import { describe, expect, it } from 'vitest';
import {
  groupDamageWindowsIntoEpisodes,
  type DefensiveEpisodeCandidate,
} from '../../../supabase/functions/_shared/defensive-episode-grouping';
import type { DamageWindow } from '../../../supabase/functions/_shared/damage-pressure-windows';

function window(overrides: Partial<DamageWindow> = {}): DamageWindow {
  return { startMs: 0, endMs: 1000, peakMs: 500, peakValue: 1000, ...overrides };
}

function candidate(overrides: Partial<DefensiveEpisodeCandidate> = {}): DefensiveEpisodeCandidate {
  return { window: window(), dominantAbilityGameId: 111, ...overrides };
}

describe('groupDamageWindowsIntoEpisodes', () => {
  it('groups a single candidate into a single episode', () => {
    const episodes = groupDamageWindowsIntoEpisodes([candidate()]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].memberIndexes).toEqual([0]);
    expect(episodes[0].groupingBasis).toBe('heuristic');
  });

  it('merges consecutive candidates from the same dominant ability within the continuity gap (Gusmï case: several ticks, one decision)', () => {
    const episodes = groupDamageWindowsIntoEpisodes([
      candidate({ window: window({ startMs: 0, endMs: 1000, peakValue: 500 }) }),
      candidate({ window: window({ startMs: 3000, endMs: 4000, peakValue: 900, peakMs: 3500 }) }), // gap 2000ms <= 6000ms default
      candidate({ window: window({ startMs: 8000, endMs: 9000, peakValue: 400 }) }), // gap 4000ms from previous endMs(4000) <= 6000
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].memberIndexes).toEqual([0, 1, 2]);
    expect(episodes[0].startMs).toBe(0);
    expect(episodes[0].endMs).toBe(9000);
    // el pico del episodio es el mayor peakValue entre sus miembros
    expect(episodes[0].peakValue).toBe(900);
    expect(episodes[0].peakMs).toBe(3500);
  });

  it('does NOT merge across a gap larger than the continuity window', () => {
    const episodes = groupDamageWindowsIntoEpisodes([
      candidate({ window: window({ startMs: 0, endMs: 1000 }) }),
      candidate({ window: window({ startMs: 10_000, endMs: 11_000 }) }), // gap 9000ms > 6000ms default
    ]);
    expect(episodes).toHaveLength(2);
  });

  it('does NOT merge candidates attributed to different dominant abilities, even if temporally adjacent', () => {
    const episodes = groupDamageWindowsIntoEpisodes([
      candidate({ window: window({ startMs: 0, endMs: 1000 }), dominantAbilityGameId: 111 }),
      candidate({ window: window({ startMs: 1500, endMs: 2000 }), dominantAbilityGameId: 222 }),
    ]);
    expect(episodes).toHaveLength(2);
  });

  it('never merges by heuristic when dominant ability is unknown (null) on either side — more episodes is safer than a false merge', () => {
    const episodes = groupDamageWindowsIntoEpisodes([
      candidate({ window: window({ startMs: 0, endMs: 1000 }), dominantAbilityGameId: null }),
      candidate({ window: window({ startMs: 1500, endMs: 2000 }), dominantAbilityGameId: null }),
    ]);
    expect(episodes).toHaveLength(2);
  });

  it('a shared real occurrenceId always merges, regardless of gap or dominant ability mismatch — causal evidence outranks the heuristic', () => {
    const episodes = groupDamageWindowsIntoEpisodes([
      candidate({ window: window({ startMs: 0, endMs: 1000 }), dominantAbilityGameId: 111, occurrenceId: 'occ-1' }),
      candidate({ window: window({ startMs: 60_000, endMs: 61_000 }), dominantAbilityGameId: 999, occurrenceId: 'occ-1' }),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].groupingBasis).toBe('occurrence');
    expect(episodes[0].occurrenceId).toBe('occ-1');
  });

  it('a group is only labelled groupingBasis=occurrence when EVERY member shares the same occurrenceId — a mixed group downgrades to heuristic', () => {
    const episodes = groupDamageWindowsIntoEpisodes([
      candidate({ window: window({ startMs: 0, endMs: 1000 }), dominantAbilityGameId: 111, occurrenceId: 'occ-1' }),
      // se fusiona por heurística (misma ability, dentro del gap), pero sin occurrenceId propio
      candidate({ window: window({ startMs: 3000, endMs: 4000 }), dominantAbilityGameId: 111, occurrenceId: null }),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].groupingBasis).toBe('heuristic');
    expect(episodes[0].occurrenceId).toBeNull();
  });

  it('sorts out-of-order input candidates by window.startMs before grouping', () => {
    const episodes = groupDamageWindowsIntoEpisodes([
      candidate({ window: window({ startMs: 5000, endMs: 6000 }), dominantAbilityGameId: 111 }),
      candidate({ window: window({ startMs: 0, endMs: 1000 }), dominantAbilityGameId: 111 }),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].startMs).toBe(0);
    expect(episodes[0].endMs).toBe(6000);
  });

  it('respects a custom continuityGapMs', () => {
    const candidates = [
      candidate({ window: window({ startMs: 0, endMs: 1000 }) }),
      candidate({ window: window({ startMs: 2000, endMs: 3000 }) }), // gap 1000ms
    ];
    expect(groupDamageWindowsIntoEpisodes(candidates, 500)).toHaveLength(2); // gap > 500ms custom
    expect(groupDamageWindowsIntoEpisodes(candidates, 6000)).toHaveLength(1); // gap <= 6000ms default-equivalent
  });
});
