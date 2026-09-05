import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { enqueueCombatEvaluation, type CombatQueueClient } from '../_shared/combat-evaluation-queue.ts';

interface ClaimedJob {
  id: string;
  batch_id: string;
  pull_id: string;
  job_type: string;
  lease_token: string;
}

async function invokeOfficerFunction(
  functionName: string,
  body: Record<string, unknown>,
  authorization: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || payload['ok'] !== true) {
    throw new Error(`${functionName}: ${String(payload['error'] ?? response.statusText)}`);
  }
  return payload;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let { data, error } = await supabase.rpc('claim_combat_evaluation_job', {
    p_job_type: 'full_execution_backfill',
    p_lease_seconds: 300,
  });
  if (!data && !error) {
    ({ data, error } = await supabase.rpc('claim_combat_evaluation_job', {
      p_job_type: 'pull_context',
      p_lease_seconds: 300,
    }));
  }
  if (error) return jsonResponse({ ok: false, error: error.message }, 500);
  const job = data as ClaimedJob | null;
  if (!job) return jsonResponse({ ok: true, processed: false, reason: 'queue_empty' });

  const stages: Record<string, unknown> = {};
  try {
    if (job.job_type === 'full_execution_backfill') {
      const { data: context, error: contextError } = await supabase
        .from('pull_evaluation_context')
        .select('resolver_version')
        .eq('pull_id', job.pull_id)
        .single();
      if (contextError || !context) {
        throw new Error(`load_context: ${contextError?.message ?? 'contexto ausente'}`);
      }
      const authorization = req.headers.get('Authorization') ?? '';
      if (!authorization) throw new Error('Authorization ausente al ejecutar el backfill.');

      const occurrences = await invokeOfficerFunction(
        'evaluate-mechanic-occurrences',
        { pullId: job.pull_id, contextResolverVersion: context.resolver_version },
        authorization,
      );
      stages['occurrences'] = occurrences['occurrencesCreated'] ?? 0;

      const responsibility = await invokeOfficerFunction(
        'compute-responsibility-edges',
        { pullId: job.pull_id },
        authorization,
      );
      stages['responsibilityEdges'] = responsibility['edgesCreated'] ?? 0;

      const defensive = await invokeOfficerFunction(
        'evaluate-defensive-execution',
        { pullId: job.pull_id },
        authorization,
      );
      stages['defensiveEvaluations'] = Array.isArray(defensive['evaluations'])
        ? defensive['evaluations'].length
        : 0;

      const ledger = await invokeOfficerFunction(
        'materialize-execution-ledger',
        { pullId: job.pull_id },
        authorization,
      );
      stages['ledgerEvents'] = ledger['eventsCreated'] ?? 0;

      const consumables = await invokeOfficerFunction(
        'materialize-consumable-execution',
        { pullId: job.pull_id },
        authorization,
      );
      stages['consumableEvents'] = consumables['eventsCreated'] ?? 0;
    } else {
    // PullEvaluationContext es autoridad. Se descarta cualquier derivado v3
    // del intervalo anterior y se agenda su reconstrucción completa; nunca
    // se deja una mezcla de versiones visible a los consumers.
    const { error: ledgerError } = await supabase.from('player_execution_events').delete().eq('pull_id', job.pull_id);
    if (ledgerError) throw new Error(`invalidate_ledger: ${ledgerError.message}`);
    stages['ledgerInvalidated'] = true;

    const { data: occurrenceRows, error: occurrenceReadError } = await supabase
      .from('mechanic_occurrence_evaluations').select('id').eq('pull_id', job.pull_id);
    if (occurrenceReadError) throw new Error(`load_occurrences: ${occurrenceReadError.message}`);
    const occurrenceIds = (occurrenceRows ?? []).map((row) => row.id);
    if (occurrenceIds.length) {
      const { error: responsibilityError } = await supabase.from('mechanic_responsibility_edges').delete().in('occurrence_id', occurrenceIds);
      if (responsibilityError) throw new Error(`invalidate_responsibility: ${responsibilityError.message}`);
    }
    const { error: occurrenceError } = await supabase.from('mechanic_occurrence_evaluations').delete().eq('pull_id', job.pull_id);
    if (occurrenceError) throw new Error(`invalidate_occurrences: ${occurrenceError.message}`);
    stages['occurrencesInvalidated'] = occurrenceIds.length;

    const nextBatchId = await enqueueCombatEvaluation(supabase as unknown as CombatQueueClient, {
      pullIds: [job.pull_id],
      jobType: 'full_execution_backfill',
      reason: 'pull_context_changed',
      scope: { sourceJobId: job.id },
      payload: { contextInvalidatedAt: new Date().toISOString() },
      requestedBy: guard.userId,
    });
    stages['fullBackfillBatchId'] = nextBatchId;
    }

    const { error: finishError } = await supabase.rpc('finish_combat_evaluation_job', {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_succeeded: true,
      p_stage_progress: stages,
      p_error: null,
    });
    if (finishError) throw new Error(`finish_job: ${finishError.message}`);
    return jsonResponse({ ok: true, processed: true, jobId: job.id, pullId: job.pull_id, stages });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const { error: finishError } = await supabase.rpc('finish_combat_evaluation_job', {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_succeeded: false,
      p_stage_progress: stages,
      p_error: message,
    });
    return jsonResponse({ ok: false, error: message, queueFinalizeError: finishError?.message ?? null, jobId: job.id }, 500);
  }
});
