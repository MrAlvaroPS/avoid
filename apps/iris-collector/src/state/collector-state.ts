import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CollectorClockContext,
  CombatLogFormatState,
  SequenceString,
  SpoolRecord,
} from '../../../../packages/combat-log-contracts/src/index.ts';
import { sequenceFromWire } from '../../../../packages/combat-log-contracts/src/index.ts';

export interface CollectorState {
  version: 1;
  sourcePath: string;
  fileIdentity: string;
  streamId: string;
  lastCommittedOffset: number;
  lastUploadedOffset: number;
  lastSequence: SequenceString;
  formatState: CombatLogFormatState;
  clockContext: CollectorClockContext;
  updatedAt: string;
}

export class CollectorStateStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<CollectorState | null> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as CollectorState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(state: CollectorState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
  }
}

export function reconcileStateWithSpool(state: CollectorState, lastRecord: SpoolRecord | null): CollectorState {
  if (!lastRecord || lastRecord.streamId !== state.streamId) return state;
  if (sequenceFromWire(lastRecord.sequence) <= sequenceFromWire(state.lastSequence)) return state;
  return {
    ...state,
    lastSequence: lastRecord.sequence,
    lastCommittedOffset: Math.max(state.lastCommittedOffset, lastRecord.committedOffset),
    formatState: { ...lastRecord.formatState },
    updatedAt: new Date().toISOString(),
  };
}
