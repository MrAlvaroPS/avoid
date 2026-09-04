// §Paso C — iris-defensive-canonicalization-v1-plan.md §2.6: forma exacta
// de UN episodio dentro de la columna `episodes` (jsonb) de
// `player_pull_defensive_episode_evaluations`. Pura combinación de lo que
// ya producen `defensive-episode-grouping.ts` (identidad de ventana) +
// `defensive-episode-verdict.ts` (usageEngaged/responseVerdict) +
// `defensive-episode-identity.ts` (episodeId/causalGroupId estables) — este
// módulo no reevalúa nada, solo da la forma persistible y completa que pide
// el plan: "Persistir los episodios completos, incluyendo
// usageEngaged/usageEvaluable, candidates, applicability, availability,
// Response verdict, plan linkage, evidence y versiones."

import type { EvaluationConfidence } from './combat-evaluation-contract.ts';
import type { EpisodeVerdictCandidate, EpisodeVerdictResult, ResponseVerdict } from './defensive-episode-verdict.ts';
import { deriveEpisodeCausalGroupId, resolveDefensiveEpisodeId, type EpisodeIdentitySource } from './defensive-episode-identity.ts';

export type PlanVerdict = 'covered' | 'missed';

export interface PersistedDefensiveEpisode {
  episodeId: string;
  causalGroupId: string;
  startMs: number;
  peakMs: number;
  endMs: number;
  /** KPI Uso — independiente de responseVerdict, ver §2.5.1 del plan. */
  usageEngaged: boolean;
  /**
   * Denominador del KPI Uso: "episodios donde realmente podía actuar"
   * (§2.5.1). Derivado aquí, no lo produce resolveEpisodeVerdict() todavía
   * (esa función solo conoce Response) — un episodio cuenta si NO está
   * `excluded` y el kit tenía al menos un candidato is_defensive_kit_member
   * (aunque acabara siendo `unknown`/`no` para Response: Uso pregunta "¿tenía
   * algo con lo que actuar?", no "¿era la herramienta correcta?").
   */
  usageEvaluable: boolean;
  usedSpellIds: number[];
  /** Snapshot completo de candidatos evaluados — membership/applicability/availability por spellId. */
  applicableCandidates: EpisodeVerdictCandidate[];
  responseVerdict: ResponseVerdict;
  responseReason: string;
  coveredBySpellId: number | null;
  /** Gestión (§2.5.3) — null hasta que exista un evaluator de Plan real; nunca se infiere aquí. */
  planAssignmentId: string | null;
  planVerdict: PlanVerdict | null;
  evidence: Record<string, unknown>;
  confidence: EvaluationConfidence;
}

/**
 * "¿Podía actuar?" — ver el comentario de `usageEvaluable` arriba.
 * `excluded` nunca es evaluable para ningún KPI (wipe call / fuera de
 * ventana de evaluación); el resto exige al menos un miembro del kit
 * presente en el episodio, sin importar si acabó `unknown`/`no`.
 */
export function deriveUsageEvaluable(
  responseVerdict: ResponseVerdict,
  candidates: readonly Pick<EpisodeVerdictCandidate, 'isDefensiveKitMember'>[],
): boolean {
  if (responseVerdict === 'excluded') return false;
  return candidates.some((candidate) => candidate.isDefensiveKitMember);
}

export interface BuildPersistedDefensiveEpisodeParams {
  pullId: string;
  playerName: string;
  window: EpisodeIdentitySource & { peakMs: number };
  candidates: EpisodeVerdictCandidate[];
  verdict: EpisodeVerdictResult;
  confidence: EvaluationConfidence;
  /** Evidencia adicional (p. ej. reconstrucción causal, grouping basis) — se fusiona con la evidencia mínima ya derivada aquí. */
  evidence?: Record<string, unknown>;
  planAssignmentId?: string | null;
  planVerdict?: PlanVerdict | null;
}

/**
 * Combina identidad + veredicto + candidatos ya resueltos en la forma
 * persistible completa de UN episodio. No reevalúa nada — es una función de
 * ensamblaje puro, para que "reconstrucción staging→ledger" sea trivial de
 * testear sin duplicar la lógica de veredicto.
 */
export function buildPersistedDefensiveEpisode(
  params: BuildPersistedDefensiveEpisodeParams,
): PersistedDefensiveEpisode {
  const episodeId = resolveDefensiveEpisodeId(params.pullId, params.playerName, params.window);
  const usageEvaluable = deriveUsageEvaluable(params.verdict.responseVerdict, params.candidates);
  return {
    episodeId,
    causalGroupId: deriveEpisodeCausalGroupId(episodeId),
    startMs: params.window.startMs,
    peakMs: params.window.peakMs,
    endMs: params.window.endMs,
    usageEngaged: params.verdict.usageEngaged,
    usageEvaluable,
    usedSpellIds: params.verdict.usedSpellIds,
    applicableCandidates: params.candidates,
    responseVerdict: params.verdict.responseVerdict,
    responseReason: params.verdict.reason,
    coveredBySpellId: params.verdict.coveredBySpellId,
    planAssignmentId: params.planAssignmentId ?? null,
    planVerdict: params.planVerdict ?? null,
    evidence: {
      occurrenceId: params.window.occurrenceId,
      dominantAbilityGameId: params.window.dominantAbilityGameId,
      memberIndexes: params.window.memberIndexes,
      ...params.evidence,
    },
    confidence: params.confidence,
  };
}
