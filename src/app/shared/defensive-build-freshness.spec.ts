import { describe, expect, it } from 'vitest';
import { defensiveBuildFreshness } from './defensive-build-freshness';

const NOW = Date.parse('2026-09-01T10:00:00.000Z');

describe('defensiveBuildFreshness', () => {
  it('requires build, fingerprint and observation', () => {
    expect(defensiveBuildFreshness({ gameBuild: null, fingerprint: null, observedAt: null, confidence: 'uncertain', nowMs: NOW })).toBe('unknown');
  });

  it('distinguishes verified, inferred and stale observations', () => {
    expect(defensiveBuildFreshness({ gameBuild: '11.2.0.1', fingerprint: 'sha256:x', observedAt: '2026-08-31T10:00:00.000Z', confidence: 'verified', nowMs: NOW })).toBe('fresh_verified');
    expect(defensiveBuildFreshness({ gameBuild: '11.2.0.1', fingerprint: 'sha256:x', observedAt: '2026-08-31T10:00:00.000Z', confidence: 'inferred', nowMs: NOW })).toBe('inferred');
    expect(defensiveBuildFreshness({ gameBuild: '11.2.0.1', fingerprint: 'sha256:x', observedAt: '2026-08-31T10:00:00.000Z', confidence: 'uncertain', nowMs: NOW })).toBe('unknown');
    expect(defensiveBuildFreshness({ gameBuild: '11.2.0.1', fingerprint: 'sha256:x', observedAt: '2026-08-01T10:00:00.000Z', confidence: 'verified', nowMs: NOW })).toBe('stale');
  });
});
