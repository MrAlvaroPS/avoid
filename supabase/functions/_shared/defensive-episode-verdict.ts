// §Paso C (iris-defensive-canonicalization-v1-plan.md §10/§11) — REESCRITO
// 2026-09-04 tras revisión real que encontró un bug de invariante y una
// simplificación de KPI incorrecta en la versión anterior de este fichero.
// No se reescribe por gusto: hay tres cambios de fondo respecto a la
// primera versión.
//
// 1) TRES KPI, no uno. Uso (¿pulsó algo?) y Response (¿lo que pulsó — o no
//    pulsó — resolvió la presión?) son preguntas DISTINTAS que comparten el
//    mismo episodio pero nunca deben colapsarse en un único verdict. Antes
//    esta función devolvía un solo `verdict`; ahora devuelve
//    `usageEngaged` (booleano, independiente) + `responseVerdict` (el
//    estado canónico de 7 valores). "Barkskin demasiado pronto y no cubre"
//    debe poder ser Uso=✅ / Response=❌ simultáneamente.
//
// 2) BUG REAL corregido: la versión anterior dejaba que
//    applicability==='unknown' + disponible + sin cast produjera
//    `missed_ready` (el filtro era `applicability !== 'no'`, que incluye
//    'unknown'). El propio comentario del fichero decía que unknown "nunca"
//    podía generar missed_ready — la condición real lo permitía. Ahora
//    missed_ready exige `applicability === 'yes'` estrictamente. Para
//    CRÉDITO seguimos aceptando unknown (ver covered_verified vs el nuevo
//    caso intermedio), para PENALIZACIÓN ya no.
//
// 3) La reconstrucción causal (más abajo, reconstructCausalAvailability)
//    NUNCA produce missed_due_to_mistime por ausencia de un episodio
//    anterior que justifique un cast — eso NO es evidencia positiva de mal
//    uso (caso real señalado: daño sostenido/mecánicas Mythic que el
//    detector de candidatos no llega a convertir en DefensiveEpisode). Sin
//    evidencia positiva (que hoy no existe — vendría del evaluator de Plan,
//    reservas rotas, etc.), degrada a `uncertain`. missed_due_to_mistime
//    queda definido en el contrato pero, de momento, inalcanzable desde
//    esta función — reservado para cuando exista esa fuente de evidencia.

import type { DefensiveCooldown, DefensiveCooldownStatus } from './defensive-cooldowns.ts';
import { chargeAvailabilityAt, defensiveStatusAt } from './defensive-cooldowns.ts';
import type { ApplicabilityVerdict } from './defensive-applicability.ts';
import type { DefensiveMechanism } from './defensive-classification-semantics.ts';

export type ResponseVerdict =
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

export interface EpisodeVerdictCandidate {
  spellId: number;
  /** isDefensiveKitMember del resolver — puede acreditar Uso (Bear Form incluido) aunque no pueda fallar en Response. */
  isDefensiveKitMember: boolean;
  /** createsMissableOpportunity del resolver — el único que puede producir missed_ready. */
  createsMissableOpportunity: boolean;
  applicability: ApplicabilityVerdict;
  usedDuringEpisode: boolean;
  statusAtPeak: DefensiveCooldownStatus;
}

export interface EpisodeVerdictResult {
  /** KPI Uso — independiente de si la respuesta fue correcta. */
  usageEngaged: boolean;
  usedSpellIds: number[];
  /** KPI Response — el estado canónico de 7 valores. */
  responseVerdict: ResponseVerdict;
  reason: string;
  coveredBySpellId: number | null;
}

const DEFAULT_SUSTAIN_GRACE_MS = 3000;

