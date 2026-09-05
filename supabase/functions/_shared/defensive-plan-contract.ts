export type PlanMode = 'full' | 'partial' | 'no_plan';
export type Role = 'tank' | 'healer' | 'dps';
export type CoverageStatus = 'covered' | 'partial' | 'uncovered' | 'excluded';
export type SlotSource = 'automatic' | 'manual' | 'locked' | 'emergency' | 'fallback';
export type Confidence = 'verified' | 'inferred' | 'fallback' | 'uncertain';

export interface DraftMember {
  playerKey: string;
  characterId?: number | null;
  playerName: string;
  class: string;
  spec?: string | null;
  role?: Role | null;
  raidGroup?: number | null;
  buildFingerprint?: string | null;
  gameBuild?: string | null;
  buildObservedAt?: string | null;
  buildConfidence: Confidence;
  included?: boolean;
  resolverVersion: string;
  effectiveKit: unknown[];
  provenance?: Record<string, unknown>;
}

export interface DraftSlot {
  abilityId: number;
  occurrenceIndex: number;
  slotIndex?: number;
  occurrenceTimeMs: number;
  windowStartMs: number;
  windowEndMs: number;
  priority?: number | null;
  requirementLevel: 'required' | 'recommended' | 'optional';
  demandType: 'raid' | 'personal' | 'tank' | 'external' | 'utility';
  coverageStatus: CoverageStatus;
  assignedPlayerKey?: string | null;
  targetPlayerKey?: string | null;
  defensiveSpellId?: number | null;
  plannedCastAtMs?: number | null;
  prewarnMs?: number;
  source: SlotSource;
  locked?: boolean;
  emergencyReserved?: boolean;
  confidence: Confidence;
  triggerMode?: 'time' | 'bossmod';
  bossmodSpellId?: number | null;
  bossmodCounter?: string | null;
  bossmodCounterVerified?: boolean;
  assignedGroups?: number[] | null;
  effectiveCooldownMsSnapshot?: number | null;
  effectiveDurationMsSnapshot?: number | null;
  chargesSnapshot?: number | null;
  buildFingerprintSnapshot?: string | null;
  notes?: string | null;
  rationale?: Record<string, unknown>;
  /** false = ya cubierto por la duración de un cast anterior del mismo jugador+defensivo; ver defensive-plan-solver.ts. */
  needsFreshCast?: boolean;
  coveredByPriorCastAtMs?: number | null;
}

export interface CreateDraftRequest {
  action: 'create_draft';
  bossId: string;
  difficulty: string;
  name: string;
  planMode: PlanMode;
  planningQuality: 'optimal' | 'fallback_greedy' | 'manual';
  gameBuild?: string | null;
  solverVersion: string;
  resolverVersion: string;
  backendResolved?: boolean;
  rosterFingerprint?: string | null;
  sourceProfileRevision?: string | null;
  sourceCatalogRevision?: string | null;
  supersedesId?: string | null;
  uncertaintyMarginMs?: number;
  fallbackUsed?: boolean;
  rosterSnapshotAt: string;
  diagnostics?: Record<string, unknown>;
  notes?: string | null;
  members: DraftMember[];
  slots: DraftSlot[];
}

const PLAN_MODES = new Set<PlanMode>(['full', 'partial', 'no_plan']);
const ROLES = new Set<Role>(['tank', 'healer', 'dps']);
const COVERAGE = new Set<CoverageStatus>(['covered', 'partial', 'uncovered', 'excluded']);
const SOURCES = new Set<SlotSource>(['automatic', 'manual', 'locked', 'emergency', 'fallback']);
const CONFIDENCE = new Set<Confidence>(['verified', 'inferred', 'fallback', 'uncertain']);
const DEMAND_TYPES = new Set(['raid', 'personal', 'tank', 'external', 'utility']);
const REQUIREMENT_LEVELS = new Set(['required', 'recommended', 'optional']);

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

