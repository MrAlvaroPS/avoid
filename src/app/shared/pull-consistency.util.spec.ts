import { describe, expect, it } from 'vitest';
import {
  buildAttemptComparison,
  summarizeExecutionIncidents,
  validAttemptOrdinal,
} from './pull-consistency.util';

describe('pull consistency', () => {
  it('cuenta incidentes temporales, no filas de jugadores, y el desglose suma el total', () => {
    const summary = summarizeExecutionIncidents(
      [
        { mechanic_name: 'Blast Wave', outcome: 'fail', category: 'avoidable-ground' },
        { mechanic_name: 'Raid Pulse', outcome: 'partial_fail', category: 'raid-damage' },
        { mechanic_name: 'Unknown', outcome: 'fail', category: null },
        { mechanic_name: 'Clean Cast', outcome: 'clean', category: 'avoidable-ground' },
      ],
      2,
    );

    expect(summary).toMatchObject({
      totalEvents: 5,
      personalEvents: 1,
      groupEvents: 1,
      unclassifiedEvents: 1,
      uncoveredDeathEvents: 2,
    });
    expect(
      summary.personalEvents +
        summary.groupEvents +
        summary.unclassifiedEvents +
        summary.uncoveredDeathEvents,
    ).toBe(summary.totalEvents);
  });

  it('responsibility explícita manda sobre category al separar personal de grupo', () => {
    const summary = summarizeExecutionIncidents([
      {
        mechanic_name: 'Raid-owned ground damage',
        outcome: 'fail',
        category: 'avoidable-ground',
        responsibility: 'raid',
      },
      {
        mechanic_name: 'Personal hit',
        outcome: 'fail',
        category: 'personal-target',
        responsibility: 'personal',
      },
      {
        mechanic_name: 'Unknown ownership',
        outcome: 'fail',
        category: null,
        responsibility: null,
      },
    ]);

    expect(summary).toMatchObject({
      totalEvents: 3,
      personalEvents: 1,
      groupEvents: 1,
      unclassifiedEvents: 1,
    });
    expect(summary.personalBreakdown.map((row) => row.label)).toEqual(['Personal hit']);
    expect(summary.groupBreakdown.map((row) => row.label)).toEqual(['Raid-owned ground damage']);
  });

  it('propaga ability_id y nota al desglose, para el tooltip de "Llamada colectiva"', () => {
    const summary = summarizeExecutionIncidents(
      [
        { mechanic_name: 'Raid Pulse', outcome: 'fail', category: 'raid-damage', ability_id: 12345 },
        { mechanic_name: 'Sin manifiesto', outcome: 'fail', category: 'tankbuster' },
      ],
      0,
      new Map([['Raid Pulse', 'Sal del área marcada en el suelo.']]),
    );

    expect(summary.groupBreakdown).toEqual([
      { label: 'Raid Pulse', count: 1, wowheadSpellId: 12345, notes: 'Sal del área marcada en el suelo.' },
      { label: 'Sin manifiesto', count: 1, wowheadSpellId: null, notes: null },
    ]);
  });

  it('numera solo intentos válidos y conserva el ninja pull como excluido', () => {
    const pulls = [
      { id: 'one', ninja_pull_excluded: false },
      { id: 'ninja', ninja_pull_excluded: true },
      { id: 'two', ninja_pull_excluded: false },
    ];

    expect(validAttemptOrdinal(pulls, 'one')).toBe(1);
    expect(validAttemptOrdinal(pulls, 'ninja')).toBeNull();
    expect(validAttemptOrdinal(pulls, 'two')).toBe(2);
  });

  it('describe como mixto un pull con más progreso pero más muertes e incidentes', () => {
    expect(
      buildAttemptComparison({
        previousAttemptNumber: 3,
        currentWipePct: 19.9,
        previousWipePct: 69.7,
        currentDeaths: 23,
        previousDeaths: 22,
        currentIncidents: 25,
        previousIncidents: 4,
      }),
    ).toEqual({
      previousAttemptNumber: 3,
      progressDeltaPp: 49.8,
      deathsDelta: 1,
      incidentsDelta: 21,
      verdict: 'mixed',
    });
  });
});
