import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fetchPublicRankings, resolveTopReportRefs, getFightEvents, getReportAbilities, getDamageTakenByPlayerTable, tallyPlayersHitPerAbility, getFightPlayerRoles } from '../_shared/wcl-client.ts';
import { normalizeAbilityName, buildAbilityIdsByName } from '../_shared/ability-name-match.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §"Preparación" (ver plan guardado, conversación real 2026-08-30): perfil
// de daño/timing por mecánica, para poder generar reminders de MRT sin
// heredar el sesgo de "trampeadas" que discutimos — un log público bien
// jugado amortigua el golpe con mitigación activa, así que el daño POST-
// mitigación de ESE log no es una medida fiable de cuánto pega la mecánica
// de verdad. La corrección: separar cada hit en "con mitigación activa en
// el objetivo" vs "sin ella" (cruzando los propios casts del jugador
// golpeado contra cooldown_catalog.survival_type='mitigation', misma idea
// que defensiveStatusAt pero sin necesitar resolver clase/spec/talentos —
// un cast real de un spellId de mitigación en el combatlog SOLO puede venir
// de un jugador que de verdad lo tiene, así que no hace falta filtrar por
// clase antes) y usar el bucket SIN mitigar como señal principal de
// peligrosidad cruda. Para absorciones, WCL ya separa `amount` de
// `absorbed` en DamageTaken — `amount+absorbed` reconstruye el golpe crudo
// aunque se absorbiera del todo, sin necesitar ningún cruce.
//
// §"se tiene que auto poner el 'exige defensivo' cuando lo exija" +
// "prioridad del 1 al 5... en base al daño que hace a la raid" (feedback
// real, 2026-08-31): `priority` y `requires_defensive` SÍ se calculan aquí
// ahora, RELATIVOS a las demás mecánicas de este mismo boss+dificultad
// (quintil por impactScore = mediana sin mitigar × jugadores golpeados) —
// no un umbral absoluto de daño (evitaría necesitar maxHitPoints/
// includeResources, payload mucho más pesado, ver CPU quota en sync-boss-
// mechanics), sino relativo a "de las mecánicas reales de ESTE boss, ¿esta
// está entre las que más pico hacen?". Mismo contrato que
// boss_mechanics_candidates para todo lo demás: si un humano ya puso
// requires_defensive a mano (requires_defensive_source='manual_override'),
// un resync nunca lo pisa — ver el bucle de abajo.

interface SyncRequest {
  bossId: string; // encounterID de WCL, como texto — igual que sync-boss-mechanics.
  difficulties?: number[]; // WCL difficulty ids; si se omite, todas las que ya tengan mecánicas curadas en boss_mechanics_candidates para este boss.
}

const WCL_DIFFICULTY_NAME_BY_ID: Record<number, string> = { 1: 'LFR', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };

// §más cautos que sync-boss-mechanics (10/25/50): esta función pide UN tipo
// de evento más por fight de referencia (Casts Friendlies, para el cruce de
// mitigación) — sin cifra real todavía de su techo de CPU/WORKER_RESOURCE_
// LIMIT propio. Subir con confianza en cuanto haya una corrida real que lo
// confirme, mismo criterio que ya dejó documentado sync-boss-mechanics.
const REFERENCE_COUNT_BY_DIFFICULTY: Record<string, number> = { Normal: 8, Heroic: 15, Mythic: 25 };
const DEFAULT_REFERENCE_COUNT = 15;
const REFERENCE_CONCURRENCY = 4;
const MIN_REFERENCE_SAMPLE_FIGHTS = 5; // mismo umbral que MIN_REFERENCE_SAMPLE en _shared/mechanic-severity.ts — no un número nuevo inventado

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface DamageTakenEventLite {
  timestamp?: number;
  targetID?: number;
  abilityGameID?: number;
  amount?: number;
  absorbed?: number;
}
interface CastEventLite {
  timestamp?: number;
  sourceID?: number;
  abilityGameID?: number;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: SyncRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.bossId) return jsonResponse({ ok: false, error: 'bossId es obligatorio' }, 400);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const encounterId = Number(body.bossId);

  try {
    // --- mitigaciones conocidas, UNA vez para toda la sincronización (no depende del boss) ---
    const { data: mitigationRows } = await supabase
      .from('cooldown_catalog')
      .select('spell_id, base_duration_ms')
      .eq('survival_type', 'mitigation')
      .not('base_duration_ms', 'is', null);
    const mitigationDurationBySpellId = new Map<number, number>((mitigationRows ?? []).map((r) => [r.spell_id as number, r.base_duration_ms as number]));

    // --- qué mecánicas hay que perfilar: las ya curadas por sync-boss-mechanics, no una lista nueva ---
    const { data: allCandidates, error: candidatesError } = await supabase
      .from('boss_mechanics_candidates')
      .select('difficulty, ability_id, name, reference_avg_players_hit')
      .eq('boss_id', body.bossId);
    if (candidatesError) return jsonResponse({ ok: false, error: candidatesError.message }, 500);
    if (!allCandidates?.length) {
      return jsonResponse({ ok: false, error: 'Este boss todavía no tiene mecánicas curadas — sincroniza primero en Ajustes → Mecánicas antes de perfilar daño/timing.' });
    }

    const difficultyIds = body.difficulties?.length ? body.difficulties : [3, 4, 5].filter((id) => allCandidates.some((c) => c.difficulty === WCL_DIFFICULTY_NAME_BY_ID[id]));

    const results: { difficulty: string; referenceFightsUsed: number; mechanicsProfiled: number; totalFightsConsumed: number; exhausted: boolean }[] = [];

    for (const wclDifficultyId of difficultyIds) {
      const difficultyName = WCL_DIFFICULTY_NAME_BY_ID[wclDifficultyId];
      const candidates = allCandidates.filter((c) => c.difficulty === difficultyName);
      if (!candidates.length) continue;

      // §"muchos muchos muchos logs... si solo valoramos unos pocos, lo
      // trampeamos" (feedback real, 2026-08-31): cada sync trae la
      // SIGUIENTE tanda de logs de referencia, no repite los mismos —
      // boss_reference_sync_state recuerda cuántos ya se consumieron.
      // fetchPublicRankings solo pide metadata de ranking (barato, sin
      // fights completos) así que pedir hasta `alreadyConsumed + batch` de
      // golpe y quedarse con el tramo nuevo es más simple que paginar a
      // mano, y no cuesta CPU real de más (el coste caro es procesar cada
      // fight, no listar el ranking).
      const { data: syncState } = await supabase.from('boss_reference_sync_state').select('reference_fights_consumed').eq('boss_id', body.bossId).eq('difficulty', difficultyName).maybeSingle();
      const alreadyConsumed = syncState?.reference_fights_consumed ?? 0;
      const batchSize = REFERENCE_COUNT_BY_DIFFICULTY[difficultyName] ?? DEFAULT_REFERENCE_COUNT;
      const rankings = await fetchPublicRankings(encounterId, wclDifficultyId, alreadyConsumed + batchSize);
      const newRankings = rankings.slice(alreadyConsumed);
      const exhausted = newRankings.length < batchSize; // menos de una tanda completa = no hay (o casi no hay) logs nuevos más allá de este punto
      const refs = await resolveTopReportRefs(newRankings, batchSize);
      // Aunque no haya refs nuevas, se registra igual el intento (consumed
      // no avanza si no hubo nada nuevo) — evita reintentar infinitamente
      // contra un leaderboard ya agotado en cada clic.
      await supabase
        .from('boss_reference_sync_state')
        .upsert({ boss_id: body.bossId, difficulty: difficultyName, reference_fights_consumed: alreadyConsumed + refs.length, last_synced_at: new Date().toISOString() }, { onConflict: 'boss_id,difficulty' });
      if (!refs.length) {
        results.push({ difficulty: difficultyName, referenceFightsUsed: 0, mechanicsProfiled: 0, totalFightsConsumed: alreadyConsumed, exhausted });
        continue;
      }

      // ability_id de boss_mechanics_candidates viene del Journal — casi nunca
      // coincide con el abilityGameID real de un log concreto (misma causa
      // raíz documentada en sync-boss-mechanics) — se cruza por NOMBRE.
      interface FightBundle {
        idsByName: Map<string, number[]>;
        damageTaken: DamageTakenEventLite[];
        playerCasts: CastEventLite[];
        enemyCasts: CastEventLite[]; // solo para reference_cast_offset_ms_samples (timeline/preview) — nunca el trigger real, ver MrtBossmodTrigger
        startTime: number;
        damageTally: Map<number, { playersHit: Set<string>; totalDamage: number }> | null;
        tankNames: Set<string> | null;
        healerNames: Set<string> | null;
      }
      const bundles: FightBundle[] = [];

      for (let batchStart = 0; batchStart < refs.length; batchStart += REFERENCE_CONCURRENCY) {
        const batch = refs.slice(batchStart, batchStart + REFERENCE_CONCURRENCY);
        await Promise.all(
          batch.map(async (ref) => {
            try {
              const [abilities, damageTaken, playerCasts, enemyCasts, damageTakenTable, roles] = await Promise.all([
                getReportAbilities(ref.code),
                getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'DamageTaken', startTime: ref.startTime, endTime: ref.endTime, maxPages: 6, hostilityType: 'Friendlies' }),
                getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'Casts', startTime: ref.startTime, endTime: ref.endTime, maxPages: 6, hostilityType: 'Friendlies' }),
                getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'Casts', startTime: ref.startTime, endTime: ref.endTime, maxPages: 5, hostilityType: 'Enemies' }),
                getDamageTakenByPlayerTable({ code: ref.code, fightId: ref.fightId, startTime: ref.startTime, endTime: ref.endTime }).catch(() => null),
                getFightPlayerRoles({ code: ref.code, fightId: ref.fightId, startTime: ref.startTime, endTime: ref.endTime }).catch(() => null),
              ]);
              bundles.push({
                idsByName: buildAbilityIdsByName(abilities),
                damageTaken: damageTaken as DamageTakenEventLite[],
                playerCasts: playerCasts as CastEventLite[],
                enemyCasts: enemyCasts as CastEventLite[],
                startTime: ref.startTime,
                damageTally: damageTakenTable ? tallyPlayersHitPerAbility(damageTakenTable) : null,
                tankNames: roles ? new Set([...roles.entries()].filter(([, r]) => r === 'tank').map(([n]) => n)) : null,
                healerNames: roles ? new Set([...roles.entries()].filter(([, r]) => r === 'healer').map(([n]) => n)) : null,
              });
            } catch (err) {
              // best-effort — una referencia que falle no debe tumbar el resto (mismo criterio que sync-boss-mechanics)
              console.error(`sync-mechanic-defensive-profile: fallo en referencia ${ref.code}#${ref.fightId}:`, err);
            }
          }),
        );
      }

      interface MechanicAccumulated {
        candidate: (typeof candidates)[number];
        unmitigated: number[];
        mitigated: number[];
        castOffsets: number[];
        tankHits: number;
        healerHits: number;
        dpsHits: number;
        sampledFights: number;
      }
      const accumulated: MechanicAccumulated[] = [];

      for (const candidate of candidates) {
        const nameKey = normalizeAbilityName(candidate.name);
        const unmitigated: number[] = [];
        const mitigated: number[] = [];
        const castOffsets: number[] = [];
        let tankHits = 0;
        let healerHits = 0;
        let dpsHits = 0;
        let sampledFights = 0;

        for (const bundle of bundles) {
          const realIds = bundle.idsByName.get(nameKey);
          if (!realIds?.length) continue;

          // Casts de mitigación por CASTER (sourceID) — un cast real solo
          // puede venir de quien de verdad lo tiene, no hace falta saber su
          // clase/spec de antemano. Se guarda spellId junto al timestamp
          // (no solo el timestamp) para no tener que re-buscarlo por cada
          // hit — evita un find() dentro de un bucle ya cuadrático.
          const mitigationCastsBySource = new Map<number, { timestamp: number; spellId: number }[]>();
          for (const c of bundle.playerCasts) {
            if (typeof c.sourceID !== 'number' || typeof c.abilityGameID !== 'number' || typeof c.timestamp !== 'number') continue;
            if (!mitigationDurationBySpellId.has(c.abilityGameID)) continue;
            if (!mitigationCastsBySource.has(c.sourceID)) mitigationCastsBySource.set(c.sourceID, []);
            mitigationCastsBySource.get(c.sourceID)!.push({ timestamp: c.timestamp, spellId: c.abilityGameID });
          }

          let qualifiedThisBundle = false;
          for (const hit of bundle.damageTaken) {
            if (typeof hit.abilityGameID !== 'number' || !realIds.includes(hit.abilityGameID)) continue;
            if (typeof hit.amount !== 'number' || typeof hit.targetID !== 'number' || typeof hit.timestamp !== 'number') continue;
            qualifiedThisBundle = true;
            const raw = hit.amount + (hit.absorbed ?? 0);
            if (raw <= 0) continue;
            const targetCasts = mitigationCastsBySource.get(hit.targetID) ?? [];
            const mitigationActive = targetCasts.some((cast) => {
              const duration = mitigationDurationBySpellId.get(cast.spellId)!;
              return cast.timestamp <= hit.timestamp! && hit.timestamp! - cast.timestamp <= duration;
            });
            (mitigationActive ? mitigated : unmitigated).push(raw);
          }
          if (qualifiedThisBundle) sampledFights++;

          // Timing de la mecánica REAL (cast del boss), no del hit — un cast
          // puede golpear a varios jugadores a la vez, eso sería la misma
          // "ocurrencia" contada varias veces. Solo preview/timeline en la
          // pantalla, nunca el trigger real (ver MrtBossmodTrigger).
          for (const cast of bundle.enemyCasts) {
            if (typeof cast.abilityGameID !== 'number' || !realIds.includes(cast.abilityGameID)) continue;
            if (typeof cast.timestamp !== 'number') continue;
            castOffsets.push(cast.timestamp - bundle.startTime);
          }

          if (bundle.damageTally) {
            for (const id of realIds) {
              const tally = bundle.damageTally.get(id);
              if (!tally) continue;
              for (const playerName of tally.playersHit) {
                if (bundle.tankNames?.has(playerName)) tankHits++;
                else if (bundle.healerNames?.has(playerName)) healerHits++;
                else dpsHits++;
              }
            }
          }
        }

        if (sampledFights < 1) continue; // ni un solo fight de referencia de ESTA tanda vio esta mecánica — no toca la fila existente
        accumulated.push({ candidate, unmitigated, mitigated, castOffsets, tankHits, healerHits, dpsHits, sampledFights });
      }

      // §"que se tiene que auto poner el 'exige defensivo' cuando lo
      // exija" + "columna nueva... prioridad del 1 al 5 dependiendo la
      // prioridad de defensivo que tiene en base al daño que hace a la
      // raid" (feedback real, 2026-08-31): impactScore = mediana de daño
      // SIN mitigar × jugadores golpeados por cast (reference_avg_players_
      // hit, ya calculado por sync-boss-mechanics con correlación real
      // por-cast) — misma fórmula que usa el ranking de la cascada en
      // auto-assign-cascade.util.ts (Angular), aquí en Deno porque hace
      // falta para PERSISTIR priority/requires_defensive, no solo para
      // rankear en el momento de exportar. Quintil RELATIVO a las demás
      // mecánicas de ESTE boss+dificultad (no una escala absoluta — un
      // pico "grande" en un boss puede ser "pequeño" en otro), por eso hay
      // que tener TODAS las mecánicas de la tanda antes de poder puntuar
      // ninguna, y por eso este bloque va después del bucle de arriba, no dentro.
      let mechanicsProfiled = 0;
      if (accumulated.length) {
        // Necesita el estado existente de TODAS a la vez (merge de arrays +
        // no pisar un requires_defensive puesto a mano) — una sola query en
        // vez de una por mecánica.
        const { data: existingRows } = await supabase
          .from('boss_mechanic_defensive_profile')
          .select(
            'ability_id, reference_unmitigated_damage_samples, reference_mitigated_damage_samples, reference_cast_offset_ms_samples, reference_sample_fight_count, reference_role_hit_breakdown, requires_defensive, requires_defensive_source',
          )
          .eq('boss_id', body.bossId)
          .eq('difficulty', difficultyName)
          .in(
            'ability_id',
            accumulated.map((a) => a.candidate.ability_id),
          );
        const existingByAbilityId = new Map((existingRows ?? []).map((r) => [r.ability_id as number, r]));

        const merged = accumulated.map((a) => {
          const existing = existingByAbilityId.get(a.candidate.ability_id);
          const existingBreakdown = (existing?.reference_role_hit_breakdown ?? null) as { tank: number; healer: number; dps: number } | null;
          const unmitigated = [...((existing?.reference_unmitigated_damage_samples as number[]) ?? []), ...a.unmitigated];
          return {
            candidate: a.candidate,
            unmitigated,
            mitigated: [...((existing?.reference_mitigated_damage_samples as number[]) ?? []), ...a.mitigated],
            castOffsets: [...((existing?.reference_cast_offset_ms_samples as number[]) ?? []), ...a.castOffsets],
            sampleFightCount: ((existing?.reference_sample_fight_count as number) ?? 0) + a.sampledFights,
            breakdown: { tank: (existingBreakdown?.tank ?? 0) + a.tankHits, healer: (existingBreakdown?.healer ?? 0) + a.healerHits, dps: (existingBreakdown?.dps ?? 0) + a.dpsHits },
            existingRequiresDefensive: (existing?.requires_defensive as boolean | null) ?? null,
            existingSource: (existing?.requires_defensive_source as string | null) ?? null,
            impactScore: unmitigated.length ? median(unmitigated) * (a.candidate.reference_avg_players_hit ?? 1) : null,
          };
        });

        // Rankeo solo entre las que SÍ tienen evidencia (impactScore no
        // null) — el resto se queda con priority null, "sin datos" es un
        // estado real, no un 1 falso.
        const ranked = merged.filter((m) => m.impactScore != null).sort((a, b) => b.impactScore! - a.impactScore!);
        const priorityByAbilityId = new Map<number, number>();
        ranked.forEach((m, idx) => {
          const priority = Math.max(1, 5 - Math.floor((idx / ranked.length) * 5));
          priorityByAbilityId.set(m.candidate.ability_id, priority);
        });

        for (const m of merged) {
          const priority = priorityByAbilityId.get(m.candidate.ability_id) ?? null;
          // §"category/avoidable/... nunca se pisan en un resync" (mismo
          // contrato que boss_mechanics_candidates, ver save-mechanic-
          // defensive-profile-edit): si un humano ya decidió esto a mano
          // (manual_override), el sync nunca lo vuelve a tocar.
          const isManual = m.existingSource === 'manual_override';
          const patch: Record<string, unknown> = {
            boss_id: body.bossId,
            difficulty: difficultyName,
            ability_id: m.candidate.ability_id,
            reference_unmitigated_damage_samples: m.unmitigated,
            reference_mitigated_damage_samples: m.mitigated,
            reference_role_hit_breakdown: m.breakdown,
            reference_cast_offset_ms_samples: m.castOffsets,
            reference_sample_fight_count: m.sampleFightCount,
            priority,
            updated_at: new Date().toISOString(),
          };
          if (!isManual) {
            patch['requires_defensive'] = priority == null ? m.existingRequiresDefensive : priority >= 3;
            patch['requires_defensive_source'] = priority == null ? m.existingSource : 'world_reference';
          }
          const { error: upsertError } = await supabase.from('boss_mechanic_defensive_profile').upsert(patch, { onConflict: 'boss_id,difficulty,ability_id' });
          if (!upsertError) mechanicsProfiled++;
          else console.error(`sync-mechanic-defensive-profile: fallo guardando ${m.candidate.name} (${difficultyName}):`, upsertError.message);
        }
      }

      results.push({ difficulty: difficultyName, referenceFightsUsed: bundles.length, mechanicsProfiled, totalFightsConsumed: alreadyConsumed + refs.length, exhausted });
    }

    return jsonResponse({ ok: true, results, minReferenceSampleFights: MIN_REFERENCE_SAMPLE_FIGHTS });
  } catch (err) {
    console.error('sync-mechanic-defensive-profile: fallo general:', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
