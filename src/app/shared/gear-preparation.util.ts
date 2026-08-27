import type { WclGearItem } from './models/domain';

// Índices del array CombatantInfo de WCL. TRINKET=12/13 ya se usa y
// contrasta esta misma tabla de posiciones en analyze-report.
export const ENCHANTABLE_SLOT_INDICES = new Set([0, 2, 4, 6, 7, 10, 11]); // cabeza, hombros, pecho, piernas, botas, anillos
export const GEMMABLE_SLOT_INDICES = new Set([1, 10, 11]); // cuello y anillos

export interface GearPreparationCounts {
  enchantedSlotCount: number;
  enchantableSlotCount: number;
  gemmedSlotCount: number;
  gemmableSlotCount: number;
  gemCount: number;
}

export function gearPreparationCounts(items: (WclGearItem | null)[]): GearPreparationCounts {
  let enchantedSlotCount = 0;
  let enchantableSlotCount = 0;
  let gemmedSlotCount = 0;
  let gemmableSlotCount = 0;
  let gemCount = 0;
  items.forEach((item, index) => {
    if (!item?.id) return;
    const gems = (item as WclGearItem & { gems?: unknown[] }).gems ?? [];
    gemCount += gems.length;
    if (ENCHANTABLE_SLOT_INDICES.has(index)) {
      enchantableSlotCount++;
      if (item.permanentEnchant != null && item.permanentEnchant > 0) enchantedSlotCount++;
    }
    if (GEMMABLE_SLOT_INDICES.has(index)) {
      gemmableSlotCount++;
      if (gems.length > 0) gemmedSlotCount++;
    }
  });
  return { enchantedSlotCount, enchantableSlotCount, gemmedSlotCount, gemmableSlotCount, gemCount };
}
