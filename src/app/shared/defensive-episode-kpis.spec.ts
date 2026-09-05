import { describe, expect, it } from 'vitest';
import {
  aggregateDefensiveEpisodeKpis,
  deriveDefensiveEpisodeKpiContribution,
  deriveUsageEvaluable,
  type DefensiveEpisodeKpiEpisodeInput,
  type ResponseVerdict,
} from '../../../supabase/functions/_shared/defensive-episode-kpis';

// §Corrección de límite de dependencias (2026-09-05): este fixture usaba Pick<PersistedDefensiveEpisode, ...>
// (defensive-episode-persistence.ts) — desde que aggregateDefensiveEpisodeKpis/deriveDefensiveEpisodeKpiContribution
// declaran su propio contrato mínimo (DefensiveEpisodeKpiEpisodeInput, en el propio defensive-episode-kpis.ts,
// hoja pura sin dependencias), el fixture de este spec usa ese mismo contrato directamente — ya no hace falta
// importar persistence.ts solo para tomar prestado un tipo. usageEvaluable se deriva de responseVerdict por
// defecto (mismo criterio que ya usa el propio agregador vía deriveUsageEvaluable) — los overrides pueden
// pisarlo explícitamente cuando un test necesita divergir de la derivación (ver test 36).
function episode(overrides: Partial<DefensiveEpisodeKpiEpisodeInput> = {}): DefensiveEpisodeKpiEpisodeInput {
  const responseVerdict = overrides.responseVerdict ?? 'missed_ready';
  return {
    episodeId: 'heuristic:abc',
    usageEngaged: false,
    usageEvaluable: deriveUsageEvaluable(responseVerdict),
    responseVerdict,
    ...overrides,
  };
}

describe('deriveUsageEvaluable — exact truth table (test 35)', () => {
  const table: Array<[ResponseVerdict, boolean]> = [
    ['covered_verified', true],
    ['missed_ready', true],
    ['missed_due_to_mistime', true],
    ['unavailable_legitimate', false],
    ['no_applicable_resource', false],
    ['uncertain', false],
    ['excluded', false],
  ];
  for (const [verdict, expected] of table) {
    it(`${verdict} → ${expected}`, () => expect(deriveUsageEvaluable(verdict)).toBe(expected));
  }
});

describe('deriveDefensiveEpisodeKpiContribution', () => {
  it('usageEngaged is preserved independently of usageEvaluable (test 36)', () => {
    const covered = deriveDefensiveEpisodeKpiContribution(episode({ usageEngaged: true, responseVerdict: 'covered_verified' }));
    expect(covered.usageEngaged).toBe(true);
    expect(covered.usageEvaluable).toBe(true);

    const missedNothingUsed = deriveDefensiveEpisodeKpiContribution(episode({ usageEngaged: false, responseVerdict: 'missed_ready' }));
    expect(missedNothingUsed.usageEngaged).toBe(false);
    expect(missedNothingUsed.usageEvaluable).toBe(true);

    const missedWrongToolUsed = deriveDefensiveEpisodeKpiContribution(episode({ usageEngaged: true, responseVerdict: 'missed_ready' }));
    expect(missedWrongToolUsed.usageEngaged).toBe(true);
    expect(missedWrongToolUsed.usageEvaluable).toBe(true);

    const uncertainWithRealCast = deriveDefensiveEpisodeKpiContribution(episode({ usageEngaged: true, responseVerdict: 'uncertain' }));
    expect(uncertainWithRealCast.usageEngaged).toBe(true); // preservado en evidencia
    expect(uncertainWithRealCast.usageEvaluable).toBe(false); // pero no evaluable
  });

  it('covered/missedReady/missedMistimed reflect responseVerdict exactly (test 38 building blocks)', () => {
    expect(deriveDefensiveEpisodeKpiContribution(episode({ responseVerdict: 'covered_verified' })).covered).toBe(true);
    expect(deriveDefensiveEpisodeKpiContribution(episode({ responseVerdict: 'missed_ready' })).missedReady).toBe(true);
    expect(deriveDefensiveEpisodeKpiContribution(episode({ responseVerdict: 'missed_due_to_mistime' })).missedMistimed).toBe(true);
  });
});

describe('aggregateDefensiveEpisodeKpis', () => {
  it('one episode contributes at most 1 to Usage numerator/denominator regardless of internal cast count (test 37 — casts are not counted, episodes are)', () => {
    const aggregate = aggregateDefensiveEpisodeKpis([episode({ usageEngaged: true, responseVerdict: 'covered_verified' })]);
    expect(aggregate.usage.engaged).toBe(1);
    expect(aggregate.usage.evaluable).toBe(1);
  });

  it('Response formula is EXACTLY covered / (covered + missedReady + missedMistimed) — no weights, no severity/death multiplier, no partial credit (test 38)', () => {
    const aggregate = aggregateDefensiveEpisodeKpis([
      episode({ responseVerdict: 'covered_verified' }),
      episode({ responseVerdict: 'covered_verified' }),
      episode({ responseVerdict: 'missed_ready' }),
      episode({ responseVerdict: 'missed_due_to_mistime' }),
    ]);
    expect(aggregate.response.covered).toBe(2);
    expect(aggregate.response.missedReady).toBe(1);
    expect(aggregate.response.missedMistimed).toBe(1);
    expect(aggregate.response.evaluable).toBe(4);
    expect(aggregate.response.score).toBeCloseTo((2 / 4) * 100, 5);
  });

  it('zero denominator → score null, status insufficient_evidence — never a fabricated 0% (test 39)', () => {
    const aggregate = aggregateDefensiveEpisodeKpis([
      episode({ responseVerdict: 'unavailable_legitimate' }),
      episode({ responseVerdict: 'no_applicable_resource' }),
      episode({ responseVerdict: 'uncertain' }),
      episode({ responseVerdict: 'excluded' }),
    ]);
    expect(aggregate.usage.score).toBeNull();
    expect(aggregate.usage.status).toBe('insufficient_evidence');
    expect(aggregate.response.score).toBeNull();
    expect(aggregate.response.status).toBe('insufficient_evidence');
    expect(aggregate.unavailableLegitimate).toBe(1);
    expect(aggregate.noApplicableResource).toBe(1);
    expect(aggregate.uncertain).toBe(1);
    expect(aggregate.excluded).toBe(1);
  });

  it('an empty episode list also yields null scores, never 0%', () => {
    const aggregate = aggregateDefensiveEpisodeKpis([]);
    expect(aggregate.totalEpisodes).toBe(0);
    expect(aggregate.usage.score).toBeNull();
    expect(aggregate.response.score).toBeNull();
  });

  it('scores are 0..100 percent, rounded to 2 decimals', () => {
    const aggregate = aggregateDefensiveEpisodeKpis([
      episode({ responseVerdict: 'covered_verified' }),
      episode({ responseVerdict: 'missed_ready' }),
      episode({ responseVerdict: 'missed_ready' }),
    ]);
    expect(aggregate.response.score).toBeGreaterThanOrEqual(0);
    expect(aggregate.response.score).toBeLessThanOrEqual(100);
    expect(aggregate.response.score).toBeCloseTo((1 / 3) * 100, 2);
  });
});
