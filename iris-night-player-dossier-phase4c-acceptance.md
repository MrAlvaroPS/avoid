# IRIS — Night Player Dossier Phase 4C causal acceptance gate

## Purpose

Phase 4C turns the causal rollout acceptance criteria into a reproducible read-only checklist. It does not materialize data, modify scoring, publish a cutover or reinterpret evidence. Its purpose is to prevent an officer from treating “some causal rows exist” as proof that the pipeline is ready.

The maximum automatic state is deliberately `ready_for_manual_comparison`, never `accepted`.

## Inputs

The acceptance report composes only existing causal authorities:

- Phase 4A `NightPlayerMechanicDeathAuditService` for fresh materialization coverage and integrity;
- `mechanic_occurrence_evaluations` for occurrence outcome/confidence/version identity;
- `mechanic_responsibility_edges` for player ownership and penalty eligibility;
- `player_execution_events` with `domain=mechanic` for final player decisions.

No `NightPlayerSummary.mechanicFails`, `NightDeathRow`, `player_hit_details` attribution or Reliability score is used as truth.

## Automatic checks

The report evaluates:

1. **Fresh-complete materialization** — every valid participated pull must satisfy the Phase 4A gate.
2. **Read-model integrity** — no unresolved evidence/integrity issue may remain after complete materialization.
3. **Version homogeneity** — one context resolver, one occurrence resolver and one execution-ledger evaluator in the inspected scope.
4. **Occurrence observability** — a completely materialized scope with zero occurrences is a warning that requires corpus review, not an automatic failure or automatic proof of zero mechanics.
5. **Trusted punitive events** — no penalty-eligible mechanic ledger event may use `fallback` or `uncertain` confidence.
6. **Occurrence linkage** — every punitive mechanic event must have `occurrence_id`.
7. **Trusted ownership edge** — every punitive mechanic event must have a matching `penalty_eligible` responsibility edge for the same player + occurrence with relationship `primary_owner`, `co_owner` or `assigned_resolver` and confidence `verified|inferred`.
8. **No collateral blame** — `collateral_victim` can never be penalty eligible.
9. **Trusted punitive edges** — no penalty edge may use fallback/uncertain confidence.
10. **Primary penalty ownership** — every `primary_penalty` event must have a matching `primary_owner` edge.
11. **Offense-view consistency** — after complete materialization, `player_mechanic_offenses_v3` must represent the same punitive mechanic population visible in the raw execution ledger for the player scope.

A hard failure in any automatic invariant blocks the cutover. A pending automatic prerequisite also keeps the state blocked. Warnings are visible but do not by themselves convert the state to fail.

## Mandatory manual gate — PR #17

Even when every automatic check passes, Phase 4C reports only:

`ready_for_manual_comparison`

The remaining required comparison is:

`legacy original -> Attribution Safety v1 (#17) -> causal v3`

Attribution Safety v1 is not promoted to canonical truth. It is a conservative safety baseline. Causal v3 is allowed to identify responsibility that v1 intentionally leaves unresolved, but every additional punitive attribution must be explained by explicit trusted causal ownership evidence.

Receiving mechanic damage or appearing in `player_hit_details` is never sufficient justification.

## Why this gate is separate from Execution

Phase 4C audits whether mechanic attribution evidence is safe enough to consume. It does **not** calculate the Phase 6 Execution KPI and does not activate Reliability. Those consumers remain blocked until their own approved phases.

## Runtime/deployment boundary

The integration branch has not been promoted to the final target yet, so the Phase 4B operator/new enqueue endpoint has not been deployed or executed against production from this workstream. Therefore this checklist cannot legitimately be called “accepted” against live data yet.

Once the integration build is deployed in an officer-capable environment:

1. operate the canonical queue through Phase 4B;
2. wait until Phase 4A reports fresh-complete materialization;
3. require Phase 4C automatic checks to reach `ready_for_manual_comparison`;
4. perform and record the PR #17 comparison;
5. explain/correct every meaningful divergence;
6. only then close Phase 4 and unblock Phase 5.

## Non-goals

- no writes;
- no queue processing;
- no schema changes;
- no new metric formula;
- no score or Reliability change;
- no automatic cutover flag;
- no inference from missing rows;
- no replacement for human review of new punitive attribution.
