import { describe, expect, it } from 'vitest';
import {
  evaluateTemporalCoverage,
  normalizeCastTimestamps,
  type TemporalCoverageInput,
} from '../../../supabase/functions/_shared/defensive-temporal-coverage';

const episode = { startMs: 10_000, endMs: 12_000, peakMs: 11_000 };

function input(overrides: Partial<TemporalCoverageInput> = {}): TemporalCoverageInput {
  return {
    timingRelation: 'before_or_during',
    effectiveDurationMs: 12_000,
    castsForSpellMs: [],
    episode,
    afterDamageResponseWindowMs: 3000,
    evaluationEndMs: null,
    ...overrides,
  };
}

describe('normalizeCastTimestamps', () => {
  it('sorts ascending, dedupes exact duplicates, and drops non-finite values', () => {
    expect(normalizeCastTimestamps([500, 100, 100, Number.NaN, 300, Infinity])).toEqual([100, 300, 500]);
  });

  it('does not reject negative synthetic timestamps', () => {
    expect(normalizeCastTimestamps([-20_000, -5000])).toEqual([-20_000, -5000]);
  });
});

describe('evaluateTemporalCoverage — before_or_during (test 11-13)', () => {
  it('11: cast before the episode whose duration covers the peak → engagement + covered', () => {
    const result = evaluateTemporalCoverage(input({ castsForSpellMs: [8_000], effectiveDurationMs: 12_000 }));
    expect(result.engagement).toBe(true);
    expect(result.opportunity).toBe('yes');
    expect(result.castCoverage).toBe('yes');
  });

  it('12: cast after the peak but still inside the episode → engagement true, not verified cover', () => {
    const result = evaluateTemporalCoverage(input({ castsForSpellMs: [11_500] }));
    expect(result.engagement).toBe(true);
    expect(result.castCoverage).toBe('no');
  });

  it('13: cast too early, effect expired before the peak → not verified coverage', () => {
    const result = evaluateTemporalCoverage(input({ castsForSpellMs: [8_000], effectiveDurationMs: 2000 }));
    expect(result.engagement).toBe(true);
    expect(result.castCoverage).toBe('no');
  });

  it('unknown effectiveDurationMs never guesses coverage for a cast strictly before the episode', () => {
    const result = evaluateTemporalCoverage(input({ castsForSpellMs: [8_000], effectiveDurationMs: null }));
    expect(result.engagement).toBe(false);
    expect(result.castCoverage).toBe('no');
  });

  it('unknown effectiveDurationMs with a cast inside the episode still leaves coverage unknown', () => {
    const result = evaluateTemporalCoverage(input({ castsForSpellMs: [10_500], effectiveDurationMs: null }));
    expect(result.engagement).toBe(true);
    expect(result.castCoverage).toBe('unknown');
  });

  it('an observed active-effect interval is stronger positive evidence than cast+duration', () => {
    const result = evaluateTemporalCoverage(
      input({ castsForSpellMs: [], observedActiveIntervals: [{ startMs: 10_900, endMs: 11_200 }] }),
    );
    expect(result.castCoverage).toBe('yes');
  });

  it('observed aura removal before the peak beats a theoretical duration that would otherwise cover', () => {
    const result = evaluateTemporalCoverage(
      input({
        castsForSpellMs: [8_000],
        effectiveDurationMs: 12_000,
        observedActiveIntervals: [{ startMs: 8_000, endMs: 10_500 }],
      }),
    );
    expect(result.engagement).toBe(true);
    expect(result.castCoverage).toBe('no');
    expect(result.evidence['observedNegativePrecedence']).toBe(true);
  });

  it('real Magzil/Prismatic Barrier regression: 45.005→72.078 cannot cover peak 72.775 despite a 60s maximum duration', () => {
    const result = evaluateTemporalCoverage(
      input({
        episode: { startMs: 70_000, endMs: 74_000, peakMs: 72_775 },
        castsForSpellMs: [45_005],
        effectiveDurationMs: 60_000,
        observedActiveIntervals: [{ startMs: 45_005, endMs: 72_078 }],
      }),
    );
    expect(result.castCoverage).toBe('no');
    expect(result.evidence['observedNegativePrecedence']).toBe(true);
  });

  it('a refresh cast inside an observed interval is also disproven when that interval ends before the peak', () => {
    const result = evaluateTemporalCoverage(
      input({
        castsForSpellMs: [8_000, 10_000],
        effectiveDurationMs: 12_000,
        observedActiveIntervals: [{ startMs: 8_000, endMs: 10_500 }],
      }),
    );
    expect(result.castCoverage).toBe('no');
  });

  it('when observed aura evidence exists but cannot be associated with a theoretical covering cast, it fails closed to unknown', () => {
    const result = evaluateTemporalCoverage(
      input({
        castsForSpellMs: [8_000],
        effectiveDurationMs: 12_000,
        observedActiveIntervals: [{ startMs: 1_000, endMs: 2_000 }],
      }),
    );
    expect(result.castCoverage).toBe('unknown');
  });
});

