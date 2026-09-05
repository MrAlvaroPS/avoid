import type { DefensiveResolutionConfidence, ResolvedDefensive } from './effective-defensives.ts';
// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import { effectiveDefensiveStateAt } from './effective-defensive-state.ts';
// @ts-ignore Same cross-runtime boundary as above.
import { isConservativeScheduleFeasible } from './defensive-plan-solver.ts';
// @ts-ignore Same cross-runtime boundary as above.
import { computeDefensiveManagementScore } from './defensive-management-score.ts';

// §2.4.0 (feedback real, 2026-09-03): corrige el sentinel "Environment"/
// targetActorId -1 en observedCasts() (un auto-cast de Barkskin se
// descartaba como si fuera de otro jugador), añade requirementLevel real
// para ventanas sin plan (antes siempre 'recommended', ahora sale de
// boss_mechanic_defensive_planning_view igual que el solver), hace viajar
// peakValue hasta la card, y añade una salvaguarda: un cast propio no
// explicado dentro de una ventana/secuencia letal nunca se traduce en un
// fallo confirmado, degrada a incertidumbre. Cambia el resultado de
// evaluateDefensiveExecution — filas 2.3.0 quedan fuera de una generación
// v2 homogénea hasta reanalizarse, mismo criterio que el salto anterior.
export const DEFENSIVE_EXECUTION_EVALUATOR_VERSION = 'defensive-execution-evaluator@2.4.0';

export type DefensiveExecutionState =
  | 'plan_covered'
  | 'covered_with_substitution'
  | 'correct_hold'
  | 'safe_extra_use'
  | 'missed_extra_opportunity'
  | 'plan_broken'
  | 'reminder_missed'
  | 'death_with_viable_cd'
  | 'death_with_ready_cd'
  | 'no_feasible_alternative'
  | 'uncertain_data';

export type DefensiveEvaluationReason =
  | 'PLANNED_CAST_IN_WINDOW'
  | 'SUBSTITUTE_VALID_NO_FUTURE_COST'
  | 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT'
  | 'RESERVED_HIGHER_PRIORITY'
  | 'SAFE_EXTRA_USE'
  | 'COUNTERFACTUAL_FEASIBLE'
  | 'EARLY_CAST_CAUSED_MISS'
  | 'READY_NOT_CAST_IN_WINDOW'
  | 'DEATH_COUNTERFACTUAL_FEASIBLE'
  | 'DEATH_READY_AT_END_ONLY'
  | 'NO_COUNTERFACTUAL_SCHEDULE'
  | 'TARGET_MISMATCH'
  | 'UNRESOLVED_BUILD_OR_RULE';

export interface EvaluationPlanSlot {
  id: string;
  abilityId: number;
  occurrenceIndex: number;
  occurrenceTimeMs: number;
  windowStartMs: number;
  windowEndMs: number;
  priority: number;
  requirementLevel: 'required' | 'recommended' | 'optional';
  coverageStatus: 'covered' | 'partial' | 'uncovered' | 'excluded';
  assignedPlayerKey: string | null;
  targetPlayerKey: string | null;
  defensiveSpellId: number | null;
  plannedCastAtMs: number | null;
  confidence: DefensiveResolutionConfidence;
}

export interface ObservedDefensiveCast {
  sourcePlayerKey: string;
  spellId: number;
  timeMs: number;
  targetPlayerKey?: string | null;
  targetActorId?: number | null;
  targetName?: string | null;
}

export interface EvaluationPressureWindow {
  id: string;
  startMs: number;
  endMs: number;
  peakMs: number;
  priority: number;
  critical: boolean;
  mechanicId?: number | null;
  coverageRequirement?:
    | { kind: 'ANY_OF' }
    | { kind: 'ALL_OF' }
    | { kind: 'MIN_N'; count: number }
    | { kind: 'LAYERED' };
  /** §"buscarle la lógica... ahora que sabemos cuáles son las ventanas de
   * daño... podemos saber qué daño era evitable, dónde se debía tirar un
   * defensivo" (feedback real, 2026-09-03): mismo criterio que ya usa el
   * solver (generate-defensive-plan/index.ts) contra
   * boss_mechanic_defensive_planning_view — sin esto, evaluateUnplannedWindow
   * trataba toda ventana sin plan como 'recommended' (peso 1) sin mirar si la
   * mecánica real exige defensivo. undefined = sin clasificación resuelta,
   * cae al valor por defecto de siempre.
   */
  requirementLevel?: 'required' | 'recommended' | 'optional';
  /** Pico de daño real de la ventana (mismo dato que ya trae el sensor,
   * defensive_pressure_windows_v2) — antes se perdía al construir esta
   * ventana; sin él es imposible decir "era la mecánica de más daño". */
  peakValue?: number;
}

