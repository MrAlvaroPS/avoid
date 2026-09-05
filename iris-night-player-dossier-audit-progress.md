# IRIS — Night Player Dossier Audit implementation progress

## Source plan and sequencing

This file tracks implementation of the approved Night Player Dossier audit plan.
The order is fixed and must not be bypassed by later PRs:

1. TruthClaim / EvidenceRef contract, exact WCL helper, canonical pull identity, new shell.
2. Pull Ledger.
3. Defensive v7 audit.
4. Mechanics + deaths.
5. WCL performance + gear/talents.
6. Execution and removal of the legacy defensive dependency.
7. Reliability and defensive-axis cutover to canonical Response.
8. Progression / evolution.
9. AI over the Truth Catalog.
10. Remove the old dossier presentation after all consumers have moved.

Core invariant: the dossier does not recalculate product metrics. It exposes the
same facts/read-models as the infographic and preserves enough provenance to
reconstruct every numerator and denominator.

## Baseline and integration strategy

- Merge prerequisite completed: PR #5 (`feature/mechanics`) merged into
  `fix/defensive-catalog-discovery-v5` on 2026-09-05.
- Baseline merge commit: `efce3bc058766d1a9e5cffda7a7b44fd497ac803`.
- Integration branch for the whole dossier migration:
  `feature/dossier-audit-p1-contracts`.
- PR #14 is the draft umbrella PR from that integration branch to
  `fix/defensive-catalog-discovery-v5`.
- New implementation blocks are developed in child branches and reviewed via
  PRs whose base is `feature/dossier-audit-p1-contracts`. The umbrella PR is not
  promoted until the accumulated dossier work has been audited end-to-end.

## Phase 1A — contractual foundation

Status: IMPLEMENTED AND VALIDATED ON INTEGRATION BRANCH.

Included:

- `AuditClaim<T>` with explicit status, scope, numerator/denominator, formula,
  evidence, version, coverage and integrity issues.
- `EvidenceRef` union and common `PullEvidenceRef`.
- Explicit source kinds: WCL, IRIS canonical, IRIS derived, catalog and AI
  interpretation.
- `NIGHT_PLAYER_CLAIM_REGISTRY` as ownership registry only. It does not contain
  formulas and does not promote transitional owners to canonical status.
- Human pull identity is centralized as `Boss Name · Pull #N`, where N is the
  boss-local ordinal. `fightId` remains an external WCL locator only.
- Exact `wclReportUrl()` and `wclFightUrl()` helpers. No speculative WCL filters
  are generated.
- Regression tests for claim ownership, pull identity and exact WCL URLs.

Explicitly NOT included in Phase 1A:

- no Supabase reads;
- no scoring;
- no metric aggregation;
- no frontend/UI changes;
- no new fallback to legacy data;
- no defensive, mechanics, execution or reliability cutover.

### Validation

GitHub Actions run `33991638821` on commit
`19e58d17ad3317f5bfeae4c6d19888f131f66960`: PASS.

Executed successfully:

- dossier audit + WCL helper Vitest suites;
- existing E7 defensive regression suite;
- `npm run verify:defensive-contract`;
- `npm run verify:causal-schema`;
- `npm run verify:causal-runtime`;
- `npm run build`;
- Deno checks for the canonical defensive evaluator/ledger/evidence/shadow
  modules covered by the permanent E7 workflow.

An earlier validation attempt failed before executing any test because the two
new standalone specs relied on global Vitest symbols. The specs now import
`describe`, `it` and `expect` explicitly; the subsequent complete run passed.
The temporary branch trigger used only to execute this validation was removed
before opening the PR, so no CI-only change remains in the final diff.

## Phase 1B — auditable dossier shell and provenance presentation

Status: IMPLEMENTED ON CHILD BRANCH / VALIDATION IN PROGRESS.

Child branch: `feature/dossier-audit-p1b-shell`.
Target integration branch: `feature/dossier-audit-p1-contracts`.

Included:

- new standalone `NightPlayerAuditShellComponent`;
- a global, explicit data-integrity state that currently reports the truthful
  migration state: contractual structure exists, runtime claims are not yet
  connected;
- provenance drawer backed only by `NIGHT_PLAYER_CLAIM_REGISTRY`, clearly
  labelled as contractual ownership rather than runtime evidence;
- source-kind legend for WCL direct, IRIS canonical, IRIS derived, catalog and
  AI interpretation;
- visible fail-closed messaging: the shell does not manufacture metrics while
  the corresponding canonical owner/read-model is not connected;
- phase navigation placeholders that make later domains visibly unavailable
  instead of silently projecting legacy values;
- isolated officer-only route
  `/report/:reportCode/player/:playerName/audit` for auditing the new shell
  without replacing the stable legacy dossier route;
- direct link back to the current dossier.

Explicitly NOT included in Phase 1B:

- no Pull Ledger rows or pull aggregation;
- no Supabase reads;
- no KPI values;
- no defensive v7 reads or generation selection;
- no mechanics/death evaluation;
- no WCL parse/gear projection;
- no Execution or Reliability changes;
- no AI analysis;
- no cutover of `/report/:reportCode/player/:playerName`.

### Validation

A temporary branch trigger was added to the existing `E7 READY validation`
workflow only to execute the same full repository gate used for Phase 1A. Run
`33992104276` validates the Phase 1B application code. The temporary trigger
must be removed before the child PR is considered final.

## Next gate

Phase 2: Pull Ledger. It may start only after Phase 1B is reviewed and accepted
into the integration branch. The ledger must use the existing boss-local pull
identity and canonical participated-pull population; it must not recreate pull
numbering or scoring filters in the frontend.
