import { describe, expect, it } from 'vitest';
import type {
  CanonicalDefensiveEpisodeView,
  NightCanonicalDefensiveSummary,
  NightPlayerSummary,
} from './night-player-summary.service';
import {
  buildRaiderEvidenceProjection,
  groupEquivalentCanonicalCoaching,
  type RaiderEvidenceItem,
} from './raider-evidence-projection';

function defensiveItem(overrides: Partial<RaiderEvidenceItem> = {}): RaiderEvidenceItem {
  return {
    id: 'defensive|canonical|episode-1',
    kind: 'defensive',
    pullId: 'pull-1',
    pullNumber: 1,
    bossId: 'boss-coiled',
    bossName: 'The Coiled Altar',
    difficulty: 'Mythic',
    atMs: 108_000,
    mechanicId: 1282408,
    mechanicName: 'Noxious Ground',
    title: 'Noxious Ground · CD disponible sin cubrir',
    verdict: 'confirmed_error',
    reasonCode: 'DEFENSIVE_READY_NOT_USED',
    observation:
      'Barkskin estaba disponible como respuesta válida para Noxious Ground, pero la ventana quedó sin cobertura.',
    whyItMatters: 'Noxious Ground crea áreas venenosas persistentes que deben abandonarse.',
    action: 'Usa Barkskin como respuesta a Noxious Ground.',
    preventionKey: 'No dejes Barkskin disponible sin usar en esta oportunidad.',
    mechanicDescription: null,
    resolutionText: 'Sal de las zonas venenosas en cuanto aparezcan.',
    defensives: [{ spellId: 22812, name: 'Barkskin', status: 'available_unused' }],
    confidence: 'verified',
    occurrences: [{ pullId: 'pull-1', pullNumber: 1, atMs: 108_000 }],
    provenance: [
      {
        source: 'player_pull_defensive_episode_evaluations',
        key: 'episode-1',
        version: 'verified',
      },
    ],
    priorityTier: 0,
    damageTotal: 0,
    ...overrides,
  };
}

function episode(
  episodeId: string,
  pullId: string,
  pullNumber: number,
  peakMs: number,
  overrides: Partial<CanonicalDefensiveEpisodeView> = {},
): CanonicalDefensiveEpisodeView {
  return {
    episodeId,
    causalGroupId: `group-${episodeId}`,
    pullId,
    pullNumber,
    bossId: 'boss-coiled',
    bossName: 'The Coiled Altar',
    difficulty: 'Mythic',
    startMs: peakMs - 1_000,
    peakMs,
    endMs: peakMs + 1_000,
    dominantAbilityGameId: 1282408,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [],
    responseVerdict: 'missed_ready',
    responseReason: 'Barkskin estaba disponible con evidencia suficiente.',
    coveredBySpellId: null,
    decisiveSpellIds: [22812],
    planAssignmentId: null,
    planVerdict: null,
    confidence: 'verified',
    mechanicName: 'Noxious Ground',
    mechanicDescription: 'Noxious Ground crea áreas venenosas persistentes que deben abandonarse.',
    mechanicResolution: 'Sal de las zonas venenosas en cuanto aparezcan.',
    ...overrides,
  };
}

function canonical(episodes: CanonicalDefensiveEpisodeView[]): NightCanonicalDefensiveSummary {
  return {
    state: 'available',
    coverage: { evaluatedPulls: episodes.length, expectedPulls: episodes.length },
    usage: {
      status: 'available',
      score: 0,
      engaged: 0,
      evaluable: episodes.length,
    },
    response: {
      status: 'available',
      score: 0,
      covered: 0,
      evaluable: episodes.length,
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
      usage: { status: 'available', score: 0, engaged: 0, evaluable: episodes.length },
      response: {
        status: 'available',
        score: 0,
        covered: 0,
        evaluable: episodes.length,
        missedReady: episodes.filter((row) => row.responseVerdict === 'missed_ready').length,
        missedMistimed: episodes.filter((row) => row.responseVerdict === 'missed_due_to_mistime').length,
      },
      rowsExpected: episodes.length,
      rowsFound: episodes.length,
    },
  };
}