export interface DefensiveExecutionEvaluationInput {
  playerKey: string;
  playerName: string;
  mode: 'full' | 'partial' | 'no_plan';
  planVersionId: string | null;
  gameBuild: string | null;
  buildFingerprint: string | null;
  resolverVersion: string;
  solverVersion: string;
  solverStrictScoringEligible: boolean;
  dataConfidence: DefensiveResolutionConfidence;
  kit: ResolvedDefensive[];
  slots: EvaluationPlanSlot[];
  casts: ObservedDefensiveCast[];
  windows: EvaluationPressureWindow[];
  deathTimeMs?: number | null;
  /** Inicio observado de la secuencia de daÃ±o previa a la muerte. Sin esta
   * evidencia solo puede afirmarse disponibilidad al final, no respuesta
   * factible durante la ventana letal. */
  lethalWindowStartMs?: number | null;
  /** Wipe call: nada a partir de este instante forma parte del intento evaluable. */
  evaluationCutoffMs?: number | null;
}

export interface DefensiveExecutionEvaluationEvent {
  state: DefensiveExecutionState;
  reason: DefensiveEvaluationReason;
  atMs: number;
  coverageOutcome: 'covered' | 'uncovered' | 'not_applicable' | 'uncertain';
  adherenceOutcome: 'followed' | 'substituted' | 'held' | 'broken' | 'missed' | 'not_applicable' | 'uncertain';
  managementOutcome: 'success' | 'failure' | 'neutral' | 'uncertain';
  requirementLevel?: 'required' | 'recommended' | 'optional';
  slotId?: string;
  windowId?: string;
  abilityId?: number;
  occurrenceIndex?: number;
  plannedSpellId?: number;
  actualSpellId?: number;
  actualCastAtMs?: number;
  targetPlayerKey?: string | null;
  relatedFutureSlotId?: string;
  relatedFutureAtMs?: number;
  cooldownRemainingMs?: number;
  candidateSpellIds?: number[];
  lethalWindowStartMs?: number;
  /** Pico de daño real de la ventana que originó este evento — ver
   * EvaluationPressureWindow.peakValue. undefined para eventos que no vienen
   * de una ventana de presión (slots de plan, muertes). */
  peakValue?: number;
  causalGroupId?: string;
  primaryPenalty?: boolean;
}

export interface DefensiveExecutionEvaluationResult {
  playerName: string;
  planVersionId: string | null;
  mode: DefensiveExecutionEvaluationInput['mode'];
  gameBuild: string | null;
  buildFingerprint: string | null;
  resolverVersion: string;
  solverVersion: string;
  evaluatorVersion: typeof DEFENSIVE_EXECUTION_EVALUATOR_VERSION;
  planRequiredCount: number;
  requiredExactAdherenceCount: number;
  requiredCoverageSuccessCount: number;
  planExecutedCount: number;
  criticalWindowCount: number;
  criticalCoveredCount: number;
  correctHoldCount: number;
  brokenReservationCount: number;
  reminderMissedCount: number;
  viableExtraCount: number;
  extraUsedCount: number;
  deathViableCdCount: number;
  managementScore: number | null;
  dataConfidence: DefensiveResolutionConfidence;
  events: DefensiveExecutionEvaluationEvent[];
}

function trusted(confidence: DefensiveResolutionConfidence): boolean {
  return confidence === 'verified' || confidence === 'inferred';
}

function relevantAssignedSlots(input: DefensiveExecutionEvaluationInput): EvaluationPlanSlot[] {
  return input.slots
    .filter(
      (slot) =>
        slot.assignedPlayerKey === input.playerKey &&
        slot.defensiveSpellId != null &&
        (input.evaluationCutoffMs == null || slot.occurrenceTimeMs < input.evaluationCutoffMs) &&
        (slot.coverageStatus === 'covered' || slot.coverageStatus === 'partial'),
    )
    .sort(
      (left, right) =>
        left.occurrenceTimeMs - right.occurrenceTimeMs ||
        left.abilityId - right.abilityId ||
        left.occurrenceIndex - right.occurrenceIndex ||
        left.id.localeCompare(right.id),
    );
}

