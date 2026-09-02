/**
 * Contratos puros de la cadena causal v3.
 *
 * Este módulo no importa Deno, Supabase ni Angular. Es la fuente compartida
 * por backend, frontend y tests durante el rollout en shadow.
 */

export const COMBAT_EVALUATION_CONTRACT_VERSION = 'combat-evaluation-contract@1.0.0';
export const PULL_CONTEXT_RESOLVER_VERSION = 'pull-evaluation-context@1.0.0';
export const OCCURRENCE_RESOLVER_VERSION = 'mechanic-occurrence-resolver@1.0.0';
export const EXECUTION_LEDGER_VERSION = 'execution-ledger@1.0.0';

export const EVALUATION_CONFIDENCES = ['verified', 'inferred', 'fallback', 'uncertain'] as const;
export type EvaluationConfidence = (typeof EVALUATION_CONFIDENCES)[number];

export const NINJA_STATUSES = ['valid', 'probable', 'confirmed', 'unknown'] as const;
export type NinjaStatus = (typeof NINJA_STATUSES)[number];

export const WIPE_CALL_SOURCES = ['none', 'manual_rl', 'instrumented', 'inferred'] as const;
export type WipeCallSource = (typeof WIPE_CALL_SOURCES)[number];

export const NINJA_SOURCES = ['manual', 'heuristic', 'imported'] as const;
export type NinjaSource = (typeof NINJA_SOURCES)[number];

export const OCCURRENCE_OUTCOMES = ['success', 'partial_fail', 'fail', 'not_evaluable', 'uncertain'] as const;
export type OccurrenceOutcome = (typeof OCCURRENCE_OUTCOMES)[number];

export const RESPONSIBILITY_RELATIONSHIPS = [
  'primary_owner',
  'co_owner',
  'assigned_resolver',
  'successful_resolver',
  'target',
  'collateral_victim',
  'beneficiary',
] as const;
export type ResponsibilityRelationship = (typeof RESPONSIBILITY_RELATIONSHIPS)[number];

export const EXECUTION_DOMAINS = [
  'mechanic',
  'defensive',
  'external',
  'consumable',
  'interrupt',
  'dispel',
  'utility',
  'death',
  'preparation',
] as const;
export type ExecutionDomain = (typeof EXECUTION_DOMAINS)[number];

export const EXECUTION_VERDICTS = [
  'success',
  'failure',
  'correct_hold',
  'missed',
  'context',
  'not_applicable',
  'uncertain',
] as const;
export type ExecutionVerdict = (typeof EXECUTION_VERDICTS)[number];

export const EXECUTION_REASON_CODES = [
  'SPREAD_CARRIER_COLLATERAL',
  'ASSIGNED_SOAK_MISSED',
  'PERSONAL_GROUND_HIT',
  'TANK_FRONTAL_HIT_RAID',
  'TANK_SWAP_THRESHOLD_BREACH',
  'ASSIGNED_INTERRUPT_MISSED',
  'RAID_INTERRUPT_MISSED',
  'VOLUNTEER_MECHANIC_RESOLVED',
  'VOLUNTEER_MECHANIC_UNRESOLVED',
  'SELF_FAILURE_DEATH',
  'COLLATERAL_DEATH',
  'UNAVOIDABLE_PRESSURE_DEATH',
  'POST_WIPE_DEATH',
  'UNCERTAIN_CAUSE',
  'PLAN_COVERED',
  'CORRECT_HOLD',
  'REMINDER_MISSED',
  'DEATH_VIABLE_CD',
  'VIABLE_CD_NON_PUNITIVE',
  'TARGET_MISMATCH',
  'SAFE_EXTRA_USE',
  'PREPOT_USED',
  'PREPOT_MISSED_VERIFIED',
  'HEALTHSTONE_REACTIVE',
  'HEALTHSTONE_VIABLE_NOT_USED',
  'HEALTH_POTION_REACTIVE',
  'AVAILABILITY_UNKNOWN',
] as const;
export type ExecutionReasonCode = (typeof EXECUTION_REASON_CODES)[number];

export interface PullEvaluationContextContract {
  pullId: string;
  evaluationEligible: boolean;
  evaluationStartMs: number;
  evaluationEndMs: number;
  cutoffReason: 'fight_end' | 'wipe_call' | 'invalid_pull';
  wipeCallAtMs: number | null;
  wipeCallBossHpPct: number | null;
  wipeCallSource: WipeCallSource;
  wipeCallConfidence: number | null;
  wipeCallVerified: boolean;
  ninjaStatus: NinjaStatus;
  ninjaSource: NinjaSource;
  ninjaConfidence: number | null;
  evidence: Record<string, unknown>;
  resolverVersion: string;
  updatedAt: string;
}

