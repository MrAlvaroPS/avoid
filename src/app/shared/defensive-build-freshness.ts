import type { DefensiveResolutionConfidence } from './models/domain';

export type DefensiveBuildFreshness = 'fresh_verified' | 'inferred' | 'stale' | 'unknown';

export const DEFENSIVE_BUILD_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export function defensiveBuildFreshness(input: {
  gameBuild: string | null;
  fingerprint: string | null;
  observedAt: string | null;
  confidence: DefensiveResolutionConfidence | null;
  nowMs?: number;
}): DefensiveBuildFreshness {
  if (!input.gameBuild || !input.fingerprint || !input.observedAt) return 'unknown';
  const observedAtMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAtMs)) return 'unknown';
  if ((input.nowMs ?? Date.now()) - observedAtMs > DEFENSIVE_BUILD_STALE_AFTER_MS) return 'stale';
  if (input.confidence === 'verified') return 'fresh_verified';
  if (input.confidence === 'inferred') return 'inferred';
  return 'unknown';
}
