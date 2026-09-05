import { describe, expect, it } from 'vitest';
import {
  reconstructCausalAvailability,
  resolveEpisodeVerdict,
  resolveEpisodeVerdictWithCausalAvailability,
  type CausallyAwareCandidate,
  type CausalTimingContext,
  type EpisodeVerdictCandidate,
  type EpisodeWindow,
} from '../../../supabase/functions/_shared/defensive-episode-verdict';

const episode: EpisodeWindow = { startMs: 10_000, endMs: 12_000, peakMs: 11_000 };

function candidate(overrides: Partial<EpisodeVerdictCandidate> = {}): EpisodeVerdictCandidate {
  return {
    spellId: 22812,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    materiallyUnresolved: false,
    damageApplicability: 'yes',
    temporalOpportunity: 'yes',
    temporalCastCoverage: 'yes',
    engagement: false,
    statusAtPeak: 'available_unused',
    confidence: 'verified',
    evidence: {},
    ...overrides,
  };
}

describe('resolveEpisodeVerdict — precedence (§7 of the continuation plan)', () => {
  it('1) VERIFIED COVER: engaged kit member with damage+timing coverage → covered_verified, decisive confidence from the covering candidate', () => {
    const result = resolveEpisodeVerdict([candidate({ engagement: true, confidence: 'inferred' })]);
    expect(result.usageEngaged).toBe(true);
    expect(result.responseVerdict).toBe('covered_verified');
    expect(result.coveredBySpellId).toBe(22812);
    expect(result.confidence).toBe('inferred');
    expect(result.decisiveSpellIds).toEqual([22812]);
  });

  it('credit_only members (isDefensiveKitMember but not createsMissableOpportunity) resolve an episode positively when actually used correctly', () => {
    const bearForm = candidate({ createsMissableOpportunity: false, engagement: true });
    const result = resolveEpisodeVerdict([bearForm]);
    expect(result.responseVerdict).toBe('covered_verified');
  });

  it('2) USED BUT POSSIBLY VALID UNKNOWN: engaged kit member with unknown damage applicability → uncertain, never covered, never penalized', () => {
    const result = resolveEpisodeVerdict([
      candidate({ engagement: true, damageApplicability: 'unknown', temporalCastCoverage: 'unknown' }),
    ]);
    expect(result.usageEngaged).toBe(true);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.coveredBySpellId).toBeNull();
    expect(result.confidence).toBe('uncertain');
    expect(result.uncertaintyBlockers).toEqual([22812]);
  });

  it('an unrelated UNUSED unknown resource does not excuse a known ready miss (test 7)', () => {
    const readyKnown = candidate({ spellId: 1, engagement: false, statusAtPeak: 'available_unused' });
    const unrelatedUnknown = candidate({
      spellId: 2,
      engagement: false,
      damageApplicability: 'unknown',
      temporalOpportunity: 'unknown',
      createsMissableOpportunity: false,
    });
    const result = resolveEpisodeVerdict([readyKnown, unrelatedUnknown]);
    expect(result.responseVerdict).toBe('missed_ready');
    expect(result.decisiveSpellIds).toEqual([1]);
  });

  it('an actually USED unresolved/unknown potentially relevant resource blocks missed_ready even with another ready candidate unused (test 8)', () => {
    const usedUnknown = candidate({
      spellId: 1,
      engagement: true,
      damageApplicability: 'unknown',
      temporalCastCoverage: 'unknown',
    });
    const readyOther = candidate({ spellId: 2, engagement: false, statusAtPeak: 'available_unused' });
    const result = resolveEpisodeVerdict([usedUnknown, readyOther]);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.responseVerdict).not.toBe('missed_ready');
  });

  it('used the wrong tool (damageApplicability confirmed no): usageEngaged=true, never covered', () => {
    const result = resolveEpisodeVerdict([
      candidate({ engagement: true, damageApplicability: 'no', createsMissableOpportunity: false }),
    ]);
    expect(result.usageEngaged).toBe(true);
    expect(result.responseVerdict).not.toBe('covered_verified');
  });

  it('3) POSITIVE READY OPPORTUNITY: missed_ready only when damageApplicability AND temporalOpportunity are strictly yes and it was truly available', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'available_unused' })]);
    expect(result.responseVerdict).toBe('missed_ready');
    expect(result.usageEngaged).toBe(false);
  });

  it('never misses when damageApplicability is confirmed no (invariant 5)', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'available_unused', damageApplicability: 'no' })]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
  });

  it('never misses when temporalOpportunity is confirmed no', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'available_unused', temporalOpportunity: 'no' })]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
  });

  it('whole-kit precedence: a second ready ability wins over a first one being on cooldown — the episode is missed_ready, not resolved per-spell', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 1, statusAtPeak: 'on_cooldown' }),
      candidate({ spellId: 2, statusAtPeak: 'available_unused' }),
    ]);
    expect(result.responseVerdict).toBe('missed_ready');
  });

  it('4) NO POSITIVE MISSABLE OPPORTUNITY: no strategic resource at all (not even unresolved) → no_applicable_resource', () => {
    const result = resolveEpisodeVerdict([]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
  });

  it('a resolved-but-irrelevant candidate (not a kit member, not materially unresolved) does not block no_applicable_resource (test 5)', () => {
    const utilityResource = candidate({
      isDefensiveKitMember: false,
      createsMissableOpportunity: false,
      materiallyUnresolved: false,
      engagement: false,
    });
    const result = resolveEpisodeVerdict([utilityResource]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
  });

  it('BUG FIX regression: damageApplicability unknown + available + not used must NEVER produce no_applicable_resource — it is uncertain because that unknown resource could genuinely be the answer', () => {
    const result = resolveEpisodeVerdict([
      candidate({ damageApplicability: 'unknown', statusAtPeak: 'available_unused', engagement: false }),
    ]);
    expect(result.responseVerdict).not.toBe('no_applicable_resource');
    expect(result.responseVerdict).toBe('uncertain');
  });

  it('a potentially relevant unresolved (pending/buildPresence unknown) resource, unused, blocks no_applicable_resource → uncertain, not no_applicable_resource (test 6)', () => {
    const unresolved = candidate({
      isDefensiveKitMember: false,
      createsMissableOpportunity: false,
      materiallyUnresolved: true,
      damageApplicability: 'unknown',
      temporalOpportunity: 'unknown',
      engagement: false,
    });
    const result = resolveEpisodeVerdict([unresolved]);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.responseVerdict).not.toBe('no_applicable_resource');
    expect(result.uncertaintyBlockers).toEqual([22812]);
  });

  it('base uncertain (never a penalty) when everything strategic-applicable is on cooldown or undetermined, eligible for causal upgrade', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'on_cooldown' })]);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.causalUpgradeEligible).toBe(true);
  });
});

