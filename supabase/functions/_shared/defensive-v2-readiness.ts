export type DefensiveV2ReadinessState = 'ready' | 'partial' | 'missing';

export function defensiveV2BackfillState(total: number, completed: number): DefensiveV2ReadinessState {
  return total > 0 && completed === total ? 'ready' : 'partial';
}

export function defensiveV2Capabilities(input: {
  resolverEndpoint: boolean;
  resolverSchema: DefensiveV2ReadinessState;
  planSchema: DefensiveV2ReadinessState;
  evaluatorSchema: DefensiveV2ReadinessState;
  reliabilitySchema: DefensiveV2ReadinessState;
  overrideAudit: DefensiveV2ReadinessState;
  backfill: DefensiveV2ReadinessState;
}): {
  playerMode: boolean;
  playerOverride: boolean;
  planManagement: boolean;
  evaluator: boolean;
  infographic: boolean;
  reliability: boolean;
} {
  const playerMode = input.resolverEndpoint && input.resolverSchema === 'ready';
  const planManagement = playerMode && input.planSchema === 'ready';
  const evaluator = planManagement && input.evaluatorSchema === 'ready';
  // La infografía aplica además un gate atómico jugador×noche: si falta una
  // evaluación o la generación no es homogénea, usa el resumen legacy completo.
  // Por eso puede activarse con el evaluator listo sin esperar el histórico
  // global. Fiabilidad sí agrega ventanas históricas y exige el backfill total.
  const infographic = evaluator;
  const reliability = evaluator && input.reliabilitySchema === 'ready' && input.backfill === 'ready';
  return {
    playerMode,
    playerOverride: playerMode && input.overrideAudit === 'ready',
    planManagement,
    evaluator,
    infographic,
    reliability,
  };
}
