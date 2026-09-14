import { describe, expect, it } from 'vitest';
import type { ResolvedDefensive } from '../../../supabase/functions/_shared/effective-defensives';
import {
  effectiveDeathOptions,
  effectiveDefensiveStateAt,
  evaluateEffectiveWindowCoverage,
  preventableWithEffectiveDefensive,
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
    semanticResolved: true,
    usageRole: 'personal_survival',
    activationScope: 'self',
    primaryBeneficiary: 'self',
    secondaryPropagation: 'none',
    mechanisms: ['mitigation'],
    opportunityMode: 'normal',
    defensiveIntent: 'primary',
    semanticStatus: 'verified',
    semanticVersion: 'defensive-semantics@1.0.0',
    semanticConfidence: 'verified',
    semanticResolverVersion: 'effective-defensive-semantics@1.5.0',
    semanticProvenance: [],
    buildPresence: 'present',
    buildPresenceReason: 'fixture',
    buildPresenceConfidence: 'verified',
    buildPresenceEvidence: 'baseline_kit',
    applicability: null,
    applicabilityConfidence: 'verified',
    resolutionStatus: 'resolved',
    unresolvedRuntimeRules: [],
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
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

  it('excludes a replaced/non-member resource even if legacy category still says personal_defensive', () => {
    const replaced = defensive({ spellId: 45438, name: 'Ice Block', isDefensiveKitMember: false, createsMissableOpportunity: false });
    const replacement = defensive({ spellId: 414658, name: 'Ice Cold' });
    const result = evaluateEffectiveWindowCoverage(10_000, 12_000, [replaced, replacement], new Map());

    expect(result.options.map((option) => option.spellId)).toEqual([414658]);
  });

  it('credits credit_only use but never fabricates an available-unused opportunity from it', () => {
    const creditOnly = defensive({
      spellId: 34428,
      name: 'Victory Rush',
      usageRole: 'hybrid_survival',
      opportunityMode: 'credit_only',
      createsMissableOpportunity: false,
      effectiveDurationMs: null,
    });
    const unused = evaluateEffectiveWindowCoverage(10_000, 12_000, [creditOnly], new Map());
    expect(unused.options[0].status).toBe('available_unused');
    expect(unused.availableOpportunity).toBe(false);

    const used = evaluateEffectiveWindowCoverage(10_000, 12_000, [creditOnly], new Map([[34428, [11_000]]]));
    expect(used.covered).toBe(true);
    expect(used.availableOpportunity).toBe(false);
  });
});


describe('preventableWithEffectiveDefensive — lethal-hit causality', () => {
  it('does not blame a pure sustain resource for a hit that is already >= max HP', () => {
    const sustain = defensive({
      spellId: 202168,
      name: 'Impending Victory',
      survivalType: 'sustain',
      mechanisms: ['sustain'],
      effectiveDurationMs: 0,
    });
    const options = effectiveDeathOptions([sustain], new Map(), 100_000);

    expect(preventableWithEffectiveDefensive(options, { killingBlowAmount: 870_060, maxHitPoints: 870_060 })).toBe(false);
  });

  it('keeps pure sustain missable for non-one-shot deaths', () => {
    const sustain = defensive({
      spellId: 49039,
      name: 'Lichborne',
      survivalType: 'sustain',
      mechanisms: ['sustain'],
      effectiveDurationMs: 10_000,
    });
    const options = effectiveDeathOptions([sustain], new Map(), 100_000);

    expect(preventableWithEffectiveDefensive(options, { killingBlowAmount: 300_000, maxHitPoints: 850_000 })).toBe(true);
  });

  it('still treats mitigation as causally viable against a full-health lethal hit', () => {
    const options = effectiveDeathOptions([defensive({ spellId: 48792, name: 'Icebound Fortitude', mechanisms: ['mitigation'] })], new Map(), 100_000);

    expect(preventableWithEffectiveDefensive(options, { killingBlowAmount: 850_000, maxHitPoints: 850_000 })).toBe(true);
  });

  it('still treats effective-health as causally viable against a full-health lethal hit', () => {
    const effectiveHealth = defensive({
      spellId: 19236,
      name: 'Desperate Prayer',
      survivalType: 'emergency',
      mechanisms: ['effective_health', 'sustain'],
    });
    const options = effectiveDeathOptions([effectiveHealth], new Map(), 100_000);

    expect(preventableWithEffectiveDefensive(options, { killingBlowAmount: '836200', maxHitPoints: '836200' })).toBe(true);
  });

  it('preserves the previous rule when lethal-hit evidence is unavailable', () => {
    const sustain = defensive({ survivalType: 'sustain', mechanisms: ['sustain'] });
    const options = effectiveDeathOptions([sustain], new Map(), 100_000);

    expect(preventableWithEffectiveDefensive(options)).toBe(true);
  });
});
