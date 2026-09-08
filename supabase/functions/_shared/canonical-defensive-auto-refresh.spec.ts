import { describe, expect, it } from 'vitest';
import {
  CANONICAL_REFRESH_MAX_ATTEMPTS,
  CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION,
  canonicalRefreshRetryDecision,
  canonicalRefreshStepsForInvocation,
} from './canonical-defensive-auto-refresh';

describe('canonical defensive auto refresh policy', () => {
  it('keeps each invocation bounded so long raids are chained instead of processed in one timeout-prone request', () => {
    expect(CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION).toBe(2);
    expect(canonicalRefreshStepsForInvocation(999)).toBe(3);
    expect(canonicalRefreshStepsForInvocation(0)).toBe(1);
    expect(canonicalRefreshStepsForInvocation(Number.NaN)).toBe(2);
  });

  it('retries transient failures with bounded exponential backoff', () => {
    expect(canonicalRefreshRetryDecision(1)).toEqual({ retry: true, delaySeconds: 4 });
    expect(canonicalRefreshRetryDecision(2)).toEqual({ retry: true, delaySeconds: 8 });
    expect(canonicalRefreshRetryDecision(4)).toEqual({ retry: true, delaySeconds: 32 });
  });

  it('fails closed after the durable retry budget instead of hammering WCL forever', () => {
    expect(CANONICAL_REFRESH_MAX_ATTEMPTS).toBe(5);
    expect(canonicalRefreshRetryDecision(5)).toEqual({ retry: false, delaySeconds: 0 });
    expect(canonicalRefreshRetryDecision(20)).toEqual({ retry: false, delaySeconds: 0 });
  });
});
