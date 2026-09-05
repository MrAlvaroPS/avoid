import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { enqueueCombatEvaluation, type CombatQueueClient } from '../_shared/combat-evaluation-queue.ts';
import {
  planCausalBackfill,
  type CausalQueueJobSnapshot,
  type CausalQueueJobStatus,
  type CausalQueueJobType,
} from '../_shared/causal-backfill-operator.ts';

interface Body {
  reportCode?: unknown;
  playerName?: unknown;
  pullIds?: unknown;
}

interface QueueRow {
  pull_id: string;
  job_type: CausalQueueJobType;
  status: CausalQueueJobStatus;
  updated_at: string;
  last_error: string | null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function pullIdsFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const pullIds = [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
  return pullIds.length ? pullIds : null;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return jsonResponse({ ok: false, error: 'JSON inválido.' }, 400);
  }

  const reportCode = nonEmptyString(body.reportCode);
  const playerName = nonEmptyString(body.playerName);
  const requestedPullIds = pullIdsFrom(body.pullIds);
  if (!reportCode || !playerName || !requestedPullIds) {
    return jsonResponse({
      ok: false,
      error: 'reportCode, playerName y pullIds son obligatorios.',
    }, 400);
  }
  if (requestedPullIds.length > 100) {
    return jsonResponse({ ok: false, error: 'Máximo 100 pulls por operación.' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: pulls, error: pullsError } = await supabase
    .from('pulls')
    .select('id,report_code,ninja_pull_excluded')
    .eq('report_code', reportCode)
    .in('id', requestedPullIds);
  if (pullsError) return jsonResponse({ ok: false, error: pullsError.message }, 500);

  const reportPullIds = (pulls ?? [])
    .filter((pull) => pull.ninja_pull_excluded !== true)
    .map((pull) => String(pull.id));
  if (!reportPullIds.length) {
    return jsonResponse({ ok: false, error: 'Ningún pull solicitado pertenece al report evaluable.' }, 400);
  }

  const { data: records, error: recordsError } = await supabase
    .from('player_pull_records')
    .select('pull_id')
    .eq('player_name', playerName)
    .in('pull_id', reportPullIds);
  if (recordsError) return jsonResponse({ ok: false, error: recordsError.message }, 500);

  const participated = new Set((records ?? []).map((row) => String(row.pull_id)));
  const verifiedPullIds = reportPullIds.filter((pullId) => participated.has(pullId));
  const rejectedPullIds = requestedPullIds.filter((pullId) => !verifiedPullIds.includes(pullId));
  if (rejectedPullIds.length) {
    return jsonResponse({
      ok: false,
      error: 'La selección no coincide con la población auditable del jugador.',
      rejectedPullIds,
    }, 409);
  }

  const { data: jobs, error: jobsError } = await supabase
    .from('combat_evaluation_jobs')
    .select('pull_id,job_type,status,updated_at,last_error')
    .in('pull_id', verifiedPullIds);
  if (jobsError) return jsonResponse({ ok: false, error: jobsError.message }, 500);

  const snapshots: CausalQueueJobSnapshot[] = ((jobs ?? []) as QueueRow[]).map((job) => ({
    pullId: job.pull_id,
    jobType: job.job_type,
    status: job.status,
    updatedAt: job.updated_at,
    lastError: job.last_error,
  }));
  const plan = planCausalBackfill(verifiedPullIds, snapshots);

  let batchId: string | null = null;
  if (plan.enqueuePullIds.length) {
    try {
      batchId = await enqueueCombatEvaluation(supabase as unknown as CombatQueueClient, {
        pullIds: plan.enqueuePullIds,
        jobType: 'full_execution_backfill',
        reason: 'night_player_dossier_phase4b',
        scope: {
          reportCode,
          playerName,
          source: 'night-player-audit-shell',
        },
        payload: {
          requestedAt: new Date().toISOString(),
          requestedPullCount: plan.enqueuePullIds.length,
        },
        requestedBy: guard.userId,
      });
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  }

  return jsonResponse({
    ok: true,
    reportCode,
    playerName,
    targetPullCount: verifiedPullIds.length,
    batchId,
    enqueuedPullIds: plan.enqueuePullIds,
    alreadyCompletePullIds: plan.alreadyCompletePullIds,
    deferredPullIds: plan.deferredPullIds,
    blockedPullIds: plan.blockedPullIds,
    reasons: plan.reasons,
  });
});
