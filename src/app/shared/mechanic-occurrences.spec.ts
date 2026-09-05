import { describe, expect, it } from 'vitest';
import {
  groupMechanicOccurrenceOffsets,
  mechanicOccurrenceOffsetsForFight,
  summarizeOccurrenceOffsets,
} from '../../../supabase/functions/_shared/mechanic-occurrences';

describe('mechanic occurrences', () => {
  it('orders real casts inside one fight and deduplicates timestamp aliases', () => {
    const offsets = mechanicOccurrenceOffsetsForFight(
      [
        { timestamp: 35_000, abilityGameID: 20, sourceID: 1 },
        { timestamp: 15_000, abilityGameID: 10, sourceID: 1 },
        { timestamp: 15_000, abilityGameID: 20, sourceID: 1 },
        { timestamp: 25_000, abilityGameID: 999 },
        { timestamp: 9_000, abilityGameID: 10 },
      ],
      [10, 20],
      10_000,
    );

    expect(offsets).toEqual([5_000, 25_000]);
  });

  it('keeps simultaneous casts from different enemies as distinct occurrences', () => {
    expect(
      mechanicOccurrenceOffsetsForFight(
        [
          { timestamp: 15_000, abilityGameID: 10, sourceID: 1 },
          { timestamp: 15_000, abilityGameID: 10, sourceID: 2 },
        ],
        [10],
        10_000,
      ),
    ).toEqual([5_000, 5_000]);
  });

  it('clusters the same real occurrence across fights of different lengths by time proximity', () => {
    const grouped = groupMechanicOccurrenceOffsets([
      [10_000, 30_000, 50_000],
      [12_000, 33_000],
      [11_000],
    ]);

    // Mismo agrupamiento que la alineación posicional antigua para este caso
    // "bien portado" (mismo número aproximado de casts, sin huecos), pero el
    // orden dentro de cada cluster es ahora cronológico (no orden de fight).
    expect([...grouped.entries()]).toEqual([
      [1, [10_000, 11_000, 12_000]],
      [2, [30_000, 33_000]],
      [3, [50_000]],
    ]);
  });

  // §"si una habilidad pasó en un pull en el 0:03 y en otro en el 0:04, te
  // marca que uses dos defensivos distintos sin identificar que es la misma
  // habilidad" (feedback real, 2026-09-03). Reproduce el bug de alineación
  // POSICIONAL: el pull B se salta la ocurrencia real #2 (mecánica
  // condicional que no siempre dispara), así que su cast de la ocurrencia
  // real #3 cae en la POSICIÓN #2 dentro de ese pull. La alineación por
  // índice mezclaría esa muestra con la ocurrencia #2 real de los pulls A/C
  // y dejaría la ocurrencia #3 incompleta. El clustering por proximidad
  // temporal no se ve afectado por la posición dentro del pull.
  it('is not fooled by a skipped mid-pull occurrence that shifts positional index', () => {
    const grouped = groupMechanicOccurrenceOffsets([
      [10_000, 40_000, 70_000], // pull A: 3 ocurrencias reales
      [11_000, 71_000], // pull B: se saltó la ocurrencia real #2
      [9_000, 39_000, 69_000], // pull C: 3 ocurrencias reales
    ]);

    expect([...grouped.entries()]).toEqual([
      [1, [9_000, 10_000, 11_000]],
      [2, [39_000, 40_000]], // pull B ausente aquí — correcto, se la saltó
      [3, [69_000, 70_000, 71_000]], // pull B vuelve a aparecer en la #3 real
    ]);
  });

  // §"esta cubriendo varias mecanicas con distintos defensivos... no debe
  // estar teniendo en cuenta... duracion" (feedback real, 2026-09-03, con
  // capturas reales de Magzil/Gusmï mostrando una "ocurrencia" con ventana
  // p10/p90 de más de 70 segundos). Encadenar solo contra la muestra
  // anterior deja que un cluster derive sin límite: A-B cerca, B-C cerca...
  // aunque A y la última estén a varios segundos. Con tolerancia 1000ms
  // (mínimo posible) y 7 muestras separadas 900ms cada una, la versión
  // anterior las fundía en UN cluster de 5.4s de ancho.
  it('never lets a cluster drift wider than the tolerance via chained gaps', () => {
    const grouped = groupMechanicOccurrenceOffsets([
      [100_000, 102_000], // fija minRealGapMs=2000 -> tolerancia=1000ms (mínimo)
      [0],
      [900],
      [1_800],
      [2_700],
      [3_600],
      [4_500],
      [5_400],
    ]);

    for (const offsets of grouped.values()) {
      const span = Math.max(...offsets) - Math.min(...offsets);
      expect(span).toBeLessThanOrEqual(1_000);
    }
    // Ninguna ocurrencia real junta muestras separadas más de la tolerancia,
    // así que las 7 muestras de la ráfaga no pueden colapsar en un único cluster.
    expect(grouped.size).toBeGreaterThan(1);
  });

  it('calculates deterministic median and p10/p90 timings', () => {
    expect(summarizeOccurrenceOffsets([14_000, 10_000, 12_000, 16_000, 18_000])).toEqual({
      medianOffsetMs: 14_000,
      p10OffsetMs: 10_800,
      p90OffsetMs: 17_200,
    });
    expect(summarizeOccurrenceOffsets([])).toBeNull();
  });
});
