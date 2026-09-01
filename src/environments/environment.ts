// Claves PÚBLICAS de Supabase (anon key). Nunca pongas aquí la service_role key:
// esa solo vive en las Edge Functions, del lado servidor.
export const environment = {
  production: false,
  supabaseUrl: 'https://qiniulkhivpvbjoquvon.supabase.co',
  supabaseAnonKey: 'sb_publishable_c4KwkdVTpWidv4lJ5aZcMg_l0S4ara7',
  defensiveFeatureFlags: {
    defensiveEffectiveResolverV2: true,
    defensiveDeployedPlans: true,
    defensiveExecutionEvaluatorV2: true,
    // R5/R7 permanecen apagados hasta backfill + contraste oficial.
    defensiveInfographicV2: false,
    defensiveReliabilityV2: false,
  },
};
