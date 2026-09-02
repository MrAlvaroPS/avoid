import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const migrationDir = join(root, 'supabase', 'migrations');
const migrations = [
  '20260901190000_pull_evaluation_context.sql',
  '20260901200000_mechanic_identity_policy_v2.sql',
  '20260901210000_mechanic_occurrence_responsibility.sql',
  '20260901220000_player_execution_ledger.sql',
];
const sql = new Map(migrations.map((name) => [name, readFileSync(join(migrationDir, name), 'utf8')]));
const extensionMigrations = [
  '20260901230000_combat_evaluation_queue.sql',
  '20260901240000_pull_dispel_events.sql',
  '20260901250000_mechanic_policy_versions.sql',
  '20260902090000_boss_mechanic_catalog_sync_state.sql',
  '20260902110000_refresh_applicable_candidates_causal_identity.sql',
  '20260902130000_publish_mechanic_policy_batch.sql',
];
const extensionSql = new Map(
  extensionMigrations.map((name) => [name, readFileSync(join(migrationDir, name), 'utf8')]),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quotedValues(source) {
  return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const allMigrationNames = readdirSync(migrationDir).filter((name) => name.endsWith('.sql'));
const timestamps = allMigrationNames.map((name) => name.slice(0, 14));
assert(new Set(timestamps).size === timestamps.length, 'Hay timestamps de migración duplicados.');
assert(migrations.every((name, index) => index === 0 || name > migrations[index - 1]), 'M11-M14 no están ordenadas.');
assert(extensionMigrations.every((name, index) => index === 0 || name > extensionMigrations[index - 1]), 'Las extensiones causales no están ordenadas.');
assert(extensionMigrations[0] > migrations.at(-1), 'Las extensiones causales deben suceder a M14.');

const requiredTablesByMigration = new Map([
  [migrations[0], ['pull_evaluation_context', 'pull_evaluation_context_audit']],
  [migrations[1], ['boss_mechanic_policy', 'boss_mechanic_policy_audit', 'boss_mechanic_aliases']],
  [migrations[2], ['mechanic_occurrence_evaluations', 'mechanic_responsibility_edges']],
  [migrations[3], ['player_execution_events']],
]);

for (const [name, tables] of requiredTablesByMigration) {
  const body = sql.get(name);
  assert(!/\b(drop\s+table|truncate|delete\s+from|drop\s+column)\b/i.test(body), `${name} contiene una operación destructiva.`);
  for (const table of tables) {
    assert(body.includes(`create table if not exists ${table}`), `${name} no crea ${table}.`);
    assert(body.includes(`alter table ${table} enable row level security`), `${table} no activa RLS.`);
    assert(body.includes(`on ${table} for select using (is_officer())`), `${table} no limita lectura a officers.`);
  }
}

const occurrenceSql = sql.get(migrations[2]);
assert(occurrenceSql.includes('foreign key (pull_id, boss_id, difficulty)'), 'Occurrences no fijan scope pull+boss+dificultad.');
assert(occurrenceSql.includes('occurrence_index integer not null check (occurrence_index > 0)'), 'Occurrences no exigen índices positivos.');
assert(occurrenceSql.includes("check (not penalty_eligible or confidence in ('verified', 'inferred'))"), 'Responsibility permite penalizar confianza no fiable.');
assert(occurrenceSql.includes("check (relationship <> 'collateral_victim' or not penalty_eligible)"), 'Una víctima colateral podría quedar penalizada.');

const occurrenceEvaluator = readFileSync(join(root, 'supabase', 'functions', 'evaluate-mechanic-occurrences', 'index.ts'), 'utf8');
assert(/occurrence_index:\s*1\b/.test(occurrenceEvaluator), 'El evaluator debe usar un occurrence_index positivo.');
assert(
  occurrenceEvaluator.includes("onConflict: 'pull_id,mechanic_key,occurrence_index,occurrence_resolver_version'"),
  'El UPSERT de occurrences no coincide con el unique versionado de M13.',
);
const responsibilityEvaluator = readFileSync(join(root, 'supabase', 'functions', 'compute-responsibility-edges', 'index.ts'), 'utf8');
assert(
  responsibilityEvaluator.includes("onConflict: 'occurrence_id,player_name,relationship,reason_code'"),
  'El UPSERT de edges no coincide con el unique de M13.',
);

const ledgerSql = sql.get(migrations[3]);
assert(ledgerSql.includes("check (verdict <> 'uncertain' or (not credit_eligible and not penalty_eligible))"), 'Ledger permite puntuar incertidumbre.');
assert(ledgerSql.match(/with \(security_invoker = true\)/g)?.length === 4, 'Las cuatro views v3 deben respetar RLS del invocador.');

const queueSql = extensionSql.get(extensionMigrations[0]);
assert(queueSql.includes('create table if not exists combat_evaluation_batches'), 'M11b no crea combat_evaluation_batches.');
assert(queueSql.includes('create table if not exists combat_evaluation_jobs'), 'M11b no crea combat_evaluation_jobs.');
assert(queueSql.includes('alter table combat_evaluation_batches enable row level security'), 'La cola causal no activa RLS en batches.');
assert(queueSql.includes('alter table combat_evaluation_jobs enable row level security'), 'La cola causal no activa RLS en jobs.');
assert(queueSql.includes('create or replace function claim_combat_evaluation_job'), 'M11b no crea la RPC de claim con lease.');
assert(queueSql.includes('create or replace function finish_combat_evaluation_job'), 'M11b no crea la RPC de finish con lease.');

const dispelSql = extensionSql.get(extensionMigrations[1]);
assert(dispelSql.includes('create table if not exists pull_dispel_events'), 'M15 no crea pull_dispel_events.');
assert(dispelSql.includes('alter table pull_dispel_events enable row level security'), 'pull_dispel_events no activa RLS.');
assert(dispelSql.includes('on pull_dispel_events for select using (is_officer())'), 'pull_dispel_events no limita lectura a officers.');

const policyVersionsSql = extensionSql.get(extensionMigrations[2]);
assert(policyVersionsSql.includes('create table if not exists boss_mechanic_policy_versions'), 'M16 no crea snapshots de policy.');
assert(policyVersionsSql.includes('create trigger boss_mechanic_policy_snapshot_version'), 'M16 no materializa snapshots atómicos de policy.');
assert(policyVersionsSql.includes('alter table boss_mechanic_policy_versions enable row level security'), 'Snapshots de policy no activan RLS.');
const ledgerMaterializer = readFileSync(join(root, 'supabase', 'functions', 'materialize-execution-ledger', 'index.ts'), 'utf8');
assert(ledgerMaterializer.includes(".from('boss_mechanic_policy_versions')"), 'El ledger debe resolver policies desde snapshots versionados.');

const catalogSyncSql = extensionSql.get(extensionMigrations[3]);
assert(catalogSyncSql.includes('create table if not exists boss_mechanic_catalog_sync_state'), 'M17 no crea el estado de sync del catálogo.');
assert(catalogSyncSql.includes('alter table boss_mechanic_catalog_sync_state enable row level security'), 'El estado de sync del catálogo no activa RLS.');
assert(catalogSyncSql.includes('on boss_mechanic_catalog_sync_state for select using (is_officer())'), 'El estado de sync del catálogo no limita lectura a officers.');
const mechanicSync = readFileSync(join(root, 'supabase', 'functions', 'sync-boss-mechanics', 'index.ts'), 'utf8');
assert(mechanicSync.includes(".from('boss_mechanic_catalog_sync_state')"), 'sync-boss-mechanics no persiste su estado operativo.');

const refreshedCandidatesSql = extensionSql.get(extensionMigrations[4]);
assert(refreshedCandidatesSql.includes('create or replace view applicable_boss_mechanics_candidates'), 'M18 no recrea la vista de candidates aplicables.');
assert(refreshedCandidatesSql.includes('select candidate.*'), 'M18 no reexpande las columnas actuales de candidates.');
assert(refreshedCandidatesSql.includes('mechanic_key y policy_version'), 'M18 no documenta las columnas causales que debe exponer.');

const policyBatchSql = extensionSql.get(extensionMigrations[5]);
assert(policyBatchSql.includes('create or replace function publish_mechanic_policy_batch'), 'M19 no crea la publicación causal por lote.');
assert(policyBatchSql.includes('jsonb_array_length(p_entries) > 20'), 'M19 no limita el tamaño del lote causal.');
assert(policyBatchSql.includes('insert into boss_mechanic_policy_audit'), 'M19 no audita cada policy publicada.');
assert(policyBatchSql.includes('for update'), 'M19 no serializa el incremento de versión por policy.');

const aliasSync = readFileSync(join(root, 'supabase', 'functions', 'sync-mechanic-aliases', 'index.ts'), 'utf8');
assert(!aliasSync.includes("onConflict: 'boss_id,difficulty,mechanic_key,ability_id,normalized_name'"), 'El UPSERT de aliases no coincide con los índices parciales de M12.');
assert(aliasSync.includes(".eq('ability_id', values.ability_id)") && aliasSync.includes(".eq('normalized_name', values.normalized_name)"), 'La sincronización de aliases debe resolver ambos identificadores activos.');
const policyBackfill = readFileSync(join(root, 'supabase', 'functions', 'backfill-mechanic-candidates-to-policy', 'index.ts'), 'utf8');
assert(policyBackfill.includes(".from('applicable_boss_mechanics_candidates')"), 'El backfill de policies debe respetar la vista de candidates aplicables.');
assert(!policyBackfill.includes(".eq('excluded', false)"), 'El backfill de policies depende de una columna excluded que no existe en candidates.');
assert(policyBackfill.includes('function responsibilityModeFromLegacy'), 'El backfill debe traducir responsabilidades legacy al enum causal.');
assert(!policyBackfill.includes("responsibility_mode: candidate.responsibility"), 'El backfill no puede insertar responsabilidades legacy directamente en M12.');

const mechanicClassifier = readFileSync(join(root, 'supabase', 'functions', 'classify-mechanics', 'index.ts'), 'utf8');
assert(mechanicClassifier.includes('promptVersion: 8'), 'El clasificador de catálogo no expone el contrato v8 separado.');
assert(!mechanicClassifier.includes(".from('boss_mechanic_policy')"), 'El clasificador de catálogo todavía publica policies.');
assert(!mechanicClassifier.includes('resyncMechanicCategory'), 'El clasificador de catálogo todavía recorre históricos.');
assert(mechanicClassifier.includes('submittedPairs.has(submittedPair)'), 'El clasificador no rechaza pares ability+difficulty duplicados antes del UPSERT.');

const policyClassifier = readFileSync(join(root, 'supabase', 'functions', 'classify-mechanic-policies', 'index.ts'), 'utf8');
assert(policyClassifier.includes('MAX_POLICY_BATCH_SIZE = 20'), 'El clasificador causal no limita cada lote a 20 policies.');
assert(policyClassifier.includes(".rpc('publish_mechanic_policy_batch'"), 'El clasificador causal no usa la publicación transaccional.');
assert(policyClassifier.includes('applyPolicyConfidenceGuard'), 'El clasificador causal no aplica guards por confianza.');
assert(policyClassifier.includes("entry.difficulty !== difficulty"), 'El clasificador causal no restringe el lote a una dificultad.');
assert(policyClassifier.includes('Todas las policies a investigar'), 'El prompt causal no incluye todas las mecánicas/dificultades del boss.');
assert(policyClassifier.includes('policyIdentities: list.map'), 'El prompt causal no devuelve identities para validar la respuesta global antes de publicar.');
const policyBatcher = readFileSync(join(root, 'src', 'app', 'shared', 'mechanic-policy-batches.ts'), 'utf8');
assert(policyBatcher.includes('expectedByKey') && policyBatcher.includes('byDifficulty') && policyBatcher.includes('group.slice(offset, offset + maxBatchSize)'), 'El cliente no valida y fragmenta la respuesta global por dificultad y tamaño.');

const contract = readFileSync(join(root, 'supabase', 'functions', '_shared', 'combat-evaluation-contract.ts'), 'utf8');
const contractReasonBlock = contract.match(/EXECUTION_REASON_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/);
const sqlReasonBlock = ledgerSql.match(/reason_code text[\s\S]*?check \(reason_code in \(([\s\S]*?)\)\),/);
assert(contractReasonBlock && sqlReasonBlock, 'No se pudo leer el contrato de reason codes.');
const contractReasons = quotedValues(contractReasonBlock[1]);
const sqlReasons = quotedValues(sqlReasonBlock[1]);
assert(JSON.stringify(contractReasons) === JSON.stringify(sqlReasons), 'Los reason codes TypeScript y SQL no coinciden exactamente.');
assert(new Set(contractReasons).size === contractReasons.length, 'Hay reason codes duplicados.');
const edgeBuilder = readFileSync(join(root, 'supabase', 'functions', '_shared', 'responsibility-edge-builder.ts'), 'utf8');
const edgeReasonCodes = [...edgeBuilder.matchAll(/'([A-Z][A-Z_]+)'/g)].map((match) => match[1]);
assert(edgeReasonCodes.every((reason) => contractReasons.includes(reason)), 'El builder de responsibility edges contiene reason codes fuera del contrato M14.');

const environment = readFileSync(join(root, 'src', 'environments', 'environment.ts'), 'utf8');
const expectedFlags = [
  'combatEvaluationContextV2',
  'mechanicPolicyV2',
  'mechanicResponsibilityV2',
  'consumableEvaluatorV2',
  'playerInfographicV3',
  'reliabilityExecutionV3',
];
for (const flag of expectedFlags) {
  assert(new RegExp(`${flag}:\\s*false`).test(environment), `${flag} no nace apagado.`);
}

console.log(`Causal schema OK: ${migrations.length + extensionMigrations.length} migraciones, ${contractReasons.length} reason codes y ${expectedFlags.length} flags apagados.`);
