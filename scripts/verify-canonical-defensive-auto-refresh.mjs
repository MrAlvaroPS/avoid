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
const resumeMigrationPath = join(
  root,
  'supabase',
  'migrations',
  '20260908222000_canonical_defensive_auto_refresh_resume.sql',
);
const contractUpgradeMigrationPath = join(
  root,
  'supabase',
  'migrations',
  '20260910001000_canonical_defensive_contract_upgrade_recovery.sql',
);
const leaseQualificationMigrationPath = join(
  root,
  'supabase',
  'migrations',
  '20260910075357_canonical_defensive_resume_lease_qualification.sql',
);
const gatewayAuthMigrationPath = join(
  root,
  'supabase',
  'migrations',
  '20260910105836_canonical_defensive_dispatch_gateway_auth.sql',
);
const coverageOptimizationMigrationPath = join(
  root,
  'supabase',
  'migrations',
  '20260910111440_optimize_defensive_generation_coverage.sql',
);
const expiredLeaseMigrationPath = join(
  root,
  'supabase',
  'migrations',
  '20260910112058_harden_canonical_defensive_expired_lease.sql',
);
const workerPath = join(
  root,
  'supabase',
  'functions',
  'canonical-defensive-auto-refresh',
  'index.ts',
);
const canonicalWorkerPath = join(
  root,
  'supabase',
  'functions',
  'canonical-defensive-refresh',
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
const resumeMigration = readFileSync(resumeMigrationPath, 'utf8');
const contractUpgradeMigration = readFileSync(contractUpgradeMigrationPath, 'utf8');
const leaseQualificationMigration = readFileSync(leaseQualificationMigrationPath, 'utf8');
const gatewayAuthMigration = readFileSync(gatewayAuthMigrationPath, 'utf8');
const coverageOptimizationMigration = readFileSync(coverageOptimizationMigrationPath, 'utf8');
const expiredLeaseMigration = readFileSync(expiredLeaseMigrationPath, 'utf8');
const worker = readFileSync(workerPath, 'utf8');
const canonicalWorker = readFileSync(canonicalWorkerPath, 'utf8');
const canonicalWorkerStart = canonicalWorker.slice(
  canonicalWorker.indexOf('async function start('),
  canonicalWorker.indexOf('async function processOne('),
);
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
  'current_attempts < 5',
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

// A transient failure/expired lease must resume the same BUILDING generation.
// Otherwise a timeout late in a report throws away all already-completed pulls
// and replays the whole report on every retry.
for (const required of [
  'is_dispatch_resume boolean := false',
  "q.status = 'running'",
  'q.generation_id = existing_id',
  'if not is_dispatch_resume then',
  'lease_generation_id = selected.generation_id',
  'generation_id = current_generation_id',
]) {
  assert(
    resumeMigration.includes(required),
    `resume hardening is missing required contract: ${required}`,
  );
}
assert(
  !resumeMigration.includes('generation_id = null,\n        not_before = now()'),
  'expired leases still discard their BUILDING generation',
);
assert(
  resumeMigration.includes('publish_complete_defensive_generation(current_generation_id)'),
  'resume migration accidentally dropped complete-generation recovery',
);

// A private BUILDING generation from an older evaluator contract must not
// permanently block the currently deployed worker. Replacement is lease-aware,
// remains private, and publication still belongs exclusively to the exhaustive
// guarded RPC.
for (const required of [
  'begin_or_resume_canonical_defensive_refresh',
  "'retired_incompatible_building_generation'",
  'p_dispatch_lease_token',
  'conflicting_live_lease',
  "set status = 'failed'",
  "where q.status = 'blocked'",
  'canonical_defensive_report_needs_refresh(q.report_code)',
  'dispatch_canonical_defensive_refresh_async()',
]) {
  assert(
    contractUpgradeMigration.includes(required),
    `contract-upgrade recovery is missing required contract: ${required}`,
  );
}
assert(
  !contractUpgradeMigration.includes('set published_generation_id ='),
  'contract-upgrade recovery bypasses guarded canonical publication',
);
assert(
  !contractUpgradeMigration.includes('q.generation_id is not null'),
  'one-time recovery can retire a build during the legacy start-to-bind lease gap',
);
assert(
  contractUpgradeMigration.includes('from canonical_defensive_refresh_dispatch_runtime r'),
  'one-time recovery does not protect an active dispatcher runtime lease',
);

// The resume claim must qualify the shared lease_token name. PostgreSQL treats
// the RETURNS TABLE output column as a PL/pgSQL variable; leaving the UPDATE
// predicate unqualified fails at runtime with SQLSTATE 42702.
for (const required of [
  'q.lease_token = runtime.lease_token',
  'lease_generation_id = selected.generation_id',
  'for update skip locked',
  'grant execute on function claim_canonical_defensive_refresh_request()',
]) {
  assert(
    leaseQualificationMigration.includes(required),
    `lease qualification recovery is missing required contract: ${required}`,
  );
}
assert(
  !leaseQualificationMigration.includes('set published_generation_id ='),
  'lease qualification recovery bypasses guarded canonical publication',
);

for (const required of [
  "s.name = 'canonical_defensive_dispatch_gateway_jwt'",
  "'authorization', 'Bearer ' || gateway_jwt",
  "'apikey', gateway_jwt",
  "'x-iris-dispatch-token', token::text",
]) {
  assert(
    gatewayAuthMigration.includes(required),
    `gateway-authenticated DB wake-up is missing required contract: ${required}`,
  );
}
assert(
  !gatewayAuthMigration.includes('set published_generation_id ='),
  'gateway authentication migration bypasses guarded canonical publication',
);

for (const required of [
  'with eligible as materialized',
  'safe_rows as materialized',
  'expected_keys as materialized',
  'actual_keys as materialized',
  'missing_player_rows = 0',
  'missing_ledger_events = 0',
  'orphan_ledger_events = 0',
]) {
  assert(
    coverageOptimizationMigration.includes(required),
    `optimized coverage dropped an exhaustive invariant: ${required}`,
  );
}

for (const required of [
  'fail_canonical_defensive_refresh_request(',
  "'dispatcher lease expired before completion'",
  'q.attempts < 5',
  'q.attempts >= 5',
  "status = 'blocked'",
]) {
  assert(
    expiredLeaseMigration.includes(required),
    `expired-lease claim is missing bounded recovery: ${required}`,
  );
}
assert(
  !expiredLeaseMigration.includes('set published_generation_id ='),
  'expired-lease recovery bypasses guarded canonical publication',
);

// Edge worker processes a bounded number of pulls, then continues with a fresh
// invocation. It must use the DB lease before every continuation.
for (const required of [
  "CANONICAL_WORKER_SLUG = 'canonical-defensive-refresh'",
  "action: 'start'",
  "action: 'process'",
  "action: 'execute'",
  "action: 'continue'",
  'renew_canonical_defensive_refresh_lease',
  'bind_canonical_defensive_refresh_generation',
  'complete_canonical_defensive_refresh_request',
  'fail_canonical_defensive_refresh_request',
  'block_canonical_defensive_refresh_request',
  'x-iris-dispatch-token',
  "Deno.env.get('SUPABASE_ANON_KEY')",
  'authorization: `Bearer ${gatewayKey}`',
  'body.includeCoverage !== false',
  ".eq('report_code', reportCode)",
]) {
  assert(worker.includes(required), `dispatcher is missing required contract: ${required}`);
}
assert(
  worker.includes('canonicalRefreshStepsForInvocation()'),
  'dispatcher does not bound work per Edge invocation',
);
assert(
  worker.includes("state: 'scheduled'")
    && worker.includes("{ action: 'execute', reportCode: claim.report_code, leaseToken: claim.lease_token }"),
  'database wake-up still performs heavy canonical work before returning to pg_net',
);
assert(
  worker.includes("{ action: 'start', reportCode, leaseToken }"),
  'dispatcher does not pass its lease into atomic generation start/binding',
);
for (const required of [
  ".select('generation_id')",
  "callCanonicalWorker({ action: 'health' })",
  'const contractMatches = generation',
  'processGeneration(client, reportCode, leaseToken, resumableGenerationId)',
]) {
  assert(
    worker.includes(required),
    `dispatcher cannot fast-resume a fully staged bound generation: ${required}`,
  );
}
assert(
  canonicalWorker.includes("'begin_or_resume_canonical_defensive_refresh'"),
  'canonical worker does not use the contract-upgrade-safe start RPC',
);
assert(
  !canonicalWorkerStart.includes('coverage: await coverage(client, generationId)'),
  'canonical worker can still lose a newly-created generation ID on an accessory coverage read',
);
assert(
  canonicalWorker.includes('describeUnknownError(error)'),
  'canonical worker still collapses structured PostgREST failures to [object Object]',
);

// Retry/backoff has one source of truth: SQL. Do not reintroduce a second retry
// policy in TypeScript.
assert(
  !helper.includes('MAX_ATTEMPTS') && !helper.includes('retryDecision'),
  'retry policy is duplicated outside the durable SQL queue',
);

console.log('canonical defensive auto-refresh contract: OK');
