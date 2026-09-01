import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function fsyncDirectory(dir) {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Directory fsync is not portable on every Windows/filesystem combination.
    // Journal and state-file fsync remain mandatory; directory fsync is an
    // additional rename-durability barrier where the platform supports it.
    if (!['EPERM', 'EACCES', 'EISDIR', 'ENOTSUP', 'EINVAL'].includes(error?.code)) throw error;
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
 *   1. append one or more full NDJSON records
 *   2. fsync journal once for the batch
 *   3. atomically advance state to the last record
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
    const lastNonEmptyIndex = (() => {
      for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].trim()) return i;
      return -1;
    })();

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // A syntactically torn last record can result from a process/filesystem
        // failure during append. Earlier complete records are still valid.
        if (i === lastNonEmptyIndex) break;
        throw new Error('Corrupt non-final record in combat-log spool');
      }
      // Structurally invalid but valid JSON is corruption, not a torn write.
      if (!Number.isInteger(record.sequence) || record.sequence < 1) {
        throw new Error('Invalid sequence in combat-log spool');
      }
      if (last && record.sequence <= last.sequence) {
        throw new Error('Non-monotonic sequence in combat-log spool');
      }
      last = record;
    }

    const journalSequence = last?.sequence ?? 0;
    const stateSequence = Number.isInteger(persisted.sequence) ? persisted.sequence : 0;
    if (stateSequence > journalSequence) {
      throw new Error('Combat-log spool state is ahead of its durable journal');
    }

    if (last && journalSequence >= stateSequence) {
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

  async append(item) {
    const records = await this.appendBatch([item]);
    return records[0];
  }

  async appendBatch(items) {
    if (!this.journal) throw new Error('Spool is not open');
    if (!Array.isArray(items) || items.length === 0) return [];

    const collectedAt = new Date().toISOString();
    const records = items.map((item, index) => ({
      version: 1,
      sequence: this.sequence + index + 1,
      source: item.source,
      fileIdentity: item.fileIdentity,
      startOffset: item.startOffset,
      nextOffset: item.nextOffset,
      collectedAt,
      event: item.event,
    }));

    // One write and one fsync per poll batch. The checkpoint does not advance
    // until every record in this buffer is durable.
    await this.journal.write(records.map((record) => `${JSON.stringify(record)}\n`).join(''));
    await this.journal.sync();

    const last = records.at(-1);
    const state = {
      version: 1,
      sequence: last.sequence,
      source: last.source,
      fileIdentity: last.fileIdentity,
      sourceOffset: last.nextOffset,
      updatedAt: last.collectedAt,
    };
    await this.#writeStateAtomic(state);
    this.sequence = last.sequence;
    this.state = state;
    return records;
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
