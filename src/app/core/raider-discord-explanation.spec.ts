import { describe, expect, it } from 'vitest';
import type {
  CanonicalDefensiveEpisodeView,
  NightCanonicalDefensiveSummary,
  NightDeathRow,
  NightInterruptRow,
  NightMechanicFailRow,
  NightPlayerSummary,
  NightPullSummary,
} from './night-player-summary.service';
import { buildRaiderEvidenceProjection } from './raider-evidence-projection';
import { buildRaiderInfographicViewModel } from './raider-infographic-view-model';
import {
  DISCORD_MESSAGE_MAX_LENGTH,
  buildRaiderDiscordExplanation,
  sanitizeDiscordText,
} from './raider-discord-explanation';

function pull(pullId: string, pullNumber: number, overrides: Partial<NightPullSummary> = {}): NightPullSummary {
  return {
    pullId,
    pullNumber,
    fightId: pullNumber + 30,
    bossId: 'boss-1',
    bossName: "Nek'zali the Soulcoiler",
    difficulty: 'Heroic',
    kill: false,
    wipePct: 50,
    durationMs: 120_000,
    closedAt: '2026-09-05T20:00:00Z',
    died: false,
    excludedFromStats: false,
    excludedReason: null,
    hadWipeCall: false,
    worldRankPercent: null,
    pullScore: 0.63,
    scoreBreakdown: {
      mechanicFailCount: 0,
      mechanicScore: 1,
      avoidableMechanicEligibleCount: 0,
      avoidableMechanicFailCount: 0,
      died: false,
      usedConsumable: true,
      consumableScore: 1,
      deathMultiplier: 1,
      deathTimeMs: null,
      defensiveMissed: false,
      defensiveMissMultiplier: 1,
      defensiveMissKind: null,
      defensiveMissedWindows: [],
      unassignedMechanicSuccessCount: 0,
      unassignedMechanicBonus: 0,
    },
    ...overrides,
  };
}

function canonicalEpisode(overrides: Partial<CanonicalDefensiveEpisodeView> = {}): CanonicalDefensiveEpisodeView {
  return {
    episodeId: 'episode-1',
    causalGroupId: 'group-1',
    pullId: 'p1',
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
    responseReason: 'fixture',
    coveredBySpellId: null,
    decisiveSpellIds: [22812],
    planAssignmentId: null,
    planVerdict: null,
    confidence: 'verified',
    mechanicName: 'Soulcoil Rite',
    mechanicDescription: null,
    mechanicResolution: null,
    ...overrides,
  };
}

function canonical(overrides: Partial<NightCanonicalDefensiveSummary> = {}): NightCanonicalDefensiveSummary {
  return {
    state: 'available',
    coverage: { evaluatedPulls: 1, expectedPulls: 1 },
    usage: { status: 'insufficient_evidence', score: null, engaged: 0, evaluable: 0 },
    response: { status: 'insufficient_evidence', score: null, covered: 0, evaluable: 0, missedReady: 0, missedMistimed: 0 },
    management: { status: 'no_plan', score: null, fulfilled: 0, evaluable: 0 },
    context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 0, excluded: 0 },
    totalEpisodes: 0,
    episodes: [],
    generation: null,
    integrityIssues: [],
    diagnostics: {
      usage: { status: 'insufficient_evidence', engaged: 0, evaluable: 0, score: null },
      response: { status: 'insufficient_evidence', covered: 0, evaluable: 0, score: null, missedReady: 0, missedMistimed: 0 },
      rowsExpected: 0,
      rowsFound: 0,
    },
    ...overrides,
  };
}

function mechanicFail(overrides: Partial<NightMechanicFailRow> = {}): NightMechanicFailRow {
  return {
    pullId: 'p1',
    bossId: 'boss-2',
    bossName: 'The Coiled Altar',
    difficulty: 'Heroic',
    pullNumber: 1,
    mechanicName: 'Axegrinder',
    mechanicId: 9001,
    category: 'avoidable-ground',
    responsibility: 'personal',
    outcome: 'fail',
    timeMs: 69_000,
    damageTaken: 118_162,
    aiNote: null,
    comparisonSource: null,
    comparisonPercentile: null,
    resolution: null,
    ...overrides,
  };
}

