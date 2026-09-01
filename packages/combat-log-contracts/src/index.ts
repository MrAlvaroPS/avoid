export const COMBAT_LOG_PARSER_VERSION = 'iris-combat-log-parser/0.1.0';
export const COLLECTOR_SPOOL_FORMAT_VERSION = 1 as const;

export type SequenceString = `${bigint}`;

export interface ActorRef {
  guid: string;
  name?: string;
  flags?: number;
  raidFlags?: number;
  ownerGuid?: string;
}

export interface AbilityRef {
  id: number;
  name?: string;
  school?: number;
}

export interface RawLineRef {
  streamId: string;
  sequence: bigint;
  byteStart: number;
  byteEndExclusive: number;
  lineHash?: string;
}

export interface AdvancedSnapshot {
  infoGuid?: string;
  ownerGuid?: string;
  hp?: number;
  maxHp?: number;
  attackPower?: number;
  spellPower?: number;
  armor?: number;
  absorb?: number;
  powerType?: number;
  power?: number;
  maxPower?: number;
  powerCost?: number;
  x?: number;
  y?: number;
  mapId?: number;
  facing?: number;
  levelOrItemLevel?: number;
  describesActor: 'source' | 'target' | 'other' | 'unknown';
}

export interface CombatLogFormatState {
  logFormatVersion?: number;
  advancedEnabled: boolean | null;
  gameBuild?: string;
  projectId?: number;
}

export interface CombatLogVersionPayload {
  kind: 'combat_log_version';
  version: number;
  advancedEnabled: boolean;
  buildVersion?: string;
  projectId?: number;
  rawFields: string[];
}

export interface ZoneChangePayload {
  kind: 'zone_change';
  instanceId?: number;
  zoneName?: string;
  difficultyId?: number;
}

export interface MapChangePayload {
  kind: 'map_change';
  mapId?: number;
  mapName?: string;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
}

export interface EncounterStartPayload {
  kind: 'encounter_start';
  encounterId?: number;
  encounterName?: string;
  difficultyId?: number;
  groupSize?: number;
  instanceId?: number;
}

export interface EncounterEndPayload {
  kind: 'encounter_end';
  encounterId?: number;
  encounterName?: string;
  difficultyId?: number;
  groupSize?: number;
  success?: boolean;
  fightTimeMs?: number;
}

export interface CombatantInfoPayload {
  kind: 'combatant_info';
  playerGuid?: string;
  topLevelFields: string[];
}

export interface DamagePayload {
  kind: 'damage';
  amount?: number;
  overkill?: number;
  school?: number;
  resisted?: number;
  blocked?: number;
  absorbed?: number;
  critical?: boolean;
  glancing?: boolean;
  crushing?: boolean;
  offHand?: boolean;
}

export interface HealPayload {
  kind: 'heal';
  amount?: number;
  overhealing?: number;
  absorbed?: number;
  critical?: boolean;
}

export interface MissedPayload {
  kind: 'missed';
  missType?: string;
  offHand?: boolean;
  amountMissed?: number;
  critical?: boolean;
}

export interface EnergizePayload {
  kind: 'energize';
  amount?: number;
  overEnergize?: number;
  powerType?: number;
  maxPower?: number;
}

export interface AuraPayload {
  kind: 'aura';
  operation: 'applied' | 'removed' | 'applied_dose' | 'removed_dose' | 'refresh' | 'broken';
  auraType?: string;
  amount?: number;
}

export interface CastPayload {
  kind: 'cast';
  operation: 'start' | 'success' | 'failed';
  failedType?: string;
}

export interface InterruptPayload {
  kind: 'interrupt';
  extraAbility?: AbilityRef;
}

export interface DispelPayload {
  kind: 'dispel';
  operation: 'dispel' | 'dispel_failed' | 'stolen';
  extraAbility?: AbilityRef;
  auraType?: string;
}

export interface UnitDeathPayload {
  kind: 'unit_death';
  recapId?: number;
  unconsciousOnDeath?: boolean;
}

export interface UnknownPayload {
  kind: 'unknown';
  reason: 'unsupported_event' | 'format_state_unknown' | 'schema_not_verified' | 'malformed_line';
  tokenizedFields: string[];
}

export type CombatLogPayload =
  | CombatLogVersionPayload
  | ZoneChangePayload
  | MapChangePayload
  | EncounterStartPayload
  | EncounterEndPayload
  | CombatantInfoPayload
  | DamagePayload
  | HealPayload
  | MissedPayload
  | EnergizePayload
  | AuraPayload
  | CastPayload
  | InterruptPayload
  | DispelPayload
  | UnitDeathPayload
  | UnknownPayload;

export interface RawCombatLogEvent<TPayload extends CombatLogPayload = CombatLogPayload> {
  streamId: string;
  sequence: bigint;
  timestamp: number;
  rawTimestamp: string;
  eventType: string;
  source?: ActorRef;
  target?: ActorRef;
  ability?: AbilityRef;
  advanced?: AdvancedSnapshot;
  payload: TPayload;
  rawRef: RawLineRef;
  parserVersion: string;
  logFormatVersion?: number;
  gameBuild?: string;
}

export interface WireRawLineRef extends Omit<RawLineRef, 'sequence'> {
  sequence: SequenceString;
}

export interface WireRawCombatLogEvent extends Omit<RawCombatLogEvent, 'sequence' | 'rawRef' | 'timestamp'> {
  sequence: SequenceString;
  timestamp: number | null;
  rawRef: WireRawLineRef;
}

export interface CollectorClockContext {
  timeZone: string;
  referenceYear: number;
  source: 'logger_local_clock';
}

export interface SpoolRecord {
  version: typeof COLLECTOR_SPOOL_FORMAT_VERSION;
  streamId: string;
  sequence: SequenceString;
  committedOffset: number;
  formatState: CombatLogFormatState;
  event: WireRawCombatLogEvent;
}

export function toWireEvent(event: RawCombatLogEvent): WireRawCombatLogEvent {
  return {
    ...event,
    sequence: event.sequence.toString() as SequenceString,
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : null,
    rawRef: {
      ...event.rawRef,
      sequence: event.rawRef.sequence.toString() as SequenceString,
    },
  };
}

export function sequenceFromWire(sequence: SequenceString | string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(sequence)) {
    throw new Error(`Invalid decimal sequence: ${sequence}`);
  }
  return BigInt(sequence);
}
