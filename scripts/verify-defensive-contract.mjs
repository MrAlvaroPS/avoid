import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`${label}: falta ${text}`);
}

const environment = read('src/environments/environment.ts');
const reliability = read('src/app/core/reliability.service.ts');
const summary = read('src/app/core/night-player-summary.service.ts');
const infographic = read(
  'src/app/features/night-player-dossier/night-player-infographic.component.ts',
);
const evidenceProjection = read('src/app/core/raider-evidence-projection.ts');
const evaluator = read('supabase/functions/_shared/defensive-execution-evaluator.ts');
const activationMigration = read('supabase/migrations/20260901180000_defensive_activation_semantics.sql');
const consistencyMigration = read('supabase/migrations/20260902150000_defensive_evaluation_consistency.sql');

for (const [flag, enabled] of new Map([
  ['defensiveEffectiveResolverV2', false],
  ['defensiveDeployedPlans', false],
  ['defensiveExecutionEvaluatorV2', false],
  // La infografía tiene gate atómico jugador×noche y puede adelantarse al backfill global.
  ['defensiveInfographicV2', true],
  ['defensiveReliabilityV2', false],
])) {
  requireText(environment, `${flag}: ${enabled}`, 'rollout defensivo explícito');
}

for (const flag of [
  'combatEvaluationContextV2',
  'mechanicPolicyV2',
  'mechanicResponsibilityV2',
  'consumableEvaluatorV2',
  'playerInfographicV3',
  'reliabilityExecutionV3',
]) {
  requireText(environment, `${flag}: true`, 'rollout causal explícito');
}

requireText(
  activationMigration,
  'evaluation.resolver_version as defensive_resolver_version',
  'DV2-02 ya corregido por M18',
);

for (const column of [
  'defensive_required_exact_adherence_count',
  'defensive_solver_version',
  'defensive_game_build',
  'defensive_build_fingerprint',
  'defensive_evaluated_at',
]) {
  requireText(consistencyMigration, column, 'migración de consistencia');
  requireText(reliability, column, 'consumer Reliability');
}

for (const versionedSource of [evaluator, reliability, summary]) {
  requireText(
    versionedSource,
    'defensive-execution-evaluator@2.4.0',
    'gate de evaluator homogéneo',
  );
}
requireText(summary, 'effective-defensives@2.1.0', 'gate de resolver autoritativo en la infografía');

if (
  /v2\.managementScore != null[\s\S]{0,250}planExecutedCount\s*\/\s*v2\.planRequiredCount/.test(
    infographic,
  )
) {
  throw new Error('La agregación nocturna ha reintroducido un proxy distinto del score central.');
}

if (/\.slice\(0,\s*5\)/.test(summary)) {
  throw new Error('El agregado nocturno vuelve a truncar decisiones antes de la proyección.');
}

for (const required of [
  'buildRaiderEvidenceProjection',
  "'confirmed_error'",
  "'no_verdict'",
  'additionalCoachingCount',
  'KNOWN_DEFENSIVE_REASONS',
]) {
  requireText(evidenceProjection, required, 'RaiderEvidenceProjection');
}

for (const inventedFallback of ['deja uno preasignado', 'Revisa en WCL']) {
  if (infographic.includes(inventedFallback)) {
    throw new Error(`La UI conserva un consejo no respaldado: ${inventedFallback}`);
  }
}

for (const splitContract of [
  'findPageSplitY()',
  '1/2 — diagnóstico y coaching',
  '2/2 — mecánicas y defensivos',
]) {
  requireText(infographic, splitContract, 'exportación en dos páginas');
}

const resolverColumn = consistencyMigration.indexOf(
  'evaluation.resolver_version as defensive_resolver_version',
);
const exactColumn = consistencyMigration.indexOf(
  'evaluation.required_exact_adherence_count as defensive_required_exact_adherence_count',
);
if (resolverColumn < 0 || exactColumn < resolverColumn) {
  throw new Error('M21 no conserva el orden de columnas publicado por la vista M18.');
}

console.log('Contrato defensivo: OK');