function death(overrides: Partial<NightDeathRow> = {}): NightDeathRow {
  return {
    pullId: 'p1',
    bossId: 'boss-3',
    bossName: 'Sszorak',
    difficulty: 'Heroic',
    pullNumber: 2,
    timeMs: 161_000,
    mechanicName: 'Tempest',
    mechanicId: 4242,
    category: 'raid-damage',
    responsibility: 'raid',
    rootCause: 'unclassified',
    defensivesAvailable: [{ spellId: 123, name: 'Barkskin' }],
    isWipeCall: false,
    isNinjaPull: false,
    statisticalExclusionReason: null,
    usedHealthstoneInPull: false,
    usedHealthPotionInPull: false,
    aiNote: null,
    resolution: null,
    damageProfile: 'unknown',
    burstHealthPct: null,
    killingBlowAmount: null,
    damageWindowTotal: null,
    damageWindowHits: null,
    healingWindowTotal: null,
    healingWindowHits: null,
    ...overrides,
  };
}

function interrupt(overrides: Partial<NightInterruptRow> = {}): NightInterruptRow {
  return {
    pullId: 'p1',
    bossId: 'boss-1',
    bossName: "Nek'zali the Soulcoiler",
    difficulty: 'Heroic',
    pullNumber: 1,
    mechanicName: 'Void Bolt',
    mechanicId: 777,
    timeMs: 82_000,
    aiNote: null,
    ...overrides,
  };
}

function summary(pulls: NightPullSummary[], overrides: Partial<NightPlayerSummary> = {}): NightPlayerSummary {
  return {
    playerName: 'Gusmï',
    reportCode: '7GbANtw1J2pjZzH9',
    reportTitle: 'Raid nocturna',
    reportDate: '2026-09-05T20:00:00Z',
    roster: null,
    reliability: null,
    nightReliability: null,
    pulls,
    nightScore: 0.63,
    nightDefensiveConsistency: { missPullCount: 0, multiplier: 1, rawScore: 0.63 },
    totalDeaths: 0,
    totalMechanicFails: 0,
    deaths: [],
    mechanicFails: [],
    mechanicOffensesV3: [],
    interrupts: [],
    unassignedMechanicCredits: [],
    repeatedPatterns: [],
    gearSnapshot: null,
    startingPreparation: null,
    defensiveSummary: {
      totalCasts: 0,
      pullsWithCasts: 0,
      pressurePulls: pulls.length,
      pressurePullsWithCast: 0,
      deathsWithDefensiveAvailable: 0,
      spells: [],
      pressurePullBreakdown: [],
      mechanicPressureBreakdown: [],
    },
    defensiveManagementV2: null,
    canonicalDefensive: canonical(),
    execution: {
      evaluatedPulls: pulls.length,
      cleanPulls: pulls.length,
      cleanPullRate: 100,
      avoidableEligible: 0,
      avoidableFailed: 0,
      avoidableSucceeded: 0,
      avoidableSuccessRate: null,
      actionableIncidents: 0,
      actionableIncidentRatePer10: 0,
      deathRatePer10: 0,
      emergencyConsumableOpportunities: 0,
      emergencyConsumableUses: 0,
      emergencyConsumableUseRate: null,
    },
    evolution: null,
    battleNetUrl: null,
    raiderIoUrl: null,
    brief: null,
    discordChannel: null,
    ...overrides,
  };
}

function explanationFor(input: NightPlayerSummary, spellNameById: ReadonlyMap<number, string> = new Map()) {
  const projection = buildRaiderEvidenceProjection(input, {
    defensiveManagementV2: null,
    canonicalDefensive: input.canonicalDefensive,
    spellNameById,
  });
  const viewModel = buildRaiderInfographicViewModel(input, projection);
  return buildRaiderDiscordExplanation(input, projection, viewModel);
}

function lineContaining(body: string, needle: string): string {
  const line = body.split('\n').find((row) => row.includes(needle));
  expect(line, `expected a line containing "${needle}" in:\n${body}`).toBeDefined();
  return line!;
}

