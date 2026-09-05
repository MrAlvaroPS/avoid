import type { ResolvedDefensive } from './effective-defensives.ts';

// 2.2.0: cobertura por duración — un cast dentro de cuya duración cae la
// siguiente ocurrencia ya no consume una carga nueva ni genera un segundo
// recordatorio (needsFreshCast/coveredByPriorCastAtMs). Ver progreso 2026-09-03.
export const DEFENSIVE_PLAN_SOLVER_VERSION = 'defensive-plan-solver@2.2.0';

const DEFAULT_SEARCH_BUDGET = 5_000;
const MAX_SEARCH_BUDGET = 5_000;

export type RequirementLevel = 'required' | 'recommended' | 'optional';
export type PlanMode = 'full' | 'partial' | 'no_plan';

export interface MechanicOccurrence {
  abilityId: number;
  occurrenceIndex: number;
  timeMs: number;
  timeUncertaintyMs: number;
  requirementLevel: RequirementLevel;
  priority: number;
  raidImpactScore: number;
  individualLethalityScore: number;
  applicableRoles?: ('tank' | 'healer' | 'dps')[];
  assignedGroups?: number[];
  demandType?: 'raid' | 'personal' | 'tank' | 'external' | 'utility';
  targetPlayerKey?: string | null;
  emergencyEligible?: boolean;
  prewarnMs?: number;
}

export interface SolverPlayerKit {
  playerKey: string;
  playerName: string;
  className: string;
  specName: string | null;
  role: 'tank' | 'healer' | 'dps';
  raidGroup?: number | null;
  buildFingerprint: string | null;
  included?: boolean;
  defensives: ResolvedDefensive[];
}

export interface SolverReservation {
  playerKey: string;
  spellId: number;
  abilityId: number;
  occurrenceIndex: number;
  plannedCastAtMs?: number;
  hard: boolean;
  locked?: boolean;
  source: 'manual' | 'published' | 'template';
  targetPlayerKey?: string | null;
  triggerMode?: 'time' | 'bossmod';
  bossmodSpellId?: number | null;
  bossmodCounter?: string | null;
  bossmodCounterVerified?: boolean;
  notes?: string | null;
}

export interface SolverInput {
  mode: PlanMode;
  occurrences: MechanicOccurrence[];
  players: SolverPlayerKit[];
  reservations?: SolverReservation[];
  maxSearchNodes?: number;
}

export interface SolverAssignment {
  abilityId: number;
  occurrenceIndex: number;
  slotIndex: number;
  occurrenceTimeMs: number;
  windowStartMs: number;
  windowEndMs: number;
  requirementLevel: RequirementLevel;
  priority: number;
  demandType: NonNullable<MechanicOccurrence['demandType']>;
  coverageStatus: 'covered' | 'partial' | 'uncovered' | 'excluded';
  assignedPlayerKey: string | null;
  targetPlayerKey: string | null;
  defensiveSpellId: number | null;
  plannedCastAtMs: number | null;
  prewarnMs: number;
  source: 'automatic' | 'manual' | 'locked' | 'emergency' | 'fallback';
  locked: boolean;
  emergencyReserved: boolean;
  confidence: ResolvedDefensive['confidence'];
  triggerMode: 'time' | 'bossmod';
  bossmodSpellId: number | null;
  bossmodCounter: string | null;
  bossmodCounterVerified: boolean;
  assignedGroups: number[] | null;
  effectiveCooldownMsSnapshot: number | null;
  effectiveDurationMsSnapshot: number | null;
  chargesSnapshot: number | null;
  buildFingerprintSnapshot: string | null;
  notes: string | null;
  rationale: Record<string, unknown>;
  /**
   * §"un cast debe cubrir toda su ventana de duración (no un recordatorio
   * por cada ocurrencia cercana)" (feedback real, 2026-09-03). El solver
   * decide QUÉ jugador/defensivo cubre cada ocurrencia mirando solo
   * cooldown/cargas; dos ocurrencias del mismo jugador+defensivo pueden
   * caer ambas dentro de la duración de UN único cast. `false` significa
   * que este slot está protegido por un cast anterior todavía activo — no
   * hace falta pulsar nada de nuevo, así que no debe generar un segundo
   * recordatorio de MRT. `true` (o ausente en asignaciones no cubiertas)
   * significa que sí hace falta un press nuevo.
   */
  needsFreshCast: boolean;
  /** Cuándo se pulsó el cast anterior que ya cubre este slot, si needsFreshCast es false. */
  coveredByPriorCastAtMs: number | null;
}

