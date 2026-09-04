// §Paso C (iris-defensive-canonicalization-v1-plan.md §10/§11): el veredicto
// canónico de un DefensiveEpisode. Reutiliza defensiveStatusAt() tal cual
// (defensive-cooldowns.ts) — no se reinventa cast+cooldown, solo se aplica
// en el instante relevante de CADA episodio en vez de solo en el instante de
// una muerte.
//
// §decisión explícita (feedback real, 2026-09-04): mientras no exista una
// fuente real de DamageDescriptor (school/deliveryScope/dodgeable... — ver
// defensive-applicability.ts), canDefensiveCover() devuelve 'unknown' para
// prácticamente todo. En vez de bloquear este módulo hasta tener esa fuente,
// se aplica la asimetría que ya pedía §29/invariante 5 del plan: 'unknown'
// SIGUE sin poder generar nunca missed_ready (ya lo garantiza que
// createsMissableOpportunity exige applicability!=='no' más abajo), pero SÍ
// puede generar covered_verified cuando hay un cast real — "el defensivo
// usado se asume correcto para la mecánica hasta que tengamos con qué
// demostrar lo contrario". Marcado explícitamente en el reason de cada
// verdict para que sea trivial de encontrar y endurecer el día que
// DamageDescriptor deje de ser inerte.
//
// Deliberadamente NO resuelve todavía la causa de un "todo en cooldown"
// (unavailable_legitimate vs missed_due_to_mistime, §31 del plan) — eso
// exige reconstruir la cadena causal completa de episodios anteriores de la
// misma habilidad, un algoritmo distinto (secuencial, no por episodio
// aislado). Ese caso degrada honestamente a 'uncertain' por ahora: no se
// acusa sin poder demostrar la causa.

import type { DefensiveCooldown, DefensiveCooldownStatus } from './defensive-cooldowns.ts';
import { defensiveStatusAt } from './defensive-cooldowns.ts';
import type { ApplicabilityVerdict } from './defensive-applicability.ts';
import type { DefensiveMechanism } from './defensive-classification-semantics.ts';

export type EpisodeVerdict =
  | 'covered_verified'
  | 'missed_ready'
  | 'missed_due_to_mistime'
  | 'unavailable_legitimate'
  | 'no_applicable_resource'
  | 'uncertain'
  | 'excluded';

export interface EpisodeWindow {
  startMs: number;
  endMs: number;
  peakMs: number;
}

/**
 * Resumen ya calculado de un candidato para UN episodio concreto. Se separa
 * de resolveEpisodeVerdict() para que ese quede una función de decisión
 * pura y trivial de testear — el cálculo de timing (con su regla especial
 * para sustain) vive en summarizeCandidateForEpisode().
 */
export interface EpisodeVerdictCandidate {
  spellId: number;
  /** isDefensiveKitMember del resolver — puede cubrir (Bear Form incluido) aunque no pueda fallar. */
  isDefensiveKitMember: boolean;
  /** createsMissableOpportunity del resolver — el único que puede producir missed_ready. */
  createsMissableOpportunity: boolean;
  applicability: ApplicabilityVerdict;
  usedDuringEpisode: boolean;
  statusAtPeak: DefensiveCooldownStatus;
}

export interface EpisodeVerdictResult {
  verdict: EpisodeVerdict;
  reason: string;
  /** spellId que produjo la cobertura, solo si verdict==='covered_verified'. */
  coveredBySpellId: number | null;
}

const DEFAULT_SUSTAIN_GRACE_MS = 3000;

/**
 * Calcula usedDuringEpisode/statusAtPeak para un candidato — sustain
 * (Frenzied Regeneration-style) tolera un cast en una ventana de gracia
 * INMEDIATAMENTE DESPUÉS del daño (§30 del plan: "sustain necesita su
 * propia relación temporal"); mitigation/absorption/immunity/avoidance
 * exigen que el cast caiga dentro del propio tramo del episodio (antes o
 * durante, nunca después — de lo contrario no protegió nada).
 */
