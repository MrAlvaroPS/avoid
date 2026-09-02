import { spawnSync } from 'node:child_process';

const functions = [
  'analyze-report',
  'set-pull-evaluation-context',
  'evaluate-mechanic-occurrences',
  'compute-responsibility-edges',
  'evaluate-defensive-execution',
  'materialize-execution-ledger',
  'materialize-consumable-execution',
  'process-combat-evaluation-queue',
  'publish-mechanic-policy',
  'query-mechanic-policy',
  'sync-mechanic-aliases',
  'backfill-mechanic-candidates-to-policy',
  'classify-mechanics',
  'classify-mechanic-policies',
];

for (const functionName of functions) {
  const result = spawnSync(
    'npx',
    ['deno', 'check', `supabase/functions/${functionName}/index.ts`],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Causal runtime OK: ${functions.length} Edge Functions comprobadas.`);
