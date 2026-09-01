import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

export interface FileIdentitySnapshot {
  identity: string;
  size: number;
  modifiedAtMs: number;
}

export interface CompleteLogLine {
  text: string;
  byteStart: number;
  byteEndExclusive: number;
  lineHash: string;
}

export interface TailReadResult {
  kind: 'ok' | 'truncated';
  observedSize: number;
  nextCommittedOffset: number;
  lines: CompleteLogLine[];
}

export interface IncrementalTailOptions {
  chunkSize?: number;
  maxReadBytes?: number;
  maxLineBytes?: number;
}

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

function shortHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

export async function snapshotFileIdentity(path: string): Promise<FileIdentitySnapshot> {
  const current = await stat(path);
  return {
    identity: `${current.dev}:${current.ino}:${Math.trunc(current.birthtimeMs)}`,
    size: current.size,
    modifiedAtMs: current.mtimeMs,
  };
}

export async function readCompleteLines(
  path: string,
  fromOffset: number,
  options: IncrementalTailOptions = {},
): Promise<TailReadResult> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) throw new Error(`Invalid byte offset: ${fromOffset}`);

  const current = await stat(path);
  if (current.size < fromOffset) {
    return { kind: 'truncated', observedSize: current.size, nextCommittedOffset: 0, lines: [] };
  }
  if (current.size === fromOffset) {
    return { kind: 'ok', observedSize: current.size, nextCommittedOffset: fromOffset, lines: [] };
  }

  const handle = await open(path, 'r');
  try {
    const hardEnd = Math.min(current.size, fromOffset + maxReadBytes);
    const lines: CompleteLogLine[] = [];
    let absoluteCursor = fromOffset;
    let pending = Buffer.alloc(0);
    let pendingStart = fromOffset;
    let nextCommittedOffset = fromOffset;

    while (absoluteCursor < hardEnd) {
      const requested = Math.min(chunkSize, hardEnd - absoluteCursor);
      const chunk = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(chunk, 0, requested, absoluteCursor);
      if (bytesRead === 0) break;
      absoluteCursor += bytesRead;

      const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let localStart = 0;
      let newlineIndex = data.indexOf(0x0a, localStart);
      while (newlineIndex !== -1) {
        const rawLine = data.subarray(localStart, newlineIndex);
        const withoutCr = rawLine.length && rawLine[rawLine.length - 1] === 0x0d ? rawLine.subarray(0, -1) : rawLine;
        const byteStart = pendingStart + localStart;
        const byteEndExclusive = pendingStart + newlineIndex + 1;
        lines.push({
          text: withoutCr.toString('utf8'),
          byteStart,
          byteEndExclusive,
          lineHash: shortHash(withoutCr),
        });
        nextCommittedOffset = byteEndExclusive;
        localStart = newlineIndex + 1;
        newlineIndex = data.indexOf(0x0a, localStart);
      }

      pending = data.subarray(localStart);
      pendingStart = nextCommittedOffset;
      if (pending.length > maxLineBytes) {
        throw new Error(`Combat-log line exceeds ${maxLineBytes} bytes without newline at offset ${pendingStart}`);
      }
    }

    return { kind: 'ok', observedSize: current.size, nextCommittedOffset, lines };
  } finally {
    await handle.close();
  }
}
