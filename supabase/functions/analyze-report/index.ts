import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  getFightEvents,
  getFightGraph,
  getFightPlayerRoles,
  sumGraphSeries,
  getFightPlayerRankings,
  getReportAbilities,
  getReportActors,
  getReportFights,
  isEncounterFight,
  type WclActor,
} from '../_shared/wcl-client.ts';
import { activeDefensives, defensivesForClass, type CooldownCatalog, type TalentGate } from '../_shared/defensive-cooldowns.ts';
import { attributeWindowAbility, detectDamageWindows } from '../_shared/damage-pressure-windows.ts';
import { getItemName, getSpecName, getCurrentBuildNamespace } from '../_shared/blizzard-client.ts';
import { buildFromBlizzardNamespace, fetchTalentSpellLookup } from '../_shared/wago-db2-client.ts';
import { resolveConsumableAbilityIds, buildConsumableUsage } from '../_shared/consumables.ts';
import { normalizeAbilityName, buildAbilityIdsByName } from '../_shared/ability-name-match.ts';
import { computeDamageProfile } from '../_shared/damage-profile.ts';
import { upsertReportEncounters } from '../_shared/report-encounters.ts';
import { resolveSeverity } from '../_shared/mechanic-severity.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { pullIngestionRecoveryAction } from '../_shared/report-ingestion-recovery.ts';
import { detectWipeCall as detectWipeCallShared, type WipeCallDetection } from '../_shared/wipe-call-detection.ts';
import { PULL_CONTEXT_COMMAND_VERSION } from '../_shared/pull-evaluation-context.ts';
import { detectUnassignedMechanicOccurrences, type UnassignedMechanicCatalogEntry, type ActorLite, type GenericEvent } from '../_shared/unassigned-mechanics.ts';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  effectiveDefensiveDataFromDatabaseRows,
  fingerprintTalentBuild,
  inferCurrentGameBuildObservation,
  normalizeTalentBuild,
  resolveEffectiveDefensiveKit,
  type TalentBuildNode,
} from '../_shared/effective-defensives.ts';
import { effectiveDeathOptions, evaluateEffectiveWindowCoverage } from '../_shared/effective-defensive-state.ts';
import { evaluateDefensivePull } from '../_shared/defensive-execution-persistence.ts';

// "Engancharse a los pulls": trae fights nuevos de WCL y genera `pulls` +
// `player_pull_records` reales. A PROPÓSITO no llama al LLM aquí — eso es
// generate-pull-brief, una función aparte. Motivo: un log histórico puede
// traer decenas de pulls de golpe, y traer los eventos de cada uno (Deaths +
// DamageTaken, hasta 20 páginas cada uno) ya tarda; si además hubiera que
// esperar una respuesta del LLM por cada uno en la misma llamada HTTP, el
// fetch del navegador acaba abortando ("Failed to send a request to the Edge
// Function") mucho antes de terminar. Por eso esta función procesa como
// mucho `maxFights` fights nuevos y devuelve `remaining` — el cliente la
// llama en bucle hasta ponerse al día (funciona igual para un log en vivo
// que para el de ayer con 30 pulls), y solo pide un brief para el pull más
// reciente que haya quedado procesado, no para todos.

const WCL_DIFFICULTY_NAME_BY_ID: Record<number, string> = { 1: 'LFR', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };
const DEFAULT_MAX_FIGHTS_PER_CALL = 3;

// Orden de inventario estándar de WoW: los slots de trinket son los índices
// 12 y 13 del array `gear` de combatantInfo (verificado en real el
// 2026-08-22 contra un pull real: índice 12 traía icono "raidtrinkets").
// Repetido aquí y en pull-analysis.service.ts (Deno vs. navegador, runtimes
// distintos, no comparten módulo) — si cambia, cambia en los dos sitios.
const TRINKET_SLOT_INDICES = [12, 13];

interface DeathEvent {
  timestamp?: number;
  targetID?: number;
  killingAbilityGameID?: number;
}
interface DamageEvent {
  timestamp?: number;
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
  amount?: number;
  absorbed?: number;
  buffs?: string;
  hitPoints?: number;
  maxHitPoints?: number;
  resources?: { hitPoints?: number; maxHitPoints?: number } | null;
}
interface CastEvent {
  timestamp?: number;
  abilityGameID?: number;
  sourceID?: number;
  targetID?: number;
}
interface ThroughputEvent {
  sourceID?: number;
  amount?: number;
  // targetID/timestamp no se usaban antes (solo hacía falta sourceID+amount
  // para el agregado de dps/hps) — WCL ya los trae en el JSON crudo, se
  // exponen aquí para §10 (rootCause 'no_healing_received': hace falta saber
  // A QUIÉN curó cada tick, no solo cuánto curó cada sanador en total).
  targetID?: number;
  timestamp?: number;
}
interface CombatantInfoEvent {
  sourceID?: number;
  specID?: number;
  // OJO: `talents` (verificado en real el 2026-08-22) es un campo legado del
  // sistema de talentos pre-Shadowlands y siempre viene vacío ahora — el
  // build real del árbol de talentos actual está en `talentTree`
  // ([{ id, rank, nodeID }], IDs crudos de nodo/opción). `id` se enriquece
  // más abajo con un `spellId` real cruzando TraitNodeEntry+TraitDefinition
  // de Wago DB2 (ver talentSpellLookup) — así el front puede pintar cada
  // talento con tooltip de Wowhead en vez de "N nodos".
  talentTree?: unknown[];
  gear?: unknown[];
}
interface MechanicRow {
  ability_id: number;
  name: string;
  description: string | null;
  category: string | null;
  responsibility: string | null;
  inferred_category: string | null;
  observed_as_interrupt: boolean;
  avoidable: boolean | null;
  severity_threshold: number | null;
  /** Muestra cruda de logs públicos de referencia (nivel 2 de resolveSeverity) — ver sync-boss-mechanics/index.ts. null si el boss no se ha (re)clasificado desde que existe esta columna. */
  reference_hit_ratio_samples: number[] | null;
}

function effectiveMechanicCategory(mechanic: MechanicRow, observedInCurrentReport = false): string | null {
  const category = mechanic.category ?? mechanic.inferred_category;
  if (category === 'interrupt' && !mechanic.observed_as_interrupt && !observedInCurrentReport) return null;
  return category;
}
interface InterruptEvent {
  timestamp?: number;
  extraAbilityGameID?: number; // verificado en real el 2026-08-22 contra un log público: es la habilidad que SE interrumpió, no la que interrumpe
  // §"wipefest para mejorar en el boss concreto... informe de mejora por
  // jugador" (feedback real, 2026-08-27): quién lanzó el interrupt. Ya
  // venía en el JSON crudo de WCL (todo evento trae sourceID), solo no se
  // leía porque hasta ahora bastaba con el booleano wasInterrupted.
  sourceID?: number;
}

// §"Dispels — sin ingestión de eventos de dispel" (feedback real): mismo
// contrato que InterruptEvent — extraAbilityGameID es la habilidad (debuff)
// que se quitó, no la spell de dispel usada. isBuff=true = se robó/quitó un
// BUFF del enemigo (dispel ofensivo), no un debuff de un aliado — no cuenta
// para "¿se limpió el debuff-stack de la raid?".
interface DispelEvent {
  timestamp?: number;
  sourceID?: number;
  targetID?: number;
  extraAbilityGameID?: number;
  isBuff?: boolean;
}

// Ventana de reacción para atribuir daño/muertes a un cast concreto del boss.
// Es la misma idea del §12 de la hoja de ruta (response_window_ms por
// mecánica), simplificada a un valor fijo: el manifiesto todavía no tiene
// esa columna por mecánica, y 4s cubre con margen la mayoría de mecánicas de
// "golpea y hace daño" sin confundir un cast con el siguiente.
const MECHANIC_REACTION_WINDOW_MS = 4000;

