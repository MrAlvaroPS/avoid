// §Paso C — iris-defensive-canonicalization-v1-plan.md §2.6: convierte una
// fila de staging YA evaluada (`player_pull_defensive_episode_evaluations`,
// ver `defensive-episode-staging.ts`) en eventos canónicos del ledger
// (`player_execution_events`), namespace `defensive_episode_*` (Respuesta)
// y `defensive_plan_*` (Gestión, solo cuando el episodio lleva plan
// linkage). Puro — el caller (materialize-execution-ledger) hace el I/O.
//
// Identidad ESTABLE, corrección de infraestructura #2 del plan: a
// diferencia de `generateDefensiveEvents()` (V2 legacy, dedup key con hash
// de evidence — una reevaluación con la MISMA decisión pero evidencia
// nueva inserta fila en vez de actualizar), aquí el deduplicationKey NUNCA
// incluye evidence/veredicto: `${generationId}:${episodeId}:${playerName}:response`
// (o `:plan:${planAssignmentId}` para Gestión). Reevaluar el mismo episodio
// dentro de la MISMA generación siempre pisa la misma fila vía UPSERT.

import type { EvaluationConfidence, ExecutionReasonCode, ExecutionVerdict } from './combat-evaluation-contract.ts';
import type { PersistedDefensiveEpisode } from './defensive-episode-persistence.ts';
import type { ResponseVerdict } from './defensive-episode-verdict.ts';
import type { DefensiveEpisodeEvaluationRow } from './defensive-episode-staging.ts';

/** episode-evaluator@1 — asignado aquí per §8 del plan ("pendiente de asignar cuando se construya el materializer"). */
export const DEFENSIVE_EPISODE_EVALUATOR_VERSION = 'episode-evaluator@1';

/** Mapeo §2.6 — tabla "Mapeo a ExecutionVerdict", literal. */
export const RESPONSE_VERDICT_TO_EXECUTION_VERDICT: Record<ResponseVerdict, ExecutionVerdict> = {
  covered_verified: 'success',
  missed_ready: 'missed',
  missed_due_to_mistime: 'missed',
  unavailable_legitimate: 'correct_hold',
  no_applicable_resource: 'not_applicable',
  uncertain: 'uncertain',
  excluded: 'context',
};

/** Reason codes nuevos §2.6 — uno por responseVerdict, nunca compartidos con Gestión/legacy. */
export const RESPONSE_VERDICT_TO_REASON_CODE: Record<ResponseVerdict, ExecutionReasonCode> = {
  covered_verified: 'DEFENSIVE_EPISODE_COVERED',
  missed_ready: 'DEFENSIVE_READY_NOT_USED',
  missed_due_to_mistime: 'DEFENSIVE_MISTIMED',
  unavailable_legitimate: 'DEFENSIVE_UNAVAILABLE_LEGITIMATE',
  no_applicable_resource: 'DEFENSIVE_NO_APPLICABLE_RESOURCE',
  uncertain: 'DEFENSIVE_EPISODE_UNCERTAIN',
  excluded: 'DEFENSIVE_EPISODE_EXCLUDED',
};

/** Solo estos dos pueden penalizar (tabla §2.6: creditEligible/penaltyEligible). */
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
  /**
   * Solo se enlaza occurrence_id cuando el episodio es realmente
   * occurrence-backed (episodeId no heurístico) Y el caller aporta la
   * versión del resolver de occurrence que lo demuestra — la causalidad v3
   * sigue en shadow (ver defensive-episode-grouping.ts), así que sin este
   * dato explícito se deja null en ambos lados (invariante de la FK
   * emparejada de player_execution_events: occurrence_id null ⟺
   * occurrence_resolver_version null).
   */
  occurrenceResolverVersion?: string | null;
}

function isOccurrenceBackedEpisodeId(episodeId: string): boolean {
  return !episodeId.startsWith('heuristic:');
}

/** UN evento de Respuesta por episodio — siempre se emite (los 7 estados son mutuamente excluyentes). */
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

/**
 * UN evento de Gestión por episodio — solo cuando el episodio lleva plan
 * linkage real (`planAssignmentId`+`planVerdict`). Hoy ningún evaluator
 * puebla esos campos todavía (Gestión es "un evaluator distinto de
 * Respuesta", §2.5.3 — no se construye en este corte); esta función queda
 * lista y testeada para cuando exista, en vez de inventar su lógica aquí.
 */
export function buildDefensiveEpisodePlanLedgerEvent(
  ctx: DefensiveEpisodeLedgerEventContext,
): DefensiveEpisodeLedgerEvent | null {
  const { episode } = ctx;
  if (episode.planAssignmentId == null || episode.planVerdict == null) return null;

  const verdict: ExecutionVerdict = episode.planVerdict === 'covered' ? 'success' : 'missed';
  // Reutiliza los reason codes YA existentes de Gestión/Plan legacy — son
  // conceptualmente correctos aquí (esto SÍ es Gestión, no Respuesta); la
  // prohibición del plan es solo no usarlos para eventos de Respuesta.
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

/** Todos los eventos canónicos (Respuesta + Gestión cuando aplique) de UNA fila de staging completa. */
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
