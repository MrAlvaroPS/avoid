// §Paso C (iris-defensive-canonicalization-v1-plan.md §10/§11) — REESCRITO
// 2026-09-04 tras revisión real que encontró un bug de invariante y una
// simplificación de KPI incorrecta en la versión anterior de este fichero,
// y REESCRITO OTRA VEZ en E4 (misma fecha, plan de continuación §1-§12) para
// dejar de recibir un `applicability` ambiguo y una disponibilidad
// implícita: el candidato ahora distingue explícitamente damageApplicability
// / temporalOpportunity / temporalCastCoverage / engagement / statusAtPeak
// (§6 del plan de continuación), y la confidence del veredicto es
// DECISION-SCOPED (§11) — nunca la más débil de TODO el kit, solo la de la
// evidencia que realmente decidió el veredicto.
//
// Sigue habiendo TRES cambios de fondo heredados de la reescritura anterior,
// más uno nuevo (E4):
//
// 1) TRES KPI, no uno. Uso (¿pulsó algo?) y Response (¿lo que pulsó — o no
//    pulsó — resolvió la presión?) son preguntas DISTINTAS que comparten el
//    mismo episodio pero nunca deben colapsarse en un único verdict.
//    `usageEngaged` (booleano, independiente) + `responseVerdict` (el estado
//    canónico de 7 valores).
//
// 2) BUG REAL corregido: applicability==='unknown' + disponible + sin cast
//    nunca produce `missed_ready` — missed_ready exige damageApplicability Y
//    temporalOpportunity estrictamente 'yes'.
//
// 3) La reconstrucción causal (reconstructCausalAvailability) NUNCA produce
//    missed_due_to_mistime por ausencia de un episodio anterior que
//    justifique un cast — eso no es evidencia positiva de mal uso. Sin
//    evidencia positiva, degrada a `uncertain`. missed_due_to_mistime queda
//    definido en el contrato pero, de momento, inalcanzable desde esta
//    función.
//
// 4) (E4) `no_applicable_resource` es una conclusión POSITIVA — nunca el
//    fallback de "no sé". Un candidato potencialmente relevante pero
//    materialmente sin resolver (semántica pending, buildPresence unknown,
//    resolutionStatus conflict/unresolved, o una regla runtime sin resolver
//    que podría cambiar membership) BLOQUEA esa conclusión y produce
//    `uncertain` en su lugar — nunca crea un missed_ready por sí mismo.

import type { EvaluationConfidence } from './combat-evaluation-contract.ts';
import type { ApplicabilityVerdict, TimingRelation } from './defensive-applicability.ts';
import type { DefensiveCooldownStatus } from './defensive-cooldowns.ts';
import { evaluateTemporalCoverage, normalizeCastTimestamps } from './defensive-temporal-coverage.ts';
// §Corrección de límite de dependencias (2026-09-05): ResponseVerdict se define ahora en
// defensive-episode-kpis.ts (hoja pura sin dependencias, reutilizable tal cual desde el frontend Angular —
// ver el comentario en ese archivo) — se reimporta y reexporta aquí para que ningún consumidor existente de
// `import type { ResponseVerdict } from './defensive-episode-verdict.ts'` (defensive-episode-persistence.ts,
// defensive-episode-ledger-events.ts) tenga que cambiar una sola línea. Mismos 7 valores, sin cambio semántico.
import type { ResponseVerdict } from './defensive-episode-kpis.ts';
export type { ResponseVerdict };

export interface EpisodeWindow {
  startMs: number;
  endMs: number;
  peakMs: number;
}

export interface EpisodeVerdictCandidate {
  spellId: number;
  isDefensiveKitMember: boolean;
  createsMissableOpportunity: boolean;
  materiallyUnresolved: boolean;
  damageApplicability: ApplicabilityVerdict;
  temporalOpportunity: ApplicabilityVerdict;
  temporalCastCoverage: ApplicabilityVerdict;
  engagement: boolean;
  statusAtPeak: DefensiveCooldownStatus;
  confidence: EvaluationConfidence;
  /** Claim-scoped confidence. Optional for backward-compatible fixtures; when absent, confidence is used. */
  membershipConfidence?: EvaluationConfidence;
  applicabilityClaimConfidence?: EvaluationConfidence;
  availabilityConfidence?: EvaluationConfidence;
  coverageConfidence?: EvaluationConfidence;
  evidence: Record<string, unknown>;
}

export interface EpisodeVerdictResult {
  usageEngaged: boolean;
  /** True when a real core opportunity was actionable, even if Response itself must remain uncertain. */
  usageEvaluable: boolean;
  usedSpellIds: number[];
  /** Positive non-core defensive actions are preserved without inflating either KPI. */
  bonusCreditSpellIds: number[];
  responseVerdict: ResponseVerdict;
  reason: string;
  coveredBySpellId: number | null;
  confidence: EvaluationConfidence;
  decisiveSpellIds: number[];
  uncertaintyBlockers: number[];
  causalUpgradeEligible?: boolean;
}

