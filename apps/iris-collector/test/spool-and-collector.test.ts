import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { COLLECTOR_SPOOL_FORMAT_VERSION, type SequenceString, type SpoolRecord } from '../../../packages/combat-log-contracts/src/index.ts';
import { IrisCollector } from '../src/collector.ts';
import { JsonlSpool } from '../src/spool/jsonl-spool.ts';

async function withTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'iris-collector-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function record(sequence: number): SpoolRecord {
  const seq = String(sequence) as SequenceString;
  return {
    version: COLLECTOR_SPOOL_FORMAT_VERSION,
    streamId: 'stream-1',
    sequence: seq,
    committedOffset: sequence * 10,
    formatState: { advancedEnabled: true, logFormatVersion: 19, gameBuild: '12.0.5', projectId: 1 },
    event: {
      streamId: 'stream-1',
      sequence: seq,
      timestamp: 1,
      rawTimestamp: '9/1 20:00:00.000',
      eventType: 'TEST',
      payload: { kind: 'unknown', reason: 'unsupported_event', tokenizedFields: [] },
      rawRef: { streamId: 'stream-1', sequence: seq, byteStart: 0, byteEndExclusive: sequence * 10 },
      parserVersion: 'test',
    },
  };
}

test('spool is durable, JSON-safe and ignores a retried already-committed sequence', async () => {
  await withTemp(async (dir) => {
    const spoolPath = join(dir, 'spool.jsonl');
    const spool = new JsonlSpool(spoolPath);
    assert.equal(await spool.append([record(1), record(2)]), 2);
    assert.equal(await spool.append([record(2), record(3)]), 1);
    assert.equal((await spool.lastRecord())?.sequence, '3');
    const lines = (await readFile(spoolPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3);
    assert.doesNotThrow(() => lines.map(JSON.parse));
  });
});

test('spool recovers a torn final write and keeps the previous durable record', async () => {
  await withTemp(async (dir) => {
    const spoolPath = join(dir, 'spool.jsonl');
    const spool = new JsonlSpool(spoolPath);
    await spool.append([record(1), record(2)]);
    await appendFile(spoolPath, '{"version":1,"broken":', 'utf8');
    assert.equal((await spool.lastRecord())?.sequence, '2');
    assert.ok((await readFile(spoolPath, 'utf8')).endsWith('\n'));
  });
});

test('collector restart reconciles spool before state and does not duplicate facts', async () => {
  await withTemp(async (dir) => {
    const logPath = join(dir, 'WoWCombatLog.txt');
    const statePath = join(dir, 'state.json');
    const spoolPath = join(dir, 'spool.jsonl');
    const version = '9/1 20:00:00.000  COMBAT_LOG_VERSION,19,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.0.5,PROJECT_ID,1\n';
    const encounter = '9/1 20:00:01.000  ENCOUNTER_START,999,"Boss, The Test",16,20,3000\n';
    await writeFile(logPath, version + encounter.slice(0, -1), 'utf8');

    const collector = new IrisCollector({ sourcePath: logPath, statePath, spoolPath, referenceDate: new Date('2026-09-01T00:00:00Z'), fixedOffsetMinutes: 120 });
    const first = await collector.pollOnce();
    assert.equal(first.linesRead, 1);
    assert.equal(first.advancedEnabled, true);

    await appendFile(logPath, '\n', 'utf8');
    const secondCollector = new IrisCollector({ sourcePath: logPath, statePath, spoolPath, referenceDate: new Date('2026-09-01T00:00:00Z'), fixedOffsetMinutes: 120 });
    const second = await secondCollector.pollOnce();
    assert.equal(second.linesRead, 1);
    assert.equal(second.lastSequence, '2');

    const third = await secondCollector.pollOnce();
    assert.equal(third.linesRead, 0);
    const spoolLines = (await readFile(spoolPath, 'utf8')).trim().split('\n');
    assert.equal(spoolLines.length, 2);
  });
});

test('truncate starts a new stream rather than reusing offsets from the old file', async () => {
  await withTemp(async (dir) => {
    const logPath = join(dir, 'WoWCombatLog.txt');
    const statePath = join(dir, 'state.json');
    const spoolPath = join(dir, 'spool.jsonl');
    await writeFile(logPath, '9/1 20:00:00.000  COMBAT_LOG_VERSION,19,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.0.5,PROJECT_ID,1\n9/1 20:00:01.000  ZONE_CHANGE,3000,"Raid",16\n', 'utf8');
    const collector = new IrisCollector({ sourcePath: logPath, statePath, spoolPath, referenceDate: new Date('2026-09-01T00:00:00Z'), fixedOffsetMinutes: 120 });
    const before = await collector.pollOnce();

    await truncate(logPath, 0);
    await writeFile(logPath, '9/1 21:00:00.000  COMBAT_LOG_VERSION,19,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.0.5,PROJECT_ID,1\n', 'utf8');
    const after = await collector.pollOnce();
    assert.equal(after.rotationReason, 'truncated');
    assert.notEqual(after.streamId, before.streamId);
    assert.equal(after.lastSequence, '1');
  });
});
