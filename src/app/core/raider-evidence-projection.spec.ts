import { describe, expect, it } from 'vitest';
import type {
  NightDefensiveDecision,
  NightDefensiveManagementV2,
  NightDeathRow,
  NightPlayerSummary,
} from './night-player-summary.service';
import { buildRaiderEvidenceProjection } from './raider-evidence-projection';

function pull(pullId: string, pullNumber: number, pullScore: number | null) {
  return {
    pullId,
    pullNumber,
    fightId: pullNumber,
    bossId: 'boss-1',
    bossName: 'Boss uno',
    difficulty: 'mythic',
    kill: false,
    wipePct: 50,
    durationMs: 120_000,
    closedAt: '2026-09-02T20:00:00Z',
    died: false,
    excludedFromStats: pullScore == null,
    excludedReason: pullScore == null ? ('ninja_pull' as const) : null,
    hadWipeCall: false,
    worldRankPercent: null,
    pullScore,
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
  };
}

function summary(overrides: Partial<NightPlayerSummary> = {}): NightPlayerSummary {
  return {
    playerName: 'Raider',
    reportCode: 'REPORT',
    reportTitle: 'Raid',
    reportDate: '2026-09-02T20:00:00Z',
    roster: null,
    reliability: null,
    nightReliability: null,
    pulls: [pull('p1', 1, 0.8), pull('ninja', 99, null)],
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
      pressurePulls: 0,
      pressurePullsWithCast: 0,
      deathsWithDefensiveAvailable: 0,
      spells: [],
      pressurePullBreakdown: [],
      mechanicPressureBreakdown: [],
    },
    defensiveManagementV2: null,
    execution: {
      evaluatedPulls: 1,
      cleanPulls: 1,
      cleanPullRate: 1,
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

function decision(
  overrides: Partial<NightDefensiveDecision> = {},
): NightDefensiveDecision {
  return {
    state: 'reminder_missed',
    reason: 'READY_NOT_CAST_IN_WINDOW',
    atMs: 30_000,
    coverageOutcome: 'uncovered',
    adherenceOutcome: 'missed',
    managementOutcome: 'failure',
    requirementLevel: 'required',
    plannedSpellId: 123,
    candidateSpellIds: [123],
    primaryPenalty: true,
    pullId: 'p1',
    pullNumber: 1,
    bossId: 'boss-1',
    bossName: 'Boss uno',
    difficulty: 'mythic',
    mechanicName: 'Explosión',
    plannedSpellName: 'Escudo',
    actualSpellName: null,
    candidateSpellNames: ['Escudo'],
    evaluationMode: 'plan',
    planVersionId: 'plan-1',
    ...overrides,
  };
}

function management(decisions: NightDefensiveDecision[]): NightDefensiveManagementV2 {
  return {
    mode: 'plan',
    evaluatedPullCount: 1,
    planRequiredCount: 1,
    requiredExactAdherenceCount: 0,
    requiredCoverageSuccessCount: 0,
    planExecutedCount: 0,
    criticalWindowCount: 1,
    criticalCoveredCount: 0,
    correctHoldCount: 0,
    brokenReservationCount: 0,
    reminderMissedCount: 1,
    viableExtraCount: 0,
    extraUsedCount: 0,
    deathViableCdCount: 0,
    deathReadyCdCount: 0,
    managementScore: 0,
    evaluatorVersion: 'defensive-execution-evaluator@2.3.0',
    resolverVersion: 'effective-defensives@2.0.0',
    solverVersion: 'defensive-plan-solver@2.0.0',
    gameBuild: '12.0.0.1',
    buildFingerprint: 'sha256:test',
    dataConfidence: 'verified',
    decisions,
  };
}

function unknownDeath(overrides: Partial<NightDeathRow> = {}): NightDeathRow {
  return {
    pullId: 'p1',
    bossId: 'boss-1',
    bossName: 'Boss uno',
    difficulty: 'mythic',
    pullNumber: 1,
    timeMs: 80_000,
    mechanicName: 'Unknown Ability',
    mechanicId: 0,
    category: null,
    rootCause: 'unclassified',
    defensivesAvailable: [{ spellId: 123, name: 'Escudo' }],
    isWipeCall: false,
    isNinjaPull: false,
    statisticalExclusionReason: null,
    usedHealthstoneInPull: false,
    usedHealthPotionInPull: false,
    aiNote: null,
    resolution: 'Usa Escudo antes del impacto.',
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

describe('RaiderEvidenceProjection', () => {
  it('usa solo pulls evaluables y no deja entrar evidencia de un ninja pull', () => {
    const v2 = management([
      decision(),
      decision({ pullId: 'ninja', pullNumber: 99, atMs: 10_000 }),
    ]);
    const projection = buildRaiderEvidenceProjection(
      summary({ defensiveManagementV2: v2 }),
      { defensiveManagementV2: v2 },
    );

    expect(projection.evaluatedPullIds).toEqual(['p1']);
    expect(projection.items).toHaveLength(1);
    expect(projection.items[0].pullId).toBe('p1');
  });

  it('no convierte una categoría desconocida ni una resolution ausente en acusación o consejo', () => {
    const projection = buildRaiderEvidenceProjection(
      summary({
        mechanicFails: [
          {
            pullId: 'p1',
            bossId: 'boss-1',
            bossName: 'Boss uno',
            difficulty: 'mythic',
            pullNumber: 1,
            mechanicName: 'Marca',
            mechanicId: 456,
            category: null,
            outcome: 'fail',
            timeMs: 25_000,
            damageTaken: 100,
            aiNote: null,
            comparisonSource: null,
            comparisonPercentile: null,
            resolution: null,
          },
        ],
      }),
      { defensiveManagementV2: null },
    );

    const item = projection.items.find((row) => row.kind === 'mechanic');
    expect(item?.verdict).toBe('no_verdict');
    expect(item?.action).toBeNull();
    expect(projection.coaching).toEqual([]);
  });

  it('degrada un reason defensivo desconocido a no_verdict sin fallback punitivo', () => {
    const v2 = management([decision({ reason: 'FUTURE_REASON' })]);
    const projection = buildRaiderEvidenceProjection(
      summary({ defensiveManagementV2: v2 }),
      { defensiveManagementV2: v2 },
    );

    expect(projection.items[0]).toMatchObject({
      verdict: 'no_verdict',
      confidence: 'uncertain',
      action: null,
    });
  });

  it('deduplica un mismo grupo causal y limita solo las cards, no la evidencia', () => {
    const v2 = management([
      decision({ causalGroupId: 'g1', primaryPenalty: false, state: 'death_with_ready_cd', reason: 'DEATH_READY_AT_END_ONLY' }),
      decision({ causalGroupId: 'g1', primaryPenalty: true }),
      decision({ causalGroupId: 'g2', atMs: 40_000 }),
      decision({ causalGroupId: 'g3', atMs: 50_000 }),
      decision({ causalGroupId: 'g4', atMs: 60_000 }),
    ]);
    const projection = buildRaiderEvidenceProjection(
      summary({ defensiveManagementV2: v2 }),
      { defensiveManagementV2: v2 },
    );

    expect(projection.items).toHaveLength(4);
    expect(projection.coaching).toHaveLength(3);
    expect(projection.additionalCoachingCount).toBe(1);
    expect(projection.items.find((row) => row.id.includes('g1'))?.reasonCode).toBe(
      'READY_NOT_CAST_IN_WINDOW',
    );
  });

  it('mantiene una muerte con CD listo al final como coaching, nunca como evitable', () => {
    const v2 = management([
      decision({
        state: 'death_with_ready_cd',
        reason: 'DEATH_READY_AT_END_ONLY',
        abilityId: 456,
        plannedSpellId: undefined,
        plannedSpellName: null,
      }),
    ]);
    const projection = buildRaiderEvidenceProjection(
      summary({ defensiveManagementV2: v2 }),
      { defensiveManagementV2: v2 },
    );
    const item = projection.items[0];

    expect(item.verdict).toBe('coaching');
    expect(item.action).toBeNull();
    expect(`${item.title} ${item.observation} ${item.whyItMatters}`).not.toMatch(/evitable/i);
  });

  it('no recomienda defensivos en una muerte legacy con causa desconocida', () => {
    const projection = buildRaiderEvidenceProjection(
      summary({ deaths: [unknownDeath()], totalDeaths: 1 }),
      { defensiveManagementV2: null },
    );
    const item = projection.items.find((row) => row.kind === 'death');

    expect(item).toMatchObject({
      title: 'Causa no identificada',
      verdict: 'context',
      reasonCode: 'DEATH_CAUSE_UNIDENTIFIED',
      action: null,
      defensives: [],
    });
    expect(projection.coaching).toEqual([]);
  });

  it('degrada también la decisión v2 si la secuencia letal no tiene causa verificable', () => {
    const v2 = management([
      decision({
        state: 'death_with_viable_cd',
        reason: 'DEATH_COUNTERFACTUAL_FEASIBLE',
        abilityId: 0,
        mechanicName: 'Unknown Ability',
        candidateSpellIds: [123],
        candidateSpellNames: ['Escudo'],
      }),
    ]);
    const projection = buildRaiderEvidenceProjection(
      summary({ deaths: [unknownDeath()], totalDeaths: 1, defensiveManagementV2: v2 }),
      { defensiveManagementV2: v2 },
    );

    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({
      title: 'Causa no identificada',
      verdict: 'context',
      reasonCode: 'DEATH_CAUSE_UNIDENTIFIED',
      action: null,
      defensives: [],
    });
    expect(projection.coaching).toEqual([]);
  });

  it('puede declarar cobertura de evidencia alta sin fabricar una corrección', () => {
    const v2 = management([]);
    const projection = buildRaiderEvidenceProjection(
      summary({ defensiveManagementV2: v2 }),
      { defensiveManagementV2: v2 },
    );

    expect(projection.quality).toBe('high');
    expect(projection.coaching).toEqual([]);
  });
});