function castHasReliableTarget(cast: ObservedDefensiveCast): boolean {
  // undefined = WCL/evento legacy no aportó target. null = sí había un
  // target identificable, pero no pertenece al roster desplegado.
  return cast.targetPlayerKey !== undefined;
}

function castAppliesToSelfOrSlot(
  cast: ObservedDefensiveCast,
  defensive: ResolvedDefensive,
  playerKey: string,
  expectedTargetPlayerKey: string | null,
): boolean {
  if (cast.sourcePlayerKey !== playerKey || defensive.category === 'utility' || defensive.targetingMode === 'unknown') return false;
  if (defensive.category === 'external_defensive' || defensive.targetingMode === 'ally') {
    return expectedTargetPlayerKey != null && cast.targetPlayerKey === expectedTargetPlayerKey;
  }
  if (defensive.targetingMode === 'raid') return true;
  if (expectedTargetPlayerKey != null && expectedTargetPlayerKey !== playerKey) {
    return defensive.targetingMode === 'both' && cast.targetPlayerKey === expectedTargetPlayerKey;
  }
  if (cast.targetPlayerKey === undefined) return true;
  if (cast.targetPlayerKey === null) return false;
  return cast.targetPlayerKey === playerKey;
}

function castProtectsInterval(
  cast: ObservedDefensiveCast,
  defensive: ResolvedDefensive,
  startMs: number,
  endMs: number,
): boolean {
  if (cast.timeMs > endMs) return false;
  if (defensive.effectiveDurationMs == null) return cast.timeMs >= startMs;
  return cast.timeMs + defensive.effectiveDurationMs >= startMs;
}

function futureHigherReservations(
  input: DefensiveExecutionEvaluationInput,
  defensive: ResolvedDefensive,
  afterMs: number,
  candidatePriority: number,
): EvaluationPlanSlot[] {
  return relevantAssignedSlots(input).filter(
    (slot) =>
      slot.defensiveSpellId === defensive.spellId &&
      (slot.plannedCastAtMs ?? slot.occurrenceTimeMs) > afterMs &&
      (slot.requirementLevel === 'required' || slot.priority > candidatePriority),
  );
}

function counterfactual(
  input: DefensiveExecutionEvaluationInput,
  defensive: ResolvedDefensive,
  atMs: number,
  priority: number,
): { feasible: boolean; futureSlotId?: string; futureAtMs?: number } {
  const future = futureHigherReservations(input, defensive, atMs, priority);
  const pastActual = input.casts.filter(
    (cast) => cast.sourcePlayerKey === input.playerKey && cast.spellId === defensive.spellId && cast.timeMs < atMs,
  );
  const usages = [
    ...pastActual.map((cast, index) => ({ timeMs: cast.timeMs, uncertaintyMs: 0, identity: `actual:${index}:${cast.timeMs}` })),
    { timeMs: atMs, uncertaintyMs: 0, identity: 'counterfactual' },
    ...future.map((slot) => ({
      timeMs: slot.plannedCastAtMs ?? slot.occurrenceTimeMs,
      uncertaintyMs: Math.max(0, Math.round((slot.windowEndMs - slot.windowStartMs) / 2)),
      identity: `slot:${slot.id}`,
    })),
  ];
  return {
    feasible: isConservativeScheduleFeasible(defensive, usages),
    ...(future[0] ? { futureSlotId: future[0].id } : {}),
    ...(future[0] ? { futureAtMs: future[0].plannedCastAtMs ?? future[0].occurrenceTimeMs } : {}),
  };
}

function coveringCasts(
  input: DefensiveExecutionEvaluationInput,
  startMs: number,
  endMs: number,
  expectedTargetPlayerKey: string | null,
): { cast: ObservedDefensiveCast; defensive: ResolvedDefensive }[] {
  const kitBySpell = new Map(input.kit.map((defensive) => [defensive.spellId, defensive]));
  return input.casts
    .filter((cast) => input.evaluationCutoffMs == null || cast.timeMs < input.evaluationCutoffMs)
    .map((cast) => ({ cast, defensive: kitBySpell.get(cast.spellId) }))
    .filter(
      (entry): entry is { cast: ObservedDefensiveCast; defensive: ResolvedDefensive } =>
        Boolean(
          entry.defensive?.eligible &&
            trusted(entry.defensive.confidence) &&
            castAppliesToSelfOrSlot(entry.cast, entry.defensive, input.playerKey, expectedTargetPlayerKey) &&
            castProtectsInterval(entry.cast, entry.defensive, startMs, endMs),
        ),
    )
    .sort((left, right) => left.cast.timeMs - right.cast.timeMs || left.cast.spellId - right.cast.spellId);
}

