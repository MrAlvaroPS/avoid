import {
  evaluateDefensiveExecution,
  type DefensiveExecutionEvaluationInput,
  type EvaluationPlanSlot,
  type EvaluationPressureWindow,
} from '../../../supabase/functions/_shared/defensive-execution-evaluator';
import type { ResolvedDefensive } from '../../../supabase/functions/_shared/effective-defensives';

function defensive(spellId: number, cooldownMs = 20_000, overrides: Partial<ResolvedDefensive> = {}): ResolvedDefensive {
  return {
    spellId,
    name: `Defensive ${spellId}`,
    className: 'Priest',
    specName: 'Shadow',
    category: 'personal_defensive',
    survivalType: 'mitigation',
    targetingMode: 'self',
    activationMode: 'active',
    effectiveCooldownMs: cooldownMs,
    effectiveDurationMs: 5_000,
    charges: 1,
    rechargeMs: cooldownMs,
    eligible: true,
    buildFingerprint: 'build-fp',
    gameBuild: '12.0.0.1',
    resolverVersion: 'resolver@test',
    confidence: 'verified',
    provenance: [],
    conditionalModifiers: [],
    ...overrides,
  };
}

function slot(overrides: Partial<EvaluationPlanSlot> = {}): EvaluationPlanSlot {
  return {
    id: 'slot-1',
    abilityId: 500,
    occurrenceIndex: 1,
    occurrenceTimeMs: 100_000,
    windowStartMs: 98_000,
    windowEndMs: 102_000,
    priority: 5,
    requirementLevel: 'required',
    coverageStatus: 'covered',
    assignedPlayerKey: 'player:a',
    targetPlayerKey: 'player:a',
    defensiveSpellId: 100,
    plannedCastAtMs: 98_000,
    confidence: 'verified',
    ...overrides,
  };
}

function window(overrides: Partial<EvaluationPressureWindow> = {}): EvaluationPressureWindow {
  return { id: 'window-1', startMs: 83_000, endMs: 87_000, peakMs: 85_000, priority: 2, critical: true, ...overrides };
}

function input(overrides: Partial<DefensiveExecutionEvaluationInput> = {}): DefensiveExecutionEvaluationInput {
  return {
    playerKey: 'player:a',
    playerName: 'Alda',
    mode: 'full',
    planVersionId: 'plan-1',
    gameBuild: '12.0.0.1',
    buildFingerprint: 'build-fp',
    resolverVersion: 'resolver@test',
    solverVersion: 'solver@test',
    solverStrictScoringEligible: true,
    dataConfidence: 'verified',
    kit: [defensive(100)],
    slots: [slot()],
    casts: [],
    windows: [],
    deathTimeMs: null,
    ...overrides,
  };
}

