export type CausalQueueJobType =
  | 'pull_context'
  | 'mechanic_policy'
  | 'mechanic_assignment'
  | 'consumable_policy'
  | 'full_execution_backfill';

export type CausalQueueJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface CausalQueueJobSnapshot {
  pullId: string;
  jobType: CausalQueueJobType;
  status: CausalQueueJobStatus;
  updatedAt: string;
  lastError?: string | null;
}

export interface CausalBackfillPlan {
  enqueuePullIds: string[];
  alreadyCompletePullIds: string[];
  deferredPullIds: string[];
  blockedPullIds: string[];
  reasons: Record<string, string>;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function newer(left: CausalQueueJobSnapshot, right: CausalQueueJobSnapshot): boolean {
  const leftMs = timestamp(left.updatedAt);
  const rightMs = timestamp(right.updatedAt);
  return leftMs != null && rightMs != null && leftMs > rightMs;
}

/**
 * Conservative planner for the existing causal queue.
 *
 * It never declares product truth. It only decides whether an officer action
 * may safely enqueue/retry the already-existing `full_execution_backfill` job.
 * Canonical completeness remains owned by the dossier read-model.
 */
export function planCausalBackfill(
  targetPullIds: readonly string[],
  jobs: readonly CausalQueueJobSnapshot[],
): CausalBackfillPlan {
  const uniquePullIds = [...new Set(targetPullIds.filter(Boolean))];
  const jobsByPull = new Map<string, CausalQueueJobSnapshot[]>();
  for (const job of jobs) {
    if (!uniquePullIds.includes(job.pullId)) continue;
    const list = jobsByPull.get(job.pullId) ?? [];
    list.push(job);
    jobsByPull.set(job.pullId, list);
  }

  const enqueuePullIds: string[] = [];
  const alreadyCompletePullIds: string[] = [];
  const deferredPullIds: string[] = [];
  const blockedPullIds: string[] = [];
  const reasons: Record<string, string> = {};

  for (const pullId of uniquePullIds) {
    const pullJobs = jobsByPull.get(pullId) ?? [];
    const full = pullJobs.find((job) => job.jobType === 'full_execution_backfill');
    const invalidations = pullJobs.filter((job) => job.jobType !== 'full_execution_backfill');

    const pending = pullJobs.find((job) => job.status === 'queued' || job.status === 'running');
    if (pending) {
      deferredPullIds.push(pullId);
      reasons[pullId] = `${pending.jobType}:${pending.status}`;
      continue;
    }

    const invalidationError = invalidations.find((job) => job.status === 'error');
    if (invalidationError) {
      blockedPullIds.push(pullId);
      reasons[pullId] = `${invalidationError.jobType}:error${invalidationError.lastError ? `:${invalidationError.lastError}` : ''}`;
      continue;
    }

    const newerInvalidation =
      full?.status === 'done' && invalidations.some((job) => job.status === 'done' && newer(job, full));

    if (full?.status === 'done' && !newerInvalidation) {
      alreadyCompletePullIds.push(pullId);
      reasons[pullId] = 'full_execution_backfill:done:fresh';
      continue;
    }

    enqueuePullIds.push(pullId);
    reasons[pullId] = newerInvalidation
      ? 'full_execution_backfill:stale_after_invalidation'
      : full?.status === 'error'
        ? 'full_execution_backfill:retry_error'
        : 'full_execution_backfill:missing';
  }

  return {
    enqueuePullIds,
    alreadyCompletePullIds,
    deferredPullIds,
    blockedPullIds,
    reasons,
  };
}
