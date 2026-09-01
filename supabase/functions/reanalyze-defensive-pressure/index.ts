import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getReportFights, getReportActors, getReportAbilities, getFightEvents, getFightGraph, type WclActor } from '../_shared/wcl-client.ts';
import { defensivesForClass, type CooldownCatalog, type TalentGate } from '../_shared/defensive-cooldowns.ts';
import { getSpecName, getCurrentBuildNamespace } from '../_shared/blizzard-client.ts';
import { buildFromBlizzardNamespace, fetchTalentSpellLookup } from '../_shared/wago-db2-client.ts';
import { attributeWindowAbility, detectDamageWindows } from '../_shared/damage-pressure-windows.ts';
import { normalizeAbilityName, buildAbilityIdsByName } from '../_shared/ability-name-match.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  effectiveDefensiveDataFromDatabaseRows,
  fingerprintTalentBuild,
  inferCurrentGameBuildObservation,
  normalizeTalentBuild,
  resolveEffectiveDefensiveKit,
  type DefensiveResolutionConfidence,
  type TalentBuildNode,
} from '../_shared/effective-defensives.ts';
import { effectiveDeathOptions, evaluateEffectiveWindowCoverage } from '../_shared/effective-defensive-state.ts';
import { DEFENSIVE_REANALYSIS_MAX_ATTEMPTS } from '../_shared/defensive-reanalysis-queue.ts';
import { evaluateDefensivePull } from '../_shared/defensive-execution-persistence.ts';

// §"backfill completo del histórico" (feedback real, 2026-08-29): analyze-report
// solo escribe defensive_pressure_windows para fights NUEVOS a partir de su
// despliegue — esta función recalcula esa misma columna para un pull YA
// importado, sin tocar report_code/fight_id/pull_number/nada más de la fila.
// Mismo patrón que reanalyze-wipe-call (vuelve a pedir a WCL solo lo
// necesario: graph(DamageTaken) + Casts(Friendlies), no todo el pipeline de
// mecánicas/gear/consumibles).
//
// §"añadir crisálida vital también tiene consecuencia para actualizar...
// todos los sitios que afectan los defensivos" (feedback real, 2026-08-30):
// SÍ toca death_cause.defensiveOptions ahora (solo esa clave, el resto de
// death_cause se deja intacto) — es el mismo hueco que dejó sin cerrar el
// backfill original: un catálogo nuevo (o un cooldown/duración editado)
// deja desactualizada tanto defensive_pressure_windows COMO el estado de
// cada defensivo en el instante exacto de morir, y hasta ahora solo se
// recalculaba lo primero. Simplificación deliberada frente a analyze-report:
// no repite el snapshot de buffs de WCL a ≤2s de morir (buffActiveOverride)
// porque exigiría pedir Buffs además de Casts — sin él, un defensivo con
// duración desconocida que SÍ estaba activo al morir puede quedar en
// 'unknown' en vez de 'active' (mismo criterio de "mejor no lo sé que
// inventar" que ya rige el resto del catálogo, nunca un falso 'available_unused').
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

interface CastEvent { timestamp?: number; sourceID?: number; abilityGameID?: number; targetID?: number }
interface CombatantInfoEvent {
  sourceID?: number;
  specID?: number;
  /** Mismo campo/mismo comentario que en analyze-report: `talents` es legado y viene vacío, el árbol real está aquí ([{id, rank, nodeID}]). */
  talentTree?: { id?: number; rank?: number; nodeID?: number }[];
}

interface ExistingPlayerRecord {
  player_name: string;
  died: boolean;
  death_cause: Record<string, unknown> | null;
  class: string | null;
  spec: string | null;
  talent_build: TalentBuildNode[] | null;
  talent_build_fingerprint: string | null;
  game_build: string | null;
  game_build_source: string | null;
  game_build_confidence: DefensiveResolutionConfidence;
  defensive_resolution_version: string | null;
}

class ReanalysisHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: { pullId?: string; jobId?: string | null };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.pullId) return jsonResponse({ ok: false, error: 'pullId es obligatorio' }, 400);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.pullId)) {
    return jsonResponse({ ok: false, error: 'pullId inválido' }, 400);
  }
  if (body.jobId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.jobId)) {
    return jsonResponse({ ok: false, error: 'jobId inválido' }, 400);
  }

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
  // Solución robusta: esta función solo procesa UN pull por invocación. El
  // cliente las ejecuta en secuencia, pero batch+jobs conservan el trabajo en
  // Supabase para poder retomarlo si se cierra la pestaña.

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let queueJob: { id: string; batchId: string } | null = null;

  async function refreshBatch(batchId: string): Promise<void> {
    const { data, error } = await supabase
      .from('defensive_reanalysis_jobs')
      .select('status,attempts')
      .eq('batch_id', batchId);
    if (error) {
      console.error('No se pudo refrescar el batch de reanálisis:', error);
      return;
    }
    const jobs = data ?? [];
    const completedJobs = jobs.filter((job) => job.status === 'done').length;
    const failedJobs = jobs.filter((job) => job.status === 'error').length;
    const hasPending = jobs.some(
      (job) =>
        job.status === 'queued' ||
        job.status === 'running' ||
        (job.status === 'error' && job.attempts < DEFENSIVE_REANALYSIS_MAX_ATTEMPTS),
    );
    const status = hasPending ? 'running' : failedJobs ? 'completed_with_errors' : 'completed';
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('defensive_reanalysis_batches')
      .update({
        status,
        completed_jobs: completedJobs,
        failed_jobs: failedJobs,
        finished_at: hasPending ? null : now,
        updated_at: now,
      })
      .eq('id', batchId);
    if (updateError) console.error('No se pudo actualizar el progreso del batch:', updateError);
  }

  async function finishQueueJob(success: boolean, failure?: string): Promise<void> {
    if (!queueJob) return;
    const now = new Date().toISOString();
    const { data: finished, error } = await supabase
      .from('defensive_reanalysis_jobs')
      .update({
        status: success ? 'done' : 'error',
        last_error: success ? null : (failure ?? 'Error desconocido').slice(0, 2000),
        finished_at: now,
        updated_at: now,
      })
      .eq('id', queueJob.id)
      .eq('status', 'running')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!finished) throw new Error(`El job ${queueJob.id} ya no estaba running al finalizar.`);
    await refreshBatch(queueJob.batchId);
  }

  try {
    if (body.jobId) {
      const { data: job, error: jobError } = await supabase
        .from('defensive_reanalysis_jobs')
        .select('id,batch_id,pull_id,status,attempts')
        .eq('id', body.jobId)
        .maybeSingle();
      if (jobError) throw jobError;
      if (!job) throw new ReanalysisHttpError(`Job ${body.jobId} no encontrado`, 404);
      if (job.pull_id !== body.pullId) throw new ReanalysisHttpError('El job no pertenece al pull solicitado', 409);
      if (job.status === 'done') {
        return jsonResponse({ ok: true, pullId: body.pullId, updated: 0, skipped: 0, alreadyDone: true, jobId: body.jobId });
      }
      if (job.status === 'running') throw new ReanalysisHttpError('El job ya está en ejecución', 409);
      if (job.attempts >= DEFENSIVE_REANALYSIS_MAX_ATTEMPTS) {
        throw new ReanalysisHttpError(`El job agotó sus ${DEFENSIVE_REANALYSIS_MAX_ATTEMPTS} intentos automáticos`, 409);
      }

      const now = new Date().toISOString();
      const { data: claimed, error: claimError } = await supabase
        .from('defensive_reanalysis_jobs')
        .update({ status: 'running', attempts: job.attempts + 1, claimed_at: now, finished_at: null, updated_at: now })
        .eq('id', job.id)
        .in('status', ['queued', 'error'])
        .select('id,batch_id')
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) throw new ReanalysisHttpError('Otro worker reclamó el job', 409);
      queueJob = { id: claimed.id, batchId: claimed.batch_id };
      await supabase.from('defensive_reanalysis_batches').update({ status: 'running', updated_at: now }).eq('id', claimed.batch_id);
      await supabase.from('defensive_reanalysis_batches').update({ started_at: now }).eq('id', claimed.batch_id).is('started_at', null);
    }

    const { data: pull, error: pullFetchError } = await supabase
      .from('pulls')
      .select('id, report_code, fight_id, boss_id, difficulty')
      .eq('id', body.pullId)
      .maybeSingle();
    if (pullFetchError) throw pullFetchError;
    if (!pull) throw new ReanalysisHttpError(`Pull ${body.pullId} no encontrado`, 404);

    const reportDetail = await getReportFights(pull.report_code);
    const fight = reportDetail.fights.find((f) => f.id === pull.fight_id);
    if (!fight) throw new ReanalysisHttpError(`Fight ${pull.fight_id} no encontrado en el report ${pull.report_code}`, 404);

    const actors = await getReportActors(pull.report_code);
    const actorById = new Map<number, WclActor>(actors.map((a) => [a.id, a]));

    const { data: catalogRows } = await supabase
      .from('cooldown_catalog')
      .select('class,spec,spec_override,spell_id,name,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,survival_type,excluded')
      .eq('excluded', false);
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
    const castEventsByActor = new Map<number, Map<number, { timestamp: number; targetID: number | null }[]>>();
    for (const raw of friendlyCastEvents) {
      const e = raw as CastEvent;
      if (typeof e.sourceID !== 'number' || typeof e.abilityGameID !== 'number') continue;
      if (!castTimestampsByActor.has(e.sourceID)) castTimestampsByActor.set(e.sourceID, new Map());
      const perSpell = castTimestampsByActor.get(e.sourceID)!;
      if (!perSpell.has(e.abilityGameID)) perSpell.set(e.abilityGameID, []);
      perSpell.get(e.abilityGameID)!.push(e.timestamp ?? 0);
      if (!castEventsByActor.has(e.sourceID)) castEventsByActor.set(e.sourceID, new Map());
      const perSpellEvents = castEventsByActor.get(e.sourceID)!;
      if (!perSpellEvents.has(e.abilityGameID)) perSpellEvents.set(e.abilityGameID, []);
      perSpellEvents.get(e.abilityGameID)!.push({
        timestamp: e.timestamp ?? 0,
        targetID: typeof e.targetID === 'number' ? e.targetID : null,
      });
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
      .select(
        'player_name,died,death_cause,class,spec,talent_build,talent_build_fingerprint,game_build,game_build_source,game_build_confidence,defensive_resolution_version',
      )
      .eq('pull_id', pull.id);
    if (recordsFetchError) throw recordsFetchError;

    const records = (existingRecords ?? []) as ExistingPlayerRecord[];
    const resolverShadowWarnings: string[] = [];
    const [specProfilesResult, modifierRulesResult, overridesResult] = await Promise.all([
      supabase.from('defensive_spec_profiles').select('*'),
      supabase.from('defensive_modifier_rules').select('*').eq('active', true),
      supabase.from('player_defensive_overrides').select('*').eq('active', true),
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

    // Cada histórico conserva su build. Para builds distintos del actual solo
    // se usa una caché ya versionada; nunca se descarga el DB2 de la patch de
    // hoy y se hace pasar por el del pull antiguo.
    const talentLookupsByBuild = new Map<string, Map<number, number>>();
    if (currentGameBuild && talentSpellLookup) talentLookupsByBuild.set(currentGameBuild, talentSpellLookup);
    const persistedBuilds = [...new Set(records.map((record) => record.game_build).filter((build): build is string => Boolean(build)))];
    for (const build of persistedBuilds) {
      if (talentLookupsByBuild.has(build)) continue;
      const { data: cached, error } = await supabase.from('talent_spell_lookup').select('entry_to_spell').eq('build', build).maybeSingle();
      if (error) {
        resolverShadowWarnings.push(`talent_spell_lookup ${build}: ${error.message}`);
        continue;
      }
      if (cached?.entry_to_spell) {
        talentLookupsByBuild.set(
          build,
          new Map(Object.entries(cached.entry_to_spell as Record<string, number>).map(([id, spellId]) => [Number(id), spellId])),
        );
      }
    }

    const actorIdByName = new Map(fight.friendlyPlayers.map((actorId) => [actorById.get(actorId)?.name, actorId]).filter((e): e is [string, number] => Boolean(e[0])));

    let updated = 0;
    let skipped = 0;
    const perPlayerWindowCounts: { playerName: string; windowCount: number }[] = [];
    for (const record of records) {
      const actorId = actorIdByName.get(record.player_name);
      const actor = actorId != null ? actorById.get(actorId) : undefined;
      const damageSeries = actorId != null ? damageTakenSeriesByActorId.get(actorId) : undefined;
      if (!actor || !damageSeries) {
        skipped++;
        continue;
      }
      const catalog = defensivesForClass(actor.subType, specNameByActor.get(actorId!) ?? null, cooldownCatalog, talentGateForActor(actorId!));
      const { baselineValue, windows } = detectDamageWindows(damageSeries.points, damageSeries.pointStart, damageSeries.pointIntervalMs);
      const actorDamageEvents = damageEventsByTarget.get(actorId) ?? [];
      const defensivePressureWindowSensor = {
        baselineValue,
        windows: windows.map((w) => {
          const dominant = attributeWindowAbility(actorDamageEvents, w.startMs, w.endMs);
          return {
            startMs: w.startMs - fight.startTime,
            endMs: w.endMs - fight.startTime,
            peakMs: w.peakMs - fight.startTime,
            peakValue: w.peakValue,
            mechanicId: dominant?.abilityGameID ?? null,
            mechanicName: dominant ? (mechanicNameById.get(dominant.abilityGameID) ?? abilityNameById.get(dominant.abilityGameID) ?? null) : null,
          };
        }),
      };
      const updatePatch: Record<string, unknown> = {};

      const inferredBuild = inferCurrentGameBuildObservation({
        currentGameBuild,
        reportStartTimeMs: reportDetail.startTime,
        fightStartTimeMs: fight.startTime,
      });
      const observedBuild = record.game_build
        ? {
            gameBuild: record.game_build,
            source: record.game_build_source,
            confidence: record.game_build_confidence ?? ('uncertain' as DefensiveResolutionConfidence),
          }
        : inferredBuild;
      const lookupForObservedBuild = observedBuild.gameBuild ? (talentLookupsByBuild.get(observedBuild.gameBuild) ?? null) : null;
      const rawTalentBuild = normalizeTalentBuild(
        record.talent_build ??
          ((combatantInfoByActor.get(actorId)?.talentTree?.map((node) => ({
            id: node.id ?? 0,
            nodeID: node.nodeID ?? 0,
            rank: node.rank ?? 0,
          })) ?? null) as TalentBuildNode[] | null),
      );
      const talentBuild = normalizeTalentBuild(
        rawTalentBuild?.map((node) => {
          const resolvedSpellId =
            lookupForObservedBuild?.get(node.id) ??
            (record.game_build != null && record.game_build === observedBuild.gameBuild ? node.spellId : undefined);
          return resolvedSpellId ? { ...node, spellId: resolvedSpellId } : { id: node.id, nodeID: node.nodeID, rank: node.rank };
        }) ?? null,
      );
      const playerClass = record.class ?? actor.subType;
      const playerSpec = record.spec ?? specNameByActor.get(actorId) ?? null;
      const talentBuildFingerprint = observedBuild.gameBuild
        ? await fingerprintTalentBuild(playerClass, playerSpec, observedBuild.gameBuild, talentBuild)
        : null;
      const resolvedKit = resolveEffectiveDefensiveKit(
        {
          className: playerClass,
          specName: playerSpec,
          talentBuild,
          buildFingerprint: talentBuildFingerprint,
          gameBuild: observedBuild.gameBuild,
          gameBuildConfidence: observedBuild.confidence,
          playerIdentity: { playerName: record.player_name },
          allTalentSpellIds: lookupForObservedBuild ? new Set(lookupForObservedBuild.values()) : null,
          talentLookupComplete: lookupForObservedBuild != null,
        },
        resolverData,
      );
      const legacyBySpellId = new Map(catalog.map((entry) => [entry.spellId, entry]));
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
      if (observedBuild.gameBuild && lookupForObservedBuild) updatePatch['talent_build'] = talentBuild;
      updatePatch['talent_build_fingerprint'] = talentBuildFingerprint;
      updatePatch['game_build'] = observedBuild.gameBuild;
      updatePatch['game_build_source'] = observedBuild.source;
      updatePatch['game_build_confidence'] = observedBuild.confidence;
      updatePatch['defensive_resolution_shadow'] = {
        resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
        authoritative: false,
        kit: resolvedKit,
        differencesFromLegacy: resolutionDifferences,
        warnings: [
          ...resolverShadowWarnings,
          ...(observedBuild.gameBuild ? [] : ['No se puede asociar este pull histórico a un game_build exacto.']),
        ],
      };
      const resolvedCastsBySpellId = new Map(
        resolvedKit.map((entry) => [entry.spellId, castTimestampsByActor.get(actorId)?.get(entry.spellId) ?? []]),
      );
      updatePatch['defensive_casts'] = resolvedKit.filter((defensive) => defensive.eligible).map((defensive) => ({
        spellId: defensive.spellId,
        name: defensive.name,
        timestampsMs: (castTimestampsByActor.get(actorId)?.get(defensive.spellId) ?? []).map((timestamp) => timestamp - fight.startTime),
        events: (castEventsByActor.get(actorId)?.get(defensive.spellId) ?? []).map((event) => ({
          timestampMs: event.timestamp - fight.startTime,
          targetActorId: event.targetID,
          targetName: event.targetID == null ? null : (actorById.get(event.targetID)?.name ?? null),
        })),
      }));
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
      updatePatch['defensive_pressure_windows_v2'] = defensivePressureWindowsV2;
      // Compatibilidad de lectura: legacy conserva su forma, pero deja de
      // recalcular cooldowns por una vía paralela. `coverable` es solo el
      // alias temporal del diagnóstico v2 `availableOpportunity`.
      updatePatch['defensive_pressure_windows'] = {
        baselineValue: defensivePressureWindowsV2.baselineValue,
        windows: defensivePressureWindowsV2.windows.map((window) => ({
          ...window,
          coverable: window.availableOpportunity,
        })),
      };
      updatePatch['defensive_resolution_version'] = EFFECTIVE_DEFENSIVE_RESOLVER_VERSION;
      updatePatch['defensive_resolution_evaluated_at'] = new Date().toISOString();
      // §"añadir crisálida vital también tiene consecuencia para... muertes
      // con defensivo libre y sin usar" (feedback real, 2026-08-30):
      // death_cause.defensiveOptions sigue disponible como contrato legacy,
      // pero ahora se proyecta desde effectiveDeathOptions. Así cooldown,
      // cargas, duración y confianza se resuelven una sola vez.
      // §nota: no replica aquí el caso bossMeleeOnNonTank de analyze-report
      // (que fuerza defensiveOptions:[] para esas muertes) — no bloquea
      // nada, el consumidor real (night-player-summary.service.ts,
      // excludedFromStatistics) ya vacía defensivesAvailable para esas
      // mismas muertes leyendo statisticalExclusionReason, que esta función
      // no toca. Repetir el cálculo aquí solo para volver a llegar a `[]`
      // no aporta nada.
      const deathTimeMs = typeof record.death_cause?.['timeMs'] === 'number' ? (record.death_cause['timeMs'] as number) : null;
      if (record.died && record.death_cause && deathTimeMs != null) {
        const deathTimestampAbs = deathTimeMs + fight.startTime;
        const deathDefensiveOptionsV2 =
          record.death_cause['statisticalExclusionReason'] === 'boss_melee_on_non_tank'
            ? []
            : effectiveDeathOptions(resolvedKit, resolvedCastsBySpellId, deathTimestampAbs);
        updatePatch['death_defensive_options_v2'] = deathDefensiveOptionsV2;
        updatePatch['death_cause'] = {
          ...record.death_cause,
          defensiveOptions: deathDefensiveOptionsV2.map((option) => ({
            spellId: option.spellId,
            name: option.name,
            status: option.status,
            cooldownRemainingMs: option.cooldownRemainingMs,
          })),
        };
      } else {
        updatePatch['death_defensive_options_v2'] = record.died ? [] : null;
      }
      const { error: updateError } = await supabase
        .from('player_pull_records')
        .update(updatePatch)
        .eq('pull_id', pull.id)
        .eq('player_name', record.player_name);
      if (updateError) throw updateError;
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
      try {
        await evaluateDefensivePull(supabase, pull.id);
      } catch (evaluationError) {
        console.error('No se pudo recalcular la evaluación defensiva v2 (no bloqueante):', evaluationError);
      }
    }

    // La invalidación forma parte del contrato del job aunque no hubiese
    // player rows que actualizar. Marcarlo done sin este touch permitiría que
    // roster/dosier siguieran sirviendo un snapshot anterior en silencio.
    const { error: touchError } = await supabase.from('pulls').update({ updated_at: new Date().toISOString() }).eq('id', pull.id);
    if (touchError) throw new Error(`No se pudo marcar pulls.updated_at tras el reanálisis: ${touchError.message}`);

    await finishQueueJob(true);
    return jsonResponse({
      ok: true,
      pullId: pull.id,
      updated,
      skipped,
      perPlayerWindowCounts,
      jobId: queueJob?.id ?? null,
      resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
    });
  } catch (err) {
    console.error('reanalyze-defensive-pressure error:', err);
    const message = err instanceof Error ? err.message : String(err);
    try {
      await finishQueueJob(false, message);
    } catch (queueError) {
      console.error('No se pudo marcar el job de reanálisis como error:', queueError);
    }
    return jsonResponse({ ok: false, error: message }, err instanceof ReanalysisHttpError ? err.status : 500);
  }
});