describe('defensive execution evaluator', () => {
  it('classifies the planned cast inside its valid window as plan_covered', () => {
    const result = evaluateDefensiveExecution(input({ casts: [{ sourcePlayerKey: 'player:a', spellId: 100, timeMs: 98_500 }] }));
    expect(result.events[0].state).toBe('plan_covered');
    expect(result.planExecutedCount).toBe(1);
    expect(result.managementScore).toBe(100);
  });

  it('separates functional coverage from adherence for a safe substitute', () => {
    const result = evaluateDefensiveExecution(
      input({
        kit: [defensive(100), defensive(200, 30_000)],
        casts: [{ sourcePlayerKey: 'player:a', spellId: 200, timeMs: 99_000 }],
      }),
    );
    expect(result.events[0]).toEqual(expect.objectContaining({ state: 'covered_with_substitution', coverageOutcome: 'covered', adherenceOutcome: 'substituted' }));
    expect(result.events[0].managementOutcome).toBe('success');
    expect(result.requiredExactAdherenceCount).toBe(0);
    expect(result.requiredCoverageSuccessCount).toBe(1);
  });

  it('penalizes management once when a substitute breaks a future reservation', () => {
    const result = evaluateDefensiveExecution(
      input({
        kit: [defensive(100), defensive(200, 30_000)],
        slots: [
          slot(),
          slot({
            id: 'slot-2',
            occurrenceIndex: 2,
            occurrenceTimeMs: 110_000,
            windowStartMs: 109_000,
            windowEndMs: 111_000,
            plannedCastAtMs: 110_000,
            defensiveSpellId: 200,
          }),
        ],
        casts: [{ sourcePlayerKey: 'player:a', spellId: 200, timeMs: 99_000 }],
      }),
    );
    const substitution = result.events.find((event) => event.slotId === 'slot-1');
    const future = result.events.find((event) => event.slotId === 'slot-2');
    expect(substitution).toEqual(expect.objectContaining({
      coverageOutcome: 'covered',
      managementOutcome: 'failure',
      reason: 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT',
      primaryPenalty: true,
    }));
    expect(future?.primaryPenalty).toBe(false);
    expect(result.requiredCoverageSuccessCount).toBe(1);
    expect(result.brokenReservationCount).toBe(1);
    expect(result.managementScore).toBe(0);
  });

  it('classifies a locally ready cooldown reserved ten seconds later as correct_hold', () => {
    const result = evaluateDefensiveExecution(input({ slots: [slot({ occurrenceTimeMs: 105_000, windowStartMs: 104_000, windowEndMs: 106_000, plannedCastAtMs: 105_000 })], windows: [window({ peakMs: 95_000, startMs: 94_000, endMs: 96_000 })] }));
    expect(result.events.find((event) => event.windowId === 'window-1')).toEqual(expect.objectContaining({ state: 'correct_hold', reason: 'RESERVED_HIGHER_PRIORITY' }));
  });

  it('marks an early cast that leaves the assigned cooldown pending as plan_broken', () => {
    const result = evaluateDefensiveExecution(input({ casts: [{ sourcePlayerKey: 'player:a', spellId: 100, timeMs: 90_000 }] }));
    expect(result.events[0]).toEqual(expect.objectContaining({ state: 'plan_broken', reason: 'EARLY_CAST_CAUSED_MISS', cooldownRemainingMs: 12_000 }));
  });

  it('marks a ready assigned spell not cast in its slot as reminder_missed', () => {
    expect(evaluateDefensiveExecution(input()).events[0]).toEqual(expect.objectContaining({ state: 'reminder_missed', reason: 'READY_NOT_CAST_IN_WINDOW' }));
  });

  it('only reports an extra opportunity when a safe counterfactual schedule exists', () => {
    const result = evaluateDefensiveExecution(input({ slots: [slot({ occurrenceTimeMs: 130_000, windowStartMs: 128_000, windowEndMs: 132_000, plannedCastAtMs: 130_000 })], windows: [window()] }));
    expect(result.events.find((event) => event.windowId === 'window-1')).toEqual(expect.objectContaining({ state: 'missed_extra_opportunity', reason: 'COUNTERFACTUAL_FEASIBLE' }));
  });

  it('returns no_feasible_alternative when no schedule can cover the window', () => {
    const result = evaluateDefensiveExecution(input({ casts: [{ sourcePlayerKey: 'player:a', spellId: 100, timeMs: 77_000 }], slots: [], windows: [window({ peakMs: 85_000 })], mode: 'no_plan', planVersionId: null }));
    expect(result.events[0]).toEqual(expect.objectContaining({ state: 'no_feasible_alternative', reason: 'NO_COUNTERFACTUAL_SCHEDULE' }));
  });

  it('does not count an external cast on another target as self coverage', () => {
    const external = defensive(300, 120_000, { category: 'external_defensive', targetingMode: 'ally' });
    const result = evaluateDefensiveExecution(
      input({
        kit: [external],
        slots: [slot({ defensiveSpellId: 300, targetPlayerKey: 'player:a' })],
        casts: [{ sourcePlayerKey: 'player:a', spellId: 300, timeMs: 99_000, targetPlayerKey: 'player:b' }],
      }),
    );
    expect(result.events[0]).toEqual(expect.objectContaining({ state: 'plan_broken', reason: 'TARGET_MISMATCH', coverageOutcome: 'uncovered' }));
  });

  it('evaluates a semi defensive only when the published plan opted into it', () => {
    const semi = defensive(17, 15_000, { category: 'semi_defensive', targetingMode: 'both' });
    const planned = evaluateDefensiveExecution(
      input({
        kit: [semi],
        slots: [slot({ defensiveSpellId: 17 })],
        casts: [{ sourcePlayerKey: 'player:a', spellId: 17, timeMs: 99_000, targetPlayerKey: 'player:a' }],
      }),
    );
    const noPlan = evaluateDefensiveExecution(
      input({
        mode: 'no_plan',
        planVersionId: null,
        kit: [semi],
        slots: [],
        windows: [window()],
        casts: [{ sourcePlayerKey: 'player:a', spellId: 17, timeMs: 84_000, targetPlayerKey: 'player:a' }],
      }),
    );

    expect(planned.events[0].state).toBe('plan_covered');
    expect(noPlan.events[0].state).toBe('no_feasible_alternative');
  });

  it('never emits a punitive state when data confidence is uncertain', () => {
    const result = evaluateDefensiveExecution(input({ dataConfidence: 'uncertain' }));
    expect(result.events.map((event) => event.state)).toEqual(['uncertain_data']);
    expect(result.events.some((event) => ['plan_broken', 'reminder_missed', 'death_with_viable_cd'].includes(event.state))).toBeFalsy();
  });

  it('does not punish a plan produced by a non-strict fallback solver', () => {
    const result = evaluateDefensiveExecution(input({ solverStrictScoringEligible: false }));
    expect(result.events.map((event) => event.state)).toEqual(['uncertain_data']);
    expect(result.dataConfidence).toBe('uncertain');
    expect(result.planRequiredCount).toBe(0);
  });

  it('does not evaluate slots, pressure or deaths after the wipe-call cutoff', () => {
    const result = evaluateDefensiveExecution(
      input({ windows: [window({ startMs: 99_000, endMs: 101_000, peakMs: 100_000 })], deathTimeMs: 101_000, evaluationCutoffMs: 95_000 }),
    );
    expect(result.events).toEqual([]);
    expect(result.planRequiredCount).toBe(0);
    expect(result.criticalWindowCount).toBe(0);
  });

  it('treats a cooldown ready only at death as coaching, not demonstrated prevention', () => {
    const result = evaluateDefensiveExecution(
      input({ mode: 'no_plan', planVersionId: null, slots: [], deathTimeMs: 100_000 }),
    );
    expect(result.events[0]).toEqual(expect.objectContaining({
      state: 'death_with_ready_cd',
      reason: 'DEATH_READY_AT_END_ONLY',
      managementOutcome: 'neutral',
    }));
    expect(result.managementScore).toBeNull();
  });

  it('requires readiness during the observed lethal window for a scored death response', () => {
    const result = evaluateDefensiveExecution(
      input({
        mode: 'no_plan',
        planVersionId: null,
        slots: [],
        deathTimeMs: 100_000,
        lethalWindowStartMs: 96_000,
      }),
    );
    expect(result.events[0]).toEqual(expect.objectContaining({
      state: 'death_with_viable_cd',
      lethalWindowStartMs: 96_000,
      managementOutcome: 'failure',
    }));
    expect(result.managementScore).toBe(0);
  });

  it('keeps death evidence but applies one primary penalty for the same missed window', () => {
    const result = evaluateDefensiveExecution(
      input({
        mode: 'no_plan',
        planVersionId: null,
        slots: [],
        windows: [window({ startMs: 96_000, endMs: 99_000, peakMs: 98_000 })],
        deathTimeMs: 100_000,
        lethalWindowStartMs: 96_000,
      }),
    );
    expect(result.events).toHaveLength(2);
    expect(new Set(result.events.map((event) => event.causalGroupId)).size).toBe(1);
    expect(result.events.filter((event) => event.primaryPenalty !== false)).toHaveLength(1);
    expect(result.managementScore).toBe(0);
  });

  it('does not guess cardinality when a critical window overlaps multiple slots', () => {
    const result = evaluateDefensiveExecution(
      input({
        kit: [defensive(100), defensive(200)],
        slots: [slot(), slot({ id: 'slot-2', defensiveSpellId: 200 })],
        windows: [window({ startMs: 98_000, endMs: 102_000, peakMs: 100_000 })],
        casts: [{ sourcePlayerKey: 'player:a', spellId: 100, timeMs: 99_000 }],
      }),
    );
    expect(result.criticalWindowCount).toBe(0);
    expect(result.criticalCoveredCount).toBe(0);
  });
});
