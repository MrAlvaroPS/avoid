import { CombatLogTail } from './tail.mjs';
import { parseCombatLogLine } from './parser.mjs';
import { DurableCombatLogSpool } from './spool.mjs';

/**
 * Shadow collector composition. It intentionally stops at the durable local
 * spool: no network upload, causality, mechanic classification or scoring is
 * allowed in Block A.
 */
export async function openShadowCollector({ logPath, spoolDirectory, attachMode = 'eof' }) {
  const spool = new DurableCombatLogSpool(spoolDirectory);
  const recovered = await spool.open();
  const sameSource = recovered.source === logPath;
  const tail = new CombatLogTail(logPath, {
    attachMode,
    recoveryOffset: sameSource ? recovered.sourceOffset : null,
    recoveryIdentity: sameSource ? recovered.fileIdentity : null,
  });
  await tail.attach();

  return {
    async collectAvailable() {
      const lines = await tail.poll();
      const appended = [];
      for (const record of lines) {
        const event = parseCombatLogLine(record.line);
        appended.push(
          await spool.append({
            source: logPath,
            fileIdentity: record.fileIdentity,
            startOffset: record.startOffset,
            nextOffset: record.nextOffset,
            event,
          }),
        );
      }
      return appended;
    },
    snapshot() {
      return { tail: tail.snapshot(), spool: spool.checkpoint() };
    },
    async close() {
      await tail.close();
      await spool.close();
    },
  };
}

export { CombatLogTail, DurableCombatLogSpool, parseCombatLogLine };
