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
  healthstone: { available: boolean; used: boolean; usedReactively: boolean; count: number; timestampsMs: number[] };
  healthPotion: { used: boolean; usedReactively: boolean; count: number; timestampsMs: number[] };
}

/**
 * §"si tras sufrir daño uso la poción o piedra de brujo es un uso correcto.
 * Usarla por usarla no es correcto" (feedback real, 2026-08-30): antes
 * `used` (cualquier cast en cualquier momento del intento) era lo único que
 * alimentaba consumableScore/emergencyConsumableUses — se podía "aprobar" el
 * punto de consumibles con una piedra gastada al principio del pull sin
 * relación con la muerte real. Reactivo = el cast cae dentro de una ventana
 * de presión real de ESE jugador en ESE pull (mismo detector que ya usa
 * damage-pressure-windows.ts para defensivos — línea base propia ×2,5,
 * tramo sostenido) o justo después de ella, nunca "en cualquier momento".
 * Mismo margen que ya usa el resto del informe para "justo después de un
 * pico" (ATTRIBUTION_PAD_MS antes, 8s después — igual que nearestDefensiveCast
 * en la infografía): un jugador tarda un segundo en reaccionar y pulsar.
 */
const REACTIVE_PAD_BEFORE_MS = 2000;
const REACTIVE_PAD_AFTER_MS = 8000;

export function isReactiveConsumableUse(
  timestampsMs: number[],
  pressureWindowsMs: { startMs: number; endMs: number }[],
): boolean {
  return timestampsMs.some((t) =>
    pressureWindowsMs.some((w) => t >= w.startMs - REACTIVE_PAD_BEFORE_MS && t <= w.endMs + REACTIVE_PAD_AFTER_MS),
  );
}

/**
 * `available` de healthstone: hubo un Warlock en la friendly list de ESTE
 * pull. Blizzard permite llevar una piedra crafteada por cualquiera aunque
 * no haya warlock presente, así que esto es un mínimo verificable, no el
 * máximo teórico — si no hay warlock y el jugador no la usó, se deja
 * `available: false` en vez de asumir que la tenía igualmente (más honesto
 * que adivinar; ver misma idea en DefensiveOption.status 'unknown').
 *
 * `pressureWindowsMs`: las ventanas de presión YA calculadas para este mismo
 * jugador/pull (detectDamageWindows, en ms relativos al inicio del pull,
 * igual espacio que timestampsMs de aquí abajo) — se pasan ya calculadas en
 * vez de recalcularlas aquí para no depender de la serie de daño ni
 * duplicar ese cómputo (quien llama ya lo tiene a mano).
 */
export function buildConsumableUsage(
  castTimestampsBySpell: Map<number, number[]> | undefined,
  ids: ConsumableAbilityIds,
  fightStartTime: number,
  warlockPresent: boolean,
  pressureWindowsMs: { startMs: number; endMs: number }[] = [],
): ConsumableUsage {
  const healthstoneTimestamps = (ids.healthstoneId != null ? castTimestampsBySpell?.get(ids.healthstoneId) : undefined) ?? [];
  const healthPotionTimestamps: number[] = [];
  for (const id of ids.healthPotionIds) {
    for (const t of castTimestampsBySpell?.get(id) ?? []) healthPotionTimestamps.push(t);
  }
  healthPotionTimestamps.sort((a, b) => a - b);

  const healthstoneRelativeMs = healthstoneTimestamps.map((t) => t - fightStartTime);
  const healthPotionRelativeMs = healthPotionTimestamps.map((t) => t - fightStartTime);

  return {
    healthstone: {
      available: warlockPresent || healthstoneTimestamps.length > 0, // si la usó, obviamente la tenía disponible, aunque no detectemos warlock (pudo craftearla ella misma)
      used: healthstoneTimestamps.length > 0,
      usedReactively: isReactiveConsumableUse(healthstoneRelativeMs, pressureWindowsMs),
      count: healthstoneTimestamps.length,
      timestampsMs: healthstoneRelativeMs,
    },
    healthPotion: {
      used: healthPotionTimestamps.length > 0,
      usedReactively: isReactiveConsumableUse(healthPotionRelativeMs, pressureWindowsMs),
      count: healthPotionTimestamps.length,
      timestampsMs: healthPotionRelativeMs,
    },
  };
}