/**
 * Calcula usedDuringEpisode/statusAtPeak para un candidato.
 *
 * Timing: sustain (Frenzied Regeneration-style) tolera un cast en una
 * ventana de gracia INMEDIATAMENTE DESPUÉS del daño (§30 del plan);
 * mitigation/absorption/immunity/avoidance exigen que el cast caiga dentro
 * del propio tramo del episodio.
 *
 * §cargas real (Paso C-1, iris-defensive-canonicalization-v1-plan.md §2.4):
 * `chargeAvailabilityAt()` (defensive-cooldowns.ts) reconstruye disponibilidad
 * real por cargas cuando `rechargeMs` es un dato fiable (`defensive_spec_profiles.recharge_ms`,
 * con fallback a `cooldownMs` cuando el perfil no cura una recarga aparte —
 * ya resuelto por `resolveEffectiveDefensiveKit()`). Sin `rechargeMs` fiable
 * (perfil todavía sin curar para esa ability) sigue fail-closed a `unknown`
 * — nunca puede producir `missed_ready` ni entrar en la reconstrucción
 * causal como si supiéramos que estaba realmente indisponible. Con
 * `charges<=1` (el 100% del catálogo salvo Survival Instincts/Shield Block,
 * verificado 2026-09-04) el comportamiento es idéntico al de siempre.
 */
export function summarizeCandidateForEpisode(
  cd: DefensiveCooldown,
  mechanisms: DefensiveMechanism[],
  castsForSpellMs: number[],
  episode: EpisodeWindow,
  charges = 1,
  sustainGraceMs = DEFAULT_SUSTAIN_GRACE_MS,
  rechargeMs: number | null = null,
): { usedDuringEpisode: boolean; statusAtPeak: DefensiveCooldownStatus } {
  const isSustainOnly = mechanisms.length > 0 && mechanisms.every((m) => m === 'sustain');
  const windowEnd = isSustainOnly ? episode.endMs + sustainGraceMs : episode.endMs;
  const usedDuringEpisode = castsForSpellMs.some((t) => t >= episode.startMs && t <= windowEnd);
  const statusAtPeak = chargeAvailabilityAt(cd, charges, rechargeMs, castsForSpellMs, episode.peakMs).status;
  return { usedDuringEpisode, statusAtPeak };
}

/**
 * Veredicto de UN episodio a partir del resumen ya resuelto de sus
 * candidatos (ver summarizeCandidateForEpisode). No conoce la cadena
 * causal de episodios anteriores — cuando el resultado es 'uncertain'
 * porque todo lo aplicable está en cooldown, resolveEpisodeVerdictWithCausalAvailability()
 * puede refinarlo más abajo.
 *
 * `excluded` no lo produce esta función — lo decide el caller ANTES de
 * llamar (wipe call, episodio posterior a evaluationCutoffMs) sin evaluar
 * el episodio en absoluto.
 */
