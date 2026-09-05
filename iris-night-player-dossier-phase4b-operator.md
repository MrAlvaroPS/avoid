# IRIS — Night Player Dossier Phase 4B causal operator

## Purpose

Phase 4A established a fail-closed read/audit layer for mechanic attribution and deaths. Phase 4B adds the minimum operational surface needed to drive the **existing** causal materialization pipeline without creating a second queue, evaluator or scoring path.

This block does not declare the remote E2E accepted by itself. It makes that E2E executable and observable by an authenticated officer while keeping product claims gated by Phase 4A.

## Security boundary

The database RPC `enqueue_combat_evaluation_jobs` remains revoked from `authenticated` and executable only by `service_role`.

A new Edge Function, `enqueue-causal-backfill`, is the only new write doorway. It:

- requires a real logged-in officer through `requireOfficer`;
- validates `reportCode`, `playerName` and requested pull IDs;
- confirms every pull belongs to the report, is not ninja-excluded and has a real `player_pull_records` row for that player;
- reads the current causal queue before enqueueing;
- uses the existing shared `enqueueCombatEvaluation()` helper and the existing `full_execution_backfill` job type;
- never grants the browser direct RPC access.

## Conservative enqueue planner

`planCausalBackfill()` classifies target pulls as:

- `alreadyComplete`: existing completed full marker with no newer invalidation known to the planner;
- `deferred`: a causal job is currently queued/running, so the operator does not race it;
- `blocked`: a non-full invalidation ended in error and requires attention;
- `enqueue`: missing/stale/failed full backfill may be enqueued/retried.

The planner is operational only. It does **not** decide whether dossier evidence is canonical. The Phase 4A read-model independently re-checks full coverage, staleness and source-version homogeneity before publishing mechanic/death totals.

## Existing processor reused

The Angular operator never implements stages itself. `processBatch()` performs bounded repeated calls to the already deployed `process-combat-evaluation-queue` Edge Function.

That processor remains the owner of:

`pull_context invalidation -> full_execution_backfill -> evaluate-mechanic-occurrences -> compute-responsibility-edges -> evaluate-defensive-execution -> materialize-execution-ledger -> materialize-consumable-execution`

The processor claims the **global causal queue**, deliberately. The dossier does not create a player/report-specific queue that could diverge from the system queue.

## Audit-shell operator

The new Phase 4B surface exposes:

- target pull count from the canonical Pull Ledger population;
- queue markers by status;
- missing full-backfill markers;
- explicit enqueue/repair action;
- bounded “process up to 10 jobs” action;
- job type/status/attempt/error details;
- explicit warning that a `full done` marker is operational and does not bypass the canonical Phase 4A gate.

After queue changes the mechanic/death audit component receives a refresh token and rereads the canonical state instead of mutating its own metrics locally.

## Runtime gate expansion

`verify:causal-runtime` now checks `enqueue-causal-backfill` and executes the Deno suite for the queue planner. This is a permanent validation change, not a temporary CI branch trigger.

## Deployment / acceptance boundary

This PR must not deploy the new Edge Function to production independently of the integration strategy. Until the integration branch is deployed in an environment where the officer session can invoke it, the production queue remains unchanged.

Remote Phase 4 acceptance still requires:

1. run the operator against a controlled report corpus;
2. drain/process the causal jobs;
3. demonstrate fresh complete backfill for every target pull;
4. verify occurrences -> responsibility edges -> execution ledger;
5. verify homogeneous versions and zero punitive fallback/uncertain rows;
6. compare legacy original -> Attribution Safety v1 -> causal v3;
7. explain every new punitive causal attribution with explicit trusted responsibility evidence.

Phase 5 remains blocked until these runtime checks are accepted.