const CONFIDENCE_RANK: Record<EvaluationConfidence, number> = { verified: 0, inferred: 1, fallback: 2, uncertain: 3 };

export function weakestConfidence(...values: EvaluationConfidence[]): EvaluationConfidence {
  return values.reduce((weakest, value) => (CONFIDENCE_RANK[value] > CONFIDENCE_RANK[weakest] ? value : weakest), 'verified' as EvaluationConfidence);
}

function bySpellId<T extends { spellId: number }>(a: T, b: T): number {
  return a.spellId - b.spellId;
}

function isPunitiveConfidence(confidence: EvaluationConfidence): boolean {
  return confidence === 'verified' || confidence === 'inferred';
}

export function resolveEpisodeVerdict(candidates: EpisodeVerdictCandidate[]): EpisodeVerdictResult {
  const sorted = [...candidates].sort(bySpellId);
  const claim = (c: EpisodeVerdictCandidate, key: 'membershipConfidence' | 'applicabilityClaimConfidence' | 'availabilityConfidence' | 'coverageConfidence') =>
    c[key] ?? c.confidence;
  const strong = (c: EpisodeVerdictCandidate, key: 'membershipConfidence' | 'applicabilityClaimConfidence' | 'availabilityConfidence' | 'coverageConfidence') =>
    isPunitiveConfidence(claim(c, key));

  const engagedKitMembers = sorted.filter((c) => c.isDefensiveKitMember && c.engagement);
  const usageEngaged = engagedKitMembers.length > 0;
  const usedSpellIds = [...new Set(engagedKitMembers.map((c) => c.spellId))].sort((a, b) => a - b);

  // A core opportunity can ONLY be created by normal/missable personal resources
  // with strong membership+applicability evidence. credit_only may resolve this
  // opportunity but can never manufacture its denominator.
  const coreApplicable = sorted.filter(
    (c) =>
      c.createsMissableOpportunity &&
      c.damageApplicability === 'yes' &&
      c.temporalOpportunity === 'yes' &&
      strong(c, 'membershipConfidence') &&
      strong(c, 'applicabilityClaimConfidence'),
  );
  const strongReadyCore = coreApplicable.filter(
    (c) => c.statusAtPeak === 'available_unused' && strong(c, 'availabilityConfidence'),
  );
  const strongActiveCore = coreApplicable.filter(
    (c) => c.statusAtPeak === 'active' && strong(c, 'availabilityConfidence'),
  );
  const usageEvaluableNow = strongReadyCore.length > 0 || strongActiveCore.length > 0;

  const strongCovers = sorted.filter(
    (c) =>
      c.isDefensiveKitMember &&
      c.engagement &&
      c.damageApplicability === 'yes' &&
      c.temporalCastCoverage === 'yes' &&
      strong(c, 'membershipConfidence') &&
      strong(c, 'applicabilityClaimConfidence') &&
      strong(c, 'coverageConfidence'),
  );
  const bonusOnlyCovers = strongCovers.filter((c) => !c.createsMissableOpportunity).map((c) => c.spellId);

  if (coreApplicable.length && strongCovers.length) {
    const winner = strongCovers[0];
    return {
      usageEngaged: true,
      usageEvaluable: true,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'covered_verified',
      reason: `Había una oportunidad defensiva core y spellId ${winner.spellId} la cubrió con evidencia suficiente de membership, aplicabilidad y cobertura.`,
      coveredBySpellId: winner.spellId,
      confidence: claim(winner, 'coverageConfidence'),
      decisiveSpellIds: [winner.spellId],
      uncertaintyBlockers: [],
    };
  }

  // A valid credit_only action outside any core opportunity is useful evidence,
  // but it is bonus context, never a synthetic 100% denominator.
  if (!coreApplicable.length && strongCovers.length) {
    return {
      usageEngaged,
      usageEvaluable: false,
      usedSpellIds,
      bonusCreditSpellIds: [...new Set(bonusOnlyCovers)].sort((a, b) => a - b),
      responseVerdict: 'no_applicable_resource',
      reason: 'Se observó una acción defensiva válida, pero no existía una oportunidad core normal que pudiera crear denominador; se conserva como crédito adicional.',
      coveredBySpellId: null,
      confidence: weakestConfidence(...strongCovers.map((c) => claim(c, 'coverageConfidence'))),
      decisiveSpellIds: [],
      uncertaintyBlockers: [],
    };
  }

  const lowConfidenceCovers = sorted.filter(
    (c) =>
      c.isDefensiveKitMember &&
      c.engagement &&
      c.damageApplicability === 'yes' &&
      c.temporalCastCoverage === 'yes' &&
      (!strong(c, 'membershipConfidence') || !strong(c, 'applicabilityClaimConfidence') || !strong(c, 'coverageConfidence')),
  );
  if (coreApplicable.length && lowConfidenceCovers.length) {
    return {
      usageEngaged,
      usageEvaluable: usageEvaluableNow,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'uncertain',
      reason: 'Hubo una respuesta defensiva candidata, pero la evidencia de cobertura no alcanza el umbral simétrico para dar éxito ni para acusar fallo.',
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: [],
      uncertaintyBlockers: lowConfidenceCovers.map((c) => c.spellId).sort((a, b) => a - b),
    };
  }

  const usedUnknown = sorted.filter(
    (c) =>
      c.isDefensiveKitMember &&
      c.engagement &&
      c.damageApplicability !== 'no' &&
      c.temporalCastCoverage !== 'no' &&
      (c.damageApplicability === 'unknown' || c.temporalCastCoverage === 'unknown'),
  );
  if (coreApplicable.length && usedUnknown.length) {
    return {
      usageEngaged,
      usageEvaluable: usageEvaluableNow,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'uncertain',
      reason: `spellId ${usedUnknown.map((c) => c.spellId).join(', ')} se usó durante una oportunidad core, pero su cobertura de daño/timing no puede demostrarse; Uso puede quedar acreditado sin convertir Response en culpa ni éxito.`,
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: [],
      uncertaintyBlockers: usedUnknown.map((c) => c.spellId),
    };
  }

  if (strongReadyCore.length) {
    const winner = strongReadyCore[0];
    return {
      usageEngaged,
      usageEvaluable: true,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'missed_ready',
      reason: usageEngaged
        ? `Había al menos una respuesta core disponible (spellId ${winner.spellId}); hubo uso defensivo, pero ninguna acción cubrió esta ventana.`
        : `spellId ${winner.spellId} estaba disponible con evidencia suficiente de membership, aplicabilidad y disponibilidad; no hubo respuesta defensiva.`,
      coveredBySpellId: null,
      confidence: weakestConfidence(
        claim(winner, 'membershipConfidence'),
        claim(winner, 'applicabilityClaimConfidence'),
        claim(winner, 'availabilityConfidence'),
      ),
      decisiveSpellIds: [winner.spellId],
      uncertaintyBlockers: [],
    };
  }

  const apparentlyReady = coreApplicable.filter((c) => c.statusAtPeak === 'available_unused');
  if (apparentlyReady.length) {
    return {
      usageEngaged,
      usageEvaluable: false,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'uncertain',
      reason: 'Hay recursos core aparentemente disponibles, pero la evidencia específica de disponibilidad no permite convertirlos en missed_ready.',
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: apparentlyReady.map((c) => c.spellId).sort((a, b) => a - b),
      uncertaintyBlockers: apparentlyReady.map((c) => c.spellId).sort((a, b) => a - b),
      causalUpgradeEligible: false,
    };
  }

  const strategic = sorted.filter((c) => c.createsMissableOpportunity || c.materiallyUnresolved);
  if (!strategic.length) {
    return {
      usageEngaged,
      usageEvaluable: false,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'no_applicable_resource',
      reason: 'El build no tiene ningún recurso personal estratégico normal, resuelto o pendiente de resolver, aplicable a este episodio.',
      coveredBySpellId: null,
      confidence: 'verified',
      decisiveSpellIds: [],
      uncertaintyBlockers: [],
    };
  }

  const relevantStrategic = strategic.filter((c) => c.damageApplicability !== 'no' && c.temporalOpportunity !== 'no');
  if (!relevantStrategic.length) {
    return {
      usageEngaged,
      usageEvaluable: false,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'no_applicable_resource',
      reason: 'El build tenía recursos estratégicos, pero ninguno demuestra aplicabilidad de daño/timing a este episodio.',
      coveredBySpellId: null,
      confidence: weakestConfidence(...strategic.map((c) => c.confidence)),
      decisiveSpellIds: strategic.map((c) => c.spellId).sort((a, b) => a - b),
      uncertaintyBlockers: [],
    };
  }

  const unresolvedBlockers = relevantStrategic.filter(
    (c) =>
      c.materiallyUnresolved ||
      c.damageApplicability === 'unknown' ||
      c.temporalOpportunity === 'unknown' ||
      c.statusAtPeak === 'unknown' ||
      !strong(c, 'membershipConfidence') ||
      !strong(c, 'applicabilityClaimConfidence'),
  );
  if (unresolvedBlockers.length) {
    return {
      usageEngaged,
      usageEvaluable: usageEvaluableNow,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'uncertain',
      reason: `spellId ${unresolvedBlockers.map((c) => c.spellId).join(', ')} podría cambiar la evaluación, pero alguna afirmación necesaria todavía no está suficientemente resuelta.`,
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: [],
      uncertaintyBlockers: unresolvedBlockers.map((c) => c.spellId).sort((a, b) => a - b),
      causalUpgradeEligible: false,
    };
  }

  return {
    usageEngaged,
    usageEvaluable: false,
    usedSpellIds,
    bonusCreditSpellIds: [],
    responseVerdict: 'uncertain',
    reason: 'Todo lo estratégico y aplicable estaba en cooldown o activo en el pico; se necesita reconstrucción causal para distinguir indisponibilidad legítima.',
    coveredBySpellId: null,
    confidence: 'uncertain',
    decisiveSpellIds: relevantStrategic.map((c) => c.spellId).sort((a, b) => a - b),
    uncertaintyBlockers: relevantStrategic.map((c) => c.spellId).sort((a, b) => a - b),
    causalUpgradeEligible: true,
  };
}