export function resolveEpisodeVerdict(candidates: EpisodeVerdictCandidate[]): EpisodeVerdictResult {
  const usedCandidates = candidates.filter((c) => c.isDefensiveKitMember && c.usedDuringEpisode);
  const usageEngaged = usedCandidates.length > 0;
  const usedSpellIds = usedCandidates.map((c) => c.spellId);

  // 1) Cast real + aplicabilidad DEMOSTRADA → cobertura certificada.
  const verifiedCovering = usedCandidates.find((c) => c.applicability === 'yes');
  if (verifiedCovering) {
    return {
      usageEngaged: true,
      usedSpellIds,
      responseVerdict: 'covered_verified',
      reason: `spellId ${verifiedCovering.spellId} se usó durante el episodio y su aplicabilidad está demostrada.`,
      coveredBySpellId: verifiedCovering.spellId,
    };
  }

  // 2) Cast real + aplicabilidad NO demostrada todavía (DamageDescriptor
  // pendiente) → Uso ya queda acreditado (arriba), pero Response no
  // certifica una cobertura que no puede demostrar. No es una penalización
  // — es la ausencia de evidencia suficiente para lo contrario.
  const unknownCovering = usedCandidates.find((c) => c.applicability === 'unknown');
  if (unknownCovering) {
    return {
      usageEngaged: true,
      usedSpellIds,
      responseVerdict: 'uncertain',
      reason: `spellId ${unknownCovering.spellId} se usó durante el episodio, pero su aplicabilidad todavía no está demostrada (DamageDescriptor pendiente) — Uso queda acreditado; Response no certifica cobertura sin evidencia.`,
      coveredBySpellId: null,
    };
  }

  // A partir de aquí nada de lo usado (si hubo algo) sirvió con evidencia
  // real ('no' para todo lo usado) — Uso puede seguir acreditado por
  // usageEngaged de arriba; Response sigue evaluando como si no hubiera
  // cobertura.

  // 3) ¿Hay algo estratégico con aplicabilidad DEMOSTRADA (yes) que no se usó?
  const missable = candidates.filter((c) => c.createsMissableOpportunity && c.applicability === 'yes');
  if (!missable.length) {
    const hadStrategicKit = candidates.some((c) => c.createsMissableOpportunity);
    return {
      usageEngaged,
      usedSpellIds,
      responseVerdict: 'no_applicable_resource',
      reason: hadStrategicKit
        ? 'El build tenía recursos estratégicos, pero ninguno tiene aplicabilidad demostrada para este episodio.'
        : 'El build de este jugador no tiene ningún recurso personal estratégico.',
      coveredBySpellId: null,
    };
  }

  // 4) ¿Alguno de los aplicables-demostrados estaba realmente listo?
  const ready = missable.find((c) => c.statusAtPeak === 'available_unused');
  if (ready) {
    return {
      usageEngaged,
      usedSpellIds,
      responseVerdict: 'missed_ready',
      reason: `spellId ${ready.spellId} estaba disponible y su aplicabilidad está demostrada; no se usó.`,
      coveredBySpellId: null,
    };
  }

  // 5) Todo lo aplicable-demostrado está en cooldown o en un estado no
  // determinado (incluye el fail-closed de cargas de arriba). La causa
  // exacta exige la cadena de episodios anteriores — ver
  // resolveEpisodeVerdictWithCausalAvailability(). Sin ella, uncertain: no
  // se acusa sin poder demostrarlo.
  return {
    usageEngaged,
    usedSpellIds,
    responseVerdict: 'uncertain',
    reason: 'Todo lo estratégico y aplicable estaba en cooldown o en un estado no determinado en el pico del episodio — la causa (uso legítimo previo vs. sin explicación) todavía no se ha reconstruido en este veredicto base.',
    coveredBySpellId: null,
  };
}

export interface CausalAvailabilityResult {
  /** missed_due_to_mistime NO es alcanzable desde esta función todavía — ver cabecera del fichero. */
  classification: 'unavailable_legitimate' | 'uncertain';
  reason: string;
  justifyingEpisodeIndex?: number;
}

/**
 * Por qué UNA habilidad concreta no estaba lista en el pico de
 * episodes[episodeIndex]: busca el cast que la puso en cooldown y comprueba,
 * retrocediendo por los episodios ANTERIORES, si ese cast cubrió alguno de
 * verdad (misma regla de timing que summarizeCandidateForEpisode, aplicada
 * hacia atrás con un único cast).
 *
 * Busca desde el episodio más cercano hacia atrás — el primer match es la
 * explicación más probable, no cualquier coincidencia lejana.
 */
