# IRIS — Night Player Dossier Phase 4 causal gate

## Status

Phase 4A is implemented and validated as a fail-closed audit/read layer. It is not yet an accepted runtime cutover because the production causal materialization has not completed its E2E/backfill gate.

Branch: `feature/dossier-audit-p4-mechanics-deaths`
Base: `feature/dossier-audit-p1-contracts`

## Production state observed before implementation

Read-only production checks showed that the causal schema and Edge Functions are deployed, but the mechanic/death evidence required by the dossier is not yet materialized end-to-end:

- `mechanic_occurrence_evaluations`: 0 rows;
- `mechanic_responsibility_edges`: 0 rows;
- no observed `player_execution_events` in domains `mechanic` or `death` at the time of the check;
- `pull_evaluation_context`: 101 rows;
- `boss_mechanic_policy`: 674 rows;
- `boss_mechanic_aliases`: 674 rows;
- 13 `pull_context` combat-evaluation jobs remained queued, last updated 2026-09-02 22:50 UTC.

The relevant Edge Functions are ACTIVE, including `evaluate-mechanic-occurrences`, `compute-responsibility-edges`, `materialize-execution-ledger` and `process-combat-evaluation-queue`.

Therefore an empty causal result cannot currently be interpreted as zero incidents.

## Phase 4A read model

`NightPlayerMechanicDeathAuditService` consumes only the causal v3 path plus the existing auditable Pull Ledger:

`Pull Ledger -> combat_evaluation_jobs -> player_mechanic_offenses_v3 / player_execution_events(domain=death) -> audit projection`

It does not read `NightPlayerSummary.mechanicFails` or `NightDeathRow` as fallback truth.

### Claims

- `mechanics.actionableIncidents`: count of attributable mechanic offenses only after complete causal materialization.
- `deaths.total`: factual death-ledger count only after complete causal materialization. Cause, confidence and penalty eligibility remain separate facts.
- `mechanics.avoidableSuccess`: deliberately N/D. `player_mechanic_offenses_v3` contains attributable failures and does not define a homogeneous player-level success denominator.

### Completion gate

A pull is complete only when it has a fresh successful `full_execution_backfill` marker. A historical `done` marker is rejected if a newer or pending causal invalidation (`pull_context`, `mechanic_policy`, `mechanic_assignment`, etc.) exists for that pull.

Consequences:

- no backfill marker => unavailable/N-D, never zero;
- partial pull coverage => partial/N-D;
- mixed causal versions => incompatible/N-D;
- complete fresh coverage for every valid participated pull => zero may legitimately mean zero;
- a failed or stale job remains visible as an integrity issue.

This closes the race where an old completed backfill could otherwise be mistaken for current evidence immediately after `PullEvaluationContext` or another causal authority changed.

## Attribution Safety v1 / PR #17

PR #17 is not used as the canonical Phase 4 owner. It remains a conservative transition layer for legacy consumers.

However, its central safety property is now an explicit causal-v3 acceptance invariant:

> Receiving the consequence of a mechanic cannot by itself create player blame.

Regression `mechanic-attribution-causal-guard.spec.ts` verifies that the causal schema/materializer preserves this property:

- `collateral_victim` cannot be `penalty_eligible`;
- penalty-eligible responsibility edges are restricted to `primary_owner`, `co_owner` and `assigned_resolver`;
- `player_mechanic_offenses_v3` requires both an eligible responsibility edge and an eligible mechanic failure/miss ledger event;
- `primaryPenalty` is only created for `primary_owner`, not from a player-hit observation.

For the later remote E2E, the acceptance comparison is:

`legacy original -> Attribution Safety v1 -> causal v3`

Causal v3 may identify responsibility that v1 deliberately leaves unresolved, but every additional punitive attribution must have an explicit trusted responsibility edge. `player_hit_details` alone is never sufficient.

## Regression coverage

Phase 4A tests verify:

- no full backfill does not turn an empty table into zero incidents;
- only complete fresh backfill coverage permits canonical zero;
- an old `done` backfill plus a newer causal invalidation returns partial;
- partial coverage keeps totals null even when some rows exist;
- mixed source versions fail closed;
- attributable mechanic offenses preserve occurrence + execution evidence and exact boss-local pull/WCL identity;
- an `uncertain` death remains a factual death without being converted into player blame;
- repeated mechanic patterns are only produced under complete coverage;
- Avoidable Success is not fabricated from a failures-only view;
- causal ownership guards preserve the safety property learned from PR #17.

## Validation history

Initial Phase 4A gate before the freshness hardening passed.

A subsequent run (`33994325061`) failed only in the new Phase 4 fixture suite after `CombatBackfillJobFact` gained `job_type`; the fixtures still omitted that newly required discriminator, so intended full-backfill fixtures were correctly rejected by the stricter implementation. No product regression was found.

Fixtures were corrected and a dedicated stale-invalidation regression was added.

Final validation run `33994877346` on commit `02470ddecca05af82cc310896e029f6a15e84c35`: PASS.

Passed:

- Phase 4 mechanic/death audit tests;
- causal Attribution Safety acceptance guard;
- Phase 1/2/3 dossier regressions;
- Defensive E7 regressions;
- `npm run verify:defensive-contract`;
- `npm run verify:causal-schema`;
- `npm run verify:causal-runtime`;
- `npm run build`;
- final Deno checks.

The temporary Phase 4 workflow trigger/test list was restored after the PASS and is not intended to remain in the final PR diff.

## Phase 4B gate — required before Phase 5

Phase 5 must not start yet.

Phase 4B must close the remote materialization/E2E gate using the already existing causal queue and Edge Functions, not a parallel pipeline:

1. safely enqueue/rebuild the target canonical pull corpus;
2. process `pull_context` invalidations and subsequent `full_execution_backfill` jobs;
3. verify occurrences -> responsibility edges -> execution ledger per pull;
4. verify homogeneous versions and no fallback/uncertain punitive rows;
5. compare legacy original -> Attribution Safety v1 -> causal v3;
6. explain every meaningful divergence and require explicit trusted responsibility evidence for every new punitive attribution;
7. only then consider the mechanic/death claims runtime-accepted and move to Phase 5.
