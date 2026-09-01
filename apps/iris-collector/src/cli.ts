import { homedir } from 'node:os';
import { join } from 'node:path';
import { IrisCollector } from './collector.ts';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function defaultDataDir(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'IRIS Raid Intelligence', 'collector');
  }
  return join(homedir(), '.iris-collector');
}

const sourcePath = argValue('--log') ?? process.env.IRIS_COMBAT_LOG_PATH;
if (!sourcePath) {
  console.error('Usage: npm start -- --log "<path-to-WoWCombatLog.txt>" [--once] [--poll-ms 500]');
  process.exit(2);
}

const dataDir = argValue('--data-dir') ?? process.env.IRIS_COLLECTOR_DATA_DIR ?? defaultDataDir();
const pollMs = Number(argValue('--poll-ms') ?? '500');
if (!Number.isFinite(pollMs) || pollMs < 100) {
  console.error('--poll-ms must be a number >= 100');
  process.exit(2);
}

const collector = new IrisCollector({
  sourcePath,
  statePath: join(dataDir, 'state.json'),
  spoolPath: join(dataDir, 'spool', 'facts.jsonl'),
});

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

async function runPoll(): Promise<void> {
  const diagnostics = await collector.pollOnce();
  const summary = [
    `stream=${diagnostics.streamId}`,
    `lines=${diagnostics.linesRead}`,
    `offset=${diagnostics.lastCommittedOffset}`,
    `sequence=${diagnostics.lastSequence}`,
    `advanced=${String(diagnostics.advancedEnabled)}`,
    `unknown=${diagnostics.unknownEvents}`,
  ];
  if (diagnostics.rotationReason) summary.push(`rotation=${diagnostics.rotationReason}`);
  console.log(`[IRIS collector] ${summary.join(' ')}`);
  if (diagnostics.advancedEnabled === false) {
    console.warn('[IRIS collector] Advanced Combat Logging is disabled; telemetry is degraded.');
  }
}

try {
  do {
    await runPoll();
    if (hasArg('--once')) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (!stopping);
} catch (error) {
  console.error('[IRIS collector] fatal:', error);
  process.exitCode = 1;
}
