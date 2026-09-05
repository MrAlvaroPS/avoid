import { describe, expect, it } from 'vitest';
import type {
  CanonicalDefensiveEpisodeView,
  NightCanonicalDefensiveSummary,
  NightPlayerSummary,
} from './night-player-summary.service';
import { buildRaiderEvidenceProjection } from './raider-evidence-projection';

function episode(overrides: Partial<CanonicalDefensiveEpisodeView> = {}): CanonicalDefensiveEpisodeView {
  return {
    episodeId: 'episode-1',
    causalGroupId: 'group-1',
    pullId: 'pull-1',
    pullNumber: 1,
    bossId: 'boss-1',
    bossName: "Nek'zali the Soulcoiler",
    difficulty: 'Heroic',
    startMs: 34_000,
    peakMs: 35_000,
    endMs: 36_000,
    dominantAbilityGameId: 1288772,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [],
    responseVerdict: 'missed_ready',
    responseReason: 'spellId 22812 estaba disponible con evidencia suficiente; no hubo respuesta defensiva.',
    coveredBySpellId: null,
    decisiveSpellIds: [22812],
    planAssignmentId: null,
    planVerdict: null,
    confidence: 'inferred',
    mechanicName: 'Necrotic Bolt',
    mechanicDescription: null,
    mechanicResolution: null,
    ...overrides,
  };
}

function canonical(episodes: CanonicalDefensiveEpisodeView[]): NightCanonicalDefensiveSummary {
  return {
    state: 'available',
    coverage: { evaluatedPulls: 1, expectedPulls: 1 },
    usage: { status: 'available', score: 0, engaged: 0, evaluable: 1 },
    response: {
      status: 'available',
      score: 0,
      covered: 0,
      evaluable: 1,
      missedReady: episodes.filter((row) => row.responseVerdict === 'missed_ready').length,
      missedMistimed: episodes.filter((row) => row.responseVerdict === 'missed_due_to_mistime').length,
    },
    management: { status: 'no_plan', score: null, fulfilled: 0, evaluable: 0 },
    context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 0, excluded: 0 },
    totalEpisodes: episodes.length,
    episodes,
    generation: null,
    integrityIssues: [],
    diagnostics: {
      usage: { status: 'available', score: 0, engaged: 0, evaluable: 1 },
      response: {
        status: 'available',
        score: 0,
        covered: 0,
        evaluable: 1,
        missedReady: episodes.filter((row) => row.responseVerdict === 'missed_ready').length,
        missedMistimed: episodes.filter((row) => row.responseVerdict === 'missed_due_to_mistime').length,
      },
      rowsExpected: 1,
      rowsFound: 1,
    },
  };
}

function summary(): NightPlayerSummary {
  return {
    playerName: 'Gusmï',
    reportCode: '7GbANtw1J2pjZzH9',
    pulls: [
      {
        pullId: 'pull-1',
        pullNumber: 1,
        bossId: 'boss-1',
        bossName: "Nek'zali the Soulcoiler",
        difficulty: 'Heroic',
        pullScore: 0.63,
        scoreBreakdown: { mechanicFailCount: 0, died: false },
      },
    ],
    defensiveManagementV2: null,
    deaths: [],
    mechanicFails: [],
    startingPreparation: null,
  } as unknown as NightPlayerSummary;
}

describe('RaiderEvidenceProjection · canonical defensive coaching details', () => {
  it('publica el spell decisivo de missed_ready como disponible sin usar y conserva el spellId para su icono', () => {
    const projection = buildRaiderEvidenceProjection(summary(), {
      defensiveManagementV2: null,
      canonicalDefensive: canonical([
        episode({
          // Caso realista: el mismo spell puede aparecer en usedSpellIds por un cast dentro del episodio,
          // pero el verdict demuestra que estaba available_unused en el instante decisivo. No duplicar chips.
          usageEngaged: true,
          usedSpellIds: [22812],
        }),
      ]),
      spellNameById: new Map([[22812, 'Barkskin']]),
    });

    const item = projection.items.find((row) => row.id === 'defensive|canonical|episode-1');
    expect(item).toBeDefined();
    expect(item?.defensives).toEqual([
      { spellId: 22812, name: 'Barkskin', status: 'available_unused' },
    ]);
    expect(item?.observation).toContain('Barkskin');
    expect(item?.whyItMatters).toContain('Barkskin');
    expect(item?.whyItMatters).not.toContain('No hay una inferencia adicional publicable');
    expect(item?.preventionKey).toContain('Barkskin');
  });

  it('no inventa un spell recomendado si un missed_ready corrupto llega sin decisiveSpellIds', () => {
    const projection = buildRaiderEvidenceProjection(summary(), {
      defensiveManagementV2: null,
      canonicalDefensive: canonical([episode({ decisiveSpellIds: [] })]),
      spellNameById: new Map([[22812, 'Barkskin']]),
    });

    const item = projection.items.find((row) => row.id === 'defensive|canonical|episode-1');
    expect(item?.defensives).toEqual([]);
    expect(item?.whyItMatters).toContain('respuesta defensiva aplicable y disponible');
  });

  it('para missed_due_to_mistime conserva el spell decisivo como usado y explica el fallo temporal', () => {
    const projection = buildRaiderEvidenceProjection(summary(), {
      defensiveManagementV2: null,
      canonicalDefensive: canonical([
        episode({
          responseVerdict: 'missed_due_to_mistime',
          decisiveSpellIds: [22812],
          usedSpellIds: [22812],
          usageEngaged: true,
        }),
      ]),
      spellNameById: new Map([[22812, 'Barkskin']]),
    });

    const item = projection.items.find((row) => row.id === 'defensive|canonical|episode-1');
    expect(item?.defensives).toEqual([{ spellId: 22812, name: 'Barkskin', status: 'used' }]);
    expect(item?.title).toBe('Mal timing demostrado');
    expect(item?.whyItMatters).toContain('fallo de timing');
  });
});