export interface SolverResult {
  solverVersion: typeof DEFENSIVE_PLAN_SOLVER_VERSION;
  mode: PlanMode;
  feasible: boolean;
  coverageComplete: boolean;
  planningQuality: 'optimal' | 'fallback_greedy';
  strictScoringEligible: boolean;
  assignments: SolverAssignment[];
  diagnostics: {
    searchNodes: number;
    searchBudget: number;
    fallbackReason: 'search_budget_exceeded' | 'search_space_exceeds_budget' | null;
    hardConflicts: string[];
    uncoveredRequired: { abilityId: number; occurrenceIndex: number }[];
  };
}

interface Usage {
  timeMs: number;
  uncertaintyMs: number;
  identity: string;
  /**
   * Instante real de la ocurrencia que este uso protege (no el planned cast,
   * que puede ir adelantado por prewarn). Si se omite, se asume igual a
   * timeMs — comportamiento histórico para llamadas que no conocen duración.
   */
  occurrenceAtMs?: number;
  /**
   * Duración efectiva del defensivo en este uso. Si se omite o es 0, este
   * uso no cubre nada más allá de sí mismo (comportamiento histórico).
   */
  durationMs?: number;
}

interface Candidate {
  occurrence: MechanicOccurrence;
  player: SolverPlayerKit;
  defensive: ResolvedDefensive;
  reservation: SolverReservation | null;
  plannedCastAtMs: number;
  opportunityCostMs: number;
}

interface SearchScore {
  requiredCovered: number;
  individualLethality: number;
  raidImpact: number;
  confidenceValue: number;
  opportunityCost: number;
  additionalCovered: number;
  signature: string;
}

const confidenceValue: Record<ResolvedDefensive['confidence'], number> = {
  verified: 3,
  inferred: 2,
  fallback: 1,
  uncertain: 0,
};

function occurrenceKey(occurrence: Pick<MechanicOccurrence, 'abilityId' | 'occurrenceIndex'>): string {
  return `${occurrence.abilityId}:${occurrence.occurrenceIndex}`;
}

function resourceKey(playerKey: string, spellId: number): string {
  return `${playerKey}\u0000${spellId}`;
}

function compareOccurrences(left: MechanicOccurrence, right: MechanicOccurrence): number {
  return left.timeMs - right.timeMs || left.abilityId - right.abilityId || left.occurrenceIndex - right.occurrenceIndex;
}

function plannedCastAt(occurrence: MechanicOccurrence, reservation?: SolverReservation | null): number {
  return reservation?.plannedCastAtMs ?? Math.max(0, occurrence.timeMs - (occurrence.prewarnMs ?? 0));
}

/**
 * Simula cargas con recharge secuencial. Cada uso anterior se considera en su
 * instante más tardío y el siguiente en el más temprano; si aun así hay una
 * carga, el schedule es seguro dentro de todos los percentiles declarados.
 *
 * §"un cast debe cubrir toda su ventana de duración (no un recordatorio por
 * cada ocurrencia cercana)" (feedback real, 2026-09-03): antes de consumir
 * una carga nueva, un uso comprueba si el peor caso (p90) de su propia
 * ocurrencia ya cae dentro de la ventana activa [cast, cast+duración] de un
 * uso anterior del MISMO recurso — si es así, no hace falta un press nuevo,
 * así que no consume carga ni entra en la cola de recarga. `occurrenceAtMs`/
 * `durationMs` son opcionales: ausentes, el comportamiento es idéntico al
 * histórico (duración 0 nunca cubre nada más allá de sí misma).
 */