describe('buildRaiderDiscordExplanation', () => {
  it('A. Gusmï-shaped: Usage 5/20, Response 3/19, Management no_plan — sin confundir denominadores', () => {
    const input = summary([pull('p1', 1)], {
      canonicalDefensive: canonical({
        usage: { status: 'available', score: 25, engaged: 5, evaluable: 20 },
        response: { status: 'available', score: 15.79, covered: 3, evaluable: 19, missedReady: 14, missedMistimed: 2 },
        management: { status: 'no_plan', score: null, fulfilled: 0, evaluable: 0 },
        context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 4, excluded: 0 },
      }),
    });

    const explanation = explanationFor(input);

    const usageLine = lineContaining(explanation.body, 'Uso ');
    expect(usageLine).toContain('5/20');
    expect(usageLine).not.toContain('3/19');

    const responseLine = lineContaining(explanation.body, 'Respuesta ');
    expect(responseLine).toContain('3/19');
    expect(responseLine).not.toContain('5/20');

    const managementLine = lineContaining(explanation.body, 'Gestión');
    expect(managementLine).toContain('N/D');
    expect(managementLine).toContain('no existe plan defensivo canónico evaluable');
  });

  it('B. Tetasdivinas-shaped: 0/1 debe decir 0%, nunca N/D', () => {
    const input = summary([pull('p1', 1)], {
      canonicalDefensive: canonical({
        usage: { status: 'available', score: 0, engaged: 0, evaluable: 1 },
        response: { status: 'available', score: 0, covered: 0, evaluable: 1, missedReady: 1, missedMistimed: 0 },
      }),
    });

    const explanation = explanationFor(input);
    const usageLine = lineContaining(explanation.body, 'Uso ');
    expect(usageLine).toContain('0%');
    expect(usageLine).not.toContain('N/D');
  });

  it('C. uncertain nunca se llama "fallo"', () => {
    const input = summary([pull('p1', 1)], {
      canonicalDefensive: canonical({
        response: { status: 'available', score: 33.33, covered: 3, evaluable: 9, missedReady: 4, missedMistimed: 2 },
        context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 10, excluded: 0 },
      }),
    });

    const explanation = explanationFor(input);
    const responseLine = lineContaining(explanation.body, 'Respuesta ');
    expect(responseLine).toContain('10 episodios uncertain quedaron fuera del KPI');
    expect(responseLine.toLowerCase()).not.toContain('fallo');
  });

  it('D. missed_ready episode incluye boss, pull, fight, tiempo y el spell decisivo', () => {
    const input = summary([pull('p1', 1)], {
      canonicalDefensive: canonical({
        usage: { status: 'available', score: 0, engaged: 0, evaluable: 1 },
        response: { status: 'available', score: 0, covered: 0, evaluable: 1, missedReady: 1, missedMistimed: 0 },
        episodes: [canonicalEpisode()],
        totalEpisodes: 1,
      }),
    });

    const explanation = explanationFor(input, new Map([[22812, 'Barkskin']]));

    expect(explanation.body).toContain("Nek'zali");
    expect(explanation.body).toContain('P1');
    expect(explanation.body).toContain('(fight 31)');
    expect(explanation.body).toContain('0:35');
    expect(explanation.body).toContain('Barkskin');
  });

  it('E. mecánica Axegrinder agrupada explica incidencias/daño/resolución sin mencionar defensivos', () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      mechanicFail({ pullId: 'p1', timeMs: 69_000 + index * 1000, damageTaken: 118_162 }),
    );
    const input = summary([pull('p1', 1)], { mechanicFails: rows, totalMechanicFails: rows.length });

    const explanation = explanationFor(input);
    const mechanicLine = lineContaining(explanation.body, 'Axegrinder');

    // Mismo texto ya generado por groupMechanicFails (raider-evidence-projection.ts) — este builder lo
    // reutiliza tal cual, nunca lo reformula.
    expect(mechanicLine).toContain('12 exposici');
    expect(mechanicLine).toContain('1.417.944');
    expect(mechanicLine).toContain('de daño registrado');
    // El hallazgo de esta mecánica no debe etiquetarse como si fuera un fallo defensivo — eso vive en su
    // propia sección "Qué corregir" con sus propios episodios canónicos, nunca mezclado en la misma frase.
    expect(mechanicLine.toLowerCase()).not.toContain('defensiv');
  });

  it('F. un fallo de raid/tank sin resolución no aparece como fallo personal del jugador', () => {
    const raidRow = mechanicFail({
      mechanicName: 'Tank Swap Missed',
      mechanicId: 5555,
      category: null,
      responsibility: 'tank',
      resolution: null,
    });
    const input = summary([pull('p1', 1)], {
      mechanicFails: [raidRow],
      totalMechanicFails: 1,
    });

    const explanation = explanationFor(input);
    expect(explanation.body).not.toContain('Tank Swap Missed');
  });

  it('G. muerte con defensiveOptions legacy nunca afirma "tenías defensivo disponible"', () => {
    const deathRow = death();
    const input = summary([pull('p1', 2)], {
      deaths: [deathRow],
      totalDeaths: 1,
    });

    const explanation = explanationFor(input);
    expect(explanation.body).toContain('Sszorak');
    expect(explanation.body).toContain('Tempest');
    expect(explanation.body).not.toContain('Barkskin');
    expect(explanation.body.toLowerCase()).not.toContain('disponible');
  });

  it('H. dataset enorme respeta el presupuesto de caracteres y nunca corta a mitad de línea', () => {
    const pulls = Array.from({ length: 20 }, (_, index) => pull(`p${index + 1}`, index + 1));
    const mechanicRows = Array.from({ length: 40 }, (_, index) =>
      mechanicFail({
        pullId: `p${(index % 20) + 1}`,
        bossId: `boss-extra-${index}`,
        bossName: `Boss extra ${index}`,
        mechanicName: `Mecánica ${index}`,
        mechanicId: 10_000 + index,
        timeMs: 10_000 + index * 500,
        damageTaken: 50_000 + index,
        resolution: `Resuelve la mecánica ${index} moviéndote a la zona segura marcada por IRIS.`,
      }),
    );
    const deaths = Array.from({ length: 6 }, (_, index) =>
      death({ pullId: `p${index + 1}`, timeMs: 90_000 + index * 1000, mechanicName: `Causa ${index}`, mechanicId: 20_000 + index }),
    );
    const interrupts = Array.from({ length: 5 }, (_, index) => interrupt({ pullId: `p${index + 1}`, timeMs: 40_000 + index * 500 }));
    const input = summary(pulls, {
      mechanicFails: mechanicRows,
      totalMechanicFails: mechanicRows.length,
      deaths,
      totalDeaths: deaths.length,
      interrupts,
      canonicalDefensive: canonical({
        usage: { status: 'available', score: 25, engaged: 5, evaluable: 20 },
        response: { status: 'available', score: 15.79, covered: 3, evaluable: 19, missedReady: 14, missedMistimed: 2 },
      }),
    });

    const explanation = explanationFor(input);

    expect(explanation.spoilerContent.length).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_LENGTH);
    expect(explanation.omittedFactCount).toBeGreaterThan(0);
    expect(explanation.body).toContain('hechos adicionales permanecen en el dosier');
    // Nunca termina a mitad de frase: la última línea no vacía es la nota de "+N hechos..." o una frase completa.
    const lastLine = explanation.body.trimEnd().split('\n').pop()!;
    expect(lastLine.trim().endsWith('.')).toBe(true);
  });

  it('I. un input con "||" no rompe el spoiler exterior y nunca contiene triple-backtick', () => {
    const input = summary([pull('p1', 1)], {
      playerName: 'Gus||mï',
      mechanicFails: [mechanicFail({ bossName: 'Boss||Malicioso', mechanicName: 'Nombre||Roto' })],
      totalMechanicFails: 1,
    });

    const explanation = explanationFor(input);

    expect(explanation.spoilerContent.startsWith('||')).toBe(true);
    expect(explanation.spoilerContent.startsWith('|||')).toBe(false);
    expect(explanation.spoilerContent.endsWith('||')).toBe(true);
    expect(explanation.spoilerContent.endsWith('|||')).toBe(false);
    expect(explanation.body).not.toContain('||');
    expect(explanation.spoilerContent).not.toContain('```');
  });

  it('sanitizeDiscordText neutraliza pipes, backticks y menciones', () => {
    expect(sanitizeDiscordText('a||b')).not.toContain('||');
    expect(sanitizeDiscordText('```danger```')).not.toContain('```');
    expect(sanitizeDiscordText('hola @everyone')).not.toContain('@everyone');
  });

  it('J. management no_plan nunca se confunde con 0%', () => {
    const input = summary([pull('p1', 1)], {
      canonicalDefensive: canonical({ management: { status: 'no_plan', score: null, fulfilled: 0, evaluable: 0 } }),
    });

    const explanation = explanationFor(input);
    const managementLine = lineContaining(explanation.body, 'Gestión');
    expect(managementLine).toContain('N/D');
    expect(managementLine).not.toContain('%');
  });

  it('K. cobertura parcial se menciona explícitamente', () => {
    const input = summary([pull('p1', 1)], {
      canonicalDefensive: canonical({
        state: 'partial',
        coverage: { evaluatedPulls: 12, expectedPulls: 13 },
        usage: { status: 'available', score: 50, engaged: 6, evaluable: 12 },
        response: { status: 'available', score: 50, covered: 6, evaluable: 12, missedReady: 6, missedMistimed: 0 },
      }),
    });

    const explanation = explanationFor(input);
    expect(explanation.body.toLowerCase()).toContain('parcial');
    expect(explanation.body).toContain('12/13');
  });

  it('L. un fact ausente de la superficie canónica actual no se cuela aunque el summary lleve un campo shadow', () => {
    const input = summary([pull('p1', 1)]);
    // Simula un pipeline shadow (mechanic-attribution-canonical-shadow-v1) colgando datos extra en el
    // objeto — este builder nunca los lee (no hay ningún import de ese pipeline en raider-discord-explanation.ts).
    (input as unknown as Record<string, unknown>)['mechanicAttributionShadowEvaluations'] = [
      { playerName: 'Gusmï', mechanicName: 'ShadowOnlyMechanic', verdict: 'personal_fail' },
    ];

    const explanation = explanationFor(input);
    expect(explanation.body).not.toContain('ShadowOnlyMechanic');
  });
});
