import {
  COMBAT_LOG_PARSER_VERSION,
  type AbilityRef,
  type ActorRef,
  type AdvancedSnapshot,
  type AuraPayload,
  type CastPayload,
  type CombatLogFormatState,
  type CombatLogPayload,
  type DispelPayload,
  type RawCombatLogEvent,
  type RawLineRef,
  type UnknownPayload,
} from '../../combat-log-contracts/src/index.ts';

export interface ParserLineContext {
  streamId: string;
  sequence: bigint;
  byteStart: number;
  byteEndExclusive: number;
  lineHash?: string;
}

export interface TimestampResolverOptions {
  referenceDate?: Date;
  fixedOffsetMinutes?: number;
}

interface ParsedEnvelope {
  rawTimestamp: string;
  body: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').replace(/\\"/g, '"');
  }
  return trimmed;
}

export function tokenizeCombatLogCsv(input: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  let inQuotes = false;
  let escaped = false;
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        if (input[i + 1] === '"') {
          i += 1;
          continue;
        }
        inQuotes = false;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === '(') roundDepth += 1;
    else if (char === ')') roundDepth = Math.max(0, roundDepth - 1);
    else if (char === '[') squareDepth += 1;
    else if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
    else if (char === '{') curlyDepth += 1;
    else if (char === '}') curlyDepth = Math.max(0, curlyDepth - 1);
    else if (char === ',' && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      tokens.push(unquote(input.slice(start, i)));
      start = i + 1;
    }
  }

  tokens.push(unquote(input.slice(start)));
  return tokens;
}

function parseEnvelope(line: string): ParsedEnvelope | null {
  const match = /^(\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s{2,}(.*)$/.exec(line);
  if (!match) return null;
  return { rawTimestamp: match[1], body: match[2] };
}

function valueOrUndefined(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized === 'nil' || normalized === 'null') return undefined;
  return normalized;
}

