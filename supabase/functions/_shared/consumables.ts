// Piedra de Brujo y poción de vida — WCL los ve como casts normales (no hay
// un dataType "Consumibles" aparte), así que la única forma fiable de saber
// SU abilityId es buscarlos por nombre en masterData.abilities de CADA
// report, nunca un ID fijo a mano: "Healthstone" es estable desde hace
// muchísimas expansiones, pero el nombre de la poción de vida cambia cada
// tier (verificado en real 2026-08-22 contra un report actual: el tier en
// curso usa "Silvermoon Health Potion" / "Concentrated Silvermoon Health
// Potion" — nada que ver con nombres de tiers anteriores). Buscar por
// patrón "health(ing) potion" en vez de un nombre fijo hace que esto siga
// funcionando solo cuando cambie otra vez el tier, sin tocar código.
import type { WclAbility } from './wcl-client.ts';

export interface ConsumableAbilityIds {
  healthstoneId: number | null;
  healthPotionIds: Set<number>;
}

export function resolveConsumableAbilityIds(abilities: WclAbility[]): ConsumableAbilityIds {
  const healthstone = abilities.find((a) => a.name === 'Healthstone');
  const healthPotionIds = new Set(abilities.filter((a) => /health(ing)? potion/i.test(a.name)).map((a) => a.gameID));
  return { healthstoneId: healthstone?.gameID ?? null, healthPotionIds };
}

export interface ConsumableUsage {
  healthstone: { available: boolean; used: boolean; count: number; timestampsMs: number[] };
  healthPotion: { used: boolean; count: number; timestampsMs: number[] };
}

/**
 * `available` de healthstone: hubo un Warlock en la friendly list de ESTE
 * pull. Blizzard permite llevar una piedra crafteada por cualquiera aunque
 * no haya warlock presente, así que esto es un mínimo verificable, no el
 * máximo teórico — si no hay warlock y el jugador no la usó, se deja
 * `available: false` en vez de asumir que la tenía igualmente (más honesto
 * que adivinar; ver misma idea en DefensiveOption.status 'unknown').
 */
export function buildConsumableUsage(
  castTimestampsBySpell: Map<number, number[]> | undefined,
  ids: ConsumableAbilityIds,
  fightStartTime: number,
  warlockPresent: boolean,
): ConsumableUsage {
  const healthstoneTimestamps = (ids.healthstoneId != null ? castTimestampsBySpell?.get(ids.healthstoneId) : undefined) ?? [];
  const healthPotionTimestamps: number[] = [];
  for (const id of ids.healthPotionIds) {
    for (const t of castTimestampsBySpell?.get(id) ?? []) healthPotionTimestamps.push(t);
  }
  healthPotionTimestamps.sort((a, b) => a - b);

  return {
    healthstone: {
      available: warlockPresent || healthstoneTimestamps.length > 0, // si la usó, obviamente la tenía disponible, aunque no detectemos warlock (pudo craftearla ella misma)
      used: healthstoneTimestamps.length > 0,
      count: healthstoneTimestamps.length,
      timestampsMs: healthstoneTimestamps.map((t) => t - fightStartTime),
    },
    healthPotion: {
      used: healthPotionTimestamps.length > 0,
      count: healthPotionTimestamps.length,
      timestampsMs: healthPotionTimestamps.map((t) => t - fightStartTime),
    },
  };
}
