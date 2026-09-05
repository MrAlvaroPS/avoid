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
  PRs whose base is `feature/dossier-audit-p1-contracts`. Validated child PRs
  may be merged into the integration branch so subsequent phases share one
  coherent baseline; the umbrella PR remains Draft until the accumulated
  dossier work has been audited end-to-end.

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

Status: IMPLEMENTED, VALIDATED AND MERGED INTO INTEGRATION BRANCH.

Child branch: `feature/dossier-audit-p1b-shell`.
PR: #16.
Integration merge commit: `1342e27b2fcc28247278267bde0aa637195cad6e`.
Target integration branch: `feature/dossier-audit-p1-contracts`.

Included:

- new standalone `NightPlayerAuditShellComponent`;
- a global, explicit data-integrity state;
- provenance drawer backed only by `NIGHT_PLAYER_CLAIM_REGISTRY`, clearly
  labelled as contractual ownership rather than runtime evidence;
- source-kind legend for WCL direct, IRIS canonical, IRIS derived, catalog and
  AI interpretation;
- visible fail-closed messaging;
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

GitHub Actions run `33992104276` on commit
`d846d7b7d8eedf81395466dd11f742990ad404ba`: PASS.

Executed successfully:

- existing E7 defensive regression suite;
- `npm run verify:defensive-contract`;
- `npm run verify:causal-schema`;
- `npm run verify:causal-runtime`;
- `npm run build` including compilation of the new standalone component,
  template and route;
- Deno checks for the canonical defensive evaluator/ledger/evidence/shadow
  modules covered by the permanent E7 workflow.

The temporary branch trigger used only to execute this validation was removed
before the child PR was finalized.

## Phase 2 — auditable Pull Ledger

Status: IMPLEMENTED, VALIDATED AND MERGED INTO INTEGRATION BRANCH.

Child branch: `feature/dossier-audit-p2-pull-ledger`.
PR: #18.
Integration merge commit: `2bf3425a4954d4f1f82d04482bba8f7c767752f5`.
Target integration branch: `feature/dossier-audit-p1-contracts`.
Baseline: Phase 1B integration merge `1342e27b2fcc28247278267bde0aa637195cad6e`.

### Canonical population and identity rules

The ledger does not derive its own scoring population.

- report pulls come from `pulls` for the exact `report_code`;
- player participation requires an actual `player_pull_records` row for that
  player and pull;
- boss-local numbering reuses `validAttemptOrdinal` over **all valid pulls** in
  the same `boss_id + difficulty` group, not only the pulls in which the player
  participated;
- benching a player on one attempt therefore does not renumber later attempts;
- `fightId` is only an external WCL locator and never replaces the human pull
  identity;
- participated ninja pulls remain visible as excluded context but receive no
  fabricated boss-local ordinal and do not enter the evaluable ledger.

### Read projection implemented

`NightPlayerPullLedgerService` reads only the facts required by Phase 2:

- `pulls` identity/result/duration/exclusion facts;
- `report_encounters.fight_id + boss_name`;
- `player_pull_records` participation and WCL parse facts.

It projects one `NightPlayerPullLedgerRow` per valid participated pull with:

- canonical human label `Boss Name · Pull #N`;
- exact WCL fight deep-link via the Phase 1 helper;
- participation claim;
- boss-local identity claim;
- result claim from `wipe_pct`;
- duration claim from `duration_ms`;
- WCL parse claim from `world_rank_percent`;
- per-row integrity state and evidence refs.

The expanded audit surface exposes definition, status, formula/source version,
internal pull id, WCL locator and evidence references rather than only the
rendered value.

### Fail-closed behavior

- missing `world_rank_percent` => `value=null`, `status=not_evaluable`, rendered
  as N/D; never 0;
- missing `wipe_pct` => result N/D; the UI does not silently assume wipe;
- missing duration => duration N/D;
- unresolved boss-local identity => the pull is preserved in contextual
  exclusions rather than assigned a guessed number;
- duplicate player-pull records, orphan records and missing encounter labels
  generate explicit integrity issues;
- later domains are presented only as pending their approved phase, not filled
  from legacy scoring.

### Explicitly NOT included in Phase 2

