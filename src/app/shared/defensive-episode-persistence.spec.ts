import { describe, expect, it } from 'vitest';
import {
  buildPersistedDefensiveEpisode,
  deriveUsageEvaluable,
} from '../../../supabase/functions/_shared/defensive-episode-persistence';
import { deriveEpisodeCausalGroupId, resolveDefensiveEpisodeId } from '../../../supabase/functions/_shared/defensive-episode-identity';
import type { EpisodeVerdictCandidate, EpisodeVerdictResult } from '../../../supabase/functions/_shared/defensive-episode-verdict';

function candidate(overrides: Partial<EpisodeVerdictCandidate> = {}): EpisodeVerdictCandidate {
  return {
    spellId: 22812,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    applicability: 'yes',
    usedDuringEpisode: false,
    statusAtPeak: 'available_unused',
    ...overrides,
  };
}

const missedReadyVerdict: EpisodeVerdictResult = {
  usageEngaged: false,
  usedSpellIds: [],
  responseVerdict: 'missed_ready',
  reason: 'spellId 22812 estaba disponible y su aplicabilidad está demostrada; no se usó.',
  coveredBySpellId: null,
};

describe('deriveUsageEvaluable', () => {
  it('true cuando hay al menos un miembro del kit, sin importar el responseVerdict', () => {
    expect(deriveUsageEvaluable('uncertain', [{ isDefensiveKitMember: true }])).toBe(true);
    expect(deriveUsageEvaluable('no_applicable_resource', [{ isDefensiveKitMember: true }])).toBe(true);
  });

  it('false cuando ningún candidato es miembro del kit (nada con lo que actuar)', () => {
    expect(deriveUsageEvaluable('no_applicable_resource', [{ isDefensiveKitMember: false }])).toBe(false);
    expect(deriveUsageEvaluable('missed_ready', [])).toBe(false);
  });

  it('false cuando el episodio está excluded, incluso si el kit tenía miembros (nunca cuenta para ningún KPI)', () => {
    expect(deriveUsageEvaluable('excluded', [{ isDefensiveKitMember: true }])).toBe(false);
  });
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

  it('usageEvaluable se deriva del mismo predicado que deriveUsageEvaluable (no una copia divergente)', () => {
    const result = buildPersistedDefensiveEpisode({
      pullId: 'pull-1',
      playerName: 'Gusmï',
      window,
      candidates: [candidate({ isDefensiveKitMember: true })],
      verdict: missedReadyVerdict,
      confidence: 'verified',
    });
    expect(result.usageEvaluable).toBe(true);
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

  it('la evidencia fusiona el contexto de ventana (occurrenceId/dominantAbility/memberIndexes) con evidencia extra del caller', () => {
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
