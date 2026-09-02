import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import type {
  MechanicOccurrenceEvaluationContract,
  MechanicResponsibilityEdgeContract,
  ExecutionDomain,
  ExecutionVerdict,
  ExecutionReasonCode,
} from '../_shared/combat-evaluation-contract.ts';

interface Body {
  pullId?: unknown;
  ledgerEvaluatorVersion?: unknown;
}

const LEDGER_EVALUATOR_VERSION = 'execution-ledger@1.0.0';

interface GeneratedEvent {
  pullId: string;
  bossId: string;
  difficulty: string;
  playerName: string;
  occurrenceId: string | null;
  causalGroupId: string;
  timestampMs: number;
  domain: ExecutionDomain;
  eventType: string;
  verdict: ExecutionVerdict;
  reasonCode: ExecutionReasonCode;
  creditEligible: boolean;
  penaltyEligible: boolean;
  primaryPenalty: boolean;
  severity: number;
  priority: number;
  confidence: string;
  evidence: Record<string, unknown>;
  contextResolverVersion: string;
  occurrenceResolverVersion: string | null;
  policyVersion: number | null;
  deduplicationKey: string;
}

interface DefensiveEvaluationRow {
  player_name: string;
  resolver_version: string;
  evaluator_version: string;
  data_confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  events: Array<{
    state: string;
    reason: string;
    atMs: number;
    slotId?: string;
    windowId?: string;
    abilityId?: number;
    occurrenceIndex?: number;
    targetPlayerKey?: string | null;
    plannedSpellId?: number;
    actualSpellId?: number;
    actualCastAtMs?: number;
  }>;
}

interface DeathRecordRow {
  player_name: string;
  died: boolean;
  death_cause: { timeMs?: unknown; rootCause?: unknown; mechanicName?: unknown } | null;
  equipped_items: Array<{ id?: number; permanentEnchant?: number | null; gems?: unknown[] } | null> | null;
}

interface InterruptRecordRow {
  id: string;
  mechanic_name: string;
  trigger_time_ms: number;
  outcome: 'clean' | 'partial_fail' | 'fail';
  players_hit_names: string[];
}

interface DispelRecordRow {
  id: string;
  source_player_name: string | null;
  target_player_name: string | null;
  dispelled_ability_id: number | null;
  timestamp_ms: number;
  is_buff: boolean;
}

interface DefensiveCausalLink {
  occurrence: MechanicOccurrenceEvaluationContract;
  defensiveExpectation: 'none' | 'optional' | 'recommended' | 'required' | 'contingency_only';
  policyConfidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
}

function rowToOccurrence(row: Record<string, unknown>): MechanicOccurrenceEvaluationContract {
  return {
    id: row['id'] as string,
    pullId: row['pull_id'] as string,
    bossId: row['boss_id'] as string,
    difficulty: row['difficulty'] as string,
    mechanicKey: row['mechanic_key'] as string,
    occurrenceIndex: row['occurrence_index'] as number,
    startMs: row['start_ms'] as number,
    resolveMs: row['resolve_ms'] as number,
    endMs: row['end_ms'] as number,
    targetActorIds: (row['target_actor_ids'] as number[]) || [],
    outcome: row['outcome'] as any,
    failureMode: row['failure_mode'] as string | null,
    evidence: row['evidence'] as Record<string, unknown>,
    confidence: row['confidence'] as any,
    policyVersion: row['policy_version'] as number,
    contextResolverVersion: row['context_resolver_version'] as string,
    occurrenceResolverVersion: row['occurrence_resolver_version'] as string,
  };
}

function rowToEdge(row: Record<string, unknown>): MechanicResponsibilityEdgeContract {
  return {
    id: row['id'] as string,
    occurrenceId: row['occurrence_id'] as string,
    playerName: row['player_name'] as string,
    actorId: row['actor_id'] as number | null,
    relationship: row['relationship'] as any,
    damageCaused: row['damage_caused'] as number,
    damageTaken: row['damage_taken'] as number,
    victimCount: row['victim_count'] as number,
    creditEligible: row['credit_eligible'] as boolean,
    penaltyEligible: row['penalty_eligible'] as boolean,
    reasonCode: row['reason_code'] as any,
    confidence: row['confidence'] as any,
    evidence: row['evidence'] as Record<string, unknown>,
    createdAt: row['created_at'] as string,
  };
}

