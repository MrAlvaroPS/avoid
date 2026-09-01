# IRIS — Causal analysis implementation progress

> Persistent implementation ledger for the causal/responsibility workstream. This file is the single progress source for all blocks and must be updated whenever implementation advances.

## Branch and baseline

- Working branch: `feature/iris-causal-analysis-block-a`
- Base branch: `fix/defensive-catalog-discovery-v5`
- Base commit at branch creation: `4aad209930a72c5150e57e2b10456a51999e2cbd`
- Started: 2026-09-01
- Delivery rule: code and this progress file are one delivery. A block is not considered closed until this file reflects the real repository state.
- Review rule: every block receives two explicit review passes before it can move to `ACCEPTED`.

## Global roadmap

| Block | Scope | Status |
|---|---|---|
| A | Local combat-log collector: tail, parser, durable spool, fixtures/tests | TESTING |
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

The base branch contains the web application, Supabase functions and Warcraft Logs ingestion pipeline, but no dedicated local `WoWCombatLog.txt` collector/parser subsystem. Block A is therefore implemented as an additive `tools/combat-log-collector/` surface and does not replace the existing WCL-backed production path.

Compatibility rule maintained in this implementation: the Angular application, Supabase schema/functions, defensive v2 pipeline and current report analysis do not depend on the local collector yet. If the collector is removed, the existing application behavior is unchanged.

## Implemented architecture

### 1. Parser — `tools/combat-log-collector/parser.mjs`

Implemented a factual parser with the following contract:

- parses the timestamp prefix separately from the CSV event payload;
- uses an actual CSV scanner instead of `split(',')`, preserving quoted commas and doubled quotes;
- parses the nine-field common source/destination header;
- parses spell/range/periodic spell prefixes where that grammar actually applies;
- resolves both modern 19-field and legacy 17-field advanced combat-log blocks;
- parses modern and legacy damage suffixes separately;
- parses modern and legacy healing suffixes separately;
- handles `SPELL_ABSORBED` as its own grammar, including spell-attack and swing/physical variants;
- supports `SWING_DAMAGE`, `SWING_DAMAGE_LANDED`, spell/range damage, periodic damage, environmental damage, healing and support variants already covered by the generic suffix rules;
- preserves unknown event payloads instead of dropping them or inventing meaning;
- preserves `COMBAT_LOG_VERSION` metadata;
- preserves the raw source line as audit evidence.

The parser does **not** classify mechanics, responsibility, culpability, defensive eligibility, wipe calls or score impact.

### 2. Tail — `tools/combat-log-collector/tail.mjs`

Implemented a byte-offset tailer designed for a live `WoWCombatLog.txt`:

- first attach defaults to EOF;
- explicit start/recovery offsets are supported;
- offsets are byte offsets, not JS character indexes;
- only newline-terminated records become events;
- partial final lines are buffered across reads;
- replacement/rotation is detected with file identity;
- recovery identity prevents applying an old offset to a new file;
- in-place truncation is detected;
- truncate-and-rewrite cases where the new file has already grown beyond the previous offset are additionally detected with a rolling content anchor;
- file identity combines device, inode and birth time to reduce accidental identity reuse across rotations.

### 3. Durable spool — `tools/combat-log-collector/spool.mjs`

Implemented an append-only local shadow journal:

`tail -> parser -> NDJSON journal -> fsync -> atomic state checkpoint`

Durability invariant:

1. all records in a poll batch are appended to the journal;
2. the journal is fsynced;
3. only then is `state.json` advanced to the last source offset;
4. the state file itself is fsynced and atomically renamed;
5. directory fsync is attempted where supported and treated as a portability enhancement rather than a Windows-breaking hard requirement.

Restart recovery treats the journal as authoritative. If the process dies after journal fsync but before `state.json` advances, the last valid journal record restores the correct source offset rather than replaying an already durable record.

The recovery path also fails closed if persisted state is somehow ahead of the durable journal, because silently trusting that state could skip combat-log bytes.

### 4. Collector composition — `tools/combat-log-collector/index.mjs`

Implemented an isolated shadow collector that composes the three layers without any network uploader yet.

Important behavior:

- source paths are canonicalized before being persisted/compared for restart recovery;
- a tail attach failure closes the already-open spool instead of leaking a file handle;
- records read by the tail remain in an in-memory pending queue until durable persistence succeeds;
- if spool persistence fails, the queue is retained for retry;
- if the process dies after such a failure, the durable checkpoint remains behind the failed batch and the next process rereads those source bytes;
- journal persistence is batched per poll, so the collector does not perform one filesystem `fsync` per combat event.

