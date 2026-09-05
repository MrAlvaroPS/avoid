import { describe, expect, it } from 'vitest';
import {
  calculateLocalDefensiveMetrics,
  finiteNumber,
  positiveAbilityId,
  rankLocalDefensivePriorities,
} from '../../../supabase/functions/_shared/local-defensive-profile';

describe('local defensive profile', () => {
  it('never converts missing identifiers or measurements to zero', () => {
    expect(finiteNumber(null)).toBeNull();
    expect(finiteNumber('')).toBeNull();
    expect(positiveAbilityId(undefined)).toBeNull();
    expect(positiveAbilityId(0)).toBeNull();
    expect(positiveAbilityId('123')).toBe(123);
  });

  it('keeps raid impact and individual lethality as separate local signals', () => {
    expect(
      calculateLocalDefensiveMetrics({
        abilityId: 123,
        damageSamples: [100, 200],
        unmitigatedEstimateSamples: [300, 500],
        maxHealthPctSamples: [40, 80],
        playerHitCountSamples: [10, 20],
        deathCount: 1,
        nearDeathCount: 2,
        samplePullCount: 10,
      }),
    ).toEqual({
      raidImpactScore: 6_000,
      individualLethalityScore: 96,
    });
  });

  it('ranks ties deterministically by ability id', () => {
    const priorities = rankLocalDefensivePriorities([
      { abilityId: 20, raidImpactScore: 100, individualLethalityScore: 50 },
      { abilityId: 10, raidImpactScore: 100, individualLethalityScore: 50 },
    ]);

    expect(priorities.get(10)).toBe(5);
    expect(priorities.get(20)).toBe(3);
  });
});