// §"cuando decimos que es un 0 tiene que ser una comprobación 100% real de
// que no ha usado ningún defensivo ante ningún daño" (feedback real,
// 2026-09-03): coveringCasts() ya filtra por categoría/confidence/target —
// si un cast real del jugador cae dentro de la ventana pero no encaja con
// ninguno de esos filtros (el bug de "Environment" era un caso concreto;
// puede haber otros: catálogo mal clasificado, confidence no fiable...),
// eso NO es evidencia de que no hizo nada — es evidencia de que no se pudo
// interpretar. Nunca se afirma un fallo confirmado sobre un hueco de
// interpretación; se degrada a uncertain_data, igual que ya hace
// evaluateDeath cuando el kit tiene una entrada no fiable.
function hasUnexplainedOwnCast(
  input: DefensiveExecutionEvaluationInput,
  startMs: number,
  endMs: number,
): boolean {
  return input.casts.some(
    (cast) =>
      cast.sourcePlayerKey === input.playerKey &&
      (input.evaluationCutoffMs == null || cast.timeMs < input.evaluationCutoffMs) &&
      cast.timeMs >= startMs &&
      cast.timeMs <= endMs,
  );
}

function uncertainEvent(atMs: number, details: Partial<DefensiveExecutionEvaluationEvent> = {}): DefensiveExecutionEvaluationEvent {
  return {
    state: 'uncertain_data',
    reason: 'UNRESOLVED_BUILD_OR_RULE',
    atMs,
    coverageOutcome: 'uncertain',
    adherenceOutcome: 'uncertain',
    managementOutcome: 'uncertain',
    ...details,
  };
}

function evaluateSlot(
  input: DefensiveExecutionEvaluationInput,
  slot: EvaluationPlanSlot,
  kitBySpell: ReadonlyMap<number, ResolvedDefensive>,
): DefensiveExecutionEvaluationEvent {
  const atMs = slot.plannedCastAtMs ?? slot.occurrenceTimeMs;
  const base = {
    atMs,
    slotId: slot.id,
    abilityId: slot.abilityId,
    occurrenceIndex: slot.occurrenceIndex,
    plannedSpellId: slot.defensiveSpellId ?? undefined,
    targetPlayerKey: slot.targetPlayerKey,
    requirementLevel: slot.requirementLevel,
  };
  const defensive = slot.defensiveSpellId == null ? undefined : kitBySpell.get(slot.defensiveSpellId);
  if (
    !trusted(input.dataConfidence) ||
    (!input.solverStrictScoringEligible && input.mode !== 'no_plan') ||
    !defensive?.eligible ||
    !trusted(slot.confidence) ||
    !trusted(defensive.confidence)
  ) {
    return uncertainEvent(atMs, base);
  }

  const covering = coveringCasts(input, slot.windowStartMs, slot.windowEndMs, slot.targetPlayerKey);
  const planned = covering.find((entry) => entry.cast.spellId === defensive.spellId);
  if (planned) {
    return {
      ...base,
      state: 'plan_covered',
      reason: 'PLANNED_CAST_IN_WINDOW',
      actualSpellId: planned.cast.spellId,
      actualCastAtMs: planned.cast.timeMs,
      coverageOutcome: 'covered',
      adherenceOutcome: 'followed',
      managementOutcome: 'success',
    };
  }

  const substitute = covering.find((entry) => entry.cast.spellId !== defensive.spellId);
  if (substitute) {
    const replay = counterfactual(input, substitute.defensive, substitute.cast.timeMs, slot.priority);
    return {
      ...base,
      state: 'covered_with_substitution',
      reason: replay.feasible ? 'SUBSTITUTE_VALID_NO_FUTURE_COST' : 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT',
      actualSpellId: substitute.cast.spellId,
      actualCastAtMs: substitute.cast.timeMs,
      coverageOutcome: 'covered',
      adherenceOutcome: 'substituted',
      managementOutcome: replay.feasible ? 'success' : 'failure',
      ...(replay.futureSlotId ? { relatedFutureSlotId: replay.futureSlotId } : {}),
      ...(replay.futureAtMs != null ? { relatedFutureAtMs: replay.futureAtMs } : {}),
    };
  }

  const sameSpellInWindow = input.casts.find(
    (cast) =>
      cast.sourcePlayerKey === input.playerKey &&
      cast.spellId === defensive.spellId &&
      (input.evaluationCutoffMs == null || cast.timeMs < input.evaluationCutoffMs) &&
      cast.timeMs >= slot.windowStartMs &&
      cast.timeMs <= slot.windowEndMs,
  );
  if (sameSpellInWindow && !castHasReliableTarget(sameSpellInWindow) && (defensive.category === 'external_defensive' || defensive.targetingMode === 'ally')) {
    return uncertainEvent(atMs, base);
  }
  if (sameSpellInWindow) {
    return {
      ...base,
      state: 'plan_broken',
      reason: 'TARGET_MISMATCH',
      actualSpellId: sameSpellInWindow.spellId,
      actualCastAtMs: sameSpellInWindow.timeMs,
      coverageOutcome: 'uncovered',
      adherenceOutcome: 'broken',
      managementOutcome: 'failure',
    };
  }

  const previousCasts = input.casts
    .filter((cast) => cast.sourcePlayerKey === input.playerKey && cast.spellId === defensive.spellId)
    .map((cast) => cast.timeMs);
  const state = effectiveDefensiveStateAt(defensive, previousCasts, atMs);
  if (state.status === 'unknown') return uncertainEvent(atMs, base);
  if (state.status === 'on_cooldown') {
    const lastCastAtMs = previousCasts.filter((castAtMs) => castAtMs <= atMs).sort((left, right) => left - right).at(-1);
    return {
      ...base,
      state: 'plan_broken',
      reason: 'EARLY_CAST_CAUSED_MISS',
      coverageOutcome: 'uncovered',
      adherenceOutcome: 'broken',
      managementOutcome: 'failure',
      actualSpellId: defensive.spellId,
      ...(lastCastAtMs != null ? { actualCastAtMs: lastCastAtMs } : {}),
      cooldownRemainingMs: state.cooldownRemainingMs,
    };
  }
  return {
    ...base,
    state: 'reminder_missed',
    reason: 'READY_NOT_CAST_IN_WINDOW',
    coverageOutcome: 'uncovered',
    adherenceOutcome: 'missed',
    managementOutcome: 'failure',
  };
}

