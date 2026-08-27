import { gearPreparationCounts } from './gear-preparation.util';
import type { WclGearItem } from './models/domain';

function item(permanentEnchant?: number, gems: unknown[] = []): WclGearItem {
  return { id: 1, itemLevel: 1, permanentEnchant, gems } as WclGearItem;
}

describe('gearPreparationCounts', () => {
  it('usa cabeza, hombros, pecho, piernas, botas y anillos para enchants', () => {
    const items = Array.from({ length: 17 }, () => item());
    for (const index of [0, 2, 4, 6, 7, 10, 11]) items[index] = item(123);
    const counts = gearPreparationCounts(items);
    expect(counts.enchantedSlotCount).toBe(7);
    expect(counts.enchantableSlotCount).toBe(7);
  });

  it('solo exige al menos una gema en cuello y cada anillo', () => {
    const items = Array.from({ length: 17 }, () => item());
    items[1] = item(undefined, [{ id: 1 }, { id: 2 }]);
    items[10] = item(undefined, [{ id: 3 }]);
    items[11] = item(undefined, [{ id: 4 }]);
    const counts = gearPreparationCounts(items);
    expect(counts.gemmedSlotCount).toBe(3);
    expect(counts.gemmableSlotCount).toBe(3);
    expect(counts.gemCount).toBe(4);
  });

  it('no considera muñecas ni capa como encantables esta season', () => {
    const items = Array.from({ length: 17 }, () => item());
    items[8] = item(123);
    items[14] = item(123);
    expect(gearPreparationCounts(items).enchantedSlotCount).toBe(0);
  });
});
