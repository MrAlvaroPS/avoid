import { describe, expect, it } from 'vitest';
import type {
  CanonicalDefensiveEpisodeView,
  NightCanonicalDefensiveSummary,
  NightPlayerSummary,
  NightPullSummary,
} from './night-player-summary.service';
import type { EpisodeVerdictCandidate, ResponseVerdict } from '../../../supabase/functions/_shared/defensive-episode-verdict';
import { buildRaiderEvidenceProjection } from './raider-evidence-projection';
import { buildRaiderInfographicViewModel } from './raider-infographic-view-model';

function pull(index: number, overrides: Partial<NightPullSummary> = {}): NightPullSummary {
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

function candidate(overrides: Partial<EpisodeVerdictCandidate> & { spellId: number }): EpisodeVerdictCandidate {
  return {
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

let episodeSeq = 0;

/** Fixture de un CanonicalDefensiveEpisodeView (episodio canónico ya enriquecido con boss/pull/mecánica —
 * forma exacta que night-player-summary.service.ts adjunta a NightPlayerSummary.canonicalDefensive). */
function canonicalEpisode(overrides: Partial<CanonicalDefensiveEpisodeView> = {}): CanonicalDefensiveEpisodeView {
  episodeSeq += 1;
  return {
    episodeId: `episode-${episodeSeq}`,
    causalGroupId: `group-${episodeSeq}`,
    pullId: 'pull-1',
    pullNumber: 1,
    bossId: 'boss-1',
    bossName: 'Boss uno',
    difficulty: 'mythic',
    startMs: 19_000,
    peakMs: 20_000,
    endMs: 21_000,
    dominantAbilityGameId: 5000,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [candidate({ spellId: 2000 })],
    responseVerdict: 'missed_ready',
    responseReason: 'fixture',
    coveredBySpellId: null,
    decisiveSpellIds: [],
    planAssignmentId: null,
    planVerdict: null,
    confidence: 'verified',
    mechanicName: 'Mecánica de prueba',
    mechanicDescription: null,
    mechanicResolution: null,
    ...overrides,
  };
}

function canonicalSummary(
  episodes: CanonicalDefensiveEpisodeView[],
  overrides: Partial<NightCanonicalDefensiveSummary> = {},
): NightCanonicalDefensiveSummary {
  const evaluableVerdicts = new Set<ResponseVerdict>(['covered_verified', 'missed_ready', 'missed_due_to_mistime']);
  const evaluable = episodes.filter((e) => evaluableVerdicts.has(e.responseVerdict));
  const covered = evaluable.filter((e) => e.responseVerdict === 'covered_verified');
  const missedReady = evaluable.filter((e) => e.responseVerdict === 'missed_ready').length;
  const missedMistimed = evaluable.filter((e) => e.responseVerdict === 'missed_due_to_mistime').length;
  const engaged = evaluable.filter((e) => e.usageEngaged);
  return {
    state: 'available',
    coverage: { evaluatedPulls: 1, expectedPulls: 1 },
    usage: {
      status: evaluable.length ? 'available' : 'insufficient_evidence',
      score: evaluable.length ? Math.round((engaged.length / evaluable.length) * 10000) / 100 : null,
      engaged: engaged.length,
      evaluable: evaluable.length,
    },
    response: {
      status: evaluable.length ? 'available' : 'insufficient_evidence',
      score: evaluable.length ? Math.round((covered.length / evaluable.length) * 10000) / 100 : null,
      covered: covered.length,
      evaluable: evaluable.length,
      missedReady,
      missedMistimed,
    },
    management: { status: 'no_plan', score: null, fulfilled: 0, evaluable: 0 },
    context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 0, excluded: 0 },
    totalEpisodes: episodes.length,
    episodes,
    generation: {
      id: 'generation-1',
      publishedAt: '2026-09-05T00:00:00Z',
      semanticVersion: 'defensive-semantics@1.0.0',
      resolverVersion: 'effective-defensives@2.3.0',
      semanticResolverVersion: 'effective-defensive-semantics@1.5.0',
      episodeVersion: 'episode-evaluator@7',
      evaluatorVersion: 'episode-evaluator@7',
      gameBuild: '12.1.0.68914',
    },
    integrityIssues: [],
    diagnostics: {
      usage: { status: 'available', engaged: engaged.length, evaluable: evaluable.length, score: 0 },
      response: { status: 'available', covered: covered.length, evaluable: evaluable.length, score: 0, missedReady, missedMistimed },
      rowsExpected: 1,
      rowsFound: 1,
    },
    ...overrides,
  };
}

function summary(
  pulls: NightPullSummary[],
  canonical: NightCanonicalDefensiveSummary,
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
      mechanicPressureBreakdown: [],
    },
    defensiveManagementV2: null,
    canonicalDefensive: canonical,
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

function buildView(input: NightPlayerSummary) {
  const projection = buildRaiderEvidenceProjection(input, {
    defensiveManagementV2: null,
    canonicalDefensive: input.canonicalDefensive,
  });
  return buildRaiderInfographicViewModel(input, projection);
}

describe('RaiderInfographicViewModel · hero defensivo canónico', () => {
  it('§71: expone exactamente Ejecución + Uso/Respuesta/Gestión — nunca un cuarto "Calidad de evidencia"', () => {
    const pulls = [pull(1)];
    const canonical = canonicalSummary([canonicalEpisode({ responseVerdict: 'covered_verified', usageEngaged: true })]);
    const view = buildView(summary(pulls, canonical));

    expect(view.hero.execution.key).toBe('execution');
    expect(Object.keys(view.hero.defensive)).toEqual(['usage', 'response', 'management']);
    expect((view as unknown as { heroMetrics?: unknown }).heroMetrics).toBeUndefined();
  });

  it('§58 fuente única: Respuesta canónica gana aunque el summary lleve valores legacy decoy', () => {
    const pulls = [pull(1)];
    const canonical = canonicalSummary([
      canonicalEpisode({ responseVerdict: 'missed_ready' }),
      canonicalEpisode({ responseVerdict: 'missed_ready' }),
      canonicalEpisode({ responseVerdict: 'missed_ready' }),
      canonicalEpisode({ responseVerdict: 'covered_verified' }),
    ]); // Respuesta real: 1/4 = 25%
    const input = summary(pulls, canonical, {
      // decoys legacy — nunca deben alimentar el hero de la v3.
      nightReliability: { sampleSize: 1, overall: 80, breakdown: { defensiva: 80 } as never } as never,
    });
    const view = buildView(input);

    expect(view.hero.defensive.response.value).toBe('25%');
    expect(view.hero.defensive.response.fraction).toBe('1/4');
  });

  it('§59-62 smoke: Usage y Response nunca colapsan al mismo número con denominadores distintos', () => {
    const pulls = [pull(1)];
    // 18/23 engaged, 4/20 covered — Magzil-shaped (denominadores distintos, evaluable Response < evaluable Usage por los 3 "uncertain").
    const episodes: CanonicalDefensiveEpisodeView[] = [
      ...Array.from({ length: 18 }, () => canonicalEpisode({ responseVerdict: 'missed_ready', usageEngaged: true })),
      ...Array.from({ length: 2 }, () => canonicalEpisode({ responseVerdict: 'missed_ready', usageEngaged: false })),
      ...Array.from({ length: 4 }, () => canonicalEpisode({ responseVerdict: 'covered_verified', usageEngaged: true })),
      // 3 uncertain: fuera de ambos denominadores.
    ];
    const canonical = canonicalSummary(episodes, {
      usage: { status: 'available', score: 78.26, engaged: 18, evaluable: 23 },
      response: { status: 'available', score: 20, covered: 4, evaluable: 20, missedReady: 16, missedMistimed: 0 },
    });
    const view = buildView(summary(pulls, canonical));

    expect(view.hero.defensive.usage.fraction).toBe('18/23');
    expect(view.hero.defensive.response.fraction).toBe('4/20');
    expect(view.hero.defensive.usage.value).not.toBe(view.hero.defensive.response.value);
  });

  it('§63 sin episodios: Usage/Response muestran N/D, nunca 0%', () => {
    const canonical = canonicalSummary([]);
    const view = buildView(summary([pull(1)], canonical));

    expect(view.hero.defensive.usage.value).toBe('N/D');
    expect(view.hero.defensive.usage.progressPct).toBeNull();
    expect(view.hero.defensive.response.value).toBe('N/D');
  });

  it('§30/§60 0% real es distinto de N/D — Tetasdivinas-shaped (0/1)', () => {
    const canonical = canonicalSummary([canonicalEpisode({ responseVerdict: 'missed_ready', usageEngaged: false })]);
    const view = buildView(summary([pull(1)], canonical));

    expect(view.hero.defensive.usage.value).toBe('0%');
    expect(view.hero.defensive.usage.progressPct).toBe(0);
    expect(view.hero.defensive.usage.tone).toBe('danger');
    expect(view.hero.defensive.response.value).toBe('0%');
  });

  it('§67 sin plan: Gestión es N/D · Sin plan, nunca 0%', () => {
    const canonical = canonicalSummary([canonicalEpisode({ responseVerdict: 'covered_verified' })]);
    const view = buildView(summary([pull(1)], canonical));

    expect(view.hero.defensive.management.value).toBe('N/D');
    expect(view.hero.defensive.management.fraction).toBe('Sin plan');
    expect(view.hero.defensive.management.tone).toBe('neutral');
    expect(view.hero.defensive.management.progressPct).toBeNull();
  });

  it('§68 con plan: 3/4 asignaciones cumplidas → 75%, sin bonus', () => {
    const episodes = [
      canonicalEpisode({ planAssignmentId: 'a', planVerdict: 'covered' }),
      canonicalEpisode({ planAssignmentId: 'b', planVerdict: 'covered' }),
      canonicalEpisode({ planAssignmentId: 'c', planVerdict: 'covered' }),
      canonicalEpisode({ planAssignmentId: 'd', planVerdict: 'missed' }),
    ];
    const canonical = canonicalSummary(episodes, {
      management: { status: 'available', score: 75, fulfilled: 3, evaluable: 4 },
    });
    const view = buildView(summary([pull(1)], canonical));

    expect(view.hero.defensive.management.value).toBe('75%');
    expect(view.hero.defensive.management.fraction).toBe('3/4');
  });

  it('100% también se muestra como número real, no como categoría', () => {
    const canonical = canonicalSummary([canonicalEpisode({ responseVerdict: 'covered_verified', usageEngaged: true })], {
      usage: { status: 'available', score: 100, engaged: 1, evaluable: 1 },
    });
    const view = buildView(summary([pull(1)], canonical));
    expect(view.hero.defensive.usage.value).toBe('100%');
    expect(view.hero.defensive.usage.tone).toBe('positive');
  });
});

describe('RaiderInfographicViewModel · mecánicas y strip defensivo canónicos', () => {
  it('agrupa episodios canónicos por boss+dificultad+dominantAbilityGameId, no por mechanicPressureBreakdown', () => {
    const pulls = [pull(1)];
    const episodes = [
      canonicalEpisode({ dominantAbilityGameId: 5000, responseVerdict: 'covered_verified', usedSpellIds: [2000] }),
      canonicalEpisode({ dominantAbilityGameId: 5000, responseVerdict: 'missed_ready' }),
      canonicalEpisode({ dominantAbilityGameId: 6000, responseVerdict: 'missed_due_to_mistime' }),
    ];
    const canonical = canonicalSummary(episodes);
    const view = buildView(summary(pulls, canonical));

    expect(view.mechanics).toHaveLength(2);
    const first = view.mechanics.find((m) => m.mechanicId === 5000)!;
    expect(first.coveredCount).toBe(1);
    expect(first.totalCount).toBe(2);
    expect(first.occurrenceGroups.flatMap((g) => g.cells).map((c) => c.state).sort()).toEqual(['covered', 'uncovered']);
  });

  it('unavailable_legitimate y uncertain nunca cuentan como uncovered en el grid (§39/§40, corregido)', () => {
    const episodes = [
      canonicalEpisode({ dominantAbilityGameId: 5000, responseVerdict: 'unavailable_legitimate', decisiveSpellIds: [2000] }),
      canonicalEpisode({ dominantAbilityGameId: 5000, responseVerdict: 'uncertain' }),
      canonicalEpisode({ dominantAbilityGameId: 5000, responseVerdict: 'no_applicable_resource' }),
    ];
    const canonical = canonicalSummary(episodes);
    const view = buildView(summary([pull(1)], canonical));
    const states = view.mechanics[0].occurrenceGroups.flatMap((g) => g.cells).map((c) => c.state);

    expect(states).not.toContain('uncovered');
    expect(states.filter((s) => s === 'not_required')).toHaveLength(1);
    expect(states.filter((s) => s === 'context')).toHaveLength(2);
    // covered/total sigue sin contar estos tres como fallo — 0 covered de 3, pero ninguno "uncovered".
    expect(view.mechanics[0].coveredCount).toBe(0);
  });

  it('la tabla de defensivos por mecánica nunca llama "reserva correcta" a unavailable_legitimate', () => {
    const episodes = [
      canonicalEpisode({
        dominantAbilityGameId: 5000,
        responseVerdict: 'unavailable_legitimate',
        decisiveSpellIds: [2000],
        applicableCandidates: [candidate({ spellId: 2000, statusAtPeak: 'on_cooldown' })],
      }),
    ];
    const canonical = canonicalSummary(episodes);
    const view = buildView(summary([pull(1)], canonical));
    const row = view.mechanics[0].defensives.find((d) => d.spellId === 2000)!;

    expect(row.notRequiredCount).toBe(1);
    expect((row as unknown as { reservedCount?: unknown }).reservedCount).toBeUndefined();
  });

  it('el strip defensivo usa los 5 KPI canónicos (uso/respuesta/CD sin cubrir/mal timing/gestión), no "Casts defensivos"', () => {
    const episodes = [
      canonicalEpisode({ responseVerdict: 'missed_ready' }),
      canonicalEpisode({ responseVerdict: 'missed_due_to_mistime' }),
      canonicalEpisode({ responseVerdict: 'covered_verified', usageEngaged: true }),
    ];
    const canonical = canonicalSummary(episodes);
    const view = buildView(summary([pull(1)], canonical));
    const keys = view.defensiveMetrics.map((m) => m.key);

    expect(keys).toEqual(['usage', 'response', 'missed-ready', 'missed-mistimed', 'management']);
    expect(view.defensiveMetrics.find((m) => m.key === 'missed-ready')?.value).toBe('1');
    expect(view.defensiveMetrics.find((m) => m.key === 'missed-mistimed')?.value).toBe('1');
  });

  it('positiveSignals nunca deriva de unavailable_legitimate — solo de covered_verified', () => {
    const episodesNoCoverage = [canonicalEpisode({ responseVerdict: 'unavailable_legitimate' })];
    const viewNoCoverage = buildView(summary([pull(1)], canonicalSummary(episodesNoCoverage)));
    expect(viewNoCoverage.positiveSignals.some((s) => s.key === 'defensive')).toBe(false);

    const episodesCovered = [canonicalEpisode({ responseVerdict: 'covered_verified', usageEngaged: true })];
    const viewCovered = buildView(
      summary([pull(1)], canonicalSummary(episodesCovered, { response: { status: 'available', score: 100, covered: 1, evaluable: 1, missedReady: 0, missedMistimed: 0 } })),
    );
    expect(viewCovered.positiveSignals.some((s) => s.key === 'defensive')).toBe(true);
  });
});
