// Production canonical defensive generation refresher.
//
// This is deliberately NOT the old shadow-defensive-v7 empirical runner:
// that runner was hard-scoped to two reports and explicitly said not to wire
// it into product traffic. This worker reuses the exact evaluator/resolver v7
// contract, but delegates scope, retry state and publication invariants to the
// database lifecycle introduced in 20260907110000.
//
// Contract:
// - published generations are immutable;
// - `start` creates/reuses one copy-on-write BUILDING child;
// - already-valid facts are cloned by SQL when the evaluator contract matches;
// - `process` always rebuilds one DB-reported missing/incomplete pull;
// - a pull is retried from zero if a previous invocation stopped halfway;
// - when no pull is missing, the DB performs an exhaustive coverage + ledger
//   check and atomically publishes the child. An incomplete generation cannot
//   be published even by a manual pointer update (DB trigger).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  getReportFights,
  getReportActors,
  getReportAbilities,
  getFightEvents,
  getFightGraph,
} from '../_shared/wcl-client.ts';
import {
  effectiveDefensiveDataFromDatabaseRows,
  normalizeTalentBuild,
  fingerprintTalentBuild,
  resolveEffectiveDefensiveKit,
  computeDemonstratedPersistentCastSpellIds,
} from '../_shared/effective-defensives.ts';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V7,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V7,
  DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7,
  mergeObservedCastEvidenceV6,
  defensiveSemanticClosureViolationsV6,
  defensiveScoreabilityViolationsV6,
  observedSelfCastAcquisitionViolationsV6,
} from '../_shared/defensive-evidence-v7.ts';
import { evaluateDefensiveEpisodesForPlayer } from '../_shared/defensive-episode-evaluator.ts';
import { buildDefensiveEpisodeLedgerEvents } from '../_shared/defensive-episode-ledger-events.ts';
import {
  buildDefensiveEpisodeEvaluationRow,
  episodeEvaluationRowToDbRecord,
} from '../_shared/defensive-episode-staging.ts';
import {
  decodeSchoolMask,
  tallyAbilityCombatTableObservations,
  mergeAbilityCombatTableObservations,
  buildDebuffIntervals,
} from '../_shared/damage-descriptor-wcl.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

const GAME_BUILD = '12.1.0.68914';
const SEMANTIC_VERSION = 'defensive-semantics@1.0.0';
const LEDGER_VERSION = 'execution-ledger@1.0.0';
const FUNCTION_VERSION = 'canonical-defensive-refresh@1';

type Action = 'health' | 'start' | 'process' | 'status';
interface Body {
  action?: Action;
  reportCode?: string | null;
  generationId?: string | null;
}

interface MissingPull {
  pull_id: string;
  report_code: string;
  fight_id: number;
  boss_id: string;
  difficulty: string;
  expected_player_rows: number;
}

const serviceClient = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function castRowsToObserved(rows: any[], currentPullId: string, fingerprint: string | null) {
  const out: { spellId: number; samePull: boolean; pullTalentBuildFingerprint: string | null }[] = [];
  for (const row of rows) {
    const samePull = row.pull_id === currentPullId;
    if (!samePull && (!fingerprint || row.talent_build_fingerprint !== fingerprint)) continue;
    for (const cast of row.defensive_casts ?? []) {
      if (
        typeof cast?.spellId !== 'number' ||
        !Array.isArray(cast?.timestampsMs) ||
        !cast.timestampsMs.length
      ) continue;
      out.push({
        spellId: cast.spellId,
        samePull,
        pullTalentBuildFingerprint: samePull ? null : row.talent_build_fingerprint ?? null,
      });
    }
  }
  return out;
}

function liveCastSpellIdsForActor(events: any[], actorId: number): number[] {
  return [...new Set(
    events
      .filter((event: any) => event.sourceID === actorId && Number.isInteger(event.abilityGameID))
      .map((event: any) => Number(event.abilityGameID)),
  )].sort((a, b) => a - b);
}

