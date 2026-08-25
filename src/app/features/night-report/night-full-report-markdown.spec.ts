import type { NightFullReport } from '../../shared/models/night-full-report';
import { bilingualName, buildNightDiscordSummary, buildNightFullReportMarkdown } from './night-full-report-markdown';

const report: NightFullReport = {
    schemaVersion: 10,
  reportCode: 'ABC123',
  reportTitle: 'Raid test',
  reportDate: '2026-08-24T18:00:00.000Z',
  summary: {
    totalPulls: 8,
    totalBosses: 1,
    totalKills: 1,
    totalWipes: 7,
    bestPull: { bossName: 'The Test Boss', bossNameEs: 'El Boss de Prueba', difficulty: 'Heroic', wipePct: 0, kill: true, pullNumber: 8 },
    avgPullDurationMs: 120_000,
    totalCombatTimeMs: 960_000,
    earlyWipeCount: 2,
    earlyWipeThresholdMs: 90_000,
    progressBoss: { bossName: 'The Test Boss', bossNameEs: 'El Boss de Prueba', difficulty: 'Heroic', pulls: 8, firstWipePct: 82, lastWipePct: 20, bestWipePct: 20 },
    bosses: [{ bossName: 'The Test Boss', bossNameEs: 'El Boss de Prueba', difficulty: 'Heroic', pulls: 8, kills: 1, bestWipePct: 0 }],
    progression: [{ bossName: 'The Test Boss', bossNameEs: 'El Boss de Prueba', difficulty: 'Heroic', firstWipePct: 82, lastWipePct: 0, pulls: 8 }],
  },
  mechanics: [{
    mechanicName: 'Fire Test',
    mechanicNameEs: 'Prueba de Fuego',
    wowheadSpellId: 12345,
    category: 'avoidable-ground',
    categoryLabel: 'Zona evitable',
    responsibility: 'personal',
    responsibilityLabel: 'Personal',
    note: 'Evita el área de fuego antes de que explote.',
    bossName: 'The Test Boss',
    bossNameEs: 'El Boss de Prueba',
    difficulty: 'Heroic',
    isProgressBoss: true,
    totalFails: 6,
    pullsAffected: 4,
    totalPulls: 8,
    pctPullsAffected: 50,
    lethalFinalBlows: 2,
    avoidableDamageTotal: null,
    trend: 'improving',
  }],
  timelinePatterns: null,
  avoidableDamage: null,
  deaths: {
    totalRealDeaths: 10,
    totalWipeCallExcluded: 3,
    rootCauseClassifiedCount: 6,
    rootCauseCoveragePct: 60,
    mechanicCategorizedCount: 4,
    mechanicCategoryCoveragePct: 40,
    unknownFinalBlowCount: 2,
    unknownFinalBlowWithDamageContextCount: 1,
    byRootCause: [{ rootCause: 'self_positioning', label: 'Posicionamiento propio', count: 4, pct: 40 }],
    byCategory: [{ category: 'avoidable-ground', label: 'Zona evitable', count: 4, pct: 40 }],
    topFinalBlows: [{ mechanicName: 'Fire Test', mechanicNameEs: 'Prueba de Fuego', wowheadSpellId: 12345, bossName: 'The Test Boss', bossNameEs: 'El Boss de Prueba', difficulty: 'Heroic', isProgressBoss: true, note: 'Evita el área de fuego antes de que explote.', count: 4 }],
    topLastDamageBeforeUnknownFinalBlow: [{ mechanicName: 'Lingering Fire', mechanicNameEs: 'Fuego persistente', wowheadSpellId: 333, bossName: 'The Test Boss', bossNameEs: 'El Boss de Prueba', difficulty: 'Heroic', isProgressBoss: true, note: null, count: 1 }],
    pctWithDefensiveAvailableUnused: 25,
    defensiveEvaluableCount: 8,
  },
  responsibilities: {
    classifiedMechanics: 1,
    totalMechanics: 1,
    classificationCoveragePct: 100,
    byResponsibility: [{ responsibility: 'personal', label: 'Personal', mechanics: 1, failedEvents: 5, pullsAffected: 4, deaths: 3, playersHit: 8, damageTaken: 500_000 }],
  },
  survival: {
    emergencyLookbackMs: 15_000,
    healthstone: { playersEverUsed: 8, playersWithObservedAccess: 20, pctUsedAtLeastOnce: 40, deathsWithObservedAccessNoRecentUse: 2, deathsEvaluable: 6 },
    healthPotion: { playersEverUsed: 5, totalPlayersTracked: 20, pctUsedAtLeastOnce: 25 },
    either: { playersEverUsed: 10, totalPlayersTracked: 20, pctUsedAtLeastOnce: 50 },
    pctDeathsWithNoRecentEmergencyConsumable: 60,
  },
  defensives: { playersEverUsed: 18, totalPlayersTracked: 20, pctPlayersUsedAtLeastOnce: 90, totalCasts: 90, castsPerCombatMinute: 5.6, globalAvailableUnusedPct: 25, availableUnusedCount: 2, totalEvaluated: 8, byCategory: [] },
  interrupts: {
    totalCasts: 10,
    interrupted: 8,
    pctSuccess: 80,
    excludedUnverifiedCasts: 3,
    topUninterrupted: [{ mechanicName: 'Danger Cast', mechanicNameEs: 'Lanzamiento Peligroso', wowheadSpellId: 9876, note: 'Debe interrumpirse.', completedCount: 2 }],
    progressBoss: { bossName: 'The Test Boss', bossNameEs: 'El Boss de Prueba', difficulty: 'Heroic', totalCasts: 10, interrupted: 8, pctSuccess: 80, topUninterrupted: [{ mechanicName: 'Danger Cast', mechanicNameEs: 'Lanzamiento Peligroso', wowheadSpellId: 9876, note: 'Debe interrumpirse.', completedCount: 2 }] },
  },
  wipePatterns: [{ category: 'mecanica_personal', label: 'Alguna muerte asociada a posicionamiento o soak', count: 4, pct: 57.1 }],
  wipeRecovery: { windowMs: 10_000, wipesEvaluable: 7, wipesWithCascade: 3, pctWipesWithCascade: 42.9 },
  roleInsights: {
    scope: { bossName: 'The Test Boss', bossNameEs: 'El Boss de Prueba', difficulty: 'Heroic', pulls: 8 },
    classifiedPlayers: 20,
    totalPlayers: 20,
    classificationCoveragePct: 100,
    tanks: { players: 2, deaths: 2, deathsPerPull: 0.3, playersUsingDefensive: 2, tankbusterDeaths: 2, nonTankTankbusterDeaths: 1 },
    healers: { players: 4, deaths: 3, deathsPerPull: 0.4, playersUsingDefensive: 4, raidDeathsWithSustainedNoHealingSignal: 2 },
    dps: { players: 14, deaths: 5, deathsPerPull: 0.6, playersUsingDefensive: 12, personalMechanicDeaths: 3 },
  },
  progressionComparison: { sampleSize: 8, avoidableDamageDeltaPct: null, deathsDeltaPct: -25, defensiveCoverageDeltaPct: 10 },
  priorities: [{ title: 'Fire Test (Prueba de Fuego)', detail: 'Presente en 4 de 8 pulls.', note: 'Evita el área de fuego antes de que explote.' }],
  goodPoints: ['Se consiguió el kill.'],
  notAvailable: ['Daño evitable — sin cobertura confirmada.'],
};

