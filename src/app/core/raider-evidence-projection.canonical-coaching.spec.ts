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

function summary(overrides: Partial<NightPlayerSummary> = {}): NightPlayerSummary {
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
    ...overrides,
  } as unknown as NightPlayerSummary;
}

function mechanicPressureMetadata(overrides: Record<string, unknown> = {}) {
  return {
    mechanicId: 1288772,
    mechanicName: 'Soulcoil Rite',
    bossId: 'boss-1',
    bossName: "Nek'zali the Soulcoiler",
    difficulty: 'Heroic',
    timingPattern: null,
    occurrences: [],
    coveredCount: 0,
    totalCount: 1,
    defensives: [],
    aiNote:
      'Soulcoil Rite daña a toda la raid y deja un DoT prolongado que acumula; parte de sus aplicaciones son guionizadas.',
    resolution:
      'Sana las aplicaciones guionizadas y evita stacks extra; en fase 2 cada Invoke incrementa la presión.',
    ...overrides,
  };
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
    expect(item?.title).toContain('Mal timing demostrado');
    expect(item?.whyItMatters).toContain('fallo de timing');
  });

  it('recupera nombre, contexto y resolución por boss+dificultad+abilityId sin tocar el verdict canónico', () => {
    const projection = buildRaiderEvidenceProjection(
      summary({
        defensiveSummary: {
          mechanicPressureBreakdown: [mechanicPressureMetadata()],
        } as NightPlayerSummary['defensiveSummary'],
      }),
      {
        defensiveManagementV2: null,
        canonicalDefensive: canonical([
          episode({
            mechanicName: null,
            mechanicDescription: null,
            mechanicResolution: null,
          }),
        ]),
        spellNameById: new Map([[22812, 'Barkskin']]),
      },
    );

    const item = projection.items.find((row) => row.id === 'defensive|canonical|episode-1');
    expect(item?.mechanicName).toBe('Soulcoil Rite');
    expect(item?.title).toBe('Soulcoil Rite · CD disponible sin cubrir');
    expect(item?.whyItMatters).toContain('Soulcoil Rite daña a toda la raid');
    expect(item?.whyItMatters).not.toContain('IRIS verificó que Barkskin');
    expect(item?.resolutionText).toContain('Sana las aplicaciones guionizadas');
    expect(item?.preventionKey).toContain('Barkskin');
    expect(item?.reasonCode).toBe('DEFENSIVE_READY_NOT_USED');
    // La descripción se consume en "Qué sabemos" y no se duplica bajo el boss de la misma card.
    expect(item?.mechanicDescription).toBeNull();
  });

  it('si hay resolución revisada pero no nota, mantiene la táctica en Cómo resolver y no la sustituye por el defensivo', () => {
    const projection = buildRaiderEvidenceProjection(
      summary({
        defensiveSummary: {
          mechanicPressureBreakdown: [
            mechanicPressureMetadata({
              mechanicId: 1281925,
              mechanicName: 'Plague Froth',
              aiNote: null,
              resolution: 'Los objetivos se separan y orientan las líneas lejos de la raid.',
            }),
          ],
        } as NightPlayerSummary['defensiveSummary'],
      }),
      {
        defensiveManagementV2: null,
        canonicalDefensive: canonical([
          episode({
            dominantAbilityGameId: 1281925,
            mechanicName: null,
            mechanicDescription: null,
            mechanicResolution: null,
          }),
        ]),
        spellNameById: new Map([[22812, 'Barkskin']]),
      },
    );

    const item = projection.items.find((row) => row.id === 'defensive|canonical|episode-1');
    expect(item?.mechanicName).toBe('Plague Froth');
    expect(item?.whyItMatters).toContain('Plague Froth tiene una resolución táctica revisada');
  expect(item?.whyItMatters).toContain('Los objetivos se separan');
  expect(item?.resolutionText).toBe('Los objetivos se separan y orientan las líneas lejos de la raid.');
  expect(item?.resolutionText).not.toContain('Barkskin');
  expect(item?.preventionKey).toContain('Barkskin');
  });

  it('no hace fallback por nombre/timing si boss+dificultad+abilityId no coinciden exactamente', () => {
    const projection = buildRaiderEvidenceProjection(
      summary({
        defensiveSummary: {
          mechanicPressureBreakdown: [mechanicPressureMetadata({ difficulty: 'Normal' })],
        } as NightPlayerSummary['defensiveSummary'],
      }),
      {
        defensiveManagementV2: null,
        canonicalDefensive: canonical([
          episode({
            mechanicName: null,
            mechanicDescription: null,
            mechanicResolution: null,
          }),
        ]),
        spellNameById: new Map([[22812, 'Barkskin']]),
      },
    );

    const item = projection.items.find((row) => row.id === 'defensive|canonical|episode-1');
    expect(item?.mechanicName).toBeNull();
    expect(item?.title).toBe('CD disponible sin cubrir');
    expect(item?.whyItMatters).toContain('IRIS verificó que Barkskin');
  });

  it('reserva hasta dos huecos del top 4 para coaching no defensivo cuando existe', () => {
    const episodes = [1, 2, 3, 4].map((index) =>
      episode({ episodeId: `episode-${index}`, causalGroupId: `group-${index}`, peakMs: 30_000 + index }),
    );
    const projection = buildRaiderEvidenceProjection(
      summary({
        mechanicFails: [
          {
            pullId: 'pull-1',
            bossId: 'boss-1',
            bossName: "Nek'zali the Soulcoiler",
            difficulty: 'Heroic',
            pullNumber: 1,
            mechanicName: 'Avoidable One',
            mechanicId: 900001,
            category: 'avoidable-ground',
            outcome: 'fail',
            timeMs: 10_000,
            damageTaken: 100_000,
            aiNote: 'Sal de la zona.',
            comparisonSource: 'fixed_threshold',
            comparisonPercentile: null,
            resolution: 'Muévete fuera antes del impacto.',
          },
          {
            pullId: 'pull-1',
            bossId: 'boss-1',
            bossName: "Nek'zali the Soulcoiler",
            difficulty: 'Heroic',
            pullNumber: 1,
            mechanicName: 'Avoidable Two',
            mechanicId: 900002,
            category: 'spread',
            outcome: 'fail',
            timeMs: 20_000,
            damageTaken: 80_000,
            aiNote: 'Sepárate del grupo.',
            comparisonSource: 'fixed_threshold',
            comparisonPercentile: null,
            resolution: 'Mantén la separación asignada.',
          },
        ],
      }),
      {
        defensiveManagementV2: null,
        canonicalDefensive: canonical(episodes),
        spellNameById: new Map([[22812, 'Barkskin']]),
      },
    );

    expect(projection.coaching).toHaveLength(4);
    expect(projection.coaching.filter((item) => item.kind === 'defensive')).toHaveLength(2);
    expect(projection.coaching.filter((item) => item.kind === 'mechanic')).toHaveLength(2);
    expect(projection.additionalCoachingCount).toBe(2);
  });

  it('en una card puramente mecánica combina contexto + impacto y genera prevención desde la resolución revisada', () => {
  const projection = buildRaiderEvidenceProjection(
    summary({
      mechanicFails: [
        {
          pullId: 'pull-1',
          bossId: 'boss-1',
          bossName: 'The Coiled Altar',
          difficulty: 'Heroic',
          pullNumber: 1,
          mechanicName: 'Axegrinder',
          mechanicId: 900010,
          category: 'avoidable-ground',
          outcome: 'fail',
          timeMs: 69_000,
          damageTaken: 1_417_944,
          aiNote: 'Axegrinder lanza hachas que recorren la sala y se evitan por posicionamiento.',
          comparisonSource: 'fixed_threshold',
          comparisonPercentile: null,
          resolution: 'Esquiva los puntos de impacto y no cruces la trayectoria de las hachas que recorren la sala.',
        },
      ],
    }),
    { defensiveManagementV2: null, canonicalDefensive: canonical([]) },
  );

  const item = projection.items.find((row) => row.id === 'mechanic|boss-1|Heroic|900010');
  expect(item?.defensives).toEqual([]);
  expect(item?.whyItMatters).toContain('Axegrinder lanza hachas');
  expect(item?.whyItMatters).toContain('1.417.944 de daño');
  expect(item?.resolutionText).toContain('Esquiva los puntos de impacto');
  expect(item?.preventionKey).toContain('Esquiva los puntos de impacto');
  expect(item?.preventionKey).not.toBe('—');
});

  it('permite cuatro cards defensivas si realmente no existe otro coaching accionable', () => {
    const episodes = [1, 2, 3, 4, 5].map((index) =>
      episode({ episodeId: `episode-${index}`, causalGroupId: `group-${index}`, peakMs: 30_000 + index }),
    );
    const projection = buildRaiderEvidenceProjection(summary(), {
      defensiveManagementV2: null,
      canonicalDefensive: canonical(episodes),
      spellNameById: new Map([[22812, 'Barkskin']]),
    });

    expect(projection.coaching).toHaveLength(4);
    expect(projection.coaching.every((item) => item.kind === 'defensive')).toBe(true);
    expect(projection.additionalCoachingCount).toBe(1);
  });
});