function buildObservedActiveIntervals(
  events: any[],
  actorId: number,
): Map<number, { startMs: number; endMs: number | null }[]> {
  const result = new Map<number, { startMs: number; endMs: number | null }[]>();
  const open = new Map<number, number>();
  const sorted = [...events]
    .filter(
      (event: any) =>
        event.targetID === actorId &&
        typeof event.abilityGameID === 'number' &&
        typeof event.timestamp === 'number',
    )
    .sort((a: any, b: any) => a.timestamp - b.timestamp);
  const push = (spellId: number, interval: { startMs: number; endMs: number | null }) => {
    const list = result.get(spellId) ?? [];
    list.push(interval);
    result.set(spellId, list);
  };
  for (const event of sorted) {
    const spellId = Number(event.abilityGameID);
    const timestamp = Number(event.timestamp);
    const type = String(event.type ?? '').toLowerCase();
    if (type === 'applybuff' || type === 'applybuffstack' || type === 'refreshbuff') {
      if (!open.has(spellId)) open.set(spellId, timestamp);
    } else if (type === 'removebuff') {
      const start = open.get(spellId);
      if (start != null) {
        push(spellId, { startMs: start, endMs: timestamp });
        open.delete(spellId);
      }
    }
  }
  for (const [spellId, start] of open) push(spellId, { startMs: start, endMs: null });
  return result;
}

async function loadResolverData(client: any) {
  const [catalog, profiles, modifiers, semantics, semanticRules, lookup, combat] = await Promise.all([
    client
      .from('cooldown_catalog')
      .select(
        'class,spec,spec_override,spell_id,name,category,survival_type,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,reviewed,excluded',
      )
      .eq('excluded', false),
    client.from('defensive_spec_profiles').select('*'),
    client.from('defensive_modifier_rules').select('*').eq('active', true),
    client.from('defensive_ability_semantic_catalog').select('*'),
    client.from('defensive_semantic_rules').select('*'),
    client
      .from('talent_spell_lookup')
      .select('entry_to_spell,known_entry_ids')
      .eq('build', GAME_BUILD)
      .maybeSingle(),
    client
      .from('ability_combat_table_facts')
      .select('ability_game_id,dodge_count,parry_count,block_count')
      .eq('game_build', GAME_BUILD),
  ]);
  for (const response of [catalog, profiles, modifiers, semantics, semanticRules, lookup, combat]) {
    if (response.error) throw response.error;
  }
  const data = effectiveDefensiveDataFromDatabaseRows({
    catalogRows: catalog.data ?? [],
    specProfileRows: profiles.data ?? [],
    modifierRuleRows: modifiers.data ?? [],
    semanticRows: semantics.data ?? [],
    semanticRuleRows: semanticRules.data ?? [],
  });
  const entryToSpell = lookup.data?.entry_to_spell ?? {};
  const allTalentSpellIds = new Set(
    Object.values(entryToSpell)
      .map(Number)
      .filter((value: any) => Number.isInteger(value) && value > 0),
  );
  const knownTalentEntryIds = new Set((lookup.data?.known_entry_ids ?? []).map(Number));
  const cachedCombat = new Map<number, any>(
    (combat.data ?? []).map((row: any) => [
      Number(row.ability_game_id),
      { dodgeCount: row.dodge_count, parryCount: row.parry_count, blockCount: row.block_count },
    ]),
  );
  return { data, entryToSpell, allTalentSpellIds, knownTalentEntryIds, cachedCombat };
}

async function resolvePlayerKit(
  record: any,
  resolver: any,
  allPlayerRows: any[],
  liveSpellIds: number[],
) {
  const rawBuild = normalizeTalentBuild(record.talent_build ?? null);
  const enriched = normalizeTalentBuild(
    rawBuild?.map((node: any) => {
      const spellId = node.spellId ?? Number(resolver.entryToSpell[String(node.id)]);
      return Number.isInteger(spellId) && spellId > 0
        ? { ...node, spellId }
        : { id: node.id, nodeID: node.nodeID, rank: node.rank };
    }) ?? null,
  );
  const fingerprint = await fingerprintTalentBuild(
    record.class,
    record.spec,
    GAME_BUILD,
    enriched,
  );
  const input: any = {
    className: record.class,
    specName: record.spec,
    talentBuild: enriched,
    buildFingerprint: fingerprint,
    gameBuild: GAME_BUILD,
    gameBuildConfidence: record.game_build_confidence ?? 'uncertain',
    playerIdentity: { playerName: record.player_name },
    allTalentSpellIds: resolver.allTalentSpellIds,
    talentLookupComplete: true,
    knownTalentEntryIds: resolver.knownTalentEntryIds,
  };
  const first = resolveEffectiveDefensiveKit(input, resolver.data);
  const stored = castRowsToObserved(
    allPlayerRows.filter((row: any) => row.player_name === record.player_name),
    record.pull_id,
    fingerprint,
  );
  const observed = mergeObservedCastEvidenceV6(stored, liveSpellIds);
  const demonstrated = computeDemonstratedPersistentCastSpellIds(observed, fingerprint, first);
  const kit = demonstrated.size
    ? resolveEffectiveDefensiveKit(
        { ...input, demonstratedPersistentCastSpellIds: demonstrated },
        resolver.data,
      )
    : first;
  return {
    kit,
    fingerprint,
    semanticClosure: defensiveSemanticClosureViolationsV6(kit),
    scoreability: defensiveScoreabilityViolationsV6(kit),
    acquisition: observedSelfCastAcquisitionViolationsV6(kit, liveSpellIds),
  };
}

