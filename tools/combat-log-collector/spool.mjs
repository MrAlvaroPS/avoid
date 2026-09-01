import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function fsyncDirectory(dir) {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Durable local shadow spool.
 *
 * Ordering invariant:
 *   1. append full NDJSON record
 *   2. fsync journal
 *   3. atomically advance state
 *
 * The journal is authoritative during recovery. If a crash happens after
 * step 2 but before step 3, recovery can safely advance from the last valid
 * journal line instead of replaying the same source bytes.
 */
export class DurableCombatLogSpool {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.journalPath = path.join(directory, options.journalName ?? 'events.ndjson');
    this.statePath = path.join(directory, options.stateName ?? 'state.json');
    this.journal = null;
    this.sequence = 0;
    this.state = null;
  }

  async open() {
    await mkdir(this.directory, { recursive: true });
    const recovered = await this.recover();
    this.sequence = recovered.sequence;
    this.state = recovered;
    this.journal = await open(this.journalPath, 'a+');
    return recovered;
  }

  async recover() {
    const persisted = (await readJson(this.statePath)) ?? {
      version: 1,
      sequence: 0,
      source: null,
      fileIdentity: null,
      sourceOffset: null,
      updatedAt: null,
    };

    let journalText = '';
    try {
      journalText = await readFile(this.journalPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    let last = null;
    const lines = journalText.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (Number.isInteger(record.sequence) && record.sequence > (last?.sequence ?? 0)) last = record;
      } catch {
        // A torn final write must not poison all earlier durable records.
        // Non-final corruption is surfaced because silently skipping it could
        // create an untraceable hole in the event stream.
        if (line !== lines.at(-1)) throw new Error('Corrupt non-final record in combat-log spool');
      }
    }

    if (last && last.sequence >= (persisted.sequence ?? 0)) {
      return {
        version: 1,
        sequence: last.sequence,
        source: last.source ?? persisted.source ?? null,
        fileIdentity: last.fileIdentity ?? persisted.fileIdentity ?? null,
        sourceOffset: last.nextOffset ?? persisted.sourceOffset ?? null,
        updatedAt: last.collectedAt ?? persisted.updatedAt ?? null,
      };
    }
    return persisted;
  }

  async append({ source, fileIdentity, startOffset, nextOffset, event }) {
    if (!this.journal) throw new Error('Spool is not open');
    const sequence = this.sequence + 1;
    const record = {
      version: 1,
      sequence,
      source,
      fileIdentity,
      startOffset,
      nextOffset,
      collectedAt: new Date().toISOString(),
      event,
    };
    await this.journal.write(`${JSON.stringify(record)}\n`);
    await this.journal.sync();

    const state = {
      version: 1,
      sequence,
      source,
      fileIdentity,
      sourceOffset: nextOffset,
      updatedAt: record.collectedAt,
    };
    await this.#writeStateAtomic(state);
    this.sequence = sequence;
    this.state = state;
    return record;
  }

  async #writeStateAtomic(state) {
    const temp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const tempHandle = await open(temp, 'r');
    try {
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    await rename(temp, this.statePath);
    await fsyncDirectory(this.directory);
  }

  checkpoint() {
    return this.state;
  }

  async close() {
    if (this.journal) await this.journal.close();
    this.journal = null;
  }
}