export function summarizeCandidateForEpisode(
  cd: DefensiveCooldown,
  mechanisms: DefensiveMechanism[],
  castsForSpellMs: number[],
  episode: EpisodeWindow,
  sustainGraceMs = DEFAULT_SUSTAIN_GRACE_MS,
): { usedDuringEpisode: boolean; statusAtPeak: DefensiveCooldownStatus } {
  const isSustainOnly = mechanisms.length > 0 && mechanisms.every((m) => m === 'sustain');
  const windowEnd = isSustainOnly ? episode.endMs + sustainGraceMs : episode.endMs;
  const usedDuringEpisode = castsForSpellMs.some((t) => t >= episode.startMs && t <= windowEnd);
  const statusAtPeak = defensiveStatusAt(cd, castsForSpellMs, episode.peakMs).status;
  return { usedDuringEpisode, statusAtPeak };
}

/**
 * Veredicto canónico de un episodio dado el resumen ya resuelto de sus
 * candidatos. No conoce casts/cooldowns directamente — eso ya está en
 * `usedDuringEpisode`/`statusAtPeak` (ver summarizeCandidateForEpisode).
 *
 * `excluded` no lo produce esta función — lo decide el caller ANTES de
 * llamar (wipe call, episodio posterior a evaluationCutoffMs, etc.) y
 * simplemente no evalúa el episodio en absoluto.
 */
export function resolveEpisodeVerdict(candidates: EpisodeVerdictCandidate[]): EpisodeVerdictResult {
  // 1) ¿Alguno cubrió de verdad? applicability!=='no' incluye 'unknown' a
  // propósito (ver cabecera del fichero) — un cast real se asume correcto
  // hasta que podamos demostrar lo contrario.
  const covering = candidates.find(
    (c) => c.isDefensiveKitMember && c.usedDuringEpisode && c.applicability !== 'no',
  );
  if (covering) {
    return {
      verdict: 'covered_verified',
      reason:
        covering.applicability === 'yes'
          ? `spellId ${covering.spellId} se usó durante el episodio y su aplicabilidad está demostrada.`
          : `spellId ${covering.spellId} se usó durante el episodio; aplicabilidad no demostrada todavía (asumida correcta — DamageDescriptor pendiente, ver defensive-applicability.ts).`,
      coveredBySpellId: covering.spellId,
    };
  }

  // 2) Nadie cubrió. ¿Hay algo ESTRATÉGICO cuya aplicabilidad no lo
  // descarte ya (applicability==='no' real, no 'unknown')?
  const missable = candidates.filter((c) => c.createsMissableOpportunity && c.applicability !== 'no');
  if (!missable.length) {
    const hadAnyMissableAtAll = candidates.some((c) => c.createsMissableOpportunity);
    return {
      verdict: 'no_applicable_resource',
      reason: hadAnyMissableAtAll
        ? 'El build tenía recursos estratégicos, pero ninguno es aplicable a este episodio (aplicabilidad real descartada).'
        : 'El build de este jugador no tiene ningún recurso personal estratégico disponible.',
      coveredBySpellId: null,
    };
  }

  // 3) ¿Alguno de los aplicables estaba realmente listo (no en cooldown)?
  const ready = missable.find((c) => c.statusAtPeak === 'available_unused');
  if (ready) {
    return {
      verdict: 'missed_ready',
      reason: `spellId ${ready.spellId} estaba disponible y era aplicable en el pico del episodio; no se usó.`,
      coveredBySpellId: null,
    };
  }

  // 4) Todo lo aplicable está en cooldown o en estado desconocido. La causa
  // exacta (unavailable_legitimate vs missed_due_to_mistime) exige
  // reconstruir la cadena causal de episodios anteriores — todavía no
  // implementado (ver cabecera). No se acusa sin poder demostrarlo.
  if (missable.every((c) => c.statusAtPeak === 'on_cooldown')) {
    return {
      verdict: 'uncertain',
      reason:
        'Todo lo aplicable estaba en cooldown en el pico del episodio; la causa (uso legítimo previo vs desincronización) todavía no se reconstruye — pendiente, no penaliza.',
      coveredBySpellId: null,
    };
  }

  return {
    verdict: 'uncertain',
    reason: 'No se pudo demostrar con evidencia suficiente si había un recurso realmente listo en este episodio.',
    coveredBySpellId: null,
  };
}
