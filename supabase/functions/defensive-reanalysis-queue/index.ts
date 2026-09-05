import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import {
  DEFENSIVE_REANALYSIS_MAX_ATTEMPTS,
  DEFENSIVE_REANALYSIS_STALE_RUNNING_MS,
} from '../_shared/defensive-reanalysis-queue.ts';
import { defensiveReanalysisHealth } from '../_shared/defensive-reanalysis-health.ts';
import { enqueueDefensiveReanalysis } from '../_shared/defensive-reanalysis-queue.ts';
import { auditControlledDefensiveBackfill } from '../_shared/controlled-defensive-backfill-audit.ts';

type QueueAction = 'pending' | 'status' | 'retry' | 'cancel' | 'start_sample' | 'sample_report';

interface QueueRequestBody {
  action?: QueueAction;
  batchId?: string | null;
  limit?: number;
  bossId?: string;
  difficulty?: string;
  sampleSize?: number;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: QueueRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.action || !['pending', 'status', 'retry', 'cancel', 'start_sample', 'sample_report'].includes(body.action)) {
    return jsonResponse({ ok: false, error: 'action inválida' }, 400);
  }
  if (
    body.batchId != null &&
    (typeof body.batchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.batchId))
  ) {
    return jsonResponse({ ok: false, error: 'batchId inválido' }, 400);
  }
  const limit = body.limit == null ? 100 : Math.floor(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
    return jsonResponse({ ok: false, error: 'limit debe estar entre 1 y 250' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - DEFENSIVE_REANALYSIS_STALE_RUNNING_MS).toISOString();
    const { data: staleRows, error: staleError } = await supabase
      .from('defensive_reanalysis_jobs')
      .update({ status: 'queued', last_error: 'Lease expirada; job reencolado.', claimed_at: null, updated_at: now })
      .eq('status', 'running')
      .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
      .select('batch_id');
    if (staleError) throw staleError;
    const recoveredBatchIds = [...new Set((staleRows ?? []).map((row) => row.batch_id as string))];
    if (recoveredBatchIds.length) {
      const { error: recoveredBatchError } = await supabase
        .from('defensive_reanalysis_batches')
        .update({ status: 'queued', finished_at: null, updated_at: now })
        .in('id', recoveredBatchIds);
      if (recoveredBatchError) throw recoveredBatchError;
    }

    if (body.action === 'start_sample') {
      const bossId = typeof body.bossId === 'string' ? body.bossId.trim() : '';
      const difficulty = typeof body.difficulty === 'string' ? body.difficulty.trim() : '';
      const sampleSize = body.sampleSize == null ? 5 : Math.floor(body.sampleSize);
      if (!bossId) return jsonResponse({ ok: false, error: 'bossId es obligatorio' }, 400);
      if (!difficulty) return jsonResponse({ ok: false, error: 'difficulty es obligatoria' }, 400);
      if (!Number.isInteger(sampleSize) || sampleSize < 5 || sampleSize > 10) {
        return jsonResponse({ ok: false, error: 'sampleSize debe estar entre 5 y 10' }, 400);
      }

      const scope = { kind: 'controlled_backfill', bossId, difficulty };
      const { data: existingBatch, error: existingBatchError } = await supabase
        .from('defensive_reanalysis_batches')
        .select('id,status')
        .eq('reason', 'controlled_backfill')
        .contains('scope', scope)
        .in('status', ['queued', 'running', 'completed_with_errors'])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingBatchError) throw existingBatchError;

      if (existingBatch) {
        const { data: existingJobs, error: existingJobsError } = await supabase
          .from('defensive_reanalysis_jobs')
          .select('id,pull_id,status,attempts')
          .eq('batch_id', existingBatch.id)
          .in('status', ['queued', 'error'])
          .lt('attempts', DEFENSIVE_REANALYSIS_MAX_ATTEMPTS);
        if (existingJobsError) throw existingJobsError;
        return jsonResponse({
          ok: true,
          batchId: existingBatch.id,
          reused: true,
          pullIds: (existingJobs ?? []).map((job) => job.pull_id),
          jobs: (existingJobs ?? []).map((job) => ({ id: job.id, pullId: job.pull_id })),
        });
      }

      const { data: pulls, error: pullsError } = await supabase
        .from('pulls')
        .select('id')
        .eq('boss_id', bossId)
        .eq('difficulty', difficulty)
        .eq('ninja_pull_excluded', false)
        .order('closed_at', { ascending: false })
        .limit(sampleSize);
      if (pullsError) throw pullsError;
      const pullIds = (pulls ?? []).map((pull) => pull.id as string);
      if (pullIds.length < 5) {
        return jsonResponse({
          ok: false,
          error: `Solo hay ${pullIds.length} pulls elegibles para ${bossId} ${difficulty}; se necesitan al menos 5.`,
        }, 409);
      }
      const enqueued = await enqueueDefensiveReanalysis(supabase, {
        pullIds,
        reason: 'controlled_backfill',
        scope: { ...scope, requestedSampleSize: sampleSize },
        requestedBy: guard.userId,
      });
      return jsonResponse({
        ok: true,
        batchId: enqueued.batchId,
        reused: false,
        pullIds,
        jobs: enqueued.jobs,
      });
    }

    if (body.action === 'sample_report') {
      if (!body.batchId) return jsonResponse({ ok: false, error: 'batchId es obligatorio' }, 400);
      const { data: jobs, error: jobsError } = await supabase
        .from('defensive_reanalysis_jobs')
        .select('pull_id,status')
        .eq('batch_id', body.batchId);
      if (jobsError) throw jobsError;
      const pullIds = [...new Set((jobs ?? []).map((job) => job.pull_id as string))];
      const { data: records, error: recordsError } = pullIds.length
        ? await supabase
            .from('player_pull_records')
            .select('player_name,game_build,game_build_confidence,defensive_resolution_shadow,death_defensive_options_v2,defensive_pressure_windows_v2')
            .in('pull_id', pullIds)
        : { data: [], error: null };
      if (recordsError) throw recordsError;
      return jsonResponse({
        ok: true,
        batchId: body.batchId,
        progress: {
          total: jobs?.length ?? 0,
          completed: (jobs ?? []).filter((job) => job.status === 'done').length,
          running: (jobs ?? []).filter((job) => job.status === 'running').length,
          failed: (jobs ?? []).filter((job) => job.status === 'error').length,
        },
        cases: auditControlledDefensiveBackfill(
          (records ?? []).map((record) => ({
            playerName: record.player_name,
            gameBuild: record.game_build,
            gameBuildConfidence: record.game_build_confidence,
            defensiveResolutionShadow: record.defensive_resolution_shadow,
            deathDefensiveOptionsV2: record.death_defensive_options_v2,
            defensivePressureWindowsV2: record.defensive_pressure_windows_v2,
          })),
        ),
      });
    }

    if (body.action === 'retry') {
      let retryQuery = supabase
        .from('defensive_reanalysis_jobs')
        .update({ status: 'queued', attempts: 0, claimed_at: null, finished_at: null, updated_at: now })
        .eq('status', 'error');
      if (body.batchId) retryQuery = retryQuery.eq('batch_id', body.batchId);
      const { data: retriedRows, error: retryError } = await retryQuery.select('id,batch_id');
      if (retryError) throw retryError;

      const batchIds = [...new Set((retriedRows ?? []).map((row) => row.batch_id as string))];
      if (batchIds.length) {
        const { error: batchRetryError } = await supabase
          .from('defensive_reanalysis_batches')
          .update({ status: 'queued', failed_jobs: 0, finished_at: null, updated_at: now })
          .in('id', batchIds);
        if (batchRetryError) throw batchRetryError;
      }

      return jsonResponse({
        ok: true,
        retriedCount: retriedRows?.length ?? 0,
        batchIds,
        maxAttempts: DEFENSIVE_REANALYSIS_MAX_ATTEMPTS,
      });
    }

    if (body.action === 'cancel') {
      // §"cancelar cola... de forma real y eficiente" (feedback real,
      // 2026-09-04): dos UPDATE masivos (uno por tabla), no un bucle
      // job-a-job — cientos de filas en una sola sentencia SQL cada uno.
      // Sin batchId cancela TODA la cola no terminal, que es el caso de uso
      // real (limpiar el backlog acumulado de antes del refactor v10, ya
      // irrecuperable — rate limit de WCL expirado, catálogo viejo).
      let jobsQuery = supabase
        .from('defensive_reanalysis_jobs')
        .update({
          status: 'cancelled',
          last_error: 'Cancelado por officer.',
          claimed_at: null,
          finished_at: now,
          updated_at: now,
        })
        .in('status', ['queued', 'running', 'error']);
      if (body.batchId) jobsQuery = jobsQuery.eq('batch_id', body.batchId);
      const { data: cancelledJobs, error: cancelJobsError } = await jobsQuery.select('id,batch_id');
      if (cancelJobsError) throw cancelJobsError;

      let batchesQuery = supabase
        .from('defensive_reanalysis_batches')
        .update({ status: 'cancelled', finished_at: now, updated_at: now })
        .in('status', ['queued', 'running', 'completed_with_errors']);
      if (body.batchId) batchesQuery = batchesQuery.eq('id', body.batchId);
      const { data: cancelledBatches, error: cancelBatchesError } = await batchesQuery.select('id');
      if (cancelBatchesError) throw cancelBatchesError;

      return jsonResponse({
        ok: true,
        cancelledJobs: cancelledJobs?.length ?? 0,
        cancelledBatches: cancelledBatches?.length ?? 0,
      });
    }

    if (body.action === 'status') {
      const baseCountQuery = (status: 'queued' | 'running' | 'error') => {
        let query = supabase
          .from('defensive_reanalysis_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('status', status);
        if (body.batchId) query = query.eq('batch_id', body.batchId);
        return query;
      };

      let retryableQuery = baseCountQuery('error').lt('attempts', DEFENSIVE_REANALYSIS_MAX_ATTEMPTS);
      let blockedQuery = baseCountQuery('error').gte('attempts', DEFENSIVE_REANALYSIS_MAX_ATTEMPTS);
      let batchQuery = supabase
        .from('defensive_reanalysis_batches')
        .select('id,reason,scope,status,total_jobs,completed_jobs,failed_jobs,created_at,started_at,finished_at,updated_at')
        .in('status', ['queued', 'running', 'completed_with_errors'])
        .order('updated_at', { ascending: false })
        .limit(8);
      let lastErrorQuery = supabase
        .from('defensive_reanalysis_jobs')
        .select('id,batch_id,pull_id,attempts,last_error,updated_at')
        .eq('status', 'error')
        .not('last_error', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (body.batchId) {
        retryableQuery = retryableQuery.eq('batch_id', body.batchId);
        blockedQuery = blockedQuery.eq('batch_id', body.batchId);
        batchQuery = batchQuery.eq('id', body.batchId);
        lastErrorQuery = lastErrorQuery.eq('batch_id', body.batchId);
      }

      const [queuedResult, runningResult, retryableResult, blockedResult, batchesResult, lastErrorResult] = await Promise.all([
        baseCountQuery('queued'),
        baseCountQuery('running'),
        retryableQuery,
        blockedQuery,
        batchQuery,
        lastErrorQuery,
      ]);
      const firstError = [queuedResult, runningResult, retryableResult, blockedResult, batchesResult, lastErrorResult]
        .map((result) => result.error)
        .find(Boolean);
      if (firstError) throw firstError;

      const counts = {
        queued: queuedResult.count ?? 0,
        running: runningResult.count ?? 0,
        retryableErrors: retryableResult.count ?? 0,
        blockedErrors: blockedResult.count ?? 0,
      };
      const lastError = lastErrorResult.data?.[0] ?? null;
      return jsonResponse({
        ok: true,
        health: defensiveReanalysisHealth(counts),
        counts,
        pendingCount: counts.queued + counts.running + counts.retryableErrors,
        maxAttempts: DEFENSIVE_REANALYSIS_MAX_ATTEMPTS,
        lastError: lastError
          ? {
              jobId: lastError.id,
              batchId: lastError.batch_id,
              pullId: lastError.pull_id,
              attempts: lastError.attempts,
              message: lastError.last_error,
              updatedAt: lastError.updated_at,
            }
          : null,
        batches: (batchesResult.data ?? []).map((batch) => ({
          id: batch.id,
          reason: batch.reason,
          scope: batch.scope ?? {},
          status: batch.status,
          totalJobs: batch.total_jobs,
          completedJobs: batch.completed_jobs,
          failedJobs: batch.failed_jobs,
          createdAt: batch.created_at,
          startedAt: batch.started_at,
          finishedAt: batch.finished_at,
          updatedAt: batch.updated_at,
        })),
      });
    }

    let jobsQuery = supabase
      .from('defensive_reanalysis_jobs')
      .select('id,batch_id,pull_id,status,attempts,last_error,created_at')
      .in('status', ['queued', 'error'])
      .lt('attempts', DEFENSIVE_REANALYSIS_MAX_ATTEMPTS)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (body.batchId) jobsQuery = jobsQuery.eq('batch_id', body.batchId);
    const { data: jobRows, error: jobsError } = await jobsQuery;
    if (jobsError) throw jobsError;

    const batchIds = [...new Set((jobRows ?? []).map((row) => row.batch_id as string))];
    const batchById = new Map<string, { reason: string; scope: Record<string, unknown> }>();
    if (batchIds.length) {
      const { data: batchRows, error: batchesError } = await supabase
        .from('defensive_reanalysis_batches')
        .select('id,reason,scope')
        .in('id', batchIds);
      if (batchesError) throw batchesError;
      for (const batch of batchRows ?? []) {
        batchById.set(batch.id, { reason: batch.reason, scope: batch.scope ?? {} });
      }
    }

    let blockedQuery = supabase
      .from('defensive_reanalysis_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'error')
      .gte('attempts', DEFENSIVE_REANALYSIS_MAX_ATTEMPTS);
    if (body.batchId) blockedQuery = blockedQuery.eq('batch_id', body.batchId);
    const { count: blockedCount, error: blockedError } = await blockedQuery;
    if (blockedError) throw blockedError;

    return jsonResponse({
      ok: true,
      jobs: (jobRows ?? []).map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        pullId: row.pull_id,
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
        reason: batchById.get(row.batch_id)?.reason ?? 'reanálisis defensivo pendiente',
        scope: batchById.get(row.batch_id)?.scope ?? {},
      })),
      blockedCount: blockedCount ?? 0,
      maxAttempts: DEFENSIVE_REANALYSIS_MAX_ATTEMPTS,
    });
  } catch (err) {
    console.error('defensive-reanalysis-queue error:', err);
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