export function isConservativeScheduleFeasible(defensive: ResolvedDefensive, usages: Usage[]): boolean {
  if (!defensive.eligible || defensive.effectiveCooldownMs == null || defensive.effectiveCooldownMs < 0) return false;
  const charges = Math.max(1, Math.trunc(defensive.charges || 1));
  const rechargeMs = defensive.rechargeMs ?? defensive.effectiveCooldownMs;
  if (!Number.isFinite(rechargeMs) || rechargeMs < 0) return false;

  let available = charges;
  const rechargeReadyAt: number[] = [];
  let activeCoverageEndMs = -Infinity;
  for (const usage of [...usages].sort((left, right) => left.timeMs - right.timeMs || left.identity.localeCompare(right.identity))) {
    const worstCaseNeedAtMs = (usage.occurrenceAtMs ?? usage.timeMs) + Math.max(0, usage.uncertaintyMs);
    if (worstCaseNeedAtMs <= activeCoverageEndMs) continue;

    const earliest = Math.max(0, usage.timeMs - Math.max(0, usage.uncertaintyMs));
    const latest = usage.timeMs + Math.max(0, usage.uncertaintyMs);
    while (rechargeReadyAt.length && rechargeReadyAt[0] <= earliest) {
      rechargeReadyAt.shift();
      available = Math.min(charges, available + 1);
    }
    if (available <= 0) return false;
    available--;
    activeCoverageEndMs = Math.max(activeCoverageEndMs, usage.timeMs + Math.max(0, usage.durationMs ?? 0));
    const rechargeStartsAt = rechargeReadyAt.length ? rechargeReadyAt[rechargeReadyAt.length - 1] : latest;
    rechargeReadyAt.push(Math.max(rechargeStartsAt, latest) + rechargeMs);
  }
  return true;
}

function roleAndGroupApply(occurrence: MechanicOccurrence, player: SolverPlayerKit): boolean {
  if (occurrence.applicableRoles?.length && !occurrence.applicableRoles.includes(player.role)) return false;
  if (occurrence.assignedGroups?.length && (player.raidGroup == null || !occurrence.assignedGroups.includes(player.raidGroup))) return false;
  return true;
}

function targetSemanticsApply(
  occurrence: MechanicOccurrence,
  player: SolverPlayerKit,
  defensive: ResolvedDefensive,
  targetPlayerKey: string | null,
): boolean {
  if (defensive.category === 'utility') return false;
  if (defensive.category === 'external_defensive') {
    if (defensive.targetingMode === 'raid') {
      return occurrence.demandType === 'raid' && targetPlayerKey == null;
    }
    return (
      occurrence.demandType === 'external' &&
      targetPlayerKey != null &&
      targetPlayerKey !== player.playerKey &&
      (defensive.targetingMode === 'ally' || defensive.targetingMode === 'both')
    );
  }
  if (defensive.targetingMode === 'ally' || defensive.targetingMode === 'unknown') return false;
  if (occurrence.demandType === 'external') return false;
  return defensive.targetingMode === 'self' || defensive.targetingMode === 'both' || defensive.targetingMode === 'raid';
}

function candidateAllowed(
  occurrence: MechanicOccurrence,
  player: SolverPlayerKit,
  defensive: ResolvedDefensive,
  reservation: SolverReservation | null,
): boolean {
  if (player.included === false || !defensive.eligible || defensive.effectiveCooldownMs == null) return false;
  if (!roleAndGroupApply(occurrence, player)) return false;
  if (defensive.survivalType === 'emergency' && !occurrence.emergencyEligible && !reservation?.hard) return false;
  return targetSemanticsApply(occurrence, player, defensive, reservation?.targetPlayerKey ?? occurrence.targetPlayerKey ?? null);
}

function candidateSort(left: Candidate, right: Candidate): number {
  const leftPreferred = left.reservation ? 0 : 1;
  const rightPreferred = right.reservation ? 0 : 1;
  const leftEmergency = left.defensive.survivalType === 'emergency' ? 1 : 0;
  const rightEmergency = right.defensive.survivalType === 'emergency' ? 1 : 0;
  return (
    leftPreferred - rightPreferred ||
    leftEmergency - rightEmergency ||
    (left.defensive.rechargeMs ?? left.defensive.effectiveCooldownMs ?? Number.MAX_SAFE_INTEGER) -
      (right.defensive.rechargeMs ?? right.defensive.effectiveCooldownMs ?? Number.MAX_SAFE_INTEGER) ||
    left.defensive.spellId - right.defensive.spellId ||
    left.player.playerKey.localeCompare(right.player.playerKey)
  );
}