function evaluateUnplannedWindow(
  input: DefensiveExecutionEvaluationInput,
  window: EvaluationPressureWindow,
): DefensiveExecutionEvaluationEvent {
  const base = {
    atMs: window.peakMs,
    windowId: window.id,
    abilityId: window.mechanicId ?? undefined,
    requirementLevel: window.requirementLevel ?? 'recommended',
    ...(window.peakValue != null ? { peakValue: window.peakValue } : {}),
  };
  if (!trusted(input.dataConfidence) || (!input.solverStrictScoringEligible && input.mode !== 'no_plan')) {
    return uncertainEvent(window.peakMs, base);
  }

  const actualCoverage = coveringCasts(input, window.startMs, window.endMs, input.playerKey)
    .find((entry) => entry.defensive.category === 'personal_defensive');
  if (actualCoverage) {
    const replay = counterfactual(input, actualCoverage.defensive, actualCoverage.cast.timeMs, window.priority);
    if (replay.feasible) {
      return {
        ...base,
        state: 'safe_extra_use',
        reason: 'SAFE_EXTRA_USE',
        actualSpellId: actualCoverage.cast.spellId,
        actualCastAtMs: actualCoverage.cast.timeMs,
        coverageOutcome: 'covered',
        adherenceOutcome: 'not_applicable',
        managementOutcome: 'success',
      };
    }
    return {
      ...base,
      state: 'plan_broken',
      reason: 'EARLY_CAST_CAUSED_MISS',
      actualSpellId: actualCoverage.cast.spellId,
      actualCastAtMs: actualCoverage.cast.timeMs,
      coverageOutcome: 'covered',
      adherenceOutcome: 'broken',
      managementOutcome: 'failure',
      ...(replay.futureSlotId ? { relatedFutureSlotId: replay.futureSlotId } : {}),
      ...(replay.futureAtMs != null ? { relatedFutureAtMs: replay.futureAtMs } : {}),
    };
  }

  const trustedPersonal = input.kit.filter(
    (defensive) =>
      defensive.eligible &&
      trusted(defensive.confidence) &&
      defensive.category === 'personal_defensive' &&
      defensive.targetingMode === 'self' &&
      defensive.survivalType !== 'emergency',
  );
  const locallyReady = trustedPersonal.filter((defensive) => {
    const casts = input.casts
      .filter((cast) => cast.sourcePlayerKey === input.playerKey && cast.spellId === defensive.spellId)
      .map((cast) => cast.timeMs);
    return effectiveDefensiveStateAt(defensive, casts, window.peakMs).status === 'available_unused';
  });
  const viable = locallyReady.filter((defensive) => counterfactual(input, defensive, window.peakMs, window.priority).feasible);
  if (viable.length) {
    // "0 verificado": si hubo un cast propio real dentro de la ventana que
    // coveringCasts() no reconoció como cobertura (categoría/confidence/
    // target no encajaron), no se afirma "no hizo nada" — se degrada.
    if (hasUnexplainedOwnCast(input, window.startMs, window.endMs)) return uncertainEvent(window.peakMs, base);
    return {
      ...base,
      state: 'missed_extra_opportunity',
      reason: 'COUNTERFACTUAL_FEASIBLE',
      candidateSpellIds: viable.map((defensive) => defensive.spellId),
      coverageOutcome: 'uncovered',
      adherenceOutcome: 'not_applicable',
      managementOutcome: 'failure',
    };
  }
  if (locallyReady.length) {
    const replay = counterfactual(input, locallyReady[0], window.peakMs, window.priority);
    return {
      ...base,
      state: 'correct_hold',
      reason: 'RESERVED_HIGHER_PRIORITY',
      candidateSpellIds: locallyReady.map((defensive) => defensive.spellId),
      coverageOutcome: 'uncovered',
      adherenceOutcome: 'held',
      managementOutcome: 'neutral',
      ...(replay.futureSlotId ? { relatedFutureSlotId: replay.futureSlotId } : {}),
      ...(replay.futureAtMs != null ? { relatedFutureAtMs: replay.futureAtMs } : {}),
    };
  }
  if (input.kit.some((defensive) => defensive.eligible && !trusted(defensive.confidence))) return uncertainEvent(window.peakMs, base);
  return {
    ...base,
    state: 'no_feasible_alternative',
    reason: 'NO_COUNTERFACTUAL_SCHEDULE',
    coverageOutcome: 'uncovered',
    adherenceOutcome: 'not_applicable',
    managementOutcome: 'neutral',
  };
}

