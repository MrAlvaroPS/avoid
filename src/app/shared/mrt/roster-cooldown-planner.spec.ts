import { planRosterCooldowns } from './roster-cooldown-planner.util';
import type { EffectiveDefensive } from './effective-defensive-resolver.util';
import type { DamageWindow } from './damage-window-timeline.util';

const fortify = {
  spellId: 115203, name: 'Fortifying Brew', category: 'personal_defensive', survivalType: 'mitigation',
  baseCooldownMs: 120_000, effectiveCooldownMs: 90_000, durationMs: 15_000, charges: 1,
  explanation: '120 s - 30 s = 90 s', appliedModifierSpellIds: [388813], warnings: [],
} as EffectiveDefensive;

function window(key: string, timeMs: number, score: number): DamageWindow {
  return { key, timeMs, impactScore: score, priority: 4, occurrences: [{ abilityId: Number(key), name: key, occurrenceIndex: 1, timeMs, sampleCount: 1, supportFraction: 1, impactScore: score, priority: 4 }] };
}

describe('planRosterCooldowns', () => {
  it('reserva el pico prioritario y rellena usos compatibles antes y después', () => {
    const result = planRosterCooldowns({
      windows: [window('1', 44_000, 40), window('2', 147_000, 100), window('3', 245_000, 70), window('4', 348_000, 60)],
      defensives: [fortify],
    });
    expect(result.map((assignment) => assignment.window.timeMs)).toEqual([44_000, 147_000, 245_000, 348_000]);
  });

  it('nunca usa un external como defensivo personal automático', () => {
    const external = { ...fortify, spellId: 116849, name: 'Life Cocoon', category: 'external_defensive' as const };
    expect(planRosterCooldowns({ windows: [window('1', 60_000, 100)], defensives: [external] })).toEqual([]);
  });
});
