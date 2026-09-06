import { describe, expect, it } from 'vitest';
import {
  groupParticipantsForSidebar,
  filterParticipantGroups,
} from './report-participant-grouping.util';
import type { ReportParticipant } from '../../core/report-participants.service';

function participant(overrides: Partial<ReportParticipant> = {}): ReportParticipant {
  return {
    name: 'Raider',
    className: 'Warlock',
    spec: 'Destruction',
    role: 'Ranged',
    rank: 'Main',
    avatarUrl: null,
    ...overrides,
  };
}

describe('groupParticipantsForSidebar · PR3', () => {
  it('Melee y Ranged colapsan visualmente en un único grupo DPS', () => {
    const groups = groupParticipantsForSidebar([
      participant({ name: 'Mechavalec', role: 'Melee', className: 'Warrior' }),
      participant({ name: 'Gusmï', role: 'Ranged', className: 'Warlock' }),
    ]);

    const dps = groups.find((g) => g.key === 'dps');
    expect(dps).toBeDefined();
    expect(dps!.count).toBe(2);
    expect(
      groups.some(
        (g) =>
          g.key !== 'dps' &&
          g.classes.some((c) => c.players.some((p) => p.role === 'Melee' || p.role === 'Ranged')),
      ),
    ).toBe(false);
  });

  it('role null cae en "unknown" y nunca se descarta', () => {
    const groups = groupParticipantsForSidebar([
      participant({ name: 'PlayerX', role: null, className: null }),
    ]);

    const unknown = groups.find((g) => g.key === 'unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.label).toBe('Otros / Rol desconocido');
    expect(unknown!.count).toBe(1);
  });

  it('un grupo sin ningún jugador no aparece en el resultado', () => {
    const groups = groupParticipantsForSidebar([participant({ role: 'Tank' })]);

    expect(groups.map((g) => g.key)).toEqual(['tanks']);
  });

  it('ordena clases alfabéticamente (es) y jugadores alfabéticamente dentro de cada clase', () => {
    const groups = groupParticipantsForSidebar([
      participant({ name: 'Zeta', className: 'Warlock', role: 'Ranged' }),
      participant({ name: 'Alfa', className: 'Warlock', role: 'Ranged' }),
      participant({ name: 'Beta', className: 'Mage', role: 'Ranged' }),
    ]);

    const dps = groups.find((g) => g.key === 'dps')!;
    expect(dps.classes.map((c) => c.className)).toEqual(['Mage', 'Warlock']);
    expect(dps.classes.find((c) => c.className === 'Warlock')!.players.map((p) => p.name)).toEqual([
      'Alfa',
      'Zeta',
    ]);
  });

  it('la clase desconocida se ordena AL FINAL del grupo, no al principio, y se etiqueta null (no vacía)', () => {
    const groups = groupParticipantsForSidebar([
      participant({ name: 'SinClase', className: null, role: 'Heal' }),
      participant({ name: 'ConClase', className: 'Priest', role: 'Heal' }),
    ]);

    const healers = groups.find((g) => g.key === 'healers')!;
    expect(healers.classes.map((c) => c.className)).toEqual(['Priest', null]);
  });

  it('count refleja el total de jugadores del grupo (sumando todas sus clases)', () => {
    const groups = groupParticipantsForSidebar([
      participant({ name: 'A', className: 'Warlock', role: 'Ranged' }),
      participant({ name: 'B', className: 'Mage', role: 'Ranged' }),
      participant({ name: 'C', className: 'Hunter', role: 'Ranged' }),
    ]);

    expect(groups.find((g) => g.key === 'dps')!.count).toBe(3);
  });
});

describe('filterParticipantGroups · PR3', () => {
  const groups = groupParticipantsForSidebar([
    participant({ name: 'Dewerland', className: 'Warlock', role: 'Ranged' }),
    participant({ name: 'Gusmï', className: 'Warlock', role: 'Ranged' }),
    participant({ name: 'Sjorsak', className: 'Warrior', role: 'Tank' }),
  ]);

  it('sin búsqueda, devuelve los grupos sin tocar', () => {
    expect(filterParticipantGroups(groups, '')).toEqual(groups);
  });

  it('filtra por nombre manteniendo la forma Role → Class y recalcula count', () => {
    const filtered = filterParticipantGroups(groups, 'dew');

    expect(filtered.map((g) => g.key)).toEqual(['dps']);
    expect(filtered[0].count).toBe(1);
    expect(filtered[0].classes).toEqual([
      { className: 'Warlock', players: [expect.objectContaining({ name: 'Dewerland' })] },
    ]);
  });

  it('una búsqueda sin coincidencias hace desaparecer el grupo entero, no solo al jugador', () => {
    expect(filterParticipantGroups(groups, 'no-existe')).toEqual([]);
  });

  it('la búsqueda no distingue mayúsculas/tildes básicas del locale es', () => {
    const filtered = filterParticipantGroups(groups, 'GUSM');

    expect(
      filtered
        .flatMap((g) => g.classes)
        .flatMap((c) => c.players)
        .map((p) => p.name),
    ).toEqual(['Gusmï']);
  });
});