- no `pullScore` or `scoreBreakdown` reuse;
- no legacy defensive miss fields or pressure-window scoring;
- no Defensive v7 read/cutover;
- no mechanics or death evaluation;
- no Execution score;
- no Reliability score;
- no gear/talent projection;
- no AI;
- no schema or migration changes;
- no change to the stable legacy dossier route.

### Regression coverage

`night-player-pull-ledger.service.spec.ts` covers:

- only real participated pulls enter the ledger;
- boss-local ordinal remains based on all valid attempts even when the player
  was bench for an intermediate pull;
- boss changes reset the ordinal independently;
- ninja pulls are contextual exclusions and do not consume an ordinal;
- missing parse is N/D rather than zero;
- exact WCL fight URL and row evidence are reconstructible.

### Validation

GitHub Actions run `33992666948` on commit
`66a5923f3186b6cb417a122a37082f381636571e`: PASS.

Executed successfully:

- Phase 2 Pull Ledger Vitest suite;
- Phase 1 audit contract regression suite;
- existing E7 defensive regression suites;
- `npm run verify:defensive-contract`;
- `npm run verify:causal-schema`;
- `npm run verify:causal-runtime`;
- `npm run build`, including the Pull Ledger service/component/templates;
- Deno checks for the canonical defensive evaluator/ledger/evidence/shadow
  modules covered by the permanent E7 workflow.

The temporary Phase 2 workflow trigger and the extra CI-only test-list entries
were removed after the successful run, so they are not part of the final Phase 2
diff.

## Phase 3 — canonical Defensive v7 audit

Status: IMPLEMENTED AND VALIDATED ON CHILD BRANCH.

Child branch: `feature/dossier-audit-p3-defensives`.
Target integration branch: `feature/dossier-audit-p1-contracts`.
Baseline: integration commit `12f5cf1dd1eba3f12daf89f2da6ead55fe569ef2`.

### Gate verification against production

Phase 3 was not started from the historical Shadow runner assumption. The live
Supabase state was checked first.

At validation time `defensive_generation_pointer.published_generation_id`
resolved to:

`aed9ea13-0c8a-4bf9-85bc-b8f69e86b9a2`

That generation is `status=published` and declares:

- semantic version `defensive-semantics@1.0.0`;
- resolver `effective-defensives@2.3.0`;
- semantic resolver `effective-defensive-semantics@1.5.0`;
- episode/evaluator `episode-evaluator@7`;
- game build `12.1.0.68914`.

It contains 611 player-pull evaluation rows across 26 canonical pulls. Its audit
notes record a completed two-report v7 validation, no failed pulls, no gate
violations and zero global-integrity violations before the pointer was promoted.

`shadow-defensive-v7` remains a temporary empirical runner and is **not** called
by the dossier. The product path is exclusively:

`defensive_generation_pointer -> published defensive_generations row -> canonical_scored_pulls -> player_pull_defensive_episode_evaluations -> CanonicalDefensiveSummaryService -> audit projection`.

This distinction is deliberate: historical provenance may say the generation
originated in a shadow run, but the dossier only trusts its later published
identity selected through the canonical pointer.

### Published coverage limitation

The current published generation is complete for the two audited reports:

- `7GbANtw1J2pjZzH9`: 13/13 canonical pulls;
- `24nwKPpL8tr9Bcg1`: 13/13 canonical pulls.

Other reports currently present in `canonical_scored_pulls` have no rows in this
published generation. For those reports the Phase 3 surface remains fail-closed
(partial/incompatible/N/D according to the canonical read-model); it never falls
back to V2, pressure-window scoring or death-time defensive availability.

### Audit projection implemented

`NightPlayerDefensiveAuditService` composes the existing Pull Ledger with
`CanonicalDefensiveSummaryService` and projects:

- canonical Usage claim with the exact canonical numerator/denominator;
- canonical Response claim with the exact canonical numerator/denominator;
- Management from real published plan assignments only;
- generation identity and all resolver/evaluator versions;
- evaluated/expected pull coverage;
- contextual counts for `unavailable_legitimate`, `no_applicable_resource`,
  `uncertain` and `excluded`;
