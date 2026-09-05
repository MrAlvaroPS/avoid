import { describe, expect, it } from 'vitest';
import { resolveEpisodeVerdict, type EpisodeVerdictCandidate } from './defensive-episode-verdict.ts';

function candidate(overrides: Partial<EpisodeVerdictCandidate> = {}): EpisodeVerdictCandidate {
  return {
    spellId: 1,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    materiallyUnresolved: false,
    damageApplicability: 'yes',
    temporalOpportunity: 'yes',
    temporalCastCoverage: 'no',
    engagement: false,
    statusAtPeak: 'available_unused',
    confidence: 'inferred',
    evidence: {},
    ...overrides,
  };
}

describe('E7 low-confidence punitive safety', () => {
  it('fallback-only ready strategic candidate fails closed to uncertain', () => {
    const result = resolveEpisodeVerdict([candidate({ confidence: 'fallback' })]);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.confidence).toBe('fallback');
    expect(result.uncertaintyBlockers).toEqual([1]);
  });

  it('uncertain-only ready strategic candidate fails closed to uncertain', () => {
    const result = resolveEpisodeVerdict([candidate({ confidence: 'uncertain' })]);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.confidence).toBe('uncertain');
  });

  it('trusted ready candidate wins independently of fallback ready candidate', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 1, confidence: 'fallback' }),
      candidate({ spellId: 2, confidence: 'inferred' }),
    ]);
    expect(result.responseVerdict).toBe('missed_ready');
    expect(result.confidence).toBe('inferred');
    expect(result.decisiveSpellIds).toEqual([2]);
  });

  it('fallback non-strategic utility does not block no_applicable_resource', () => {
    const result = resolveEpisodeVerdict([
      candidate({ isDefensiveKitMember: false, createsMissableOpportunity: false, confidence: 'fallback' }),
    ]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
  });
});
