// §E4 (iris-defensive-canonicalization-v1-plan.md — Episode Evaluator,
// "TIMING: remove the mechanism heuristic"): hasta E3.6 la ventana temporal
// de un candidato se decidía mirando `mechanisms` ("sustain" → 3s de gracia
// tras el episodio, cualquier otra cosa → el cast debía caer dentro del
// propio tramo). Eso es un atajo, no el contrato real — `ResolvedDefensive.
// applicability.timingRelation` (defensive-applicability.ts) YA es la fuente
// de verdad de cuándo un defensivo puede cubrir daño (before_or_during /
// after_damage / either / continuous_state / unknown), puesta ahí desde v10
// de classify-defensives. Este módulo es el evaluador temporal PURO y único
// que la sustituye.
//
// Deliberadamente separa TRES preguntas que el contrato viejo colapsaba en
// un único booleano:
//  - engagement: ¿hubo una activación real del jugador en la ventana de
//    decisión/efecto relevante? Una aura observada demuestra cobertura, pero
//    NO inventa Usage si no puede vincularse a un cast del mismo jugador.
//  - opportunity: ¿pudo este defensivo, en principio, ser una oportunidad
//    legítima para este episodio, solo por su relación temporal? (no mira
//    ningún cast concreto).
//  - castCoverage: ¿el/los cast(s) o el estado observado demuestran cobertura
//    de ESTE episodio? Cobertura observada y activación son claims distintos.
//
// Nunca fabrica certeza: sin duración conocida, sin intervalo de efecto
// observado, o con timingRelation null/unknown, degrada a 'unknown' en vez
// de adivinar — la falsa incertidumbre es aceptable en shadow, un falso
// missed_ready/covered_verified no lo es.

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
  /** ResolvedDefensive.applicability?.timingRelation — null cuando no hay applicability en absoluto. */
  timingRelation: TimingRelation | null;
  effectiveDurationMs: number | null;
  /** Timestamps de cast de ESTE spell — no se asume ordenado ni deduplicado, ver normalizeCastTimestamps. */
  castsForSpellMs: readonly number[];
  episode: TemporalEpisodeWindow;
  /** Timestamps de daño crudo que realmente pertenecen al episodio. after_damage se ancla a estos hits, no al borde agregado del episodio. */
  damageTimestampsMs?: readonly number[];
  /** Política explícita del Episode Evaluator (§5.2) — persistida como evidencia, nunca un magic number oculto. */
  afterDamageResponseWindowMs: number;
  /** Cutoff de evaluación (wipe call) — la ventana de gracia reactiva nunca se extiende más allá de esto. null = sin cutoff conocido. */
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

/** Normaliza timestamps de cast UNA vez antes de cualquier evaluación de disponibilidad/causalidad (§9). */
export function normalizeCastTimestamps(timestamps: readonly number[]): number[] {
  const finite = timestamps.filter((t) => Number.isFinite(t));
  return [...new Set(finite)].sort((a, b) => a - b);
}

function intervalCoveringPeak(
  intervals: readonly ObservedEffectInterval[] | undefined,
  peakMs: number,
): ObservedEffectInterval | null {
  if (!intervals?.length) return null;
  return intervals.find((interval) => peakMs >= interval.startMs && (interval.endMs == null || peakMs <= interval.endMs)) ?? null;
}

/**
 * A Buffs interval is coverage evidence, not automatically activation evidence.
 * We credit Usage from an observed interval only when a same-spell player cast
 * can be associated with the aura application. This prevents derived/passive
 * auras (e.g. Shield of Vengeance-like effects) from becoming phantom button
 * presses while preserving Barrier/Bear Form when WCL also reports their cast.
 */
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

/** §5.1 — proactivo: coverage demostrada cuando el efecto está activo en el pico. */
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
  const relevantCasts = input.castsForSpellMs.filter((t) => t <= input.episode.endMs && t >= lowerBound);
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
  const covered = prePeakCasts.some((t) => t + input.effectiveDurationMs! >= input.episode.peakMs);
  return {
    engagement: true,
    castCoverage: covered ? 'yes' : 'no',
    reason: covered
      ? 'El cast, sumada su duración efectiva, sigue activo en el pico.'
      : 'El cast expiró (según su duración efectiva) antes del pico.',
    evidence: { activationProvenance: 'player_cast' satisfies ActivationProvenance, relevantCasts, prePeakCasts },
  };
}

/** §5.2 — reactivo: ventana explícita y versionada tras el daño, nunca un heurístico por nombre de mechanism. */
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

  // Compatibility fallback for pure callers/tests that do not have raw hits.
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

/** §5.3 — cualquiera de las dos rutas basta; nunca exige ambas. */
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

/** §5.4 — continuous state: aura puede demostrar cobertura; Usage exige activación vinculable. */
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

/** §5.5 — un cast real puede acreditar Uso, pero el timing nunca se adivina. */
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

/** Evaluador temporal puro único. */
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
