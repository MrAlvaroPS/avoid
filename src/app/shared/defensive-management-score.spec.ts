import {
  computeDefensiveManagementScore,
  DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS,
} from '../../../supabase/functions/_shared/defensive-management-score';

describe('defensive management score v2', () => {
  it('alcanza 100 con todas las decisiones puntuables correctas', () => {
    const result = computeDefensiveManagementScore([
      { state: 'plan_covered', requirementLevel: 'required' },
      { state: 'covered_with_substitution', requirementLevel: 'recommended' },
      { state: 'safe_extra_use' },
    ]);
    expect(result.score).toBe(100);
    expect(result.requiredSuccessCount).toBe(1);
  });

  it('aplica los pesos centrales sin duplicar una reserva rota como fallo required', () => {
    const result = computeDefensiveManagementScore([
      { state: 'plan_covered', requirementLevel: 'required' },
      { state: 'plan_broken', requirementLevel: 'required' },
      { state: 'death_with_viable_cd' },
    ]);
    expect(result.weightedSuccess).toBe(DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.required);
    expect(result.weightedOpportunity).toBe(
      DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.required +
        DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.brokenReservation +
        DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.deathWithViableCooldown,
    );
    expect(result.score).toBeCloseTo((4 / 14) * 100, 2);
  });

  it('deja optional, correct_hold, no_feasible y uncertain fuera del denominador', () => {
    const result = computeDefensiveManagementScore([
      { state: 'reminder_missed', requirementLevel: 'optional' },
      { state: 'correct_hold', requirementLevel: 'recommended' },
      { state: 'no_feasible_alternative', requirementLevel: 'required' },
      { state: 'uncertain_data', requirementLevel: 'required' },
    ]);
    expect(result.score).toBeNull();
    expect(result.decisionCount).toBe(0);
    expect(result.requiredCount).toBe(1);
  });

  it('puntúa los fallos required y recommended con pesos 4 y 1', () => {
    const result = computeDefensiveManagementScore([
      { state: 'reminder_missed', requirementLevel: 'required' },
      { state: 'reminder_missed', requirementLevel: 'recommended' },
    ]);
    expect(result.score).toBe(0);
    expect(result.weightedOpportunity).toBe(5);
    expect(result.requiredCount).toBe(1);
    expect(result.requiredSuccessCount).toBe(0);
  });

  it('conserva cobertura pero penaliza una sustitucion con coste futuro', () => {
    const result = computeDefensiveManagementScore([
      {
        state: 'covered_with_substitution',
        reason: 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT',
        requirementLevel: 'required',
      },
    ]);
    expect(result.requiredSuccessCount).toBe(0);
    expect(result.weightedSuccess).toBe(0);
    expect(result.weightedOpportunity).toBe(
      DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.brokenReservation,
    );
    expect(result.score).toBe(0);
  });

  it('no penaliza dos veces evidencia secundaria del mismo hecho causal', () => {
    const result = computeDefensiveManagementScore([
      { state: 'missed_extra_opportunity', primaryPenalty: true },
      { state: 'death_with_viable_cd', primaryPenalty: false },
    ]);
    expect(result.decisionCount).toBe(1);
    expect(result.weightedOpportunity).toBe(
      DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.recommended,
    );
  });
});
