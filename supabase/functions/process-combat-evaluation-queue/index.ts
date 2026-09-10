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

type Action = 'process' | 'prepare-report' | 'process-batch' | 'status-report';

interface Body {
  action?: Action;
  reportCode?: string | null;
  batchId?: string | null;
}

interface FullBackfillJobRow {
  id: string;
  batch_id: string;
  pull_id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown> | null;
  last_error: string | null;
  finished_at: string | null;
}

interface NightReadinessEnqueueResult {
  batchId: string | null;
  enqueuedPullIds: string[];
  waitingPullIds: string[];
}

const NIGHT_INFOGRAPHIC_READINESS_VERSION = 'night-infographic-readiness@1';

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

async function reportPullIds(supabase: any, reportCode: string): Promise<string[]> {
  const { data: ingestionComplete, error: ingestionError } = await supabase.rpc(
    'canonical_defensive_report_ingestion_complete',
    { p_report_code: reportCode },
  );
  if (ingestionError) throw new Error(`report_ingestion_status: ${ingestionError.message}`);
  if (ingestionComplete !== true) {
    throw new Error(
      `El informe ${reportCode} todavía no ha terminado de ingerirse; no se enviará ninguna infografía.`,
    );
  }

  const { data, error } = await supabase
    .from('canonical_scored_pulls')
    .select('id')
    .eq('report_code', reportCode)
    .order('fight_id', { ascending: true });
  if (error) throw new Error(`load_canonical_pulls: ${error.message}`);
  return (data ?? []).map((row: { id: string }) => row.id);
}

function isCurrentCompletedJob(job: FullBackfillJobRow | undefined): boolean {
  return job?.status === 'done'
    && job.payload?.['nightInfographicReadinessVersion'] === NIGHT_INFOGRAPHIC_READINESS_VERSION;
}

async function loadReportJobs(supabase: any, pullIds: string[]): Promise<FullBackfillJobRow[]> {
  if (!pullIds.length) return [];
  const { data, error } = await supabase
    .from('combat_evaluation_jobs')
    .select('id,batch_id,pull_id,status,attempts,max_attempts,payload,last_error,finished_at')
    .eq('job_type', 'full_execution_backfill')
    .in('pull_id', pullIds);
  if (error) throw new Error(`load_execution_backfill_jobs: ${error.message}`);
  return (data ?? []) as FullBackfillJobRow[];
}

async function reportLedgerStatus(supabase: any, reportCode: string) {
  const pullIds = await reportPullIds(supabase, reportCode);
  const jobs = await loadReportJobs(supabase, pullIds);
  const byPull = new Map(jobs.map((job) => [job.pull_id, job]));
  const current = pullIds.map((pullId) => byPull.get(pullId));
  const completedPulls = current.filter(isCurrentCompletedJob).length;
  const failed = current.filter(
    (job) => job?.status === 'error'
      && job.payload?.['nightInfographicReadinessVersion'] === NIGHT_INFOGRAPHIC_READINESS_VERSION,
  ) as FullBackfillJobRow[];
  const failedPulls = failed.length;
  const pendingPulls = pullIds.length - completedPulls - failedPulls;

  return {
    ok: true,
    state: completedPulls === pullIds.length ? 'ready' : failedPulls > 0 ? 'failed' : 'pending',
    reportCode,
    readinessVersion: NIGHT_INFOGRAPHIC_READINESS_VERSION,
    totalPulls: pullIds.length,
    completedPulls,
    pendingPulls,
    failedPulls,
    lastError: failed.find((job) => job.last_error)?.last_error ?? null,
  };
}

async function prepareReportLedger(supabase: any, reportCode: string, requestedBy: string) {
  const pullIds = await reportPullIds(supabase, reportCode);
  const jobs = await loadReportJobs(supabase, pullIds);
  const byPull = new Map(jobs.map((job) => [job.pull_id, job]));
  const missingPullIds = pullIds.filter((pullId) => !isCurrentCompletedJob(byPull.get(pullId)));
  if (!missingPullIds.length) {
    return { ...(await reportLedgerStatus(supabase, reportCode)), batchId: null };
  }

  const { data, error } = await supabase.rpc('enqueue_night_infographic_readiness_jobs', {
    p_pull_ids: missingPullIds,
    p_report_code: reportCode,
    p_readiness_version: NIGHT_INFOGRAPHIC_READINESS_VERSION,
    p_requested_by: requestedBy,
  });
  if (error) throw new Error(`enqueue_night_readiness: ${error.message}`);
  const enqueue = data as NightReadinessEnqueueResult | null;
  if (!enqueue) throw new Error('enqueue_night_readiness: respuesta ausente');
  return {
    ...(await reportLedgerStatus(supabase, reportCode)),
    batchId: enqueue.batchId,
    waitingPulls: enqueue.waitingPullIds.length,
  };
}

