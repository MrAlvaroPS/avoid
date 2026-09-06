import { describe, expect, it } from 'vitest';
import {
  resolveDominantClassSpec,
  resolveNightPlayerIdentity,
  type PlayerPullSpecObservation,
} from './night-player-identity.util';

function obs(
  className: string | null,
  spec: string | null,
  orderIndex: number,
): PlayerPullSpecObservation {
  return { className, spec, orderIndex };
}

describe('resolveNightPlayerIdentity · rol antes que spec (PR1)', () => {
  it('Holy 4 pulls + Discipline 4 pulls + Shadow 5 pulls sale Healer, no DPS — el rol suma pulls de TODAS las specs que lo componen', () => {
    const observations = [
      ...Array.from({ length: 4 }, (_, i) => obs('Priest', 'Holy', i)),
      ...Array.from({ length: 4 }, (_, i) => obs('Priest', 'Discipline', 4 + i)),
      ...Array.from({ length: 5 }, (_, i) => obs('Priest', 'Shadow', 8 + i)),
    ];

    const result = resolveNightPlayerIdentity(observations);

    expect(result.role).toBe('Heal');
    // Holy y Discipline empatan 4-4 dentro del rol ganador -> desempata el pull más reciente (Discipline, índices 4-7).
    expect(result.spec).toBe('Discipline');
    expect(result.className).toBe('Priest');
  });

  it('un empate de ROL se desempata por el rol visto en el pull más reciente', () => {
    // Warrior Protection (Tank) x3 vs Warrior Arms (Melee) x3, Arms es el más reciente.
    const observations = [
      obs('Warrior', 'Protection', 0),
      obs('Warrior', 'Protection', 1),
      obs('Warrior', 'Protection', 2),
      obs('Warrior', 'Arms', 3),
      obs('Warrior', 'Arms', 4),
      obs('Warrior', 'Arms', 5),
    ];

    const result = resolveNightPlayerIdentity(observations);

    expect(result.role).toBe('Melee');
    expect(result.spec).toBe('Arms');
  });

  it('ninguna observación resuelve rol -> role null, class/spec quedan como evidencia descriptiva (mayoría simple)', () => {
    const observations = [
      obs('Priest', 'UnknownSpec', 0),
      obs('Priest', 'UnknownSpec', 1),
      obs('Priest', null, 2),
    ];

    const result = resolveNightPlayerIdentity(observations);

    expect(result.role).toBeNull();
    expect(result.spec).toBe('UnknownSpec');
    expect(result.className).toBe('Priest');
  });

  it('una sola observación se devuelve a sí misma', () => {
    const result = resolveNightPlayerIdentity([obs('Mage', 'Frost', 0)]);

    expect(result).toEqual({ className: 'Mage', spec: 'Frost', role: 'Ranged' });
  });
});

describe('resolveDominantClassSpec · mayoría + desempate por reciente', () => {
  it('la (class,spec) con más pulls gana', () => {
    const result = resolveDominantClassSpec([
      obs('Druid', 'Balance', 0),
      obs('Druid', 'Balance', 1),
      obs('Druid', 'Feral', 2),
    ]);

    expect(result).toEqual({ className: 'Druid', spec: 'Balance' });
  });

  it('en empate gana la vista en el pull más reciente (mayor orderIndex)', () => {
    const result = resolveDominantClassSpec([obs('Druid', 'Balance', 0), obs('Druid', 'Feral', 5)]);

    expect(result).toEqual({ className: 'Druid', spec: 'Feral' });
  });
});
