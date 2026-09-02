import { environment } from '../../environments/environment';

describe('defensive rollout safety', () => {
  it('keeps every defensive v2 surface disabled until the E2E gate passes', () => {
    expect(environment.defensiveFeatureFlags).toEqual({
      defensiveEffectiveResolverV2: false,
      defensiveDeployedPlans: false,
      defensiveExecutionEvaluatorV2: false,
      defensiveInfographicV2: false,
      defensiveReliabilityV2: false,
    });
  });

  it('keeps causal v3 disabled while occurrences are not authoritative', () => {
    expect(Object.values(environment.combatEvaluationFeatureFlags)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
