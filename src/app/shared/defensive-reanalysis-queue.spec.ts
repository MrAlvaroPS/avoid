import { describe, expect, it, vi } from 'vitest';
import { enqueueDefensiveReanalysis } from '../../../supabase/functions/_shared/defensive-reanalysis-queue';

function queueClient(options: {
  batchId?: string | null;
  rpcError?: string | null;
  jobs?: { id: string; pull_id: string }[];
  jobsError?: string | null;
} = {}) {
  const eq = vi.fn().mockResolvedValue({
    data: options.jobs ?? [],
    error: options.jobsError ? { message: options.jobsError } : null,
  });
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn().mockResolvedValue({
    data: options.batchId === undefined ? 'batch-1' : options.batchId,
    error: options.rpcError ? { message: options.rpcError } : null,
  });

  return { client: { rpc, from }, rpc, from, select, eq };
}

describe('enqueueDefensiveReanalysis', () => {
  it('does not create an empty batch', async () => {
    const mock = queueClient();

    await expect(
      enqueueDefensiveReanalysis(mock.client, { pullIds: [], reason: 'catalog_edit' }),
    ).resolves.toEqual({ batchId: null, jobs: [] });
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('deduplicates pulls and returns the durable job IDs', async () => {
    const mock = queueClient({
      jobs: [
        { id: 'job-1', pull_id: 'pull-1' },
        { id: 'job-2', pull_id: 'pull-2' },
      ],
    });

    await expect(
      enqueueDefensiveReanalysis(mock.client, {
        pullIds: ['pull-1', 'pull-1', 'pull-2'],
        reason: 'catalog_edit',
        scope: { class: 'Monk' },
        requestedBy: 'officer-1',
      }),
    ).resolves.toEqual({
      batchId: 'batch-1',
      jobs: [
        { id: 'job-1', pullId: 'pull-1' },
        { id: 'job-2', pullId: 'pull-2' },
      ],
    });
    expect(mock.rpc).toHaveBeenCalledWith('enqueue_defensive_reanalysis_batch', {
      p_pull_ids: ['pull-1', 'pull-2'],
      p_reason: 'catalog_edit',
      p_scope: { class: 'Monk' },
      p_requested_by: 'officer-1',
    });
    expect(mock.from).toHaveBeenCalledWith('defensive_reanalysis_jobs');
    expect(mock.eq).toHaveBeenCalledWith('batch_id', 'batch-1');
  });

  it('surfaces a transactional enqueue error', async () => {
    const mock = queueClient({ rpcError: 'foreign key violation' });

    await expect(
      enqueueDefensiveReanalysis(mock.client, { pullIds: ['pull-1'], reason: 'catalog_edit' }),
    ).rejects.toThrow('foreign key violation');
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('rejects an incomplete job set instead of silently losing pulls', async () => {
    const mock = queueClient({ jobs: [{ id: 'job-1', pull_id: 'pull-1' }] });

    await expect(
      enqueueDefensiveReanalysis(mock.client, {
        pullIds: ['pull-1', 'pull-2'],
        reason: 'catalog_edit',
      }),
    ).rejects.toThrow('La cola creó 1/2 jobs.');
  });
});