function generateDeduplicationKey(
  pullId: string,
  domain: string,
  playerName: string,
  occurrenceId: string | null,
  timestampMs: number,
  evidenceHash: string,
): string {
  return `${pullId}:${domain}:${playerName}:${occurrenceId}:${timestampMs}:${evidenceHash}`;
}

function hashEvidence(evidence: Record<string, unknown>): string {
  // Simple hash: stringify y tomar primeros 8 chars de Base64
  const str = JSON.stringify(evidence);
  const encoded = new TextEncoder().encode(str);
  const hashArray = Array.from(new Uint8Array(encoded));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 8);
}

function stableCausalGroupId(seed: string): string {
  let first = 2_166_136_261;
  let second = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    first = Math.imul(first ^ seed.charCodeAt(index), 16_777_619);
    second = Math.imul(second ^ seed.charCodeAt(seed.length - index - 1), 16_777_619);
  }
  const hex = `${first >>> 0}`.padStart(8, '0') + `${second >>> 0}`.padStart(8, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${hex.slice(4, 16)}`;
}

function weakestConfidence(
  ...values: Array<'verified' | 'inferred' | 'fallback' | 'uncertain'>
): 'verified' | 'inferred' | 'fallback' | 'uncertain' {
  const rank = { verified: 0, inferred: 1, fallback: 2, uncertain: 3 } as const;
  return values.reduce((weakest, value) => (rank[value] > rank[weakest] ? value : weakest), 'verified');
}

async function generateMechanicEvents(
  pull: any,
  occurrences: MechanicOccurrenceEvaluationContract[],
  edges: MechanicResponsibilityEdgeContract[],
): Promise<GeneratedEvent[]> {
  const events: GeneratedEvent[] = [];
  const edgesByOccurrenceId = new Map<string, MechanicResponsibilityEdgeContract[]>();

  // Agrupar edges por occurrence_id
  for (const edge of edges) {
    if (!edgesByOccurrenceId.has(edge.occurrenceId)) {
      edgesByOccurrenceId.set(edge.occurrenceId, []);
    }
    edgesByOccurrenceId.get(edge.occurrenceId)!.push(edge);
  }

  // Generar eventos por occurrence
  for (const occ of occurrences) {
    const occEdges = edgesByOccurrenceId.get(occ.id) || [];

    if (occEdges.length === 0) continue;

    for (const edge of occEdges) {
      const isMechanicFailure = occ.outcome === 'fail' || occ.outcome === 'partial_fail';
      const isMechanicSuccess = occ.outcome === 'success';

      // Determinada del veredicto según relationship y outcome
      let verdict: ExecutionVerdict = 'uncertain';
      if (isMechanicSuccess && edge.relationship === 'successful_resolver') {
        verdict = 'success';
      } else if (isMechanicFailure && edge.penaltyEligible) {
        verdict = 'failure';
      } else if (isMechanicSuccess) {
        verdict = 'success';
      }

      const evidence = {
        ...edge.evidence,
        occurrence_outcome: occ.outcome,
        relationship: edge.relationship,
        mechanic_key: occ.mechanicKey,
      };

      const dedup = generateDeduplicationKey(
        occ.pullId,
        'mechanic',
        edge.playerName,
        occ.id,
        occ.endMs,
        hashEvidence(evidence),
      );

      events.push({
        pullId: occ.pullId,
        bossId: occ.bossId,
        difficulty: occ.difficulty,
        playerName: edge.playerName,
        occurrenceId: occ.id,
        causalGroupId: occ.id,
        timestampMs: occ.endMs,
        domain: 'mechanic' as ExecutionDomain,
        eventType: `mechanic_${verdict}`,
        verdict,
        reasonCode: edge.reasonCode,
        creditEligible: edge.creditEligible && verdict === 'success',
        penaltyEligible: edge.penaltyEligible && verdict === 'failure',
        primaryPenalty: edge.relationship === 'primary_owner' && isMechanicFailure,
        severity: isMechanicFailure ? 50 : 0,
        priority: edge.relationship === 'primary_owner' ? 1 : 3,
        confidence: occ.confidence,
        evidence,
        contextResolverVersion: occ.contextResolverVersion,
        occurrenceResolverVersion: occ.occurrenceResolverVersion,
        policyVersion: occ.policyVersion,
        deduplicationKey: dedup,
      });
    }
  }

  return events;
}

function generateDefensiveEvents(
  pull: { id: string; boss_id: string; difficulty: string },
  contextResolverVersion: string,
  evaluations: DefensiveEvaluationRow[],
  causalLinks: ReadonlyMap<string, DefensiveCausalLink>,
): GeneratedEvent[] {
  const events: GeneratedEvent[] = [];
  for (const evaluation of evaluations) {
    for (const decision of evaluation.events ?? []) {
      const isFailure = ['plan_broken', 'reminder_missed', 'death_with_viable_cd'].includes(decision.state);
      const isSuccess = ['plan_covered', 'covered_with_substitution', 'safe_extra_use'].includes(decision.state);
      const isHold = decision.state === 'correct_hold';
      const causalLink =
        decision.abilityId != null && decision.occurrenceIndex != null
          ? causalLinks.get(`${decision.abilityId}:${decision.occurrenceIndex}`)
          : undefined;
      const confidence = causalLink
        ? weakestConfidence(evaluation.data_confidence, causalLink.occurrence.confidence, causalLink.policyConfidence)
        : evaluation.data_confidence;
      const causalPenaltyAllowed =
        causalLink != null &&
        ['required', 'recommended'].includes(causalLink.defensiveExpectation) &&
        (confidence === 'verified' || confidence === 'inferred');
      const verdict: ExecutionVerdict = isFailure
        ? 'failure'
        : isSuccess
          ? 'success'
          : isHold
            ? 'correct_hold'
            : decision.state === 'uncertain_data'
              ? 'uncertain'
              : 'context';
      const reasonCode: ExecutionReasonCode = decision.state === 'plan_covered'
        ? 'PLAN_COVERED'
        : decision.state === 'correct_hold'
          ? 'CORRECT_HOLD'
          : decision.state === 'safe_extra_use'
            ? 'SAFE_EXTRA_USE'
            : decision.state === 'death_with_viable_cd'
              ? 'DEATH_VIABLE_CD'
              : decision.state === 'no_feasible_alternative'
                ? 'VIABLE_CD_NON_PUNITIVE'
                : decision.state === 'uncertain_data'
                  ? 'UNCERTAIN_CAUSE'
                  : 'REMINDER_MISSED';
      const evidence = {
        source: 'player_pull_defensive_evaluations',
        state: decision.state,
        reason: decision.reason,
        slot_id: decision.slotId ?? null,
        window_id: decision.windowId ?? null,
        mechanic_key: causalLink?.occurrence.mechanicKey ?? null,
        occurrence_index: causalLink?.occurrence.occurrenceIndex ?? null,
        defensive_expectation: causalLink?.defensiveExpectation ?? null,
        evaluator_version: evaluation.evaluator_version,
        resolver_version: evaluation.resolver_version,
      };
      const deduplicationKey = generateDeduplicationKey(
        pull.id,
        'defensive',
        evaluation.player_name,
        null,
        decision.atMs,
        hashEvidence(evidence),
      );
      events.push({
        pullId: pull.id,
        bossId: pull.boss_id,
        difficulty: pull.difficulty,
        playerName: evaluation.player_name,
        occurrenceId: causalLink?.occurrence.id ?? null,
        causalGroupId: stableCausalGroupId(deduplicationKey),
        timestampMs: decision.atMs,
        domain: 'defensive',
        eventType: `defensive_${decision.state}`,
        verdict,
        reasonCode,
        creditEligible: isSuccess,
        penaltyEligible: isFailure && causalPenaltyAllowed,
        primaryPenalty: decision.state === 'death_with_viable_cd' && causalPenaltyAllowed,
        severity: isFailure ? 50 : 0,
        priority: decision.state === 'death_with_viable_cd' ? 1 : 2,
        confidence,
        evidence,
        contextResolverVersion,
        occurrenceResolverVersion: causalLink?.occurrence.occurrenceResolverVersion ?? null,
        policyVersion: causalLink?.occurrence.policyVersion ?? null,
        deduplicationKey,
      });
    }
  }
  return events;
}

function generateDeathEvents(
  pull: { id: string; boss_id: string; difficulty: string },
  contextResolverVersion: string,
  records: DeathRecordRow[],
): GeneratedEvent[] {
  const events: GeneratedEvent[] = [];
  for (const record of records) {
    const timestampMs = record.death_cause?.timeMs;
    if (!record.died || typeof timestampMs !== 'number' || timestampMs < 0) continue;
    const rootCause = typeof record.death_cause?.rootCause === 'string'
      ? record.death_cause.rootCause
      : 'unknown';
    const isSelfFailure = rootCause === 'self_positioning';
    const reasonCode: ExecutionReasonCode = isSelfFailure
      ? 'SELF_FAILURE_DEATH'
      : rootCause === 'collateral'
        ? 'COLLATERAL_DEATH'
        : rootCause === 'unavoidable_pressure'
          ? 'UNAVOIDABLE_PRESSURE_DEATH'
          : rootCause === 'post_wipe'
            ? 'POST_WIPE_DEATH'
            : 'UNCERTAIN_CAUSE';
    const verdict: ExecutionVerdict = isSelfFailure ? 'failure' : rootCause === 'unknown' ? 'uncertain' : 'context';
    const evidence = {
      source: 'player_pull_records',
      root_cause: rootCause,
      mechanic_name: record.death_cause?.mechanicName ?? null,
    };
    const deduplicationKey = generateDeduplicationKey(
      pull.id,
      'death',
      record.player_name,
      null,
      timestampMs,
      hashEvidence(evidence),
    );
    events.push({
      pullId: pull.id,
      bossId: pull.boss_id,
      difficulty: pull.difficulty,
      playerName: record.player_name,
      occurrenceId: null,
      causalGroupId: stableCausalGroupId(deduplicationKey),
      timestampMs,
      domain: 'death',
      eventType: 'death_event',
      verdict,
      reasonCode,
      creditEligible: false,
      penaltyEligible: isSelfFailure,
      primaryPenalty: isSelfFailure,
      severity: isSelfFailure ? 70 : 0,
      priority: 1,
      confidence: isSelfFailure ? 'inferred' : rootCause === 'unknown' ? 'uncertain' : 'verified',
      evidence,
      contextResolverVersion,
      occurrenceResolverVersion: null,
      policyVersion: null,
      deduplicationKey,
    });
  }
  return events;
}

function generatePreparationEvents(
  pull: { id: string; boss_id: string; difficulty: string },
  contextResolverVersion: string,
  records: DeathRecordRow[],
): GeneratedEvent[] {
  const enchantableSlots = new Set([0, 2, 4, 6, 7, 10, 11]);
  const gemmableSlots = new Set([1, 10, 11]);
  const events: GeneratedEvent[] = [];
  for (const record of records) {
    const items = record.equipped_items ?? [];
    const enchantedSlots = [...enchantableSlots].filter(
      (index) => items[index]?.id && Number(items[index]?.permanentEnchant ?? 0) > 0,
    ).length;
    const equippedEnchantableSlots = [...enchantableSlots].filter((index) => items[index]?.id).length;
    const gemmedSlots = [...gemmableSlots].filter(
      (index) => items[index]?.id && (items[index]?.gems?.length ?? 0) > 0,
    ).length;
    const equippedGemmableSlots = [...gemmableSlots].filter((index) => items[index]?.id).length;
    for (const check of [
      { type: 'enchant', completed: enchantedSlots, eligible: equippedEnchantableSlots },
      { type: 'gem', completed: gemmedSlots, eligible: equippedGemmableSlots },
    ]) {
      if (!check.eligible) continue;
      const success = check.completed === check.eligible;
      const evidence = {
        source: 'player_pull_records',
        completed_slots: check.completed,
        eligible_slots: check.eligible,
        check: check.type,
      };
      const deduplicationKey = generateDeduplicationKey(
        pull.id,
        'preparation',
        record.player_name,
        null,
        0,
        hashEvidence(evidence),
      );
      events.push({
        pullId: pull.id,
        bossId: pull.boss_id,
        difficulty: pull.difficulty,
        playerName: record.player_name,
        occurrenceId: null,
        causalGroupId: stableCausalGroupId(deduplicationKey),
        timestampMs: 0,
        domain: 'preparation',
        eventType: `${check.type}_check`,
        verdict: success ? 'success' : 'missed',
        reasonCode: success ? 'SAFE_EXTRA_USE' : 'AVAILABILITY_UNKNOWN',
        creditEligible: false,
        penaltyEligible: false,
        primaryPenalty: false,
        severity: success ? 0 : 20,
        priority: 3,
        confidence: 'verified',
        evidence,
        contextResolverVersion,
        occurrenceResolverVersion: null,
        policyVersion: null,
        deduplicationKey,
      });
    }
  }
  return events;
}

function generateInterruptEvents(
  pull: { id: string; boss_id: string; difficulty: string },
  contextResolverVersion: string,
  records: InterruptRecordRow[],
): GeneratedEvent[] {
  const events: GeneratedEvent[] = [];
  for (const record of records) {
    if (record.outcome !== 'clean' || record.players_hit_names.length !== 1) continue;
    const playerName = record.players_hit_names[0];
    const evidence = {
      source: 'pull_mechanic_events',
      mechanic_name: record.mechanic_name,
      source_event_id: record.id,
      outcome: record.outcome,
    };
    const deduplicationKey = generateDeduplicationKey(
      pull.id,
      'interrupt',
      playerName,
      null,
      record.trigger_time_ms,
      hashEvidence(evidence),
    );
    events.push({
      pullId: pull.id,
      bossId: pull.boss_id,
      difficulty: pull.difficulty,
      playerName,
      occurrenceId: null,
      causalGroupId: stableCausalGroupId(deduplicationKey),
      timestampMs: record.trigger_time_ms,
      domain: 'interrupt',
      eventType: 'interrupt_clean',
      verdict: 'success',
      reasonCode: 'PLAN_COVERED',
      creditEligible: true,
      penaltyEligible: false,
      primaryPenalty: false,
      severity: 0,
      priority: 3,
      confidence: 'verified',
      evidence,
      contextResolverVersion,
      occurrenceResolverVersion: null,
      policyVersion: null,
      deduplicationKey,
    });
  }
  return events;
}

function generateExternalEvents(
  pull: { id: string; boss_id: string; difficulty: string },
  contextResolverVersion: string,
  evaluations: DefensiveEvaluationRow[],
  externalSpellIds: ReadonlySet<number>,
): GeneratedEvent[] {
  const events: GeneratedEvent[] = [];
  for (const evaluation of evaluations) {
    for (const decision of evaluation.events ?? []) {
      const spellId = decision.actualSpellId ?? decision.plannedSpellId;
      if (
        decision.targetPlayerKey == null ||
        spellId == null ||
        !externalSpellIds.has(spellId) ||
        !['plan_covered', 'covered_with_substitution', 'plan_broken', 'reminder_missed'].includes(decision.state)
      ) {
        continue;
      }
      const isSuccess = ['plan_covered', 'covered_with_substitution'].includes(decision.state);
      const confidence = evaluation.data_confidence;
      const evidence = {
        source: 'player_pull_defensive_evaluations',
        source_domain: 'external_defensive',
        state: decision.state,
        reason: decision.reason,
        target_player_key: decision.targetPlayerKey,
        spell_id: spellId,
        slot_id: decision.slotId ?? null,
      };
      const deduplicationKey = generateDeduplicationKey(
        pull.id,
        'external',
        evaluation.player_name,
        null,
        decision.actualCastAtMs ?? decision.atMs,
        hashEvidence(evidence),
      );
      events.push({
        pullId: pull.id,
        bossId: pull.boss_id,
        difficulty: pull.difficulty,
        playerName: evaluation.player_name,
        occurrenceId: null,
        causalGroupId: stableCausalGroupId(deduplicationKey),
        timestampMs: decision.actualCastAtMs ?? decision.atMs,
        domain: 'external',
        eventType: `external_${decision.state}`,
        verdict: isSuccess ? 'success' : 'failure',
        reasonCode: decision.reason === 'TARGET_MISMATCH' ? 'TARGET_MISMATCH' : isSuccess ? 'PLAN_COVERED' : 'REMINDER_MISSED',
        creditEligible: isSuccess,
        penaltyEligible: !isSuccess && (confidence === 'verified' || confidence === 'inferred'),
        primaryPenalty: false,
        severity: isSuccess ? 0 : 50,
        priority: 2,
        confidence,
        evidence,
        contextResolverVersion,
        occurrenceResolverVersion: null,
        policyVersion: null,
        deduplicationKey,
      });
    }
  }
  return events;
}

function generateDispelEvents(
  pull: { id: string; boss_id: string; difficulty: string },
  contextResolverVersion: string,
  records: DispelRecordRow[],
): GeneratedEvent[] {
  const events: GeneratedEvent[] = [];
  for (const record of records) {
    if (record.is_buff || !record.source_player_name) continue;
    const evidence = {
      source: 'pull_dispel_events',
      source_event_id: record.id,
      target_player_name: record.target_player_name,
      dispelled_ability_id: record.dispelled_ability_id,
    };
    const deduplicationKey = generateDeduplicationKey(
      pull.id,
      'dispel',
      record.source_player_name,
      null,
      record.timestamp_ms,
      hashEvidence(evidence),
    );
    events.push({
      pullId: pull.id,
      bossId: pull.boss_id,
      difficulty: pull.difficulty,
      playerName: record.source_player_name,
      occurrenceId: null,
      causalGroupId: stableCausalGroupId(deduplicationKey),
      timestampMs: record.timestamp_ms,
      domain: 'dispel',
      eventType: 'dispel_ally_debuff',
      verdict: 'success',
      reasonCode: 'PLAN_COVERED',
      creditEligible: true,
      penaltyEligible: false,
      primaryPenalty: false,
      severity: 0,
      priority: 3,
      confidence: 'verified',
      evidence,
      contextResolverVersion,
      occurrenceResolverVersion: null,
      policyVersion: null,
      deduplicationKey,
    });
  }
  return events;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido.' }, 400);
  }

  if (typeof body.pullId !== 'string' || !body.pullId) {
    return jsonResponse({ ok: false, error: 'pullId es obligatorio.' }, 400);
  }

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Leer pull
    const { data: pullData, error: pullErr } = await client.from('pulls').select('*').eq('id', body.pullId).single();

    if (pullErr || !pullData) {
      return jsonResponse({ ok: false, error: `No se encontró pull ${body.pullId}` }, 404);
    }

    const pull = pullData as any;

    // Leer pull_evaluation_context (autoridad)
    const { data: contextData, error: contextErr } = await client
      .from('pull_evaluation_context')
      .select('*')
      .eq('pull_id', body.pullId)
      .single();

    if (contextErr || !contextData) {
      return jsonResponse(
        { ok: false, error: `No se encontró contexto de evaluación para ${body.pullId}` },
        404,
      );
    }

    const pullContext = contextData as any;
    if (pullContext.evaluation_eligible !== true) {
      return jsonResponse({ ok: false, error: 'El pull no es elegible para evaluación.' }, 409);
    }

    // Leer occurrences
    const { data: occurrencesData, error: occErr } = await client
      .from('mechanic_occurrence_evaluations')
      .select('*')
      .eq('pull_id', body.pullId);

    if (occErr) throw occErr;

    const occurrences: MechanicOccurrenceEvaluationContract[] = (occurrencesData as any[] | null)?.map((row) =>
      rowToOccurrence(row)
    ) || [];

    // Leer edges
    let edges: MechanicResponsibilityEdgeContract[] = [];
    if (occurrences.length) {
      const { data: edgesData, error: edgesErr } = await client
        .from('mechanic_responsibility_edges')
        .select('*')
        .in('occurrence_id', occurrences.map((occurrence) => occurrence.id));
      if (edgesErr) throw edgesErr;
      edges = (edgesData as any[] | null)?.map((row) => rowToEdge(row)) ?? [];
    }

    const { data: defensiveData, error: defensiveErr } = await client
      .from('player_pull_defensive_evaluations')
      .select('player_name, resolver_version, evaluator_version, data_confidence, events')
      .eq('pull_id', body.pullId);
    if (defensiveErr) throw defensiveErr;
    const [{ data: aliasData, error: aliasErr }, { data: policyVersionData, error: policyVersionErr }] = await Promise.all([
      client
        .from('boss_mechanic_aliases')
        .select('ability_id, mechanic_key')
        .eq('boss_id', pull.boss_id)
        .eq('difficulty', pull.difficulty)
        .eq('active', true)
        .not('ability_id', 'is', null),
      client
        .from('boss_mechanic_policy_versions')
        .select('mechanic_key, policy_version, snapshot')
        .eq('boss_id', pull.boss_id)
        .eq('difficulty', pull.difficulty),
    ]);
    if (aliasErr) throw aliasErr;
    if (policyVersionErr) throw policyVersionErr;
    const mechanicKeyByAbilityId = new Map(
      (aliasData ?? []).map((alias) => [Number(alias.ability_id), alias.mechanic_key]),
    );
    const policyByIdentity = new Map(
      (policyVersionData ?? []).flatMap((policy) => {
        const snapshot = policy.snapshot as Record<string, unknown> | null;
        const expectation = snapshot?.['defensive_expectation'];
        const confidence = snapshot?.['confidence'];
        return typeof expectation === 'string' && typeof confidence === 'string'
          ? [[`${policy.mechanic_key}:${policy.policy_version}`, { expectation, confidence }] as const]
          : [];
      }),
    );
    const causalLinks = new Map<string, DefensiveCausalLink>();
    for (const occurrence of occurrences) {
      const policy = policyByIdentity.get(`${occurrence.mechanicKey}:${occurrence.policyVersion}`);
      if (
        !policy ||
        policy.expectation === 'none'
      ) {
        continue;
      }
      for (const [abilityId, mechanicKey] of mechanicKeyByAbilityId) {
        if (mechanicKey === occurrence.mechanicKey) {
          causalLinks.set(`${abilityId}:${occurrence.occurrenceIndex}`, {
            occurrence,
            defensiveExpectation: policy.expectation as DefensiveCausalLink['defensiveExpectation'],
            policyConfidence: policy.confidence as DefensiveCausalLink['policyConfidence'],
          });
        }
      }
    }
    const defensiveEvents = generateDefensiveEvents(
      pull,
      pullContext.resolver_version,
      (defensiveData ?? []) as DefensiveEvaluationRow[],
      causalLinks,
    );
    const evaluations = (defensiveData ?? []) as DefensiveEvaluationRow[];
    const defensiveSpellIds = [...new Set(evaluations.flatMap((evaluation) =>
      evaluation.events.flatMap((event) => [event.actualSpellId, event.plannedSpellId]),
    ).filter((spellId): spellId is number => typeof spellId === 'number' && spellId > 0))];
    let externalSpellIds = new Set<number>();
    if (defensiveSpellIds.length) {
      const { data: catalogData, error: catalogErr } = await client
        .from('cooldown_catalog')
        .select('spell_id')
        .eq('category', 'external_defensive')
        .eq('excluded', false)
        .in('spell_id', defensiveSpellIds);
      if (catalogErr) throw catalogErr;
      externalSpellIds = new Set((catalogData ?? []).map((row) => Number(row.spell_id)));
    }
    const externalEvents = generateExternalEvents(
      pull,
      pullContext.resolver_version,
      evaluations,
      externalSpellIds,
    );

    const { data: recordData, error: recordErr } = await client
      .from('player_pull_records')
      .select('player_name, died, death_cause, equipped_items')
      .eq('pull_id', body.pullId);
    if (recordErr) throw recordErr;
    const deathEvents = generateDeathEvents(
      pull,
      pullContext.resolver_version,
      (recordData ?? []) as DeathRecordRow[],
    );
    const preparationEvents = generatePreparationEvents(
      pull,
      pullContext.resolver_version,
      (recordData ?? []) as DeathRecordRow[],
    );
    const { data: interruptData, error: interruptErr } = await client
      .from('pull_mechanic_events')
      .select('id, mechanic_name, trigger_time_ms, outcome, players_hit_names')
      .eq('pull_id', body.pullId)
      .eq('category', 'interrupt');
    if (interruptErr) throw interruptErr;
    const interruptEvents = generateInterruptEvents(
      pull,
      pullContext.resolver_version,
      (interruptData ?? []) as InterruptRecordRow[],
    );
    const { data: dispelData, error: dispelErr } = await client
      .from('pull_dispel_events')
      .select('id, source_player_name, target_player_name, dispelled_ability_id, timestamp_ms, is_buff')
      .eq('pull_id', body.pullId);
    if (dispelErr) throw dispelErr;
    const dispelEvents = generateDispelEvents(
      pull,
      pullContext.resolver_version,
      (dispelData ?? []) as DispelRecordRow[],
    );

    // Generar eventos
    const mechanicEvents = await generateMechanicEvents(pull, occurrences, edges);
    const generatedEvents = [
      ...mechanicEvents,
      ...defensiveEvents,
      ...deathEvents,
      ...preparationEvents,
      ...interruptEvents,
      ...externalEvents,
      ...dispelEvents,
    ];

    // Construir rows para UPSERT
    const now = new Date().toISOString();
    const eventsToInsert = generatedEvents.map((event) => ({
      pull_id: event.pullId,
      boss_id: event.bossId,
      difficulty: event.difficulty,
      player_name: event.playerName,
      occurrence_id: event.occurrenceId,
      causal_group_id: event.causalGroupId || stableCausalGroupId(event.deduplicationKey),
      timestamp_ms: event.timestampMs,
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
      ledger_evaluator_version: LEDGER_EVALUATOR_VERSION,
      deduplication_key: event.deduplicationKey,
      created_at: now,
      evaluated_at: now,
    }));

    // UPSERT idempotente
    const { data: inserted, error: upsertErr } = await client
      .from('player_execution_events')
      .upsert(eventsToInsert, {
        onConflict: 'pull_id,ledger_evaluator_version,deduplication_key',
        ignoreDuplicates: false,
      })
      .select('*');

    if (upsertErr) throw upsertErr;

    const result = (inserted as Record<string, unknown>[] | null)?.map((row) => ({
      id: row['id'],
      playerName: row['player_name'],
      domain: row['domain'],
      verdict: row['verdict'],
      reasonCode: row['reason_code'],
    })) || [];

    return jsonResponse({
      ok: true,
      action: 'materialize_execution_ledger',
      pullId: body.pullId,
      occurrencesProcessed: occurrences.length,
      edgesProcessed: edges.length,
      defensiveEventsProcessed: defensiveEvents.length,
      deathEventsProcessed: deathEvents.length,
      preparationEventsProcessed: preparationEvents.length,
      interruptEventsProcessed: interruptEvents.length,
      externalEventsProcessed: externalEvents.length,
      dispelEventsProcessed: dispelEvents.length,
      eventsCreated: result.length,
      ledgerEvaluatorVersion: LEDGER_EVALUATOR_VERSION,
      events: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('materialize-execution-ledger error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