export function validateDefensivePlanDraft(body: CreateDraftRequest): string | null {
  if (!body.bossId?.trim() || !body.difficulty?.trim() || !body.name?.trim()) return 'bossId, difficulty y name son obligatorios.';
  if (!PLAN_MODES.has(body.planMode) || !['optimal', 'fallback_greedy', 'manual'].includes(body.planningQuality) || !body.solverVersion?.trim() || !body.resolverVersion?.trim()) return 'Versión, calidad o modo de plan inválido.';
  if (!Number.isFinite(Date.parse(body.rosterSnapshotAt))) return 'rosterSnapshotAt no es una fecha válida.';
  if (body.sourceProfileRevision != null && !Number.isFinite(Date.parse(body.sourceProfileRevision))) return 'sourceProfileRevision no es una fecha válida.';
  if (body.sourceCatalogRevision != null && !Number.isFinite(Date.parse(body.sourceCatalogRevision))) return 'sourceCatalogRevision no es una fecha válida.';
  if (!Array.isArray(body.members) || !Array.isArray(body.slots)) return 'members y slots deben ser arrays.';
  if (!nonNegativeInteger(body.uncertaintyMarginMs ?? 0)) return 'uncertaintyMarginMs debe ser un entero no negativo.';

  const memberKeys = new Set<string>();
  for (const member of body.members) {
    if (!member.playerKey?.trim() || memberKeys.has(member.playerKey)) return 'Cada member necesita un playerKey único.';
    if (!member.playerName?.trim() || !member.class?.trim() || !member.resolverVersion?.trim() || !Array.isArray(member.effectiveKit)) {
      return `Member inválido: ${member.playerKey}.`;
    }
    if (member.role != null && !ROLES.has(member.role)) return `Rol inválido para ${member.playerKey}.`;
    if (!CONFIDENCE.has(member.buildConfidence)) return `Confianza de build inválida para ${member.playerKey}.`;
    if (member.buildObservedAt != null && !Number.isFinite(Date.parse(member.buildObservedAt))) return `Fecha de build inválida para ${member.playerKey}.`;
    if (member.raidGroup != null && (!positiveInteger(member.raidGroup) || member.raidGroup > 8)) return `Grupo inválido para ${member.playerKey}.`;
    memberKeys.add(member.playerKey);
  }

  const slotKeys = new Set<string>();
  for (const slot of body.slots) {
    const slotIndex = slot.slotIndex ?? 1;
    const key = `${slot.abilityId}:${slot.occurrenceIndex}:${slotIndex}`;
    if (!positiveInteger(slot.abilityId) || !positiveInteger(slot.occurrenceIndex) || !positiveInteger(slotIndex) || slotKeys.has(key)) {
      return `Identidad de slot inválida o duplicada: ${key}.`;
    }
    if (!nonNegativeInteger(slot.occurrenceTimeMs) || !nonNegativeInteger(slot.windowStartMs) || !nonNegativeInteger(slot.windowEndMs) || slot.windowEndMs < slot.windowStartMs) {
      return `Ventana temporal inválida en ${key}.`;
    }
    if (slot.priority != null && (!positiveInteger(slot.priority) || slot.priority > 5)) return `Prioridad inválida en ${key}.`;
    if (!DEMAND_TYPES.has(slot.demandType) || !REQUIREMENT_LEVELS.has(slot.requirementLevel) || !COVERAGE.has(slot.coverageStatus) || !SOURCES.has(slot.source) || !CONFIDENCE.has(slot.confidence)) {
      return `Semántica inválida en ${key}.`;
    }
    if (slot.effectiveCooldownMsSnapshot != null && !nonNegativeInteger(slot.effectiveCooldownMsSnapshot)) return `Snapshot de cooldown inválido en ${key}.`;
    if (slot.effectiveDurationMsSnapshot != null && !nonNegativeInteger(slot.effectiveDurationMsSnapshot)) return `Snapshot de duración inválido en ${key}.`;
    if (slot.assignedGroups?.some((group) => !positiveInteger(group) || group > 8)) return `Grupos inválidos en ${key}.`;
    const assigned = slot.coverageStatus === 'covered' || slot.coverageStatus === 'partial';
    if (assigned) {
      if (!slot.assignedPlayerKey || !memberKeys.has(slot.assignedPlayerKey) || !positiveInteger(slot.defensiveSpellId) || !nonNegativeInteger(slot.plannedCastAtMs) || !positiveInteger(slot.chargesSnapshot)) {
        return `El slot cubierto ${key} no tiene jugador, spell o tiempo válidos.`;
      }
    } else if (slot.assignedPlayerKey != null || slot.defensiveSpellId != null || slot.plannedCastAtMs != null || slot.chargesSnapshot != null) {
      return `El slot no cubierto ${key} no puede contener una asignación.`;
    }
    if (slot.targetPlayerKey != null && !memberKeys.has(slot.targetPlayerKey)) return `Target desconocido en ${key}.`;
    if ((slot.triggerMode ?? 'time') === 'bossmod' && !positiveInteger(slot.bossmodSpellId)) return `bossmodSpellId inválido en ${key}.`;
    if (slot.coveredByPriorCastAtMs != null && !nonNegativeInteger(slot.coveredByPriorCastAtMs)) return `coveredByPriorCastAtMs inválido en ${key}.`;
    if ((slot.needsFreshCast ?? true) === false && !assigned) return `Un slot no cubierto no puede marcarse como needsFreshCast=false en ${key}.`;
    slotKeys.add(key);
  }
  return null;
}
