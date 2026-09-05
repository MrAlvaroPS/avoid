// §E4 (iris-defensive-canonicalization-v1-plan.md — Episode Evaluator,
// "TIMING: remove the mechanism heuristic"): este módulo es el evaluador
// temporal puro y único. Separa activación, oportunidad y cobertura para no
// convertir una señal parcial en una certeza causal.

import type { TimingRelation } from './defensive-applicability.ts';

export type TemporalTriState = 'yes' | 'no' | 'unknown';
export type ActivationProvenance =
  | 'player_cast'
  | 'player_cast_and_observed_aura'
  | 'observed_aura_only'
  | 'none';

/** Intervalo de efecto/aura REALMENTE observado (p. ej. Buffs(target) de WCL). */
export interface ObservedEffectInterval {
  startMs: number;
  /** null = seguía activo al final de la ventana de eventos pedida. */
  endMs: number | null;
}

export interface TemporalEpisodeWindow {
  startMs: number;
  endMs: number;
  peakMs: number;
}

export interface TemporalCoverageInput {
  timingRelation: TimingRelation | null;
  effectiveDurationMs: number | null;
  castsForSpellMs: readonly number[];
  episode: TemporalEpisodeWindow;
  damageTimestampsMs?: readonly number[];
  afterDamageResponseWindowMs: number;
  evaluationEndMs: number | null;
  observedActiveIntervals?: readonly ObservedEffectInterval[];
}

export interface TemporalCoverageResult {
  engagement: boolean;
  opportunity: TemporalTriState;
  castCoverage: TemporalTriState;
  reason: string;
  evidence: Record<string, unknown>;
}

interface CoreResult {
  engagement: boolean;
  castCoverage: TemporalTriState;
  reason: string;
  evidence?: Record<string, unknown>;
}

export function normalizeCastTimestamps(timestamps: readonly number[]): number[] {
  const finite = timestamps.filter((t) => Number.isFinite(t));
  return [...new Set(finite)].sort((a, b) => a - b);
}

function intervalCoversTimestamp(interval: ObservedEffectInterval, timestampMs: number): boolean {
  return timestampMs >= interval.startMs && (interval.endMs == null || timestampMs <= interval.endMs);
}

function intervalCoveringPeak(
  intervals: readonly ObservedEffectInterval[] | undefined,
  peakMs: number,
): ObservedEffectInterval | null {
  if (!intervals?.length) return null;
  return intervals.find((interval) => intervalCoversTimestamp(interval, peakMs)) ?? null;
}

function castsEstablishingInterval(
  casts: readonly number[],
  interval: ObservedEffectInterval,
  effectiveDurationMs: number | null,
): number[] {
  const normalized = normalizeCastTimestamps(casts);
  const applyToleranceMs = 1500;
  const nearApply = normalized.filter((t) => t >= interval.startMs - applyToleranceMs && t <= interval.startMs + applyToleranceMs);
  if (nearApply.length) return nearApply;
  if (effectiveDurationMs == null) return [];
  return normalized.filter((t) => t <= interval.startMs && t + effectiveDurationMs >= interval.startMs);
}

/**
 * Relaciona un cast con la trayectoria de aura observada. Además del apply
 * tolerado, un cast puede ocurrir dentro de un intervalo ya abierto (refresh).
 * Si WCL demuestra que ese intervalo terminó antes del pico, esa evidencia
 * negativa es más fuerte que la duración máxima teórica del tooltip.
 */
function observedIntervalsForCast(
  intervals: readonly ObservedEffectInterval[],
  castMs: number,
): ObservedEffectInterval[] {
  const applyToleranceMs = 1500;
  return intervals.filter((interval) =>
    castMs >= interval.startMs - applyToleranceMs &&
    (interval.endMs == null || castMs <= interval.endMs + applyToleranceMs)
  );
}

