import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CombatLogTail } from './tail.mjs';
import { DurableCombatLogSpool } from './spool.mjs';

const tempRoots = [];
async function tempRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), 'iris-combat-log-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CombatLogTail', () => {
  it('attaches at EOF by default and only emits newly appended complete lines', async () => {
    const dir = await tempRoot();
    const file = path.join(dir, 'WoWCombatLog.txt');
    await writeFile(file, 'old-1\nold-2\n');
    const tail = new CombatLogTail(file);
    const attached = await tail.attach();
    expect(attached.offset).toBe(Buffer.byteLength('old-1\nold-2\n'));
    expect(await tail.poll()).toEqual([]);

    await appendFile(file, 'new-1\n');
    const records = await tail.poll();
    expect(records.map((r) => r.line)).toEqual(['new-1']);
    expect(records[0].nextOffset).toBe(Buffer.byteLength('old-1\nold-2\nnew-1\n'));
    await tail.close();
  });

  it('holds a partial final line until its newline arrives', async () => {
    const dir = await tempRoot();
    const file = path.join(dir, 'WoWCombatLog.txt');
    await writeFile(file, '');
    const tail = new CombatLogTail(file, { attachMode: 'start', readChunkBytes: 4 });
    await tail.attach();

    await appendFile(file, 'partial');
    expect(await tail.poll()).toEqual([]);
    expect(tail.snapshot().pendingBytes).toBe(Buffer.byteLength('partial'));

    await appendFile(file, '-done\n');
    const records = await tail.poll();
    expect(records.map((r) => r.line)).toEqual(['partial-done']);
    expect(tail.snapshot().pendingBytes).toBe(0);
    await tail.close();
  });

  it('recovers safely after in-place truncation', async () => {
    const dir = await tempRoot();
    const file = path.join(dir, 'WoWCombatLog.txt');
    await writeFile(file, 'first\nsecond\n');
    const tail = new CombatLogTail(file, { attachMode: 'start' });
    await tail.attach();
    expect((await tail.poll()).map((r) => r.line)).toEqual(['first', 'second']);

    await truncate(file, 0);
    await appendFile(file, 'after-truncate\n');
    expect((await tail.poll()).map((r) => r.line)).toEqual(['after-truncate']);
    await tail.close();
  });

  it('starts a replacement file from zero instead of reusing an old inode checkpoint', async () => {
    const dir = await tempRoot();
    const file = path.join(dir, 'WoWCombatLog.txt');
    const rotated = path.join(dir, 'WoWCombatLog.old.txt');
    await writeFile(file, 'before\n');
    const first = new CombatLogTail(file, { attachMode: 'start' });
    const attached = await first.attach();
    const firstRecords = await first.poll();
    const oldCheckpoint = firstRecords.at(-1).nextOffset;
    await first.close();

    await rename(file, rotated);
    await writeFile(file, 'new-file-first\n');
    const recovered = new CombatLogTail(file, {
      recoveryOffset: oldCheckpoint,
      recoveryIdentity: attached.identity,
    });
    await recovered.attach();
    expect((await recovered.poll()).map((r) => r.line)).toEqual(['new-file-first']);
    await recovered.close();
  });
});

describe('DurableCombatLogSpool', () => {
  it('writes a durable journal record before advancing checkpoint state', async () => {
    const dir = await tempRoot();
    const spool = new DurableCombatLogSpool(dir);
    await spool.open();
    await spool.append({
      source: '/Logs/WoWCombatLog.txt',
      fileIdentity: '1:2',
      startOffset: 0,
      nextOffset: 10,
      event: { event: 'SPELL_DAMAGE' },
    });
    const journal = (await readFile(path.join(dir, 'events.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    expect(journal).toHaveLength(1);
    expect(journal[0].sequence).toBe(1);
    expect(journal[0].nextOffset).toBe(10);
    expect(state.sequence).toBe(1);
    expect(state.sourceOffset).toBe(10);
    await spool.close();
  });

  it('recovers a fsynced journal record when checkpoint state lags behind it', async () => {
    const dir = await tempRoot();
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({
      version: 1, sequence: 0, source: '/Logs/WoWCombatLog.txt', fileIdentity: '1:2', sourceOffset: 0,
    }));
    await writeFile(path.join(dir, 'events.ndjson'), `${JSON.stringify({
      version: 1,
      sequence: 1,
      source: '/Logs/WoWCombatLog.txt',
      fileIdentity: '1:2',
      startOffset: 0,
      nextOffset: 42,
      collectedAt: '2026-09-01T00:00:00.000Z',
      event: { event: 'SPELL_DAMAGE' },
    })}\n`);
    const spool = new DurableCombatLogSpool(dir);
    const recovered = await spool.open();
    expect(recovered.sequence).toBe(1);
    expect(recovered.sourceOffset).toBe(42);
    await spool.close();
  });

  it('fails closed when state is ahead of the durable journal', async () => {
    const dir = await tempRoot();
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, sequence: 2, sourceOffset: 99 }));
    await writeFile(path.join(dir, 'events.ndjson'), `${JSON.stringify({ sequence: 1, nextOffset: 42 })}\n`);
    const spool = new DurableCombatLogSpool(dir);
    await expect(spool.open()).rejects.toThrow(/state is ahead/i);
  });
});
