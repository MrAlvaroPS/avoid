export interface DefensiveReanalysisJobRef {
  id: string;
  pullId: string;
}

export const DEFENSIVE_REANALYSIS_MAX_ATTEMPTS = 3;
export const DEFENSIVE_REANALYSIS_STALE_RUNNING_MS = 15 * 60 * 1000;

export interface EnqueuedDefensiveReanalysis {
  batchId: string | null;
  jobs: DefensiveReanalysisJobRef[];
}

interface QueueClient {
  rpc(name: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
}

/** Crea batch+jobs en una sola transacción SQL y devuelve IDs para el cliente. */
export async function enqueueDefensiveReanalysis(
  supabase: QueueClient,
  params: {
    pullIds: string[];
    reason: string;
    scope?: Record<string, unknown>;
    requestedBy?: string | null;
  },
): Promise<EnqueuedDefensiveReanalysis> {
  const pullIds = [...new Set(params.pullIds.filter(Boolean))];
  if (!pullIds.length) return { batchId: null, jobs: [] };

  const { data: batchIdRaw, error: enqueueError } = await supabase.rpc('enqueue_defensive_reanalysis_batch', {
    p_pull_ids: pullIds,
    p_reason: params.reason,
    p_scope: params.scope ?? {},
    p_requested_by: params.requestedBy ?? null,
  });
  if (enqueueError) throw new Error(enqueueError.message);
  const batchId = typeof batchIdRaw === 'string' ? batchIdRaw : null;
  if (!batchId) throw new Error('La cola no devolvió batchId.');

  const { data, error } = await supabase.from('defensive_reanalysis_jobs').select('id,pull_id').eq('batch_id', batchId);
  if (error) throw new Error(error.message);
  const jobs = (data ?? [])
    .map((row) => row as { id?: unknown; pull_id?: unknown })
    .filter((row): row is { id: string; pull_id: string } => typeof row.id === 'string' && typeof row.pull_id === 'string')
    .map((row) => ({ id: row.id, pullId: row.pull_id }));
  if (jobs.length !== pullIds.length) throw new Error(`La cola creó ${jobs.length}/${pullIds.length} jobs.`);
  return { batchId, jobs };
}
