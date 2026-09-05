import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { NightPlayerPullLedgerService } from './night-player-pull-ledger.service';
import { errorMessage } from '../shared/error-message.util';

export type CausalOperatorJobType =
  | 'pull_context'
  | 'mechanic_policy'
  | 'mechanic_assignment'
  | 'consumable_policy'
  | 'full_execution_backfill';
export type CausalOperatorJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface CausalOperatorJob {
  pullId: string;
  jobType: CausalOperatorJobType;
  status: CausalOperatorJobStatus;
  attempts: number;
  maxAttempts: number;
  stageProgress: Record<string, unknown>;
  lastError: string | null;
  updatedAt: string;
}

export interface CausalMaterializationOperatorStatus {
  reportCode: string;
  playerName: string;
  targetPullIds: readonly string[];
  jobs: readonly CausalOperatorJob[];
  counts: {
    targetPulls: number;
    freshDone: number;
    queued: number;
    running: number;
    error: number;
    missingFullBackfill: number;
  };
}

export interface EnqueueCausalBackfillResult {
  ok: true;
  reportCode: string;
  playerName: string;
  targetPullCount: number;
  batchId: string | null;
  enqueuedPullIds: string[];
  alreadyCompletePullIds: string[];
  deferredPullIds: string[];
  blockedPullIds: string[];
  reasons: Record<string, string>;
}

export interface ProcessCausalQueueResult {
  ok: true;
  processed: boolean;
  reason?: string;
  jobId?: string;
  pullId?: string;
  stages?: Record<string, unknown>;
}

export interface ProcessCausalQueueBatchResult {
  iterations: number;
  processed: number;
  queueEmpty: boolean;
  lastPullId: string | null;
}

interface QueueRow {
  pull_id: string;
  job_type: CausalOperatorJobType;
  status: CausalOperatorJobStatus;
  attempts: number;
  max_attempts: number;
  stage_progress: Record<string, unknown> | null;
  last_error: string | null;
  updated_at: string;
}

@Injectable({ providedIn: 'root' })
export class CausalMaterializationOperatorService {
  private readonly supabase = inject(SupabaseService);
  private readonly pullLedger = inject(NightPlayerPullLedgerService);

  async status(reportCode: string, playerName: string): Promise<CausalMaterializationOperatorStatus> {
    const ledger = await this.pullLedger.load(reportCode, playerName);
    const targetPullIds = ledger.rows.map((row) => row.pull.pullId);
    if (!targetPullIds.length) {
      return {
        reportCode,
        playerName,
        targetPullIds,
        jobs: [],
        counts: { targetPulls: 0, freshDone: 0, queued: 0, running: 0, error: 0, missingFullBackfill: 0 },
      };
    }

    const { data, error } = await this.supabase.client
      .from('combat_evaluation_jobs')
      .select('pull_id,job_type,status,attempts,max_attempts,stage_progress,last_error,updated_at')
      .in('pull_id', targetPullIds);
    if (error) throw error;

    const jobs: CausalOperatorJob[] = ((data ?? []) as QueueRow[]).map((row) => ({
      pullId: row.pull_id,
      jobType: row.job_type,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      stageProgress: row.stage_progress ?? {},
      lastError: row.last_error,
      updatedAt: row.updated_at,
    }));

    const fullByPull = new Map(
      jobs
        .filter((job) => job.jobType === 'full_execution_backfill')
        .map((job) => [job.pullId, job] as const),
    );
    const freshDone = targetPullIds.filter((pullId) => fullByPull.get(pullId)?.status === 'done').length;

    return {
      reportCode,
      playerName,
      targetPullIds,
      jobs: jobs.sort((a, b) => a.pullId.localeCompare(b.pullId) || a.jobType.localeCompare(b.jobType)),
      counts: {
        targetPulls: targetPullIds.length,
        freshDone,
        queued: jobs.filter((job) => job.status === 'queued').length,
        running: jobs.filter((job) => job.status === 'running').length,
        error: jobs.filter((job) => job.status === 'error').length,
        missingFullBackfill: targetPullIds.filter((pullId) => !fullByPull.has(pullId)).length,
      },
    };
  }

  async enqueue(reportCode: string, playerName: string): Promise<EnqueueCausalBackfillResult> {
    const ledger = await this.pullLedger.load(reportCode, playerName);
    const pullIds = ledger.rows.map((row) => row.pull.pullId);
    if (!pullIds.length) {
      throw new Error('No hay pulls válidos participados para encolar.');
    }

    const { data, error } = await this.supabase.client.functions.invoke('enqueue-causal-backfill', {
      body: { reportCode, playerName, pullIds },
    });
    if (error) throw new Error(errorMessage(error, 'No se pudo encolar el backfill causal.'));
    if (!data?.ok) throw new Error(errorMessage(data?.error, 'El backfill causal fue rechazado.'));
    return data as EnqueueCausalBackfillResult;
  }

  async processNext(): Promise<ProcessCausalQueueResult> {
    const { data, error } = await this.supabase.client.functions.invoke('process-combat-evaluation-queue', {
      body: {},
    });
    if (error) throw new Error(errorMessage(error, 'No se pudo procesar la cola causal.'));
    if (!data?.ok) throw new Error(errorMessage(data?.error, 'La cola causal devolvió un error.'));
    return data as ProcessCausalQueueResult;
  }

  /**
   * Procesa un lote pequeño de la cola global ya existente. No crea workers ni
   * reimplementa stages; cada iteración es una invocación al processor canónico.
   */
  async processBatch(maxIterations = 10): Promise<ProcessCausalQueueBatchResult> {
    const bounded = Math.max(1, Math.min(20, Math.trunc(maxIterations)));
    let processed = 0;
    let iterations = 0;
    let queueEmpty = false;
    let lastPullId: string | null = null;

    for (; iterations < bounded; iterations += 1) {
      const result = await this.processNext();
      if (!result.processed) {
        queueEmpty = result.reason === 'queue_empty';
        iterations += 1;
        break;
      }
      processed += 1;
      lastPullId = result.pullId ?? lastPullId;
    }

    return { iterations, processed, queueEmpty, lastPullId };
  }
}