describe('buildNightFullReportMarkdown', () => {
  it('genera Markdown legible por Discord con nombres bilingües y enlaces', () => {
    const markdown = buildNightFullReportMarkdown(report, '2026-08-25T09:00:00.000Z');

    expect(markdown).toContain('# Informe de combate de IRIS');
    expect(markdown).toContain('The Test Boss (El Boss de Prueba)');
    expect(markdown).toContain('[Fire Test \(Prueba de Fuego\)](https://www.wowhead.com/spell=12345)');
    expect(markdown).toContain('## Límites del informe');
    expect(markdown).toContain('No demuestran por sí solas');
    expect(markdown).toContain('```text');
    expect(markdown).toContain('## Golpe final más repetido de la noche');
    expect(markdown).toContain('## Información por función');
    expect(markdown).toContain('Qué hace:');
    expect(markdown).not.toMatch(/^\|.+\|$/m);
  });

  it('genera un resumen Discord con tabla ASCII y todas las secciones útiles', () => {
    const markdown = buildNightDiscordSummary(report);

    expect(markdown).toContain('# Informe de combate de IRIS');
    expect(markdown).toContain('```text');
    expect(markdown).toContain('Prioridades para la próxima raid');
    expect(markdown).toContain('Progress actual');
    expect(markdown).not.toContain('## Golpe final más repetido');
    expect(markdown).toContain('Claves por función');
    expect(markdown).toContain('Evita el área de fuego');
    expect(markdown).toContain('Referencia de esta noche: 0,5 golpes finales por pull');
    expect(markdown).toContain('jugadores con algún defensivo registrado 2/2');
    expect(markdown).toContain('Avances confirmados');
    expect(markdown).not.toContain('Cobertura de causa raíz');
    expect(markdown).not.toContain('Tanks:** 2 muertes');
    expect(markdown).not.toContain('Absent');
  });

  it('no recorta notas largas aunque el resumen supere los 2.000 caracteres', () => {
    const longNote = Array.from(
      { length: 40 },
      () => 'Esta explicación debe conservarse completa porque aporta contexto necesario para resolver correctamente la habilidad.',
    ).join(' ');
    const reportWithLongNotes: NightFullReport = {
      ...report,
      deaths: {
        ...report.deaths,
        topFinalBlows: [{ ...report.deaths.topFinalBlows[0], note: longNote }],
      },
      priorities: [{ ...report.priorities[0], note: longNote }],
    };

    const markdown = buildNightDiscordSummary(reportWithLongNotes);

    expect(markdown.length).toBeGreaterThan(2_000);
    expect(markdown).toContain(longNote);
    expect(markdown).not.toContain('…');
  });

  it('describe un enrage como estado alcanzado y no como fallo personal', () => {
    const enrageMechanic = {
      ...report.mechanics[0],
      mechanicName: 'Final Ascension',
      mechanicNameEs: 'Ascensión final',
      category: 'enrage',
      categoryLabel: 'Enrage',
      pullsAffected: 8,
      totalPulls: 8,
      lethalFinalBlows: 12,
    };
    const enrageReport: NightFullReport = {
      ...report,
      mechanics: [enrageMechanic],
      deaths: {
        ...report.deaths,
        topFinalBlows: [{
          ...report.deaths.topFinalBlows[0],
          mechanicName: 'Final Ascension',
          mechanicNameEs: 'Ascensión final',
          count: 12,
        }],
      },
      priorities: [{
        title: 'Final Ascension (Ascensión final) — The Test Boss',
        detail: 'Registró fallos en el 100% de los pulls.',
        note: 'Hard enrage del encuentro.',
      }],
    };

    const markdown = buildNightDiscordSummary(enrageReport);

    expect(markdown).toContain('El enrage apareció en 8/8 pulls');
    expect(markdown).not.toContain('Registró fallos en el 100%');
  });

  it('no duplica el nombre cuando la localización es igual', () => {
    expect(bilingualName('Ravage', 'Ravage')).toBe('Ravage');
    expect(bilingualName('Ravage', 'Devastar')).toBe('Ravage (Devastar)');
  });
});
