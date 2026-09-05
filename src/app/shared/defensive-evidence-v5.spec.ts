import { describe, expect, it } from 'vitest';
import { resolveEpisodeVerdict, type EpisodeVerdictCandidate } from '../../../supabase/functions/_shared/defensive-episode-verdict';
import { resolveEffectiveDefensiveKit, type EffectiveDefensiveData, type ResolveDefensiveKitInput } from '../../../supabase/functions/_shared/effective-defensives';

function candidate(overrides: Partial<EpisodeVerdictCandidate> = {}): EpisodeVerdictCandidate {
  return {
    spellId: 1,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    materiallyUnresolved: false,
    damageApplicability: 'yes',
    temporalOpportunity: 'yes',
    temporalCastCoverage: 'no',
    engagement: false,
    statusAtPeak: 'available_unused',
    confidence: 'verified',
    membershipConfidence: 'verified',
    applicabilityClaimConfidence: 'verified',
    availabilityConfidence: 'verified',
    coverageConfidence: 'verified',
    evidence: {},
    ...overrides,
  };
}

describe('defensive evidence v5 — core opportunity scoring', () => {
  it('credit_only can cover an existing core opportunity', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 10 }),
      candidate({ spellId: 20, createsMissableOpportunity: false, engagement: true, temporalCastCoverage: 'yes', statusAtPeak: 'active' }),
    ]);
    expect(result.responseVerdict).toBe('covered_verified');
    expect(result.coveredBySpellId).toBe(20);
    expect(result.usageEvaluable).toBe(true);
  });

  it('credit_only used outside any core opportunity is bonus, not a synthetic Response denominator', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 20, createsMissableOpportunity: false, engagement: true, temporalCastCoverage: 'yes', statusAtPeak: 'active' }),
    ]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
    expect(result.usageEvaluable).toBe(false);
    expect(result.bonusCreditSpellIds).toEqual([20]);
  });

  it('availability fallback blocks a miss but does not invalidate an independently strong positive cover', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 10, availabilityConfidence: 'fallback' }),
      candidate({ spellId: 20, createsMissableOpportunity: false, engagement: true, temporalCastCoverage: 'yes', statusAtPeak: 'active' }),
    ]);
    expect(result.responseVerdict).toBe('covered_verified');
  });

  it('a late/ineffective defensive is Usage yes and Response miss when a strong core option was available', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 10 }),
      candidate({ spellId: 20, createsMissableOpportunity: false, engagement: true, temporalCastCoverage: 'no', statusAtPeak: 'on_cooldown' }),
    ]);
    expect(result.usageEngaged).toBe(true);
    expect(result.usageEvaluable).toBe(true);
    expect(result.responseVerdict).toBe('missed_ready');
    expect(result.reason).toContain('hubo uso defensivo');
  });
});

describe('defensive evidence v5 — source precedence and baseline modifiers', () => {
  const baseInput: ResolveDefensiveKitInput = {
    className: 'Monk', specName: 'Mistweaver', talentBuild: [], buildFingerprint: 'x',
    gameBuild: '12.1.0.68914', gameBuildConfidence: 'verified', playerIdentity: { playerName: 'Fixture' },
  };
  const catalog: any = {
    spellId: 115203, name: 'Fortifying Brew', className: 'Monk', specName: null, specOverride: null,
    category: 'personal_defensive', survivalType: 'mitigation', targetingMode: 'self', activationMode: 'active',
    passiveConversionSpellIds: [], activationGameBuild: '12.1.0.68914', baseCooldownMs: 360000, baseDurationMs: 15000,
    reviewed: true,
  };
  const semantic: any = {
    spellId: 115203, className: 'Monk', usageRole: 'personal_survival', activationScope: 'self', primaryBeneficiary: 'self',
    secondaryPropagation: 'none', mechanisms: ['mitigation'], opportunityMode: 'normal', defensiveIntent: 'primary',
    semanticStatus: 'verified', semanticVersion: 'defensive-semantics@1.0.0', semanticConfidence: 'verified', locked: true,
    applicability: { schoolScope: 'all', schools: [], deliveryScopes: ['all'], requiresDodgeable: false, requiresParryable: false, requiresBlockable: false, requiresSourceAffectedBySpell: false, timingRelation: 'before_or_during' },
    applicabilityConfidence: 'high', applicabilityError: null, specSemanticProfiles: [], invalidSpecSemanticProfiles: [],
  };
  const data: EffectiveDefensiveData = {
    catalog: [catalog],
    specProfiles: [{ className: 'Monk', specName: 'Mistweaver', spellId: 115203, gameBuild: 'legacy-current', baseCooldownMs: 120000, baseDurationMs: 15000, charges: 1, rechargeMs: null }],
    modifierRules: [{ id: 'mw-core', className: 'Monk', specNames: ['Mistweaver'], modifierSpellId: 1258138, targetSpellId: 115203, operation: 'subtract_ms', effectField: 'cooldown_ms', value: 240000, perRank: false, condition: 'always', gameBuild: '12.1.0.68914', applicationOrder: 100, description: 'core passive', active: true, presenceMode: 'spec_baseline' }],
    semantics: [semantic], semanticRules: [], overrides: [],
  };

  it('ignores conflicting legacy timing when exact-current reviewed catalog exists, then applies spec baseline rule', () => {
    const [resolved] = resolveEffectiveDefensiveKit(baseInput, data);
    expect(resolved.effectiveCooldownMs).toBe(120000);
    expect(resolved.cooldownConfidence).toBe('verified');
    expect(resolved.provenance.some((p) => p.kind === 'validation' && p.field === 'cooldown_ms')).toBe(true);
  });
});
