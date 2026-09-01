import type {
  CombatLogFormatState,
  RawCombatLogEvent,
} from '../../combat-log-contracts/src/index.ts';
import {
  CombatLogParser as CoreCombatLogParser,
  CombatLogTimestampResolver as CoreCombatLogTimestampResolver,
  tokenizeCombatLogCsv,
} from './core.ts';
import type {
  ParserLineContext,
  TimestampResolverOptions,
} from './core.ts';

export { tokenizeCombatLogCsv };
export type { ParserLineContext, TimestampResolverOptions } from './core.ts';

interface FlexibleTimestampParts {
  month: number;
  day: number;
  year?: number;
  hour: number;
  minute: number;
  second: number;
  fractionalMilliseconds: number;
  fractionRaw: string;
}

const FLEXIBLE_ENVELOPE = /^(\d{1,2}\/\d{1,2}(?:\/\d{4})?\s+\d{2}:\d{2}:\d{2}\.\d{1,9})\s{2,}(.*)$/;
const FLEXIBLE_TIMESTAMP = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{2}):(\d{2}):(\d{2})\.(\d{1,9})$/;

function parseFlexibleTimestamp(rawTimestamp: string): FlexibleTimestampParts {
  const match = FLEXIBLE_TIMESTAMP.exec(rawTimestamp);
  if (!match) throw new Error(`Unsupported combat-log timestamp: ${rawTimestamp}`);
  const [, monthRaw, dayRaw, yearRaw, hourRaw, minuteRaw, secondRaw, fractionRaw] = match;
  return {
    month: Number(monthRaw),
    day: Number(dayRaw),
    year: yearRaw ? Number(yearRaw) : undefined,
    hour: Number(hourRaw),
    minute: Number(minuteRaw),
    second: Number(secondRaw),
    fractionalMilliseconds: Number(`0.${fractionRaw}`) * 1000,
    fractionRaw,
  };
}

function normalizedTimestampForCore(rawTimestamp: string): string {
  const parts = parseFlexibleTimestamp(rawTimestamp);
  const milliseconds = `${parts.fractionRaw}000`.slice(0, 3);
  return `${parts.month}/${parts.day} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}.${milliseconds}`;
}

function prefixWidth(eventType: string): 0 | 1 | 3 | null {
  if (eventType === 'DAMAGE_SPLIT' || eventType === 'DAMAGE_SHIELD' || eventType === 'DAMAGE_SHIELD_MISSED') return 3;
  if (eventType.startsWith('SWING_')) return 0;
  if (eventType.startsWith('ENVIRONMENTAL_')) return 1;
  if (
    eventType.startsWith('SPELL_') ||
    eventType.startsWith('SPELL_PERIODIC_') ||
    eventType.startsWith('SPELL_BUILDING_') ||
    eventType.startsWith('RANGE_')
  ) return 3;
  if (
    eventType === 'PARTY_KILL' ||
    eventType === 'UNIT_DIED' ||
    eventType === 'UNIT_DESTROYED' ||
    eventType === 'UNIT_DISSIPATES'
  ) return 0;
  return null;
}

function suffixBounds(eventType: string): { min: number; max: number } | null {
  if (eventType.endsWith('_AURA_APPLIED_DOSE') || eventType.endsWith('_AURA_REMOVED_DOSE')) return { min: 1, max: 2 };
  if (eventType.endsWith('_AURA_APPLIED') || eventType.endsWith('_AURA_REMOVED')) return { min: 1, max: 2 };
  if (eventType.endsWith('_AURA_REFRESH') || eventType.endsWith('_AURA_BROKEN')) return { min: 1, max: 2 };
  if (eventType.endsWith('_CAST_START') || eventType.endsWith('_CAST_SUCCESS')) return { min: 0, max: 0 };
  if (eventType.endsWith('_CAST_FAILED')) return { min: 1, max: 1 };
  if (eventType.endsWith('_INTERRUPT')) return { min: 3, max: 3 };
  if (eventType.endsWith('_DISPEL_FAILED')) return { min: 3, max: 3 };
  if (eventType.endsWith('_DISPEL') || eventType.endsWith('_STOLEN')) return { min: 4, max: 4 };
  if (eventType.endsWith('_ENERGIZE')) return { min: 3, max: 4 };
  if (eventType.endsWith('_MISSED')) return { min: 2, max: 4 };
  if (eventType.endsWith('_HEAL')) return { min: 4, max: 6 };
  if (eventType.endsWith('_DAMAGE')) return { min: 10, max: 12 };
  if (eventType === 'UNIT_DIED' || eventType === 'UNIT_DESTROYED' || eventType === 'UNIT_DISSIPATES') return { min: 0, max: 2 };
  return null;
}

