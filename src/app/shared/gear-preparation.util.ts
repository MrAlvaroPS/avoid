import type { WclGearItem } from './models/domain';

// Índices del array CombatantInfo de WCL. TRINKET=12/13 ya se usa y
// contrasta esta misma tabla de posiciones en analyze-report.
export const ENCHANTABLE_SLOT_INDICES = new Set([0, 2, 4, 6, 7, 10, 11]); // cabeza, hombros, pecho, piernas, botas, anillos
export const GEMMABLE_SLOT_INDICES = new Set([1, 10, 11]); // cuello y anillos

export const GEAR_SLOT_LABELS: Record<number, string> = {
  0: 'Cabeza',
  1: 'Cuello',
  2: 'Hombros',
  4: 'Pecho',
  6: 'Piernas',
  7: 'Botas',
  10: 'Anillo 1',
  11: 'Anillo 2',
};

export interface GearPreparationCounts {
  enchantedSlotCount: number;
  enchantableSlotCount: number;
  gemmedSlotCount: number;
  gemmableSlotCount: number;
  gemCount: number;
}

export interface GearPreparationDetails extends GearPreparationCounts {
  missingEnchantSlots: string[];
  missingGemSlots: string[];
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

/**
 * Mismo criterio que `gearPreparationCounts`, pero conserva los slots para
 * poder decirle al raider qué pieza debe corregir en vez de enseñar solo un
 * porcentaje agregado.
 */
export function gearPreparationDetails(items: (WclGearItem | null)[]): GearPreparationDetails {
  const counts = gearPreparationCounts(items);
  const missingEnchantSlots: string[] = [];
  const missingGemSlots: string[] = [];

  items.forEach((item, index) => {
    if (!item?.id) return;
    if (
      ENCHANTABLE_SLOT_INDICES.has(index) &&
      !(item.permanentEnchant != null && item.permanentEnchant > 0)
    ) {
      missingEnchantSlots.push(GEAR_SLOT_LABELS[index] ?? `Slot ${index}`);
    }
    if (GEMMABLE_SLOT_INDICES.has(index) && !(item.gems?.length ?? 0)) {
      missingGemSlots.push(GEAR_SLOT_LABELS[index] ?? `Slot ${index}`);
    }
  });

  return { ...counts, missingEnchantSlots, missingGemSlots };
}