export interface CausalTimingContext {
  timingRelation: TimingRelation | null;
  effectiveDurationMs: number | null;
  afterDamageResponseWindowMs: number;
  evaluationEndMs: number | null;
}

export interface CausalAvailabilityResult {
  classification: 'unavailable_legitimate' | 'uncertain';
  reason: string;
  justifyingEpisodeIndex?: number;
}

export function reconstructCausalAvailability(
  timing: CausalTimingContext,
  castsForSpellMs: readonly number[],
  episodes: readonly EpisodeWindow[],
  episodeIndex: number,
): CausalAvailabilityResult {
  const sortedCasts = normalizeCastTimestamps(castsForSpellMs);
  const atMs = episodes[episodeIndex].peakMs;
  let lastCastBefore: number | undefined;
  for (const t of sortedCasts) {
    if (t <= atMs) lastCastBefore = t;
    else break;
  }
  if (lastCastBefore === undefined) {
    return { classification: 'uncertain', reason: 'No hay cast previo que explique el cooldown en este pico — inconsistencia de datos, no se acusa.' };
  }

  for (let i = episodeIndex - 1; i >= 0; i--) {
    const result = evaluateTemporalCoverage({
      timingRelation: timing.timingRelation,
      effectiveDurationMs: timing.effectiveDurationMs,
      castsForSpellMs: [lastCastBefore],
      episode: episodes[i],
      afterDamageResponseWindowMs: timing.afterDamageResponseWindowMs,
      evaluationEndMs: timing.evaluationEndMs,
    });
    if (result.castCoverage === 'yes') {
      return {
        classification: 'unavailable_legitimate',
        reason: `El cast anterior (${lastCastBefore}ms) demuestra cobertura del episodio #${i}; el cooldown es consecuencia de un uso correcto.`,
        justifyingEpisodeIndex: i,
      };
    }
  }

  return {
    classification: 'uncertain',
    reason: `El cast anterior (${lastCastBefore}ms) no demuestra cobertura de ningún episodio anterior conocido — puede ser uso legítimo contra una amenaza que el detector no capturó. Sin evidencia positiva de mal uso, no se demuestra mistime.`,
  };
}

