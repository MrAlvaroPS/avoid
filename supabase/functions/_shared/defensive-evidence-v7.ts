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
 * Shadow v7 does not change acquisition or semantic resolution versus v6.
 * It bumps only the episode evaluator contract: observed aura termination is
 * authoritative negative evidence over a tooltip's maximum theoretical duration.
 */
export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V7 = EFFECTIVE_DEFENSIVE_RESOLVER_VERSION;
export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V7 = EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION;
export const DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7 = 'episode-evaluator@7';
