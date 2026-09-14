import { describe, expect, it } from 'vitest';
import {
  nightInfographicSummaryReadinessError,
  type NightInfographicSummaryReadinessInput,
} from './night-infographic-readiness.util';

function readySummary(
  overrides: Partial<NightInfographicSummaryReadinessInput> = {},
): NightInfographicSummaryReadinessInput {
  return {
    playerName: 'Gusmi',
    pulls: [{}],
    nightScore: 87,
    nightReliability: { score: 91 },
    canonicalDefensive: {
      state: 'available',
      coverage: { evaluatedPulls: 6, expectedPulls: 6 },
      generation: { id: 'generation-v8' },
    },
    defensiveAudit: {
      state: 'available',
      metadata: { evaluatedPulls: 6, expectedPulls: 6 },
    },
    ...overrides,
  };
}

describe('night infographic readiness', () => {
  it('accepts a fully materialized summary even when a KPI can legitimately be N/D', () => {
    const summary = readySummary({
      canonicalDefensive: {
        state: 'available',
        coverage: { evaluatedPulls: 6, expectedPulls: 6 },
        generation: { id: 'generation-v8' },
      },
    });
    expect(nightInfographicSummaryReadinessError(summary)).toBeNull();
  });

  it('rejects partial canonical defensive coverage', () => {
    const summary = readySummary({
      canonicalDefensive: {
        state: 'partial',
        coverage: { evaluatedPulls: 4, expectedPulls: 6 },
        generation: { id: 'generation-v8' },
      },
    });
    expect(nightInfographicSummaryReadinessError(summary)).toContain('estado partial');
  });

  it('rejects a stale or partial audit even if the summary projection looks available', () => {
    const summary = readySummary({
      defensiveAudit: {
        state: 'available',
        metadata: { evaluatedPulls: 5, expectedPulls: 6 },
      },
    });
    expect(nightInfographicSummaryReadinessError(summary)).toContain('5/6');
  });

  it('rejects missing night-level KPI materialization for a player with pulls', () => {
    expect(nightInfographicSummaryReadinessError(readySummary({ nightReliability: null })))
      .toContain('fiabilidad');
  });
});