export interface CausallyAwareCandidate extends EpisodeVerdictCandidate {
  castsForSpellMs: number[];
  timing: CausalTimingContext;
}

export function resolveEpisodeVerdictWithCausalAvailability(
  candidates: CausallyAwareCandidate[],
  episodes: readonly EpisodeWindow[],
  episodeIndex: number,
): EpisodeVerdictResult {
  const base = resolveEpisodeVerdict(candidates);
  if (base.responseVerdict !== 'uncertain' || !base.causalUpgradeEligible) return base;

  const onCooldownMissable = candidates.filter(
    (c) => c.createsMissableOpportunity && c.damageApplicability === 'yes' && c.temporalOpportunity === 'yes' && c.statusAtPeak === 'on_cooldown',
  );
  if (!onCooldownMissable.length) return base;

  const causalResults = onCooldownMissable.map((c) => ({
    spellId: c.spellId,
    confidence: c.availabilityConfidence ?? c.confidence,
    ...reconstructCausalAvailability(c.timing, c.castsForSpellMs, episodes, episodeIndex),
  }));

  if (causalResults.every((r) => r.classification === 'unavailable_legitimate')) {
    return {
      ...base,
      responseVerdict: 'unavailable_legitimate',
      reason: `Todo lo estratégico y aplicable estaba en cooldown por un uso previo demostrablemente legítimo (${causalResults.map((r) => r.spellId).join(', ')}).`,
      confidence: weakestConfidence(...causalResults.map((r) => r.confidence)),
      decisiveSpellIds: causalResults.map((r) => r.spellId).sort((a, b) => a - b),
    };
  }

  return base;
}
