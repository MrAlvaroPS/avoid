import { describe, expect, it } from 'vitest';
import {
  canPenalize,
  EXECUTION_REASON_CODES,
  getEvaluationCutoffMs,
  isEventEvaluable,
  isPullStatisticallyValid,
  type PullEvaluationContextContract,
} from '../../../supabase/functions/_shared/combat-evaluation-contract';

function context(overrides: Partial<PullEvaluationContextContract> = {}): PullEvaluationContextContract {
  return {
    pullId: 'pull-1',
    evaluationEligible: true,
    evaluationStartMs: 0,
    evaluationEndMs: 120_000,
    cutoffReason: 'wipe_call',
    wipeCallAtMs: 120_000,
    wipeCallBossHpPct: 42,
    wipeCallSource: 'manual_rl',
    wipeCallConfidence: 100,
    wipeCallVerified: true,
    ninjaStatus: 'valid',
    ninjaSource: 'manual',
    ninjaConfidence: 100,
    evidence: {},
    resolverVersion: 'pull-evaluation-context@1.0.0',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('combat evaluation contract', () => {
  it('uses one half-open interval for every event consumer', () => {
    const value = context();
    expect(isEventEvaluable(value, 0)).toBe(true);
    expect(isEventEvaluable(value, 119_999)).toBe(true);
    expect(isEventEvaluable(value, 120_000)).toBe(false);
    expect(getEvaluationCutoffMs(value)).toBe(120_000);
  });

  it('invalidates a confirmed ninja pull as one atomic scope', () => {
    const value = context({ evaluationEligible: false, cutoffReason: 'invalid_pull', ninjaStatus: 'confirmed' });
    expect(isPullStatisticallyValid(value)).toBe(false);
    expect(isEventEvaluable(value, 1)).toBe(false);
    expect(getEvaluationCutoffMs(value)).toBeNull();
  });

  it('never turns fallback or uncertain evidence into a penalty', () => {
    expect(canPenalize('verified', true)).toBe(true);
    expect(canPenalize('inferred', true)).toBe(true);
    expect(canPenalize('fallback', true)).toBe(false);
    expect(canPenalize('uncertain', true)).toBe(false);
  });

  it('publishes unique stable reason codes', () => {
    expect(new Set(EXECUTION_REASON_CODES).size).toBe(EXECUTION_REASON_CODES.length);
    expect(EXECUTION_REASON_CODES).toContain('SPREAD_CARRIER_COLLATERAL');
    expect(EXECUTION_REASON_CODES).toContain('VIABLE_CD_NON_PUNITIVE');
    expect(EXECUTION_REASON_CODES).toContain('AVAILABILITY_UNKNOWN');
  });
});
