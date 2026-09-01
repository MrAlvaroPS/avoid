# IRIS — Causal analysis implementation progress

> Persistent implementation ledger for the causal/responsibility workstream. This file is the single progress source for all blocks and must be updated whenever implementation advances.

## Branch and baseline

- Working branch: `feature/iris-causal-analysis-block-a`
- Base branch: `fix/defensive-catalog-discovery-v5`
- Started: 2026-09-01
- Delivery rule: code and this progress file are one delivery. A block is not considered closed until this file reflects the real repository state.
- Review rule: every block receives two explicit review passes before it can move to `ACCEPTED`.

## Global roadmap

| Block | Scope | Status |
|---|---|---|
| A | Local combat-log collector: tail, parser, durable spool, fixtures/tests | IMPLEMENTING |
| B | Canonical PullEvaluationContext and editable wipe/ninja boundaries | PENDING |
| C | MechanicPolicy v2 and canonical mechanic identity | PENDING |
| D | Occurrence-level responsibility/causality resolver | PENDING |
| E | Canonical player execution ledger | PENDING |
| F | Defensive evaluator v2 integration with causal eligibility | PENDING |
| G | Consumables and externals semantic integration | PENDING |
| H | Dossier/infographic v2 and visual evidence surfaces | PENDING |
| I | Preparation/MRT causal integration | PENDING |
| J | Backfill, corpus, migration rollout, observability and legacy retirement | PENDING |

---

# Block A — Collector and parser

## Objective

Create a loss-resistant local ingestion layer for WoW retail combat logs without introducing causality, responsibility or scoring. Block A must only answer: **what raw event happened, exactly as the local log recorded it, and can IRIS recover that event after a restart/crash?**

The output of this block is deliberately factual. Later blocks may interpret an event, but Block A must never decide who failed a mechanic or whether an event should affect a score.

## Initial audit

The base branch contains the web application, Supabase functions and Warcraft Logs ingestion pipeline, but no dedicated local `WoWCombatLog.txt` collector/parser subsystem. Therefore Block A is implemented as an additive `tools/combat-log-collector/` package surface and does not alter the current WCL-backed application path.

Compatibility requirement: nothing in the existing Angular/Supabase runtime is replaced or made dependent on the collector during Block A.

## Required parser coverage

- Timestamp + CSV payload parsing, including quoted names and escaped quotes.
- Common source/destination event header.
- Spell/range/periodic prefixes.
- Advanced combat logging blocks in both modern 19-field and legacy 17-field layouts.
- Modern damage and healing suffixes.
- `SWING_DAMAGE`, `SPELL_DAMAGE`, `SPELL_PERIODIC_DAMAGE`, `RANGE_DAMAGE`, `ENVIRONMENTAL_DAMAGE`.
- `SPELL_HEAL`, `SPELL_PERIODIC_HEAL`.
- `SPELL_ABSORBED` physical and spell variants without pretending it is an ordinary damage suffix.
- Unknown/unimplemented event types preserved as raw fields instead of discarded.
- Format metadata (`COMBAT_LOG_VERSION`) preserved for diagnostics.

## Transport/durability requirements

- Live attach defaults to EOF so enabling the collector does not replay an arbitrary multi-gigabyte historical file by accident.
- Optional recovery offset is supported explicitly.
- Partial final lines are retained until newline arrives; they must not be emitted as valid events.
- File truncation/replacement is detected and the cursor recovers safely.
- Shadow transport: collected events are durably spooled locally before any future uploader consumes them.
- Journal write is flushed/fsynced before durable checkpoint state advances.
- Restart recovery resumes from durable state and never assumes an in-memory cursor was persisted.

## Files introduced / affected

Planned in this block:

- `tools/combat-log-collector/parser.mjs`
- `tools/combat-log-collector/tail.mjs`
- `tools/combat-log-collector/spool.mjs`
- `tools/combat-log-collector/index.mjs`
- `tools/combat-log-collector/*.test.mjs`
- `tools/combat-log-collector/fixtures/*`
- `package.json` (collector test script only; no runtime dependency replacement)
- this progress file

## Bugs / inconsistencies found during audit

### A-001 — No local collector exists on the base branch

**Impact:** there is no durable first-party path from local `WoWCombatLog.txt` to a canonical factual event stream. Current analysis is WCL/API-driven.

**Resolution:** additive local collector in Block A. It remains isolated from scoring and current production ingestion until a later integration block.

### A-002 — Format-version assumptions would be unsafe if implemented with fixed absolute offsets

Retail logs can expose different advanced blocks (modern 19-field vs legacy 17-field), and `SPELL_ABSORBED` has its own variants. Treating all events as one fixed schema would silently shift amount/HP/position fields.

**Resolution:** parser will identify prefix/suffix families and resolve advanced-block length from the event shape, preserving raw fields when a layout cannot be proven.

## Implementation log

### 2026-09-01 — Block A started

- Created dedicated branch from `fix/defensive-catalog-discovery-v5`.
- Audited repository tree and confirmed collector is additive rather than a refactor of an existing local collector.
- Established this file as the single cross-thread implementation ledger.
- Parser/tail/spool implementation now in progress.

## Test gate

Block A cannot be marked `ACCEPTED` until the fixture corpus covers at least:

- modern 19-field spell damage;
- legacy 17-field spell damage;
- modern heal;
- spell absorb variants;
- quoted comma/quote CSV handling;
- unknown event preservation;
- attach-at-EOF behavior;
- append after attach;
- partial line across reads;
- truncation/rotation recovery;
- spool restart recovery;
- checkpoint never advancing ahead of fsynced journal data.

## Review pass 1

Status: **PENDING** — run after first implementation is complete.

## Review pass 2

Status: **PENDING** — independent contradiction/edge-case pass after review 1 fixes.

## Pending after Block A

No causal interpretation, responsibility attribution, mechanic scoring, wipe/ninja classification changes, dossier changes or MRT changes belong in this block. Those remain explicitly deferred to later blocks.
