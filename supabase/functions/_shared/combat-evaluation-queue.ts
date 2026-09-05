export type CombatEvaluationJobType =
  | 'pull_context'
  | 'mechanic_policy'
  | 'mechanic_assignment'
  | 'consumable_policy'
  | 'full_execution_backfill';

export interface CombatQueueClient {
  rpc(name: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function enqueueCombatEvaluation(
  client: CombatQueueClient,
  params: {
    pullIds: string[];
    jobType: CombatEvaluationJobType;
    reason: string;
    scope?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    requestedBy?: string | null;
  },
): Promise<string | null> {
  const pullIds = [...new Set(params.pullIds.filter(Boolean))];
  if (!pullIds.length) return null;
  const { data, error } = await client.rpc('enqueue_combat_evaluation_jobs', {
    p_pull_ids: pullIds,
    p_job_type: params.jobType,
    p_reason: params.reason,
    p_scope: params.scope ?? {},
    p_payload: params.payload ?? {},
    p_requested_by: params.requestedBy ?? null,
  });
  if (error) throw new Error(error.message);
  if (typeof data !== 'string') throw new Error('La cola causal no devolvió batchId.');
  return data;
}
