import { mkdir, open, stat, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SequenceString, SpoolRecord } from '../../../../packages/combat-log-contracts/src/index.ts';
import { sequenceFromWire } from '../../../../packages/combat-log-contracts/src/index.ts';

const DEFAULT_TAIL_BYTES = 1024 * 1024;

export class JsonlSpool {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(records: SpoolRecord[]): Promise<number> {
    if (!records.length) return 0;
    await mkdir(dirname(this.path), { recursive: true });
    const last = await this.lastRecord();
    const lastSequence = last ? sequenceFromWire(last.sequence) : -1n;
    const newRecords = records.filter((record) => sequenceFromWire(record.sequence) > lastSequence);
    if (!newRecords.length) return 0;

    for (let i = 1; i < newRecords.length; i += 1) {
      if (sequenceFromWire(newRecords[i].sequence) <= sequenceFromWire(newRecords[i - 1].sequence)) {
        throw new Error('Spool append requires strictly increasing sequence numbers');
      }
    }

    const serialized = newRecords.map((record) => JSON.stringify(record)).join('\n') + '\n';
    const handle = await open(this.path, 'a');
    try {
      await handle.write(serialized, undefined, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return newRecords.length;
  }

  async lastRecord(): Promise<SpoolRecord | null> {
    let fileSize: number;
    try {
      fileSize = (await stat(this.path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (fileSize === 0) return null;

    const readSize = Math.min(fileSize, DEFAULT_TAIL_BYTES);
    const start = fileSize - readSize;
    const handle = await open(this.path, 'r');
    let buffer: Buffer;
    try {
      buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, start);
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    let end = buffer.length;
    while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1;
    while (end > 0) {
      const previousNewline = buffer.lastIndexOf(0x0a, end - 1);
      const lineStart = previousNewline + 1;
      const candidate = buffer.subarray(lineStart, end).toString('utf8').trim();
      if (candidate) {
        try {
          return JSON.parse(candidate) as SpoolRecord;
        } catch {
          if (start + end === fileSize) {
            await truncate(this.path, start + lineStart);
          }
        }
      }
      if (previousNewline < 0) break;
      end = previousNewline;
      while (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
    }

    throw new Error(`Unable to recover a complete spool record from the last ${readSize} bytes`);
  }

  async pendingAfter(uploadedSequence: SequenceString | null): Promise<SpoolRecord[]> {
    let text: string;
    try {
      const handle = await open(this.path, 'r');
      try {
        text = await handle.readFile({ encoding: 'utf8' });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const cutoff = uploadedSequence == null ? -1n : sequenceFromWire(uploadedSequence);
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SpoolRecord)
      .filter((record) => sequenceFromWire(record.sequence) > cutoff);
  }
}
