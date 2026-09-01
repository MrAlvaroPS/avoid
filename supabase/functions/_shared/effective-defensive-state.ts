import type { DefensiveResolutionConfidence, ResolvedDefensive } from './effective-defensives.ts';

export type EffectiveDefensiveStatus = 'active' | 'available_unused' | 'on_cooldown' | 'unknown';

export interface EffectiveDefensiveState {
  status: EffectiveDefensiveStatus;
  chargesAvailable: number | null;
  cooldownRemainingMs?: number;
  nextChargeAtMs?: number;
}

export interface EffectiveWindowOption {
  spellId: number;
  name: string;
  survivalType: ResolvedDefensive['survivalType'];
  confidence: DefensiveResolutionConfidence;
  status: EffectiveDefensiveStatus | 'used_during_window';
  chargesAvailable: number | null;
  cooldownRemainingMs?: number;
  nextChargeAtMs?: number;
}

export interface EffectiveWindowCoverage {
  covered: boolean;
  /** Sensor v2 no punitivo; el evaluator decide si era una oportunidad real. */
  availableOpportunity: boolean;
  options: EffectiveWindowOption[];
}

function personalCandidates(kit: ResolvedDefensive[]): ResolvedDefensive[] {
  return kit.filter(
    (defensive) =>
      defensive.eligible &&
      (defensive.category === 'personal_defensive' || defensive.category === 'semi_defensive') &&
      (defensive.targetingMode === 'self' || defensive.targetingMode === 'both'),
  );
}

/**
 * Replay determinista de cargas. WoW recarga cargas de forma secuencial: al
 * gastar desde el máximo arranca un reloj; cada tick devuelve una carga y, si
 * aún falta otra, programa el siguiente tick.
 */
export function effectiveDefensiveStateAt(
  defensive: ResolvedDefensive,
  castsForSpellMs: number[],
  atMs: number,
  buffActiveOverride = false,
): EffectiveDefensiveState {
  if (!defensive.eligible) return { status: 'unknown', chargesAvailable: null };
  const casts = castsForSpellMs.filter((timestamp) => Number.isFinite(timestamp) && timestamp <= atMs).sort((a, b) => a - b);
  const lastCast = casts.at(-1);

  if (lastCast != null && defensive.effectiveDurationMs != null) {
    if (atMs - lastCast <= defensive.effectiveDurationMs) {
      return { status: 'active', chargesAvailable: null };
    }
  } else if (defensive.effectiveDurationMs == null && buffActiveOverride) {
    return { status: 'active', chargesAvailable: null };
  }

  if (!casts.length) return { status: 'available_unused', chargesAvailable: defensive.charges };
  const rechargeMs = defensive.rechargeMs ?? defensive.effectiveCooldownMs;
  if (rechargeMs == null || !Number.isFinite(rechargeMs) || rechargeMs < 0 || defensive.charges < 1) {
    return { status: 'unknown', chargesAvailable: null };
  }

  let available = defensive.charges;
  let nextChargeAtMs: number | null = null;
  let replayAnomaly = false;
  const advanceTo = (timestamp: number): void => {
    while (available < defensive.charges && nextChargeAtMs != null && nextChargeAtMs <= timestamp) {
      available++;
      nextChargeAtMs = available < defensive.charges ? nextChargeAtMs + rechargeMs : null;
    }
  };

  for (const castAtMs of casts) {
    advanceTo(castAtMs);
    if (available <= 0) {
      // Puede ser un duplicado del log o CDR dinámico/conditional que el
      // resolver no puede garantizar. El cast es real, pero no se penaliza
      // usando una timeline inventada.
      replayAnomaly = true;
      nextChargeAtMs = castAtMs + rechargeMs;
      continue;
    }
    const wasFull = available === defensive.charges;
    available--;
    if (wasFull) nextChargeAtMs = castAtMs + rechargeMs;
  }
  advanceTo(atMs);

  if (replayAnomaly) {
    return {
      status: 'unknown',
      chargesAvailable: available,
      ...(nextChargeAtMs != null ? { nextChargeAtMs, cooldownRemainingMs: Math.max(0, nextChargeAtMs - atMs) } : {}),
    };
  }

  if (available > 0) {
    return {
      status: 'available_unused',
      chargesAvailable: available,
      ...(nextChargeAtMs != null ? { nextChargeAtMs } : {}),
    };
  }
  if (nextChargeAtMs == null) return { status: 'unknown', chargesAvailable: 0 };
  return {
    status: 'on_cooldown',
    chargesAvailable: 0,
    cooldownRemainingMs: Math.max(0, nextChargeAtMs - atMs),
    nextChargeAtMs,
  };
}

export function effectiveDeathOptions(
  kit: ResolvedDefensive[],
  castsBySpellId: Map<number, number[]>,
  deathAtMs: number,
  activeSpellIds: ReadonlySet<number> = new Set(),
): EffectiveWindowOption[] {
  return personalCandidates(kit).map((defensive) => ({
    spellId: defensive.spellId,
    name: defensive.name,
    survivalType: defensive.survivalType,
    confidence: defensive.confidence,
    ...effectiveDefensiveStateAt(defensive, castsBySpellId.get(defensive.spellId) ?? [], deathAtMs, activeSpellIds.has(defensive.spellId)),
  }));
}

export function evaluateEffectiveWindowCoverage(
  windowStartMs: number,
  windowEndMs: number,
  kit: ResolvedDefensive[],
  castsBySpellId: Map<number, number[]>,
): EffectiveWindowCoverage {
  const options: EffectiveWindowOption[] = personalCandidates(kit).map((defensive) => {
    const casts = castsBySpellId.get(defensive.spellId) ?? [];
    const usedDuringWindow = casts.some((timestamp) => timestamp >= windowStartMs && timestamp <= windowEndMs);
    const atStart = effectiveDefensiveStateAt(defensive, casts, windowStartMs);
    return {
      spellId: defensive.spellId,
      name: defensive.name,
      survivalType: defensive.survivalType,
      confidence: defensive.confidence,
      ...atStart,
      status: atStart.status === 'active' ? 'active' : usedDuringWindow ? 'used_during_window' : atStart.status,
    };
  });
  const covered = options.some((option) => option.status === 'active' || option.status === 'used_during_window');
  const availableOpportunity =
    !covered &&
    options.some(
      (option) =>
        option.status === 'available_unused' &&
        option.survivalType !== 'emergency' &&
        (option.confidence === 'verified' || option.confidence === 'inferred'),
    );
  return { covered, availableOpportunity, options };
}
