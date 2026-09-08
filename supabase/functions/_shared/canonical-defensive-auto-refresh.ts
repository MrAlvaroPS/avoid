export const CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION = 2;
export const CANONICAL_REFRESH_MAX_ATTEMPTS = 5;
export const CANONICAL_REFRESH_MAX_RETRY_DELAY_SECONDS = 60;

export interface CanonicalRefreshRetryDecision {
  retry: boolean;
  delaySeconds: number;
}

/**
 * Pure retry policy shared by the dispatcher and its tests. Attempts are
 * 1-based because the DB increments the durable request before handing it to
 * the worker.
 */
export function canonicalRefreshRetryDecision(attempt: number): CanonicalRefreshRetryDecision {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  if (normalizedAttempt >= CANONICAL_REFRESH_MAX_ATTEMPTS) {
    return { retry: false, delaySeconds: 0 };
  }
  return {
    retry: true,
    delaySeconds: Math.min(
      CANONICAL_REFRESH_MAX_RETRY_DELAY_SECONDS,
      Math.max(2, 2 ** normalizedAttempt * 2),
    ),
  };
}

/**
 * One Edge invocation intentionally does only a small bounded amount of WCL
 * work. The continuation chain gives every pull a fresh function budget, so a
 * long raid cannot turn into one oversized request that times out halfway.
 */
export function canonicalRefreshStepsForInvocation(
  configured = CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION,
): number {
  if (!Number.isFinite(configured)) return CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION;
  return Math.max(1, Math.min(3, Math.trunc(configured)));
}
