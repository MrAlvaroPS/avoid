import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION,
} from './effective-defensives.ts';

export {
  mergeObservedCastEvidenceV6,
  defensiveSemanticClosureViolationsV6,
  defensiveScoreabilityViolationsV6,
  observedSelfCastAcquisitionViolationsV6,
  type ObservedCastEvidenceV6,
  type DefensiveSemanticClosureViolation,
  type DefensiveScoreabilityViolation,
} from './defensive-evidence-v6.ts';

/**
 * v9 (2026-09-10, §causal-fix — hallazgo empírico real: Gusmï/Txerokee/
 * Truchaman/Tetasdivinas cayendo a `uncertain` en la mayoría de sus
 * episodios evaluables pese a tener casts defensivos reales cerca de daño
 * real). `reconstructCausalAvailability` (defensive-episode-verdict.ts)
 * ahora también acepta daño crudo real del pull — no solo episodios ya
 * agrupados por el detector de presión (umbral 2.5x mediana propia) — como
 * evidencia positiva de que un cooldown es consecuencia de un uso legítimo.
 * Esto SÍ cambia decisiones de veredicto (uncertain → unavailable_legitimate
 * en casos concretos), a diferencia de v8 (solo contrato de persistencia).
 * resolver/semantic-resolver de kit NO cambian — el kit efectivo resuelto es
 * idéntico a v8, solo cambia qué episodios se consideran evaluables.
 */
export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V9 = EFFECTIVE_DEFENSIVE_RESOLVER_VERSION;
export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V9 = EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION;
export const DEFENSIVE_EPISODE_EVALUATOR_VERSION_V9 = 'episode-evaluator@9';