async function coverage(client: any, generationId: string) {
  const { data, error } = await client.rpc('defensive_generation_coverage', {
    p_generation_id: generationId,
  });
  if (error) throw error;
  return data;
}

async function start(client: any, reportCode: string | null) {
  if (reportCode) {
    const { count, error } = await client
      .from('canonical_defensive_eligible_player_pulls')
      .select('*', { count: 'exact', head: true })
      .eq('report_code', reportCode)
      .eq('game_build', GAME_BUILD);
    if (error) throw error;
    if (!count) {
      return {
        skipped: true,
        reason: 'report_has_no_player_pulls_eligible_for_current_canonical_build',
        reportCode,
        gameBuild: GAME_BUILD,
      };
    }
  }

  const { data: generationId, error } = await client.rpc('begin_defensive_generation_refresh', {
    p_game_build: GAME_BUILD,
    p_semantic_version: SEMANTIC_VERSION,
    p_resolver_version: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V7,
    p_semantic_resolver_version: EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V7,
    p_episode_version: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7,
    p_evaluator_version: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7,
    p_report_code: reportCode,
  });
  if (error) throw error;
  return {
    skipped: false,
    generationId,
    reportCode,
    coverage: await coverage(client, generationId),
  };
}

async function processOne(client: any, generationId: string) {
  const { data: generation, error: generationError } = await client
    .from('defensive_generations')
    .select('*')
    .eq('id', generationId)
    .maybeSingle();
  if (generationError) throw generationError;
  if (!generation || generation.status !== 'building') {
    throw new Error(`Generation ${generationId} is not BUILDING.`);
  }
  if (
    generation.game_build !== GAME_BUILD ||
    generation.semantic_version !== SEMANTIC_VERSION ||
    generation.resolver_version !== EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V7 ||
    generation.semantic_resolver_version !== EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V7 ||
    generation.episode_version !== DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7 ||
    generation.evaluator_version !== DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7
  ) {
    throw new Error(`Generation ${generationId} contract does not match ${FUNCTION_VERSION}.`);
  }

  const { data: missingRows, error: missingError } = await client.rpc(
    'next_missing_defensive_generation_pull',
    { p_generation_id: generationId },
  );
  if (missingError) throw missingError;
  const target = ((missingRows ?? []) as MissingPull[])[0] ?? null;
  if (!target) {
    const { data: published, error: publishError } = await client.rpc(
      'publish_complete_defensive_generation',
      { p_generation_id: generationId },
    );
    if (publishError) throw publishError;
    return { done: true, generationId, published };
  }

  // A stopped invocation may have staged only part of this pull. The child is
  // private, so rebuild the target from a clean slate before every retry.
  const { error: resetError } = await client.rpc('reset_building_defensive_generation_pull', {
    p_generation_id: generationId,
    p_pull_id: target.pull_id,
  });
  if (resetError) throw resetError;

  const [recordsResponse, expectedResponse, contextResponse] = await Promise.all([
    client
      .from('player_pull_records')
      .select(
        'pull_id,player_name,class,spec,talent_build,talent_build_fingerprint,game_build,game_build_confidence,defensive_casts',
      )
      .eq('pull_id', target.pull_id),
    client
      .from('canonical_defensive_eligible_player_pulls')
      .select('player_name')
      .eq('pull_id', target.pull_id)
      .eq('game_build', GAME_BUILD),
    client
      .from('pull_evaluation_context')
      .select('evaluation_end_ms,resolver_version')
      .eq('pull_id', target.pull_id)
      .maybeSingle(),
  ]);
  if (recordsResponse.error || expectedResponse.error || contextResponse.error) {
    throw recordsResponse.error || expectedResponse.error || contextResponse.error;
  }

  const expectedNames = new Set(
    ((expectedResponse.data ?? []) as { player_name: string }[]).map((row) => row.player_name),
  );
  if (expectedNames.size !== target.expected_player_rows) {
    throw new Error(
      `Eligibility drift for pull ${target.pull_id}: DB target expected ${target.expected_player_rows}, current view has ${expectedNames.size}.`,
    );
  }
  const eligible = (recordsResponse.data ?? []).filter((row: any) => expectedNames.has(row.player_name));
  if (eligible.length !== expectedNames.size) {
    throw new Error(
      `Missing player_pull_records for canonical pull ${target.pull_id}: expected ${expectedNames.size}, loaded ${eligible.length}.`,
    );
  }

  const names = [...expectedNames];
  const { data: history, error: historyError } = names.length
    ? await client
        .from('player_pull_records')
        .select(
          'pull_id,player_name,class,spec,talent_build_fingerprint,game_build,defensive_casts',
        )
        .in('player_name', names)
        .eq('game_build', GAME_BUILD)
        .limit(5000)
    : { data: [], error: null };
  if (historyError) throw historyError;

  const resolver = await loadResolverData(client);
  const report = await getReportFights(target.report_code);
  const fight = report.fights.find((candidate: any) => candidate.id === target.fight_id);
  if (!fight) throw new Error(`Fight ${target.fight_id} not found in WCL report ${target.report_code}.`);

  const [actors, abilities, graph, casts, damage, buffs] = await Promise.all([
    getReportActors(target.report_code),
    getReportAbilities(target.report_code),
    getFightGraph({
      code: target.report_code,
      fightId: fight.id,
      dataType: 'DamageTaken',
      hostilityType: 'Friendlies',
      startTime: fight.startTime,
      endTime: fight.endTime,
    }),
    getFightEvents({
      code: target.report_code,
      fightId: fight.id,
      dataType: 'Casts',
      hostilityType: 'Friendlies',
      startTime: fight.startTime,
      endTime: fight.endTime,
    }),
    getFightEvents({
      code: target.report_code,
      fightId: fight.id,
      dataType: 'DamageTaken',
      hostilityType: 'Friendlies',
      startTime: fight.startTime,
      endTime: fight.endTime,
    }),
    getFightEvents({
      code: target.report_code,
      fightId: fight.id,
      dataType: 'Buffs',
      hostilityType: 'Friendlies',
      startTime: fight.startTime,
      endTime: fight.endTime,
    }),
  ]);

  const actorByName = new Map<string, any>(actors.map((actor: any) => [actor.name, actor]));
  const seriesByActor = new Map<number, any>(
    (graph?.series ?? []).map((series: any) => [series.id, series]),
  );
  const schoolMap = new Map<number, any>(
    abilities.map((ability: any) => [ability.gameID, decodeSchoolMask(ability.type)]),
  );
  const localCombat = tallyAbilityCombatTableObservations(damage as any[]);
  const combat = mergeAbilityCombatTableObservations(resolver.cachedCombat, localCombat);
  const normalizedBuffs = (buffs as any[]).map((event: any) => ({
    ...event,
    timestamp:
      typeof event.timestamp === 'number' ? event.timestamp - fight.startTime : event.timestamp,
  }));
  const normalizedCasts = (casts as any[]).map((event: any) => ({
    ...event,
    timestamp:
      typeof event.timestamp === 'number' ? event.timestamp - fight.startTime : event.timestamp,
  }));

  const kits = new Map<string, any>();
  let needsDebuffs = false;
  const scoreabilityViolations: any[] = [];
  for (const record of eligible) {
    const actor = actorByName.get(record.player_name);
    if (!actor?.id) {
      throw new Error(`Expected canonical actor ${record.player_name} is absent from WCL pull ${target.pull_id}.`);
    }
    const liveSpellIds = liveCastSpellIdsForActor(normalizedCasts, actor.id);
    const resolved = await resolvePlayerKit(record, resolver, history ?? [], liveSpellIds);
    kits.set(record.player_name, resolved);

    const hard = [
      ...resolved.semanticClosure.map((violation: any) => ({ gate: 'semantic_closure', ...violation })),
      ...resolved.acquisition.map((violation: any) => ({ gate: 'live_cast_acquisition', ...violation })),
    ];
    if (hard.length) {
      throw new Error(
        `Canonical v7 hard gate violation on ${target.pull_id}/${record.player_name}: ${JSON.stringify(hard.slice(0, 10))}`,
      );
    }
    for (const violation of resolved.scoreability) {
      scoreabilityViolations.push({ playerName: record.player_name, ...violation });
    }
    if (
      resolved.kit.some(
        (defensive: any) => defensive.applicability?.requiresSourceAffectedBySpell === true,
      )
    ) needsDebuffs = true;
  }

  let debuffIntervals: any[] = [];
  const bossActor =
    (actors as any[]).find((actor: any) => actor.name === fight.name && actor.type !== 'Player') ?? null;
  if (needsDebuffs && bossActor) {
    const debuffs = await getFightEvents({
      code: target.report_code,
      fightId: fight.id,
      dataType: 'Debuffs',
      hostilityType: 'Enemies',
      startTime: fight.startTime,
      endTime: fight.endTime,
    });
    debuffIntervals = buildDebuffIntervals(
      (debuffs as any[]).map((event: any) => ({
        ...event,
        timestamp:
          typeof event.timestamp === 'number' ? event.timestamp - fight.startTime : event.timestamp,
      })),
    );
  }

  let staged = 0;
  let episodeCount = 0;
  for (const record of eligible) {
    const actor = actorByName.get(record.player_name);
    if (!actor?.id) {
      throw new Error(
        `Expected canonical actor ${record.player_name} is absent from WCL pull ${target.pull_id}.`,
      );
    }

    const rawHits = (damage as any[])
      .filter((event: any) => event.targetID === actor.id)
      .map((event: any) => ({
        ...event,
        timestamp:
          typeof event.timestamp === 'number' ? event.timestamp - fight.startTime : event.timestamp,
      }));

    // WCL may omit one actor from the DamageTaken graph when that actor took
    // no positive damage. That is valid zero-damage evidence, but only when
    // the fight graph itself exists for other actors AND the independent raw
    // DamageTaken event stream agrees there was no positive hit. Any graph
    // outage or graph/event disagreement remains a hard publication failure.
    const graphSeries = graph?.series ?? [];
    const observedSeries = seriesByActor.get(actor.id) ?? null;
    const hasPositiveRawDamage = rawHits.some(
      (event: any) => typeof event.amount === 'number' && event.amount > 0,
    );
    const series = observedSeries ?? (
      graphSeries.length > 0 && !hasPositiveRawDamage
        ? {
            id: actor.id,
            data: [],
            pointStart: graphSeries[0]?.pointStart ?? fight.startTime,
            pointInterval: graphSeries[0]?.pointInterval ?? 1000,
          }
        : null
    );
    if (!series) {
      throw new Error(
        `Expected WCL damage series for ${record.player_name} is absent in canonical pull ${target.pull_id}; positiveRawDamage=${hasPositiveRawDamage}, graphSeries=${graphSeries.length}.`,
      );
    }

    const castsBySpellId = new Map<number, number[]>();
    for (const event of normalizedCasts) {
      if (
        event.sourceID !== actor.id ||
        typeof event.abilityGameID !== 'number' ||
        typeof event.timestamp !== 'number'
      ) continue;
      const list = castsBySpellId.get(event.abilityGameID) ?? [];
      list.push(event.timestamp);
      castsBySpellId.set(event.abilityGameID, list);
    }
    const activeIntervals = buildObservedActiveIntervals(normalizedBuffs, actor.id);
    const resolved = kits.get(record.player_name);
    const episodes = evaluateDefensiveEpisodesForPlayer({
      pullId: target.pull_id,
      playerName: record.player_name,
      bossActorId: bossActor?.id ?? null,
      evaluationEndMs: contextResponse.data?.evaluation_end_ms ?? null,
      resolvedDefensives: resolved.kit,
      damageTakenGraphPoints: series.data,
      graphPointStartMs: series.pointStart - fight.startTime,
      graphPointIntervalMs: series.pointInterval,
      rawDamageHits: rawHits,
      castsBySpellId,
      observedActiveIntervalsBySpellId: activeIntervals,
      schoolByAbilityId: schoolMap,
      combatTableObservations: combat,
      bossDebuffIntervals: debuffIntervals,
      dataConfidence: record.game_build_confidence ?? 'uncertain',
    });

    const row = buildDefensiveEpisodeEvaluationRow({
      defensiveGenerationId: generationId,
      pullId: target.pull_id,
      playerName: record.player_name,
      episodeEvaluatorVersion: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7,
      semanticVersion: SEMANTIC_VERSION,
      semanticResolverVersion: EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V7,
      resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V7,
      buildFingerprint: resolved.fingerprint,
      episodes,
    });
    const { error: stageError } = await client
      .from('player_pull_defensive_episode_evaluations')
      .upsert(episodeEvaluationRowToDbRecord(row), {
        onConflict: 'defensive_generation_id,pull_id,player_name',
      });
    if (stageError) throw stageError;

    const ledgers = buildDefensiveEpisodeLedgerEvents({
      pull: { id: target.pull_id, bossId: target.boss_id, difficulty: target.difficulty },
      row,
      contextResolverVersion: contextResponse.data?.resolver_version ?? 'pull-context@unknown',
    });
    if (ledgers.length) {
      const now = new Date().toISOString();
      const ledgerRows = ledgers.map((event: any) => ({
        pull_id: event.pullId,
        boss_id: event.bossId,
        difficulty: event.difficulty,
        player_name: event.playerName,
        occurrence_id: event.occurrenceId,
        causal_group_id: event.causalGroupId,
        timestamp_ms: Math.max(0, Math.round(event.timestampMs)),
        domain: event.domain,
        event_type: event.eventType,
        verdict: event.verdict,
        reason_code: event.reasonCode,
        credit_eligible: event.creditEligible,
        penalty_eligible: event.penaltyEligible,
        primary_penalty: event.primaryPenalty,
        severity: event.severity,
        priority: event.priority,
        confidence: event.confidence,
        evidence: event.evidence,
        policy_version: event.policyVersion,
        context_resolver_version: event.contextResolverVersion,
        occurrence_resolver_version: event.occurrenceResolverVersion,
        ledger_evaluator_version: LEDGER_VERSION,
        deduplication_key: event.deduplicationKey,
        evaluated_at: now,
        defensive_generation_id: event.defensiveGenerationId,
      }));
      const { error: ledgerError } = await client
        .from('player_execution_events')
        .upsert(ledgerRows, { onConflict: 'pull_id,ledger_evaluator_version,deduplication_key' });
      if (ledgerError) throw ledgerError;
    }
    staged++;
    episodeCount += episodes.length;
  }

  if (staged !== expectedNames.size) {
    throw new Error(
      `Canonical staging mismatch for pull ${target.pull_id}: staged=${staged}, expected=${expectedNames.size}.`,
    );
  }

  return {
    done: false,
    generationId,
    pullId: target.pull_id,
    reportCode: target.report_code,
    staged,
    episodes: episodeCount,
    scoreabilityViolations: scoreabilityViolations.length,
    coverage: await coverage(client, generationId),
  };
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  // Normal product traffic still requires a real Officer session. Internal
  // maintenance may use the project's service-role JWT; the Edge gateway also
  // keeps verify_jwt=true, so there is no unauthenticated bypass here.
  const serviceRoleHeader = `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`;
  if (req.headers.get('Authorization') !== serviceRoleHeader) {
    const guard = await requireOfficer(req);
    if (guard instanceof Response) return guard;
  }

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = body.action ?? 'status';
    const client = serviceClient();

    if (action === 'health') {
      return jsonResponse({
        ok: true,
        version: FUNCTION_VERSION,
        gameBuild: GAME_BUILD,
        semanticVersion: SEMANTIC_VERSION,
        resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V7,
        semanticResolverVersion: EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V7,
        evaluatorVersion: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7,
      });
    }
    if (action === 'start') {
      return jsonResponse({ ok: true, ...(await start(client, body.reportCode ?? null)) });
    }
    if (action === 'process') {
      if (!body.generationId) {
        return jsonResponse({ ok: false, error: 'generationId required' }, 400);
      }
      return jsonResponse({ ok: true, ...(await processOne(client, body.generationId)) });
    }
    if (action === 'status') {
      if (!body.generationId) {
        const { data: building, error } = await client
          .from('defensive_generations')
          .select('id')
          .eq('status', 'building')
          .maybeSingle();
        if (error) throw error;
        if (!building) return jsonResponse({ ok: true, building: false, coverage: null });
        return jsonResponse({
          ok: true,
          building: true,
          generationId: building.id,
          coverage: await coverage(client, building.id),
        });
      }
      return jsonResponse({
        ok: true,
        building: true,
        generationId: body.generationId,
        coverage: await coverage(client, body.generationId),
      });
    }
    return jsonResponse({ ok: false, error: `Unknown action ${action}` }, 400);
  } catch (error) {
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});
