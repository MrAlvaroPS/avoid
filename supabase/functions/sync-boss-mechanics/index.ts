import { createClient } from 'jsr:@supabase/supabase-js@2';
import { searchJournalEncounter, getJournalEncounterWithNamespace, getJournalEncounterLocalized, flattenJournalSections } from '../_shared/blizzard-client.ts';
import { fetchJournalDifficultySnapshot, buildFromBlizzardNamespace, type JournalDifficultySnapshot } from '../_shared/wago-db2-client.ts';
import { resolveDb2Difficulty, filterAbilitiesForDifficulty } from '../_shared/difficulty-mapping.ts';
import {
  getFightEvents,
  fetchPublicRankings,
  summarizePublicRankings,
  resolveTopReportRefs,
  getReportAbilities,
  getDamageTakenByPlayerTable,
  tallyPlayersHitPerAbility,
  getFightPlayerRoles,
  type AbilityPlayerTally,
} from '../_shared/wcl-client.ts';
import {
  inferMechanicCategory,
  inferCategoryFromBehavior,
  type AbilityBehaviorSample,
  type AggregateBehaviorSample,
} from '../_shared/mechanic-category-inference.ts';
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
  // §"cuantos logs nos podemos traer... comprueba WCL" (feedback real,
  // 2026-08-27): la suposición anterior de "100 no es realista" era de
  // cuando esto solo servía para inferir categoría — verificado en real
  // contra la cuenta de WCL (rateLimitData) que un bundle de referencia
  // completo cuesta 9,25 puntos de un presupuesto de 3600/hora (~389
  // fights/hora solo por cuota), y un batch real de 4 concurrentes tarda
  // ~940ms (120 referencias ≈ 28s) — hay margen real. El techo de verdad es
  // la ejecución de la Edge Function (WORKER_RESOURCE_LIMIT ya visto esta
  // sesión), no la cuota de WCL — se verifica en real, no en teoría.
  deepSync?: boolean;
}
// §"lo repartimos por dificultad" (feedback real, 2026-08-27): no tiene
// sentido pedir la misma muestra en las 3 — Normal ya sale fluido, Heroico
// va por la mitad, y Mítico es donde Avoid de verdad se atasca y donde más
// falta hace una comparación fina. La mayoría del presupuesto va ahí.
// §"mientras dura el world first no hay logs de mítico, pero los habrá
// pronto, hay que dejarlo preparado" (feedback real, 2026-08-27): bajado de
// la primera versión (10/30/120) tras un HTTP 546 real en producción
// (WORKER_RESOURCE_LIMIT, boss 3445 Mítico, solo 21 referencias — ver notas
// de maxPages/REFERENCE_CONCURRENCY más abajo, que atacan la causa real).
// Con esas dos mitigaciones puestas, estos números deberían aguantar
// cuando existan logs de sobra — pero como con world-first no hay forma de
// probar 50/120 reales todavía, se deja un techo realista y se puede subir
// con confianza en cuanto haya muestra real que lo permita comprobar.
const DEEP_SYNC_REFERENCE_COUNT_BY_DIFFICULTY: Record<string, number> = {
  Normal: 10,
  Heroic: 25,
  Mythic: 50,
};
const DEFAULT_DEEP_SYNC_REFERENCE_COUNT = 25; // fallback si difficultyName no coincide con el mapa (no debería pasar, LFR ya no se sincroniza)
const QUICK_SYNC_REFERENCE_COUNT = 3;

const WCL_DIFFICULTY_NAME_BY_ID: Record<number, string> = { 1: 'LFR', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };

