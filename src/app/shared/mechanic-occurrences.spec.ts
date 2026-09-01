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

  it('aligns the same occurrence index across fights with different lengths', () => {
    const grouped = groupMechanicOccurrenceOffsets([
      [10_000, 30_000, 50_000],
      [12_000, 33_000],
      [11_000],
    ]);

    expect([...grouped.entries()]).toEqual([
      [1, [10_000, 12_000, 11_000]],
      [2, [30_000, 33_000]],
      [3, [50_000]],
    ]);
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
