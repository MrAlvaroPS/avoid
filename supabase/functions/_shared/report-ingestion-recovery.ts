export type PullIngestionStatus = 'processing' | 'complete' | 'failed';

export type PullIngestionRecoveryAction =
  | 'create'
  | 'reuse_complete'
  | 'replace_incomplete'
  | 'wait_for_in_progress';

export const PULL_INGESTION_STALE_AFTER_MS = 15 * 60 * 1000;

export function pullIngestionRecoveryAction(
  existing: { ingestion_status?: string | null; created_at?: string | null } | null,
  nowMs = Date.now(),
  staleAfterMs = PULL_INGESTION_STALE_AFTER_MS,
): PullIngestionRecoveryAction {
  if (!existing) return 'create';
  if (existing.ingestion_status === 'complete') return 'reuse_complete';
  if (existing.ingestion_status !== 'processing') return 'replace_incomplete';

  const startedAtMs = Date.parse(existing.created_at ?? '');
  if (!Number.isFinite(startedAtMs)) return 'wait_for_in_progress';
  return nowMs - startedAtMs >= staleAfterMs ? 'replace_incomplete' : 'wait_for_in_progress';
}
