export interface DamageProfileEvent {
  timestamp?: number;
  amount?: number;
  /** WCL suele exponer los recursos directamente en el evento crudo. */
  hitPoints?: number;
  maxHitPoints?: number;
  /** Compatibilidad con consumidores que los entreguen agrupados. */
  resources?: { hitPoints?: number; maxHitPoints?: number } | null;
}

export interface ComputedDamageProfile<T extends DamageProfileEvent> {
  damageProfile: 'burst' | 'sustained' | 'unknown';
  killingBlowAmount: number | null;
  damageWindowTotal: number;
  damageWindowHits: number;
  terminalBurstDamage: number;
  burstWindowMs: number;
  maxHitPoints: number | null;
  burstHealthPct: number | null;
  windowEvents: T[];
}

export const DEATH_DAMAGE_LOOKBACK_MS = 5000;
export const ONESHOT_BURST_WINDOW_MS = 1000;
export const ONESHOT_HEALTH_FRACTION = 0.8;

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Clasifica la forma de una muerte, no el estado de vida previo del jugador.
 * Un "oneshot" puede ser un solo impacto o varios ticks dentro del mismo
 * segundo: si ese bloque suma al menos el 80% de la vida máxima, no había una
 * ventana curable aunque el jugador ya estuviera algo tocado.
 *
 * Para logs antiguos sin recursos se conserva la regla anterior y se añade
 * una aproximación temporal conservadora: >=80% de todo el daño de los cinco
 * segundos finales concentrado en el último segundo.
 */
export function computeDamageProfile<T extends DamageProfileEvent>(
  sourceEvents: T[],
  deathTimestamp: number,
): ComputedDamageProfile<T> {
  const windowEvents = sourceEvents
    .filter((event) => (event.amount ?? 0) > 0
      && (event.timestamp ?? 0) <= deathTimestamp
      && (event.timestamp ?? 0) >= deathTimestamp - DEATH_DAMAGE_LOOKBACK_MS)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  if (!windowEvents.length) {
    return {
      damageProfile: 'unknown',
      killingBlowAmount: null,
      damageWindowTotal: 0,
      damageWindowHits: 0,
      terminalBurstDamage: 0,
      burstWindowMs: ONESHOT_BURST_WINDOW_MS,
      maxHitPoints: null,
      burstHealthPct: null,
      windowEvents,
    };
  }

  const damageWindowTotal = windowEvents.reduce((sum, event) => sum + (event.amount ?? 0), 0);
  const killingBlowAmount = Math.max(...windowEvents.map((event) => event.amount ?? 0));
  const terminalEvents = windowEvents.filter((event) => (event.timestamp ?? 0) >= deathTimestamp - ONESHOT_BURST_WINDOW_MS);
  const terminalBurstDamage = terminalEvents.reduce((sum, event) => sum + (event.amount ?? 0), 0);

  let maxHitPoints: number | null = null;
  for (const event of windowEvents) {
    maxHitPoints = positiveNumber(event.maxHitPoints)
      ?? positiveNumber(event.resources?.maxHitPoints)
      ?? maxHitPoints;
  }
  const burstHealthPct = maxHitPoints == null ? null : (terminalBurstDamage / maxHitPoints) * 100;
  const healthBasedBurst = burstHealthPct != null && burstHealthPct >= ONESHOT_HEALTH_FRACTION * 100;
  const temporalFallback = maxHitPoints == null
    && damageWindowTotal > 0
    && terminalBurstDamage / damageWindowTotal >= ONESHOT_HEALTH_FRACTION;
  const legacyDominantHit = windowEvents.length <= 3
    && damageWindowTotal > 0
    && killingBlowAmount / damageWindowTotal >= 0.6;

  return {
    damageProfile: healthBasedBurst || temporalFallback || legacyDominantHit ? 'burst' : 'sustained',
    killingBlowAmount,
    damageWindowTotal,
    damageWindowHits: windowEvents.length,
    terminalBurstDamage,
    burstWindowMs: ONESHOT_BURST_WINDOW_MS,
    maxHitPoints,
    burstHealthPct,
    windowEvents,
  };
}
