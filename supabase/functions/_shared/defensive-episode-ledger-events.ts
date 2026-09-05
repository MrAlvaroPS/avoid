// §Paso C — iris-defensive-canonicalization-v1-plan.md §2.6: convierte una
// fila de staging YA evaluada (`player_pull_defensive_episode_evaluations`,
// ver `defensive-episode-staging.ts`) en eventos canónicos del ledger
// (`player_execution_events`), namespace `defensive_episode_*` (Respuesta)
// y `defensive_plan_*` (Gestión, solo cuando el episodio lleva plan linkage).
// Identidad estable: el deduplicationKey nunca depende de evidence/verdict.

import type { EvaluationConfidence, ExecutionReasonCode, ExecutionVerdict } from './combat-evaluation-contract.ts';
import type { PersistedDefensiveEpisode } from './defensive-episode-persistence.ts';
import type { ResponseVerdict } from './defensive-episode-verdict.ts';
import type { DefensiveEpisodeEvaluationRow } from './defensive-episode-staging.ts';

// @4: `missed_ready` exige además confidence punitiva (verified/inferred).
// fallback/uncertain apparent-ready degrada a uncertain y queda fuera del
// denominador de Response. Esta versión es la constante autoritativa.
export const DEFENSIVE_EPISODE_EVALUATOR_VERSION = 'episode-evaluator@4';

export const RESPONSE_VERDICT_TO_EXECUTION_VERDICT: Record<ResponseVerdict, ExecutionVerdict> = {
  covered_verified: 'success',
  missed_ready: 'missed',
  missed_due_to_mistime: 'missed',
  unavailable_legitimate: 'correct_hold',
  no_applicable_resource: 'not_applicable',
  uncertain: 'uncertain',
  excluded: 'context',
};

export const RESPONSE_VERDICT_TO_REASON_CODE: Record<ResponseVerdict, ExecutionReasonCode> = {
  covered_verified: 'DEFENSIVE_EPISODE_COVERED',
  missed_ready: 'DEFENSIVE_READY_NOT_USED',
  missed_due_to_mistime: 'DEFENSIVE_MISTIMED',
  unavailable_legitimate: 'DEFENSIVE_UNAVAILABLE_LEGITIMATE',
  no_applicable_resource: 'DEFENSIVE_NO_APPLICABLE_RESOURCE',
  uncertain: 'DEFENSIVE_EPISODE_UNCERTAIN',
  excluded: 'DEFENSIVE_EPISODE_EXCLUDED',
};

const PENALTY_ELIGIBLE_RESPONSE_VERDICTS = new Set<ResponseVerdict>(['missed_ready', 'missed_due_to_mistime']);

function isPenaltyConfidence(confidence: EvaluationConfidence): boolean {
  return confidence === 'verified' || confidence === 'inferred';
}

export interface DefensiveEpisodeLedgerEvent {
  pullId: string;
  bossId: string;
  difficulty: string;
  playerName: string;
  occurrenceId: string | null;
  causalGroupId: string;
  timestampMs: number;
  domain: 'defensive';
  eventType: string;
  verdict: ExecutionVerdict;
  reasonCode: ExecutionReasonCode;
  creditEligible: boolean;
  penaltyEligible: boolean;
  primaryPenalty: boolean;
  severity: number;
  priority: number;
  confidence: EvaluationConfidence;
  evidence: Record<string, unknown>;
  contextResolverVersion: string;
  occurrenceResolverVersion: string | null;
  policyVersion: number | null;
  defensiveGenerationId: string;
  deduplicationKey: string;
}

export function buildResponseDeduplicationKey(generationId: string, episodeId: string, playerName: string): string {
  return `${generationId}:${episodeId}:${playerName}:response`;
}

export function buildPlanDeduplicationKey(
  generationId: string,
  episodeId: string,
  playerName: string,
  planAssignmentId: string,
): string {
  return `${generationId}:${episodeId}:${playerName}:plan:${planAssignmentId}`;
}

export interface DefensiveEpisodeLedgerEventContext {
  pull: { id: string; bossId: string; difficulty: string };
  playerName: string;
  defensiveGenerationId: string;
  episode: PersistedDefensiveEpisode;
  episodeEvaluatorVersion: string;
  semanticVersion: string;
  semanticResolverVersion: string;
  resolverVersion: string;
  contextResolverVersion: string;
  occurrenceResolverVersion?: string | null;
}

function isOccurrenceBackedEpisodeId(episodeId: string): boolean {
  return !episodeId.startsWith('heuristic:');
}

