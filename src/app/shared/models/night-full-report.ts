export type NightReportTrend = 'improving' | 'worsening' | 'flat' | 'insufficient_data';

export interface NightFullReport {
  schemaVersion: 10;
  reportCode: string;
  reportTitle: string;
  reportDate: string;
  summary: {
    totalPulls: number;
    totalBosses: number;
    totalKills: number;
    totalWipes: number;
    bestPull: {
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      wipePct: number | null;
      kill: boolean;
      pullNumber: number;
    } | null;
    avgPullDurationMs: number;
    totalCombatTimeMs: number;
    earlyWipeCount: number;
    earlyWipeThresholdMs: number;
    progressBoss: {
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      pulls: number;
      firstWipePct: number | null;
      lastWipePct: number | null;
      bestWipePct: number | null;
    } | null;
    bosses: {
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      pulls: number;
      kills: number;
      bestWipePct: number | null;
    }[];
    progression: {
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      firstWipePct: number;
      lastWipePct: number;
      pulls: number;
    }[];
  };
  mechanics: {
    mechanicName: string;
    mechanicNameEs: string | null;
    wowheadSpellId: number | null;
    category: string | null;
    categoryLabel: string | null;
    responsibility: string | null;
    responsibilityLabel: string | null;
    note: string | null;
    bossName: string;
    bossNameEs: string | null;
    difficulty: string;
    isProgressBoss: boolean;
    totalFails: number;
    pullsAffected: number;
    totalPulls: number;
    pctPullsAffected: number;
    lethalFinalBlows: number;
    avoidableDamageTotal: number | null;
    trend: NightReportTrend;
  }[];
  timelinePatterns: {
    bossName: string;
    bossNameEs: string | null;
    difficulty: string;
    windowBeforeMs: number;
    windowAfterMs: number;
    timelines: {
      anchorMechanicName: string;
      anchorMechanicNameEs: string | null;
      anchorWowheadSpellId: number | null;
      anchorCategory: string | null;
      anchorCategoryLabel: string | null;
      anchorResponsibility: string | null;
      anchorResponsibilityLabel: string | null;
      medianTimeMs: number;
      occurrences: number;
      failures: number;
      lethalFinalBlows: number;
      pulls: number[];
      resolution: string | null;
      markers: {
        kind: 'ability' | 'deaths';
        offsetMs: number;
        mechanicName: string;
        mechanicNameEs: string | null;
        wowheadSpellId: number | null;
        outcome: 'clean' | 'partial_fail' | 'fail' | null;
        occurrences: number;
        playersHit: number;
        deaths: number;
        isAnchor: boolean;
      }[];
    }[];
  } | null;
  avoidableDamage: {
    total: number;
    perMinute: number;
    pctOfRaidDamage: number | null;
    measuredBossScopes: number;
    totalBossScopes: number;
    complete: boolean;
  } | null;
  deaths: {
    totalRealDeaths: number;
    totalWipeCallExcluded: number;
    rootCauseClassifiedCount: number;
    rootCauseCoveragePct: number;
    mechanicCategorizedCount: number;
    mechanicCategoryCoveragePct: number;
    unknownFinalBlowCount: number;
    unknownFinalBlowWithDamageContextCount: number;
    byRootCause: { rootCause: string; label: string; count: number; pct: number }[];
    byCategory: { category: string; label: string; count: number; pct: number }[];
    topFinalBlows: {
      mechanicName: string;
      mechanicNameEs: string | null;
      wowheadSpellId: number | null;
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      isProgressBoss: boolean;
      note: string | null;
      count: number;
    }[];
    topLastDamageBeforeUnknownFinalBlow: {
      mechanicName: string;
      mechanicNameEs: string | null;
      wowheadSpellId: number | null;
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      isProgressBoss: boolean;
      note: string | null;
      count: number;
    }[];
    pctWithDefensiveAvailableUnused: number;
    defensiveEvaluableCount: number;
  };
  responsibilities: {
    classifiedMechanics: number;
    totalMechanics: number;
    classificationCoveragePct: number;
    byResponsibility: {
      responsibility: string;
      label: string;
      mechanics: number;
      failedEvents: number;
      pullsAffected: number;
      deaths: number;
      playersHit: number;
      damageTaken: number;
    }[];
  };
  survival: {
    emergencyLookbackMs: number;
    healthstone: {
      playersEverUsed: number;
      playersWithObservedAccess: number;
      pctUsedAtLeastOnce: number;
      deathsWithObservedAccessNoRecentUse: number;
      deathsEvaluable: number;
    };
    healthPotion: { playersEverUsed: number; totalPlayersTracked: number; pctUsedAtLeastOnce: number };
    either: { playersEverUsed: number; totalPlayersTracked: number; pctUsedAtLeastOnce: number };
    pctDeathsWithNoRecentEmergencyConsumable: number;
  };
  defensives: {
    playersEverUsed: number;
    totalPlayersTracked: number;
    pctPlayersUsedAtLeastOnce: number;
    totalCasts: number;
    castsPerCombatMinute: number;
    globalAvailableUnusedPct: number;
    availableUnusedCount: number;
    totalEvaluated: number;
    byCategory: { category: string; label: string; availableUnusedPct: number; evaluated: number }[];
  };
  interrupts: {
    totalCasts: number;
    interrupted: number;
    pctSuccess: number;
    excludedUnverifiedCasts: number;
    topUninterrupted: {
      mechanicName: string;
      mechanicNameEs: string | null;
      wowheadSpellId: number | null;
      note: string | null;
      completedCount: number;
    }[];
    progressBoss: {
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      totalCasts: number;
      interrupted: number;
      pctSuccess: number;
      topUninterrupted: {
        mechanicName: string;
        mechanicNameEs: string | null;
        wowheadSpellId: number | null;
        note: string | null;
        completedCount: number;
      }[];
    } | null;
  };
  wipePatterns: {
    category: string;
    label: string;
    count: number;
    pct: number;
  }[];
  wipeRecovery: { windowMs: number; wipesEvaluable: number; wipesWithCascade: number; pctWipesWithCascade: number };
  roleInsights: {
    scope: { bossName: string; bossNameEs: string | null; difficulty: string; pulls: number } | null;
    classifiedPlayers: number;
    totalPlayers: number;
    classificationCoveragePct: number;
    tanks: { players: number; deaths: number; deathsPerPull: number; playersUsingDefensive: number; tankbusterDeaths: number; nonTankTankbusterDeaths: number };
    healers: { players: number; deaths: number; deathsPerPull: number; playersUsingDefensive: number; raidDeathsWithSustainedNoHealingSignal: number };
    dps: { players: number; deaths: number; deathsPerPull: number; playersUsingDefensive: number; personalMechanicDeaths: number };
  };
  progressionComparison: {
    sampleSize: number;
    avoidableDamageDeltaPct: number | null;
    deathsDeltaPct: number | null;
    defensiveCoverageDeltaPct: number | null;
  } | null;
  priorities: { title: string; detail: string; note: string | null }[];
  goodPoints: string[];
  notAvailable: string[];
}

export interface StoredNightFullReport {
  report: NightFullReport;
  generatedAt: string;
}

export interface GenerateNightFullReportResult extends StoredNightFullReport {
  ok: true;
  cached: boolean;
}