async function processClaimedJob(
  supabase: any,
  job: ClaimedJob,
  authorization: string,
  requestedBy: string,
) {
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
      // PullEvaluationContext is authoritative. Invalidate the previous v3
      // interval and enqueue its complete rebuild; never expose mixed versions.
      const { error: ledgerError } = await supabase
        .from('player_execution_events')
        .delete()
        .eq('pull_id', job.pull_id);
      if (ledgerError) throw new Error(`invalidate_ledger: ${ledgerError.message}`);
      stages['ledgerInvalidated'] = true;

      const { data: occurrenceRows, error: occurrenceReadError } = await supabase
        .from('mechanic_occurrence_evaluations')
        .select('id')
        .eq('pull_id', job.pull_id);
      if (occurrenceReadError) throw new Error(`load_occurrences: ${occurrenceReadError.message}`);
      const occurrenceIds = (occurrenceRows ?? []).map((row: { id: string }) => row.id);
      if (occurrenceIds.length) {
        const { error: responsibilityError } = await supabase
          .from('mechanic_responsibility_edges')
          .delete()
          .in('occurrence_id', occurrenceIds);
        if (responsibilityError) throw new Error(`invalidate_responsibility: ${responsibilityError.message}`);
      }
      const { error: occurrenceError } = await supabase
        .from('mechanic_occurrence_evaluations')
        .delete()
        .eq('pull_id', job.pull_id);
      if (occurrenceError) throw new Error(`invalidate_occurrences: ${occurrenceError.message}`);
      stages['occurrencesInvalidated'] = occurrenceIds.length;

      const nextBatchId = await enqueueCombatEvaluation(supabase as unknown as CombatQueueClient, {
        pullIds: [job.pull_id],
        jobType: 'full_execution_backfill',
        reason: 'pull_context_changed',
        scope: { sourceJobId: job.id },
        payload: { contextInvalidatedAt: new Date().toISOString() },
        requestedBy,
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
    return { ok: true, processed: true, jobId: job.id, pullId: job.pull_id, stages };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const { error: finishError } = await supabase.rpc('finish_combat_evaluation_job', {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_succeeded: false,
      p_stage_progress: stages,
      p_error: message,
    });
    return {
      ok: false,
      error: message,
      queueFinalizeError: finishError?.message ?? null,
      jobId: job.id,
    };
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = (await req.json().catch(() => ({}))) as Body;
  const requestedAction = body.action ?? 'process';
  const allowedActions: readonly Action[] = ['process', 'prepare-report', 'process-batch', 'status-report'];
  if (!allowedActions.includes(requestedAction)) {
    return jsonResponse({ ok: false, error: `action no soportada: ${String(requestedAction)}` }, 400);
  }
  const action: Action = requestedAction;

  try {
    if (action === 'prepare-report') {
      if (!body.reportCode) return jsonResponse({ ok: false, error: 'reportCode required' }, 400);
      return jsonResponse(await prepareReportLedger(supabase, body.reportCode, guard.userId));
    }
    if (action === 'status-report') {
      if (!body.reportCode) return jsonResponse({ ok: false, error: 'reportCode required' }, 400);
      return jsonResponse(await reportLedgerStatus(supabase, body.reportCode));
    }

    let data: unknown = null;
    let error: { message: string } | null = null;
    if (action === 'process-batch') {
      if (!body.batchId) return jsonResponse({ ok: false, error: 'batchId required' }, 400);
      ({ data, error } = await supabase.rpc('claim_combat_evaluation_job_for_batch', {
        p_batch_id: body.batchId,
        p_job_type: 'full_execution_backfill',
        p_lease_seconds: 300,
      }));
    } else {
      ({ data, error } = await supabase.rpc('claim_combat_evaluation_job', {
        p_job_type: 'full_execution_backfill',
        p_lease_seconds: 300,
      }));
    }
    if (!data && !error && action === 'process') {
      ({ data, error } = await supabase.rpc('claim_combat_evaluation_job', {
        p_job_type: 'pull_context',
        p_lease_seconds: 300,
      }));
    }
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const job = data as ClaimedJob | null;
    if (!job) {
      return jsonResponse({
        ok: true,
        processed: false,
        reason: action === 'process-batch' ? 'batch_empty' : 'queue_empty',
        batchId: body.batchId ?? null,
      });
    }

    const result = await processClaimedJob(
      supabase,
      job,
      req.headers.get('Authorization') ?? '',
      guard.userId,
    );
    return jsonResponse(result, result.ok ? 200 : 500);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
