import { describe, expect, it } from 'vitest';
import type {
  NightDefensiveManagementV2,
  NightMechanicPressureSummary,
  NightPlayerSummary,
  NightPullSummary,
} from './night-player-summary.service';
import { buildRaiderEvidenceProjection } from './raider-evidence-projection';
import { buildRaiderInfographicViewModel } from './raider-infographic-view-model';

function pull(
  index: number,
  overrides: Partial<NightPullSummary> = {},
): NightPullSummary {
  return {
    pullId: `pull-${index}`,
    pullNumber: index,
    fightId: index,
    bossId: 'boss-1',
    bossName: 'Boss uno',
    difficulty: 'mythic',
    kill: false,
    wipePct: 50,
    durationMs: 120_000,
    closedAt: '2026-09-02T20:00:00Z',
    died: false,
    excludedFromStats: false,
    excludedReason: null,
    hadWipeCall: false,
    worldRankPercent: null,
    pullScore: 0.8,
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

function mechanic(
  index: number,
  defensiveCount: number,
  occurrencePulls: NightPullSummary[],
): NightMechanicPressureSummary {
  return {
    mechanicId: 1_000 + index,
    mechanicName: `Mecánica ${index}`,
    bossId: occurrencePulls[0]?.bossId ?? 'boss-1',
    bossName: occurrencePulls[0]?.bossName ?? 'Boss uno',
    difficulty: 'mythic',
    timingPattern: null,
    occurrences: occurrencePulls.map((row, occurrenceIndex) => ({
      pullId: row.pullId,
      pullNumber: row.pullNumber,
      timeMs: 20_000 + occurrenceIndex * 1_000,
      covered: occurrenceIndex % 2 === 0,
      coveredBySpellId: occurrenceIndex % 2 === 0 ? 2_000 : null,
      coveredBySpellName: occurrenceIndex % 2 === 0 ? 'Defensivo 1' : null,
    })),
    coveredCount: Math.ceil(occurrencePulls.length / 2),
    totalCount: occurrencePulls.length,
    defensives: Array.from({ length: defensiveCount }, (_, defensiveIndex) => ({
      spellId: 2_000 + defensiveIndex,
      name: `Defensivo ${defensiveIndex + 1}`,
      timesCovered: defensiveIndex === 0 ? 1 : 0,
      timesAvailableUnused: 2,
      timesOnCooldown: 1,
      timesUnknown: 0,
    })),
  };
}

function summary(
  pulls: NightPullSummary[],
  mechanics: NightMechanicPressureSummary[],
  overrides: Partial<NightPlayerSummary> = {},
): NightPlayerSummary {
  return {
    playerName: 'Raider',
    reportCode: 'REPORT',
    reportTitle: 'Raid',
    reportDate: '2026-09-02T20:00:00Z',
    roster: null,
    reliability: null,
    nightReliability: null,
    pulls,
    nightScore: 0.8,
    nightDefensiveConsistency: { missPullCount: 0, multiplier: 1, rawScore: 0.8 },
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
      mechanicPressureBreakdown: mechanics,
    },
    defensiveManagementV2: null,
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

function management(
  summaryValue: NightPlayerSummary,
  mechanicValue: NightMechanicPressureSummary,
): NightDefensiveManagementV2 {
  const firstPull = summaryValue.pulls[0];
  return {
    mode: 'plan',
    evaluatedPullCount: summaryValue.pulls.length,
    planRequiredCount: 0,
    requiredExactAdherenceCount: 0,
    requiredCoverageSuccessCount: 0,
    planExecutedCount: 0,
    criticalWindowCount: 1,
    criticalCoveredCount: 0,
    correctHoldCount: 1,
    brokenReservationCount: 0,
    reminderMissedCount: 0,
    viableExtraCount: 0,
    extraUsedCount: 0,
    deathViableCdCount: 0,
    deathReadyCdCount: 0,
    managementScore: null,
    evaluatorVersion: 'defensive-execution-evaluator@2.3.0',
    resolverVersion: 'effective-defensives@2.0.0',
    solverVersion: 'defensive-plan-solver@2.0.0',
    gameBuild: '12.0.0.1',
    buildFingerprint: 'sha256:test',
    dataConfidence: 'verified',
    decisions: [
      {
        state: 'correct_hold',
        reason: 'RESERVED_HIGHER_PRIORITY',
        atMs: mechanicValue.occurrences[0].timeMs,
        coverageOutcome: 'uncovered',
        adherenceOutcome: 'held',
        managementOutcome: 'success',
        requirementLevel: 'optional',
        abilityId: mechanicValue.mechanicId,
        candidateSpellIds: [mechanicValue.defensives[0].spellId],
        candidateSpellNames: [mechanicValue.defensives[0].name],
        causalGroupId: 'hold-1',
        primaryPenalty: false,
        pullId: firstPull.pullId,
        pullNumber: firstPull.pullNumber,
        bossId: firstPull.bossId,
        bossName: firstPull.bossName,
        difficulty: firstPull.difficulty,
        mechanicName: mechanicValue.mechanicName,
        plannedSpellName: null,
        actualSpellName: null,
        evaluationMode: 'plan',
        planVersionId: 'plan-1',
      },
    ],
  };
}

describe('RaiderInfographicViewModel', () => {
  it('mantiene una noche corta con dos defensivos sin slots fijos ni cifras inventadas', () => {
    const pulls = Array.from({ length: 4 }, (_, index) => pull(index + 1));
    const mechanics = [mechanic(1, 2, pulls)];
    const input = summary(pulls, mechanics);
    const projection = buildRaiderEvidenceProjection(input, { defensiveManagementV2: null });
    const view = buildRaiderInfographicViewModel(input, projection, null);

    expect(view.identity).toMatchObject({
      evaluatedPullCount: 4,
      evaluatedBossCount: 1,
      bossKillCount: 0,
    });
    expect(view.timelineGroups).toHaveLength(1);
    expect(view.timelineGroups[0].cells).toHaveLength(4);
    expect(view.mechanicPages[0][0].defensives).toHaveLength(2);
    expect(view.layout).toMatchObject({
      pullDensity: 'normal',
      defensiveDensity: 'normal',
      spreadCount: 1,
    });
  });

  it('pagina nueve mecánicas y conserva 25 pulls, siete bosses y cinco defensivos', () => {
    const pulls = Array.from({ length: 25 }, (_, index) => {
      const bossIndex = Math.min(6, Math.floor(index / 4));
      return pull(index + 1, {
        pullId: `boss-${bossIndex + 1}-pull-${(index % 4) + 1}`,
        pullNumber: (index % 4) + 1,
        bossId: `boss-${bossIndex + 1}`,
        bossName: `Boss ${bossIndex + 1}`,
        kill: index === bossIndex * 4,
      });
    });
    const mechanics = Array.from({ length: 9 }, (_, index) =>
      mechanic(index + 1, 5, pulls.filter((row) => row.bossId === `boss-${(index % 7) + 1}`)),
    );
    const input = summary(pulls, mechanics);
    const projection = buildRaiderEvidenceProjection(input, { defensiveManagementV2: null });
    const view = buildRaiderInfographicViewModel(input, projection, null);

    expect(view.identity).toMatchObject({
      evaluatedPullCount: 25,
      evaluatedBossCount: 7,
      bossKillCount: 7,
    });
    expect(view.timelineGroups).toHaveLength(7);
    expect(view.timelineGroups.flatMap((group) => group.cells)).toHaveLength(25);
    expect(view.mechanicPages.map((page) => page.length)).toEqual([6, 3]);
    expect(view.mechanicPages[0][0].defensives).toHaveLength(5);
    expect(view.layout).toEqual({
      pullDensity: 'dense',
      mechanicDensity: 'dense',
      defensiveDensity: 'compact',
      spreadCount: 2,
    });
  });

  it('conserva las 25 ocurrencias cuando todos los pulls pertenecen a un solo boss', () => {
    const pulls = Array.from({ length: 25 }, (_, index) => pull(index + 1));
    const mechanics = [mechanic(1, 5, pulls)];
    const input = summary(pulls, mechanics);
    const projection = buildRaiderEvidenceProjection(input, { defensiveManagementV2: null });
    const view = buildRaiderInfographicViewModel(input, projection, null);

    expect(view.timelineGroups).toHaveLength(1);
    expect(view.timelineGroups[0].cells).toHaveLength(25);
    expect(view.mechanicPages).toHaveLength(1);
    expect(view.mechanicPages[0][0].occurrenceGroups).toHaveLength(25);
    expect(
      view.mechanicPages[0][0].occurrenceGroups.flatMap((group) => group.cells),
    ).toHaveLength(25);
    expect(view.mechanicPages[0][0].defensives).toHaveLength(5);
    expect(view.layout.pullDensity).toBe('dense');
  });

  it('separa una reserva V2 del contador libre sin alterar el total del defensivo', () => {
    const pulls = [pull(1)];
    const mechanicValue = mechanic(1, 2, pulls);
    const base = summary(pulls, [mechanicValue]);
    const v2 = management(base, mechanicValue);
    const input = { ...base, defensiveManagementV2: v2 };
    const projection = buildRaiderEvidenceProjection(input, { defensiveManagementV2: v2 });
    const view = buildRaiderInfographicViewModel(input, projection, v2);
    const defensive = view.mechanicPages[0][0].defensives[0];

    expect(defensive).toMatchObject({
      coveredCount: 1,
      freeUnusedCount: 1,
      reservedCount: 1,
      onCooldownCount: 1,
      unknownCount: 0,
      totalCount: 4,
    });
    expect(view.mechanicPages[0][0].occurrenceGroups[0].cells[0].state).toBe('covered');
  });
});
