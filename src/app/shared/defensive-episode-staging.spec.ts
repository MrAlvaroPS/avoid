import { describe, expect, it } from 'vitest';
import {
  buildDefensiveEpisodeEvaluationRow,
  dbRecordToEpisodeEvaluationRow,
  episodeEvaluationRowToDbRecord,
  rollupDataConfidence,
} from '../../../supabase/functions/_shared/defensive-episode-staging';
import type { PersistedDefensiveEpisode } from '../../../supabase/functions/_shared/defensive-episode-persistence';

function episode(overrides: Partial<PersistedDefensiveEpisode> = {}): PersistedDefensiveEpisode {
  return {
    episodeId: 'heuristic:abc123',
    causalGroupId: '11111111-2222-4333-8444-555555555555',
    startMs: 10_000,
    peakMs: 11_000,
    endMs: 12_000,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [],
    responseVerdict: 'missed_ready',
    responseReason: 'spellId 22812 estaba disponible y su aplicabilidad está demostrada; no se usó.',
    coveredBySpellId: null,
    planAssignmentId: null,
    planVerdict: null,
    evidence: {},
    confidence: 'verified',
    ...overrides,
  };
}

describe('rollupDataConfidence', () => {
  it('uncertain cuando no hay episodios (sin evidencia de nada)', () => {
    expect(rollupDataConfidence([])).toBe('uncertain');
  });

  it('el confidence más débil entre los episodios, no el más fuerte ni un promedio', () => {
    expect(
      rollupDataConfidence([{ confidence: 'verified' }, { confidence: 'inferred' }, { confidence: 'verified' }]),
    ).toBe('inferred');
    expect(rollupDataConfidence([{ confidence: 'verified' }, { confidence: 'uncertain' }])).toBe('uncertain');
  });

  it('todos verified → verified', () => {
    expect(rollupDataConfidence([{ confidence: 'verified' }, { confidence: 'verified' }])).toBe('verified');
  });
});

describe('reconstrucción staging→ledger: round-trip de la fila completa', () => {
  it('build → toDbRecord → fromDbRecord reproduce exactamente la fila original (sin pérdida)', () => {
    const episodes = [
      episode({ episodeId: 'occ-1', responseVerdict: 'covered_verified', usageEngaged: true, usedSpellIds: [22812] }),
      episode({ episodeId: 'heuristic:def456', responseVerdict: 'uncertain', confidence: 'uncertain' }),
    ];
    const row = buildDefensiveEpisodeEvaluationRow({
      defensiveGenerationId: 'gen-1',
      pullId: 'pull-1',
      playerName: 'Gusmï',
      episodeEvaluatorVersion: 'episode-evaluator@1',
      semanticVersion: 'defensive-semantics@10',
      semanticResolverVersion: 'effective-defensive-semantics@1.0.0',
      resolverVersion: 'effective-defensives@2.1.0',
      buildFingerprint: 'fp-abc',
      episodes,
      evaluatedAt: '2026-09-04T00:00:00.000Z',
    });

    // Rollup calculado correctamente a partir de los episodios pasados.
    expect(row.dataConfidence).toBe('uncertain');

    const dbRecord = episodeEvaluationRowToDbRecord(row);
    expect(dbRecord.defensive_generation_id).toBe('gen-1');
    expect(dbRecord.pull_id).toBe('pull-1');
    expect(dbRecord.player_name).toBe('Gusmï');
    expect(dbRecord.episodes).toBe(episodes); // no clona, no transforma — persistible tal cual en jsonb

    const roundTripped = dbRecordToEpisodeEvaluationRow(dbRecord);
    expect(roundTripped).toEqual(row);
  });

  it('build sin buildFingerprint explícito degrada a null, no a undefined (jsonb-safe)', () => {
    const row = buildDefensiveEpisodeEvaluationRow({
      defensiveGenerationId: 'gen-1',
      pullId: 'pull-1',
      playerName: 'Gusmï',
      episodeEvaluatorVersion: 'episode-evaluator@1',
      semanticVersion: 'defensive-semantics@10',
      semanticResolverVersion: 'effective-defensive-semantics@1.0.0',
      resolverVersion: 'effective-defensives@2.1.0',
      episodes: [],
    });
    expect(row.buildFingerprint).toBeNull();
    expect(row.dataConfidence).toBe('uncertain'); // sin episodios, ver rollupDataConfidence
  });
});
