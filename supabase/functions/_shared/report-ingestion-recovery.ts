export type PullIngestionStatus = 'processing' | 'complete' | 'failed';

export type PullIngestionRecoveryAction = 'create' | 'reuse_complete' | 'replace_incomplete';

export function pullIngestionRecoveryAction(
  existing: { ingestion_status?: string | null } | null,
): PullIngestionRecoveryAction {
  if (!existing) return 'create';
  return existing.ingestion_status === 'complete' ? 'reuse_complete' : 'replace_incomplete';
}