function beforeOrDuring(input: TemporalCoverageInput): CoreResult {
  const observedInterval = intervalCoveringPeak(input.observedActiveIntervals, input.episode.peakMs);
  if (observedInterval) {
    const establishingCasts = castsEstablishingInterval(input.castsForSpellMs, observedInterval, input.effectiveDurationMs);
    const engagement = establishingCasts.length > 0;
    const activationProvenance: ActivationProvenance = engagement
      ? 'player_cast_and_observed_aura'
      : 'observed_aura_only';
    return {
      engagement,
      castCoverage: 'yes',
      reason: engagement
        ? 'Intervalo de efecto observado cubre el pico y un cast del jugador demuestra la activación.'
        : 'Intervalo de efecto observado cubre el pico, pero no existe cast del mismo spell que permita acreditar Usage.',
      evidence: { activationProvenance, observedInterval, establishingCasts },
    };
  }

  const lookbackMs = input.effectiveDurationMs ?? 0;
  const lowerBound = input.episode.startMs - lookbackMs;
  const relevantCasts = normalizeCastTimestamps(input.castsForSpellMs)
    .filter((t) => t <= input.episode.endMs && t >= lowerBound);
  if (!relevantCasts.length) {
    return {
      engagement: false,
      castCoverage: 'no',
      reason: 'Ningún cast antes o durante el episodio (dentro del alcance de su propia duración conocida).',
      evidence: { activationProvenance: 'none' satisfies ActivationProvenance },
    };
  }

  const prePeakCasts = relevantCasts.filter((t) => t <= input.episode.peakMs);
  if (!prePeakCasts.length) {
    return {
      engagement: true,
      castCoverage: 'no',
      reason: 'El cast ocurrió dentro del episodio pero después del pico — Uso queda acreditado, pero un defensivo proactivo tarde no cubre el pico.',
      evidence: { activationProvenance: 'player_cast' satisfies ActivationProvenance, relevantCasts },
    };
  }
  if (input.effectiveDurationMs == null) {
    return {
      engagement: true,
      castCoverage: 'unknown',
      reason: 'Duración efectiva desconocida — no se puede demostrar si el efecto seguía activo en el pico.',
      evidence: { activationProvenance: 'player_cast' satisfies ActivationProvenance, relevantCasts },
    };
  }

  const theoreticallyCoveringCasts = prePeakCasts.filter(
    (t) => t + input.effectiveDurationMs! >= input.episode.peakMs,
  );
  if (!theoreticallyCoveringCasts.length) {
    return {
      engagement: true,
      castCoverage: 'no',
      reason: 'El cast expiró (según su duración efectiva) antes del pico.',
      evidence: {
        activationProvenance: 'player_cast' satisfies ActivationProvenance,
        relevantCasts,
        prePeakCasts,
      },
    };
  }

  const observedIntervals = input.observedActiveIntervals ?? [];
  if (observedIntervals.length) {
    const contradictedCasts: number[] = [];
    const unresolvedCasts: number[] = [];

    for (const castMs of theoreticallyCoveringCasts) {
      const associated = observedIntervalsForCast(observedIntervals, castMs);
      if (associated.some((interval) => intervalCoversTimestamp(interval, input.episode.peakMs))) {
        return {
          engagement: true,
          castCoverage: 'yes',
          reason: 'La trayectoria de aura observada asociada al cast demuestra el efecto activo en el pico.',
          evidence: {
            activationProvenance: 'player_cast_and_observed_aura' satisfies ActivationProvenance,
            relevantCasts,
            prePeakCasts,
            theoreticallyCoveringCasts,
            observedIntervals: associated,
          },
        };
      }

      if (associated.length && associated.every((interval) => interval.endMs != null && interval.endMs < input.episode.peakMs)) {
        contradictedCasts.push(castMs);
      } else {
        unresolvedCasts.push(castMs);
      }
    }

    if (!unresolvedCasts.length) {
      return {
        engagement: true,
        castCoverage: 'no',
        reason: 'WCL demuestra que el efecto observado terminó antes del pico; la duración máxima teórica no puede resucitarlo.',
        evidence: {
          activationProvenance: 'player_cast' satisfies ActivationProvenance,
          relevantCasts,
          prePeakCasts,
          theoreticallyCoveringCasts,
          contradictedCasts,
          observedActiveIntervals: observedIntervals,
          observedNegativePrecedence: true,
        },
      };
    }

    return {
      engagement: true,
      castCoverage: 'unknown',
      reason: 'Existe evidencia de aura observada para este spell, pero no permite vincular todos los casts teóricamente cubrientes; se evita fabricar cobertura por duración máxima.',
      evidence: {
        activationProvenance: 'player_cast' satisfies ActivationProvenance,
        relevantCasts,
        prePeakCasts,
        theoreticallyCoveringCasts,
        contradictedCasts,
        unresolvedCasts,
        observedActiveIntervals: observedIntervals,
      },
    };
  }

  return {
    engagement: true,
    castCoverage: 'yes',
    reason: 'Sin trayectoria de aura observada que lo contradiga, el cast y su duración efectiva conocida cubren el pico.',
    evidence: {
      activationProvenance: 'player_cast' satisfies ActivationProvenance,
      relevantCasts,
      prePeakCasts,
      theoreticallyCoveringCasts,
    },
  };
}

