import { describe, expect, it } from 'vitest';
import type { ResolvedDefensive } from '../../../supabase/functions/_shared/effective-defensives';
import {
  effectiveDeathOptions,
  effectiveDefensiveStateAt,
  evaluateEffectiveWindowCoverage,
} from '../../../supabase/functions/_shared/effective-defensive-state';

function defensive(overrides: Partial<ResolvedDefensive> = {}): ResolvedDefensive {
  return {
    spellId: 586,
    name: 'Fade',
    className: 'Priest',
    specName: 'Shadow',
    category: 'personal_defensive',
    survivalType: 'mitigation',
    targetingMode: 'self',
    activationMode: 'active',
    effectiveCooldownMs: 20_000,
    effectiveDurationMs: 5_000,
    charges: 1,
    rechargeMs: null,
    eligible: true,
    buildFingerprint: 'sha256:test',
    gameBuild: '12.1.0.68914',
    resolverVersion: 'effective-defensives@2.1.0',
    confidence: 'verified',
    provenance: [],
    conditionalModifiers: [],
    ...overrides,
  };
}

describe('effectiveDefensiveStateAt', () => {
  it('uses the effective 20 second cooldown instead of the catalog baseline', () => {
    expect(effectiveDefensiveStateAt(defensive({ effectiveDurationMs: null }), [10_000], 25_000)).toMatchObject({
      status: 'on_cooldown',
      cooldownRemainingMs: 5_000,
    });
    expect(effectiveDefensiveStateAt(defensive({ effectiveDurationMs: null }), [10_000], 30_000).status).toBe('available_unused');
  });

  it('replays two charges with sequential recharge', () => {
    const twoCharges = defensive({ charges: 2, rechargeMs: 20_000, effectiveDurationMs: null });

    expect(effectiveDefensiveStateAt(twoCharges, [0, 1_000], 10_000)).toMatchObject({
      status: 'on_cooldown',
      chargesAvailable: 0,
      cooldownRemainingMs: 10_000,
    });
    expect(effectiveDefensiveStateAt(twoCharges, [0, 1_000], 20_000)).toMatchObject({
      status: 'available_unused',
      chargesAvailable: 1,
      nextChargeAtMs: 40_000,
    });
  });

  it('marks a known-duration effect active before cooldown state', () => {
    expect(effectiveDefensiveStateAt(defensive(), [10_000], 14_000).status).toBe('active');
  });

  it('returns unknown for a cast sequence that requires unmodelled dynamic CDR', () => {
    expect(effectiveDefensiveStateAt(defensive({ effectiveDurationMs: null }), [0, 5_000], 10_000).status).toBe('unknown');
  });
});

describe('effective v2 materialization', () => {
  it('excludes external defensives from personal death options', () => {
    const external = defensive({ spellId: 33206, name: 'Pain Suppression', category: 'external_defensive', targetingMode: 'ally' });
    const options = effectiveDeathOptions([defensive(), external], new Map(), 10_000);

    expect(options.map((option) => option.spellId)).toEqual([586]);
  });

  it('also excludes semi defensives unless a published plan opted into them', () => {
    const semi = defensive({ spellId: 17, name: 'Power Word: Shield', category: 'semi_defensive', targetingMode: 'both' });
    const options = effectiveDeathOptions([defensive(), semi], new Map(), 10_000);

    expect(options.map((option) => option.spellId)).toEqual([586]);
  });

  it('does not call an uncertain available option coverable', () => {
    const result = evaluateEffectiveWindowCoverage(10_000, 12_000, [defensive({ confidence: 'uncertain' })], new Map());

    expect(result.covered).toBe(false);
    expect(result.availableOpportunity).toBe(false);
    expect(result.options[0].status).toBe('available_unused');
  });

  it('keeps actual use as positive evidence even when resolution is uncertain', () => {
    const result = evaluateEffectiveWindowCoverage(
      10_000,
      12_000,
      [defensive({ confidence: 'uncertain', effectiveDurationMs: null })],
      new Map([[586, [11_000]]]),
    );

    expect(result.covered).toBe(true);
    expect(result.options[0].status).toBe('used_during_window');
  });
});
