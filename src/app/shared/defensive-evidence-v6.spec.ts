import { describe, expect, it } from 'vitest';
import { evaluateTemporalCoverage } from '../../../supabase/functions/_shared/defensive-temporal-coverage';
import { resolveEpisodeVerdict, type EpisodeVerdictCandidate } from '../../../supabase/functions/_shared/defensive-episode-verdict';
import {
  mergeObservedCastEvidenceV6,
  defensiveSemanticClosureViolationsV6,
  observedSelfCastAcquisitionViolationsV6,
} from '../../../supabase/functions/_shared/defensive-evidence-v6';

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

describe('defensive evidence v6 — activation provenance', () => {
  it('an observed aura can prove coverage without fabricating Usage', () => {
    const result = evaluateTemporalCoverage({
      timingRelation: 'before_or_during',
      effectiveDurationMs: 10_000,
      castsForSpellMs: [],
      episode: { startMs: 10_000, peakMs: 12_000, endMs: 14_000 },
      afterDamageResponseWindowMs: 3_000,
      evaluationEndMs: null,
      observedActiveIntervals: [{ startMs: 9_000, endMs: 15_000 }],
    });
    expect(result.castCoverage).toBe('yes');
    expect(result.engagement).toBe(false);
    expect(result.evidence['activationProvenance']).toBe('observed_aura_only');
  });

  it('a same-spell cast associated with the aura proves Usage and coverage', () => {
    const result = evaluateTemporalCoverage({
      timingRelation: 'before_or_during',
      effectiveDurationMs: 10_000,
      castsForSpellMs: [9_050],
      episode: { startMs: 10_000, peakMs: 12_000, endMs: 14_000 },
      afterDamageResponseWindowMs: 3_000,
      evaluationEndMs: null,
      observedActiveIntervals: [{ startMs: 9_000, endMs: 15_000 }],
    });
    expect(result.castCoverage).toBe('yes');
    expect(result.engagement).toBe(true);
    expect(result.evidence['activationProvenance']).toBe('player_cast_and_observed_aura');
  });
});

describe('defensive evidence v6 — claim scoped scoring', () => {
  it('strong observed coverage can succeed even when availability confidence is weak', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 10, availabilityConfidence: 'fallback' }),
      candidate({
        spellId: 20,
        createsMissableOpportunity: false,
        engagement: true,
        statusAtPeak: 'active',
        temporalCastCoverage: 'yes',
        coverageConfidence: 'inferred',
      }),
    ]);
    expect(result.responseVerdict).toBe('covered_verified');
  });

  it('weak availability never creates a miss', () => {
    const result = resolveEpisodeVerdict([
      candidate({ availabilityConfidence: 'fallback' }),
    ]);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.usageEvaluable).toBe(false);
  });
});

describe('defensive evidence v6 — unified acquisition evidence', () => {
  it('merges a live same-pull WCL cast with persisted history without cross-build leakage', () => {
    const merged = mergeObservedCastEvidenceV6(
      [{ spellId: 48707, samePull: false, pullTalentBuildFingerprint: 'same-build' }],
      [48707, 48792],
    );
    expect(merged.some((x) => x.spellId === 48707 && x.samePull && x.source === 'wcl_live_cast')).toBe(true);
    expect(merged.some((x) => x.spellId === 48792 && x.samePull && x.source === 'wcl_live_cast')).toBe(true);
  });
});

describe('defensive evidence v6 — semantic closure gates', () => {
  it('rejects hybrid_survival + normal and accepts personal_survival + normal', () => {
    const broken: any = {
      spellId: 586,
      usageRole: 'hybrid_survival', activationScope: 'self', primaryBeneficiary: 'self', secondaryPropagation: 'none',
      mechanisms: ['mitigation'], opportunityMode: 'normal', createsMissableOpportunity: false, isDefensiveKitMember: false,
    };
    expect(defensiveSemanticClosureViolationsV6([broken]).length).toBeGreaterThan(0);

    const fixed: any = { ...broken, usageRole: 'personal_survival', createsMissableOpportunity: true, isDefensiveKitMember: true };
    expect(defensiveSemanticClosureViolationsV6([fixed])).toEqual([]);
  });

  it('flags a live defensive cast that still resolves acquisition as unknown', () => {
    const kit: any[] = [{ spellId: 48707, semanticStatus: 'verified', buildPresence: 'unknown' }];
    expect(observedSelfCastAcquisitionViolationsV6(kit as any, [48707])).toEqual([
      { spellId: 48707, error: 'same-pull WCL cast observed but buildPresence=unknown' },
    ]);
  });
});