// §bug real contrastado (2026-08-27, feedback: "en la pestaña de normal se
// están poniendo [mecánicas] de otras dificultades" + investigación propia):
// resolveDb2Difficulty recibía siempre sizes:[] aquí, así que el desempate
// por tamaño de raid (pensado justo para esto) nunca se ejecutaba. Se
// contrastó en real contra la tabla Difficulty.db2 (build 12.1.0.68914,
// https://wago.tools/db2/Difficulty/csv?build=12.1.0.68914): el nombre
// "Normal" por sí solo NO es único — hay 4 filas exactas ("Normal" de
// mazmorra minPlayers=5/maxPlayers=5, dos variantes de escenario 1-3 y 5-5,
// y la de raid real 10-30) y ninguna tiene restricción de Journal (eso es
// justo lo normal en contenido base, no exclusivo de ninguna dificultad) —
// las 4 empatan a la misma puntuación exacta y todo el boss queda
// 'difficulty-mapping-ambiguous', sin ningún desempate posible. "Heroic" SÍ
// suele resolverse solo porque casi siempre hay alguna sección exclusiva de
// Heroic+ en el Journal que rompe el empate vía encounterRestrictions/
// sectionRestrictionIds — Normal casi nunca tiene ese lujo.
// Con el tamaño real de raid (diseño de juego estable: Mítica siempre fija
// a 20, LFR/Normal/Heroico flexibles 10-30 desde Legion) la fila de raid de
// verdad (10-30, o 20 en Mítica) puntúa muy por encima de las de mazmorra/
// escenario (que no solapan ese rango) — desempate limpio, sin ambigüedad.
// No hace falta el tamaño exacto de un pull concreto: candidateScore solo
// necesita QUE alguno de los valores pasados caiga dentro del [min,max] de
// la fila de raid real y fuera del de las demás, y estos dos extremos ya
// bastan para eso en cualquier tier de raid actual.
const WCL_DIFFICULTY_RAID_SIZES: Record<number, number[]> = { 1: [10, 30], 3: [10, 30], 4: [10, 30], 5: [20] };

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

    // §9.1: un boss sembrado por sync-season-bosses pero nunca pulleado por
    // la guild no tiene ninguna fila en report_encounters — antes eso
    // bloqueaba el sync entero ("Boss desconocido"), aunque el boss SÍ
    // pueda clasificarse igual desde Journal+DB2+logs públicos (solo
    // observed_in_logs/el cruce con vuestro log más reciente se quedan sin
    // dato, honestamente). Sin report_encounters no hay forma de INFERIR
    // qué dificultades sincronizar, así que ahí sí hace falta pedirlas.
    let bossName: string;
    if (seenFights?.length) {
      bossName = seenFights[0].boss_name as string;
    } else {
      const { data: known } = await supabase.from('known_raid_bosses').select('boss_name').eq('encounter_id', encounterId).maybeSingle();
      if (!known) {
        return jsonResponse({ ok: false, error: 'Boss desconocido: ni tenéis un pull suyo ni está en el catálogo de la season (Ajustes → Sincronizar bosses de la season).' });
      }
      bossName = known.boss_name as string;
    }
    const difficultyIds = body.difficulties?.length
      ? body.difficulties
      : seenFights?.length
        ? [...new Set(seenFights.map((f) => f.wcl_difficulty_id as number).filter((d) => d != null))]
        : null;
    if (!difficultyIds?.length) {
      return jsonResponse({ ok: false, error: `"${bossName}" no tiene pulls propios todavía — indica a mano qué dificultad(es) sincronizar (difficulties: [1|3|4|5]).` });
    }

    // --- 1. Blizzard Journal: fuente oficial de nombres/descripciones ---
    const matches = await searchJournalEncounter(bossName);
    const exact = matches.find((m) => m.name.toLowerCase() === bossName.toLowerCase());
    const journalEncounterId = (exact ?? matches[0])?.id;
    if (!journalEncounterId) {
      return jsonResponse({ ok: false, error: `El Journal de Blizzard no encontró "${bossName}". Puede que el nombre no coincida exactamente (localización) o que el boss aún no esté publicado.` });
    }
    const { encounter, namespace } = await getJournalEncounterWithNamespace(journalEncounterId);
    const abilities = flattenJournalSections(encounter.sections);

    // §"las habilidades deberían estar en inglés y de subtítulo en
    // castellano para poder localizarlas bien" (feedback real): segunda
    // llamada al mismo Journal, solo para el nombre — best-effort, nunca
    // bloquea el sync si Blizzard no tiene traducción o la llamada falla.
    let abilityNamesEs = new Map<number, string>();
    try {
      const encounterEs = await getJournalEncounterLocalized(journalEncounterId, 'es_ES');
      abilityNamesEs = new Map(flattenJournalSections(encounterEs.sections).map((a) => [a.abilityId, a.name]));
    } catch {
      // sin nombre en castellano esta vez — la columna queda null, no bloquea el resto
    }

    // --- 2. Wago DB2: qué mecánicas son de una dificultad concreta (best-effort, nunca bloquea el sync) ---
    let snapshot: JournalDifficultySnapshot | null = null;
    let snapshotFetchError: string | null = null;
    if (namespace) {
      try {
        snapshot = await fetchJournalDifficultySnapshot(buildFromBlizzardNamespace(namespace));
      } catch (err) {
        snapshot = null; // sin cruce de dificultad -> se sincroniza todo como "compartido", igual que antes
        // §"esto que me ha saltado al sincronizar... es normal?" (feedback
        // real, 2026-08-27): antes este fallo era mudo del todo — se veía
        // "difficulty-metadata-unavailable" sin ninguna pista de por qué
        // (a diferencia de referenceFetchError, que sí explica su propio
        // fallo). Wago (wago.tools) es un servicio público sin más límite
        // documentado que "no lo satures" — bajo la misma ráfaga de sync
        // que agota el presupuesto de WCL, también puede devolver error.
        snapshotFetchError = err instanceof Error ? err.message : String(err);
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
      snapshotFetchError: string | null;
    }[] = [];

    for (const wclDifficultyId of difficultyIds) {
      const difficultyName = WCL_DIFFICULTY_NAME_BY_ID[wclDifficultyId] ?? `Dificultad ${wclDifficultyId}`;
      const mapping = resolveDb2Difficulty(snapshot, journalEncounterId, { name: difficultyName, sizes: WCL_DIFFICULTY_RAID_SIZES[wclDifficultyId] ?? [] }, abilities);
      const abilitiesForDifficulty = filterAbilitiesForDifficulty(abilities, snapshot, mapping);
      // Si DB2 restringe explícitamente una sección y excluye esta dificultad,
      // se marca la fila antigua como no aplicable en vez de borrarla: así
      // sobreviven la clasificación y las notas manuales para auditoría.
      const includedAbilityIds = new Set(abilitiesForDifficulty.map((ability) => ability.abilityId));
      const officiallyExcludedAbilityIds = abilities.filter((ability) => !includedAbilityIds.has(ability.abilityId)).map((ability) => ability.abilityId);
      if (officiallyExcludedAbilityIds.length) {
        const { error: applicabilityError } = await supabase
          .from('boss_mechanics_candidates')
          .update({ official_difficulty_applicable: false, updated_at: new Date().toISOString() })
          .eq('boss_id', body.bossId)
          .eq('difficulty', difficultyName)
          .in('ability_id', officiallyExcludedAbilityIds);
        if (applicabilityError) throw applicabilityError;
      }

      // Cross-check best-effort: el fight más reciente que tengáis de este boss
      // en esta dificultad exacta. Cruce por NOMBRE (ver _shared/ability-name-match.ts):
      // el ability_id del Journal casi nunca coincide con el abilityGameID
      // real de WCL (verificado en real: 0/54 candidatas de un boss casaban
      // por ID) — así que se resuelve el nombre real de cada cast observado y
      // se compara contra el nombre de la candidata, no contra su ID.
      const sampleFight = (seenFights ?? []).find((f) => f.wcl_difficulty_id === wclDifficultyId);
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
        // §"sync profundo no rellenó nada": segunda fuente de comportamiento,
        // agregada por-fight (table de WCL, una sola llamada) en vez de
        // por-cast — cobertura mucho más alta cuando el boss tiene pocos
        // casts reales por log. null si WCL no respondió (best-effort, no
        // debe tumbar el resto del cruce por-cast que ya funcionaba).
        damageTally: Map<number, AbilityPlayerTally> | null;
        tankNames: Set<string> | null;
      }
      const interruptedNames = new Set<string>();
      const referenceBundles: ReferenceBundle[] = [];
      let referenceReportCode: string | null = null;
      let referenceFetchError: string | null = null;
      const referenceCount = body.deepSync
        ? (DEEP_SYNC_REFERENCE_COUNT_BY_DIFFICULTY[difficultyName] ?? DEFAULT_DEEP_SYNC_REFERENCE_COUNT)
        : QUICK_SYNC_REFERENCE_COUNT;
      try {
        // §pide directamente el número de páginas que hagan falta para
        // referenceCount (ver fetchPublicRankings — page ya no está topado
        // en 50, verificado en real) — antes se pedía siempre 1 página y
        // resolveTopReportRefs recortaba, así que un boss con
        // referenceCount>50 (Mítico) se quedaba corto de candidatas aunque
        // WCL tuviera más disponibles.
        const rankings = await fetchPublicRankings(encounterId, Number(wclDifficultyId), referenceCount);
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

        const topRefs = await resolveTopReportRefs(rankings, referenceCount);
        // §HTTP 546 real (ver nota de maxPages arriba): bajado de 4 a 3 —
        // menos payloads pesados en memoria a la vez. Más lento en tiempo de
        // pared, pero el techo real resultó ser memoria, no tiempo (30
        // referencias con concurrencia 4 tardaron 65s sin problema; 21 de un
        // boss más pesado murieron con 546 a los 48s — no es una cuestión de
        // cuántas, es de cuántas EN PARALELO a la vez).
        const REFERENCE_CONCURRENCY = 3;
        for (let batchStart = 0; batchStart < topRefs.length; batchStart += REFERENCE_CONCURRENCY) {
          const batch = topRefs.slice(batchStart, batchStart + REFERENCE_CONCURRENCY);
          await Promise.all(batch.map((ref) => processReferenceFight(ref)));
        }

        async function processReferenceFight(ref: { code: string; fightId: number; startTime: number; endTime: number; raidSize: number }) {
          const [interrupts, casts, damageTaken, deaths, referenceAbilities, damageTakenTable, roles] = await Promise.all([
            getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'Interrupts', startTime: ref.startTime, endTime: ref.endTime, maxPages: 3 }),
            getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'Casts', startTime: ref.startTime, endTime: ref.endTime, maxPages: 5, hostilityType: 'Enemies' }),
            // §HTTP 546 (WORKER_RESOURCE_LIMIT) real en producción (2026-08-27,
            // boss 3445 Mítico, solo 21 referencias): maxPages:10 sin
            // hostilityType podía traer hasta 10.000 eventos de daño CRUDOS
            // por referencia (todo el daño del fight, no solo el del boss),
            // mantenidos en memoria simultáneamente para las ~20-120
            // referencias — buildBehaviorSample solo usa damageTaken dentro
            // de una ventana de 4s tras un cast concreto (REFERENCE_REACTION_WINDOW_MS),
            // nunca el fight entero. 4 páginas es un techo real más bajo sin
            // vaciar esa ventana en fights normales.
            getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'DamageTaken', startTime: ref.startTime, endTime: ref.endTime, maxPages: 4 }),
            getFightEvents({ code: ref.code, fightId: ref.fightId, dataType: 'Deaths', startTime: ref.startTime, endTime: ref.endTime, maxPages: 3 }),
            getReportAbilities(ref.code),
            getDamageTakenByPlayerTable({ code: ref.code, fightId: ref.fightId, startTime: ref.startTime, endTime: ref.endTime }).catch(() => null),
            getFightPlayerRoles({ code: ref.code, fightId: ref.fightId, startTime: ref.startTime, endTime: ref.endTime }).catch(() => null),
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
            damageTally: damageTakenTable ? tallyPlayersHitPerAbility(damageTakenTable) : null,
            tankNames: roles ? new Set([...roles.entries()].filter(([, role]) => role === 'tank').map(([name]) => name)) : null,
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

      // Segunda fuente de comportamiento, agregada por-fight (ver
      // AggregateBehaviorSample) — solo hace falta que la ability haya hecho
      // daño a ALGUIEN en algún momento del fight, no emparejar un cast
      // concreto. Se calcula para TODAS las candidatas (es barato: ya está
      // todo pre-agregado en bundle.damageTally), aunque solo se usa de
      // verdad cuando buildBehaviorSample no dio nada (ver inferMechanicCategory).
      function buildAggregateBehaviorSample(candidateName: string): AggregateBehaviorSample | null {
        const ratios: number[] = [];
        const tankRatios: number[] = [];
        for (const bundle of referenceBundles) {
          if (!bundle.raidSize || !bundle.damageTally) continue;
          const realIds = bundle.idsByName.get(normalizeAbilityName(candidateName)) ?? [];
          if (!realIds.length) continue;
          let playersHit: Set<string> | null = null;
          for (const id of realIds) {
            const tally = bundle.damageTally.get(id);
            if (!tally) continue;
            playersHit = playersHit ? new Set([...playersHit, ...tally.playersHit]) : new Set(tally.playersHit);
          }
          if (!playersHit || !playersHit.size) continue;
          ratios.push(playersHit.size / bundle.raidSize);
          if (bundle.tankNames) {
            const tankHits = [...playersHit].filter((p) => bundle.tankNames!.has(p)).length;
            tankRatios.push(tankHits / playersHit.size);
          }
        }
        if (!ratios.length) return null;
        return {
          playersHitRatio: ratios.reduce((a, b) => a + b, 0) / ratios.length,
          tankHitRatio: tankRatios.length ? tankRatios.reduce((a, b) => a + b, 0) / tankRatios.length : null,
          referenceFightCount: ratios.length,
        };
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
        // OJO: se calcula SIEMPRE, no solo cuando `behavior` es null — el
        // cruce por-cast puede existir pero caer en la banda ambigua de
        // inferCategoryFromBehavior (ratio 0.35-0.6, ni raid-damage ni
        // avoidable-ground) y aun así no decir nada. inferMechanicCategory
        // ya sabe usar el agregado solo cuando la INFERENCIA por-cast no
        // decidió nada (no solo cuando la muestra no existía) — gatear aquí
        // por `behavior` en vez de por su resultado desaprovechaba esos
        // casos. Verificado en real: "Possession Barrage" tenía 83
        // occurrences por-cast con ratio ~58% (banda ambigua, sin
        // categoría) mientras el agregado por-fight decía 100% de la raid
        // golpeada — señal mucho más nítida que se estaba descartando sin usar.
        const aggregateBehavior = buildAggregateBehaviorSample(candidate.name);
        const wasInterruptedInReference = interruptedNames.has(normalizeAbilityName(candidate.name));
        const observedInReferenceLogs = behavior != null || aggregateBehavior != null || wasInterruptedInReference;
        let inference = inferMechanicCategory(candidate.name, candidate.description || null, behavior, aggregateBehavior);
        if (wasInterruptedInReference && inference?.category !== 'interrupt') {
          // Evidencia real (evento Interrupts observado) por encima de cualquier heurística de texto/comportamiento.
          inference = {
            category: 'interrupt',
            reasons: ['Log de referencia: se interrumpió de verdad (evento Interrupts real).', ...(inference?.reasons ?? [])],
          };
        }
        // El número enseñado tiene que ser coherente con la categoría
        // enseñada: si la categoría final vino del agregado (porque el
        // cruce por-cast existía pero cayó en la banda ambigua, ver arriba),
        // enseñar el ratio POR-CAST aquí sería contradictorio (ej. "raid-damage,
        // golpeó al 58%" cuando la razón real fue el 100% del agregado).
        const perCastDecided = behavior ? inferCategoryFromBehavior(behavior) : null;
        const referenceAvgPlayersHit = perCastDecided
          ? Math.round((behavior!.targetRatiosPerCast.reduce((a, b) => a + b, 0) / behavior!.targetRatiosPerCast.length) * avgReferenceRaidSize * 10) / 10
          : aggregateBehavior
            ? Math.round(aggregateBehavior.playersHitRatio * avgReferenceRaidSize * 10) / 10
            : behavior && behavior.occurrences
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
              name_es: abilityNamesEs.get(candidate.abilityId) ?? null,
              description: candidate.description || null,
              icon_url: null,
              sources: ['blizzard-journal', ...(observedInReferenceLogs ? ['wcl-reference'] : []), ...(observedNames.has(normalizeAbilityName(candidate.name)) ? ['guild-log'] : [])],
              observed_in_logs: observedNames.has(normalizeAbilityName(candidate.name)),
              inferred_category: inference?.category ?? null,
              inferred_category_reasons: inference?.reasons ?? [],
              journal_encounter_id: journalEncounterId,
              // §bug real reportado y contrastado en real (2026-08-27, boss
              // 3445 "Entombed Sentinels"): cuando Wago DB2 o WCL fallan
              // (rate limit, caída temporal — ver snapshotFetchError/
              // referenceFetchError), sus valores de ESTA pasada quedan a
              // null/vacíos — eso significa "hoy no lo sabemos", no
              // "confirmado que no aplica". Escribirlos incondicionalmente
              // BORRABA datos buenos de un sync anterior con éxito
              // (contrastado en real: las 4 exclusiones válidas de Normal
              // volvieron a "aplicable", y observed_in_reference_logs/
              // reference_occurrences de varias mecánicas volvieron a
              // vacío, justo tras un sync con Wago/WCL caídos). upsert()
              // solo toca las claves que le pasas (ver nota de más abajo) —
              // omitir la clave del todo cuando esta pasada no tiene un
              // dato fiable deja el valor previo intacto en vez de
              // sobrescribirlo a ciegas con "no hay nada".
              ...(mapping.db2DifficultyId != null
                ? { official_difficulty_applicable: true, db2_difficulty_id: mapping.db2DifficultyId, difficulty_mapping_status: mapping.status }
                : {}),
              ...(!referenceFetchError
                ? {
                    observed_in_reference_logs: observedInReferenceLogs,
                    observed_as_interrupt: wasInterruptedInReference,
                    reference_avg_players_hit: referenceAvgPlayersHit,
                    reference_occurrences: behavior?.occurrences ?? null,
                    reference_source_report: referenceReportCode,
                    // §"severidad variable estilo Wipefest" (feedback real,
                    // 2026-08-27): el ratio CRUDO por cast (no la media que
                    // ya se guarda arriba) — es la muestra que consume
                    // resolveSeverity en _shared/mechanic-severity.ts para
                    // comparar un pull real contra la distribución de logs
                    // de referencia. Mismo dato que ya se calculaba
                    // (behavior.targetRatiosPerCast), solo que antes se
                    // colapsaba a un único número y se descartaba.
                    reference_hit_ratio_samples: behavior?.targetRatiosPerCast?.length ? [...behavior.targetRatiosPerCast].sort((a, b) => a - b) : null,
                  }
                : {}),
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
        snapshotFetchError,
      });
    }

    return jsonResponse({ ok: true, bossName, journalEncounterId, candidates: abilities.length, upserts, difficulties: difficultySummary });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