- one auditable row per canonical `DefensiveEpisode`;
- exact WCL fight deep-link plus `DefensiveEpisodeEvidence` containing the
  generation id and episode id;
- usage engagement/evaluability, Response verdict/reason, used/covering/decisive
  spell IDs, confidence and plan assignment/verdict where present;
- explicit unresolved-evidence/integrity states when an episode cannot be
  joined to a boss-local Pull Ledger identity.

The projection **does not calculate KPI values**. `value`, numerator and
denominator are copied from `CanonicalDefensiveSummary`; the shared pure KPI
contract is used only to identify which already-canonical episodes constitute
the evidence set for those denominators.

### KPI contracts exposed

- Usage: episode-based engagement over the canonical usage-evaluable episode
  population; a cast count is never used as the KPI unit.
- Response: `covered_verified / (covered_verified + missed_ready +
  missed_due_to_mistime)`.
- Management: fulfilled published assignments / evaluable published
  assignments. No published assignment population => N/D, never 0.
- `uncertain`, `unavailable_legitimate`, `no_applicable_resource` and `excluded`
  are visible context and never silently become punitive denominator rows.

### Empirical readback

The published production generation was queried directly for Dewerland in
report `7GbANtw1J2pjZzH9`:

- 17 total episodes;
- Usage: 10/17;
- Response: 4/15;
- 11 `missed_ready`;
- 0 `missed_due_to_mistime`;
- 2 `uncertain` outside the Response denominator;
- 0 published Management assignments => Management N/D.

This matches the semantics exposed by the new audit projection and verifies that
the UI is not deriving a second denominator.

### Regression coverage

`night-player-defensive-audit.service.spec.ts` includes the acceptance canary:

- Response 12/20 must expose numerator 12, denominator 20, exactly 20 linked
  denominator episodes, 12 `covered` and 8 misses;
- Usage and Response denominators may legitimately differ;
- Management with no plan is N/D, never 0;
- a duplicated plan assignment remains one management unit;
- incompatible generation data produces no fabricated KPI;
- unresolved pull identity preserves the canonical KPI value but degrades the
  audit claim/integrity to partial instead of inventing evidence.

### UI surface

The audit route now includes a dedicated Defensive v7 section showing:

- generation/version/coverage state;
- Usage, Response and Management claim cards;
- exact numerators/denominators and formulas;
- non-punitive context counts;
- DefensiveEpisode ledger with WCL links and Wowhead spell links;
- per-episode audit detail and technical evidence locator;
- explicit blocked state instead of any legacy fallback.

### Validation

GitHub Actions run `33993501104` on application commit
`3d828b0981dbf67379e3500b3989824e49526e6d`: PASS.

Executed successfully:

- Phase 3 defensive-audit regression suite;
- canonical defensive-summary regression suite;
- Phase 1/2 audit regression suites;
- existing E7 defensive regression suites;
- `npm run verify:defensive-contract`;
- `npm run verify:causal-schema`;
- `npm run verify:causal-runtime`;
- `npm run build`, including the new service/component/templates;
- Deno checks for the defensive evaluator/ledger/evidence/shadow modules in the
  permanent E7 gate.

The temporary Phase 3 branch trigger and extra CI-only test-list entries were
removed after the successful run. The permanent workflow is restored exactly,
so `.github/workflows/e7-ready-validation.yml` is not part of the final Phase 3
diff.

### Explicitly NOT included in Phase 3

- no call to `shadow-defensive-v7` from product traffic;
- no publication/pointer mutation from the dossier;
- no Supabase schema or Edge Function change;
- no V2/legacy defensive fallback;
- no `pullScore`, `defensiveMissed` or pressure-window scoring;
- no Mechanics/death cutover;
- no Execution changes;
- no Reliability changes;
- no WCL performance/gear build phase;
- no AI.

## Next gate

Phase 4: Mechanics + deaths. It must identify and consume the actual canonical
mechanic/death ownership path before changing any player-facing claim. Legacy
`NightPlayerSummary.mechanicFails`/`NightDeathRow` data must not be promoted to
canonical truth merely because it is already easy to render. Any missing causal
linkage must remain partial/N/D rather than inferred in the dossier.
