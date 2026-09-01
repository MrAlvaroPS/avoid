import assert from 'node:assert/strict';
import { mkdtemp, open, rename, rm, truncate, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCompleteLines, snapshotFileIdentity } from '../src/file-tail/incremental-tail.ts';

async function withTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'iris-tail-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('commits only newline-terminated lines and rereads the bounded partial fragment', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'WoWCombatLog.txt');
    await writeFile(path, 'line one\nline two\npartial', 'utf8');
    const first = await readCompleteLines(path, 0, { chunkSize: 5 });
    assert.equal(first.kind, 'ok');
    assert.deepEqual(first.lines.map((line) => line.text), ['line one', 'line two']);
    const committed = Buffer.byteLength('line one\nline two\n');
    assert.equal(first.nextCommittedOffset, committed);

    await appendFile(path, ' line\n', 'utf8');
    const second = await readCompleteLines(path, first.nextCommittedOffset, { chunkSize: 4 });
    assert.deepEqual(second.lines.map((line) => line.text), ['partial line']);
    assert.equal(second.nextCommittedOffset, Buffer.byteLength('line one\nline two\npartial line\n'));
  });
});

test('detects truncate instead of silently reusing an old byte offset', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'WoWCombatLog.txt');
    await writeFile(path, 'abcdef\n', 'utf8');
    const result = await readCompleteLines(path, 20);
    assert.equal(result.kind, 'truncated');
    assert.equal(result.nextCommittedOffset, 0);
  });
});

test('file identity changes after rotation/replacement', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'WoWCombatLog.txt');
    const archived = join(dir, 'WoWCombatLog.old.txt');
    await writeFile(path, 'old\n', 'utf8');
    const before = await snapshotFileIdentity(path);
    await rename(path, archived);
    await writeFile(path, 'new\n', 'utf8');
    const after = await snapshotFileIdentity(path);
    assert.notEqual(after.identity, before.identity);
  });
});

test('reads near the end of a sparse >10 GB file without rescanning from byte zero', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'WoWCombatLog.txt');
    const tenGb = 10 * 1024 * 1024 * 1024;
    await writeFile(path, '', 'utf8');
    await truncate(path, tenGb);
    const handle = await open(path, 'r+');
    try {
      const payload = Buffer.from('tail event\n', 'utf8');
      await handle.write(payload, 0, payload.length, tenGb - payload.length);
    } finally {
      await handle.close();
    }
    const start = tenGb - Buffer.byteLength('tail event\n');
    const result = await readCompleteLines(path, start, { maxReadBytes: 1024 });
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].text, 'tail event');
    assert.equal(result.lines[0].byteStart, start);
  });
});
