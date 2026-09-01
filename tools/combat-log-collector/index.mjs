import path from 'node:path';
import { CombatLogTail } from './tail.mjs';
import { parseCombatLogLine } from './parser.mjs';
import { DurableCombatLogSpool } from './spool.mjs';

/**
 * Shadow collector composition. It intentionally stops at the durable local
 * spool: no network upload, causality, mechanic classification or scoring is
 * allowed in Block A.
 */
export async function openShadowCollector({ logPath, spoolDirectory, attachMode = 'eof' }) {
  const sourcePath = path.resolve(logPath);
  const spool = new DurableCombatLogSpool(spoolDirectory);
  const recovered = await spool.open();
  const recoveredSource = recovered.source ? path.resolve(recovered.source) : null;
  const sameSource = recoveredSource === sourcePath;
  const tail = new CombatLogTail(sourcePath, {
    attachMode,
    recoveryOffset: sameSource ? recovered.sourceOffset : null,
    recoveryIdentity: sameSource ? recovered.fileIdentity : null,
  });
  try {
    await tail.attach();
  } catch (error) {
    await spool.close().catch(() => {});
    throw error;
  }

  // poll() advances the in-memory file cursor. Records therefore remain in
  // this queue until their journal append + fsync + checkpoint succeeds. If
  // append N fails, N..end are retried in-process; after a process crash the
  // durable checkpoint still points to N-1 and the tail rereads them.
  const pendingRecords = [];

  return {
    async collectAvailable() {
      if (!pendingRecords.length) pendingRecords.push(...(await tail.poll()));
      const appended = [];
      while (pendingRecords.length) {
        const record = pendingRecords[0];
        const event = parseCombatLogLine(record.line);
        const persisted = await spool.append({
          source: sourcePath,
          fileIdentity: record.fileIdentity,
          startOffset: record.startOffset,
          nextOffset: record.nextOffset,
          event,
        });
        pendingRecords.shift();
        appended.push(persisted);
      }
      return appended;
    },
    snapshot() {
      return { tail: tail.snapshot(), spool: spool.checkpoint(), pendingRecords: pendingRecords.length };
    },
    async close() {
      await tail.close();
      await spool.close();
    },
  };
}

export { CombatLogTail, DurableCombatLogSpool, parseCombatLogLine };
