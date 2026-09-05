import { describe, expect, it } from 'vitest';
import {
  attributeDamageToMechanicCasts,
  ownerOccurrenceIndexForDeath,
} from '../../../supabase/functions/_shared/mechanic-event-attribution';

describe('mechanic event attribution', () => {
  it('atribuye una sola vez un hit que cae dentro de muchas ventanas solapadas', () => {
    const casts = [
      67_588,
      68_386,
      68_576,
      68_982,
      69_253,
      70_003,
      70_454,
      71_099,
      71_241,
      // Duplicado exacto observado en el caso real: no crea otra occurrence.
      71_241,
    ].map((timestamp) => ({ timestamp, abilityGameID: 1_285_017, sourceID: 9001 }));
    const hits = [{ timestamp: 71_300, abilityGameID: 1_285_017, sourceID: 9001, targetID: 42, amount: 52_010 }];

    const result = attributeDamageToMechanicCasts(casts, hits, [1_285_017], 4_000);

    expect(result.occurrences).toHaveLength(9);
    expect(result.occurrences.flatMap((occurrence) => occurrence.damageEvents)).toHaveLength(1);
    expect(result.occurrences.reduce((sum, occurrence) => sum + occurrence.damageEvents.reduce((n, hit) => n + (hit.amount ?? 0), 0), 0)).toBe(52_010);
    expect(result.occurrences.find((occurrence) => occurrence.damageEvents.length)?.timestamp).toBe(71_241);
    expect(result.unassignedDamageEvents).toHaveLength(0);
  });

  it('no deduplica dos hits reales aunque amount y timestamp coincidan', () => {
    const casts = [{ timestamp: 10_000, abilityGameID: 7, sourceID: 10 }];
    const hits = [
      { timestamp: 10_500, abilityGameID: 7, sourceID: 10, targetID: 1, amount: 52_010 },
      { timestamp: 10_500, abilityGameID: 7, sourceID: 10, targetID: 1, amount: 52_010 },
    ];

    const result = attributeDamageToMechanicCasts(casts, hits, [7], 4_000);

    expect(result.occurrences[0].damageEvents).toHaveLength(2);
    expect(result.occurrences[0].damageEventIndexes).toEqual([0, 1]);
  });

  it('usa sourceID para conservar casts simultáneos de NPC distintos', () => {
    const casts = [
      { timestamp: 10_000, abilityGameID: 7, sourceID: 100 },
      { timestamp: 10_050, abilityGameID: 7, sourceID: 200 },
    ];
    const hits = [
      { timestamp: 10_400, abilityGameID: 7, sourceID: 100, targetID: 1 },
      { timestamp: 10_450, abilityGameID: 7, sourceID: 200, targetID: 2 },
    ];

    const result = attributeDamageToMechanicCasts(casts, hits, [7], 4_000);

    expect(result.occurrences[0].damageEvents.map((hit) => hit.targetID)).toEqual([1]);
    expect(result.occurrences[1].damageEvents.map((hit) => hit.targetID)).toEqual([2]);
  });

  it('no exige sourceID cuando el actor que hace daño difiere del caster', () => {
    const casts = [
      { timestamp: 10_000, abilityGameID: 7, sourceID: 100 },
      { timestamp: 11_000, abilityGameID: 7, sourceID: 100 },
    ];
    const hits = [{ timestamp: 11_500, abilityGameID: 7, sourceID: 999, targetID: 1 }];

    const result = attributeDamageToMechanicCasts(casts, hits, [7], 4_000);

    expect(result.occurrences[0].damageEvents).toHaveLength(0);
    expect(result.occurrences[1].damageEvents).toHaveLength(1);
  });

  it('devuelve como huérfano el daño que no pertenece causalmente a ningún cast', () => {
    const result = attributeDamageToMechanicCasts(
      [{ timestamp: 10_000, abilityGameID: 7 }],
      [{ timestamp: 20_000, abilityGameID: 7, targetID: 1 }],
      [7],
      4_000,
    );

    expect(result.occurrences[0].damageEvents).toHaveLength(0);
    expect(result.unassignedDamageEventIndexes).toEqual([0]);
  });

  it('una muerte hereda el owner del hit terminal y no convierte varios casts en fail', () => {
    const result = attributeDamageToMechanicCasts(
      [
        { timestamp: 10_000, abilityGameID: 7 },
        { timestamp: 11_000, abilityGameID: 7 },
        { timestamp: 12_000, abilityGameID: 7 },
      ],
      [{ timestamp: 12_500, abilityGameID: 7, targetID: 1 }],
      [7],
      4_000,
    );

    const owner = ownerOccurrenceIndexForDeath(
      { timestamp: 12_500, targetID: 1, killingAbilityGameID: 7 },
      result.occurrences,
      4_000,
    );

    expect(owner).toBe(2);
  });

  it('prefiere ability exacta cuando varios IDs representan la misma mecánica lógica', () => {
    const result = attributeDamageToMechanicCasts(
      [
        { timestamp: 10_000, abilityGameID: 70, sourceID: 1 },
        { timestamp: 10_100, abilityGameID: 71, sourceID: 1 },
      ],
      [{ timestamp: 10_500, abilityGameID: 70, sourceID: 1, targetID: 1 }],
      [70, 71],
      4_000,
    );

    expect(result.occurrences[0].damageEvents).toHaveLength(1);
    expect(result.occurrences[1].damageEvents).toHaveLength(0);
  });
});