function assignmentSource(candidate: Candidate, fallback: boolean): SolverAssignment['source'] {
  if (candidate.reservation?.hard || candidate.reservation?.locked) return candidate.reservation.source === 'manual' ? 'manual' : 'locked';
  if (fallback) return 'fallback';
  if (candidate.defensive.survivalType === 'emergency') return 'emergency';
  if (candidate.reservation?.source === 'manual') return 'manual';
  return 'automatic';
}

function toAssignment(candidate: Candidate, fallback: boolean): SolverAssignment {
  const { occurrence, player, defensive, reservation } = candidate;
  const confidence = defensive.confidence;
  return {
    abilityId: occurrence.abilityId,
    occurrenceIndex: occurrence.occurrenceIndex,
    slotIndex: 1,
    occurrenceTimeMs: occurrence.timeMs,
    windowStartMs: Math.max(0, occurrence.timeMs - occurrence.timeUncertaintyMs),
    windowEndMs: occurrence.timeMs + occurrence.timeUncertaintyMs,
    requirementLevel: occurrence.requirementLevel,
    priority: occurrence.priority,
    demandType: occurrence.demandType ?? 'personal',
    coverageStatus: confidence === 'fallback' || confidence === 'uncertain' ? 'partial' : 'covered',
    assignedPlayerKey: player.playerKey,
    targetPlayerKey: reservation?.targetPlayerKey ?? occurrence.targetPlayerKey ?? null,
    defensiveSpellId: defensive.spellId,
    plannedCastAtMs: candidate.plannedCastAtMs,
    prewarnMs: occurrence.prewarnMs ?? 0,
    source: assignmentSource(candidate, fallback),
    locked: Boolean(reservation?.hard || reservation?.locked),
    emergencyReserved: defensive.survivalType === 'emergency',
    confidence,
    triggerMode: reservation?.triggerMode ?? 'time',
    bossmodSpellId: reservation?.bossmodSpellId ?? null,
    bossmodCounter: reservation?.bossmodCounter ?? null,
    bossmodCounterVerified: reservation?.bossmodCounterVerified ?? false,
    assignedGroups: occurrence.assignedGroups?.length ? [...occurrence.assignedGroups].sort((a, b) => a - b) : null,
    effectiveCooldownMsSnapshot: defensive.effectiveCooldownMs,
    effectiveDurationMsSnapshot: defensive.effectiveDurationMs,
    chargesSnapshot: defensive.charges,
    buildFingerprintSnapshot: player.buildFingerprint,
    notes: reservation?.notes ?? null,
    rationale: {
      solverVersion: DEFENSIVE_PLAN_SOLVER_VERSION,
      reservationSource: reservation?.source ?? null,
      timeUncertaintyMs: occurrence.timeUncertaintyMs,
      raidImpactScore: occurrence.raidImpactScore,
      individualLethalityScore: occurrence.individualLethalityScore,
    },
    // Se recalcula para todo el plan en markDurationCoverage() antes de devolver el resultado.
    needsFreshCast: true,
    coveredByPriorCastAtMs: null,
  };
}

