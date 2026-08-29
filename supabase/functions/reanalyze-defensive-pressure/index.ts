import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getReportFights, getReportActors, getReportAbilities, getFightEvents, getFightGraph, type WclActor } from '../_shared/wcl-client.ts';
import { defensivesForClass, type CooldownCatalog, type TalentGate } from '../_shared/defensive-cooldowns.ts';
import { getSpecName, getCurrentBuildNamespace } from '../_shared/blizzard-client.ts';
import { buildFromBlizzardNamespace, fetchTalentSpellLookup } from '../_shared/wago-db2-client.ts';
import { attributeWindowAbility, detectDamageWindows, evaluateWindowCoverage } from '../_shared/damage-pressure-windows.ts';
import { normalizeAbilityName, buildAbilityIdsByName } from '../_shared/ability-name-match.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §"backfill completo del histórico" (feedback real, 2026-08-29): analyze-report
// solo escribe defensive_pressure_windows para fights NUEVOS a partir de su
// despliegue — esta función recalcula esa misma columna para un pull YA
// importado, sin tocar report_code/fight_id/pull_number/death_cause/nada más
// de la fila. Mismo patrón que reanalyze-wipe-call (vuelve a pedir a WCL
// solo lo necesario: graph(DamageTaken) + Casts(Friendlies), no todo el
// pipeline de mecánicas/gear/consumibles).
//
// §"arregla los históricos haciendo un backfill en condiciones... que todo
// sea consistente" (feedback real, 2026-08-29): SÍ resuelve talentos —
// auditoría previa encontró que el backfill sin talentGate podía marcar
// como "disponible" un defensivo de un nodo de talento que el jugador nunca
// eligió (mismo bug de fondo que motivó talentGate en analyze-report,
// Pandokie). No repite el coste que talentSpellLookup ya resuelve una vez:
// la tabla `talent_spell_lookup` cachea por build de juego (ver
// analyze-report/index.ts) — aquí solo se LEE esa caché, nunca se golpea
// wago.tools directamente salvo que de verdad falte para este build.

interface CastEvent { timestamp?: number; sourceID?: number; abilityGameID?: number }
interface CombatantInfoEvent {
  sourceID?: number;
  specID?: number;
  /** Mismo campo/mismo comentario que en analyze-report: `talents` es legado y viene vacío, el árbol real está aquí ([{id, rank, nodeID}]). */
  talentTree?: { id?: number; rank?: number; nodeID?: number }[];
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: { pullId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.pullId) return jsonResponse({ ok: false, error: 'pullId es obligatorio' }, 400);

  // §"WORKER_RESOURCE_LIMIT... no se calculaba de nuevo" (feedback real,
  // 2026-08-29, verificado con save-defensive-edit): reanalizar decenas de
  // pulls uno detrás de otro DENTRO de una sola invocación (bucle for
  // síncrono en save-defensive-edit) agota la cuota de CPU del isolate de
  // Edge Functions a mitad de camino — cada pull ya hace varias llamadas a
  // WCL + resolución de talentos, trabajo de sobra para UNA invocación, no
  // 47+ seguidas en la misma. Se probó encadenar invocaciones vía
  // fire-and-forget (fetch sin esperar + EdgeRuntime.waitUntil) pero,
  // verificado empíricamente con un caso controlado de 3 pulls, el segundo
  // eslabón nunca llegaba a ejecutarse — el runtime mata el isolate al
  // devolver la respuesta y no hay garantía real de que ese fetch salga.
  // Solución robusta: esta función solo procesa UN pull por invocación (como
  // siempre) y quien orquesta la cola completa es el CLIENTE (ver
  // defensive-catalog.component.ts), llamando una vez por pull, en
  // secuencia, esperando cada respuesta — igual que ya hace el backfill
  // manual, solo que disparado automáticamente al editar el catálogo.

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const { data: pull, error: pullFetchError } = await supabase
      .from('pulls')
      .select('id, report_code, fight_id, boss_id, difficulty')
      .eq('id', body.pullId)
      .maybeSingle();
    if (pullFetchError) return jsonResponse({ ok: false, error: pullFetchError.message }, 500);
    if (!pull) return jsonResponse({ ok: false, error: `Pull ${body.pullId} no encontrado` }, 404);

