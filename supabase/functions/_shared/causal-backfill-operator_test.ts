import { assertEquals } from 'jsr:@std/assert@1';
import { planCausalBackfill, type CausalQueueJobSnapshot } from './causal-backfill-operator.ts';

function job(
  pullId: string,
  jobType: CausalQueueJobSnapshot['jobType'],
  status: CausalQueueJobSnapshot['status'],
  updatedAt: string,
): CausalQueueJobSnapshot {
  return { pullId, jobType, status, updatedAt, lastError: status === 'error' ? 'fixture' : null };
}

Deno.test('missing full backfill is enqueueable', () => {
  const plan = planCausalBackfill(['p1'], []);
  assertEquals(plan.enqueuePullIds, ['p1']);
  assertEquals(plan.alreadyCompletePullIds, []);
});

Deno.test('fresh completed full backfill is not enqueued again', () => {
  const plan = planCausalBackfill([
    'p1',
  ], [job('p1', 'full_execution_backfill', 'done', '2026-09-05T20:00:00Z')]);
  assertEquals(plan.alreadyCompletePullIds, ['p1']);
  assertEquals(plan.enqueuePullIds, []);
});

Deno.test('pending invalidation defers rather than racing a full backfill', () => {
  const plan = planCausalBackfill(['p1'], [
    job('p1', 'full_execution_backfill', 'done', '2026-09-05T20:00:00Z'),
    job('p1', 'pull_context', 'queued', '2026-09-05T20:05:00Z'),
  ]);
  assertEquals(plan.deferredPullIds, ['p1']);
  assertEquals(plan.enqueuePullIds, []);
});

Deno.test('newer completed invalidation makes old full backfill repairable', () => {
  const plan = planCausalBackfill(['p1'], [
    job('p1', 'full_execution_backfill', 'done', '2026-09-05T20:00:00Z'),
    job('p1', 'mechanic_policy', 'done', '2026-09-05T20:05:00Z'),
  ]);
  assertEquals(plan.enqueuePullIds, ['p1']);
  assertEquals(plan.reasons['p1'], 'full_execution_backfill:stale_after_invalidation');
});

Deno.test('failed invalidation blocks a blind retry', () => {
  const plan = planCausalBackfill(['p1'], [
    job('p1', 'mechanic_assignment', 'error', '2026-09-05T20:05:00Z'),
  ]);
  assertEquals(plan.blockedPullIds, ['p1']);
  assertEquals(plan.enqueuePullIds, []);
});

Deno.test('failed full backfill may be explicitly retried', () => {
  const plan = planCausalBackfill(['p1'], [
    job('p1', 'full_execution_backfill', 'error', '2026-09-05T20:00:00Z'),
  ]);
  assertEquals(plan.enqueuePullIds, ['p1']);
  assertEquals(plan.reasons['p1'], 'full_execution_backfill:retry_error');
});