function uncoveredAssignment(occurrence: MechanicOccurrence): SolverAssignment {
  return {
    abilityId: occurrence.abilityId,
    occurrenceIndex: occurrence.occurrenceIndex,
    slotIndex: 1,
    occurrenceTimeMs: occurrence.timeMs,
    windowStartMs: Math.max(0, occurrence.timeMs - occurrence.timeUncertaintyMs),
    windowEndMs: occurrence.timeMs + occurrence.timeUncertaintyMs,
    requirementLevel: occurrence.requirementLevel,
    priority: occurrence.priority,
    demandType: occurrence.demandType ?? 'personal',
    coverageStatus: 'uncovered',
    assignedPlayerKey: null,
    targetPlayerKey: occurrence.targetPlayerKey ?? null,
    defensiveSpellId: null,
    plannedCastAtMs: null,
    prewarnMs: occurrence.prewarnMs ?? 0,
    source: 'automatic',
    locked: false,
    emergencyReserved: false,
    confidence: 'uncertain',
    triggerMode: 'time',
    bossmodSpellId: null,
    bossmodCounter: null,
    bossmodCounterVerified: false,
    assignedGroups: occurrence.assignedGroups?.length ? [...occurrence.assignedGroups].sort((a, b) => a - b) : null,
    effectiveCooldownMsSnapshot: null,
    effectiveDurationMsSnapshot: null,
    chargesSnapshot: null,
    buildFingerprintSnapshot: null,
    notes: null,
    rationale: { solverVersion: DEFENSIVE_PLAN_SOLVER_VERSION, reason: 'no_feasible_assignment' },
    needsFreshCast: true,
    coveredByPriorCastAtMs: null,
  };
}

/**
 * Recorre las asignaciones cubiertas agrupadas por jugador+defensivo y marca
 * `needsFreshCast: false` cuando la duración de un cast anterior ya llega
 * hasta el peor caso (p90) de una ocurrencia posterior — el DFS/greedy elige
 * jugador+defensivo mirando solo cooldown/cargas, así que dos ocurrencias
 * cercanas del mismo recurso pueden quedar "cubiertas" cada una con su
 * propio cast aunque el primero por sí solo ya bastase. Nunca toca
 * coverageStatus (el jugador sigue protegido) ni reordena occurrences.
 */
function markDurationCoverage(assignments: SolverAssignment[]): void {
  const byResource = new Map<string, SolverAssignment[]>();
  for (const assignment of assignments) {
    if (assignment.coverageStatus !== 'covered' && assignment.coverageStatus !== 'partial') continue;
    if (assignment.assignedPlayerKey == null || assignment.defensiveSpellId == null || assignment.plannedCastAtMs == null) continue;
    const key = resourceKey(assignment.assignedPlayerKey, assignment.defensiveSpellId);
    const list = byResource.get(key) ?? [];
    list.push(assignment);
    byResource.set(key, list);
  }
  for (const list of byResource.values()) {
    list.sort((a, b) => a.plannedCastAtMs! - b.plannedCastAtMs! || a.occurrenceTimeMs - b.occurrenceTimeMs);
    let activeCastAtMs: number | null = null;
    let activeCoverageEndMs = -Infinity;
    for (const assignment of list) {
      // Reservas manuales/publicadas o locks nunca se reinterpretan como
      // "redundantes": un raider que fijó ese slot a propósito lo quiere ahí.
      if (assignment.locked || assignment.source === 'manual') {
        activeCastAtMs = assignment.plannedCastAtMs!;
        activeCoverageEndMs = activeCastAtMs + (assignment.effectiveDurationMsSnapshot ?? 0);
        continue;
      }
      const worstCaseHitAtMs = assignment.windowEndMs;
      if (activeCastAtMs != null && worstCaseHitAtMs <= activeCoverageEndMs) {
        assignment.needsFreshCast = false;
        assignment.coveredByPriorCastAtMs = activeCastAtMs;
        continue;
      }
      activeCastAtMs = assignment.plannedCastAtMs!;
      activeCoverageEndMs = activeCastAtMs + (assignment.effectiveDurationMsSnapshot ?? 0);
    }
  }
}

function compareScores(left: SearchScore, right: SearchScore): number {
  return (
    left.requiredCovered - right.requiredCovered ||
    left.individualLethality - right.individualLethality ||
    left.raidImpact - right.raidImpact ||
    left.confidenceValue - right.confidenceValue ||
    right.opportunityCost - left.opportunityCost ||
    left.additionalCovered - right.additionalCovered ||
    -left.signature.localeCompare(right.signature)
  );
}