function afterDamage(input: TemporalCoverageInput): CoreResult {
  const cutoff = input.evaluationEndMs ?? Number.POSITIVE_INFINITY;
  const damageTimestamps = normalizeCastTimestamps(input.damageTimestampsMs ?? []);
  if (damageTimestamps.length) {
    const windows = damageTimestamps.map((hitMs) => ({
      hitMs,
      endMs: Math.min(hitMs + input.afterDamageResponseWindowMs, cutoff),
    }));
    const relevantCasts = input.castsForSpellMs.filter((castMs) =>
      windows.some((window) => castMs >= window.hitMs && castMs <= window.endMs),
    );
    const engagement = relevantCasts.length > 0;
    return {
      engagement,
      castCoverage: engagement ? 'yes' : 'no',
      reason: engagement
        ? `Cast reactivo dentro de ${input.afterDamageResponseWindowMs}ms de un hit real del episodio.`
        : `Ningún cast dentro de ${input.afterDamageResponseWindowMs}ms de los hits reales del episodio.`,
      evidence: {
        activationProvenance: engagement ? 'player_cast' : 'none',
        anchor: 'raw_damage_hits',
        windows,
        relevantCasts,
      },
    };
  }

  const windowEndMs = Math.min(
    input.episode.endMs + input.afterDamageResponseWindowMs,
    cutoff,
  );
  const relevantCasts = input.castsForSpellMs.filter((t) => t >= input.episode.startMs && t <= windowEndMs);
  const engagement = relevantCasts.length > 0;
  return {
    engagement,
    castCoverage: engagement ? 'yes' : 'no',
    reason: engagement
      ? `Cast reactivo dentro de la ventana agregada de compatibilidad (${input.afterDamageResponseWindowMs}ms).`
      : `Ningún cast dentro de la ventana reactiva agregada de compatibilidad (${input.afterDamageResponseWindowMs}ms).`,
    evidence: {
      activationProvenance: engagement ? 'player_cast' : 'none',
      anchor: 'episode_fallback',
      windowEndMs,
      relevantCasts,
    },
  };
}

function either(input: TemporalCoverageInput): CoreResult {
  const proactive = beforeOrDuring(input);
  const reactive = afterDamage(input);
  const engagement = proactive.engagement || reactive.engagement;
  let castCoverage: TemporalTriState;
  if (proactive.castCoverage === 'yes' || reactive.castCoverage === 'yes') castCoverage = 'yes';
  else if (proactive.castCoverage === 'unknown' || reactive.castCoverage === 'unknown') castCoverage = 'unknown';
  else castCoverage = 'no';
  return {
    engagement,
    castCoverage,
    reason: 'Timing either: se acepta cobertura proactiva (antes/durante) O reactiva (tras el daño).',
    evidence: { proactive, reactive },
  };
}

function continuousState(input: TemporalCoverageInput): CoreResult {
  const observedInterval = intervalCoveringPeak(input.observedActiveIntervals, input.episode.peakMs);
  if (observedInterval) {
    const establishingCasts = castsEstablishingInterval(input.castsForSpellMs, observedInterval, input.effectiveDurationMs);
    const engagement = establishingCasts.length > 0;
    return {
      engagement,
      castCoverage: 'yes',
      reason: engagement
        ? 'Intervalo observado demuestra el estado activo y un cast del jugador acredita su activación.'
        : 'Intervalo observado demuestra el estado activo, pero sin cast asociado no se acredita Usage.',
      evidence: {
        activationProvenance: engagement ? 'player_cast_and_observed_aura' : 'observed_aura_only',
        observedInterval,
        establishingCasts,
      },
    };
  }
  const relevantCasts = input.castsForSpellMs.filter((t) => t >= input.episode.startMs && t <= input.episode.endMs);
  return {
    engagement: relevantCasts.length > 0,
    castCoverage: 'unknown',
    reason: 'Estado continuo sin intervalo de efecto observado — no se fabrica cobertura; un cast solo acredita Usage.',
    evidence: {
      activationProvenance: relevantCasts.length ? 'player_cast' : 'none',
      relevantCasts,
    },
  };
}

function unknownRelation(input: TemporalCoverageInput): CoreResult {
  const relevantCasts = input.castsForSpellMs.filter((t) => t >= input.episode.startMs && t <= input.episode.endMs);
  return {
    engagement: relevantCasts.length > 0,
    castCoverage: 'unknown',
    reason: 'timingRelation no determinado — nunca se adivina cobertura ni oportunidad por timing.',
    evidence: {
      activationProvenance: relevantCasts.length ? 'player_cast' : 'none',
      relevantCasts,
    },
  };
}

export function evaluateTemporalCoverage(input: TemporalCoverageInput): TemporalCoverageResult {
  let opportunity: TemporalTriState;
  let core: CoreResult;

  switch (input.timingRelation) {
    case 'before_or_during':
      opportunity = 'yes';
      core = beforeOrDuring(input);
      break;
    case 'after_damage':
      opportunity = 'yes';
      core = afterDamage(input);
      break;
    case 'either':
      opportunity = 'yes';
      core = either(input);
      break;
    case 'continuous_state':
      opportunity = 'unknown';
      core = continuousState(input);
      break;
    default:
      opportunity = 'unknown';
      core = unknownRelation(input);
  }

  return {
    engagement: core.engagement,
    opportunity,
    castCoverage: core.castCoverage,
    reason: core.reason,
    evidence: { timingRelation: input.timingRelation, ...(core.evidence ?? {}) },
  };
}
