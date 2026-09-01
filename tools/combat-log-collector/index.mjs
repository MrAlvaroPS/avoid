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
  // this queue until the whole journal batch is appended, fsynced and its
  // checkpoint committed. On failure the queue is untouched and can retry;
  // after process death the durable checkpoint makes the tail reread it.
  const pendingRecords = [];

  return {
    async collectAvailable() {
      if (!pendingRecords.length) pendingRecords.push(...(await tail.poll()));
      if (!pendingRecords.length) return [];

      const batch = pendingRecords.map((record) => ({
        source: sourcePath,
        fileIdentity: record.fileIdentity,
        startOffset: record.startOffset,
        nextOffset: record.nextOffset,
        event: parseCombatLogLine(record.line),
      }));
      const persisted = await spool.appendBatch(batch);
      pendingRecords.splice(0, batch.length);
      return persisted;
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