function evaluateDeath(input: DefensiveExecutionEvaluationInput, deathTimeMs: number): DefensiveExecutionEvaluationEvent {
  const base = { atMs: deathTimeMs };
  if (!trusted(input.dataConfidence) || (!input.solverStrictScoringEligible && input.mode !== 'no_plan')) {
    return uncertainEvent(deathTimeMs, base);
  }
  const readyAt = (defensive: ResolvedDefensive, atMs: number): boolean => {
    const casts = input.casts
      .filter((cast) => cast.sourcePlayerKey === input.playerKey && cast.spellId === defensive.spellId)
      .map((cast) => cast.timeMs);
    return (
      effectiveDefensiveStateAt(defensive, casts, atMs).status === 'available_unused' &&
      counterfactual(input, defensive, atMs, 5).feasible
    );
  };
  const candidates = input.kit.filter((defensive) => {
    if (
      !defensive.eligible ||
      !trusted(defensive.confidence) ||
      defensive.category !== 'personal_defensive' ||
      defensive.targetingMode !== 'self'
    ) return false;
    return readyAt(defensive, deathTimeMs);
  });
  if (candidates.length) {
    const lethalWindowStartMs = input.lethalWindowStartMs;
    const scoredLethalWindowStartMs =
      lethalWindowStartMs != null && lethalWindowStartMs < deathTimeMs
        ? lethalWindowStartMs
        : null;
    const windowCandidates =
      scoredLethalWindowStartMs != null
        ? candidates.filter((defensive) => readyAt(defensive, scoredLethalWindowStartMs))
        : [];
    if (!windowCandidates.length) {
      return {
        ...base,
        state: 'death_with_ready_cd',
        reason: 'DEATH_READY_AT_END_ONLY',
        candidateSpellIds: candidates.map((defensive) => defensive.spellId),
        coverageOutcome: 'uncovered',
        adherenceOutcome: 'not_applicable',
        managementOutcome: 'neutral',
        ...(lethalWindowStartMs != null ? { lethalWindowStartMs } : {}),
      };
    }
    // "0 verificado": un cast propio real dentro de la secuencia letal que
    // no explique por qué ninguno de los candidatos estaba "on_cooldown" no
    // se ignora — degrada a incertidumbre en vez de afirmar la muerte como
    // fallo confirmado (mismo criterio que evaluateUnplannedWindow).
    if (hasUnexplainedOwnCast(input, scoredLethalWindowStartMs!, deathTimeMs)) return uncertainEvent(deathTimeMs, base);
    return {
      ...base,
      state: 'death_with_viable_cd',
      reason: 'DEATH_COUNTERFACTUAL_FEASIBLE',
      candidateSpellIds: windowCandidates.map((defensive) => defensive.spellId),
      coverageOutcome: 'uncovered',
      adherenceOutcome: 'not_applicable',
      managementOutcome: 'failure',
      lethalWindowStartMs: scoredLethalWindowStartMs!,
    };
  }
  if (input.kit.some((defensive) => defensive.eligible && !trusted(defensive.confidence))) return uncertainEvent(deathTimeMs, base);
  return {
    ...base,
    state: 'no_feasible_alternative',
    reason: 'NO_COUNTERFACTUAL_SCHEDULE',
    coverageOutcome: 'uncovered',
    adherenceOutcome: 'not_applicable',
    managementOutcome: 'neutral',
  };
}