### 5. Fixtures/tests

Added:

- `tools/combat-log-collector/parser.test.mjs`
- `tools/combat-log-collector/tail-spool.test.mjs`
- `tools/combat-log-collector/fixtures/parser-corpus.txt`
- `npm run test:collector`

The authored tests cover modern/legacy parsing, modern healing, `SPELL_ABSORBED`, CSV quoting, unknown events, version metadata, attach-at-EOF, partial lines, truncation/rewrite, replacement/recovery identity, journal/state durability and fail-closed state/journal inconsistency.

## Files introduced / affected

- `tools/combat-log-collector/parser.mjs` — new
- `tools/combat-log-collector/tail.mjs` — new
- `tools/combat-log-collector/spool.mjs` — new
- `tools/combat-log-collector/index.mjs` — new
- `tools/combat-log-collector/parser.test.mjs` — new
- `tools/combat-log-collector/tail-spool.test.mjs` — new
- `tools/combat-log-collector/fixtures/parser-corpus.txt` — new
- `package.json` — additive `test:collector` script only
- `iris-causal-analysis-implementation-progress.md` — persistent implementation ledger

No application route, Angular component, Supabase table/view/function, WCL analysis function, defensive evaluator, dossier calculation or scoring function has been changed in Block A.

## Bugs / inconsistencies found and resolution

### A-001 — No local collector exists on the base branch

**Impact:** no durable first-party path exists from local `WoWCombatLog.txt` to a factual local event stream.

**Resolution:** additive local collector introduced without replacing the current WCL path.

### A-002 — Fixed-offset parsing would corrupt version-dependent fields

**Impact:** modern 19-field and legacy 17-field advanced blocks can shift damage/heal suffix offsets.

**Resolution:** advanced block and suffix are resolved as separate grammar layers; unsupported shapes preserve raw evidence.

### A-003 — `SPELL_ABSORBED` looked like a normal `SPELL_*` event but is not

**Found during review pass 1.**

The first parser implementation allowed the generic spell-prefix branch to consume three fields before `SPELL_ABSORBED` was handled. That would shift the absorber and absorb-spell fields and produce false factual data.

**Resolution:** `SPELL_ABSORBED` is intercepted immediately after the common header and parsed from its dedicated spell-attack/swing-attack layouts.

### A-004 — Legacy 17-field advanced block was initially mapped one field too early

**Found during review pass 1.**

The first implementation treated legacy layout as if the absorb field did not exist, shifting power/resource/position fields.

**Resolution:** legacy layout is represented as modern advanced logging minus the two modern reserved fields; absorb remains in the common advanced portion. Tests and raw fixture were corrected together.

### A-005 — Recovery offset could be applied to a rotated replacement log

**Found during review pass 1.**

An offset by itself is not enough. Applying yesterday's byte offset to a new file at the same path can skip the beginning of that new file.

**Resolution:** durable state stores file identity; tail recovery only applies the offset when identity matches. A replacement starts at byte 0.

### A-006 — Simple `size < offset` truncation detection is insufficient

**Found during review pass 1.**

A log can be truncated and rewritten beyond the previous offset between polls. In that case the new size may already be larger than the old cursor, making size-only detection silently skip bytes.

**Resolution:** the tail keeps a rolling byte anchor from the previously observed file content and verifies it before continuing. An anchor mismatch resets the cursor safely.

### A-007 — Torn final journal record handling could hide semantic corruption

**Found during review pass 1.**

The first recovery implementation used one catch path for both JSON parse failure and invalid/non-monotonic sequences. A structurally invalid but syntactically valid final record could therefore be treated as a harmless torn write.

**Resolution:** only JSON syntax failure on the final physical record is recoverable. Invalid or non-monotonic sequence metadata fails closed regardless of position.

### A-008 — Directory fsync was not portable enough for the primary Windows use case

**Found during review pass 2.**

Opening/fsyncing a directory is not uniformly supported across Windows/filesystem combinations. Making it mandatory could make a durability enhancement prevent the collector from working at all.

**Resolution:** journal fsync and state-file fsync remain mandatory. Directory fsync is best-effort for known unsupported-platform errors.

### A-009 — Source-path spelling could break restart recovery

**Found during review pass 2.**

Relative vs absolute paths, or different caller working directories, could make the same physical log look like a different source and force incorrect first-attach behavior.

**Resolution:** the collector canonicalizes the source path with `path.resolve()` before comparison and persistence.

### A-010 — Tail cursor could advance beyond records that failed to spool