describe('evaluateTemporalCoverage — after_damage (test 14-15)', () => {
  it('14: cast inside the explicit 3000ms reactive response window → engagement + coverage', () => {
    const result = evaluateTemporalCoverage(input({ timingRelation: 'after_damage', castsForSpellMs: [12_500] }));
    expect(result.engagement).toBe(true);
    expect(result.opportunity).toBe('yes');
    expect(result.castCoverage).toBe('yes');
  });

  it('15: cast outside the response window → no temporal coverage', () => {
    const result = evaluateTemporalCoverage(input({ timingRelation: 'after_damage', castsForSpellMs: [16_000] }));
    expect(result.engagement).toBe(false);
    expect(result.castCoverage).toBe('no');
  });

  it('the reactive grace window never crosses the evaluation cutoff', () => {
    const result = evaluateTemporalCoverage(
      input({ timingRelation: 'after_damage', castsForSpellMs: [14_500], evaluationEndMs: 13_000 }),
    );
    expect(result.engagement).toBe(false);
    expect(result.castCoverage).toBe('no');
  });

  it('anchors reactive coverage to the real damage hit even when cast occurs before the aggregated episode start', () => {
    const result = evaluateTemporalCoverage(
      input({
        timingRelation: 'after_damage',
        episode: { startMs: 10_000, endMs: 12_000, peakMs: 11_000 },
        damageTimestampsMs: [9_500],
        castsForSpellMs: [9_800],
        afterDamageResponseWindowMs: 3000,
      }),
    );
    expect(result.engagement).toBe(true);
    expect(result.castCoverage).toBe('yes');
    expect(result.evidence['anchor']).toBe('raw_damage_hits');
  });
});

describe('evaluateTemporalCoverage — either (test 16-17)', () => {
  it('16: proactive overlap alone satisfies either', () => {
    const result = evaluateTemporalCoverage(input({ timingRelation: 'either', castsForSpellMs: [8_000], effectiveDurationMs: 12_000 }));
    expect(result.castCoverage).toBe('yes');
  });

  it('17: reactive response alone satisfies either', () => {
    const result = evaluateTemporalCoverage(input({ timingRelation: 'either', castsForSpellMs: [12_500] }));
    expect(result.castCoverage).toBe('yes');
  });

  it('neither proactive nor reactive covers → no', () => {
    const result = evaluateTemporalCoverage(input({ timingRelation: 'either', castsForSpellMs: [16_000], effectiveDurationMs: 500 }));
    expect(result.castCoverage).toBe('no');
  });
});

describe('evaluateTemporalCoverage — continuous_state (test 18)', () => {
  it('18: without an observed active interval, never fabricates coverage and never a negative opportunity', () => {
    const result = evaluateTemporalCoverage(input({ timingRelation: 'continuous_state', castsForSpellMs: [9_000] }));
    expect(result.opportunity).toBe('unknown');
    expect(result.castCoverage).toBe('unknown');
  });

  it('an observed active interval covering the peak proves coverage', () => {
    const result = evaluateTemporalCoverage(
      input({ timingRelation: 'continuous_state', observedActiveIntervals: [{ startMs: 0, endMs: null }] }),
    );
    expect(result.castCoverage).toBe('yes');
  });
});

describe('evaluateTemporalCoverage — unknown/null timingRelation (test 19)', () => {
  it('19: preserves engagement evidence but never fabricates covered_verified/missed_ready by guessing', () => {
    const result = evaluateTemporalCoverage(input({ timingRelation: null, castsForSpellMs: [10_500] }));
    expect(result.engagement).toBe(true);
    expect(result.opportunity).toBe('unknown');
    expect(result.castCoverage).toBe('unknown');
  });

  it('same for the literal "unknown" relation', () => {
    const result = evaluateTemporalCoverage(input({ timingRelation: 'unknown', castsForSpellMs: [] }));
    expect(result.engagement).toBe(false);
    expect(result.opportunity).toBe('unknown');
    expect(result.castCoverage).toBe('unknown');
  });
});
