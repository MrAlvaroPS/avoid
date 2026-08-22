import { createClient } from 'jsr:@supabase/supabase-js@2';
import { searchJournalEncounter, getJournalEncounterWithNamespace, flattenJournalSections } from '../_shared/blizzard-client.ts';
import { fetchJournalDifficultySnapshot, buildFromBlizzardNamespace, type JournalDifficultySnapshot } from '../_shared/wago-db2-client.ts';
import { resolveDb2Difficulty, filterAbilitiesForDifficulty } from '../_shared/difficulty-mapping.ts';
import { getFightEvents, fetchPublicRankings, summarizePublicRankings, resolveTopReportRefs, getReportAbilities } from '../_shared/wcl-client.ts';
import { inferMechanicCategory, type AbilityBehaviorSample } from '../_shared/mechanic-category-inference.ts';
import { normalizeAbilityName, buildAbilityIdsByName } from '../_shared/ability-name-match.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

// Sincroniza mecánicas SIN pedir nada a mano más allá del boss elegido en el
// desplegable (que ya viene alimentado por vuestros reports sincronizados,
// ver report_encounters). Fuentes automáticas:
//  1. Blizzard Encounter Journal -> nombres/descripciones oficiales.
//  2. Wago DB2 (JournalSectionXDifficulty/JournalEncounterXDifficulty/Difficulty)
//     -> qué mecánicas son específicas de Heroic/Mythic vs compartidas.
//  3. Vuestro propio log más reciente de ese boss+dificultad -> qué IDs se
//     vieron realmente (observed_in_logs), sin pedir una URL de muestra.
// Lorrgs queda fuera del flujo automático a propósito: no hay forma fiable de
// derivar su slug sin que alguien lo teclee, y eso es justo la fricción manual
// que se quería eliminar. El cliente (_shared/lorrgs-client.ts) sigue
// disponible si en algún momento se quiere enriquecer un boss concreto a mano.

interface SyncRequest {
  bossId: string; // = encounterID de WCL, como texto. Viene del desplegable, nunca tecleado.
  difficulties?: number[]; // WCL difficulty ids; si se omite, se sincronizan todas las vistas en vuestros reports para este boss.
  // §"sync profundo": con solo 3 logs de referencia, muchas mecánicas se
  // quedan sin evidencia suficiente (verificado en real: un boss con solo
  // 15-17 casts de enemigo por log, la mayoría de candidatas del Journal ni
  // siquiera aparecen 3 veces) — más muestra reduce ese ruido estadístico.
  // 100 no es realista en una sola llamada HTTP síncrona (cada referencia
  // exige ~5 llamadas a WCL; 100×5 con latencia real supera cualquier
  // timeout razonable) — 20 es un salto real (~6-7x more) que sigue
  // terminando en un tiempo razonable.
  deepSync?: boolean;
}
const DEEP_SYNC_REFERENCE_COUNT = 20;
const QUICK_SYNC_REFERENCE_COUNT = 3;

const WCL_DIFFICULTY_NAME_BY_ID: Record<number, string> = { 1: 'LFR', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };

interface SeenFight {
  boss_name: string;
  wcl_difficulty_id: number | null;
  report_code: string;
  fight_id: number;
  start_time: number;
  end_time: number;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  let body: SyncRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.bossId) {
    return jsonResponse({ ok: false, error: 'bossId es obligatorio' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const encounterId = Number(body.bossId);

  try {
    // --- 0. El boss ya lo conocemos: sale de vuestros reports sincronizados, no de texto tecleado ---
    const { data: seenFights } = await supabase
      .from('report_encounters')
      .select('boss_name,wcl_difficulty_id,report_code,fight_id,start_time,end_time')
      .eq('encounter_id', encounterId)
      .order('start_time', { ascending: false })
      .returns<SeenFight[]>();

    if (!seenFights?.length) {
      return jsonResponse({ ok: false, error: 'Boss desconocido: sincroniza reports primero (sección 01) para que aparezca en la lista.' });
    }
    const bossName = seenFights[0].boss_name as string;
    const difficultyIds = body.difficulties?.length
      ? body.difficulties
      : [...new Set(seenFights.map((f) => f.wcl_difficulty_id as number).filter((d) => d != null))];

    // --- 1. Blizzard Journal: fuente oficial de nombres/descripciones ---
    const matches = await searchJournalEncounter(bossName);
    const exact = matches.find((m) => m.name.toLowerCase() === bossName.toLowerCase());
    const journalEncounterId = (exact ?? matches[0])?.id;
    if (!journalEncounterId) {
      return jsonResponse({ ok: false, error: `El Journal de Blizzard no encontró "${bossName}". Puede que el nombre no coincida exactamente (localización) o que el boss aún no esté publicado.` });
    }
    const { encounter, namespace } = await getJournalEncounterWithNamespace(journalEncounterId);
    const abilities = flattenJournalSections(encounter.sections);

    // --- 2. Wago DB2: qué mecánicas son de una dificultad concreta (best-effort, nunca bloquea el sync) ---
    let snapshot: JournalDifficultySnapshot | null = null;
    if (namespace) {
      try {
        snapshot = await fetchJournalDifficultySnapshot(buildFromBlizzardNamespace(namespace));
      } catch {
        snapshot = null; // sin cruce de dificultad -> se sincroniza todo como "compartido", igual que antes
      }
    }

    // --- 3. Por cada dificultad: filtra abilities aplicables + cruza contra vuestro log más reciente de esa dificultad ---
    let upserts = 0;
    const difficultySummary: {
      difficulty: string;
      mappingStatus: string;
      db2DifficultyId: number | null;
      abilities: number;
      referenceBundleCount: number;
      referenceFetchError: string | null;
    }[] = [];

    for (const wclDifficultyId of difficultyIds) {
      const difficultyName = WCL_DIFFICULTY_NAME_BY_ID[wclDifficultyId] ?? `Dificultad ${wclDifficultyId}`;
      const mapping = resolveDb2Difficulty(snapshot, journalEncounterId, { name: difficultyName, sizes: [] }, abilities);
      const abilitiesForDifficulty = filterAbilitiesForDifficulty(abilities, snapshot, mapping);

      // Cross-check best-effort: el fight más reciente que tengáis de este boss
      // en esta dificultad exacta. Cruce por NOMBRE (ver _shared/ability-name-match.ts):
      // el ability_id del Journal casi nunca coincide con el abilityGameID
      // real de WCL (verificado en real: 0/54 candidatas de un boss casaban
      // por ID) — así que se resuelve el nombre real de cada cast observado y
      // se compara contra el nombre de la candidata, no contra su ID.
      const sampleFight = seenFights.find((f) => f.wcl_difficulty_id === wclDifficultyId);
      const observedNames = new Set<string>();
      if (sampleFight) {
        try {
          const [casts, sampleAbilities] = await Promise.all([
            getFightEvents({
              code: sampleFight.report_code as string,
              fightId: sampleFight.fight_id as number,
              dataType: 'Casts',
              startTime: sampleFight.start_time as number,
              endTime: sampleFight.end_time as number,
              maxPages: 3,
              hostilityType: 'Enemies', // solo interesan los casts del BOSS — sin esto, los de ~25 jugadores lo ahogan dentro del mismo maxPages (verificado en real)
            }),
            getReportAbilities(sampleFight.report_code as string),
          ]);
          const nameById = new Map(sampleAbilities.map((a) => [a.gameID, a.name]));
          for (const event of casts) {
            const abilityGameID = (event as { abilityGameID?: number }).abilityGameID;
            const name = typeof abilityGameID === 'number' ? nameById.get(abilityGameID) : undefined;
            if (name) observedNames.add(normalizeAbilityName(name));
          }
        } catch {
          // best-effort: si WCL falla aquí, seguimos sin observed_in_logs para esta dificultad
        }
      }

      // Cruce con un log PÚBLICO GLOBAL (no de la guild) del mismo boss+
      // dificultad — no hace falta esperar a que a vuestro propio roster le
      // toque un interrupt de verdad para saber que una mecánica es de tipo
      // interrupt: un kill de referencia de cualquier guild del mundo ya lo
      // tiene. best-effort igual que el cruce de arriba: si WCL no tiene
      // ranking público para esta dificultad todavía (raid muy nueva), se
      // sigue sin ese dato, no bloquea el resto del sync.
      // Mismo log de referencia, ahora también para Casts/DamageTaken/Deaths:
      // no solo "¿fue un interrupt?" sino "¿a cuánta gente golpeó cada vez, y
      // siempre a la misma persona?" — la base real (no adivinada) para
      // sugerir tankbuster/soak/raid-damage/avoidable-ground. best-effort
      // igual que el resto: si el log de referencia falla, se sigue sin
      // sugerencia de comportamiento (solo con la del texto del Journal, si la hay).
      // §"cómo está haciendo Avoid comparativamente": ya no un único kill de
      // referencia, sino hasta 3 de las mejores kills públicas reales (más
      // muestra = inferencia de categoría más robusta), MÁS el percentil de
      // ritmo (mediana/cuartil) de hasta 50 — una sola llamada barata a
      // fetchPublicRankings cubre ambas cosas, sin pedir eventos de fight
      // para las que no se usan de referencia de comportamiento.
      interface ReferenceBundle {
        raidSize: number;
        casts: { abilityGameID?: number; timestamp?: number }[];
        damageTaken: { abilityGameID?: number; timestamp?: number; targetID?: number }[];
        deaths: { killingAbilityGameID?: number }[];
        idsByName: Map<string, number[]>;
      }
      const interruptedNames = new Set<string>();
      const referenceBundles: ReferenceBundle[] = [];
      let referenceReportCode: string | null = null;
      let referenceFetchError: string | null = null;
      try {
        const rankings = await fetchPublicRankings(encounterId, Number(wclDifficultyId));
        const summary = summarizePublicRankings(rankings);
        if (summary && rankings[0]) {
          // §"a qué estamos llegando tarde": duración del #1 del mundo (listón
          // absoluto) + mediana/cuartil de las hasta 50 mejores (comparación
          // más justa) — ambas cosas caben en el header del pull sin pedir
          // ni un solo evento de fight, solo la lista de rankings.
          await supabase.from('boss_reference_stats').upsert(
            {
              boss_id: body.bossId,
              difficulty: difficultyName,
              reference_kill_duration_ms: rankings[0].duration,
              reference_report_code: rankings[0].reportCode,
              reference_fight_id: rankings[0].reportFightId,
              reference_sample_size: summary.sampleSize,
              reference_median_duration_ms: summary.medianDurationMs,
              reference_p25_duration_ms: summary.p25DurationMs,
              reference_zero_death_rate: summary.zeroDeathRate,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'boss_id,difficulty' },
          );
        }

        const referenceCount = body.deepSync ? DEEP_SYNC_REFERENCE_COUNT : QUICK_SYNC_REFERENCE_COUNT;
        const topRefs = await resolveTopReportRefs(rankings, referenceCount);
        // Lote de 4 en paralelo — con deepSync (hasta 20 referencias) hacerlo
        // todo secuencial (una por una) sería demasiado lento para una sola
        // llamada HTTP; todo a la vez (20×5 llamadas simultáneas) arriesga
        // saturar la API de WCL. 4 concurrentes es un término medio real.
        const REFERENCE_CONCURRENCY = 4;
        for (let batchStart = 0; batchStart < topRefs.length; batchStart += REFERENCE_CONCURRENCY) {
          const batch = topRefs.slice(batchStart, batchStart + REFERENCE_CONCURRENCY);
          await Promise.all(batch.map((ref) => processReferenceFight(ref)));
        }

        async function processReferenceFight(ref: { code: string; fightId: number; startTime: number; endTime: number; raidSize: number }) {
          const [interrupts, casts, damageTaken, deaths, referenceAbilities] = await Promise.all([
            getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'Interrupts', startTime: ref.startTime, endTime: ref.endTime, maxPages: 3 }),
            getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'Casts', startTime: ref.startTime, endTime: ref.endTime, maxPages: 5, hostilityType: 'Enemies' }),
            getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'DamageTaken', startTime: ref.startTime, endTime: ref.endTime, maxPages: 10 }),
            getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'Deaths', startTime: ref.startTime, endTime: ref.endTime, maxPages: 3 }),
            getReportAbilities(ref.code),
          ]);
          const nameById = new Map(referenceAbilities.map((a) => [a.gameID, a.name]));
          for (const event of interrupts) {
            const extraAbilityGameID = (event as { extraAbilityGameID?: number }).extraAbilityGameID;
            const name = typeof extraAbilityGameID === 'number' ? nameById.get(extraAbilityGameID) : undefined;
            if (name) interruptedNames.add(normalizeAbilityName(name));
          }
          referenceBundles.push({
            raidSize: ref.raidSize,
            casts: casts as ReferenceBundle['casts'],
            damageTaken: damageTaken as ReferenceBundle['damageTaken'],
            deaths: deaths as ReferenceBundle['deaths'],
            idsByName: buildAbilityIdsByName(referenceAbilities),
          });
          if (!referenceReportCode) referenceReportCode = ref.code;
        }
      } catch (err) {
        // best-effort — un log público que falla no debe tumbar el sync de
        // vuestro propio manifiesto, pero SÍ se registra (antes se tragaba
        // en silencio del todo, lo que hizo indetectable un bug real).
        console.error(`sync-boss-mechanics: fallo trayendo logs de referencia para boss ${body.bossId} dificultad ${wclDifficultyId}:`, err);
        referenceFetchError = err instanceof Error ? err.message : String(err);
      }

      // Misma ventana de reacción que analyze-report (MECHANIC_REACTION_WINDOW_MS,
      // duplicada aquí a propósito — Deno modules distintos, no comparten
      // import; si cambia, cambia en los dos sitios).
      const REFERENCE_REACTION_WINDOW_MS = 4000;
      // Cruce por NOMBRE (ver _shared/ability-name-match.ts), no por ID: el
      // ability_id del Journal casi nunca coincide con el abilityGameID real
      // que usa este log de referencia (misma causa raíz que observed_in_logs).
      // Combina evidencia de LAS TRES referencias — más muestra, inferencia
      // más robusta que con un único kill.
      function buildBehaviorSample(candidateName: string): AbilityBehaviorSample | null {
        let totalOccurrences = 0;
        const allRatios: number[] = [];
        let allSameTarget = true;
        // BUG real encontrado en real (verificado: 6 mecánicas con
        // reference_avg_players_hit=0 salieron "tankbuster" sin ni un solo
        // golpe detectado): allSameTarget empezaba en `true` y solo se
        // apagaba si ALGÚN bundle lo desmentía — si NINGÚN bundle tenía
        // datos suficientes para probar la hipótesis (nonEmpty.length < 2
        // siempre), se quedaba en `true` por defecto, no por evidencia.
        // anyBundleTestedSameTarget exige que se haya probado de verdad
        // al menos una vez antes de poder afirmar sameTargetEveryTime.
        let anyBundleTestedSameTarget = false;
        let anyBundleQualified = false;
        let causedDeath = false;
        for (const bundle of referenceBundles) {
          if (!bundle.raidSize) continue;
          const realIds = bundle.idsByName.get(normalizeAbilityName(candidateName)) ?? [];
          if (!realIds.length) continue;
          const casts = bundle.casts.filter((c) => typeof c.abilityGameID === 'number' && realIds.includes(c.abilityGameID));
          if (!casts.length) continue;
          anyBundleQualified = true;
          const targetsPerCast: Set<number>[] = [];
          for (const cast of casts) {
            const t0 = cast.timestamp ?? 0;
            const windowEnd = t0 + REFERENCE_REACTION_WINDOW_MS;
            const targets = new Set<number>();
            for (const dmg of bundle.damageTaken) {
              if (typeof dmg.abilityGameID !== 'number' || !realIds.includes(dmg.abilityGameID)) continue;
              const t = dmg.timestamp ?? 0;
              if (t < t0 || t > windowEnd) continue;
              if (typeof dmg.targetID === 'number') targets.add(dmg.targetID);
            }
            targetsPerCast.push(targets);
            allRatios.push(targets.size / bundle.raidSize);
          }
          totalOccurrences += casts.length;
          const nonEmpty = targetsPerCast.filter((s) => s.size > 0);
          if (nonEmpty.length >= 2) {
            anyBundleTestedSameTarget = true;
            const bundleSameTarget = nonEmpty.every((s) => s.size === 1) && new Set(nonEmpty.map((s) => [...s][0])).size === 1;
            if (!bundleSameTarget) allSameTarget = false;
          }
          if (bundle.deaths.some((d) => typeof d.killingAbilityGameID === 'number' && realIds.includes(d.killingAbilityGameID))) causedDeath = true;
        }
        if (!anyBundleQualified) return null;
        return { abilityId: 0, occurrences: totalOccurrences, targetRatiosPerCast: allRatios, sameTargetEveryTime: anyBundleTestedSameTarget && allSameTarget, causedDeath };
      }
      // Tamaño de raid representativo para convertir un ratio (0-1, ya
      // normalizado por-bundle dentro de buildBehaviorSample) en un número
      // absoluto de jugadores golpeados que se pueda enseñar — con varias
      // referencias de tamaños distintos, la media es la mejor aproximación
      // razonable para ese único número de pantalla (la categoría en sí ya
      // se decide sobre el ratio, no sobre este número).
      const avgReferenceRaidSize = referenceBundles.length ? referenceBundles.reduce((sum, b) => sum + b.raidSize, 0) / referenceBundles.length : 0;

      for (const candidate of abilitiesForDifficulty) {
        const behavior = buildBehaviorSample(candidate.name);
        const wasInterruptedInReference = interruptedNames.has(normalizeAbilityName(candidate.name));
        let inference = inferMechanicCategory(candidate.name, candidate.description || null, behavior);
        if (wasInterruptedInReference && inference?.category !== 'interrupt') {
          // Evidencia real (evento Interrupts observado) por encima de cualquier heurística de texto/comportamiento.
          inference = {
            category: 'interrupt',
            reasons: ['Log de referencia: se interrumpió de verdad (evento Interrupts real).', ...(inference?.reasons ?? [])],
          };
        }
        const referenceAvgPlayersHit =
          behavior && behavior.occurrences
            ? Math.round((behavior.targetRatiosPerCast.reduce((a, b) => a + b, 0) / behavior.targetRatiosPerCast.length) * avgReferenceRaidSize * 10) / 10
            : null;

        const { error } = await supabase
          .from('boss_mechanics_candidates')
          .upsert(
            {
              boss_id: body.bossId,
              difficulty: difficultyName,
              ability_id: candidate.abilityId,
              name: candidate.name,
              description: candidate.description || null,
              icon_url: null,
              sources: ['blizzard-journal'],
              observed_in_logs: observedNames.has(normalizeAbilityName(candidate.name)),
              observed_as_interrupt: wasInterruptedInReference,
              inferred_category: inference?.category ?? null,
              inferred_category_reasons: inference?.reasons ?? [],
              reference_avg_players_hit: referenceAvgPlayersHit,
              reference_occurrences: behavior?.occurrences ?? null,
              reference_source_report: referenceReportCode,
              journal_encounter_id: journalEncounterId,
              db2_difficulty_id: mapping.db2DifficultyId,
              difficulty_mapping_status: mapping.status,
              updated_at: new Date().toISOString(),
            },
            // OJO: el payload de arriba nunca incluye category/avoidable/expected_response/
            // severity_threshold/reviewed -> el ON CONFLICT DO UPDATE que genera supabase-js
            // no los toca, así que una edición humana previa sobrevive a este resync.
            // inferred_category sí se recalcula siempre — es una sugerencia, no un dato editorial.
            { onConflict: 'boss_id,difficulty,ability_id' },
          );
        if (!error) upserts++;
      }
      difficultySummary.push({
        difficulty: difficultyName,
        mappingStatus: mapping.status,
        db2DifficultyId: mapping.db2DifficultyId,
        abilities: abilitiesForDifficulty.length,
        referenceBundleCount: referenceBundles.length,
        referenceFetchError,
      });
    }

    return jsonResponse({ ok: true, bossName, journalEncounterId, candidates: abilities.length, upserts, difficulties: difficultySummary });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
