# AGENTS.md

## Project

IRIS — Raid Intelligence.

IRIS is a World of Warcraft Retail raid-analysis platform for the Avoid guild.
It ingests Warcraft Logs data, evaluates mechanics and player execution, builds
canonical raid/player summaries, and produces officer and raider-facing reports.

The project prioritizes correctness and auditability over producing a score at
all costs.

---

## Core product principles

These rules apply to all new work unless an explicit design document says otherwise.

1. A player-facing percentage must have a mathematically reconstructible
   numerator and denominator.

2. Do not convert missing evidence into player fault.
   Unknown / uncertain / pending data must fail closed and must not create
   punitive verdicts.

3. Do not create parallel sources of truth when an existing canonical pipeline
   can be extended.

4. Prefer:
   raw facts → canonical semantic resolution → canonical evaluation →
   execution ledger → projections / summaries → UI.

5. The frontend must not perform scoring or semantic classification.

6. Do not introduce silent fallback between different algorithms under the
   same UI label.

7. Player evaluation must be build-aware where talents/spec can change the
   meaning, availability or behavior of an ability.

8. Rules must be generic across classes/specs.
   Named abilities such as AMS, Bear Form, Death Strike, Mirror Image, etc.
   are acceptance fixtures, not architecture-specific hardcodes.

9. Do not hardcode spell IDs in generic evaluators when the behavior can be
   expressed through semantic data, policy or resolver contracts.

10. Prefer N/D / uncertain over false precision.

---

## Canonical defensive architecture

The active defensive canonicalization plan is:

`iris-defensive-canonicalization-v1-plan.md`

Read it before making changes related to:

- personal defensives;
- cooldown semantics;
- DefensiveEpisode;
- DamageDescriptor;
- applicability;
- defensive availability;
- defensive scoring;
- execution ledger defensive events;
- raider defensive infographic;
- Night Report defensive metrics;
- defensive Reliability.

The intended canonical flow is:

RAW WCL FACTS
→ CANONICAL PULL SCOPE
→ ABILITY FACTS + IRIS SEMANTICS + PLAYER BUILD
→ EFFECTIVE DEFENSIVE KIT
→ DEFENSIVE EPISODES
→ DAMAGE/APPLICABILITY
→ CAUSAL AVAILABILITY
→ CANONICAL VERDICTS
→ EXECUTION LEDGER
→ CANONICAL SUMMARY
→ FRONT / RELIABILITY

Do not reintroduce legacy pressure-window scoring, legacy defensive reliability,
Management V2 semantics, or raw cooldown_catalog classification as new truth.

---

## Defensive KPI contract

The raider-facing defensive analysis has three projections of the same
canonical evidence:

### Usage
Did the player defensively engage when there was a real evaluable opportunity?

Episode-based, not cast-count-based.

### Response
Primary defensive KPI.

`covered_verified / (covered_verified + missed_ready + missed_due_to_mistime)`

No hidden weights.

### Management
Only evaluates real published defensive assignments / reservations.

If there is no defensive plan, the result is N/D, never 0%.

Do not mix these three KPIs into separate incompatible evaluators.

Reliability uses canonical Response over a different temporal scope; it does not
re-evaluate defensives independently.

---

## Evidence and penalties

A punitive defensive verdict requires sufficient evidence for all relevant
dimensions:

- effective build membership;
- episode identity;
- applicability;
- availability;
- causal reasoning where required;
- sufficient confidence.

`applicability = unknown` must never generate a punitive miss.

`missed_due_to_mistime` requires positive evidence that an earlier bad use
caused the later lack of availability.

Being on cooldown by itself is not evidence of bad play.

---

## Generations and shadow rollout

New canonical defensive results are generation-aware.

Use:

- `defensive_generations`
- `defensive_generation_pointer`
- `player_pull_defensive_episode_evaluations`
- `player_execution_events.defensive_generation_id`

Shadow and legacy data may coexist during implementation, but canonical
consumers must select an explicit generation.

Do not modify the published generation pointer unless the task explicitly
requires a validated cutover.

A generation being technically complete does not automatically mean READY.
Follow the quality gates defined in `iris-defensive-canonicalization-v1-plan.md`.

---

## Execution ledger

`player_execution_events` is the shared execution ledger.

Reuse the existing generic contracts in:

`supabase/functions/_shared/combat-evaluation-contract.ts`

Do not create another execution ledger for defensive work.

Canonical defensive event namespaces use the contracts defined by the active
plan. Keep event identity stable and independent from mutable evidence text.

Avoid double-counting legacy and canonical defensive namespaces in aggregate
views.

---

## Canonical pull population

Scoring/evaluation must use the canonical pull population.

Do not create consumer-specific pull filters for dossier, Night Report,
Reliability, Roster or defensive analysis.

Failed/incomplete/excluded pulls may be useful as context but must not silently
enter scoring.

---

## Supabase / migrations

Database schema changes must be additive during shadow rollout unless the task
explicitly belongs to the post-cutover de-legacy phase.

Do not destructively remove legacy structures before all consumers have moved
to canonical data.

External sync may update factual ability data but must not overwrite verified
IRIS semantic policy.

Prefer migrations over ad-hoc production schema edits.

---

## Important project documents

Before modifying a subsystem, read the relevant current document rather than
assuming older comments are authoritative.

Primary current defensive plan:
- `iris-defensive-canonicalization-v1-plan.md`

Causal/mechanics implementation history:
- `iris-causal-analysis-implementation-progress.md`

Historical defensive implementation context:
- `defensive-management-v2-progress.md`

Change/history context when relevant:
- `change-control.md`

Progress documents may contain historical decisions that have since been
superseded. The active canonicalization plan takes precedence for the defensive
migration.

---

## Coding approach

Before implementing a non-trivial change:

1. Inspect the existing implementation and shared contracts.
2. Identify the current owner/source of truth for the concept.
3. Reuse existing infrastructure where appropriate.
4. Check the active implementation plan.
5. State any contradiction found before creating a second mechanism.
6. Add regression tests for the semantic invariant being changed.

Prefer pure reusable functions for semantic/evaluation logic and keep database /
Deno orchestration outside them where practical.

---

## Validation

Use the existing project commands as appropriate:

- `npm run build`
- `npm test`
- `npm run verify:causal-schema`
- `npm run verify:causal-runtime`
- `npm run verify:defensive-contract`

The available scripts are defined in `package.json`.

For changes touching the defensive canonical pipeline, run at minimum the
relevant Vitest suite plus:

- `npm run verify:defensive-contract`
- `npm run verify:causal-schema`

For changes that can affect Angular compilation, also run:

- `npm run build`

Do not claim validation passed unless it was actually executed.

---

## Scope discipline

Do not fix unrelated legacy behavior "while here" unless:

- it blocks correctness of the requested change;
- it can generate false player penalties;
- or the user explicitly asks for it.

If an inherited limitation can create a false punitive result, fail closed
rather than silently preserving that behavior.

---

## Documentation

When completing a planned implementation step:

- update the active progress/plan document with what was actually implemented;
- distinguish deployed vs local-only work;
- record migrations and version bumps;
- record tests executed and their results;
- record known remaining blockers honestly.

Do not mark a planned step complete simply because scaffolding exists.

---

## Final invariant

IRIS should be able to answer, for every player-facing score:

- What evidence was observed?
- Why was this player responsible?
- Why was this event evaluable?
- Why was this ability applicable?
- Why was it considered available or unavailable?
- What entered the numerator?
- What entered the denominator?
- Which version/generation produced the result?

If the system cannot answer those questions, do not manufacture a precise
player-facing score.