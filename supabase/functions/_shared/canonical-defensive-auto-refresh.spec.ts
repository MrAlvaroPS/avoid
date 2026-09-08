import { describe, expect, it } from 'vitest';
import {
  CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION,
  canonicalRefreshStepsForInvocation,
} from './canonical-defensive-auto-refresh';

describe('canonical defensive auto refresh policy', () => {
  it('keeps each invocation bounded so long raids are chained instead of processed in one timeout-prone request', () => {
    expect(CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION).toBe(2);
    expect(canonicalRefreshStepsForInvocation(999)).toBe(3);
    expect(canonicalRefreshStepsForInvocation(0)).toBe(1);
    expect(canonicalRefreshStepsForInvocation(Number.NaN)).toBe(2);
  });

  it('normalizes fractional and negative configuration without allowing an unbounded batch', () => {
    expect(canonicalRefreshStepsForInvocation(2.9)).toBe(2);
    expect(canonicalRefreshStepsForInvocation(-10)).toBe(1);
    expect(canonicalRefreshStepsForInvocation(Number.POSITIVE_INFINITY)).toBe(2);
  });
});
