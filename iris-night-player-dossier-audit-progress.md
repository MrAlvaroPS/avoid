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

## Baseline

- Merge prerequisite completed: PR #5 (`feature/mechanics`) merged into
  `fix/defensive-catalog-discovery-v5` on 2026-09-05.
- Baseline merge commit: `efce3bc058766d1a9e5cffda7a7b44fd497ac803`.
- Implementation branch for the first atomic delivery:
  `feature/dossier-audit-p1-contracts`.

## Phase 1A — contractual foundation

Status: IMPLEMENTED ON BRANCH / VALIDATION PENDING.

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

## Next step after merge

Phase 1B: create the new dossier shell and integrity/provenance presentation over
these contracts, without yet implementing the Phase 2 Pull Ledger or any domain
scoring logic.