// Cuánto puede tener de "viejo" el último snapshot de buffs conocido de un
// jugador para seguir usándolo como "lo que tenía activo al morir". 2s es un
// término medio: bastante para encontrar un evento con `buffs` cercano
// (verificado en real que a veces faltan 1-2 eventos seguidos), pero no
// tanto como para dar por bueno un estado ya desactualizado.
const DEATH_BUFF_STALENESS_MS = 2000;

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  let reportCode: string | undefined;
  let maxFights = DEFAULT_MAX_FIGHTS_PER_CALL;
  let activePullId: string | null = null;
  try {
    const body = await req.json();
    reportCode = body.reportCode;
    if (typeof body.maxFights === 'number' && body.maxFights > 0) maxFights = Math.min(body.maxFights, 10);
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!reportCode) {
    return jsonResponse({ ok: false, error: 'reportCode es obligatorio' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, // service_role: salta RLS, solo vive aquí
  );

  try {
    const { data: reportRow } = await supabase
      .from('reports')
      .select('last_processed_fight_id, possible_duplicate_of')
      .eq('code', reportCode)
      .maybeSingle();
    const lastProcessedFightId = reportRow?.last_processed_fight_id ?? 0;
    let possibleDuplicateOf: string | null = reportRow?.possible_duplicate_of ?? null;

    const reportDetail = await getReportFights(reportCode);

    // OJO (bug real encontrado en producción, corregido aquí): `report_encounters.report_code`
    // tiene FK contra `reports.code` — en un report nuevo, upsertReportEncounters tiene que
    // ejecutarse DESPUÉS de que exista la fila en `reports`, o el insert falla en silencio
    // (el helper traga el error y devuelve 0 sin avisar) y report_encounters se queda vacía.
    if (!reportRow) {
      // §"la noche duplicada... dos personas subieron el mismo log" (bug
      // real encontrado y arreglado a mano el 2026-08-23): sin esto, dos
      // reports de la MISMA sesión (dos addons subiendo el mismo log)
      // duplican cada pull/muerte/mecánica en todo el pipeline. Antes de
      // crear la fila, se busca otro report YA importado con inicio a ±6h
      // y ≥2 bosses en común — evidencia fuerte de que es la misma noche.
      // NUNCA bloquea el import (podría ser una segunda sesión real el
      // mismo día) — solo deja un aviso visible para que el RL decida.
      const encounterIdsHere = new Set(reportDetail.fights.filter(isEncounterFight).map((f) => f.encounterID));
      if (encounterIdsHere.size) {
        const DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000;
        const { data: nearbyReports } = await supabase
          .from('reports')
          .select('code')
          .gte('start_time', reportDetail.startTime - DUPLICATE_WINDOW_MS)
          .lte('start_time', reportDetail.startTime + DUPLICATE_WINDOW_MS);
        for (const nearby of nearbyReports ?? []) {
          const { data: nearbyEncounters } = await supabase.from('report_encounters').select('encounter_id').eq('report_code', nearby.code);
          const sharedCount = new Set((nearbyEncounters ?? []).map((e) => e.encounter_id).filter((id) => encounterIdsHere.has(id))).size;
          if (sharedCount >= 2) {
            possibleDuplicateOf = nearby.code;
            break;
          }
        }
      }

      await supabase.from('reports').upsert(
        {
          code: reportCode,
          title: reportDetail.title,
          zone_id: reportDetail.zone?.id ?? null,
          zone_name: reportDetail.zone?.name ?? null,
          is_raid: reportDetail.fights.some(isEncounterFight),
          start_time: reportDetail.startTime,
          end_time: null,
          possible_duplicate_of: possibleDuplicateOf,
        },
        { onConflict: 'code', ignoreDuplicates: true },
      );
    }
    // Un log en vivo pegado a mano nunca pasa por sync-reports — asegura que
    // esta tabla (de donde sale la lista de bosses del report) siempre esté al día.
    await upsertReportEncounters(supabase, reportCode, reportDetail.fights);

    // §"WCL tiene fases de encuentro, importarlas" (feedback real): metadata
    // ESTÁTICA por boss (nombre de cada fase, si es intermedio), igual para
    // todos los pulls de este batch — se sincroniza una vez por invocación.
    // Best-effort: nunca bloquea el análisis si falla, igual que
    // talent_spell_lookup más abajo.
    if (reportDetail.phases.length) {
      const phaseRows = reportDetail.phases.flatMap((encounter) =>
        encounter.phases.map((phase) => ({
          boss_id: String(encounter.encounterID),
          phase_id: phase.id,
          name: phase.name,
          is_intermission: phase.isIntermission,
          separates_wipes: encounter.separatesWipes,
          updated_at: new Date().toISOString(),
        })),
      );
      if (phaseRows.length) {
        await supabase.from('boss_encounter_phases').upsert(phaseRows, { onConflict: 'boss_id,phase_id' }).then(
          () => {},
          (err) => console.error('No se pudo sincronizar boss_encounter_phases (no bloqueante):', err),
        );
      }
    }

    const allNewFights = reportDetail.fights.filter((f) => isEncounterFight(f) && f.id > lastProcessedFightId).sort((a, b) => a.id - b.id);
    const batch = allNewFights.slice(0, maxFights);
    const remaining = allNewFights.length - batch.length;

    let newestPullId: string | null = null;

    if (batch.length) {
      const actors = await getReportActors(reportCode);
      const actorById = new Map<number, WclActor>(actors.map((a) => [a.id, a]));

      // El Journal de Blizzard NO documenta todas las habilidades que hacen
      // daño real (verificado en real 2026-08-22: solo 1 de 29 muertes de un
      // wipe coincidía con las candidatas del Journal). masterData.abilities
      // de WCL sí tiene nombre real para prácticamente cualquier ID que
      // aparezca en el log — es la misma fuente que usa la propia web de WCL
      // para mostrar nombres. Se trae una vez por report, no por fight.
      const abilities = await getReportAbilities(reportCode);
      const abilityNameById = new Map(abilities.map((a) => [a.gameID, a.name]));
      // Puente por nombre (ver _shared/ability-name-match.ts): el ability_id
      // del Journal casi nunca coincide con el abilityGameID real que WCL usa
      // en Casts/DamageTaken/Deaths (verificado en real: 0/54 candidatas de
      // un boss casaban por ID) — pero el NOMBRE mostrado sí casi siempre. Se
      // construye una vez por report (nombre real -> todos los abilityGameID
      // reales que lo comparten, puede haber varios por fases/variantes).
      const realIdsByName = buildAbilityIdsByName(abilities);
      // §consumibles: resuelto por NOMBRE contra las abilities reales de este
      // report, nunca un ID fijo (ver _shared/consumables.ts — el nombre de
      // la poción de vida cambia cada tier, "Healthstone" no).
      const consumableIds = resolveConsumableAbilityIds(abilities);

      // §12.1: catálogo real de defensivos, sincronizado desde WoWAnalyzer
      // (o la semilla manual mientras no se haya sincronizado nada aún).
      // Se carga UNA VEZ por report, no por fight ni por evento.
      const { data: catalogRows } = await supabase.from('cooldown_catalog').select('class,spec,spec_override,spell_id,name,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,survival_type,excluded').eq('excluded', false);
      const cooldownCatalog: CooldownCatalog = (catalogRows ?? []).map((r) => ({
        spellId: r.spell_id,
        name: r.name,
        class: r.class,
        spec: r.spec,
        specOverride: r.spec_override ?? null,
        category: r.category,
        baseCooldownMs: r.base_cooldown_ms,
        durationMs: r.base_duration_ms,
        survivalType: r.survival_type ?? null,
      }));

      // Talentos → spell ID real, para tooltips de Wowhead (ver
      // wago-db2-client.ts para la cadena TraitNodeEntry->TraitDefinition
      // verificada con datos reales). §"han desaparecido todos los
      // talentos": esto ANTES pedía dos tablas DB2 completas a wago.tools en
      // CADA reprocesado (miles de filas de todas las clases) — lento y
      // ocasionalmente fallaba/tardaba de más, degradando en silencio a
      // "sin resolver" (a propósito, para no bloquear el análisis). Ahora se
      // cachea en talent_spell_lookup por build de juego: solo cambia cuando
      // Blizzard saca un parche, así que una vez resuelto no hace falta
      // volver a pedirlo — la caché quita la parte flaky del camino
      // caliente sin quitar el fallback (si build o caché fallan, sigue sin
      // bloquear el análisis).
      let talentSpellLookup: Map<number, number> | null = null;
      let currentGameBuild: string | null = null;
      try {
        const namespace = await getCurrentBuildNamespace();
        if (namespace) {
          const build = buildFromBlizzardNamespace(namespace);
          currentGameBuild = build;
          const { data: cached } = await supabase.from('talent_spell_lookup').select('entry_to_spell').eq('build', build).maybeSingle();
          if (cached) {
            talentSpellLookup = new Map(Object.entries(cached.entry_to_spell as Record<string, number>).map(([id, spellId]) => [Number(id), spellId]));
          } else {
            const fresh = (await fetchTalentSpellLookup(build)).entryIdToSpellId;
            talentSpellLookup = fresh;
            const entry_to_spell = Object.fromEntries([...fresh.entries()].map(([id, spellId]) => [String(id), spellId]));
            // Best-effort: si el insert falla (ej. carrera con otra invocación
            // guardando el mismo build a la vez), no bloquea — se recalculará
            // en la siguiente invocación sin caché, sin más coste que hoy.
            await supabase.from('talent_spell_lookup').upsert({ build, entry_to_spell }).then(
              () => {},
              (err) => console.error('No se pudo cachear talent_spell_lookup (no bloqueante):', err),
            );
          }
        }
      } catch (err) {
        console.error('No se pudieron resolver talentos a spell ID (se guardan sin resolver):', err);
      }

      // Resolver v2 en shadow: las tablas secundarias se cargan best-effort y
      // cualquier dato incompleto queda en warnings. La migración M2 sí debe
      // preceder al despliegue porque el insert ya escribe columnas v2. El
      // shadow no modifica death_cause ni defensive_pressure_windows.
      const resolverShadowWarnings: string[] = [];
      const [specProfilesResult, modifierRulesResult, overridesResult] = await Promise.all([
        supabase.from('defensive_spec_profiles').select('*'),
        supabase.from('defensive_modifier_rules').select('*').eq('active', true),
        currentGameBuild
          ? supabase.from('player_defensive_overrides').select('*').eq('game_build', currentGameBuild).eq('active', true)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (specProfilesResult.error) resolverShadowWarnings.push(`defensive_spec_profiles: ${specProfilesResult.error.message}`);
      if (modifierRulesResult.error) resolverShadowWarnings.push(`defensive_modifier_rules: ${modifierRulesResult.error.message}`);
      if (overridesResult.error) resolverShadowWarnings.push(`player_defensive_overrides: ${overridesResult.error.message}`);
      const resolverData = effectiveDefensiveDataFromDatabaseRows({
        catalogRows: catalogRows ?? [],
        specProfileRows: specProfilesResult.data ?? [],
        modifierRuleRows: modifierRulesResult.data ?? [],
        overrideRows: overridesResult.data ?? [],
      });

      for (const fight of batch) {
        const bossId = String(fight.encounterID);
        const difficulty = fight.difficulty != null ? (WCL_DIFFICULTY_NAME_BY_ID[fight.difficulty] ?? `Dificultad ${fight.difficulty}`) : 'Desconocida';
        const { data: existingPull, error: existingPullError } = await supabase
          .from('pulls')
          .select('id,ingestion_status')
          .eq('report_code', reportCode)
          .eq('fight_id', fight.id)
          .maybeSingle();
        if (existingPullError) throw existingPullError;

        const recoveryAction = pullIngestionRecoveryAction(existingPull);
        if (recoveryAction === 'reuse_complete') {
          const { error: cursorError } = await supabase
            .from('reports')
            .update({ last_processed_fight_id: fight.id })
            .eq('code', reportCode);
          if (cursorError) throw cursorError;
          newestPullId = existingPull.id;
          continue;
        }
        if (recoveryAction === 'replace_incomplete') {
          const { data: removedPull, error: removeError } = await supabase
            .from('pulls')
            .delete()
            .eq('id', existingPull.id)
            .neq('ingestion_status', 'complete')
            .select('id')
            .maybeSingle();
          if (removeError) throw removeError;
          if (!removedPull) {
            throw new Error(`El pull ${fight.id} cambió de estado durante la recuperación; reintenta la importación.`);
          }
        }
        const normalizedFightName = normalizeAbilityName(fight.name);
        const bossActorIds = new Set(
          actors
            .filter((actor) => {
              if (actor.type !== 'NPC') return false;
              const actorName = normalizeAbilityName(actor.name);
              return actorName === normalizedFightName || actorName.includes(normalizedFightName) || normalizedFightName.includes(actorName);
            })
            .map((actor) => actor.id),
        );

        const { count: priorPulls } = await supabase
          .from('pulls')
          .select('id', { count: 'exact', head: true })
          .eq('boss_id', bossId)
          .eq('difficulty', difficulty);

        // §"el timeline es horrible, rehacerlo con algo real y útil": daño
        // recibido por TODA la raid en el tiempo, agregado server-side por
        // WCL (mismo endpoint que alimenta su propia gráfica) — best-effort,
        // si falla el pull se sigue guardando igual, solo sin gráfica.
        let raidDamageTakenSeries: { pointIntervalMs: number; points: number[] } | null = null;
        // §"picos de daño... juntando ventanas de daño sufrido + defensivos"
        // (feedback real, 2026-08-29): MISMA respuesta que raidDamageTakenSeries
        // arriba, por actorId — sin llamada nueva a WCL. Ver damage-pressure-windows.ts.
        const damageTakenSeriesByActorId = new Map<number, { pointStart: number; pointIntervalMs: number; points: number[] }>();
        try {
          const graph = await getFightGraph({ code: reportCode, fightId: fight.id, dataType: 'DamageTaken', hostilityType: 'Friendlies', startTime: fight.startTime, endTime: fight.endTime });
          if (graph) {
            raidDamageTakenSeries = sumGraphSeries(graph.series);
            for (const s of graph.series) {
              damageTakenSeriesByActorId.set(s.id, { pointStart: s.pointStart, pointIntervalMs: s.pointInterval, points: s.data });
            }
          }
        } catch (err) {
          console.error('analyze-report: no se pudo traer graph(DamageTaken) para el pull', fight.id, err);
        }

        // §3.1/§7.1: percentil real de WCL por jugador — best-effort igual
        // que la gráfica de arriba (un log privado sin permiso de ranking,
        // o un boss recién publicado sin rankear todavía, no debe tumbar el
        // resto del análisis del pull).
        let playerRankings: Map<string, { rankPercent: number; totalParses: number }> | null = null;
        try {
          playerRankings = await getFightPlayerRankings(reportCode, fight.id);
        } catch (err) {
          console.error('analyze-report: no se pudo traer rankings() para el pull', fight.id, err);
        }

        // Rol real del mismo fight para reconocer autoataques del boss sobre
        // no-tanks. Best-effort: si Summary falla se usa la spec como fallback.
        let playerRoles: Map<string, 'tank' | 'healer' | 'dps'> | null = null;
        try {
          playerRoles = await getFightPlayerRoles({ code: reportCode, fightId: fight.id, startTime: fight.startTime, endTime: fight.endTime });
        } catch (err) {
          console.error('analyze-report: no se pudieron traer roles de Summary para el pull', fight.id, err);
        }

        const { data: insertedPull, error: pullError } = await supabase
          .from('pulls')
          .insert({
            report_code: reportCode,
            fight_id: fight.id,
            boss_id: bossId,
            difficulty,
            pull_number: (priorPulls ?? 0) + 1,
            wipe_pct: fight.kill ? 0 : (fight.bossPercentage ?? null),
            duration_ms: fight.endTime - fight.startTime,
            observed_at: new Date(reportDetail.startTime + fight.startTime).toISOString(),
            closed_at: new Date().toISOString(),
            raid_damage_taken_series: raidDamageTakenSeries,
            // §"fases de encuentro": disponibles directamente en `fight`, sin
            // fetch aparte — null en los tres si WCL no define fases para
            // este boss (fight de una sola fase), no un fallo de ingesta.
            phase_transitions: fight.phaseTransitions,
            last_phase_absolute_index: fight.lastPhaseAsAbsoluteIndex,
            last_phase_is_intermission: fight.lastPhaseIsIntermission,
            ingestion_status: 'processing',
            ingestion_error: null,
          })
          .select('id')
          .single();
        if (pullError) throw pullError;
        activePullId = insertedPull.id;
        newestPullId = insertedPull.id;

        // Mecánicas curadas de este boss+dificultad — el matching depende
        // directamente de lo que se haya sincronizado/revisado en la sección de mecánicas.
        const { data: mechanics } = await supabase
          .from('applicable_boss_mechanics_candidates')
          .select('ability_id,name,description,category,responsibility,inferred_category,observed_as_interrupt,avoidable,severity_threshold,reference_hit_ratio_samples')
          .eq('boss_id', bossId)
          .eq('difficulty', difficulty)
          .returns<MechanicRow[]>();

        // §"la raid debe hacerlo... no marca a nadie a propósito" (feedback
        // real, 2026-08-29): catálogo de mecánicas SIN asignación fija de
        // este boss+dificultad — ver _shared/unassigned-mechanics.ts. Mismo
        // patrón que `mechanics` justo arriba (tabla pequeña, filtrada por
        // boss+dificultad en la propia query en vez de traer todo el
        // catálogo y filtrar a mano).
        // §verificado 2026-08-29 contra Lvp1VCbzmwTRHdQ7 (ver migración
        // 20260829040000): una fila puede estar "investigada" (NPC/ability
        // real, guía de Wowhead real) sin que WCL registre NUNCA un evento
        // real de esa interacción — comprobado contra TODOS los pulls reales
        // de dos bosses, kill incluido, cero eventos. has_confirmed_detection
        // solo es true una vez visto al menos una ocurrencia real, para que
        // una fila sin señal no aparente funcionar en silencio.
        const { data: unassignedMechanicRows } = await supabase
          .from('unassigned_mechanic_catalog')
          .select('id,ability_id,actor_name_pattern,name,detection_type,applied_by')
          .eq('boss_id', bossId)
          .eq('difficulty', difficulty)
          .eq('has_confirmed_detection', true)
          .returns<
            { id: string; ability_id: number | null; actor_name_pattern: string | null; name: string; detection_type: UnassignedMechanicCatalogEntry['detectionType']; applied_by: UnassignedMechanicCatalogEntry['appliedBy'] }[]
          >();
        const unassignedMechanicCatalog: UnassignedMechanicCatalogEntry[] = (unassignedMechanicRows ?? []).map((r) => ({
          id: r.id,
          abilityId: r.ability_id,
          actorNamePattern: r.actor_name_pattern,
          name: r.name,
          detectionType: r.detection_type,
          appliedBy: r.applied_by,
        }));
        // Solo se piden Debuffs/Buffs (dataTypes que HOY no se piden nunca en
        // esta función, ver nota en unassigned-mechanics.ts) si el catálogo
        // de ESTE boss+dificultad de verdad los necesita — no gastar cuota
        // de páginas de WCL en los bosses que solo usan npc_interaction/cast.
        const needsUnassignedDebuffEvents = unassignedMechanicCatalog.some((e) => e.detectionType === 'debuff_applied');
        const needsUnassignedBuffEvents = unassignedMechanicCatalog.some((e) => e.detectionType === 'buff_applied');

        // §"variable como wipefest" (feedback real, 2026-08-27): nivel 1 de
        // resolveSeverity — ratios de kills PROPIOS de Avoid en este boss+
        // dificultad, agrupados por ability_id. Una consulta por fight
        // (mismo criterio que la de `mechanics` justo arriba, que tampoco
        // se cachea entre fights del mismo batch) contra own_mechanic_hit_ratios
        // (ver migración 20260827220000 — ya viene kill-only y sin filas de
        // categoría interrupt).
        const { data: ownRatioRows } = await supabase
          .from('own_mechanic_hit_ratios')
          .select('ability_id,hit_ratio')
          .eq('boss_id', bossId)
          .eq('difficulty', difficulty)
          .returns<{ ability_id: number; hit_ratio: number }[]>();
        const ownHistoryRatiosByAbilityId = new Map<number, number[]>();
        for (const row of ownRatioRows ?? []) {
          const arr = ownHistoryRatiosByAbilityId.get(row.ability_id);
          if (arr) arr.push(row.hit_ratio);
          else ownHistoryRatiosByAbilityId.set(row.ability_id, [row.hit_ratio]);
        }
        // Mapa DEFINITIVO "abilityGameID real de WCL -> mecánica curada":
        // combina el match directo por ID (por si alguna vez sí coincide) con
        // el match por nombre (el que de verdad funciona casi siempre, ver
        // nota de realIdsByName más arriba). No pisa un match directo por ID
        // ya existente si el nombre apuntara a otra fila distinta.
        const mechanicById = new Map<number, MechanicRow>();
        for (const m of mechanics ?? []) {
          if (!mechanicById.has(m.ability_id)) mechanicById.set(m.ability_id, m);
          for (const realId of realIdsByName.get(normalizeAbilityName(m.name)) ?? []) {
            if (!mechanicById.has(realId)) mechanicById.set(realId, m);
          }
        }
        const avoidableAbilityIds = new Set([...mechanicById.entries()].filter(([, m]) => m.avoidable === true).map(([id]) => id));

        // Casts partido en dos consultas por hostilityType (no una sola sin
        // filtrar): verificado en real que los casts de ~25 jugadores ahogan
        // los del boss dentro del mismo límite de páginas — un pull de 5-6
        // min genera miles de casts de jugadores frente a unas pocas decenas
        // del boss. friendlyCastEvents alimenta defensivos/consumibles
        // (siempre casts de jugadores); enemyCastEvents alimenta
        // pull_mechanic_events (siempre casts del boss) — cada uno con su
        // propio presupuesto de páginas en vez de competir por el mismo.
        const [deathEvents, damageEvents, friendlyCastEvents, enemyCastEvents, damageDoneEvents, healingEvents, combatantInfoEvents, interruptEvents, dispelEvents] = await Promise.all([
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Deaths', startTime: fight.startTime, endTime: fight.endTime }),
          // Los recursos del objetivo permiten distinguir un burst real de
          // >=80% de vida máxima en 1s aunque hubiera daño anterior. Solo se
          // activan aquí porque WCL avisa de que aumentan bastante el payload.
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'DamageTaken', startTime: fight.startTime, endTime: fight.endTime, includeResources: true }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Casts', startTime: fight.startTime, endTime: fight.endTime, hostilityType: 'Friendlies' }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Casts', startTime: fight.startTime, endTime: fight.endTime, hostilityType: 'Enemies' }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'DamageDone', startTime: fight.startTime, endTime: fight.endTime }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Healing', startTime: fight.startTime, endTime: fight.endTime }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'CombatantInfo', startTime: fight.startTime, endTime: fight.endTime }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Interrupts', startTime: fight.startTime, endTime: fight.endTime }),
          // §"Dispels — sin ingestión de eventos de dispel" (feedback real):
          // extraAbilityGameID = la habilidad (debuff) que se quitó, mismo
          // contrato que ya usa InterruptEvent para "qué se interrumpió" —
          // verificado en real contra un pull propio.
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Dispels', startTime: fight.startTime, endTime: fight.endTime }),
        ]);

        // §unassigned-mechanics: Debuffs/Buffs condicionales (ver
        // needsUnassignedDebuffEvents/needsUnassignedBuffEvents arriba) —
        // fuera del Promise.all grande de arriba a propósito, para no tocar
        // ese bloque ya verificado y para que quede claro que son dos
        // dataTypes nuevos, pedidos solo cuando hacen falta.
        const [unassignedDebuffEvents, unassignedBuffEvents] = await Promise.all([
          needsUnassignedDebuffEvents
            ? getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Debuffs', startTime: fight.startTime, endTime: fight.endTime })
            : Promise.resolve([] as Record<string, unknown>[]),
          needsUnassignedBuffEvents
            ? getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Buffs', startTime: fight.startTime, endTime: fight.endTime })
            : Promise.resolve([] as Record<string, unknown>[]),
        ]);
        // Verificado empíricamente contra Lvp1VCbzmwTRHdQ7 antes de escribir
        // esta llamada (huevos de Ula'tek y orbe del Altar son NPC-actors
        // reales golpeados/casteados por jugadores — ver migración
        // 20260829030000 y unassigned-mechanics.ts). fight.friendlyPlayers
        // es la misma fuente que ya usa detectNinjaPull/playerRecords más
        // abajo para "quién es jugador en este fight".
        const unassignedMechanicOccurrences = detectUnassignedMechanicOccurrences({
          catalog: unassignedMechanicCatalog,
          fightStartTime: fight.startTime,
          castEvents: friendlyCastEvents as GenericEvent[],
          damageDoneEvents: damageDoneEvents as GenericEvent[],
          debuffEvents: unassignedDebuffEvents as GenericEvent[],
          buffEvents: unassignedBuffEvents as GenericEvent[],
          actorById: actorById as unknown as Map<number, ActorLite>,
          playerActorIds: new Set(fight.friendlyPlayers),
        });

        // §3/§7: dps/hps (simplificación: duración total del pull, no el
        // "active time" que usa la propia web de WCL — puede quedar algo por
        // debajo de lo que enseña WCL para jugadores con huecos sin objetivo),
        // absorciones y talentos/trinkets (combatantInfo). Se calculan aquí
        // porque son la misma tanda de eventos que ya se está trayendo.
        const durationSeconds = Math.max((fight.endTime - fight.startTime) / 1000, 1);
        const damageDoneByActor = new Map<number, number>();
        for (const raw of damageDoneEvents) {
          const e = raw as ThroughputEvent;
          if (typeof e.sourceID === 'number') damageDoneByActor.set(e.sourceID, (damageDoneByActor.get(e.sourceID) ?? 0) + (e.amount ?? 0));
        }
        const healingByActor = new Map<number, number>();
        // §10 rootCause 'no_healing_received' + §"cuánto recibió en los
        // últimos segundos": no solo CUÁNDO le curaron (para el sí/no de
        // rootCause) sino CUÁNTO (para el número real que pide la tabla de
        // "a quién dirigir") — misma tanda de eventos que ya se traía para
        // hps, ningún fetch nuevo.
        const healingEventsByTarget = new Map<number, { timestamp: number; amount: number }[]>();
        for (const raw of healingEvents) {
          const e = raw as ThroughputEvent;
          if (typeof e.sourceID === 'number') healingByActor.set(e.sourceID, (healingByActor.get(e.sourceID) ?? 0) + (e.amount ?? 0));
          if (typeof e.targetID === 'number' && typeof e.timestamp === 'number') {
            if (!healingEventsByTarget.has(e.targetID)) healingEventsByTarget.set(e.targetID, []);
            healingEventsByTarget.get(e.targetID)!.push({ timestamp: e.timestamp, amount: e.amount ?? 0 });
          }
        }
        const combatantInfoByActor = new Map<number, CombatantInfoEvent>();
        for (const raw of combatantInfoEvents) {
          const e = raw as CombatantInfoEvent;
          if (typeof e.sourceID === 'number') combatantInfoByActor.set(e.sourceID, e);
        }

        // §3: nombres reales de trinkets/spec en vez de "ilvl 308"/"79 nodos"
        // sin más — se resuelven una vez por fight (con caché en memoria
        // dentro de blizzard-client.ts, así que un trinket/spec ya visto en
        // un fight anterior de este mismo lote no vuelve a pedirse).
        const trinketIds = new Set<number>();
        const specIds = new Set<number>();
        for (const info of combatantInfoByActor.values()) {
          for (const i of TRINKET_SLOT_INDICES) {
            const item = info.gear?.[i] as { id?: number } | undefined;
            if (item?.id) trinketIds.add(item.id);
          }
          if (typeof info.specID === 'number') specIds.add(info.specID);
        }
        const [trinketNameEntries, specNameEntries] = await Promise.all([
          Promise.all([...trinketIds].map(async (id) => [id, await getItemName(id)] as const)),
          Promise.all([...specIds].map(async (id) => [id, await getSpecName(id)] as const)),
        ]);
        const trinketNameById = new Map(trinketNameEntries);
        const specNameById = new Map(specNameEntries);
        // Centralizado — se necesita en varios sitios de este bloque
        // (defensivos activos por evento, defensivos del catálogo al morir,
        // el campo `spec` final del registro) y antes solo se resolvía en el
        // último de ellos, así que los anteriores no podían filtrar por spec.
        function resolveSpec(actorId: number): string | null {
          const specId = combatantInfoByActor.get(actorId)?.specID;
          return typeof specId === 'number' ? (specNameById.get(specId) ?? null) : null;
        }

        const TANK_SPECS = new Set(['Blood', 'Vengeance', 'Guardian', 'Brewmaster', 'Protection']);
        function isTankActor(actorId: number): boolean {
          const actor = actorById.get(actorId);
          if (actor && playerRoles?.get(actor.name) === 'tank') return true;
          return TANK_SPECS.has(resolveSpec(actorId) ?? '');
        }

        // §"que los defensivos disponibles sean propios de la clase o de los
        // talentos... hay cosas que no están por talentos o son pasivas":
        // allTalentSpellIds sale del MISMO talentSpellLookup ya resuelto
        // arriba (todos los spellId que existen como nodo de talento, de
        // cualquier clase) — no es una llamada nueva. playerTalentSpellIds
        // es el árbol REAL de este jugador en este pull. Sin talentSpellLookup
        // (falló la resolución ese report) se devuelve null: activeDefensives/
        // defensivesForClass no filtran de más por falta de dato.
        const allTalentSpellIds = talentSpellLookup ? new Set(talentSpellLookup.values()) : null;
        function talentGateForActor(actorId: number): TalentGate | null {
          if (!allTalentSpellIds || !talentSpellLookup) return null;
          const tree = combatantInfoByActor.get(actorId)?.talentTree;
          if (!tree) return null;
          const playerTalentSpellIds = new Set(
            (tree as { id?: number }[])
              .map((node) => (typeof node.id === 'number' ? talentSpellLookup!.get(node.id) : undefined))
              .filter((id): id is number => typeof id === 'number'),
          );
          return { allTalentSpellIds, playerTalentSpellIds };
        }

        // §3/§12: "qué defensivos tenía disponibles" de verdad — no solo "lo
        // lanzó alguna vez", sino próximo_disponible(t) = último_cast_antes_de(t)
        // + base_cooldown_ms, igual que describe la hoja de ruta. Se guardan
        // TODOS los timestamps de cast de cada spell del catálogo por
        // jugador (friendlyCastEvents llega en orden cronológico de WCL, así
        // que cada array queda ya ordenado — no hace falta un sort aparte).
        const defensiveCastTimestampsByActor = new Map<number, Map<number, number[]>>();
        const defensiveCastEventsByActor = new Map<number, Map<number, { timestamp: number; targetID: number | null }[]>>();
        for (const raw of friendlyCastEvents) {
          const e = raw as CastEvent;
          if (typeof e.sourceID !== 'number' || typeof e.abilityGameID !== 'number') continue;
          if (!defensiveCastTimestampsByActor.has(e.sourceID)) defensiveCastTimestampsByActor.set(e.sourceID, new Map());
          const perSpell = defensiveCastTimestampsByActor.get(e.sourceID)!;
          if (!perSpell.has(e.abilityGameID)) perSpell.set(e.abilityGameID, []);
          perSpell.get(e.abilityGameID)!.push(e.timestamp ?? 0);
          if (!defensiveCastEventsByActor.has(e.sourceID)) defensiveCastEventsByActor.set(e.sourceID, new Map());
          const perSpellEvents = defensiveCastEventsByActor.get(e.sourceID)!;
          if (!perSpellEvents.has(e.abilityGameID)) perSpellEvents.set(e.abilityGameID, []);
          perSpellEvents.get(e.abilityGameID)!.push({
            timestamp: e.timestamp ?? 0,
            targetID: typeof e.targetID === 'number' ? e.targetID : null,
          });
        }

        const deathByTarget = new Map<number, { timestamp: number; killingAbilityGameID: number }>();
        for (const raw of deathEvents) {
          const e = raw as DeathEvent;
          if (typeof e.targetID === 'number') {
            deathByTarget.set(e.targetID, { timestamp: e.timestamp ?? 0, killingAbilityGameID: e.killingAbilityGameID ?? 0 });
          }
        }

        const avoidableDamageByTarget = new Map<number, number>();
        // targetID -> mechanicId -> daño acumulado. El desglose es lo que permite
        // luego responder "¿QUÉ mecánica nos está haciendo daño?", no solo cuánto en total.
        const mechanicDamageByTarget = new Map<number, Map<number, number>>();
        const defensivesSeenByTarget = new Map<number, Map<number, string>>(); // targetID -> spellId -> name
        // OJO (bug real encontrado el 2026-08-22, corregido aquí): el campo
        // `buffs` de WCL NO viene en todos los eventos — verificado en real
        // que en un golpe mortal con 4 ticks casi simultáneos, NINGUNO traía
        // `buffs`, mientras que un evento 2s antes sí lo traía. La versión
        // anterior solo miraba el evento EXACTO de la muerte: si ese evento
        // no traía `buffs` (frecuente), lo interpretaba como "confirmado sin
        // defensivo" en vez de "no lo sabemos" — por eso TODAS las muertes
        // salían con "sin ningún defensivo activo". Ahora se guarda el ÚLTIMO
        // snapshot de buffs visto para cada jugador (de cualquier evento, no
        // solo el de la muerte) y se usa si cae dentro de una ventana
        // razonable antes de morir; si no hay ninguno reciente, queda null
        // (desconocido), no "false" disfrazado de "true".
        const lastBuffsSnapshotByTarget = new Map<number, { buffs: string; timestamp: number }>();
        const absorbedByTarget = new Map<number, number>();
        // §"oneshot vs. daño sostenido": includeResources añade la vida
        // máxima del objetivo a DamageTaken. Se conserva además TODO el
        // historial de los 5s finales para medir cuánto se concentró en el
        // último segundo y mantener un fallback para logs antiguos.
        const damageEventsByTarget = new Map<number, DamageEvent[]>();

        for (const raw of damageEvents) {
          const e = raw as DamageEvent;
          if (typeof e.targetID !== 'number') continue;
          const actor = actorById.get(e.targetID);

          if (!damageEventsByTarget.has(e.targetID)) damageEventsByTarget.set(e.targetID, []);
          damageEventsByTarget.get(e.targetID)!.push(e);

          if (e.absorbed) absorbedByTarget.set(e.targetID, (absorbedByTarget.get(e.targetID) ?? 0) + e.absorbed);

          if (typeof e.abilityGameID === 'number' && avoidableAbilityIds.has(e.abilityGameID)) {
            avoidableDamageByTarget.set(e.targetID, (avoidableDamageByTarget.get(e.targetID) ?? 0) + (e.amount ?? 0));
            if (!mechanicDamageByTarget.has(e.targetID)) mechanicDamageByTarget.set(e.targetID, new Map());
            const perMechanic = mechanicDamageByTarget.get(e.targetID)!;
            perMechanic.set(e.abilityGameID, (perMechanic.get(e.abilityGameID) ?? 0) + (e.amount ?? 0));
          }

          if (actor) {
            for (const cd of activeDefensives(e.buffs, actor.subType, resolveSpec(e.targetID), cooldownCatalog, talentGateForActor(e.targetID))) {
              if (!defensivesSeenByTarget.has(e.targetID)) defensivesSeenByTarget.set(e.targetID, new Map());
              defensivesSeenByTarget.get(e.targetID)!.set(cd.spellId, cd.name);
            }
          }

          // Snapshot más reciente de auras del jugador, de CUALQUIER golpe que
          // reciba (no solo el que lo mata) — los eventos llegan en orden
          // cronológico, así que el último que se procese es el más reciente.
          if (e.buffs !== undefined) {
            lastBuffsSnapshotByTarget.set(e.targetID, { buffs: e.buffs, timestamp: e.timestamp ?? 0 });
          }
        }

        // §consumibles: disponibilidad de piedra de brujo — hubo algún
        // Warlock en la friendly list de ESTE pull concreto (puede variar
        // pull a pull si hay bench/sustituciones).
        const warlockPresent = fight.friendlyPlayers.some((id) => actorById.get(id)?.subType === 'Warlock');

        // Ventana de los últimos segundos antes de morir. El clasificador
        // separa el contexto (5s) del burst no curable (1s): el daño previo
        // ya no diluye varios impactos simultáneos que resten >=80% de vida.
        interface DamageWindowHit {
          time_ms: number; // relativo al inicio del pull, como el resto de timestamps que se guardan
          amount: number;
          ability_id: number | null;
          ability_name: string | null;
        }
        function computeDeathDamageProfile(
          targetId: number,
          deathTimestamp: number,
        ): { damageProfile: 'burst' | 'sustained' | 'unknown'; killingBlowAmount: number | null; damageWindowTotal: number; damageWindowHits: number; terminalBurstDamage: number; burstWindowMs: number; maxHitPoints: number | null; burstHealthPct: number | null; damageWindowEvents: DamageWindowHit[] } {
          const profile = computeDamageProfile(damageEventsByTarget.get(targetId) ?? [], deathTimestamp);
          // §13.4 "la secuencia real de golpes antes de morir, no solo una
          // frase": hasta ahora solo se guardaba el agregado — el mini-timeline
          // del drawer de procedencia necesita cada golpe individual.
          const damageWindowEvents: DamageWindowHit[] = profile.windowEvents
            .map((e) => ({
              time_ms: (e.timestamp ?? 0) - fight.startTime,
              amount: e.amount ?? 0,
              ability_id: e.abilityGameID ?? null,
              ability_name: typeof e.abilityGameID === 'number' ? (abilityNameById.get(e.abilityGameID) ?? null) : null,
            }))
            .sort((a, b) => a.time_ms - b.time_ms);
          return {
            damageProfile: profile.damageProfile,
            killingBlowAmount: profile.killingBlowAmount,
            damageWindowTotal: profile.damageWindowTotal,
            damageWindowHits: profile.damageWindowHits,
            terminalBurstDamage: profile.terminalBurstDamage,
            burstWindowMs: profile.burstWindowMs,
            maxHitPoints: profile.maxHitPoints,
            burstHealthPct: profile.burstHealthPct,
            damageWindowEvents,
          };
        }

        // Un autoataque del boss sobre un no-tank significa que el boss ya no
        // tenía un tank operativo (muerto, fuera de combate o sin poder
        // mantenerlo). Se conserva como hecho en la tabla, pero no se evalúa
        // como error del objetivo ni como oportunidad de usar defensivo,
        // piedra o poción. La comprobación es deliberadamente estricta:
        // killing ability "Melee", fuente = actor del boss y sin otro daño
        // mezclado en los 2s finales.
        const BOSS_MELEE_EXCLUSIVE_WINDOW_MS = 2000;
        function isBossMeleeOnNonTank(actorId: number, death: { timestamp: number; killingAbilityGameID: number }): boolean {
          if (isTankActor(actorId) || bossActorIds.size === 0) return false;
          if (normalizeAbilityName(abilityNameById.get(death.killingAbilityGameID) ?? '') !== 'melee') return false;
          const recentDamage = (damageEventsByTarget.get(actorId) ?? []).filter(
            (event) => (event.amount ?? 0) > 0 && (event.timestamp ?? 0) <= death.timestamp && (event.timestamp ?? 0) >= death.timestamp - BOSS_MELEE_EXCLUSIVE_WINDOW_MS,
          );
          if (!recentDamage.length) return false;
          return recentDamage.every(
            (event) =>
              event.abilityGameID === death.killingAbilityGameID &&
              typeof event.sourceID === 'number' &&
              bossActorIds.has(event.sourceID),
          );
        }

        // §10 (hoja de ruta / auditoría v2): "no es lo mismo un oneshot que
        // una muerte por daño sostenido sin sanar, y dentro de cada una la
        // causa real puede ser muy distinta". Deliberadamente MÁS ACOTADO que
        // las 6 causas del documento original: undispelled_debuff y
        // tank_swap_missed harían falta events(dataType: Debuffs) y una
        // señal de stacks de amenaza que hoy no se traen — mejor devolver
        // 'unclassified' que inventar una causa sin evidencia real detrás
        // (mismo principio que ya rige todo lo demás de este pipeline). Las
        // que SÍ se pueden defender con los datos que ya se traen:
        //  - self_positioning / unsoaked_mechanic: la CATEGORÍA de la
        //    mecánica ya dice el tipo de respuesta esperada (evitar el
        //    suelo/separarse = responsabilidad individual; soak = falta de
        //    coordinación del grupo) — no hace falta reconstruir a cuánta
        //    gente golpeó ESTA instancia en concreto para eso.
        //  - no_healing_received: perfil de daño sostenido (no un burst) +
        //    ningún tick de sanación real dirigido a este jugador en los
        //    segundos previos — ahora que healingEventsByTarget existe,
        //    sin necesitar ninguna llamada nueva a WCL.
        const NO_HEAL_LOOKBACK_MS = 6000;
        // §"Dispels — sin ingestión de eventos de dispel" (feedback real):
        // ventana generosa hacia atrás desde la muerte para buscar un dispel
        // real de ESTA habilidad sobre ESTE jugador — un stack que se limpió
        // hace un minuto y se volvió a aplicar sin que nadie lo repitiera
        // sigue siendo "sin dispel" para la aplicación que mató.
        const DISPEL_LOOKBACK_MS = 15_000;
        function computeRootCause(
          actorId: number,
          deathTimestamp: number,
          category: string | null,
          damageProfile: 'burst' | 'sustained' | 'unknown',
          killingAbilityGameID: number,
        ): 'self_positioning' | 'unsoaked_mechanic' | 'no_healing_received' | 'undispelled_debuff' | 'unclassified' {
          if (category === 'avoidable-ground' || category === 'spread') return 'self_positioning';
          if (category === 'soak') return 'unsoaked_mechanic';
          // Antes deliberadamente sin implementar (ver nota histórica en el
          // roadmap): hacía falta events(dataType: Dispels), que ahora sí se
          // trae. Solo se afirma "sin dispel" con evidencia real de que a
          // ESTE jugador nunca se le quitó ESTA habilidad concreta — no se
          // asume por descarte.
          if (category === 'debuff-stack') {
            const wasDispelled = dispelEvents.some((raw) => {
              const e = raw as DispelEvent;
              return (
                e.extraAbilityGameID === killingAbilityGameID &&
                e.targetID === actorId &&
                !e.isBuff &&
                (e.timestamp ?? 0) <= deathTimestamp &&
                (e.timestamp ?? 0) >= deathTimestamp - DISPEL_LOOKBACK_MS
              );
            });
            if (!wasDispelled) return 'undispelled_debuff';
          }
          if (damageProfile === 'sustained') {
            const heals = healingEventsByTarget.get(actorId) ?? [];
            const hadRecentHeal = heals.some((h) => h.timestamp <= deathTimestamp && h.timestamp >= deathTimestamp - NO_HEAL_LOOKBACK_MS);
            if (!hadRecentHeal) return 'no_healing_received';
          }
          return 'unclassified';
        }

        // §"a quién dirigir: healing sí/no y cuánto recibió en los últimos
        // 5-10s": misma ventana que se usa para juzgar rootCause
        // (NO_HEAL_LOOKBACK_MS), pero aquí se quiere el NÚMERO real, no solo
        // el sí/no — un jugador puede haber recibido sanación real y aun así
        // haber muerto (la sanación no fue suficiente), que es una historia
        // de coaching distinta a "nadie le curó".
        function computeHealingReceived(actorId: number, deathTimestamp: number): { healingWindowTotal: number; healingWindowHits: number } {
          const heals = (healingEventsByTarget.get(actorId) ?? []).filter(
            (h) => h.timestamp <= deathTimestamp && h.timestamp >= deathTimestamp - NO_HEAL_LOOKBACK_MS,
          );
          return { healingWindowTotal: heals.reduce((sum, h) => sum + h.amount, 0), healingWindowHits: heals.length };
        }

        // §"cuándo se determina un wipe global... yo como RL digo 'vamos a
        // wipear'" (feedback real, investigado contra un caso real de esta
        // guild): la señal más engañosa es "cuánta gente muere a la vez" —
        // en un pull real, 18/22 murieron en el mismo segundo a la MISMA
        // ability (Elemental Explosion): eso es una mecánica real que
        // revienta a la raid entera de golpe, NO un wipe call. Un wipe call
        // de verdad se distingue por CÓMO mueren, no solo cuántos a la vez:
        // causas de muerte HETEROGÉNEAS (cada uno muere a lo que tuviera
        // encima) y la sanación/el daño de la raid se desploman justo antes
        // (nadie sigue intentando). Solo se evalúa en wipes — un kill nunca
        // es un wipe call por definición.
        // §"Hay que ver la manera de centralizar esta información y,
        // sobretodo, en hacerla fiable" (feedback real, 2026-08-28): la
        // detección en sí vive en _shared/wipe-call-detection.ts — así
        // reanalyze-wipe-call/index.ts puede recalcular el veredicto de un
        // pull YA analizado (p.ej. tras corregir el algoritmo) con la
        // MISMA lógica, sin una segunda copia que pueda divergir.
        function detectWipeCall(): WipeCallDetection | null {
          return detectWipeCallShared({
            fight,
            deaths: [...deathByTarget.entries()].map(([actorId, d]) => ({ actorId, timestamp: d.timestamp, killingAbilityGameID: d.killingAbilityGameID })),
            healingEvents: [...healingEventsByTarget.values()].flat(),
            damageDoneEvents: damageDoneEvents as ThroughputEvent[],
            damageProfileOf: (actorId, timestamp) => computeDeathDamageProfile(actorId, timestamp).damageProfile,
          });
        }

        // §"un ninja pull... también cuenta en la estadística de wipes...
        // habría que clasificarlo de otra manera para saberlo" (feedback
        // real): alguien engancha al boss sin que la raid lo haya decidido
        // -- WCL igual crea una fight real, de unos pocos segundos, donde
        // casi nadie de la raid llegó a entrar en combate. No es un intento
        // fallido, es que no hubo intento. Igual que el wipe call: nunca se
        // borra la fila (conserva duración/pull_number/contexto), solo se
        // excluye de las estadísticas que asumen que hubo un intento real.
        // Un kill nunca es ninja pull -- si el boss murió, hubo intento.
        //
        // §"hay muchos que estan al 99.8% o 100% incluso el try... ni aunque
        // se quede al 96%, si el combate dura menos de 40-50 segundos y
        // apenas le baja la vida, es un ninja pull o un wipe call y debería
        // excluirse" (feedback real, 2026-08-27): la duración por sí sola
        // (15s) se quedaba corta -- un pull de 16s a un 100% de vida del
        // boss (caso real visto) no llegaba ni a evaluarse. Dos señales
        // INDEPENDIENTES, cualquiera de las dos basta para excluir (antes
        // las dos tenían que darse a la vez):
        //  - fracción de la raid que llegó a "engancharse" (murió o recibió
        //    daño durante el pull) muy baja -- nadie llegó a entrar en
        //    combate de verdad;
        //  - al boss apenas le bajó la vida -- aunque TODA la raid se
        //    enganchara, si en <45s el boss sigue casi a full vida no fue un
        //    intento real evaluable (accidente o wipe call casi instantáneo,
        //    a efectos de estadísticas da igual cuál de los dos).
        // La duración sigue siendo obligatoria en ambos casos: un wipe real
        // y largo que además hizo poco daño (un enrage temprano, un pull
        // duro de verdad) SÍ debe seguir contando -- no es "poco daño" lo
        // que lo descarta, es "poco daño Y muy poco tiempo".
        const NINJA_PULL_MAX_DURATION_MS = 45_000;
        const NINJA_PULL_MAX_ENGAGED_FRACTION = 0.3;
        const NINJA_PULL_MIN_BOSS_HEALTH_PCT = 90; // wipe_pct >= esto = al boss le queda ≥90% de vida = "apenas le baja la vida"

        interface NinjaPullDetection {
          candidate: boolean;
          confidence: number;
          signals: {
            durationMs: number;
            raidSize: number;
            engagedPlayerCount: number;
            engagedFraction: number;
            bossHealthPct: number | null;
            barelyDamagedBoss: boolean;
          };
        }

        function detectNinjaPull(): NinjaPullDetection | null {
          if (fight.kill) return null;
          const durationMs = fight.endTime - fight.startTime;
          if (durationMs >= NINJA_PULL_MAX_DURATION_MS) return null;

          const raidSizeForNinjaCheck = fight.friendlyPlayers.length;
          if (!raidSizeForNinjaCheck) return null;
          const engagedPlayerCount = fight.friendlyPlayers.filter(
            (actorId) => deathByTarget.has(actorId) || (damageEventsByTarget.get(actorId)?.length ?? 0) > 0,
          ).length;
          const engagedFraction = engagedPlayerCount / raidSizeForNinjaCheck;
          const bossHealthPct = fight.bossPercentage ?? null;
          const barelyDamagedBoss = bossHealthPct != null && bossHealthPct >= NINJA_PULL_MIN_BOSS_HEALTH_PCT;

          return {
            candidate: engagedFraction <= NINJA_PULL_MAX_ENGAGED_FRACTION || barelyDamagedBoss,
            confidence: Math.round(Math.max(
              engagedFraction <= NINJA_PULL_MAX_ENGAGED_FRACTION ? (1 - engagedFraction) * 100 : 0,
              barelyDamagedBoss ? Math.min(80, 50 + (bossHealthPct! - NINJA_PULL_MIN_BOSS_HEALTH_PCT) * 3) : 0,
            )),
            signals: {
              durationMs,
              raidSize: raidSizeForNinjaCheck,
              engagedPlayerCount,
              engagedFraction: Math.round(engagedFraction * 100) / 100,
              bossHealthPct,
              barelyDamagedBoss,
            },
          };
        }

        const wipeCallDetection = detectWipeCall();
        const ninjaPullDetection = detectNinjaPull();
        const pullUpdatePatch: Record<string, unknown> = {};
        if (wipeCallDetection) {
          pullUpdatePatch.wipe_call_confidence = wipeCallDetection.confidence;
          pullUpdatePatch.wipe_call_signals = wipeCallDetection.signals;
          // El detector es un sensor. Solo un officer convierte el candidato
          // en límite autoritativo mediante set-pull-evaluation-context.
          pullUpdatePatch.wipe_call_excluded = false;
        }
        if (ninjaPullDetection) {
          pullUpdatePatch.is_ninja_pull = ninjaPullDetection.candidate;
          pullUpdatePatch.ninja_pull_signals = ninjaPullDetection.signals;
          pullUpdatePatch.ninja_pull_excluded = false;
        }
        // §unassigned-mechanics: se guarda siempre que el catálogo de este
        // boss+dificultad tenga alguna fila, aunque el resultado sea un
        // array vacío (nadie la resolvió este pull) — un array vacío real es
        // información distinta de "nunca se calculó" (null, bosses sin
        // catálogo todavía).
        if (unassignedMechanicCatalog.length) {
          pullUpdatePatch.unassigned_mechanic_occurrences = unassignedMechanicOccurrences;
        }
        if (Object.keys(pullUpdatePatch).length) {
          await supabase.from('pulls').update(pullUpdatePatch).eq('id', insertedPull.id);
        }

        // Crea la autoridad para pulls nuevos. Candidatos y hechos crudos se
        // conservan en evidence, pero el intervalo completo sigue evaluable.
        const durationMs = Math.max(0, fight.endTime - fight.startTime);
        const { error: contextError } = await supabase.rpc('set_pull_evaluation_context_v2', {
          p_pull_id: insertedPull.id,
          p_evaluation_eligible: true,
          p_evaluation_start_ms: 0,
          p_evaluation_end_ms: durationMs,
          p_cutoff_reason: 'fight_end',
          p_wipe_call_at_ms: null,
          p_wipe_call_boss_hp_pct: null,
          p_wipe_call_source: 'none',
          p_wipe_call_confidence: null,
          p_wipe_call_verified: false,
          p_ninja_status: ninjaPullDetection?.candidate ? 'probable' : 'valid',
          p_ninja_source: ninjaPullDetection?.candidate ? 'heuristic' : 'imported',
          p_ninja_confidence: ninjaPullDetection?.candidate ? ninjaPullDetection.confidence : null,
          p_evidence: {
            ...(wipeCallDetection ? { wipeCallCandidate: { boundaryMs: wipeCallDetection.signals.wipeCallStartMs, confidence: wipeCallDetection.confidence, evidence: wipeCallDetection.signals } } : {}),
            ...(ninjaPullDetection ? { ninjaPullCandidate: { confidence: ninjaPullDetection.confidence, evidence: ninjaPullDetection.signals } } : {}),
          },
          p_resolver_version: PULL_CONTEXT_COMMAND_VERSION,
          p_reason: 'Contexto inicial derivado de sensores; ninguna exclusión automática.',
          p_changed_by: null,
        });
        if (contextError) throw new Error(`No se pudo crear PullEvaluationContext: ${contextError.message}`);

        const defensiveResolutionEvaluatedAt = new Date().toISOString();
        const playerRecords = await Promise.all(fight.friendlyPlayers.map(async (actorId) => {
          const actor = actorById.get(actorId);
          const death = deathByTarget.get(actorId);
          const mechanic = death ? mechanicById.get(death.killingAbilityGameID) : undefined;
          // Se calculan una vez aquí (antes solo vivían inline dentro del
          // spread de death_cause) porque §10/rootCause también los necesita
          // — mismo dato, dos consumidores, sin recalcular category dos veces.
          const deathEffectiveCategory = mechanic ? effectiveMechanicCategory(mechanic) : null;
          const deathDamageProfile = death ? computeDeathDamageProfile(actorId, death.timestamp) : null;
          const deathHealingReceived = death ? computeHealingReceived(actorId, death.timestamp) : null;
          const bossMeleeOnNonTank = death ? isBossMeleeOnNonTank(actorId, death) : false;
          const buffsSnapshot = death ? lastBuffsSnapshotByTarget.get(actorId) : undefined;
          const buffsSnapshotIsFresh = death != null && buffsSnapshot != null && Math.abs(death.timestamp - buffsSnapshot.timestamp) <= DEATH_BUFF_STALENESS_MS;
          const defensivesAtDeath = buffsSnapshotIsFresh && actor ? activeDefensives(buffsSnapshot.buffs, actor.subType, resolveSpec(actorId), cooldownCatalog, talentGateForActor(actorId)) : [];
          const defensivesSeen = [...(defensivesSeenByTarget.get(actorId)?.entries() ?? [])].map(([spellId, name]) => ({ spellId, name }));

          // El snapshot reciente de buffs aporta únicamente la evidencia de
          // estado activo. Cooldown, duración y cargas se resolverán más abajo
          // por effectiveDefensiveStateAt a partir del kit efectivo v2.
          const activeSpellIds = new Set(defensivesAtDeath.map((d) => d.spellId));
          // §"picos de daño... juntando ventanas de daño sufrido + defensivos
          // que usa y tiene disponible" (feedback real, 2026-08-29): ver
          // damage-pressure-windows.ts para el diseño completo (validado
          // empíricamente contra 3 pulls reales y 5 perfiles de clase antes
          // de escribir esto). Best-effort — sin serie de daño para este
          // actor (falló el graph() de arriba, o el jugador apenas recibió
          // daño) se queda en [], no tumba el resto del pull.
          const damageSeries = damageTakenSeriesByActorId.get(actorId);
          const defensivePressureWindowSensor =
            damageSeries && actor
              ? (() => {
                  const { baselineValue, windows } = detectDamageWindows(damageSeries.points, damageSeries.pointStart, damageSeries.pointIntervalMs);
                  const actorDamageEvents = damageEventsByTarget.get(actorId) ?? [];
                  return {
                    baselineValue,
                    windows: windows.map((w) => {
                      // §"relacionar 'pico de daño recibido' con una
                      // habilidad del boss, de forma veraz" (feedback real,
                      // 2026-08-29): MISMA resolución de nombre que ya usa
                      // death_cause.mechanicName — curado (mechanicById) si
                      // esta abilityGameID es una mecánica clasificada,
                      // nombre real de WCL si no, null solo si ninguna de
                      // las dos lo tiene (rarísimo). Validado empíricamente
                      // contra datos reales antes de escribir esto.
                      const dominant = attributeWindowAbility(actorDamageEvents, w.startMs, w.endMs);
                      const dominantMechanic = dominant ? mechanicById.get(dominant.abilityGameID) : undefined;
                      return {
                        startMs: w.startMs - fight.startTime,
                        endMs: w.endMs - fight.startTime,
                        peakMs: w.peakMs - fight.startTime,
                        peakValue: w.peakValue,
                        mechanicId: dominant?.abilityGameID ?? null,
                        mechanicName: dominant ? (dominantMechanic?.name ?? abilityNameById.get(dominant.abilityGameID) ?? null) : null,
                      };
                    }),
                  };
                })()
              : { baselineValue: 0, windows: [] };

          const observedBuild = inferCurrentGameBuildObservation({
            currentGameBuild,
            reportStartTimeMs: reportDetail.startTime,
            fightStartTimeMs: fight.startTime,
          });
          const rawTalentBuild = normalizeTalentBuild(
            (combatantInfoByActor.get(actorId)?.talentTree?.map((node) => {
              const n = node as { id?: number; rank?: number; nodeID?: number };
              return { id: n.id ?? 0, nodeID: n.nodeID ?? 0, rank: n.rank ?? 0 };
            }) ?? null) as TalentBuildNode[] | null,
          );
          const shadowTalentLookup = observedBuild.gameBuild === currentGameBuild ? talentSpellLookup : null;
          const talentBuild = normalizeTalentBuild(
            rawTalentBuild?.map((node) => {
              const spellId = shadowTalentLookup?.get(node.id);
              return spellId ? { ...node, spellId } : node;
            }) ?? null,
          );
          const playerSpec = resolveSpec(actorId);
          const talentBuildFingerprint = actor && observedBuild.gameBuild
            ? await fingerprintTalentBuild(actor.subType, playerSpec, observedBuild.gameBuild, talentBuild)
            : null;
          const resolvedKit = actor
            ? resolveEffectiveDefensiveKit(
                {
                  className: actor.subType,
                  specName: playerSpec,
                  talentBuild,
                  buildFingerprint: talentBuildFingerprint,
                  gameBuild: observedBuild.gameBuild,
                  gameBuildConfidence: observedBuild.confidence,
                  playerIdentity: { playerName: actor.name },
                  allTalentSpellIds: shadowTalentLookup ? new Set(shadowTalentLookup.values()) : null,
                  talentLookupComplete: shadowTalentLookup != null,
                },
                resolverData,
              )
            : [];
          const legacyKit = actor ? defensivesForClass(actor.subType, playerSpec, cooldownCatalog, talentGateForActor(actorId)) : [];
          const legacyBySpellId = new Map(legacyKit.map((entry) => [entry.spellId, entry]));
          const resolutionDifferences = resolvedKit
            .map((entry) => {
              const legacy = legacyBySpellId.get(entry.spellId);
              const changed =
                Boolean(legacy) !== entry.eligible ||
                (legacy?.baseCooldownMs ?? null) !== entry.effectiveCooldownMs ||
                (legacy?.durationMs ?? null) !== entry.effectiveDurationMs;
              return changed
                ? {
                    spellId: entry.spellId,
                    legacyEligible: Boolean(legacy),
                    resolvedEligible: entry.eligible,
                    legacyCooldownMs: legacy?.baseCooldownMs ?? null,
                    resolvedCooldownMs: entry.effectiveCooldownMs,
                    legacyDurationMs: legacy?.durationMs ?? null,
                    resolvedDurationMs: entry.effectiveDurationMs,
                    confidence: entry.confidence,
                  }
                : null;
            })
            .filter((entry) => entry != null);
          const resolvedCastsBySpellId = new Map(
            resolvedKit.map((entry) => [entry.spellId, defensiveCastTimestampsByActor.get(actorId)?.get(entry.spellId) ?? []]),
          );
          const defensivePressureWindowsV2 = {
            baselineValue: defensivePressureWindowSensor.baselineValue,
            windows: defensivePressureWindowSensor.windows.map((window) => ({
              ...window,
              ...evaluateEffectiveWindowCoverage(
                window.startMs + fight.startTime,
                window.endMs + fight.startTime,
                resolvedKit,
                resolvedCastsBySpellId,
              ),
            })),
          };
          const deathDefensiveOptionsV2 =
            death && actor && !bossMeleeOnNonTank
              ? effectiveDeathOptions(resolvedKit, resolvedCastsBySpellId, death.timestamp, activeSpellIds)
              : death
                ? []
                : null;
          const defensivePressureWindows = {
            baselineValue: defensivePressureWindowsV2.baselineValue,
            windows: defensivePressureWindowsV2.windows.map((window) => ({
              ...window,
              // Alias de compatibilidad; nunca vuelve a calcularse desde el
              // cooldown base ni se usa como autoridad de scoring v2.
              coverable: window.availableOpportunity,
            })),
          };
          const defensiveOptions = (deathDefensiveOptionsV2 ?? []).map((option) => ({
            spellId: option.spellId,
            name: option.name,
            status: option.status,
            cooldownRemainingMs: option.cooldownRemainingMs,
          }));
          return {
            pull_id: insertedPull.id,
            player_name: actor?.name ?? `#${actorId}`,
            died: Boolean(death),
            // §"esa gente no debería contar como muerte ni afectar su
            // fiabilidad/defensivos... márcalo como wipe call": true SOLO
            // para quienes cayeron dentro del cluster detectado (no todo el
            // pull) — el resto de muertes del mismo pull, si las hay fuera
            // del cluster, siguen contando normal.
            wipe_call_cluster: wipeCallDetection?.clusterActorIds.has(actorId) ?? false,
            death_cause: death
              ? {
                  mechanicId: death.killingAbilityGameID,
                  // Prioridad: nombre curado a mano (manifiesto) > nombre real de WCL
                  // (masterData.abilities, aunque no esté en el Journal) > null solo si
                  // WCL tampoco lo tiene (rarísimo — la propia web de WCL no podría
                  // mostrar nombre tampoco en ese caso).
                  mechanicName: mechanic?.name ?? abilityNameById.get(death.killingAbilityGameID) ?? null,
                  // Qué hace la mecánica, no solo cómo se llama (§ "para poder
                  // explicarlo o criticarlo bien") — del Journal de Blizzard,
                  // copiado aquí para que el pull quede autocontenido.
                  mechanicDescription: mechanic?.description ?? null,
                  // category = confirmada a mano (save-mechanic-edit); si no hay
                  // ninguna todavía, cae a inferred_category (sugerencia de
                  // sync-boss-mechanics, ver _shared/mechanic-category-inference.ts)
                  // — categoryIsInferred dice cuál de las dos es, para que el
                  // front pueda pintarla distinto (confirmada vs. sugerida).
                  category: deathEffectiveCategory,
                  responsibility: mechanic?.responsibility ?? null,
                  categoryIsInferred: mechanic ? mechanic.category == null && deathEffectiveCategory != null : false,
                  avoidable: mechanic?.avoidable ?? null,
                  preventableWithDefensive: bossMeleeOnNonTank ? null : buffsSnapshotIsFresh ? defensivesAtDeath.length === 0 : null,
                  statisticalExclusionReason: bossMeleeOnNonTank ? 'boss_melee_on_non_tank' : null,
                  // §10: "no es lo mismo un oneshot que una muerte por daño
                  // sostenido sin sanar, y la causa real puede ser muy
                  // distinta" — ver computeRootCause para el alcance real
                  // (deliberadamente sin undispelled_debuff/tank_swap_missed
                  // todavía, sin datos reales para defenderlas).
                  rootCause: computeRootCause(actorId, death.timestamp, deathEffectiveCategory, deathDamageProfile?.damageProfile ?? 'unknown', death.killingAbilityGameID),
                  // §"a quién dirigir: healing sí/no y cuánto en los últimos
                  // segundos" — misma ventana de 6s que ya usa rootCause,
                  // pero con el número real en vez de solo sí/no.
                  ...(deathHealingReceived as NonNullable<typeof deathHealingReceived>),
                  // Estado de CADA defensivo de su catálogo en el momento exacto
                  // de morir — activo, en cooldown (y cuánto le faltaba),
                  // disponible y sin usar, o sin dato de cooldown. Sustituye a
                  // los dos campos sueltos de la versión anterior
                  // (activeDefensivesAtDeath/neverCastDefensives), que solo
                  // decían "algo activo sí/no" y "lo lanzó alguna vez sí/no"
                  // sin cruzar ambas cosas con el tiempo real.
                  defensiveOptions: bossMeleeOnNonTank ? [] : defensiveOptions,
                  // Offset relativo al inicio del pull, en el mismo espacio de
                  // tiempo que trigger_time_ms de pull_mechanic_events — así
                  // el front puede alinear muertes y chips de mecánica en una
                  // única timeline sin dos unidades de tiempo distintas.
                  timeMs: death.timestamp - fight.startTime,
                  // §"fases de encuentro... implementarlas en todos los
                  // sitios donde corresponda": en qué fase murió — null si
                  // el boss no tiene fases. El nombre legible se resuelve
                  // en lectura desde boss_encounter_phases (misma fuente
                  // única que pull_mechanic_events.phase_id), no se
                  // duplica aquí.
                  phaseId: resolvePhaseId(death.timestamp),
                  // §"golpe único vs. daño sostenido" — ver computeDeathDamageProfile.
                  ...(deathDamageProfile as NonNullable<typeof deathDamageProfile>),
                }
              : null,
            defensive_events: defensivesSeen,
            avoidable_damage_taken: avoidableDamageByTarget.get(actorId) ?? 0,
            mechanic_damage: [...(mechanicDamageByTarget.get(actorId)?.entries() ?? [])].map(([mechanicId, amount]) => ({
              mechanicId,
              mechanicName: mechanicById.get(mechanicId)?.name ?? null,
              amount,
            })),
            dps: Math.round(((damageDoneByActor.get(actorId) ?? 0) / durationSeconds) * 10) / 10,
            hps: Math.round(((healingByActor.get(actorId) ?? 0) / durationSeconds) * 10) / 10,
            absorbed_damage_taken: absorbedByTarget.get(actorId) ?? 0,
            // §compendio de defensivos: TODOS los casts de cada defensivo de
            // su clase durante el pull completo (no solo el estado en el
            // instante de morir, que vive aparte en death_cause.defensiveOptions).
            defensive_casts: actor
              ? resolvedKit.filter((defensive) => defensive.eligible).map((cd) => ({
                  spellId: cd.spellId,
                  name: cd.name,
                  timestampsMs: (defensiveCastTimestampsByActor.get(actorId)?.get(cd.spellId) ?? []).map((t) => t - fight.startTime),
                  events: (defensiveCastEventsByActor.get(actorId)?.get(cd.spellId) ?? []).map((event) => ({
                    timestampMs: event.timestamp - fight.startTime,
                    targetActorId: event.targetID,
                    targetName: event.targetID == null ? null : (actorById.get(event.targetID)?.name ?? null),
                  })),
                }))
              : [],
            consumables: buildConsumableUsage(defensiveCastTimestampsByActor.get(actorId), consumableIds, fight.startTime, warlockPresent, defensivePressureWindows.windows),
            defensive_pressure_windows: defensivePressureWindows,
            talent_build: talentBuild,
            talent_build_fingerprint: talentBuildFingerprint,
            game_build: observedBuild.gameBuild,
            game_build_source: observedBuild.source,
            game_build_confidence: observedBuild.confidence,
            defensive_resolution_version: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
            defensive_resolution_evaluated_at: defensiveResolutionEvaluatedAt,
            death_defensive_options_v2: deathDefensiveOptionsV2,
            defensive_pressure_windows_v2: defensivePressureWindowsV2,
            defensive_resolution_shadow: actor
              ? {
                  resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
                  authoritative: false,
                  kit: resolvedKit,
                  differencesFromLegacy: resolutionDifferences,
                  warnings: [
                    ...resolverShadowWarnings,
                    ...(observedBuild.gameBuild ? [] : ['No se puede asociar este pull histórico a un game_build exacto.']),
                  ],
                }
              : null,
            // Los trinkets (índices 12/13) llevan `name` inyectado — el resto
            // del gear se guarda tal cual, sin resolver (17 ítems × ~25
            // jugadores sería demasiadas llamadas para lo que aporta; los
            // trinkets son los que de verdad quiere ver un RL).
            equipped_items:
              combatantInfoByActor.get(actorId)?.gear?.map((item, i) => {
                const g = item as { id?: number };
                return TRINKET_SLOT_INDICES.includes(i) && g.id ? { ...g, name: trinketNameById.get(g.id) ?? null } : item;
              }) ?? null,
            class: actor?.subType ?? null,
            spec: resolveSpec(actorId),
            world_rank_percent: actor ? (playerRankings?.get(actor.name)?.rankPercent ?? null) : null,
            world_total_parses: actor ? (playerRankings?.get(actor.name)?.totalParses ?? null) : null,
          };
        }));

        if (playerRecords.length) {
          const { error: recError } = await supabase.from('player_pull_records').insert(playerRecords);
          if (recError) throw recError;
        }

        // Bloque F: se hace después de persistir game_build por jugador para
        // poder comprobar compatibilidad. Usa observed_at, nunca closed_at,
        // y materializa también un binding explícito no-plan cuando no había
        // ninguna versión publicada al comenzar el fight.
        const { error: planBindingError } = await supabase.rpc('bind_pull_to_current_defensive_plan', {
          p_pull_id: insertedPull.id,
        });
        if (planBindingError) console.error('analyze-report: no se pudo ligar el plan defensivo desplegado', planBindingError.message);
        else {
          try {
            await evaluateDefensivePull(supabase, insertedPull.id);
          } catch (evaluationError) {
            // Rollout aditivo: durante la ventana entre desplegar la función y
            // aplicar M8, el import principal no debe perder el pull.
            console.error('analyze-report: evaluación defensiva v2 no disponible (no bloqueante)', evaluationError);
          }
        }

        // Timeline raid-wide (pull_mechanic_events): un cast del boss de una
        // habilidad del manifiesto = una instancia. outcome se decide con la
        // misma heurística del §12 de la hoja de ruta: si mató a alguien es
        // 'fail'; si no, y es avoidable, se compara la fracción de raid
        // golpeada contra severity_threshold (0.35 por defecto) para separar
        // "raid-wide esperado" (clean) de "demasiada gente golpeada" (partial_fail).
        const raidSize = fight.friendlyPlayers.length || 1;

        // §"la mecánica, cuánto daño ha sufrido, si ha gastado o no
        // defensivo": lo mismo que ya se calcula para una muerte
        // (damageWindowTotal/healingWindowTotal), pero SIN muerte de por
        // medio — daño real de ESTA instancia (no una ventana genérica hacia
        // atrás, aquí sí sabemos qué ability fue) + sanación recibida
        // mientras duraba + si hubo algún cast propio (cualquiera del
        // catálogo o no — defensiveCastTimestampsByActor no filtra por
        // catálogo) en la ventana [t0 − RESPONSE_WINDOW_MS, windowEnd].
        const RESPONSE_WINDOW_MS = 10_000; // mismo criterio que CLOSE_TO_DEATH_MS en el resto de la app
        interface PlayerHitDetail {
          name: string;
          damage_taken: number;
          damage_hits: number;
          healing_received: number;
          used_defensive_spell_id: number | null;
          max_hit_points: number | null;
        }
        function buildPlayerHitDetails(
          hitTargets: Map<number, { total: number; hits: number; maxHitPoints: number | null }>,
          t0: number,
          windowEnd: number,
        ): PlayerHitDetail[] {
          const out: PlayerHitDetail[] = [];
          for (const [targetId, dmg] of hitTargets) {
            const actor = actorById.get(targetId);
            const name = actor?.name;
            if (!name) continue;
            const healingReceived = (healingEventsByTarget.get(targetId) ?? [])
              .filter((h) => h.timestamp >= t0 && h.timestamp <= windowEnd)
              .reduce((sum, h) => sum + h.amount, 0);
            // §bug real encontrado (2026-08-23, feedback real: "a Gusmï le
            // sale Wrath, que es una habilidad básica, como defensivo"):
            // defensiveCastTimestampsByActor indexa TODOS los casts del
            // jugador (rotación normal incluida), no solo su catálogo de
            // defensivos — el bucle de abajo iteraba TODAS las spells
            // castadas por el jugador y se quedaba con la primera que
            // cayera en la ventana, defensiva o no. Se acota al catálogo
            // real de su clase/spec/talentos antes de mirar timestamps.
            let usedDefensiveSpellId: number | null = null;
            const castMap = defensiveCastTimestampsByActor.get(targetId);
            const catalogSpellIds = new Set(defensivesForClass(actor.subType, resolveSpec(targetId), cooldownCatalog, talentGateForActor(targetId)).map((cd) => cd.spellId));
            if (castMap) {
              for (const [spellId, timestamps] of castMap) {
                if (!catalogSpellIds.has(spellId)) continue;
                if (timestamps.some((t) => t >= t0 - RESPONSE_WINDOW_MS && t <= windowEnd)) {
                  usedDefensiveSpellId = spellId;
                  break;
                }
              }
            }
            out.push({
              name,
              damage_taken: dmg.total,
              damage_hits: dmg.hits,
              healing_received: healingReceived,
              used_defensive_spell_id: usedDefensiveSpellId,
              max_hit_points: dmg.maxHitPoints,
            });
          }
          return out;
        }

        // §"fases de encuentro... implementarlas en todos los sitios donde
        // corresponda" (feedback real): dado un timestamp absoluto de WCL
        // (mismo espacio que fight.startTime/phaseTransitions[].startTime,
        // ANTES de restar fight.startTime), resuelve qué fase estaba activa
        // -- la última transición cuyo startTime sea <= ese instante.
        // Verificado en real: la primera transición SIEMPRE llega con
        // startTime === fight.startTime (WCL manda la fase inicial
        // explícita, no hace falta asumir "fase 1 implícita"). null si el
        // boss no tiene fases definidas en WCL.
        function resolvePhaseId(timestampAbsolute: number): number | null {
          const transitions = fight.phaseTransitions;
          if (!transitions?.length) return null;
          let current: number | null = null;
          for (const t of transitions) {
            if (t.startTime <= timestampAbsolute) current = t.id;
            else break;
          }
          return current;
        }

        const mechanicEventRows: {
          pull_id: string;
          ability_id: number;
          mechanic_name: string;
          description: string | null;
          category: string | null;
          responsibility: string | null;
          trigger_time_ms: number;
          outcome: 'clean' | 'partial_fail' | 'fail';
          players_hit: number;
          players_hit_names: string[];
          avoidable: boolean | null;
          player_hit_details: PlayerHitDetail[];
          phase_id: number | null;
          comparison_source: 'own_history' | 'world_reference' | 'fixed_threshold' | null;
          comparison_percentile: number | null;
        }[] = [];

        for (const raw of enemyCastEvents) {
          const cast = raw as CastEvent;
          const abilityId = cast.abilityGameID;
          if (typeof abilityId !== 'number') continue;
          const mech = mechanicById.get(abilityId);
          if (!mech) continue; // solo nos interesan casts de habilidades ya curadas en el manifiesto
          const t0 = cast.timestamp ?? 0;
          const windowEnd = t0 + MECHANIC_REACTION_WINDOW_MS;

          // Mecánicas de categoría 'interrupt' respaldadas por un evento
          // Interrupt real, en un log público de referencia o en este report:
          // el outcome no se decide por daño, se decide por si hubo un
          // evento Interrupts real con extraAbilityGameID = este cast dentro
          // de la ventana de reacción. Sin partial_fail en esta v1 (saber
          // "llegó tarde" exigiría el timestamp de INICIO del cast, no solo
          // el de finalización que da el evento Casts — simplificación conocida).
          // Ni una inferencia textual ni una etiqueta editorial bastan por sí
          // solas: un cast detenido por un objeto especial del encuentro no
          // acepta necesariamente un kick estándar.
          const observedInCurrentReport = interruptEvents.some((raw) => (raw as InterruptEvent).extraAbilityGameID === abilityId);
          const effectiveCategory = effectiveMechanicCategory(mech, observedInCurrentReport);
          if (effectiveCategory === 'interrupt') {
            // §"informe de mejora por jugador... wipefest para mejorar en el
            // boss concreto" (feedback real, 2026-08-27): antes solo se
            // guardaba SI se interrumpió, no QUIÉN — sin eso no hay forma de
            // atribuirle el mérito a nadie en un informe por jugador. Cuando
            // hay varios candidatos dentro de la ventana (kick + purga
            // simultáneos, p.ej.) nos quedamos con el más cercano a t0: es
            // el que de verdad cortó el cast, no una coincidencia posterior.
            const interrupter = interruptEvents
              .map((raw) => raw as InterruptEvent)
              .filter((e) => e.extraAbilityGameID === abilityId && (e.timestamp ?? 0) >= t0 && (e.timestamp ?? 0) <= windowEnd)
              .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))[0];
            const wasInterrupted = interrupter != null;
            const interrupterName = interrupter?.sourceID != null ? actorById.get(interrupter.sourceID)?.name : undefined;
            mechanicEventRows.push({
              pull_id: insertedPull.id,
              ability_id: abilityId,
              mechanic_name: mech.name,
              description: mech.description,
              category: effectiveCategory,
              responsibility: mech.responsibility,
              trigger_time_ms: t0 - fight.startTime,
              phase_id: resolvePhaseId(t0),
              outcome: wasInterrupted ? 'clean' : 'fail',
              players_hit: wasInterrupted ? 1 : 0, // reutilizado como "¿se resolvió?" para esta categoría, no cuenta jugadores golpeados
              // Solo se rellena en un interrupt CONSEGUIDO, con quien lo hizo
              // (1 nombre, no "a quién golpeó"). En un fail se deja vacío a
              // propósito: no sabemos quién tenía la asignación de kick, así
              // que no hay a quién señalar — night-player-summary.service.ts
              // ya filtra por outcome='clean' al preguntar "qué interrumpió
              // este jugador", y PERSONAL_RESPONSIBILITY_CATEGORIES (pull-
              // analysis.service.ts) no incluye 'interrupt', así que esto no
              // se cuela en el coaching de "a quién golpeó esta mecánica".
              players_hit_names: interrupterName ? [interrupterName] : [],
              avoidable: mech.avoidable,
              player_hit_details: [],
              // resolveSeverity no aplica a interrupts (outcome sale de
              // wasInterrupted arriba, nunca de un ratio contra umbral).
              comparison_source: null,
              comparison_percentile: null,
            });
            continue;
          }

          const hitTargets = new Map<number, { total: number; hits: number; maxHitPoints: number | null }>();
          for (const rawDamage of damageEvents) {
            const e = rawDamage as DamageEvent;
            if (e.abilityGameID !== abilityId) continue;
            const t = e.timestamp ?? 0;
            if (t < t0 || t > windowEnd) continue;
            if (typeof e.targetID !== 'number') continue;
            const cur = hitTargets.get(e.targetID) ?? { total: 0, hits: 0, maxHitPoints: null };
            cur.total += e.amount ?? 0;
            cur.hits += 1;
            const observedMaxHitPoints = e.maxHitPoints ?? e.resources?.maxHitPoints;
            if (typeof observedMaxHitPoints === 'number' && observedMaxHitPoints > 0) {
              cur.maxHitPoints = Math.max(cur.maxHitPoints ?? 0, observedMaxHitPoints);
            }
            hitTargets.set(e.targetID, cur);
          }

          let causedDeath = false;
          for (const rawDeath of deathEvents) {
            const e = rawDeath as DeathEvent;
            if (e.killingAbilityGameID !== abilityId) continue;
            const t = e.timestamp ?? 0;
            if (t >= t0 && t <= windowEnd) causedDeath = true;
          }

          const ratio = hitTargets.size / raidSize;
          const severity = resolveSeverity({
            ratio,
            fixedThreshold: mech.severity_threshold ?? 0.35,
            ownHistoryRatios: ownHistoryRatiosByAbilityId.get(abilityId) ?? [],
            referenceRatiosSorted: mech.reference_hit_ratio_samples,
          });
          const outcome: 'clean' | 'partial_fail' | 'fail' = causedDeath
            ? 'fail'
            : mech.avoidable && severity.isSevere
              ? 'partial_fail'
              : 'clean';

          const hitNames = [...hitTargets.keys()]
            .map((id) => actorById.get(id)?.name)
            .filter((n): n is string => typeof n === 'string');

          mechanicEventRows.push({
            pull_id: insertedPull.id,
            ability_id: abilityId,
            mechanic_name: mech.name,
            description: mech.description,
            category: effectiveCategory,
            responsibility: mech.responsibility,
            trigger_time_ms: t0 - fight.startTime,
            phase_id: resolvePhaseId(t0),
            outcome,
            players_hit: hitTargets.size,
            players_hit_names: hitNames,
            avoidable: mech.avoidable,
            player_hit_details: buildPlayerHitDetails(hitTargets, t0, windowEnd),
            comparison_source: severity.source,
            comparison_percentile: severity.percentile,
          });
        }

        // §"en un wipe es raro que hayan salido todas las mecánicas bien"
        // (feedback real, confirmado investigando): mecánicas letales tipo
        // debuff/DoT (ej. "Elemental Explosion") pueden no generar NINGÚN
        // evento Cast en WCL — solo tics de daño — así que el bucle de
        // arriba (basado en enemyCastEvents) nunca las ve, ni para bien ni
        // para mal: quedan totalmente ausentes de pull_mechanic_events, no
        // solo "clean". Para las abilities del manifiesto que NO consiguieron
        // ni una fila arriba, se reconstruyen "instancias" agrupando sus
        // eventos de daño por proximidad temporal (un hueco > INSTANCE_GAP_MS
        // sin ningún tic = empieza una instancia nueva) — mismo criterio de
        // outcome que las basadas en cast (¿mató a alguien dentro de la
        // instancia? ¿a cuántos golpeó?), solo cambia de dónde sale t0/tEnd.
        const abilityIdsWithCastRow = new Set(mechanicEventRows.map((r) => r.ability_id));
        const INSTANCE_GAP_MS = 3000;
        for (const [abilityId, mech] of mechanicById) {
          if (abilityIdsWithCastRow.has(abilityId)) continue;
          const effectiveCategory = effectiveMechanicCategory(mech);
          if (effectiveCategory === 'interrupt') continue; // sin daño que agrupar, no aplica este mecanismo

          const events = (damageEvents as DamageEvent[])
            .filter((e) => e.abilityGameID === abilityId && typeof e.targetID === 'number')
            .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
          if (!events.length) continue; // ni cast ni daño — de verdad no ocurrió en este pull

          // Tope de duración además del hueco: un aura ambiente que tiquea
          // sin pausas de más de INSTANCE_GAP_MS durante TODO el pull (ej.
          // "Malevolent Presence", raid-wide constante) si no, se agrupa en
          // UNA sola instancia que abarca el pull entero — y si alguien
          // muere 5 minutos después, el trigger_time_ms sale del primer tic
          // (segundo 2), no del momento real. Con tope, un aura así se trocea
          // en instancias de como mucho MAX_INSTANCE_MS, cada una con su
          // propio trigger_time_ms razonable.
          const MAX_INSTANCE_MS = 20_000;
          const instances: DamageEvent[][] = [];
          for (const e of events) {
            const last = instances.at(-1);
            const withinGap = last && (e.timestamp ?? 0) - (last.at(-1)!.timestamp ?? 0) <= INSTANCE_GAP_MS;
            const withinMaxSpan = last && (e.timestamp ?? 0) - (last[0].timestamp ?? 0) <= MAX_INSTANCE_MS;
            if (last && withinGap && withinMaxSpan) last.push(e);
            else instances.push([e]);
          }

          for (const instance of instances) {
            const t0 = instance[0].timestamp ?? 0;
            const windowEnd = instance.at(-1)!.timestamp ?? 0;

            const hitTargets = new Map<number, { total: number; hits: number; maxHitPoints: number | null }>();
            for (const e of instance) {
              const cur = hitTargets.get(e.targetID!) ?? { total: 0, hits: 0, maxHitPoints: null };
              cur.total += e.amount ?? 0;
              cur.hits += 1;
              const observedMaxHitPoints = e.maxHitPoints ?? e.resources?.maxHitPoints;
              if (typeof observedMaxHitPoints === 'number' && observedMaxHitPoints > 0) {
                cur.maxHitPoints = Math.max(cur.maxHitPoints ?? 0, observedMaxHitPoints);
              }
              hitTargets.set(e.targetID!, cur);
            }

            const causedDeath = (deathEvents as DeathEvent[]).some((e) => e.killingAbilityGameID === abilityId && (e.timestamp ?? 0) >= t0 && (e.timestamp ?? 0) <= windowEnd);
            const ratio = hitTargets.size / raidSize;
            const severity = resolveSeverity({
              ratio,
              fixedThreshold: mech.severity_threshold ?? 0.35,
              ownHistoryRatios: ownHistoryRatiosByAbilityId.get(abilityId) ?? [],
              referenceRatiosSorted: mech.reference_hit_ratio_samples,
            });
            const outcome: 'clean' | 'partial_fail' | 'fail' = causedDeath ? 'fail' : mech.avoidable && severity.isSevere ? 'partial_fail' : 'clean';
            const hitNames = [...hitTargets.keys()].map((id) => actorById.get(id)?.name).filter((n): n is string => typeof n === 'string');

            mechanicEventRows.push({
              pull_id: insertedPull.id,
              ability_id: abilityId,
              mechanic_name: mech.name,
              description: mech.description,
              category: effectiveCategory,
              responsibility: mech.responsibility,
              trigger_time_ms: t0 - fight.startTime,
              phase_id: resolvePhaseId(t0),
              outcome,
              players_hit: hitTargets.size,
              players_hit_names: hitNames,
              avoidable: mech.avoidable,
              player_hit_details: buildPlayerHitDetails(hitTargets, t0, windowEnd),
              comparison_source: severity.source,
              comparison_percentile: severity.percentile,
            });
          }
        }

        if (mechanicEventRows.length) {
          const { error: mechError } = await supabase.from('pull_mechanic_events').insert(mechanicEventRows);
          if (mechError) throw mechError;
        }

        const dispelEventRows = (dispelEvents as DispelEvent[]).flatMap((event) => {
          const timestamp = event.timestamp;
          if (typeof timestamp !== 'number' || timestamp < fight.startTime) return [];
          return [{
            pull_id: insertedPull.id,
            source_actor_id: event.sourceID ?? null,
            source_player_name: event.sourceID != null ? actorById.get(event.sourceID)?.name ?? null : null,
            target_actor_id: event.targetID ?? null,
            target_player_name: event.targetID != null ? actorById.get(event.targetID)?.name ?? null : null,
            dispelled_ability_id: event.extraAbilityGameID ?? null,
            timestamp_ms: timestamp - fight.startTime,
            is_buff: event.isBuff === true,
          }];
        });
        if (dispelEventRows.length) {
          const { error: dispelError } = await supabase
            .from('pull_dispel_events')
            .upsert(dispelEventRows, {
              onConflict: 'pull_id,source_actor_id,target_actor_id,dispelled_ability_id,timestamp_ms,is_buff',
              ignoreDuplicates: false,
            });
          if (dispelError) throw dispelError;
        }

        const { error: completionError } = await supabase
          .from('pulls')
          .update({ ingestion_status: 'complete', ingestion_error: null })
          .eq('id', insertedPull.id)
          .eq('ingestion_status', 'processing');
        if (completionError) throw completionError;
        activePullId = null;

        const { error: cursorError } = await supabase
          .from('reports')
          .update({ last_processed_fight_id: fight.id })
          .eq('code', reportCode);
        if (cursorError) throw cursorError;
      }
    }

    return jsonResponse({ ok: true, processed: batch.length, remaining, newestPullId, possibleDuplicateOf });
  } catch (err) {
    const detail = errorMessage(err);
    if (activePullId) {
      const { error: statusError } = await supabase
        .from('pulls')
        .update({ ingestion_status: 'failed', ingestion_error: detail })
        .eq('id', activePullId)
        .eq('ingestion_status', 'processing');
      if (statusError) {
        console.error('analyze-report: no se pudo persistir el fallo de ingesta', {
          reportCode,
          pullId: activePullId,
          error: errorMessage(statusError),
        });
      }
    }
    console.error('analyze-report: ingesta fallida', { reportCode, pullId: activePullId, error: detail });
    return jsonResponse({ ok: false, error: detail }, 500);
  }
});