function summary(episodes: CanonicalDefensiveEpisodeView[]): NightPlayerSummary {
  return {
    playerName: 'Gusmï',
    reportCode: 'fixture-report',
    pulls: episodes.map((row) => ({
      pullId: row.pullId,
      pullNumber: row.pullNumber,
      bossId: row.bossId,
      bossName: row.bossName,
      difficulty: row.difficulty,
      pullScore: 0.5,
      scoreBreakdown: { mechanicFailCount: 0, died: false },
    })),
    defensiveManagementV2: null,
    defensiveSummary: { mechanicPressureBreakdown: [] },
    deaths: [],
    mechanicFails: [],
    startingPreparation: null,
  } as unknown as NightPlayerSummary;
}

describe('RaiderEvidenceProjection · repeated coaching grouping', () => {
  it('agrupa coaching canónico equivalente y conserva todas las ocurrencias/provenance', () => {
    const first = defensiveItem();
    const second = defensiveItem({
      id: 'defensive|canonical|episode-2',
      pullId: 'pull-2',
      pullNumber: 2,
      atMs: 96_000,
      occurrences: [{ pullId: 'pull-2', pullNumber: 2, atMs: 96_000 }],
      provenance: [
        {
          source: 'player_pull_defensive_episode_evaluations',
          key: 'episode-2',
          version: 'verified',
        },
      ],
    });

    const grouped = groupEquivalentCanonicalCoaching([first, second]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].title).toBe('Noxious Ground · CD disponible sin cubrir ×2');
    expect(grouped[0].observation).toContain('También en P2 1:36.');
    expect(grouped[0].occurrences).toEqual([
      { pullId: 'pull-1', pullNumber: 1, atMs: 108_000 },
      { pullId: 'pull-2', pullNumber: 2, atMs: 96_000 },
    ]);
    expect(grouped[0].provenance.map((row) => row.key)).toEqual(['episode-1', 'episode-2']);
  });

  it('no mezcla missed_ready con mistime ni defensivos decisivos distintos', () => {
    const ready = defensiveItem();
    const mistimed = defensiveItem({
      id: 'defensive|canonical|episode-2',
      reasonCode: 'DEFENSIVE_MISTIMED',
      title: 'Noxious Ground · Mal timing demostrado',
      observation: 'El uso de Barkskin no mantuvo cobertura en el momento decisivo de Noxious Ground.',
      action: 'Ajusta el timing de Barkskin para que coincida con Noxious Ground.',
      preventionKey: 'Alinea Barkskin con el momento decisivo de la ventana.',
      defensives: [{ spellId: 22812, name: 'Barkskin', status: 'used' }],
      occurrences: [{ pullId: 'pull-2', pullNumber: 2, atMs: 96_000 }],
      provenance: [
        {
          source: 'player_pull_defensive_episode_evaluations',
          key: 'episode-2',
          version: 'verified',
        },
      ],
    });
    const frenzy = defensiveItem({
      id: 'defensive|canonical|episode-3',
      defensives: [{ spellId: 22842, name: 'Frenzied Regeneration', status: 'available_unused' }],
      observation:
        'Frenzied Regeneration estaba disponible como respuesta válida para Noxious Ground, pero la ventana quedó sin cobertura.',
      action: 'Usa Frenzied Regeneration como respuesta a Noxious Ground.',
      preventionKey: 'No dejes Frenzied Regeneration disponible sin usar en esta oportunidad.',
      occurrences: [{ pullId: 'pull-3', pullNumber: 3, atMs: 90_000 }],
      provenance: [
        {
          source: 'player_pull_defensive_episode_evaluations',
          key: 'episode-3',
          version: 'verified',
        },
      ],
    });

    expect(groupEquivalentCanonicalCoaching([ready, mistimed, frenzy])).toHaveLength(3);
  });

  it('limita el resumen visual sin destruir las ocurrencias restantes', () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      defensiveItem({
        id: `defensive|canonical|episode-${index + 1}`,
        pullId: `pull-${index + 1}`,
        pullNumber: index + 1,
        atMs: 90_000 + index * 1_000,
        occurrences: [
          { pullId: `pull-${index + 1}`, pullNumber: index + 1, atMs: 90_000 + index * 1_000 },
        ],
        provenance: [
          {
            source: 'player_pull_defensive_episode_evaluations',
            key: `episode-${index + 1}`,
            version: 'verified',
          },
        ],
      }),
    );

    const [grouped] = groupEquivalentCanonicalCoaching(items);
    expect(grouped.title).toContain('×7');
    expect(grouped.occurrences).toHaveLength(7);
    expect(grouped.provenance).toHaveLength(7);
    expect(grouped.observation).toContain('+1 más');
  });

  it('agrupa antes del Top 4 pero mantiene items/timeline por pull sin pérdida de granularidad', () => {
    const episodes = [
      episode('episode-1', 'pull-1', 1, 108_000),
      episode('episode-2', 'pull-2', 2, 96_000),
    ];
    const projection = buildRaiderEvidenceProjection(summary(episodes), {
      defensiveManagementV2: null,
      canonicalDefensive: canonical(episodes),
      spellNameById: new Map([[22812, 'Barkskin']]),
    });

    expect(projection.items.filter((row) => row.kind === 'defensive')).toHaveLength(2);
    expect(projection.coaching).toHaveLength(1);
    expect(projection.coaching[0].title).toContain('×2');
    expect(projection.coaching[0].occurrences).toHaveLength(2);
    expect(projection.additionalCoachingCount).toBe(0);
    expect(projection.timeline).toHaveLength(2);
    expect(projection.timeline.every((row) => row.state === 'confirmed_error')).toBe(true);
  });

  it('las mecánicas ya agrupadas muestran también dónde se repitieron', () => {
    const baseSummary = summary([episode('unused', 'pull-1', 1, 1)]);
    baseSummary.pulls = [
      {
        pullId: 'pull-1',
        pullNumber: 1,
        bossId: 'boss-coiled',
        bossName: 'The Coiled Altar',
        difficulty: 'Mythic',
        pullScore: 0.5,
        scoreBreakdown: { mechanicFailCount: 1, died: false },
      },
      {
        pullId: 'pull-2',
        pullNumber: 2,
        bossId: 'boss-coiled',
        bossName: 'The Coiled Altar',
        difficulty: 'Mythic',
        pullScore: 0.5,
        scoreBreakdown: { mechanicFailCount: 1, died: false },
      },
    ] as NightPlayerSummary['pulls'];
    baseSummary.mechanicFails = [
      {
        pullId: 'pull-1',
        bossId: 'boss-coiled',
        bossName: 'The Coiled Altar',
        difficulty: 'Mythic',
        pullNumber: 1,
        mechanicName: 'Axegrinder',
        mechanicId: 900010,
        category: 'avoidable-ground',
        responsibility: 'personal',
        outcome: 'fail',
        timeMs: 69_000,
        damageTaken: 100_000,
        aiNote: 'Las hachas recorren la sala.',
        comparisonSource: 'fixed_threshold',
        comparisonPercentile: null,
        resolution: 'Esquiva los puntos de impacto y no cruces la trayectoria de las hachas.',
      },
      {
        pullId: 'pull-2',
        bossId: 'boss-coiled',
        bossName: 'The Coiled Altar',
        difficulty: 'Mythic',
        pullNumber: 2,
        mechanicName: 'Axegrinder',
        mechanicId: 900010,
        category: 'avoidable-ground',
        responsibility: 'personal',
        outcome: 'fail',
        timeMs: 96_000,
        damageTaken: 120_000,
        aiNote: 'Las hachas recorren la sala.',
        comparisonSource: 'fixed_threshold',
        comparisonPercentile: null,
        resolution: 'Esquiva los puntos de impacto y no cruces la trayectoria de las hachas.',
      },
    ];

    const projection = buildRaiderEvidenceProjection(baseSummary, {
      defensiveManagementV2: null,
      canonicalDefensive: canonical([]),
    });
    const mechanic = projection.items.find((row) => row.kind === 'mechanic');
    expect(mechanic?.title).toBe('Axegrinder ×2');
    expect(mechanic?.occurrences).toHaveLength(2);
    expect(mechanic?.observation).toContain('También en P2 1:36.');
  });
});