**Found during review pass 2; high severity.**

`poll()` necessarily advances the in-memory byte cursor. In the first composition, if record N failed while appending to the spool, the method threw and N+1..end existed only in a local array that was lost. A second call in the same process would continue after those bytes.

**Resolution:** polled records remain in a persistent in-memory pending queue until persistence succeeds. The queue is only removed after durable commit. On process death, the older durable checkpoint causes those records to be reread from the source file.

### A-011 — Per-event fsync would not scale to real combat-log throughput

**Found during review pass 2.**

Correctness was initially achieved by fsyncing every journal record individually, but a combat log can emit very large numbers of events per second. That approach would make filesystem latency the ingestion bottleneck.

**Resolution:** `appendBatch()` writes all records from a poll as one NDJSON batch, fsyncs once, then advances the checkpoint to the last record. The durability ordering remains unchanged.

### A-012 — Tail attach failure leaked the already-open spool handle

**Found during review pass 2.**

**Resolution:** collector composition now closes the spool before rethrowing an attach failure.

## Implementation log

### 2026-09-01 — Block A initial implementation

- Created `feature/iris-causal-analysis-block-a` directly from `fix/defensive-catalog-discovery-v5`.
- Audited the base tree and confirmed that the local collector is a new additive subsystem.
- Added parser, tail, durable spool and shadow collector composition.
- Added parser corpus and focused tests.
- Added `npm run test:collector`.
- Performed review pass 1, fixed A-003 through A-007.
- Performed review pass 2, fixed A-008 through A-012.
- Compared the branch against its base after both review passes; changes remain isolated to the collector, its tests/fixtures, `package.json` test script and this progress file.

## Test gate

Authored coverage currently includes:

| Case | Test authored | Executed in this session |
|---|---:|---:|
| modern 19-field spell damage | yes | no |
| legacy 17-field spell damage | yes | no |
| modern heal | yes | no |
| `SPELL_ABSORBED` spell variant | yes | no |
| `SPELL_ABSORBED` swing variant | yes | no |
| quoted comma / doubled quote CSV | yes | no |
| unknown event preservation | yes | no |
| `COMBAT_LOG_VERSION` | yes | no |
| attach at EOF | yes | no |
| append after attach | yes | no |
| partial line across reads | yes | no |
| in-place truncate/rewrite | yes | no |
| replacement + stale recovery identity | yes | no |
| spool restart recovery from journal-ahead-of-state | yes | no |
| state-ahead-of-journal fail closed | yes | no |

### Test execution limitation

An attempt was made to clone the branch into the available command-execution environment and run `npm run test:collector`, but that environment has no DNS/network access to GitHub (`Could not resolve host: github.com`). There are also currently no GitHub Actions workflow runs for this branch.

Therefore the block is intentionally **not marked ACCEPTED** yet. The next execution environment with the repository checked out should run:

`npm ci && npm run test:collector && npm run build`

Any result/fix must be recorded back into this same file.

## Review pass 1 — parser and crash-correctness review

Status: **COMPLETED**

Focus:

- grammar offsets;
- special-event exceptions;
- version-dependent fields;
- restart/recovery identity;
- truncation behavior;
- journal corruption semantics.

Findings fixed: A-003, A-004, A-005, A-006, A-007.

## Review pass 2 — scalability, portability and cross-layer consistency review

Status: **COMPLETED**

Focus:

- Windows behavior;
- source identity consistency;
- failure between tail read and durable persistence;
- filesystem throughput;
- resource cleanup;
- branch isolation from existing production consumers.

Findings fixed: A-008, A-009, A-010, A-011, A-012.

## Remaining Block A work before ACCEPTED

1. Execute collector tests in a real checkout.
2. Execute normal application build to prove the additive package/script does not disturb Angular.
3. Add/execute an integration test for the full `openShadowCollector()` composition, including a simulated spool write failure and retry, if the first test run exposes a practical injection seam.
4. Validate the parser corpus against at least one actual current retail `WoWCombatLog.txt` sample before declaring the field grammar production-proven.
5. Measure journal size/restart cost on a multi-hour raid sample. Current recovery reads the complete NDJSON journal into memory; this is correct but is a known scalability candidate for a later Block A hardening pass if real samples make it material.

Until those gates pass, Block A status remains `TESTING`, not `ACCEPTED`.

## Explicitly deferred

No causal interpretation, responsibility attribution, mechanic scoring, wipe/ninja classification changes, dossier changes, reliability changes, defensive-evaluator changes or MRT changes belong in Block A. Those remain deferred to later blocks.