    const reportDetail = await getReportFights(pull.report_code);
    const fight = reportDetail.fights.find((f) => f.id === pull.fight_id);
    if (!fight) return jsonResponse({ ok: false, error: `Fight ${pull.fight_id} no encontrado en el report ${pull.report_code}` }, 404);

    const actors = await getReportActors(pull.report_code);
    const actorById = new Map<number, WclActor>(actors.map((a) => [a.id, a]));

    const { data: catalogRows } = await supabase
      .from('cooldown_catalog')
      .select('class,spec,spell_id,name,category,base_cooldown_ms,base_duration_ms,survival_type');
    const cooldownCatalog: CooldownCatalog = (catalogRows ?? []).map((r) => ({
      spellId: r.spell_id,
      name: r.name,
      class: r.class,
      spec: r.spec,
      category: r.category,
      baseCooldownMs: r.base_cooldown_ms,
      durationMs: r.base_duration_ms,
      survivalType: r.survival_type ?? null,
    }));

    const [graph, friendlyCastEvents, combatantInfoEvents, damageTakenEvents, abilities, mechanicRows] = await Promise.all([
      getFightGraph({ code: pull.report_code, fightId: fight.id, dataType: 'DamageTaken', hostilityType: 'Friendlies', startTime: fight.startTime, endTime: fight.endTime }),
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'Casts', startTime: fight.startTime, endTime: fight.endTime, hostilityType: 'Friendlies' }),
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'CombatantInfo', startTime: fight.startTime, endTime: fight.endTime }),
      // §"relacionar 'pico de daño recibido' con una habilidad del boss, de
      // forma veraz" (feedback real, 2026-08-29): eventos crudos, no hace
      // falta includeResources aquí (solo se usa abilityGameID/amount/
      // timestamp para atribuir el pico, no el % de vida).
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'DamageTaken', startTime: fight.startTime, endTime: fight.endTime, hostilityType: 'Friendlies' }),
      getReportAbilities(pull.report_code),
      supabase
        .from('applicable_boss_mechanics_candidates')
        .select('ability_id,name')
        .eq('boss_id', pull.boss_id)
        .eq('difficulty', pull.difficulty)
        .then(
          (res) => res.data ?? [],
          () => [] as { ability_id: number; name: string }[],
        ),
    ]);

    const damageTakenSeriesByActorId = new Map<number, { pointStart: number; pointIntervalMs: number; points: number[] }>();
    for (const s of graph?.series ?? []) {
      damageTakenSeriesByActorId.set(s.id, { pointStart: s.pointStart, pointIntervalMs: s.pointInterval, points: s.data });
    }

    interface DamageEventLite { targetID?: number; timestamp?: number; abilityGameID?: number; amount?: number }
    const damageEventsByTarget = new Map<number, DamageEventLite[]>();
    for (const raw of damageTakenEvents) {
      const e = raw as DamageEventLite;
      if (typeof e.targetID !== 'number') continue;
      if (!damageEventsByTarget.has(e.targetID)) damageEventsByTarget.set(e.targetID, []);
      damageEventsByTarget.get(e.targetID)!.push(e);
    }

    // §mismo cruce que analyze-report (mechanicById): nombre curado si esta
    // abilityGameID es una mecánica clasificada del manifiesto de este
    // boss+dificultad, con puente por NOMBRE (el ability_id del Journal casi
    // nunca coincide con el abilityGameID real de WCL) — nombre real de WCL
    // como fallback si no.
    const abilityNameById = new Map(abilities.map((a) => [a.gameID, a.name]));
    const realIdsByName = buildAbilityIdsByName(abilities);
    const mechanicNameById = new Map<number, string>();
    for (const m of mechanicRows as { ability_id: number; name: string }[]) {
      if (!mechanicNameById.has(m.ability_id)) mechanicNameById.set(m.ability_id, m.name);
      for (const realId of realIdsByName.get(normalizeAbilityName(m.name)) ?? []) {
        if (!mechanicNameById.has(realId)) mechanicNameById.set(realId, m.name);
      }
    }

    const castTimestampsByActor = new Map<number, Map<number, number[]>>();
    for (const raw of friendlyCastEvents) {
      const e = raw as CastEvent;
      if (typeof e.sourceID !== 'number' || typeof e.abilityGameID !== 'number') continue;
      if (!castTimestampsByActor.has(e.sourceID)) castTimestampsByActor.set(e.sourceID, new Map());
      const perSpell = castTimestampsByActor.get(e.sourceID)!;
      if (!perSpell.has(e.abilityGameID)) perSpell.set(e.abilityGameID, []);
      perSpell.get(e.abilityGameID)!.push(e.timestamp ?? 0);
    }

    // §"es importante que los defensivos disponibles sean propios de la
    // clase o de los talentos" (feedback real, Pandokie) — sin spec real, un
    // Paladin Sagrado saldría con Guardian of Ancient Kings/Ardent Defender
    // (solo Protección) en su catálogo. Se resuelve igual que analyze-report
    // (CombatantInfo.specID -> Blizzard Game Data).
    const combatantInfoByActor = new Map<number, CombatantInfoEvent>();
    for (const raw of combatantInfoEvents) {
      const e = raw as CombatantInfoEvent;
      if (typeof e.sourceID === 'number') combatantInfoByActor.set(e.sourceID, e);
    }
    const specNameByActor = new Map<number, string | null>();
    for (const [actorId, info] of combatantInfoByActor) {
      if (typeof info.specID === 'number') specNameByActor.set(actorId, await getSpecName(info.specID));
    }

    // §"arregla los históricos... que todo sea consistente" (feedback real,
    // 2026-08-29): mismo mecanismo de caché que analyze-report — solo LEE
    // talent_spell_lookup por build, no vuelve a pedir las tablas completas
    // de wago.tools salvo que falte para este build en concreto (best-effort:
    // un fallo aquí degrada a "sin talentGate", igual que analyze-report,
    // nunca bloquea el backfill del resto del pull).
    let talentSpellLookup: Map<number, number> | null = null;
    try {
      const namespace = await getCurrentBuildNamespace();
      if (namespace) {
        const build = buildFromBlizzardNamespace(namespace);
        const { data: cached } = await supabase.from('talent_spell_lookup').select('entry_to_spell').eq('build', build).maybeSingle();
        if (cached) {
          talentSpellLookup = new Map(Object.entries(cached.entry_to_spell as Record<string, number>).map(([id, spellId]) => [Number(id), spellId]));
        } else {
          const fresh = (await fetchTalentSpellLookup(build)).entryIdToSpellId;
          talentSpellLookup = fresh;
          const entry_to_spell = Object.fromEntries([...fresh.entries()].map(([id, spellId]) => [String(id), spellId]));
          await supabase.from('talent_spell_lookup').upsert({ build, entry_to_spell }).then(
            () => {},
            (err) => console.error('No se pudo cachear talent_spell_lookup (no bloqueante):', err),
          );
        }
      }
    } catch (err) {
      console.error('No se pudieron resolver talentos a spell ID (se sigue sin talentGate):', err);
    }
    const allTalentSpellIds = talentSpellLookup ? new Set(talentSpellLookup.values()) : null;
    function talentGateForActor(actorId: number): TalentGate | null {
      if (!allTalentSpellIds || !talentSpellLookup) return null;
      const tree = combatantInfoByActor.get(actorId)?.talentTree;
      if (!tree) return null;
      const playerTalentSpellIds = new Set(
        tree
          .map((node) => (typeof node.id === 'number' ? talentSpellLookup!.get(node.id) : undefined))
          .filter((id): id is number => typeof id === 'number'),
      );
      return { allTalentSpellIds, playerTalentSpellIds };
    }

    const { data: existingRecords, error: recordsFetchError } = await supabase
      .from('player_pull_records')
      .select('player_name')
      .eq('pull_id', pull.id);
    if (recordsFetchError) return jsonResponse({ ok: false, error: recordsFetchError.message }, 500);

    const actorIdByName = new Map(fight.friendlyPlayers.map((actorId) => [actorById.get(actorId)?.name, actorId]).filter((e): e is [string, number] => Boolean(e[0])));

    let updated = 0;
    let skipped = 0;
    const perPlayerWindowCounts: { playerName: string; windowCount: number }[] = [];
    for (const record of (existingRecords ?? []) as { player_name: string }[]) {
      const actorId = actorIdByName.get(record.player_name);
      const actor = actorId != null ? actorById.get(actorId) : undefined;
      const damageSeries = actorId != null ? damageTakenSeriesByActorId.get(actorId) : undefined;
      if (!actor || !damageSeries) {
        skipped++;
        continue;
      }
      const catalog = defensivesForClass(actor.subType, specNameByActor.get(actorId!) ?? null, cooldownCatalog, talentGateForActor(actorId!));
      const castsBySpellId = new Map(catalog.map((cd) => [cd.spellId, castTimestampsByActor.get(actorId!)?.get(cd.spellId) ?? []]));
      const { baselineValue, windows } = detectDamageWindows(damageSeries.points, damageSeries.pointStart, damageSeries.pointIntervalMs);
      const actorDamageEvents = damageEventsByTarget.get(actorId) ?? [];
      const defensivePressureWindows = {
        baselineValue,
        windows: windows.map((w) => {
          const coverage = evaluateWindowCoverage(w.startMs, w.endMs, catalog, castsBySpellId);
          const dominant = attributeWindowAbility(actorDamageEvents, w.startMs, w.endMs);
          return {
            startMs: w.startMs - fight.startTime,
            endMs: w.endMs - fight.startTime,
            peakMs: w.peakMs - fight.startTime,
            peakValue: w.peakValue,
            covered: coverage.covered,
            coverable: coverage.coverable,
            options: coverage.options,
            mechanicId: dominant?.abilityGameID ?? null,
            mechanicName: dominant ? (mechanicNameById.get(dominant.abilityGameID) ?? abilityNameById.get(dominant.abilityGameID) ?? null) : null,
          };
        }),
      };
      const { error: updateError } = await supabase
        .from('player_pull_records')
        .update({ defensive_pressure_windows: defensivePressureWindows })
        .eq('pull_id', pull.id)
        .eq('player_name', record.player_name);
      if (updateError) return jsonResponse({ ok: false, error: updateError.message }, 500);
      updated++;
      perPlayerWindowCounts.push({ playerName: record.player_name, windowCount: windows.length });
    }

    // §bug real encontrado en auditoría (2026-08-29): "he puesto el
    // fortifying brew y sale lo mismo en todos lados" — reanalyze-wipe-call
    // SÍ bumpea pulls.updated_at tras corregir un pull retroactivamente
    // (es justo la señal que lee RosterSnapshotCacheService/
    // NightPlayerSummaryCacheService.fingerprint() para saber "hay que
    // recalcular, no sirvas el caché"); esta función nunca lo hacía, así
    // que un reanálisis correcto en la base de datos podía quedar invisible
    // en el dosier/roster indefinidamente, aunque el dato ya estuviera bien.
    if (updated > 0) {
      const { error: touchError } = await supabase.from('pulls').update({ updated_at: new Date().toISOString() }).eq('id', pull.id);
      if (touchError) console.error('No se pudo marcar pulls.updated_at tras el reanálisis (no bloqueante):', touchError);
    }

    return jsonResponse({ ok: true, pullId: pull.id, updated, skipped, perPlayerWindowCounts });
  } catch (err) {
    console.error('reanalyze-defensive-pressure error:', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