function withCausalPenaltyGroups(
  sourceEvents: readonly DefensiveExecutionEvaluationEvent[],
): DefensiveExecutionEvaluationEvent[] {
  const events = sourceEvents.map((event) => ({ ...event }));
  for (const substitution of events.filter(
    (event) =>
      event.reason === 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT' &&
      event.relatedFutureSlotId != null,
  )) {
    const future = events.find((event) => event.slotId === substitution.relatedFutureSlotId);
    if (!future) continue;
    const causalGroupId = `defensive:${substitution.slotId ?? substitution.atMs}:${substitution.atMs}`;
    substitution.causalGroupId = causalGroupId;
    substitution.primaryPenalty = true;
    future.causalGroupId = causalGroupId;
    future.primaryPenalty = false;
  }
  for (const death of events.filter(
    (event) => event.state === 'death_with_viable_cd' || event.state === 'death_with_ready_cd',
  )) {
    const deathCandidates = new Set(death.candidateSpellIds ?? []);
    const anchor = [...events]
      .filter((event) => event !== death && event.atMs <= death.atMs && death.atMs - event.atMs <= 5_000)
      .filter((event) =>
        ['missed_extra_opportunity', 'reminder_missed', 'plan_broken'].includes(event.state),
      )
      .filter((event) => {
        const spellIds = [event.plannedSpellId, event.actualSpellId, ...(event.candidateSpellIds ?? [])]
          .filter((spellId): spellId is number => spellId != null);
        return spellIds.some((spellId) => deathCandidates.has(spellId));
      })
      .sort((left, right) => right.atMs - left.atMs)[0];
    if (!anchor) continue;
    const causalGroupId = `defensive:${anchor.slotId ?? anchor.windowId ?? anchor.atMs}:${anchor.atMs}`;
    anchor.causalGroupId = causalGroupId;
    anchor.primaryPenalty = true;
    death.causalGroupId = causalGroupId;
    death.primaryPenalty = false;
  }
  return events;
}

