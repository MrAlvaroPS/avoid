import { describe, expect, it } from 'vitest';
import { buildRosterDefensivePlan } from './roster-defensive-planner.util';
import type { DamagePlanningWindow } from './mechanic-occurrences.util';

function window(id: string, seconds: number, impact: number): DamagePlanningWindow {
  return { windowId: id, timeMs: seconds * 1000, impactScore: impact, priority: 4, occurrences: [] };
}

describe('buildRosterDefensivePlan', () => {
  it('reserves the biggest future peak and still reuses the same CD earlier when it will recover', () => {
    const plan = buildRosterDefensivePlan(
      [window('early', 60, 70), window('big', 240, 100)],
      [{ spellId: 1, name: 'Fortify', survivalType: 'mitigation', effectiveCooldownMs: 120000 }],
    );
    expect(plan.assignments.map((a) => [a.windowId, a.timeMs])).toEqual([
      ['early', 60000],
      ['big', 240000],
    ]);
  });

  it('fills the whole fight repeatedly with a 90s effective cooldown', () => {
    const plan = buildRosterDefensivePlan(
      [window('a', 40, 60), window('b', 147, 100), window('c', 245, 80), window('d', 340, 70)],
      [{ spellId: 243435, name: 'Fortifying Brew', survivalType: 'mitigation', effectiveCooldownMs: 90000 }],
    );
    expect(plan.assignments.map((a) => a.windowId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not invent an impossible use inside cooldown', () => {
    const plan = buildRosterDefensivePlan(
      [window('big', 240, 100), window('too-close', 310, 90), window('later', 360, 80)],
      [{ spellId: 1, name: 'Fortify', survivalType: 'mitigation', effectiveCooldownMs: 120000 }],
    );
    expect(plan.assignments.map((a) => a.windowId)).toEqual(['big', 'later']);
    expect(plan.uncoveredWindowIds).toEqual(['too-close']);
  });

  it('allows a use exactly when the cooldown expires', () => {
    const plan = buildRosterDefensivePlan(
      [window('a', 120, 50), window('b', 240, 100)],
      [{ spellId: 1, name: 'Fortify', survivalType: 'mitigation', effectiveCooldownMs: 120000 }],
    );
    expect(plan.assignments).toHaveLength(2);
  });
});
