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
 * v8 preserves every v7 scoring decision. The version bump is a persistence
 * contract change only: canonical rows now retain the episode peak magnitude,
 * an explicit effective-kit snapshot and the structured temporal/resource
 * facts needed by downstream audit projections. No KPI formula changes.
 */
export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V8 = EFFECTIVE_DEFENSIVE_RESOLVER_VERSION;
export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V8 = EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION;
export const DEFENSIVE_EPISODE_EVALUATOR_VERSION_V8 = 'episode-evaluator@8';

