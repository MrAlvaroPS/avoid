export const CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION = 2;

/**
 * One Edge invocation intentionally does only a small bounded amount of WCL
 * work. The continuation chain gives every pull a fresh function budget, so a
 * long raid cannot turn into one oversized request that times out halfway.
 *
 * Retry/backoff policy intentionally does NOT live here. It is persisted and
 * calculated exclusively by fail_canonical_defensive_refresh_request() in SQL,
 * so there cannot be a frontend/worker copy of the retry truth drifting away
 * from the durable queue state.
 */
export function canonicalRefreshStepsForInvocation(
  configured = CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION,
): number {
  if (!Number.isFinite(configured)) return CANONICAL_REFRESH_PROCESS_STEPS_PER_INVOCATION;
  return Math.max(1, Math.min(3, Math.trunc(configured)));
}
