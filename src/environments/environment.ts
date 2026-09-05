// Claves PÚBLICAS de Supabase (anon key). Nunca pongas aquí la service_role key:
// esa solo vive en las Edge Functions, del lado servidor.
export const environment = {
  production: false,
  supabaseUrl: 'https://qiniulkhivpvbjoquvon.supabase.co',
  supabaseAnonKey: 'sb_publishable_c4KwkdVTpWidv4lJ5aZcMg_l0S4ara7',
  defensiveFeatureFlags: {
    defensiveEffectiveResolverV2: false,
    defensiveDeployedPlans: false,
    defensiveExecutionEvaluatorV2: false,
    // R5 usa gate atómico jugador×noche; R7 permanece apagado hasta backfill global.
    defensiveInfographicV2: true,
    defensiveReliabilityV2: false,
  },
  // Causalidad/infografía v3 activas en este entorno. Cada proyector mantiene
  // sus gates de completitud: un dataset parcial nunca debe mezclarse con v3.
  combatEvaluationFeatureFlags: {
    combatEvaluationContextV2: true,
    mechanicPolicyV2: true,
    mechanicResponsibilityV2: true,
    consumableEvaluatorV2: true,
    playerInfographicV3: true,
    reliabilityExecutionV3: true,
  },
};
