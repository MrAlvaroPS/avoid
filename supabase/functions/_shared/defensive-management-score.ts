export const DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS = Object.freeze({
  required: 4,
  recommended: 1,
  brokenReservation: 5,
  deathWithViableCooldown: 5,
} as const);

export interface DefensiveManagementScoringEvent {
  state:
    | 'plan_covered'
    | 'covered_with_substitution'
    | 'correct_hold'
    | 'safe_extra_use'
    | 'missed_extra_opportunity'
    | 'plan_broken'
    | 'reminder_missed'
    | 'death_with_viable_cd'
    | 'no_feasible_alternative'
    | 'death_with_ready_cd'
    | 'uncertain_data';
  requirementLevel?: 'required' | 'recommended' | 'optional';
  reason?: string;
  /** `false` conserva el hecho para explicaciÃ³n, pero evita penalizar dos
   * veces una misma decisiÃ³n causal (por ejemplo ventana omitida + muerte). */
  primaryPenalty?: boolean;
}

export interface DefensiveManagementScoreResult {
  score: number | null;
  weightedSuccess: number;
  weightedOpportunity: number;
  decisionCount: number;
  requiredCount: number;
  requiredSuccessCount: number;
}

/**
 * Fórmula central del bloque K. Los estados neutros o no fiables nunca
 * entran en el denominador; una reserva rota usa su peso específico (5),
 * no se suma además como fallo required/recommended del mismo evento.
 */
export function computeDefensiveManagementScore(
  events: readonly DefensiveManagementScoringEvent[],
): DefensiveManagementScoreResult {
  let weightedSuccess = 0;
  let weightedOpportunity = 0;
  let decisionCount = 0;
  let requiredCount = 0;
  let requiredSuccessCount = 0;

  for (const event of events) {
    const isRequired = event.requirementLevel === 'required';
    if (isRequired && event.state !== 'uncertain_data') requiredCount++;

    if (event.primaryPenalty === false) continue;

    if (
      event.state === 'covered_with_substitution' &&
      event.reason === 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT'
    ) {
      // La cobertura actual sigue siendo real, pero la gestiÃ³n fue
      // incorrecta: el sustituto hizo inviable una reserva posterior.
      weightedOpportunity += DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.brokenReservation;
      decisionCount++;
      continue;
    }

    if (event.state === 'plan_broken') {
      weightedOpportunity += DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.brokenReservation;
      decisionCount++;
      continue;
    }
    if (event.state === 'death_with_viable_cd') {
      weightedOpportunity += DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.deathWithViableCooldown;
      decisionCount++;
      continue;
    }
    if (event.state === 'safe_extra_use' || event.state === 'missed_extra_opportunity') {
      weightedOpportunity += DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.recommended;
      if (event.state === 'safe_extra_use') weightedSuccess += DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.recommended;
      decisionCount++;
      continue;
    }
    if (
      event.state !== 'plan_covered' &&
      event.state !== 'covered_with_substitution' &&
      event.state !== 'reminder_missed'
    ) {
      continue;
    }

    const weight =
      event.requirementLevel === 'required'
        ? DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.required
        : event.requirementLevel === 'recommended'
          ? DEFENSIVE_MANAGEMENT_SCORE_WEIGHTS.recommended
          : 0;
    if (!weight) continue;
    const succeeded =
      event.state === 'plan_covered' ||
      (event.state === 'covered_with_substitution' &&
        event.reason !== 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT');
    weightedOpportunity += weight;
    if (succeeded) weightedSuccess += weight;
    if (isRequired && succeeded) requiredSuccessCount++;
    decisionCount++;
  }

  return {
    score:
      weightedOpportunity > 0
        ? Math.round((weightedSuccess / weightedOpportunity) * 10_000) / 100
        : null,
    weightedSuccess,
    weightedOpportunity,
    decisionCount,
    requiredCount,
    requiredSuccessCount,
  };
}
