import type { DefensiveAuditDiscordSendResult } from './player-defensive-audit-contract.ts';

export async function sendDiscordParts(
  parts: readonly string[],
  startPartIndex: number,
  send: (content: string, index: number) => Promise<string>,
): Promise<Omit<DefensiveAuditDiscordSendResult, 'channelName'>> {
  const messageIds: string[] = [];
  for (let index = startPartIndex; index < parts.length; index++) {
    try {
      messageIds.push(await send(parts[index], index));
    } catch (err) {
      return {
        ok: false,
        messageIds,
        parts: parts.length,
        sentParts: index,
        failedPartIndex: index,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return {
    ok: true,
    messageIds,
    parts: parts.length,
    sentParts: parts.length,
    failedPartIndex: null,
  };
}
