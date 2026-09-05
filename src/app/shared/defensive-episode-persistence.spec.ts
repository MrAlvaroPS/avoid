import { describe, expect, it } from 'vitest';
import {
  buildPersistedDefensiveEpisode,
  deriveUsageEvaluable,
} from '../../../supabase/functions/_shared/defensive-episode-persistence';
import { deriveEpisodeCausalGroupId, resolveDefensiveEpisodeId } from '../../../supabase/functions/_shared/defensive-episode-identity';
import type { EpisodeVerdictCandidate, EpisodeVerdictResult, ResponseVerdict } from '../../../supabase/functions/_shared/defensive-episode-verdict';

function candidate(overrides: Partial<EpisodeVerdictCandidate> = {}): EpisodeVerdictCandidate {
  return {
    spellId: 22812,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    materiallyUnresolved: false,
    damageApplicability: 'yes',
    temporalOpportunity: 'yes',
    temporalCastCoverage: 'yes',
    engagement: false,
    statusAtPeak: 'available_unused',
    confidence: 'verified',
    evidence: {},
    ...overrides,
  };
}

const missedReadyVerdict: EpisodeVerdictResult = {
  usageEngaged: false,
  usedSpellIds: [],
  responseVerdict: 'missed_ready',
  reason: 'spellId 22812 estaba disponible y su aplicabilidad de daño y su oportunidad temporal están demostradas; no se usó.',
  coveredBySpellId: null,
  confidence: 'verified',
  decisiveSpellIds: [22812],
  uncertaintyBlockers: [],
};

describe('deriveUsageEvaluable — canonical truth table (§E5/§13.1, test 35)', () => {
  const table: Array<[ResponseVerdict, boolean]> = [
    ['covered_verified', true],
    ['missed_ready', true],
    ['missed_due_to_mistime', true],
    ['unavailable_legitimate', false],
    ['no_applicable_resource', false],
    ['uncertain', false],
    ['excluded', false],
  ];

  for (const [verdict, expected] of table) {
    it(`${verdict} → usageEvaluable=${expected}`, () => {
      expect(deriveUsageEvaluable(verdict)).toBe(expected);
    });
  }
});

describe('buildPersistedDefensiveEpisode', () => {
  const window = {
    occurrenceId: null,
    dominantAbilityGameId: 22812,
    memberIndexes: [0],
    startMs: 10_000,
    peakMs: 11_000,
    endMs: 12_000,
  };

  it('ensambla episodeId/causalGroupId consistentes con defensive-episode-identity (misma función, sin reimplementar)', () => {
    const result = buildPersistedDefensiveEpisode({
      pullId: 'pull-1',
      playerName: 'Gusmï',
      window,
      candidates: [candidate({ statusAtPeak: 'available_unused' })],
      verdict: missedReadyVerdict,
      confidence: 'verified',
    });
    const expectedEpisodeId = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window);
    expect(result.episodeId).toBe(expectedEpisodeId);
    expect(result.causalGroupId).toBe(deriveEpisodeCausalGroupId(expectedEpisodeId));
  });

  it('copia usageEngaged/usedSpellIds/responseVerdict/responseReason/coveredBySpellId tal cual del veredicto — no reinterpreta nada', () => {
    const result = buildPersistedDefensiveEpisode({
      pullId: 'pull-1',
      playerName: 'Gusmï',
      window,
      candidates: [candidate({ statusAtPeak: 'available_unused' })],
      verdict: missedReadyVerdict,
      confidence: 'verified',
    });
    expect(result.usageEngaged).toBe(false);
    expect(result.usedSpellIds).toEqual([]);
    expect(result.responseVerdict).toBe('missed_ready');
    expect(result.responseReason).toBe(missedReadyVerdict.reason);
    expect(result.coveredBySpellId).toBeNull();
  });

  it('usageEvaluable se deriva del mismo predicado canónico que defensive-episode-kpis (no una copia divergente)', () => {
    const result = buildPersistedDefensiveEpisode({
      pullId: 'pull-1',
      playerName: 'Gusmï',
      window,
      candidates: [candidate({ isDefensiveKitMember: true })],
      verdict: missedReadyVerdict,
      confidence: 'verified',
    });
    expect(result.usageEvaluable).toBe(true);
    expect(result.usageEvaluable).toBe(deriveUsageEvaluable(missedReadyVerdict.responseVerdict));
  });

  it('planAssignmentId/planVerdict quedan null cuando no se pasan (Gestión todavía no tiene evaluator real)', () => {
    const result = buildPersistedDefensiveEpisode({
      pullId: 'pull-1',
      playerName: 'Gusmï',
      window,
      candidates: [candidate()],
      verdict: missedReadyVerdict,
      confidence: 'verified',
    });
    expect(result.planAssignmentId).toBeNull();
    expect(result.planVerdict).toBeNull();
  });

  it('conserva plan linkage explícito cuando se aporta', () => {
    const result = buildPersistedDefensiveEpisode({
      pullId: 'pull-1',
      playerName: 'Gusmï',
      window,
      candidates: [candidate()],
      verdict: missedReadyVerdict,
      confidence: 'verified',
      planAssignmentId: 'assignment-9',
      planVerdict: 'missed',
    });
    expect(result.planAssignmentId).toBe('assignment-9');
    expect(result.planVerdict).toBe('missed');
  });

  it('la evidencia fusiona el contexto de ventana (occurrenceId/dominantAbility/memberIndexes) + provenance de decisión con evidencia extra del caller', () => {
    const result = buildPersistedDefensiveEpisode({
      pullId: 'pull-1',
      playerName: 'Gusmï',
      window,
      candidates: [candidate()],
      verdict: missedReadyVerdict,
      confidence: 'verified',
      evidence: { groupingBasis: 'heuristic' },
    });
    expect(result.evidence['dominantAbilityGameId']).toBe(22812);
    expect(result.evidence['groupingBasis']).toBe('heuristic');
    expect(result.evidence['decisiveSpellIds']).toEqual([22812]);
    expect(result.evidence['uncertaintyBlockers']).toEqual([]);
  });

  it('conserva la ventana temporal completa (start/peak/end) sin alterarla', () => {
    const result = buildPersistedDefensiveEpisode({
      pullId: 'pull-1',
      playerName: 'Gusmï',
      window,
      candidates: [candidate()],
      verdict: missedReadyVerdict,
      confidence: 'verified',
    });
    expect(result.startMs).toBe(10_000);
    expect(result.peakMs).toBe(11_000);
    expect(result.endMs).toBe(12_000);
  });
});