export interface MechanicPolicyContract {
  bossId: string;
  difficulty: string;
  mechanicKey: string;
  policyVersion: number;
  displayCategory: string | null;
  targetingMode: 'tank' | 'selected_player' | 'group' | 'raid' | 'ground' | 'object' | 'none' | 'mixed';
  requiredResponse: string | null;
  responsibilityMode: 'target' | 'tank_role' | 'healer_role' | 'dps_role' | 'assigned_player' | 'assigned_group' | 'volunteer' | 'raid' | 'none';
  damageSemantics: 'mandatory' | 'avoidable' | 'partly_avoidable' | 'failure_consequence' | 'none';
  failurePropagation: 'self' | 'nearby_players' | 'group' | 'raid' | 'chained' | 'none';
  assignmentMode: 'none' | 'target_derived' | 'role_derived' | 'plan_optional' | 'plan_required';
  defensiveExpectation: 'none' | 'optional' | 'recommended' | 'required' | 'contingency_only';
  creditScope: 'resolver' | 'target' | 'group' | 'raid' | 'none';
  penaltyScope: 'owner' | 'assignee' | 'role' | 'raid_only' | 'none';
  causalRule: Record<string, unknown>;
  confidence: EvaluationConfidence;
}

export interface MechanicAliasContract {
  id: string;
  bossId: string;
  difficulty: string;
  mechanicKey: string;
  abilityId: number | null;
  normalizedName: string | null;
  source: 'journal' | 'wcl' | 'manual' | 'classifier' | 'legacy';
  confidence: EvaluationConfidence;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MechanicIdentityResolutionResult {
  mechanicKey: string;
  abilityId: number | null;
  normalizedName: string | null;
  source: 'journal' | 'wcl' | 'manual' | 'classifier' | 'legacy';
  confidence: EvaluationConfidence;
  aliasId: string | null;
}

export interface MechanicOccurrenceEvaluationContract {
  id: string;
  pullId: string;
  bossId: string;
  difficulty: string;
  mechanicKey: string;
  occurrenceIndex: number;
  startMs: number;
  resolveMs: number;
  endMs: number;
  targetActorIds: number[];
  outcome: OccurrenceOutcome;
  failureMode: string | null;
  evidence: Record<string, unknown>;
  confidence: EvaluationConfidence;
  policyVersion: number;
  contextResolverVersion: string;
  occurrenceResolverVersion: string;
}

export interface PlayerExecutionEventContract {
  id: string;
  pullId: string;
  playerName: string;
  occurrenceId: string | null;
  causalGroupId: string;
  timestampMs: number;
  domain: ExecutionDomain;
  eventType: string;
  verdict: ExecutionVerdict;
  reasonCode: ExecutionReasonCode;
  creditEligible: boolean;
  penaltyEligible: boolean;
  primaryPenalty: boolean;
  confidence: EvaluationConfidence;
  evidence: Record<string, unknown>;
  policyVersion: number | null;
  contextResolverVersion: string;
  occurrenceResolverVersion: string | null;
  ledgerEvaluatorVersion: string;
}

export interface MechanicResponsibilityEdgeContract {
  id: string;
  occurrenceId: string;
  playerName: string;
  actorId: number | null;
  relationship: ResponsibilityRelationship;
  damageCaused: number;
  damageTaken: number;
  victimCount: number;
  creditEligible: boolean;
  penaltyEligible: boolean;
  reasonCode: ExecutionReasonCode;
  confidence: EvaluationConfidence;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export function isEventEvaluable(context: PullEvaluationContextContract, timestampMs: number): boolean {
  return (
    context.evaluationEligible &&
    Number.isFinite(timestampMs) &&
    timestampMs >= context.evaluationStartMs &&
    timestampMs < context.evaluationEndMs
  );
}

export function getEvaluationCutoffMs(context: PullEvaluationContextContract): number | null {
  return context.evaluationEligible ? context.evaluationEndMs : null;
}

export function isPullStatisticallyValid(context: PullEvaluationContextContract): boolean {
  return context.evaluationEligible && context.ninjaStatus !== 'confirmed';
}

export function canPenalize(confidence: EvaluationConfidence, penaltyEligible: boolean): boolean {
  return penaltyEligible && (confidence === 'verified' || confidence === 'inferred');
}

export interface PlayerExecutionEventRow {
  id: string;
  pullId: string;
  playerName: string;
  occurrenceId: string | null;
  domain: ExecutionDomain;
  eventType: string;
  verdict: ExecutionVerdict;
  reasonCode: ExecutionReasonCode;
  creditEligible: boolean;
  penaltyEligible: boolean;
  primaryPenalty: boolean;
  severity: number;
  priority: number;
  confidence: EvaluationConfidence;
  evidence: Record<string, unknown>;
  contextResolverVersion: string;
  occurrenceResolverVersion: string | null;
  ledgerEvaluatorVersion: string;
  deduplicationKey: string;
  createdAt: string;
  evaluatedAt: string;
}

