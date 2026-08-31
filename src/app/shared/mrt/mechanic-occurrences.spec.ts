import { describe, expect, it } from 'vitest';
import { combineOccurrencesIntoDamageWindows, reconstructMechanicOccurrences } from './mechanic-occurrences.util';

describe('reconstructMechanicOccurrences', () => {
  it('keeps repeated casts as separate moments instead of one global median', () => {
    const offsets: number[] = [];
    for (const drift of [-1500, -700, 0, 600, 1200]) offsets.push(40_000 + drift, 130_000 + drift, 240_000 + drift);
    const out = reconstructMechanicOccurrences({ abilityId: 1, name: 'Pulse', castOffsetSamplesMs: offsets, sampleFightCount: 5, impactScore: 100, priority: 5 });
    expect(out.map((o) => Math.round(o.timeMs / 1000))).toEqual([40, 130, 240]);
  });

  it('drops a one-off timing outlier when reference support is broad', () => {
    const out = reconstructMechanicOccurrences({ abilityId: 1, name: 'Pulse', castOffsetSamplesMs: [40_000, 40_500, 39_700, 41_000, 310_000], sampleFightCount: 5, impactScore: 100, priority: 5 });
    expect(out).toHaveLength(1);
  });
});

describe('combineOccurrencesIntoDamageWindows', () => {
  it('combines mechanics that overlap into one pressure window', () => {
    const windows = combineOccurrencesIntoDamageWindows([
      { occurrenceId: '1:0', abilityId: 1, name: 'Mutilate', occurrenceIndex: 0, timeMs: 147000, support: 5, supportFraction: 1, impactScore: 100, priority: 4 },
      { occurrenceId: '2:0', abilityId: 2, name: 'Tempest', occurrenceIndex: 0, timeMs: 148000, support: 5, supportFraction: 1, impactScore: 70, priority: 3 },
      { occurrenceId: '3:0', abilityId: 3, name: 'Later', occurrenceIndex: 0, timeMs: 180000, support: 5, supportFraction: 1, impactScore: 50, priority: 3 },
    ]);
    expect(windows).toHaveLength(2);
    expect(windows[0].impactScore).toBe(170);
    expect(windows[0].occurrences.map((o) => o.name)).toEqual(['Mutilate', 'Tempest']);
  });
});
