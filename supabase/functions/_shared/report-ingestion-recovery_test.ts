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

Deno.test('replaces failed and stale processing pulls instead of accepting partial evidence', () => {
  const now = Date.parse('2026-09-03T12:30:00.000Z');
  assertEquals(pullIngestionRecoveryAction({ ingestion_status: 'failed' }), 'replace_incomplete');
  assertEquals(pullIngestionRecoveryAction({ ingestion_status: null }), 'replace_incomplete');
  assertEquals(
    pullIngestionRecoveryAction(
      { ingestion_status: 'processing', created_at: '2026-09-03T12:00:00.000Z' },
      now,
    ),
    'replace_incomplete',
  );
});

Deno.test('does not delete another live ingestion of the same fight', () => {
  const now = Date.parse('2026-09-03T12:05:00.000Z');
  assertEquals(
    pullIngestionRecoveryAction(
      { ingestion_status: 'processing', created_at: '2026-09-03T12:00:00.000Z' },
      now,
    ),
    'wait_for_in_progress',
  );
  assertEquals(
    pullIngestionRecoveryAction({ ingestion_status: 'processing', created_at: null }, now),
    'wait_for_in_progress',
  );
});
