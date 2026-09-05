import { describe, expect, it } from 'vitest';
import { defensiveReanalysisHealth } from '../../../supabase/functions/_shared/defensive-reanalysis-health';

describe('defensiveReanalysisHealth', () => {
  it('is healthy only when there is no unfinished work or error', () => {
    expect(defensiveReanalysisHealth({ queued: 0, running: 0, retryableErrors: 0, blockedErrors: 0 })).toBe('healthy');
  });

  it('is running while work is queued or claimed', () => {
    expect(defensiveReanalysisHealth({ queued: 2, running: 0, retryableErrors: 0, blockedErrors: 0 })).toBe('running');
    expect(defensiveReanalysisHealth({ queued: 0, running: 1, retryableErrors: 0, blockedErrors: 0 })).toBe('running');
  });

  it('keeps failures visible even if other work is still active', () => {
    expect(defensiveReanalysisHealth({ queued: 3, running: 1, retryableErrors: 1, blockedErrors: 0 })).toBe('failed');
    expect(defensiveReanalysisHealth({ queued: 0, running: 0, retryableErrors: 0, blockedErrors: 1 })).toBe('failed');
  });
});
