import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const migrationPath = join(
  root,
  'supabase',
  'migrations',
  '20260908220000_canonical_defensive_auto_refresh.sql',
);
const recoveryMigrationPath = join(
  root,
  'supabase',
  'migrations',
  '20260908221000_canonical_defensive_auto_refresh_publish_recovery.sql',
);
const workerPath = join(
  root,
  'supabase',
  'functions',
  'canonical-defensive-auto-refresh',
  'index.ts',
);
const helperPath = join(
  root,
  'supabase',
  'functions',
  '_shared',
  'canonical-defensive-auto-refresh.ts',
);

const migration = readFileSync(migrationPath, 'utf8');
const recoveryMigration = readFileSync(recoveryMigrationPath, 'utf8');
const worker = readFileSync(workerPath, 'utf8');
const helper = readFileSync(helperPath, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Trigger/completion contract: manual imports are identified by real encounter
// completion, never by the unreliable reports.is_raid metadata flag.
assert(
  migration.includes('r.last_processed_fight_id >= max(e.fight_id)'),
  'canonical refresh does not wait for the final report encounter',
);
assert(
  !migration.includes('r.is_raid is true'),
  'canonical refresh incorrectly depends on reports.is_raid',
);
assert(
  migration.includes('reports_canonical_defensive_auto_refresh'),
  'reports completion trigger is missing',
);
assert(
  migration.includes('report_encounters_canonical_defensive_auto_refresh'),
  'report_encounters safety trigger is missing',
);

// Durable/serialized processing contract.
for (const required of [
  'canonical_defensive_refresh_requests',
  'canonical_defensive_refresh_dispatch_runtime',
  "pg_advisory_xact_lock(hashtext('iris:canonical-defensive-auto-refresh:claim'))",
  "now() + interval '5 minutes'",
  'fail_canonical_defensive_refresh_request',
  "current_attempts < 5",
  'net.http_post(',
  'x-iris-dispatch-token',
]) {
  assert(migration.includes(required), `migration is missing required contract: ${required}`);
}

// The existing canonical lifecycle remains the publication authority. The base
// migration must enqueue/dispatch only; it must not write the pointer directly.
assert(
  !migration.includes('set published_generation_id ='),
  'auto-refresh migration bypasses canonical publication guards',
);

// Production hardening: if the worker fails after the BUILDING generation is
// already exhaustively complete, the failure path must recover through the
// existing guarded publication RPC instead of exhausting retries and leaving a
// complete generation stranded forever.
for (const required of [
  'defensive_generation_coverage(current_generation_id)',
  "(generation_coverage ->> 'complete')::boolean",
  'publish_complete_defensive_generation(current_generation_id)',
  "status = 'completed'",
  "'recoveredPublished', true",
]) {
  assert(
    recoveryMigration.includes(required),
    `complete-generation recovery is missing required contract: ${required}`,
  );
}
assert(
  !recoveryMigration.includes('set published_generation_id ='),
  'recovery bypasses canonical publication guards instead of using the guarded RPC',
);
assert(
  recoveryMigration.includes('current_attempts < 5'),
  'incomplete-generation failures lost their bounded retry policy',
);

// Edge worker processes a bounded number of pulls, then continues with a fresh
// invocation. It must use the DB lease before every continuation.
for (const required of [
  "CANONICAL_WORKER_SLUG = 'canonical-defensive-refresh'",
  "action: 'start'",
  "action: 'process'",
  "action: 'continue'",
  'renew_canonical_defensive_refresh_lease',
  'bind_canonical_defensive_refresh_generation',
  'complete_canonical_defensive_refresh_request',
  'fail_canonical_defensive_refresh_request',
  'block_canonical_defensive_refresh_request',
  'x-iris-dispatch-token',
]) {
  assert(worker.includes(required), `dispatcher is missing required contract: ${required}`);
}
assert(
  worker.includes('canonicalRefreshStepsForInvocation()'),
  'dispatcher does not bound work per Edge invocation',
);

// Retry/backoff has one source of truth: SQL. Do not reintroduce a second retry
// policy in TypeScript.
assert(
  !helper.includes('MAX_ATTEMPTS') && !helper.includes('retryDecision'),
  'retry policy is duplicated outside the durable SQL queue',
);

console.log('canonical defensive auto-refresh contract: OK');