export function reconstructCausalAvailability(
  cd: DefensiveCooldown,
  mechanisms: DefensiveMechanism[],
  castsForSpellMs: number[],
  episodes: EpisodeWindow[],
  episodeIndex: number,
): CausalAvailabilityResult {
  const atMs = episodes[episodeIndex].peakMs;
  let lastCastBefore: number | undefined;
  for (const t of castsForSpellMs) {
    if (t <= atMs) lastCastBefore = t;
    else break;
  }
  if (lastCastBefore === undefined) {
    return { classification: 'uncertain', reason: 'No hay cast previo que explique el cooldown en este pico — inconsistencia de datos, no se acusa.' };
  }

  for (let i = episodeIndex - 1; i >= 0; i--) {
    const { usedDuringEpisode } = summarizeCandidateForEpisode(cd, mechanisms, [lastCastBefore], episodes[i]);
    if (usedDuringEpisode) {
      return {
        classification: 'unavailable_legitimate',
        reason: `El cast anterior (${lastCastBefore}ms) cubrió el episodio #${i}; el cooldown es consecuencia de un uso correcto.`,
        justifyingEpisodeIndex: i,
      };
    }
  }

  // Sin evidencia positiva de mal uso (eso vive en el evaluator de Plan —
  // reserva rota, asignación incumplida — o en una fuente futura de "gasto
  // demostrablemente injustificado"). La AUSENCIA de un episodio anterior
  // que lo explique no es esa evidencia: puede haber protegido contra daño
  // sostenido o una mecánica que el detector de candidatos no convirtió en
  // episodio (caso real señalado: contenido Mythic con presión continua).
  return {
    classification: 'uncertain',
    reason: `El cast anterior (${lastCastBefore}ms) no coincide con ningún episodio anterior conocido — puede ser uso legítimo contra una amenaza que el detector no capturó. Sin evidencia positiva de mal uso, no se demuestra mistime.`,
  };
}

export interface CausallyAwareCandidate extends EpisodeVerdictCandidate {
  cd: DefensiveCooldown;
  mechanisms: DefensiveMechanism[];
  castsForSpellMs: number[];
}

/**
 * Envoltorio de resolveEpisodeVerdict(): cuando el veredicto base es
 * 'uncertain' PORQUE todo lo estratégico-aplicable estaba en cooldown,
 * reconstruye la causa de cada uno y decide el veredicto FINAL del
 * episodio (pertenece al episodio, no a un spell suelto — un Barkskin
 * legítimamente gastado no basta para excusar el episodio si Frenzied
 * Regeneration seguía listo; eso ya lo captura resolveEpisodeVerdict() en
 * el paso 4 antes de llegar aquí, porque "ready" gana sobre "on_cooldown"
 * para cualquier candidato del kit).
 *
 * Precedencia cuando SÍ hace falta reconstrucción causal:
 *  - todos los on_cooldown resultan unavailable_legitimate → el episodio
 *    es unavailable_legitimate.
 *  - cualquier otra combinación (alguno uncertain) → el episodio se queda
 *    uncertain — no se acusa sin que TODOS estén demostrados.
 */
export function resolveEpisodeVerdictWithCausalAvailability(
  candidates: CausallyAwareCandidate[],
  episodes: EpisodeWindow[],
  episodeIndex: number,
): EpisodeVerdictResult {
  const base = resolveEpisodeVerdict(candidates);
  if (base.responseVerdict !== 'uncertain') return base;

  const onCooldownMissable = candidates.filter(
    (c) => c.createsMissableOpportunity && c.applicability === 'yes' && c.statusAtPeak === 'on_cooldown',
  );
  if (!onCooldownMissable.length) return base; // el uncertain venía de otro motivo (unknown/applicability unknown) — nada que reconstruir

  const causalResults = onCooldownMissable.map((c) => ({
    spellId: c.spellId,
    ...reconstructCausalAvailability(c.cd, c.mechanisms, c.castsForSpellMs, episodes, episodeIndex),
  }));

  if (causalResults.every((r) => r.classification === 'unavailable_legitimate')) {
    return {
      ...base,
      responseVerdict: 'unavailable_legitimate',
      reason: `Todo lo estratégico y aplicable estaba en cooldown por un uso previo demostrablemente legítimo (${causalResults.map((r) => r.spellId).join(', ')}).`,
    };
  }

  return base; // al menos uno sin evidencia positiva — se queda uncertain
}
