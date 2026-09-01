import { randomUUID } from 'node:crypto';
import { COLLECTOR_SPOOL_FORMAT_VERSION, toWireEvent, type SequenceString, type SpoolRecord } from '../../../packages/combat-log-contracts/src/index.ts';
import { CombatLogParser, CombatLogTimestampResolver } from '../../../packages/combat-log-parser/src/index.ts';
import { readCompleteLines, snapshotFileIdentity, verifyCommittedLine } from './file-tail/incremental-tail.ts';
import { JsonlSpool } from './spool/jsonl-spool.ts';
import { CollectorStateStore, reconcileStateWithSpool, type CollectorState } from './state/collector-state.ts';

export interface CollectorOptions {
  sourcePath: string;
  statePath: string;
  spoolPath: string;
  referenceDate?: Date;
  fixedOffsetMinutes?: number;
}

export interface PollDiagnostics {
  streamId: string;
  fileIdentity: string;
  observedSize: number;
  linesRead: number;
  recordsSpooled: number;
  unknownEvents: number;
  malformedLines: number;
  advancedEnabled: boolean | null;
  lastCommittedOffset: number;
  lastSequence: SequenceString;
  rotationReason?: 'file_identity_changed' | 'truncated' | 'content_rewritten';
}

function zeroSequence(): SequenceString {
  return '0' as SequenceString;
}

export class IrisCollector {
  private readonly stateStore: CollectorStateStore;
  private readonly spool: JsonlSpool;
  private readonly options: CollectorOptions;
  private parser: CombatLogParser;

  constructor(options: CollectorOptions) {
    this.options = options;
    this.stateStore = new CollectorStateStore(options.statePath);
    this.spool = new JsonlSpool(options.spoolPath);
    this.parser = this.createParser();
  }

  private createParser(): CombatLogParser {
    return new CombatLogParser(new CombatLogTimestampResolver({
      referenceDate: this.options.referenceDate,
      fixedOffsetMinutes: this.options.fixedOffsetMinutes,
    }));
  }

  private freshState(fileIdentity: string): CollectorState {
    this.parser = this.createParser();
    return {
      version: 1,
      sourcePath: this.options.sourcePath,
      fileIdentity,
      streamId: randomUUID(),
      lastCommittedOffset: 0,
      lastUploadedOffset: 0,
      lastSequence: zeroSequence(),
      lastCommittedLineStart: undefined,
      lastCommittedLineHash: undefined,
      formatState: { advancedEnabled: null },
      clockContext: this.parser.getClockContext(),
      updatedAt: new Date().toISOString(),
    };
  }

  async pollOnce(): Promise<PollDiagnostics> {
    const identity = await snapshotFileIdentity(this.options.sourcePath);
    let state = await this.stateStore.load();
    let rotationReason: PollDiagnostics['rotationReason'];

    if (!state || state.sourcePath !== this.options.sourcePath) {
      state = this.freshState(identity.identity);
      await this.stateStore.save(state);
    } else if (state.fileIdentity !== identity.identity) {
      rotationReason = 'file_identity_changed';
      state = this.freshState(identity.identity);
      await this.stateStore.save(state);
    } else if (identity.size < state.lastCommittedOffset) {
      rotationReason = 'truncated';
      state = this.freshState(identity.identity);
      await this.stateStore.save(state);
    } else if (
      state.lastCommittedLineStart != null &&
      state.lastCommittedLineHash &&
      !(await verifyCommittedLine(
        this.options.sourcePath,
        state.lastCommittedLineStart,
        state.lastCommittedOffset,
        state.lastCommittedLineHash,
      ))
    ) {
      rotationReason = 'content_rewritten';
      state = this.freshState(identity.identity);
      await this.stateStore.save(state);
    }

    state = reconcileStateWithSpool(state, await this.spool.lastRecord());
    this.parser.hydrateFormatState(state.formatState);

    const read = await readCompleteLines(this.options.sourcePath, state.lastCommittedOffset);
    if (read.kind === 'truncated') {
      rotationReason = 'truncated';
      state = this.freshState(identity.identity);
      await this.stateStore.save(state);
      return this.pollOnce();
    }

    let sequence = BigInt(state.lastSequence);
    const records: SpoolRecord[] = [];
    let unknownEvents = 0;
    let malformedLines = 0;
    for (const line of read.lines) {
      sequence += 1n;
      const event = this.parser.parseLine(line.text, {
        streamId: state.streamId,
        sequence,
        byteStart: line.byteStart,
        byteEndExclusive: line.byteEndExclusive,
        lineHash: line.lineHash,
      });
      if (event.payload.kind === 'unknown') unknownEvents += 1;
      if (event.eventType === 'MALFORMED_LINE') malformedLines += 1;
      records.push({
        version: COLLECTOR_SPOOL_FORMAT_VERSION,
        streamId: state.streamId,
        sequence: sequence.toString() as SequenceString,
        committedOffset: line.byteEndExclusive,
        formatState: this.parser.getFormatState(),
        event: toWireEvent(event),
      });
    }

    const recordsSpooled = await this.spool.append(records);
    if (records.length) {
      const last = records[records.length - 1];
      state = {
        ...state,
        lastCommittedOffset: last.committedOffset,
        lastSequence: last.sequence,
        lastCommittedLineStart: last.event.rawRef.byteStart,
        lastCommittedLineHash: last.event.rawRef.lineHash,
        formatState: { ...last.formatState },
        updatedAt: new Date().toISOString(),
      };
      await this.stateStore.save(state);
    }

    return {
      streamId: state.streamId,
      fileIdentity: state.fileIdentity,
      observedSize: read.observedSize,
      linesRead: read.lines.length,
      recordsSpooled,
      unknownEvents,
      malformedLines,
      advancedEnabled: state.formatState.advancedEnabled,
      lastCommittedOffset: state.lastCommittedOffset,
      lastSequence: state.lastSequence,
      rotationReason,
    };
  }
}