describe('confidence is decision-scoped, never the weakest of the whole kit (§11, test 32-34)', () => {
  it('32: a verified Barkskin missed_ready is not poisoned by an unrelated uncertain credit_only resource', () => {
    const decisive = candidate({ spellId: 1, statusAtPeak: 'available_unused', confidence: 'verified' });
    const unrelated = candidate({
      spellId: 2,
      createsMissableOpportunity: false,
      confidence: 'uncertain',
      statusAtPeak: 'available_unused',
    });
    const result = resolveEpisodeVerdict([decisive, unrelated]);
    expect(result.responseVerdict).toBe('missed_ready');
    expect(result.confidence).toBe('verified');
  });

  it('33: decisive medium applicability evidence maps to inferred-level confidence', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'available_unused', confidence: 'inferred' })]);
    expect(result.confidence).toBe('inferred');
  });

  it('34: a material unresolved blocker forces uncertain confidence', () => {
    const unresolved = candidate({
      isDefensiveKitMember: false,
      createsMissableOpportunity: false,
      materiallyUnresolved: true,
      damageApplicability: 'unknown',
      confidence: 'verified',
    });
    const result = resolveEpisodeVerdict([unresolved]);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.confidence).toBe('uncertain');
  });
});

function timing(overrides: Partial<CausalTimingContext> = {}): CausalTimingContext {
  return { timingRelation: 'before_or_during', effectiveDurationMs: 12_000, afterDamageResponseWindowMs: 3000, evaluationEndMs: null, ...overrides };
}

