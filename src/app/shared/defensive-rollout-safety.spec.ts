import { environment } from '../../environments/environment';

describe('defensive rollout safety', () => {
  it('enables only the defensive surface protected by the atomic per-night gate', () => {
    expect(environment.defensiveFeatureFlags).toEqual({
      defensiveEffectiveResolverV2: false,
      defensiveDeployedPlans: false,
      defensiveExecutionEvaluatorV2: false,
      defensiveInfographicV2: true,
      defensiveReliabilityV2: false,
    });
  });

  it('keeps the committed causal v3 rollout explicit', () => {
    expect(Object.values(environment.combatEvaluationFeatureFlags)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});
