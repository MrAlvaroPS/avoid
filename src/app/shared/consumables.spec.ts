import { describe, expect, it } from 'vitest';
import {
  buildConsumableUsage,
  resolveConsumableAbilityIds,
} from '../../../supabase/functions/_shared/consumables';
import type { WclAbility } from '../../../supabase/functions/_shared/wcl-client';

function ability(gameID: number, name: string): WclAbility {
  return { gameID, name, type: 'Unknown', icon: '' };
}

describe('consumable Healthstone identity', () => {
  it('recognizes normal and Demonic Healthstone but not Create Healthstone', () => {
    const ids = resolveConsumableAbilityIds([
      ability(6262, 'Healthstone'),
      ability(452930, 'Demonic Healthstone'),
      ability(6201, 'Create Healthstone'),
      ability(123, 'Silvermoon Health Potion'),
    ]);

    expect([...ids.healthstoneIds].sort((a, b) => a - b)).toEqual([6262, 452930]);
    expect([...ids.healthPotionIds]).toEqual([123]);
  });

  it('aggregates Demonic Healthstone casts into the consumable KPI', () => {
    const ids = resolveConsumableAbilityIds([ability(452930, 'Demonic Healthstone')]);
    const usage = buildConsumableUsage(
      new Map([[452930, [110_000, 175_000, 240_000]]]),
      ids,
      100_000,
      true,
      [{ startMs: 70_000, endMs: 80_000 }],
    );

    expect(usage.healthstone).toMatchObject({
      available: true,
      used: true,
      count: 3,
      timestampsMs: [10_000, 75_000, 140_000],
      usedReactively: true,
    });
  });

  it('merges both runtime identities without double-path assumptions', () => {
    const ids = resolveConsumableAbilityIds([ability(6262, 'Healthstone'), ability(452930, 'Demonic Healthstone')]);
    const usage = buildConsumableUsage(
      new Map([
        [6262, [101_000]],
        [452930, [163_000, 226_000]],
      ]),
      ids,
      100_000,
      true,
    );

    expect(usage.healthstone.count).toBe(3);
    expect(usage.healthstone.timestampsMs).toEqual([1_000, 63_000, 126_000]);
  });
});
