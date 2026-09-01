import { open, stat } from 'node:fs/promises';

function fileIdentity(s) {
  return `${s.dev ?? 'dev'}:${s.ino ?? 'ino'}:${s.birthtimeMs ?? 'birth'}`;
}

/**
 * Pull-based tailer for WoWCombatLog.txt.
 *
 * The cursor is a byte offset, not a character count. Returned nextOffset
 * always points immediately after a newline, so callers can checkpoint only
 * complete records. A partial final line remains buffered and is never
 * emitted as an event.
 */
export class CombatLogTail {
  constructor(path, options = {}) {
    this.path = path;
    this.attachMode = options.attachMode ?? 'eof';
    this.recoveryOffset = options.recoveryOffset ?? null;
    this.recoveryIdentity = options.recoveryIdentity ?? null;
    this.readChunkBytes = options.readChunkBytes ?? 256 * 1024;
    this.anchorBytesMax = options.anchorBytesMax ?? 64;
    this.handle = null;
    this.identity = null;
    this.readOffset = 0;
    this.lineStartOffset = 0;
    this.pending = Buffer.alloc(0);
    this.anchorStart = 0;
    this.anchor = Buffer.alloc(0);
    this.initialized = false;
  }

  async attach() {
    const s = await stat(this.path);
    const currentIdentity = fileIdentity(s);
    await this.#openHandle(s);
    const recoveryMatchesFile =
      this.recoveryOffset != null &&
      (this.recoveryIdentity == null || this.recoveryIdentity === currentIdentity);
    if (recoveryMatchesFile) {
      this.readOffset = Math.max(0, Math.min(Number(this.recoveryOffset), s.size));
    } else if (this.recoveryOffset != null && this.recoveryIdentity != null && this.recoveryIdentity !== currentIdentity) {
      // The durable checkpoint belongs to the previous file behind this path.
      // A replacement can already contain new events, so start at byte 0.
      this.readOffset = 0;
    } else if (this.attachMode === 'start') {
      this.readOffset = 0;
    } else {
      // Live mode: do not replay an arbitrary historical log when the
      // collector is enabled for the first time.
      this.readOffset = s.size;
    }
    this.lineStartOffset = this.readOffset;
    this.pending = Buffer.alloc(0);
    await this.#captureAnchor();
    this.initialized = true;
    return { offset: this.readOffset, identity: this.identity, size: s.size };
  }

  async #openHandle(s) {
    if (this.handle) await this.handle.close().catch(() => {});
    this.handle = await open(this.path, 'r');
    this.identity = fileIdentity(s);
  }

  async #captureAnchor() {
    if (!this.handle || this.readOffset <= 0 || this.anchorBytesMax <= 0) {
      this.anchorStart = this.readOffset;
      this.anchor = Buffer.alloc(0);
      return;
    }
    const size = Math.min(this.anchorBytesMax, this.readOffset);
    const start = this.readOffset - size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await this.handle.read(buffer, 0, size, start);
    this.anchorStart = start;
    this.anchor = buffer.subarray(0, bytesRead);
  }

  async #anchorStillMatches(s) {
    if (!this.handle || !this.anchor.length) return true;
    if (s.size < this.anchorStart + this.anchor.length) return false;
    const current = Buffer.alloc(this.anchor.length);
    const { bytesRead } = await this.handle.read(current, 0, current.length, this.anchorStart);
    return bytesRead === this.anchor.length && current.equals(this.anchor);
  }

  #resetCursor() {
    this.readOffset = 0;
    this.lineStartOffset = 0;
    this.pending = Buffer.alloc(0);
    this.anchorStart = 0;
    this.anchor = Buffer.alloc(0);
  }

  async #refreshFile() {
    const s = await stat(this.path);
    const identity = fileIdentity(s);
    if (!this.initialized) {
      await this.attach();
      return stat(this.path);
    }

    if (identity !== this.identity) {
      // Rotation/replacement: the pathname now refers to a new file. Start
      // from byte 0 because any content in the replacement was not observed.
      await this.#openHandle(s);
      this.#resetCursor();
    } else if (s.size < this.readOffset || !(await this.#anchorStillMatches(s))) {
      // Size regression catches ordinary truncation. The anchor catches the
      // harder case where a file is truncated and rewritten past our previous
      // offset between two polls while keeping the same inode.
      this.#resetCursor();
    }
    return s;
  }

  async poll() {
    const s = await this.#refreshFile();
    if (s.size <= this.readOffset) return [];

    const records = [];
    while (this.readOffset < s.size) {
      const remaining = s.size - this.readOffset;
      const size = Math.min(this.readChunkBytes, remaining);
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await this.handle.read(chunk, 0, size, this.readOffset);
      if (!bytesRead) break;
      const actual = chunk.subarray(0, bytesRead);
      this.readOffset += bytesRead;
      this.pending = this.pending.length ? Buffer.concat([this.pending, actual]) : actual;

      let newline;
      while ((newline = this.pending.indexOf(0x0a)) !== -1) {
        let lineBuffer = this.pending.subarray(0, newline);
        if (lineBuffer.length && lineBuffer[lineBuffer.length - 1] === 0x0d) lineBuffer = lineBuffer.subarray(0, -1);
        const nextOffset = this.lineStartOffset + newline + 1;
        records.push({
          line: lineBuffer.toString('utf8'),
          startOffset: this.lineStartOffset,
          nextOffset,
          fileIdentity: this.identity,
        });
        this.pending = this.pending.subarray(newline + 1);
        this.lineStartOffset = nextOffset;
      }
    }
    await this.#captureAnchor();
    return records;
  }

  snapshot() {
    return {
      path: this.path,
      identity: this.identity,
      readOffset: this.readOffset,
      checkpointableOffset: this.lineStartOffset,
      pendingBytes: this.pending.length,
    };
  }

  async close() {
    if (this.handle) await this.handle.close();
    this.handle = null;
  }
}
