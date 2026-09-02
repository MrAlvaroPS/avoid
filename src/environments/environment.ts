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
    // R5/R7 permanecen apagados hasta backfill + contraste oficial.
    defensiveInfographicV2: false,
    defensiveReliabilityV2: false,
  },
  // Causalidad v3 · Bloque A: schema/contratos disponibles en shadow, sin
  // cambiar todavía ninguna superficie ni scoring visible.
  combatEvaluationFeatureFlags: {
    combatEvaluationContextV2: true,
    mechanicPolicyV2: true,
    mechanicResponsibilityV2: true,
    consumableEvaluatorV2: true,
    playerInfographicV3: true,
    reliabilityExecutionV3: true,
  },
};