function scoreAssignments(assignments: Candidate[], occurrenceByKey: Map<string, MechanicOccurrence>): SearchScore {
  const covered = new Map<string, Candidate>();
  for (const assignment of assignments) {
    const key = occurrenceKey(assignment.occurrence);
    const previous = covered.get(key);
    if (!previous || candidateSort(assignment, previous) < 0) covered.set(key, assignment);
  }
  let requiredCovered = 0;
  let individualLethality = 0;
  let raidImpact = 0;
  let confidence = 0;
  let opportunityCost = 0;
  let additionalCovered = 0;
  for (const [key, candidate] of covered) {
    const occurrence = occurrenceByKey.get(key)!;
    if (occurrence.requirementLevel === 'required') requiredCovered++;
    else additionalCovered++;
    individualLethality += occurrence.individualLethalityScore;
    raidImpact += occurrence.raidImpactScore * Math.max(1, occurrence.priority);
    confidence += confidenceValue[candidate.defensive.confidence];
    if (!candidate.reservation?.hard) opportunityCost += candidate.opportunityCostMs;
  }
  const signature = assignments
    .map((candidate) => `${candidate.plannedCastAtMs.toString().padStart(10, '0')}:${candidate.defensive.spellId}:${candidate.player.playerKey}`)
    .sort()
    .join('|');
  return { requiredCovered, individualLethality, raidImpact, confidenceValue: confidence, opportunityCost, additionalCovered, signature };
}

function cloneSchedules(source: Map<string, Usage[]>): Map<string, Usage[]> {
  return new Map([...source.entries()].map(([key, usages]) => [key, [...usages]]));
}

function addIfFeasible(candidate: Candidate, schedules: Map<string, Usage[]>): Map<string, Usage[]> | null {
  const key = resourceKey(candidate.player.playerKey, candidate.defensive.spellId);
  const next = cloneSchedules(schedules);
  const usages = next.get(key) ?? [];
  usages.push({
    timeMs: candidate.plannedCastAtMs,
    uncertaintyMs: candidate.occurrence.timeUncertaintyMs,
    identity: occurrenceKey(candidate.occurrence),
    occurrenceAtMs: candidate.occurrence.timeMs,
    durationMs: candidate.defensive.effectiveDurationMs ?? 0,
  });
  if (!isConservativeScheduleFeasible(candidate.defensive, usages)) return null;
  next.set(key, usages);
  return next;
}

function candidatesFor(
  occurrence: MechanicOccurrence,
  players: SolverPlayerKit[],
  softReservations: SolverReservation[],
): Candidate[] {
  const preferred = new Map(softReservations.map((reservation) => [resourceKey(reservation.playerKey, reservation.spellId), reservation]));
  const candidates: Candidate[] = [];
  for (const player of players) {
    for (const defensive of player.defensives) {
      const reservation = preferred.get(resourceKey(player.playerKey, defensive.spellId)) ?? null;
      if (!candidateAllowed(occurrence, player, defensive, reservation)) continue;
      candidates.push({ occurrence, player, defensive, reservation, plannedCastAtMs: plannedCastAt(occurrence, reservation), opportunityCostMs: 0 });
    }
  }
  const shortestRecharge = Math.min(
    ...candidates.map((candidate) => candidate.defensive.rechargeMs ?? candidate.defensive.effectiveCooldownMs ?? 0),
  );
  candidates.forEach((candidate) => {
    candidate.opportunityCostMs = Math.max(
      0,
      (candidate.defensive.rechargeMs ?? candidate.defensive.effectiveCooldownMs ?? 0) - shortestRecharge,
    );
  });
  return candidates.sort(candidateSort);
}

function finalizeAssignments(
  occurrences: MechanicOccurrence[],
  selected: Candidate[],
  fallback: boolean,
): SolverAssignment[] {
  const byOccurrence = new Map<string, Candidate[]>();
  for (const candidate of selected) {
    const key = occurrenceKey(candidate.occurrence);
    const values = byOccurrence.get(key) ?? [];
    values.push(candidate);
    byOccurrence.set(key, values);
  }
  const output: SolverAssignment[] = [];
  for (const occurrence of [...occurrences].sort(compareOccurrences)) {
    const candidates = (byOccurrence.get(occurrenceKey(occurrence)) ?? []).sort(candidateSort);
    if (!candidates.length) {
      output.push(uncoveredAssignment(occurrence));
      continue;
    }
    candidates.forEach((candidate, index) => output.push({ ...toAssignment(candidate, fallback), slotIndex: index + 1 }));
  }
  return output;
}