export function buildDefensiveEpisodeResponseLedgerEvent(
  ctx: DefensiveEpisodeLedgerEventContext,
): DefensiveEpisodeLedgerEvent {
  const { episode } = ctx;
  const verdict = RESPONSE_VERDICT_TO_EXECUTION_VERDICT[episode.responseVerdict];
  const reasonCode = RESPONSE_VERDICT_TO_REASON_CODE[episode.responseVerdict];
  const creditEligible = episode.responseVerdict === 'covered_verified';
  const penaltyEligible =
    PENALTY_ELIGIBLE_RESPONSE_VERDICTS.has(episode.responseVerdict) && isPenaltyConfidence(episode.confidence);
  const occurrenceBacked = isOccurrenceBackedEpisodeId(episode.episodeId) && ctx.occurrenceResolverVersion != null;

  return {
    pullId: ctx.pull.id,
    bossId: ctx.pull.bossId,
    difficulty: ctx.pull.difficulty,
    playerName: ctx.playerName,
    occurrenceId: occurrenceBacked ? episode.episodeId : null,
    causalGroupId: episode.causalGroupId,
    timestampMs: episode.peakMs,
    domain: 'defensive',
    eventType: `defensive_episode_${episode.responseVerdict}`,
    verdict,
    reasonCode,
    creditEligible,
    penaltyEligible,
    primaryPenalty: false,
    severity: penaltyEligible ? 50 : 0,
    priority: 2,
    confidence: episode.confidence,
    evidence: {
      source: 'player_pull_defensive_episode_evaluations',
      episode_id: episode.episodeId,
      usage_engaged: episode.usageEngaged,
      usage_evaluable: episode.usageEvaluable,
      used_spell_ids: episode.usedSpellIds,
      covered_by_spell_id: episode.coveredBySpellId,
      applicable_candidates: episode.applicableCandidates,
      response_reason: episode.responseReason,
      episode_evaluator_version: ctx.episodeEvaluatorVersion,
      semantic_version: ctx.semanticVersion,
      semantic_resolver_version: ctx.semanticResolverVersion,
      resolver_version: ctx.resolverVersion,
      ...episode.evidence,
    },
    contextResolverVersion: ctx.contextResolverVersion,
    occurrenceResolverVersion: occurrenceBacked ? ctx.occurrenceResolverVersion ?? null : null,
    policyVersion: null,
    defensiveGenerationId: ctx.defensiveGenerationId,
    deduplicationKey: buildResponseDeduplicationKey(ctx.defensiveGenerationId, episode.episodeId, ctx.playerName),
  };
}

export function buildDefensiveEpisodePlanLedgerEvent(
  ctx: DefensiveEpisodeLedgerEventContext,
): DefensiveEpisodeLedgerEvent | null {
  const { episode } = ctx;
  if (episode.planAssignmentId == null || episode.planVerdict == null) return null;

  const verdict: ExecutionVerdict = episode.planVerdict === 'covered' ? 'success' : 'missed';
  const reasonCode: ExecutionReasonCode = episode.planVerdict === 'covered' ? 'PLAN_COVERED' : 'REMINDER_MISSED';
  const creditEligible = episode.planVerdict === 'covered';
  const penaltyEligible = episode.planVerdict === 'missed' && isPenaltyConfidence(episode.confidence);

  return {
    pullId: ctx.pull.id,
    bossId: ctx.pull.bossId,
    difficulty: ctx.pull.difficulty,
    playerName: ctx.playerName,
    occurrenceId: null,
    causalGroupId: episode.causalGroupId,
    timestampMs: episode.peakMs,
    domain: 'defensive',
    eventType: `defensive_plan_${episode.planVerdict}`,
    verdict,
    reasonCode,
    creditEligible,
    penaltyEligible,
    primaryPenalty: false,
    severity: penaltyEligible ? 50 : 0,
    priority: 2,
    confidence: episode.confidence,
    evidence: {
      source: 'player_pull_defensive_episode_evaluations',
      episode_id: episode.episodeId,
      plan_assignment_id: episode.planAssignmentId,
      plan_verdict: episode.planVerdict,
      episode_evaluator_version: ctx.episodeEvaluatorVersion,
    },
    contextResolverVersion: ctx.contextResolverVersion,
    occurrenceResolverVersion: null,
    policyVersion: null,
    defensiveGenerationId: ctx.defensiveGenerationId,
    deduplicationKey: buildPlanDeduplicationKey(
      ctx.defensiveGenerationId,
      episode.episodeId,
      ctx.playerName,
      episode.planAssignmentId,
    ),
  };
}

export interface BuildDefensiveEpisodeLedgerEventsParams {
  pull: { id: string; bossId: string; difficulty: string };
  row: Pick<
    DefensiveEpisodeEvaluationRow,
    'defensiveGenerationId' | 'playerName' | 'episodeEvaluatorVersion' | 'semanticVersion' | 'semanticResolverVersion' | 'resolverVersion' | 'episodes'
  >;
  contextResolverVersion: string;
  resolveOccurrenceResolverVersion?: (episode: PersistedDefensiveEpisode) => string | null | undefined;
}

export function buildDefensiveEpisodeLedgerEvents(
  params: BuildDefensiveEpisodeLedgerEventsParams,
): DefensiveEpisodeLedgerEvent[] {
  const events: DefensiveEpisodeLedgerEvent[] = [];
  for (const episode of params.row.episodes) {
    const ctx: DefensiveEpisodeLedgerEventContext = {
      pull: params.pull,
      playerName: params.row.playerName,
      defensiveGenerationId: params.row.defensiveGenerationId,
      episode,
      episodeEvaluatorVersion: params.row.episodeEvaluatorVersion,
      semanticVersion: params.row.semanticVersion,
      semanticResolverVersion: params.row.semanticResolverVersion,
      resolverVersion: params.row.resolverVersion,
      contextResolverVersion: params.contextResolverVersion,
      occurrenceResolverVersion: params.resolveOccurrenceResolverVersion?.(episode) ?? null,
    };
    events.push(buildDefensiveEpisodeResponseLedgerEvent(ctx));
    const planEvent = buildDefensiveEpisodePlanLedgerEvent(ctx);
    if (planEvent) events.push(planEvent);
  }
  return events;
}