describe('reconstructCausalAvailability', () => {
  const episodes: EpisodeWindow[] = [
    { startMs: 0, endMs: 2000, peakMs: 1000 },
    { startMs: 10_000, endMs: 12_000, peakMs: 11_000 },
  ];

  it('unavailable_legitimate when the prior cast demonstrably covered an earlier episode', () => {
    const result = reconstructCausalAvailability(timing(), [500], episodes, 1);
    expect(result.classification).toBe('unavailable_legitimate');
    expect(result.justifyingEpisodeIndex).toBe(0);
  });

  it('a prior cast with NO matching earlier episode never becomes missed_due_to_mistime — degrades to uncertain (Mythic sustained-damage case)', () => {
    const result = reconstructCausalAvailability(timing(), [5_000], episodes, 1);
    expect(result.classification).toBe('uncertain');
    expect(result.classification).not.toBe('missed_due_to_mistime' as never);
  });

  it('uncertain when there is no prior cast at all to explain the cooldown', () => {
    const result = reconstructCausalAvailability(timing(), [], episodes, 1);
    expect(result.classification).toBe('uncertain');
  });

  it('normalizes unsorted/duplicate cast timestamps before reconstructing (§9)', () => {
    const result = reconstructCausalAvailability(timing(), [500, 500, -100], episodes, 1);
    expect(result.classification).toBe('unavailable_legitimate');
  });
});

describe('resolveEpisodeVerdictWithCausalAvailability', () => {
  const episodes: EpisodeWindow[] = [
    { startMs: 0, endMs: 2000, peakMs: 1000 },
    { startMs: 10_000, endMs: 12_000, peakMs: 11_000 },
  ];

  function causalCandidate(overrides: Partial<CausallyAwareCandidate> = {}): CausallyAwareCandidate {
    return {
      ...candidate({ statusAtPeak: 'on_cooldown' }),
      castsForSpellMs: [500],
      timing: timing(),
      ...overrides,
    };
  }

  it('promotes uncertain to unavailable_legitimate when the on-cooldown ability was legitimately spent on a prior episode (test 25)', () => {
    const result = resolveEpisodeVerdictWithCausalAvailability([causalCandidate()], episodes, 1);
    expect(result.responseVerdict).toBe('unavailable_legitimate');
  });

  it('stays uncertain when the prior cast has no justifying episode (test 26 — never fabricates missed_due_to_mistime)', () => {
    const result = resolveEpisodeVerdictWithCausalAvailability([causalCandidate({ castsForSpellMs: [5_000] })], episodes, 1);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.responseVerdict).not.toBe('missed_due_to_mistime' as never);
  });

  it('does not touch a base verdict that was already final (e.g. missed_ready — test 24)', () => {
    const result = resolveEpisodeVerdictWithCausalAvailability(
      [causalCandidate({ statusAtPeak: 'available_unused' })],
      episodes,
      1,
    );
    expect(result.responseVerdict).toBe('missed_ready');
  });

  it('mixed kit: one legitimate + one with no justification stays uncertain — not all could be demonstrated (test 27)', () => {
    const result = resolveEpisodeVerdictWithCausalAvailability(
      [
        causalCandidate({ spellId: 1, castsForSpellMs: [500] }),
        causalCandidate({ spellId: 2, castsForSpellMs: [5_000] }),
      ],
      episodes,
      1,
    );
    expect(result.responseVerdict).toBe('uncertain');
  });

  it('never upgrades when the base uncertain came from an unresolved blocker unrelated to cooldown (test 6/27 combined)', () => {
    const legitimateOnCooldown = causalCandidate({ spellId: 1, castsForSpellMs: [500] });
    const unresolvedBlocker: CausallyAwareCandidate = {
      ...candidate({
        spellId: 2,
        isDefensiveKitMember: false,
        createsMissableOpportunity: false,
        materiallyUnresolved: true,
        damageApplicability: 'unknown',
      }),
      castsForSpellMs: [],
      timing: timing(),
    };
    const result = resolveEpisodeVerdictWithCausalAvailability([legitimateOnCooldown, unresolvedBlocker], episodes, 1);
    expect(result.responseVerdict).toBe('uncertain');
  });
});