export function solveDefensivePlan(input: SolverInput): SolverResult {
  // El runtime alojado de Supabase tiene un presupuesto CPU estricto. Nunca
  // aceptamos un límite arbitrario del cliente y evitamos arrancar el DFS si
  // su árbol bruto ya excede el presupuesto: ese camino acababa igualmente
  // en el mismo greedy, pero después de decenas de miles de clones de Map.
  const requestedSearchBudget = Number.isFinite(input.maxSearchNodes)
    ? Math.trunc(input.maxSearchNodes!)
    : DEFAULT_SEARCH_BUDGET;
  const searchBudget = Math.max(1, Math.min(MAX_SEARCH_BUDGET, requestedSearchBudget));
  const occurrences = [...input.occurrences].sort(compareOccurrences);
  const occurrenceByKey = new Map(occurrences.map((occurrence) => [occurrenceKey(occurrence), occurrence]));
  const players = [...input.players]
    .filter((player) => player.included !== false)
    .sort((left, right) => left.playerKey.localeCompare(right.playerKey));
  const playerByKey = new Map(players.map((player) => [player.playerKey, player]));
  const reservations = [...(input.reservations ?? [])].sort(
    (left, right) =>
      left.abilityId - right.abilityId ||
      left.occurrenceIndex - right.occurrenceIndex ||
      left.spellId - right.spellId ||
      left.playerKey.localeCompare(right.playerKey),
  );
  const hardReservations = reservations.filter((reservation) => reservation.hard || reservation.locked);
  const hardKeys = new Set(hardReservations.map(occurrenceKey));
  const hardCandidates: Candidate[] = [];
  const hardConflicts: string[] = [];
  let hardSchedules = new Map<string, Usage[]>();

  for (const reservation of hardReservations) {
    const occurrence = occurrenceByKey.get(occurrenceKey(reservation));
    const player = playerByKey.get(reservation.playerKey);
    const defensive = player?.defensives.find((entry) => entry.spellId === reservation.spellId);
    if (!occurrence || !player || !defensive || !candidateAllowed(occurrence, player, defensive, reservation)) {
      hardConflicts.push(`Reserva inválida ${occurrenceKey(reservation)}:${reservation.playerKey}:${reservation.spellId}.`);
      continue;
    }
    const candidate: Candidate = {
      occurrence,
      player,
      defensive,
      reservation,
      plannedCastAtMs: plannedCastAt(occurrence, reservation),
      opportunityCostMs: 0,
    };
    const next = addIfFeasible(candidate, hardSchedules);
    if (!next) {
      hardConflicts.push(`Reserva incompatible con cooldown/cargas ${occurrenceKey(reservation)}:${reservation.playerKey}:${reservation.spellId}.`);
      continue;
    }
    hardSchedules = next;
    hardCandidates.push(candidate);
  }

  if (hardConflicts.length) {
    const assignments = finalizeAssignments(occurrences, hardCandidates, false);
    return {
      solverVersion: DEFENSIVE_PLAN_SOLVER_VERSION,
      mode: input.mode,
      feasible: false,
      coverageComplete: false,
      planningQuality: 'optimal',
      strictScoringEligible: false,
      assignments,
      diagnostics: {
        searchNodes: 0,
        searchBudget,
        fallbackReason: null,
        hardConflicts,
        uncoveredRequired: assignments
          .filter((slot) => slot.requirementLevel === 'required' && slot.coverageStatus === 'uncovered')
          .map((slot) => ({ abilityId: slot.abilityId, occurrenceIndex: slot.occurrenceIndex })),
      },
    };
  }

  const decisions = occurrences.filter((occurrence) => !hardKeys.has(occurrenceKey(occurrence)));
  const softByOccurrence = new Map<string, SolverReservation[]>();
  for (const reservation of reservations.filter((entry) => !entry.hard && !entry.locked)) {
    const key = occurrenceKey(reservation);
    const values = softByOccurrence.get(key) ?? [];
    values.push(reservation);
    softByOccurrence.set(key, values);
  }
  const candidatesByOccurrence = new Map(
    decisions.map((occurrence) => [
      occurrenceKey(occurrence),
      candidatesFor(occurrence, players, softByOccurrence.get(occurrenceKey(occurrence)) ?? []),
    ]),
  );

  let estimatedSearchNodes = 1;
  let nodesAtDepth = 1;
  for (const occurrence of decisions) {
    nodesAtDepth *= (candidatesByOccurrence.get(occurrenceKey(occurrence))?.length ?? 0) + 1;
    estimatedSearchNodes += nodesAtDepth;
    if (estimatedSearchNodes > searchBudget) break;
  }

  let searchNodes = 0;
  let budgetExceeded = estimatedSearchNodes > searchBudget;
  let fallbackReason: SolverResult['diagnostics']['fallbackReason'] = budgetExceeded ? 'search_space_exceeds_budget' : null;
  let bestCandidates: Candidate[] | null = null;
  let bestScore: SearchScore | null = null;

  function search(index: number, selected: Candidate[], schedules: Map<string, Usage[]>): void {
    searchNodes++;
    if (searchNodes > searchBudget) {
      budgetExceeded = true;
      fallbackReason = 'search_budget_exceeded';
      return;
    }
    if (index >= decisions.length) {
      const all = [...hardCandidates, ...selected];
      const score = scoreAssignments(all, occurrenceByKey);
      if (!bestScore || compareScores(score, bestScore) > 0) {
        bestScore = score;
        bestCandidates = all;
      }
      return;
    }

    const occurrence = decisions[index];
    const candidates = candidatesByOccurrence.get(occurrenceKey(occurrence)) ?? [];
    for (const candidate of candidates) {
      const next = addIfFeasible(candidate, schedules);
      if (next) search(index + 1, [...selected, candidate], next);
      if (budgetExceeded) return;
    }
    search(index + 1, selected, schedules);
  }

  if (!budgetExceeded) search(0, [], hardSchedules);

  if (budgetExceeded) {
    const selected = [...hardCandidates];
    let schedules = hardSchedules;
    const greedyOrder = [...decisions].sort(
      (left, right) =>
        (left.requirementLevel === 'required' ? 0 : left.requirementLevel === 'recommended' ? 1 : 2) -
          (right.requirementLevel === 'required' ? 0 : right.requirementLevel === 'recommended' ? 1 : 2) ||
        right.individualLethalityScore - left.individualLethalityScore ||
        right.raidImpactScore - left.raidImpactScore ||
        right.priority - left.priority ||
        compareOccurrences(left, right),
    );
    for (const occurrence of greedyOrder) {
      for (const candidate of candidatesByOccurrence.get(occurrenceKey(occurrence)) ?? []) {
        const next = addIfFeasible(candidate, schedules);
        if (!next) continue;
        selected.push(candidate);
        schedules = next;
        break;
      }
    }
    bestCandidates = selected;
  }

  const assignments = finalizeAssignments(occurrences, bestCandidates ?? hardCandidates, budgetExceeded);
  markDurationCoverage(assignments);
  const uncoveredRequired = assignments
    .filter((slot) => slot.requirementLevel === 'required' && slot.coverageStatus === 'uncovered')
    .map((slot) => ({ abilityId: slot.abilityId, occurrenceIndex: slot.occurrenceIndex }));
  const coverageComplete = assignments.every((slot) => slot.coverageStatus === 'covered' || slot.coverageStatus === 'excluded');
  const hasUncertainAssignment = assignments.some((slot) => slot.coverageStatus === 'partial');

  return {
    solverVersion: DEFENSIVE_PLAN_SOLVER_VERSION,
    mode: input.mode,
    feasible: true,
    coverageComplete,
    planningQuality: budgetExceeded ? 'fallback_greedy' : 'optimal',
    strictScoringEligible: !budgetExceeded && !hasUncertainAssignment && input.mode !== 'no_plan',
    assignments,
    diagnostics: {
      searchNodes: Math.min(searchNodes, searchBudget),
      searchBudget,
      fallbackReason,
      hardConflicts: [],
      uncoveredRequired,
    },
  };
}