export function evaluateDefensiveExecution(input: DefensiveExecutionEvaluationInput): DefensiveExecutionEvaluationResult {
  const kitBySpell = new Map(input.kit.map((defensive) => [defensive.spellId, defensive]));
  const assignedSlots = relevantAssignedSlots(input);
  const slotEvents = assignedSlots.map((slot) => evaluateSlot(input, slot, kitBySpell));
  const evaluableWindows = input.windows.filter(
    (window) => input.evaluationCutoffMs == null || window.startMs < input.evaluationCutoffMs,
  );
  const unplannedWindows = evaluableWindows.filter(
    (window) => !assignedSlots.some((slot) => slot.windowStartMs <= window.endMs && slot.windowEndMs >= window.startMs),
  );
  const windowEvents = unplannedWindows.map((window) => evaluateUnplannedWindow(input, window));
  const deathEvents =
    input.deathTimeMs == null || (input.evaluationCutoffMs != null && input.deathTimeMs >= input.evaluationCutoffMs)
      ? []
      : [evaluateDeath(input, input.deathTimeMs)];
  const events = withCausalPenaltyGroups([...slotEvents, ...windowEvents, ...deathEvents]).sort(
    (left, right) => left.atMs - right.atMs || left.state.localeCompare(right.state) || (left.slotId ?? '').localeCompare(right.slotId ?? ''),
  );

  let criticalWindowCount = 0;
  let criticalCoveredCount = 0;
  for (const window of evaluableWindows.filter((candidate) => candidate.critical)) {
    const overlappingSlots = assignedSlots.filter(
      (slot) => slot.windowStartMs <= window.endMs && slot.windowEndMs >= window.startMs,
    );
    const decisions = overlappingSlots.length
      ? overlappingSlots
          .map((slot) => events.find((event) => event.slotId === slot.id))
          .filter((event): event is DefensiveExecutionEvaluationEvent => Boolean(event))
      : events.filter((event) => event.windowId === window.id);
    if (!decisions.length || decisions.some((decision) => decision.state === 'uncertain_data')) continue;
    if (overlappingSlots.length > 1 && !window.coverageRequirement) continue;
    const evaluableDecisions = decisions.filter(
      (decision) => decision.state !== 'no_feasible_alternative' && decision.state !== 'correct_hold',
    );
    if (!evaluableDecisions.length) continue;
    criticalWindowCount++;
    const coveredCount = evaluableDecisions.filter((decision) => decision.coverageOutcome === 'covered').length;
    const covered =
      !window.coverageRequirement || window.coverageRequirement.kind === 'ANY_OF'
        ? coveredCount >= 1
        : window.coverageRequirement.kind === 'MIN_N'
          ? coveredCount >= window.coverageRequirement.count
          : coveredCount === evaluableDecisions.length;
    if (covered) criticalCoveredCount++;
  }
  const requiredSlotIds = new Set(
    assignedSlots
      .filter((slot) => slot.requirementLevel === 'required')
      .filter((slot) => slotEvents.find((event) => event.slotId === slot.id)?.state !== 'uncertain_data')
      .map((slot) => slot.id),
  );
  const requiredExactAdherenceCount = events.filter(
    (event) => event.slotId && requiredSlotIds.has(event.slotId) && event.state === 'plan_covered',
  ).length;
  const requiredCoverageSuccessCount = events.filter(
    (event) =>
      event.slotId &&
      requiredSlotIds.has(event.slotId) &&
      event.coverageOutcome === 'covered',
  ).length;
  const brokenSlotIds = new Set(
    events
      .filter(
        (event) =>
          event.state === 'plan_broken' ||
          event.reason === 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT',
      )
      .flatMap((event) =>
        event.reason === 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT'
          ? [event.relatedFutureSlotId]
          : [event.slotId, event.relatedFutureSlotId],
      )
      .filter((slotId): slotId is string => Boolean(slotId)),
  );
  const management = computeDefensiveManagementScore(events);

  return {
    playerName: input.playerName,
    planVersionId: input.planVersionId,
    mode: input.mode,
    gameBuild: input.gameBuild,
    buildFingerprint: input.buildFingerprint,
    resolverVersion: input.resolverVersion,
    solverVersion: input.solverVersion,
    evaluatorVersion: DEFENSIVE_EXECUTION_EVALUATOR_VERSION,
    planRequiredCount: requiredSlotIds.size,
    planExecutedCount: requiredExactAdherenceCount,
    requiredExactAdherenceCount,
    requiredCoverageSuccessCount,
    criticalWindowCount,
    criticalCoveredCount,
    correctHoldCount: events.filter((event) => event.state === 'correct_hold').length,
    brokenReservationCount: brokenSlotIds.size,
    reminderMissedCount: events.filter((event) => event.state === 'reminder_missed').length,
    viableExtraCount: events.filter((event) => event.state === 'missed_extra_opportunity' || event.state === 'safe_extra_use').length,
    extraUsedCount: events.filter((event) => event.state === 'safe_extra_use').length,
    deathViableCdCount: events.filter((event) => event.state === 'death_with_viable_cd').length,
    // Fórmula central de K aplicada sobre los estados semánticos de este replay.
    managementScore: management.score,
    dataConfidence:
      !input.solverStrictScoringEligible && input.mode !== 'no_plan' ? 'uncertain' : input.dataConfidence,
    events,
  };
}