function numberOrUndefined(value: string | undefined): number | undefined {
  const normalized = valueOrUndefined(value);
  if (normalized == null) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanOrUndefined(value: string | undefined): boolean | undefined {
  const normalized = valueOrUndefined(value)?.toLowerCase();
  if (normalized == null) return undefined;
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
}

function actorFrom(tokens: string[], start: number): ActorRef | undefined {
  const guid = valueOrUndefined(tokens[start]);
  if (!guid) return undefined;
  return {
    guid,
    name: valueOrUndefined(tokens[start + 1]),
    flags: numberOrUndefined(tokens[start + 2]),
    raidFlags: numberOrUndefined(tokens[start + 3]),
  };
}

function abilityFrom(tokens: string[], start: number): AbilityRef | undefined {
  const id = numberOrUndefined(tokens[start]);
  if (id == null) return undefined;
  return {
    id,
    name: valueOrUndefined(tokens[start + 1]),
    school: numberOrUndefined(tokens[start + 2]),
  };
}

function unknown(reason: UnknownPayload['reason'], fields: string[]): UnknownPayload {
  return { kind: 'unknown', reason, tokenizedFields: fields };
}

function prefixWidth(eventType: string): 0 | 1 | 3 | null {
  if (eventType === 'DAMAGE_SPLIT' || eventType === 'DAMAGE_SHIELD' || eventType === 'DAMAGE_SHIELD_MISSED') {
    return 3;
  }
  if (eventType.startsWith('SWING_')) return 0;
  if (eventType.startsWith('ENVIRONMENTAL_')) return 1;
  if (
    eventType.startsWith('SPELL_') ||
    eventType.startsWith('SPELL_PERIODIC_') ||
    eventType.startsWith('SPELL_BUILDING_') ||
    eventType.startsWith('RANGE_')
  ) {
    return 3;
  }
  if (
    eventType === 'PARTY_KILL' ||
    eventType === 'UNIT_DIED' ||
    eventType === 'UNIT_DESTROYED' ||
    eventType === 'UNIT_DISSIPATES'
  ) {
    return 0;
  }
  return null;
}

function suffixKind(eventType: string): string | null {
  const suffixes = [
    '_AURA_APPLIED_DOSE',
    '_AURA_REMOVED_DOSE',
    '_AURA_APPLIED',
    '_AURA_REMOVED',
    '_AURA_REFRESH',
    '_AURA_BROKEN',
    '_CAST_SUCCESS',
    '_CAST_FAILED',
    '_CAST_START',
    '_DISPEL_FAILED',
    '_INTERRUPT',
    '_ENERGIZE',
    '_DISPEL',
    '_STOLEN',
    '_MISSED',
    '_DAMAGE',
    '_HEAL',
  ];
  return suffixes.find((suffix) => eventType.endsWith(suffix)) ?? null;
}

function minimumSuffixFields(suffix: string | null): number {
  switch (suffix) {
    case '_DAMAGE': return 10;
    case '_HEAL': return 4;
    case '_MISSED': return 2;
    case '_ENERGIZE': return 3;
    case '_AURA_APPLIED':
    case '_AURA_REMOVED':
    case '_AURA_APPLIED_DOSE':
    case '_AURA_REMOVED_DOSE':
    case '_AURA_REFRESH':
    case '_AURA_BROKEN': return 1;
    case '_CAST_FAILED': return 1;
    case '_INTERRUPT': return 3;
    case '_DISPEL':
    case '_STOLEN': return 4;
    case '_DISPEL_FAILED': return 3;
    case '_CAST_START':
    case '_CAST_SUCCESS': return 0;
    default: return 0;
  }
}

function advancedFrom(tokens: string[], start: number, source?: ActorRef, target?: ActorRef): AdvancedSnapshot {
  const infoGuid = valueOrUndefined(tokens[start]);
  let describesActor: AdvancedSnapshot['describesActor'] = 'unknown';
  if (infoGuid && source?.guid === infoGuid) describesActor = 'source';
  else if (infoGuid && target?.guid === infoGuid) describesActor = 'target';
  else if (infoGuid) describesActor = 'other';

  return {
    infoGuid,
    ownerGuid: valueOrUndefined(tokens[start + 1]),
    hp: numberOrUndefined(tokens[start + 2]),
    maxHp: numberOrUndefined(tokens[start + 3]),
    attackPower: numberOrUndefined(tokens[start + 4]),
    spellPower: numberOrUndefined(tokens[start + 5]),
    armor: numberOrUndefined(tokens[start + 6]),
    absorb: numberOrUndefined(tokens[start + 7]),
    powerType: numberOrUndefined(tokens[start + 8]),
    power: numberOrUndefined(tokens[start + 9]),
    maxPower: numberOrUndefined(tokens[start + 10]),
    powerCost: numberOrUndefined(tokens[start + 11]),
    x: numberOrUndefined(tokens[start + 12]),
    y: numberOrUndefined(tokens[start + 13]),
    mapId: numberOrUndefined(tokens[start + 14]),
    facing: numberOrUndefined(tokens[start + 15]),
    levelOrItemLevel: numberOrUndefined(tokens[start + 16]),
    describesActor,
  };
}

function payloadFromSuffix(eventType: string, suffix: string | null, fields: string[]): CombatLogPayload {
  switch (suffix) {
    case '_DAMAGE':
      return {
        kind: 'damage',
        amount: numberOrUndefined(fields[0]),
        overkill: numberOrUndefined(fields[1]),
        school: numberOrUndefined(fields[2]),
        resisted: numberOrUndefined(fields[3]),
        blocked: numberOrUndefined(fields[4]),
        absorbed: numberOrUndefined(fields[5]),
        critical: booleanOrUndefined(fields[6]),
        glancing: booleanOrUndefined(fields[7]),
        crushing: booleanOrUndefined(fields[8]),
        offHand: booleanOrUndefined(fields[9]),
      };
    case '_HEAL':
      return {
        kind: 'heal',
        amount: numberOrUndefined(fields[0]),
        overhealing: numberOrUndefined(fields[1]),
        absorbed: numberOrUndefined(fields[2]),
        critical: booleanOrUndefined(fields[3]),
      };
    case '_MISSED':
      return {
        kind: 'missed',
        missType: valueOrUndefined(fields[0]),
        offHand: booleanOrUndefined(fields[1]),
        amountMissed: numberOrUndefined(fields[2]),
        critical: booleanOrUndefined(fields[3]),
      };
    case '_ENERGIZE':
      return {
        kind: 'energize',
        amount: numberOrUndefined(fields[0]),
        overEnergize: numberOrUndefined(fields[1]),
        powerType: numberOrUndefined(fields[2]),
        maxPower: numberOrUndefined(fields[3]),
      };
    case '_AURA_APPLIED':
    case '_AURA_REMOVED':
    case '_AURA_APPLIED_DOSE':
    case '_AURA_REMOVED_DOSE':
    case '_AURA_REFRESH':
    case '_AURA_BROKEN': {
      const operationMap: Record<string, AuraPayload['operation']> = {
        _AURA_APPLIED: 'applied',
        _AURA_REMOVED: 'removed',
        _AURA_APPLIED_DOSE: 'applied_dose',
        _AURA_REMOVED_DOSE: 'removed_dose',
        _AURA_REFRESH: 'refresh',
        _AURA_BROKEN: 'broken',
      };
      return {
        kind: 'aura',
        operation: operationMap[suffix],
        auraType: valueOrUndefined(fields[0]),
        amount: numberOrUndefined(fields[1]),
      };
    }
    case '_CAST_START':
    case '_CAST_SUCCESS':
    case '_CAST_FAILED': {
      const operation: CastPayload['operation'] = suffix === '_CAST_START' ? 'start' : suffix === '_CAST_SUCCESS' ? 'success' : 'failed';
      return { kind: 'cast', operation, failedType: valueOrUndefined(fields[0]) };
    }
    case '_INTERRUPT':
      return { kind: 'interrupt', extraAbility: abilityFrom(fields, 0) };
    case '_DISPEL':
    case '_DISPEL_FAILED':
    case '_STOLEN': {
      const operation: DispelPayload['operation'] = suffix === '_DISPEL' ? 'dispel' : suffix === '_STOLEN' ? 'stolen' : 'dispel_failed';
      return {
        kind: 'dispel',
        operation,
        extraAbility: abilityFrom(fields, 0),
        auraType: suffix === '_DISPEL_FAILED' ? undefined : valueOrUndefined(fields[3]),
      };
    }
    default:
      if (eventType === 'UNIT_DIED' || eventType === 'UNIT_DESTROYED' || eventType === 'UNIT_DISSIPATES') {
        return {
          kind: 'unit_death',
          recapId: numberOrUndefined(fields[0]),
          unconsciousOnDeath: booleanOrUndefined(fields[1]),
        };
      }
      return unknown('unsupported_event', fields);
  }
}

export class CombatLogTimestampResolver {
  readonly timeZone: string;
  readonly referenceYear: number;
  private readonly fixedOffsetMinutes?: number;
  private lastResolvedMs?: number;

  constructor(options: TimestampResolverOptions = {}) {
    const referenceDate = options.referenceDate ?? new Date();
    this.referenceYear = referenceDate.getFullYear();
    this.fixedOffsetMinutes = options.fixedOffsetMinutes;
    this.timeZone = options.fixedOffsetMinutes == null
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
      : `UTC${options.fixedOffsetMinutes >= 0 ? '+' : ''}${options.fixedOffsetMinutes / 60}`;
  }

  getClockContext() {
    return { timeZone: this.timeZone, referenceYear: this.referenceYear, source: 'logger_local_clock' as const };
  }

  resolve(rawTimestamp: string): number {
    const match = /^(\d{1,2})\/(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(rawTimestamp);
    if (!match) throw new Error(`Unsupported combat-log timestamp: ${rawTimestamp}`);

    const [, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, msRaw] = match;
    const parts = [monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, msRaw].map(Number);
    const [month, day, hour, minute, second, millisecond] = parts;

    const candidates = [this.referenceYear - 1, this.referenceYear, this.referenceYear + 1].map((year) => {
      if (this.fixedOffsetMinutes != null) {
        return Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - this.fixedOffsetMinutes * 60_000;
      }
      return new Date(year, month - 1, day, hour, minute, second, millisecond).getTime();
    });

    const anchor = this.lastResolvedMs ?? (this.fixedOffsetMinutes != null
      ? Date.UTC(this.referenceYear, 0, 1) - this.fixedOffsetMinutes * 60_000
      : new Date(this.referenceYear, 0, 1).getTime());
    let resolved = candidates.reduce((best, candidate) => Math.abs(candidate - anchor) < Math.abs(best - anchor) ? candidate : best);

    if (this.lastResolvedMs != null && resolved < this.lastResolvedMs - 180 * 24 * 60 * 60 * 1000) {
      resolved = candidates.find((candidate) => candidate > this.lastResolvedMs!) ?? resolved;
    }
    this.lastResolvedMs = resolved;
    return resolved;
  }
}

export class CombatLogParser {
  private formatState: CombatLogFormatState = { advancedEnabled: null };
  private readonly timestampResolver: CombatLogTimestampResolver;

  constructor(timestampResolver = new CombatLogTimestampResolver()) {
    this.timestampResolver = timestampResolver;
  }

  getFormatState(): CombatLogFormatState {
    return { ...this.formatState };
  }

  getClockContext() {
    return this.timestampResolver.getClockContext();
  }

  hydrateFormatState(state: CombatLogFormatState): void {
    this.formatState = { ...state };
  }

  parseLine(line: string, context: ParserLineContext): RawCombatLogEvent {
    const envelope = parseEnvelope(line);
    const rawRef: RawLineRef = {
      streamId: context.streamId,
      sequence: context.sequence,
      byteStart: context.byteStart,
      byteEndExclusive: context.byteEndExclusive,
      lineHash: context.lineHash,
    };

    if (!envelope) {
      return {
        streamId: context.streamId,
        sequence: context.sequence,
        timestamp: Number.NaN,
        rawTimestamp: '',
        eventType: 'MALFORMED_LINE',
        payload: unknown('malformed_line', [line]),
        rawRef,
        parserVersion: COMBAT_LOG_PARSER_VERSION,
        logFormatVersion: this.formatState.logFormatVersion,
        gameBuild: this.formatState.gameBuild,
      };
    }

    const timestamp = this.timestampResolver.resolve(envelope.rawTimestamp);
    const tokens = tokenizeCombatLogCsv(envelope.body);
    const eventType = tokens[0] ?? 'UNKNOWN';

    if (eventType === 'COMBAT_LOG_VERSION') {
      const version = numberOrUndefined(tokens[1]) ?? 0;
      const keyed = new Map<string, string>();
      for (let i = 2; i + 1 < tokens.length; i += 2) keyed.set(tokens[i], tokens[i + 1]);
      const advancedEnabled = keyed.get('ADVANCED_LOG_ENABLED') === '1';
      const buildVersion = valueOrUndefined(keyed.get('BUILD_VERSION'));
      const projectId = numberOrUndefined(keyed.get('PROJECT_ID'));
      this.formatState = { logFormatVersion: version, advancedEnabled, gameBuild: buildVersion, projectId };
      return {
        streamId: context.streamId,
        sequence: context.sequence,
        timestamp,
        rawTimestamp: envelope.rawTimestamp,
        eventType,
        payload: {
          kind: 'combat_log_version',
          version,
          advancedEnabled,
          buildVersion,
          projectId,
          rawFields: tokens.slice(1),
        },
        rawRef,
        parserVersion: COMBAT_LOG_PARSER_VERSION,
        logFormatVersion: version,
        gameBuild: buildVersion,
      };
    }

    const metadataPayload = this.parseMetadata(eventType, tokens.slice(1));
    if (metadataPayload) {
      return {
        streamId: context.streamId,
        sequence: context.sequence,
        timestamp,
        rawTimestamp: envelope.rawTimestamp,
        eventType,
        payload: metadataPayload,
        rawRef,
        parserVersion: COMBAT_LOG_PARSER_VERSION,
        logFormatVersion: this.formatState.logFormatVersion,
        gameBuild: this.formatState.gameBuild,
      };
    }

    return this.parseCombatEvent(eventType, tokens, timestamp, envelope.rawTimestamp, rawRef, context);
  }

  private parseMetadata(eventType: string, fields: string[]): CombatLogPayload | null {
    switch (eventType) {
      case 'ZONE_CHANGE':
        return { kind: 'zone_change', instanceId: numberOrUndefined(fields[0]), zoneName: valueOrUndefined(fields[1]), difficultyId: numberOrUndefined(fields[2]) };
      case 'MAP_CHANGE':
        return { kind: 'map_change', mapId: numberOrUndefined(fields[0]), mapName: valueOrUndefined(fields[1]), x0: numberOrUndefined(fields[2]), x1: numberOrUndefined(fields[3]), y0: numberOrUndefined(fields[4]), y1: numberOrUndefined(fields[5]) };
      case 'ENCOUNTER_START':
        return { kind: 'encounter_start', encounterId: numberOrUndefined(fields[0]), encounterName: valueOrUndefined(fields[1]), difficultyId: numberOrUndefined(fields[2]), groupSize: numberOrUndefined(fields[3]), instanceId: numberOrUndefined(fields[4]) };
      case 'ENCOUNTER_END':
        return { kind: 'encounter_end', encounterId: numberOrUndefined(fields[0]), encounterName: valueOrUndefined(fields[1]), difficultyId: numberOrUndefined(fields[2]), groupSize: numberOrUndefined(fields[3]), success: booleanOrUndefined(fields[4]), fightTimeMs: numberOrUndefined(fields[5]) };
      case 'COMBATANT_INFO':
        return { kind: 'combatant_info', playerGuid: valueOrUndefined(fields[0]), topLevelFields: fields };
      default:
        return null;
    }
  }

  private parseCombatEvent(
    eventType: string,
    tokens: string[],
    timestamp: number,
    rawTimestamp: string,
    rawRef: RawLineRef,
    context: ParserLineContext,
  ): RawCombatLogEvent {
    if (eventType === 'SPELL_ABSORBED' || eventType === 'SPELL_HEAL_ABSORBED') {
      return this.baseUnknownEvent(eventType, tokens.slice(1), timestamp, rawTimestamp, rawRef, context, 'schema_not_verified');
    }

    const width = prefixWidth(eventType);
    if (width == null || tokens.length < 9) {
      return this.baseUnknownEvent(eventType, tokens.slice(1), timestamp, rawTimestamp, rawRef, context, 'unsupported_event');
    }

    const source = actorFrom(tokens, 1);
    const target = actorFrom(tokens, 5);
    let cursor = 9;
    let ability: AbilityRef | undefined;
    if (width === 3) {
      ability = abilityFrom(tokens, cursor);
      cursor += 3;
    } else if (width === 1) {
      cursor += 1;
    }

    const suffix = suffixKind(eventType);
    if (this.formatState.advancedEnabled == null) {
      return {
        streamId: context.streamId,
        sequence: context.sequence,
        timestamp,
        rawTimestamp,
        eventType,
        source,
        target,
        ability,
        payload: unknown('format_state_unknown', tokens.slice(cursor)),
        rawRef,
        parserVersion: COMBAT_LOG_PARSER_VERSION,
        logFormatVersion: this.formatState.logFormatVersion,
        gameBuild: this.formatState.gameBuild,
      };
    }

    let advanced: AdvancedSnapshot | undefined;
    if (this.formatState.advancedEnabled) {
      const required = 17 + minimumSuffixFields(suffix);
      if (tokens.length - cursor < required) {
        return {
          streamId: context.streamId,
          sequence: context.sequence,
          timestamp,
          rawTimestamp,
          eventType,
          source,
          target,
          ability,
          payload: unknown('schema_not_verified', tokens.slice(cursor)),
          rawRef,
          parserVersion: COMBAT_LOG_PARSER_VERSION,
          logFormatVersion: this.formatState.logFormatVersion,
          gameBuild: this.formatState.gameBuild,
        };
      }
      advanced = advancedFrom(tokens, cursor, source, target);
      cursor += 17;
    }

    const payload = payloadFromSuffix(eventType, suffix, tokens.slice(cursor));
    return {
      streamId: context.streamId,
      sequence: context.sequence,
      timestamp,
      rawTimestamp,
      eventType,
      source,
      target,
      ability,
      advanced,
      payload,
      rawRef,
      parserVersion: COMBAT_LOG_PARSER_VERSION,
      logFormatVersion: this.formatState.logFormatVersion,
      gameBuild: this.formatState.gameBuild,
    };
  }

  private baseUnknownEvent(
    eventType: string,
    fields: string[],
    timestamp: number,
    rawTimestamp: string,
    rawRef: RawLineRef,
    context: ParserLineContext,
    reason: UnknownPayload['reason'],
  ): RawCombatLogEvent {
    return {
      streamId: context.streamId,
      sequence: context.sequence,
      timestamp,
      rawTimestamp,
      eventType,
      payload: unknown(reason, fields),
      rawRef,
      parserVersion: COMBAT_LOG_PARSER_VERSION,
      logFormatVersion: this.formatState.logFormatVersion,
      gameBuild: this.formatState.gameBuild,
    };
  }
}
