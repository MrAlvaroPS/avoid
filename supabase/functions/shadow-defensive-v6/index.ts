// TEMPORARY empirical runner for PR #9. It is intentionally scoped to two
// canonical reports and never publishes a generation. Do not wire this into
// product traffic.
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
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6,
  DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6,
  mergeObservedCastEvidenceV6,
  defensiveSemanticClosureViolationsV6,
  defensiveScoreabilityViolationsV6,
  observedSelfCastAcquisitionViolationsV6,
} from '../_shared/defensive-evidence-v6.ts';
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

const GAME_BUILD = '12.1.0.68914';
const SEMANTIC_VERSION = 'defensive-semantics@1.0.0';
const LEDGER_VERSION = 'execution-ledger@1.0.0';
const RUN_KIND = 'e6_e7_shadow_v6_two_log';
const REPORT_CODES = ['7GbANtw1J2pjZzH9', '24nwKPpL8tr9Bcg1'] as const;
const PREDECESSOR_GENERATION_ID = '079484ef-5436-4412-983f-1142d439d026';

const sb = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
function json(v: unknown, status = 200) {
  return new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
}
function parseNotes(raw: unknown): any {
  if (typeof raw !== 'string' || !raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function castRowsToObserved(rows: any[], currentPullId: string, fingerprint: string | null) {
  const out: { spellId: number; samePull: boolean; pullTalentBuildFingerprint: string | null }[] = [];
  for (const row of rows) {
    const samePull = row.pull_id === currentPullId;
    if (!samePull && (!fingerprint || row.talent_build_fingerprint !== fingerprint)) continue;
    for (const c of row.defensive_casts ?? []) {
      if (typeof c?.spellId !== 'number' || !Array.isArray(c?.timestampsMs) || !c.timestampsMs.length) continue;
      out.push({ spellId: c.spellId, samePull, pullTalentBuildFingerprint: samePull ? null : row.talent_build_fingerprint ?? null });
    }
  }
  return out;
}

function liveCastSpellIdsForActor(events: any[], actorId: number): number[] {
  return [...new Set(events
    .filter((e: any) => e.sourceID === actorId && Number.isInteger(e.abilityGameID))
    .map((e: any) => Number(e.abilityGameID)))]
    .sort((a, b) => a - b);
}

function buildObservedActiveIntervals(events: any[], actorId: number): Map<number, { startMs: number; endMs: number | null }[]> {
  const result = new Map<number, { startMs: number; endMs: number | null }[]>();
  const open = new Map<number, number>();
  const sorted = [...events]
    .filter((e: any) => e.targetID === actorId && typeof e.abilityGameID === 'number' && typeof e.timestamp === 'number')
    .sort((a: any, b: any) => a.timestamp - b.timestamp);
  const push = (spellId: number, interval: { startMs: number; endMs: number | null }) => {
    const arr = result.get(spellId) ?? [];
    arr.push(interval);
    result.set(spellId, arr);
  };
  for (const e of sorted) {
    const spellId = Number(e.abilityGameID);
    const t = Number(e.timestamp);
    const type = String(e.type ?? '').toLowerCase();
    if (type === 'applybuff' || type === 'applybuffstack' || type === 'refreshbuff') {
      if (!open.has(spellId)) open.set(spellId, t);
    } else if (type === 'removebuff') {
      const start = open.get(spellId);
      if (start != null) {
        push(spellId, { startMs: start, endMs: t });
        open.delete(spellId);
      }
    }
  }
  for (const [spellId, start] of open) push(spellId, { startMs: start, endMs: null });
  return result;
}

async function loadResolverData(client: any) {
  const [catalog, profiles, modifiers, semantics, semanticRules, lookup, combat] = await Promise.all([
    client.from('cooldown_catalog').select('class,spec,spec_override,spell_id,name,category,survival_type,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,reviewed,excluded').eq('excluded', false),
    client.from('defensive_spec_profiles').select('*'),
    client.from('defensive_modifier_rules').select('*').eq('active', true),
    client.from('defensive_ability_semantic_catalog').select('*'),
    client.from('defensive_semantic_rules').select('*'),
    client.from('talent_spell_lookup').select('entry_to_spell,known_entry_ids').eq('build', GAME_BUILD).maybeSingle(),
    client.from('ability_combat_table_facts').select('ability_game_id,dodge_count,parry_count,block_count').eq('game_build', GAME_BUILD),
  ]);
  for (const r of [catalog, profiles, modifiers, semantics, semanticRules, lookup, combat]) if (r.error) throw r.error;
  const data = effectiveDefensiveDataFromDatabaseRows({
    catalogRows: catalog.data ?? [],
    specProfileRows: profiles.data ?? [],
    modifierRuleRows: modifiers.data ?? [],
    semanticRows: semantics.data ?? [],
    semanticRuleRows: semanticRules.data ?? [],
  });
  const entryToSpell = lookup.data?.entry_to_spell ?? {};
  const allTalentSpellIds = new Set(Object.values(entryToSpell).map(Number).filter((x: any) => Number.isInteger(x) && x > 0));
  const knownTalentEntryIds = new Set((lookup.data?.known_entry_ids ?? []).map(Number));
  const cachedCombat = new Map<number, any>((combat.data ?? []).map((r: any) => [Number(r.ability_game_id), {
    dodgeCount: r.dodge_count, parryCount: r.parry_count, blockCount: r.block_count,
  }]));
  return { data, entryToSpell, allTalentSpellIds, knownTalentEntryIds, cachedCombat };
}

async function resolvePlayerKit(rec: any, resolver: any, allPlayerRows: any[], liveSpellIds: number[]) {
  const rawBuild = normalizeTalentBuild(rec.talent_build ?? null);
  const enriched = normalizeTalentBuild(rawBuild?.map((n: any) => {
    const sid = n.spellId ?? Number(resolver.entryToSpell[String(n.id)]);
    return Number.isInteger(sid) && sid > 0 ? { ...n, spellId: sid } : { id: n.id, nodeID: n.nodeID, rank: n.rank };
  }) ?? null);
  const fingerprint = await fingerprintTalentBuild(rec.class, rec.spec, GAME_BUILD, enriched);
  const input: any = {
    className: rec.class,
    specName: rec.spec,
    talentBuild: enriched,
    buildFingerprint: fingerprint,
    gameBuild: GAME_BUILD,
    gameBuildConfidence: rec.game_build_confidence ?? 'uncertain',
    playerIdentity: { playerName: rec.player_name },
    allTalentSpellIds: resolver.allTalentSpellIds,
    talentLookupComplete: true,
    knownTalentEntryIds: resolver.knownTalentEntryIds,
  };
  const first = resolveEffectiveDefensiveKit(input, resolver.data);
  const stored = castRowsToObserved(allPlayerRows.filter((r: any) => r.player_name === rec.player_name), rec.pull_id, fingerprint);
  const observed = mergeObservedCastEvidenceV6(stored, liveSpellIds);
  const demonstrated = computeDemonstratedPersistentCastSpellIds(observed, fingerprint, first);
  const kit = demonstrated.size
    ? resolveEffectiveDefensiveKit({ ...input, demonstratedPersistentCastSpellIds: demonstrated }, resolver.data)
    : first;

  return {
    kit,
    fingerprint,
    semanticClosure: defensiveSemanticClosureViolationsV6(kit),
    scoreability: defensiveScoreabilityViolationsV6(kit),
    acquisition: observedSelfCastAcquisitionViolationsV6(kit, liveSpellIds),
  };
}

async function start(client: any) {
  const [{ data: existing, error: e1 }, { data: pointer, error: e2 }, { count: pending, error: e3 }] = await Promise.all([
    client.from('defensive_generations').select('id,status').eq('status', 'building'),
    client.from('defensive_generation_pointer').select('published_generation_id').eq('id', true).maybeSingle(),
    client.from('defensive_ability_semantics').select('*', { count: 'exact', head: true }).eq('semantic_status', 'pending'),
  ]);
  if (e1 || e2 || e3) throw e1 || e2 || e3;
  if ((existing ?? []).length) throw new Error(`Ambiguous active shadow generation: ${(existing ?? []).map((g: any) => g.id).join(',')}`);
  if (pointer?.published_generation_id != null) throw new Error('Shadow v6 precondition: published pointer must remain null.');
  if (pending !== 0) throw new Error(`Shadow v6 precondition: pending semantics=${pending}, expected 0.`);

  const { count: scopedPulls, error: scopeError } = await client
    .from('canonical_scored_pulls')
    .select('*', { count: 'exact', head: true })
    .in('report_code', [...REPORT_CODES]);
  if (scopeError) throw scopeError;
  if (scopedPulls !== 26) throw new Error(`Shadow v6 scope drift: expected 26 canonical pulls across two reports, got ${scopedPulls}.`);

  const notes = JSON.stringify({
    kind: RUN_KIND,
    predecessorGenerationId: PREDECESSOR_GENERATION_ID,
    gameBuild: GAME_BUILD,
    scope: { reportCodes: REPORT_CODES, expectedCanonicalPulls: 26 },
    versions: {
      resolver: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6,
      semanticResolver: EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6,
      evaluator: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6,
    },
    progress: { processedPullIds: [], failed: [], gateViolations: [] },
    complete: false,
  });
  const { data, error } = await client.from('defensive_generations').insert({
    status: 'building',
    semantic_version: SEMANTIC_VERSION,
    resolver_version: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6,
    semantic_resolver_version: EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6,
    episode_version: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6,
    evaluator_version: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6,
    game_build: GAME_BUILD,
    notes,
  }).select('*').single();
  if (error) throw error;
  return { generation: data, reused: false };
}

async function processOne(client: any, generationId: string) {
  const { data: gen, error: ge } = await client.from('defensive_generations').select('*').eq('id', generationId).maybeSingle();
  if (ge) throw ge;
  if (!gen || gen.status !== 'building' || gen.game_build !== GAME_BUILD) throw new Error('Invalid/non-building generation.');
  if (gen.resolver_version !== EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6 ||
      gen.semantic_resolver_version !== EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6 ||
      gen.episode_version !== DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6) throw new Error('Generation version drift.');

  const notes = parseNotes(gen.notes);
  const processed = new Set<string>(notes?.progress?.processedPullIds ?? []);
  const { data: pulls, error: pe } = await client.from('canonical_scored_pulls')
    .select('id,report_code,fight_id,boss_id,difficulty')
    .in('report_code', [...REPORT_CODES])
    .order('report_code')
    .order('fight_id');
  if (pe) throw pe;

  const target = (pulls ?? []).find((p: any) => !processed.has(p.id)) ?? null;
  if (!target) {
    notes.progress = { ...(notes.progress ?? {}), processedPullIds: [...processed] };
    notes.complete = true;
    await client.from('defensive_generations').update({ notes: JSON.stringify(notes) }).eq('id', generationId);
    return { done: true, generationId, processed: processed.size, total: (pulls ?? []).length, gateViolations: notes?.progress?.gateViolations?.length ?? 0 };
  }

  try {
    const [{ data: records, error: re }, { data: ctx, error: ce }] = await Promise.all([
      client.from('player_pull_records').select('pull_id,player_name,class,spec,talent_build,talent_build_fingerprint,game_build,game_build_confidence,defensive_casts').eq('pull_id', target.id),
      client.from('pull_evaluation_context').select('evaluation_end_ms,resolver_version').eq('pull_id', target.id).maybeSingle(),
    ]);
    if (re || ce) throw re || ce;
    const eligible = (records ?? []).filter((r: any) => r.game_build === GAME_BUILD && r.class && r.spec && Array.isArray(r.talent_build));
    const names = [...new Set(eligible.map((r: any) => r.player_name))];
    const { data: history, error: he } = await client.from('player_pull_records')
      .select('pull_id,player_name,class,spec,talent_build_fingerprint,game_build,defensive_casts')
      .in('player_name', names)
      .eq('game_build', GAME_BUILD)
      .limit(5000);
    if (he) throw he;

    const resolver = await loadResolverData(client);
    const report = await getReportFights(target.report_code);
    const fight = report.fights.find((f: any) => f.id === target.fight_id);
    if (!fight) throw new Error('Fight not found in WCL.');

    const [actors, abilities, graph, casts, damage, buffs] = await Promise.all([
      getReportActors(target.report_code),
      getReportAbilities(target.report_code),
      getFightGraph({ code: target.report_code, fightId: fight.id, dataType: 'DamageTaken', hostilityType: 'Friendlies', startTime: fight.startTime, endTime: fight.endTime }),
      getFightEvents({ code: target.report_code, fightId: fight.id, dataType: 'Casts', hostilityType: 'Friendlies', startTime: fight.startTime, endTime: fight.endTime }),
      getFightEvents({ code: target.report_code, fightId: fight.id, dataType: 'DamageTaken', hostilityType: 'Friendlies', startTime: fight.startTime, endTime: fight.endTime }),
      getFightEvents({ code: target.report_code, fightId: fight.id, dataType: 'Buffs', hostilityType: 'Friendlies', startTime: fight.startTime, endTime: fight.endTime }),
    ]);

    const actorByName = new Map<string, any>(actors.map((a: any) => [a.name, a]));
    const seriesByActor = new Map<number, any>((graph?.series ?? []).map((s: any) => [s.id, s]));
    const schoolMap = new Map<number, any>(abilities.map((a: any) => [a.gameID, decodeSchoolMask(a.type)]));
    const localCombat = tallyAbilityCombatTableObservations(damage as any[]);
    const combat = mergeAbilityCombatTableObservations(resolver.cachedCombat, localCombat);
    const normalizedBuffs = (buffs as any[]).map((e: any) => ({ ...e, timestamp: typeof e.timestamp === 'number' ? e.timestamp - fight.startTime : e.timestamp }));
    const normalizedCasts = (casts as any[]).map((e: any) => ({ ...e, timestamp: typeof e.timestamp === 'number' ? e.timestamp - fight.startTime : e.timestamp }));

    const kits = new Map<string, any>();
    let needsDebuffs = false;
    const pullGateViolations: any[] = [];
    for (const rec of eligible) {
      const actor = actorByName.get(rec.player_name);
      const liveSpellIds = actor?.id != null ? liveCastSpellIdsForActor(normalizedCasts, actor.id) : [];
      const resolved = await resolvePlayerKit(rec, resolver, history ?? [], liveSpellIds);
      kits.set(rec.player_name, resolved);
      for (const v of resolved.semanticClosure) pullGateViolations.push({ pullId: target.id, playerName: rec.player_name, gate: 'semantic_closure', ...v });
      for (const v of resolved.acquisition) pullGateViolations.push({ pullId: target.id, playerName: rec.player_name, gate: 'live_cast_acquisition', ...v });
      for (const v of resolved.scoreability) pullGateViolations.push({ pullId: target.id, playerName: rec.player_name, gate: 'scoreability', ...v });
      if (resolved.kit.some((d: any) => d.applicability?.requiresSourceAffectedBySpell === true)) needsDebuffs = true;
    }

    // Semantic closure and live-cast acquisition are hard invariants: if they
    // fail, the pull is not evaluated under a contradictory model. Scoreability
    // is collected for final generation audit because some builds may simply
    // have no legitimate normal personal opportunity in this scope.
    const hard = pullGateViolations.filter((v) => v.gate !== 'scoreability');
    if (hard.length) throw new Error(`v6 hard gate violation: ${JSON.stringify(hard.slice(0, 10))}`);

    let debuffIntervals: any[] = [];
    const bossActor = (actors as any[]).find((a: any) => a.name === fight.name && a.type !== 'Player') ?? null;
    if (needsDebuffs && bossActor) {
      const debuffs = await getFightEvents({ code: target.report_code, fightId: fight.id, dataType: 'Debuffs', hostilityType: 'Enemies', startTime: fight.startTime, endTime: fight.endTime });
      debuffIntervals = buildDebuffIntervals((debuffs as any[]).map((e: any) => ({ ...e, timestamp: typeof e.timestamp === 'number' ? e.timestamp - fight.startTime : e.timestamp })));
    }

    let staged = 0;
    let episodes = 0;
    for (const rec of eligible) {
      const actor = actorByName.get(rec.player_name);
      const s = actor?.id != null ? seriesByActor.get(actor.id) : null;
      if (!actor || !s) continue;
      const rawHits = (damage as any[])
        .filter((e: any) => e.targetID === actor.id)
        .map((e: any) => ({ ...e, timestamp: typeof e.timestamp === 'number' ? e.timestamp - fight.startTime : e.timestamp }));
      const castsMap = new Map<number, number[]>();
      for (const e of normalizedCasts) if (e.sourceID === actor.id && typeof e.abilityGameID === 'number' && typeof e.timestamp === 'number') {
        const arr = castsMap.get(e.abilityGameID) ?? [];
        arr.push(e.timestamp);
        castsMap.set(e.abilityGameID, arr);
      }
      const activeIntervals = buildObservedActiveIntervals(normalizedBuffs, actor.id);
      const resolved = kits.get(rec.player_name);
      const eps = evaluateDefensiveEpisodesForPlayer({
        pullId: target.id,
        playerName: rec.player_name,
        bossActorId: bossActor?.id ?? null,
        evaluationEndMs: ctx?.evaluation_end_ms ?? null,
        resolvedDefensives: resolved.kit,
        damageTakenGraphPoints: s.data,
        graphPointStartMs: s.pointStart - fight.startTime,
        graphPointIntervalMs: s.pointInterval,
        rawDamageHits: rawHits,
        castsBySpellId: castsMap,
        observedActiveIntervalsBySpellId: activeIntervals,
        schoolByAbilityId: schoolMap,
        combatTableObservations: combat,
        bossDebuffIntervals: debuffIntervals,
        dataConfidence: rec.game_build_confidence ?? 'uncertain',
      });
      const row = buildDefensiveEpisodeEvaluationRow({
        defensiveGenerationId: generationId,
        pullId: target.id,
        playerName: rec.player_name,
        episodeEvaluatorVersion: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6,
        semanticVersion: SEMANTIC_VERSION,
        semanticResolverVersion: EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6,
        resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6,
        buildFingerprint: resolved.fingerprint,
        episodes: eps,
      });
      const { error: se } = await client.from('player_pull_defensive_episode_evaluations')
        .upsert(episodeEvaluationRowToDbRecord(row), { onConflict: 'defensive_generation_id,pull_id,player_name' });
      if (se) throw se;
      staged++;
      episodes += eps.length;

      const ledgers = buildDefensiveEpisodeLedgerEvents({
        pull: { id: target.id, bossId: target.boss_id, difficulty: target.difficulty },
        row,
        contextResolverVersion: ctx?.resolver_version ?? 'pull-context@unknown',
      });
      if (ledgers.length) {
        const now = new Date().toISOString();
        const rows = ledgers.map((e: any) => ({
          pull_id: e.pullId, boss_id: e.bossId, difficulty: e.difficulty, player_name: e.playerName,
          occurrence_id: e.occurrenceId, causal_group_id: e.causalGroupId, timestamp_ms: Math.max(0, Math.round(e.timestampMs)),
          domain: e.domain, event_type: e.eventType, verdict: e.verdict, reason_code: e.reasonCode,
          credit_eligible: e.creditEligible, penalty_eligible: e.penaltyEligible, primary_penalty: e.primaryPenalty,
          severity: e.severity, priority: e.priority, confidence: e.confidence, evidence: e.evidence, policy_version: e.policyVersion,
          context_resolver_version: e.contextResolverVersion, occurrence_resolver_version: e.occurrenceResolverVersion,
          ledger_evaluator_version: LEDGER_VERSION, deduplication_key: e.deduplicationKey, evaluated_at: now,
          defensive_generation_id: e.defensiveGenerationId,
        }));
        const { error: le } = await client.from('player_execution_events')
          .upsert(rows, { onConflict: 'pull_id,ledger_evaluator_version,deduplication_key' });
        if (le) throw le;
      }
    }

    processed.add(target.id);
    notes.progress = {
      ...(notes.progress ?? {}),
      processedPullIds: [...processed],
      gateViolations: [...(notes?.progress?.gateViolations ?? []), ...pullGateViolations],
      lastPullId: target.id,
      lastResult: { staged, episodes },
    };
    await client.from('defensive_generations').update({ notes: JSON.stringify(notes) }).eq('id', generationId);
    return { done: false, pullId: target.id, staged, episodes, processed: processed.size, total: (pulls ?? []).length, gateViolations: pullGateViolations.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.progress = {
      ...(notes.progress ?? {}),
      processedPullIds: [...processed],
      failed: [...(notes?.progress?.failed ?? []), { pullId: target.id, error: msg, at: new Date().toISOString() }],
    };
    await client.from('defensive_generations').update({ notes: JSON.stringify(notes) }).eq('id', generationId);
    return { done: false, pullId: target.id, error: msg, resumable: true };
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    const client = sb();
    const action = url.searchParams.get('action') ?? 'health';
    if (action === 'health') return json({
      ok: true,
      kind: RUN_KIND,
      gameBuild: GAME_BUILD,
      reportCodes: REPORT_CODES,
      resolver: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6,
      semanticResolver: EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6,
      evaluator: DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6,
    });
    if (action === 'start') return json({ ok: true, ...await start(client) });
    if (action === 'process') {
      const generationId = url.searchParams.get('generation_id');
      if (!generationId) return json({ ok: false, error: 'generation_id required' }, 400);
      return json({ ok: true, ...await processOne(client, generationId) });
    }
    return json({ ok: false, error: 'bad action' }, 400);
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
