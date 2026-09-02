import { pullIngestionRecoveryAction } from './report-ingestion-recovery.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

Deno.test('creates a pull only when the fight has no persisted row', () => {
  assertEquals(pullIngestionRecoveryAction(null), 'create');
});

Deno.test('reuses a completed pull when only the report cursor is stale', () => {
  assertEquals(pullIngestionRecoveryAction({ ingestion_status: 'complete' }), 'reuse_complete');
});

Deno.test('replaces processing and failed pulls instead of accepting partial evidence', () => {
  assertEquals(pullIngestionRecoveryAction({ ingestion_status: 'processing' }), 'replace_incomplete');
  assertEquals(pullIngestionRecoveryAction({ ingestion_status: 'failed' }), 'replace_incomplete');
  assertEquals(pullIngestionRecoveryAction({ ingestion_status: null }), 'replace_incomplete');
});
