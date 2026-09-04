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
//  - engagement: ¿hubo un cast real en la ventana de decisión/efecto
//    relevante? (señal de Uso, independiente de si cubrió algo).
//  - opportunity: ¿pudo este defensivo, en principio, ser una oportunidad
//    legítima para este episodio, solo por su relación temporal? (no mira
//    ningún cast concreto).
//  - castCoverage: ¿el/los cast(s) realmente usados demuestran cobertura de
//    ESTE episodio? (un Barkskin proactivo lanzado ya pasado el pico puede
//    tener engagement=true, opportunity='yes', castCoverage='no').
//
// Nunca fabrica certeza: sin duración conocida, sin intervalo de efecto
// observado, o con timingRelation null/unknown, degrada a 'unknown' en vez
// de adivinar — la falsa incertidumbre es aceptable en shadow, un falso
// missed_ready/covered_verified no lo es.

import type { TimingRelation } from './defensive-applicability.ts';

export type TemporalTriState = 'yes' | 'no' | 'unknown';

/** Intervalo de efecto/aura REALMENTE observado (p. ej. Buffs(target) de WCL) — más fuerte que cast+duración teóricos. Ningún caller de E4 lo puebla todavía (§5: "no implementar un subsistema de fetch de auras en esta tarea") — el shape existe para que una fuente futura lo rellene sin tocar este módulo. */
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

/** Normaliza timestamps de cast UNA vez antes de cualquier evaluación de disponibilidad/causalidad (§9): solo finitos, orden ascendente determinista, sin duplicados exactos. No asume que el array de entrada ya viene ordenado. */
export function normalizeCastTimestamps(timestamps: readonly number[]): number[] {
  const finite = timestamps.filter((t) => Number.isFinite(t));
  return [...new Set(finite)].sort((a, b) => a - b);
}

function intervalCoversPeak(intervals: readonly ObservedEffectInterval[] | undefined, peakMs: number): boolean {
  if (!intervals?.length) return false;
  return intervals.some((interval) => peakMs >= interval.startMs && (interval.endMs == null || peakMs <= interval.endMs));
}

/** §5.1 — proactivo: coverage demostrada cuando el efecto está activo en el pico. Un cast dentro del episodio pero DESPUÉS del pico cuenta como engagement (Uso) pero nunca como cobertura verificada de un defensivo proactivo. */
function beforeOrDuring(input: TemporalCoverageInput): CoreResult {
  if (intervalCoversPeak(input.observedActiveIntervals, input.episode.peakMs)) {
    return { engagement: true, castCoverage: 'yes', reason: 'Intervalo de efecto observado demuestra el defensivo activo en el pico.' };
  }
  const lookbackMs = input.effectiveDurationMs ?? 0;
  const lowerBound = input.episode.startMs - lookbackMs;
  const relevantCasts = input.castsForSpellMs.filter((t) => t <= input.episode.endMs && t >= lowerBound);
  if (!relevantCasts.length) {
    return { engagement: false, castCoverage: 'no', reason: 'Ningún cast antes o durante el episodio (dentro del alcance de su propia duración conocida).' };
  }
  const prePeakCasts = relevantCasts.filter((t) => t <= input.episode.peakMs);
  if (!prePeakCasts.length) {
    return {
      engagement: true,
      castCoverage: 'no',
      reason: 'El cast ocurrió dentro del episodio pero después del pico — Uso queda acreditado, pero un defensivo proactivo tarde no cubre el pico.',
    };
  }
  if (input.effectiveDurationMs == null) {
    return { engagement: true, castCoverage: 'unknown', reason: 'Duración efectiva desconocida — no se puede demostrar si el efecto seguía activo en el pico.' };
  }
  const covered = prePeakCasts.some((t) => t + input.effectiveDurationMs! >= input.episode.peakMs);
  return {
    engagement: true,
    castCoverage: covered ? 'yes' : 'no',
    reason: covered
      ? 'El cast, sumada su duración efectiva, sigue activo en el pico.'
      : 'El cast expiró (según su duración efectiva) antes del pico.',
  };
}

/** §5.2 — reactivo: ventana explícita y versionada tras el daño, nunca un heurístico por nombre de mechanism. */
function afterDamage(input: TemporalCoverageInput): CoreResult {
  const windowEndMs = Math.min(
    input.episode.endMs + input.afterDamageResponseWindowMs,
    input.evaluationEndMs ?? Number.POSITIVE_INFINITY,
  );
  const relevantCasts = input.castsForSpellMs.filter((t) => t >= input.episode.startMs && t <= windowEndMs);
  const engagement = relevantCasts.length > 0;
  return {
    engagement,
    castCoverage: engagement ? 'yes' : 'no',
    reason: engagement
      ? `Cast reactivo dentro de la ventana de respuesta explícita (${input.afterDamageResponseWindowMs}ms tras el episodio).`
      : `Ningún cast dentro de la ventana de respuesta reactiva (${input.afterDamageResponseWindowMs}ms tras el episodio).`,
    evidence: { windowEndMs },
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

/** §5.4 — un mero cast histórico no basta para afirmar que un estado indefinido seguía activo en el pico sin un intervalo de efecto observado; nunca fabrica una oportunidad negativa desde la mera disponibilidad. */
function continuousState(input: TemporalCoverageInput): CoreResult {
  if (intervalCoversPeak(input.observedActiveIntervals, input.episode.peakMs)) {
    return { engagement: true, castCoverage: 'yes', reason: 'Intervalo de efecto observado demuestra el estado continuo activo en el pico.' };
  }
  const relevantCasts = input.castsForSpellMs.filter((t) => t >= input.episode.startMs && t <= input.episode.endMs);
  return {
    engagement: relevantCasts.length > 0,
    castCoverage: 'unknown',
    reason: 'Estado continuo sin intervalo de efecto observado — no se fabrica cobertura, y la mera disponibilidad nunca genera una oportunidad negativa.',
  };
}

/** §5.5 — un cast real puede acreditar Uso, pero el timing nunca se adivina. */
function unknownRelation(input: TemporalCoverageInput): CoreResult {
  const relevantCasts = input.castsForSpellMs.filter((t) => t >= input.episode.startMs && t <= input.episode.endMs);
  return {
    engagement: relevantCasts.length > 0,
    castCoverage: 'unknown',
    reason: 'timingRelation no determinado — nunca se adivina cobertura ni oportunidad por timing.',
  };
}

/**
 * Evaluador temporal puro único (§5): separa engagement/opportunity/
 * castCoverage para UN candidato + UN episodio. Nunca se conecta a
 * canDefensiveCover() — compatibilidad de daño y de timing son dimensiones
 * independientes (§5, cabecera).
 */
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
