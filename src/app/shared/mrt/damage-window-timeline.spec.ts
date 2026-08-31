import { buildDamageWindowTimeline, clusterMechanicOccurrences } from './damage-window-timeline.util';

describe('damage window timeline', () => {
  it('conserva todas las ocurrencias repetidas en vez de una única mediana', () => {
    const clusters = clusterMechanicOccurrences([42_000, 43_000, 97_000, 98_000, 148_000, 149_000]);
    expect(clusters).toHaveLength(3);
    expect(clusters.map((values) => Math.round(values.reduce((a, b) => a + b) / values.length))).toEqual([42_500, 97_500, 148_500]);
  });

  it('combina habilidades solapadas en una sola ventana más peligrosa', () => {
    const windows = buildDamageWindowTimeline([
      { abilityId: 1, name: 'Mutilate', offsetSamplesMs: [147_000], sampleFightCount: 1, impactScore: 100, priority: 4 },
      { abilityId: 2, name: 'Tempest', offsetSamplesMs: [148_000], sampleFightCount: 1, impactScore: 80, priority: 3 },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].impactScore).toBe(180);
    expect(windows[0].occurrences).toHaveLength(2);
  });

  it('descarta un timing aislado que no aparece en suficiente muestra', () => {
    const windows = buildDamageWindowTimeline([
      { abilityId: 1, name: 'Normal', offsetSamplesMs: [60_000, 61_000, 59_000, 300_000], sampleFightCount: 10, impactScore: 100, priority: 4 },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].timeMs).toBe(60_000);
  });

  it('conserva el ordinal exacto cuando existen offsets agrupados por fight', () => {
    const windows = buildDamageWindowTimeline([{
      abilityId: 1,
      name: 'Repetida',
      offsetSamplesMs: [],
      offsetsByFight: [
        { fightKey: 'a', offsetsMs: [40_000, 90_000, 140_000] },
        { fightKey: 'b', offsetsMs: [41_000, 92_000, 143_000] },
      ],
      sampleFightCount: 2,
      impactScore: 100,
      priority: 4,
    }]);
    expect(windows.map((window) => window.occurrences[0].occurrenceIndex)).toEqual([1, 2, 3]);
  });
});