function looksLikeInfoGuid(value: string | undefined): boolean {
  if (!value) return false;
  return value === 'nil' || value === '0000000000000000' || /^[A-Za-z][A-Za-z0-9]*-/.test(value);
}

function canSafelyParseWithoutAdvanced(tokens: string[], eventType: string): boolean {
  const width = prefixWidth(eventType);
  const bounds = suffixBounds(eventType);
  if (width == null || bounds == null || tokens.length < 9 + width) return false;
  const cursor = 9 + width;
  const remaining = tokens.length - cursor;

  if (remaining >= 17 + bounds.min && looksLikeInfoGuid(tokens[cursor])) return false;
  return remaining >= bounds.min && remaining <= bounds.max;
}

export class CombatLogTimestampResolver {
  readonly timeZone: string;
  readonly referenceYear: number;
  private readonly fixedOffsetMinutes?: number;
  private readonly referenceDateMs: number;
  private lastResolvedMs?: number;

  constructor(options: TimestampResolverOptions = {}) {
    const referenceDate = options.referenceDate ?? new Date();
    this.referenceYear = referenceDate.getFullYear();
    this.referenceDateMs = referenceDate.getTime();
    this.fixedOffsetMinutes = options.fixedOffsetMinutes;
    this.timeZone = options.fixedOffsetMinutes == null
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
      : `UTC${options.fixedOffsetMinutes >= 0 ? '+' : ''}${options.fixedOffsetMinutes / 60}`;
  }

  getClockContext() {
    return { timeZone: this.timeZone, referenceYear: this.referenceYear, source: 'logger_local_clock' as const };
  }

  resolve(rawTimestamp: string): number {
    const parts = parseFlexibleTimestamp(rawTimestamp);
    const candidateYears = parts.year == null
      ? [this.referenceYear - 1, this.referenceYear, this.referenceYear + 1]
      : [parts.year];

    const candidates = candidateYears.map((year) => {
      const wholeMilliseconds = this.fixedOffsetMinutes != null
        ? Date.UTC(year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0) - this.fixedOffsetMinutes * 60_000
        : new Date(year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0).getTime();
      return wholeMilliseconds + parts.fractionalMilliseconds;
    });

    const anchor = this.lastResolvedMs ?? this.referenceDateMs;
    let resolved = candidates.reduce((best, candidate) => Math.abs(candidate - anchor) < Math.abs(best - anchor) ? candidate : best);
    if (parts.year == null && this.lastResolvedMs != null && resolved < this.lastResolvedMs - 180 * 24 * 60 * 60 * 1000) {
      resolved = candidates.find((candidate) => candidate > this.lastResolvedMs!) ?? resolved;
    }
    this.lastResolvedMs = resolved;
    return resolved;
  }
}

export class CombatLogParser {
  private readonly core: CoreCombatLogParser;
  private readonly timestampResolver: CombatLogTimestampResolver;

  constructor(timestampResolver = new CombatLogTimestampResolver()) {
    this.timestampResolver = timestampResolver;
    // The core parser only needs a syntactically valid timestamp while this
    // compatibility layer owns the authoritative timestamp/provenance.
    this.core = new CoreCombatLogParser(new CoreCombatLogTimestampResolver());
  }

  getFormatState(): CombatLogFormatState {
    return this.core.getFormatState();
  }

  getClockContext() {
    return this.timestampResolver.getClockContext();
  }

  hydrateFormatState(state: CombatLogFormatState): void {
    this.core.hydrateFormatState(state);
  }

  parseLine(line: string, context: ParserLineContext): RawCombatLogEvent {
    const envelope = FLEXIBLE_ENVELOPE.exec(line);
    if (!envelope) return this.core.parseLine(line, context);

    const rawTimestamp = envelope[1];
    const body = envelope[2];
    const normalizedLine = `${normalizedTimestampForCore(rawTimestamp)}  ${body}`;
    const tokens = tokenizeCombatLogCsv(body);
    const eventType = tokens[0] ?? 'UNKNOWN';
    const originalState = this.core.getFormatState();
    const parseWithoutAdvanced = originalState.advancedEnabled === true && canSafelyParseWithoutAdvanced(tokens, eventType);

    if (parseWithoutAdvanced) {
      this.core.hydrateFormatState({ ...originalState, advancedEnabled: false });
    }

    let event: RawCombatLogEvent;
    try {
      event = this.core.parseLine(normalizedLine, context);
    } finally {
      if (parseWithoutAdvanced) this.core.hydrateFormatState(originalState);
    }

    event.timestamp = this.timestampResolver.resolve(rawTimestamp);
    event.rawTimestamp = rawTimestamp;
    return event;
  }
}
