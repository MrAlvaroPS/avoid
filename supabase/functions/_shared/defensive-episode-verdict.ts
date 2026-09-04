// §Paso C (iris-defensive-canonicalization-v1-plan.md §10/§11) — REESCRITO
// 2026-09-04 tras revisión real que encontró un bug de invariante y una
// simplificación de KPI incorrecta en la versión anterior de este fichero,
// y REESCRITO OTRA VEZ en E4 (misma fecha, plan de continuación §1-§12) para
// dejar de recibir un `applicability` ambiguo y una disponibilidad
// implícita: el candidato ahora distingue explícitamente damageApplicability
// / temporalOpportunity / temporalCastCoverage / engagement / statusAtPeak
// (§6 del plan de continuación), y la confidence del veredicto es
// DECISION-SCOPED (§11) — nunca la más débil de TODO el kit, solo la de la
// evidencia que realmente decidió el veredicto.
//
// Sigue habiendo TRES cambios de fondo heredados de la reescritura anterior,
// más uno nuevo (E4):
//
// 1) TRES KPI, no uno. Uso (¿pulsó algo?) y Response (¿lo que pulsó — o no
//    pulsó — resolvió la presión?) son preguntas DISTINTAS que comparten el
//    mismo episodio pero nunca deben colapsarse en un único verdict.
//    `usageEngaged` (booleano, independiente) + `responseVerdict` (el estado
//    canónico de 7 valores).
//
// 2) BUG REAL corregido: applicability==='unknown' + disponible + sin cast
//    nunca produce `missed_ready` — missed_ready exige damageApplicability Y
//    temporalOpportunity estrictamente 'yes'.
//
// 3) La reconstrucción causal (reconstructCausalAvailability) NUNCA produce
//    missed_due_to_mistime por ausencia de un episodio anterior que
//    justifique un cast — eso no es evidencia positiva de mal uso. Sin
//    evidencia positiva, degrada a `uncertain`. missed_due_to_mistime queda
//    definido en el contrato pero, de momento, inalcanzable desde esta
//    función.
//
// 4) (E4) `no_applicable_resource` es una conclusión POSITIVA — nunca el
//    fallback de "no sé". Un candidato potencialmente relevante pero
//    materialmente sin resolver (semántica pending, buildPresence unknown,
//    resolutionStatus conflict/unresolved, o una regla runtime sin resolver
//    que podría cambiar membership) BLOQUEA esa conclusión y produce
//    `uncertain` en su lugar — nunca crea un missed_ready por sí mismo.

import type { EvaluationConfidence } from './combat-evaluation-contract.ts';
import type { ApplicabilityVerdict, TimingRelation } from './defensive-applicability.ts';
import type { DefensiveCooldownStatus } from './defensive-cooldowns.ts';
import { evaluateTemporalCoverage, normalizeCastTimestamps } from './defensive-temporal-coverage.ts';

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

/**
 * UN candidato ya resuelto para UN episodio (§6 del plan de continuación —
 * "explicit candidate contract"). Ningún campo mezcla dos preguntas
 * distintas: "¿el spell puede cubrir este daño?" (damageApplicability) es
 * independiente de "¿este cast concreto estuvo bien cronometrado?"
 * (temporalCastCoverage/temporalOpportunity).
 */
export interface EpisodeVerdictCandidate {
  spellId: number;
  /** isDefensiveKitMember del resolver — puede acreditar Uso (credit_only incluido) aunque no pueda generar missed_ready. */
  isDefensiveKitMember: boolean;
  /** createsMissableOpportunity del resolver — el único que puede producir missed_ready. */
  createsMissableOpportunity: boolean;
  /**
   * true solo cuando la relevancia personal de ESTE candidato está
   * materialmente sin resolver (semántica pending, buildPresence unknown,
   * resolutionStatus conflict/unresolved, o una regla runtime sin resolver
   * que podría cambiar su membership) — computado por el caller a partir de
   * ResolvedDefensive, nunca adivinado aquí. Nunca crea un miss; puede
   * bloquear una conclusión positiva de ausencia/disponibilidad.
   */
  materiallyUnresolved: boolean;
  /** "¿puede este spell cubrir mecánicamente el daño de ESTE episodio?" — veredicto combinado de canDefensiveCover()/combineHitApplicability() sobre los hits relevantes. */
  damageApplicability: ApplicabilityVerdict;
  /** "¿pudo este defensivo, por su relación temporal, ser una oportunidad legítima para este episodio?" — independiente de cualquier cast concreto. */
  temporalOpportunity: ApplicabilityVerdict;
  /** "¿el/los cast(s) realmente usados demuestran cobertura de ESTE episodio?" — un proactivo tarde puede tener engagement=true, temporalOpportunity='yes', temporalCastCoverage='no'. */
  temporalCastCoverage: ApplicabilityVerdict;
  /** Cast real dentro de la ventana de decisión/efecto relevante — señal de Uso, independiente de si cubrió algo. */
  engagement: boolean;
  statusAtPeak: DefensiveCooldownStatus;
  /** Confidence de la evidencia de ESTE candidato — nunca la más débil de todo el kit (§11). */
  confidence: EvaluationConfidence;
  /** Auditoría (hits evaluados, razones de daño/timing) — nunca se parsea para scoring; solo explica el resultado sin tener que refetchear WCL. */
  evidence: Record<string, unknown>;
}

export interface EpisodeVerdictResult {
  /** KPI Uso — independiente de si la respuesta fue correcta. */
  usageEngaged: boolean;
  usedSpellIds: number[];
  /** KPI Response — el estado canónico de 7 valores. */
  responseVerdict: ResponseVerdict;
  reason: string;
  coveredBySpellId: number | null;
  /** Confidence decision-scoped — de la evidencia que decidió el veredicto, nunca contaminada por un candidato no relacionado (§11). */
  confidence: EvaluationConfidence;
  /** spellIds cuya evidencia decidió directamente el veredicto. */
  decisiveSpellIds: number[];
  /** spellIds de candidatos sin resolver/inciertos que bloquearon una conclusión positiva (vacío cuando el veredicto no necesitó ningún bloqueador). */
  uncertaintyBlockers: number[];
  /**
   * Interno — true solo cuando el veredicto base es 'uncertain' PORQUE todo
   * lo estratégico-aplicable-demostrado está on_cooldown/activo (el único
   * caso que resolveEpisodeVerdictWithCausalAvailability puede promocionar a
   * unavailable_legitimate).
   */
  causalUpgradeEligible?: boolean;
}

const CONFIDENCE_RANK: Record<EvaluationConfidence, number> = { verified: 0, inferred: 1, fallback: 2, uncertain: 3 };

export function weakestConfidence(...values: EvaluationConfidence[]): EvaluationConfidence {
  return values.reduce((weakest, value) => (CONFIDENCE_RANK[value] > CONFIDENCE_RANK[weakest] ? value : weakest), 'verified' as EvaluationConfidence);
}

function bySpellId<T extends { spellId: number }>(a: T, b: T): number {
  return a.spellId - b.spellId;
}

/**
 * Veredicto de UN episodio a partir de candidatos ya resueltos. No conoce la
 * cadena causal de episodios anteriores — cuando el resultado base es
 * 'uncertain' porque todo lo estratégico-aplicable está en cooldown,
 * resolveEpisodeVerdictWithCausalAvailability() puede refinarlo más abajo.
 *
 * `excluded` no lo produce esta función — lo decide el caller ANTES de
 * llamar (wipe call, episodio en/después del cutoff de evaluación) sin
 * evaluar el episodio en absoluto.
 *
 * Precedencia exacta (§7 del plan de continuación):
 *  1) VERIFIED COVER
 *  2) USED BUT POSSIBLY VALID UNKNOWN ACTION
 *  3) POSITIVE READY OPPORTUNITY
 *  4) NO POSITIVE MISSABLE OPPORTUNITY → no_applicable_resource / uncertain
 *  5) (en el wrapper causal) TODO APLICABLE ESTÁ INDISPONIBLE
 */
export function resolveEpisodeVerdict(candidates: EpisodeVerdictCandidate[]): EpisodeVerdictResult {
  const sorted = [...candidates].sort(bySpellId);
  const engagedKitMembers = sorted.filter((c) => c.isDefensiveKitMember && c.engagement);
  const usageEngaged = engagedKitMembers.length > 0;
  const usedSpellIds = [...new Set(engagedKitMembers.map((c) => c.spellId))].sort((a, b) => a - b);

  // 1) VERIFIED COVER — cualquier miembro del kit usado (credit_only incluido) con daño+timing demostrados.
  const verifiedCovers = sorted.filter(
    (c) => c.isDefensiveKitMember && c.engagement && c.damageApplicability === 'yes' && c.temporalCastCoverage === 'yes',
  );
  if (verifiedCovers.length) {
    const winner = verifiedCovers[0];
    return {
      usageEngaged: true,
      usedSpellIds,
      responseVerdict: 'covered_verified',
      reason: `spellId ${winner.spellId} se usó durante el episodio y su cobertura de daño y de timing está demostrada.`,
      coveredBySpellId: winner.spellId,
      confidence: winner.confidence,
      decisiveSpellIds: [winner.spellId],
      uncertaintyBlockers: [],
    };
  }

  // 2) USED BUT POSSIBLY VALID UNKNOWN — un miembro del kit realmente usado
  // cuya cobertura no está demostrada ni descartada. Nunca se acusa mientras
  // ese cast pudiera haber sido cobertura válida.
  const usedUnknown = sorted.filter(
    (c) =>
      c.isDefensiveKitMember &&
      c.engagement &&
      c.damageApplicability !== 'no' &&
      c.temporalCastCoverage !== 'no' &&
      (c.damageApplicability === 'unknown' || c.temporalCastCoverage === 'unknown'),
  );
  if (usedUnknown.length) {
    return {
      usageEngaged,
      usedSpellIds,
      responseVerdict: 'uncertain',
      reason: `spellId ${usedUnknown.map((c) => c.spellId).join(', ')} se usó durante el episodio, pero su cobertura de daño/timing todavía no está demostrada ni descartada — Uso queda acreditado; Response no acusa mientras ese cast pudiera haber sido válido.`,
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: [],
      uncertaintyBlockers: usedUnknown.map((c) => c.spellId),
    };
  }

  // A partir de aquí nada de lo usado (si hubo algo) sirvió con evidencia
  // real — Uso puede seguir acreditado por usageEngaged de arriba; Response
  // sigue evaluando como si no hubiera cobertura.

  // 3) POSITIVE READY OPPORTUNITY — estrictamente damageApplicability='yes' Y temporalOpportunity='yes'.
  const missable = sorted.filter(
    (c) => c.createsMissableOpportunity && c.damageApplicability === 'yes' && c.temporalOpportunity === 'yes',
  );
  const ready = missable.filter((c) => c.statusAtPeak === 'available_unused');
  if (ready.length) {
    const winner = ready[0];
    return {
      usageEngaged,
      usedSpellIds,
      responseVerdict: 'missed_ready',
      reason: `spellId ${winner.spellId} estaba disponible y su aplicabilidad de daño y su oportunidad temporal están demostradas; no se usó.`,
      coveredBySpellId: null,
      confidence: winner.confidence,
      decisiveSpellIds: [winner.spellId],
      uncertaintyBlockers: [],
    };
  }

  // 4) NO POSITIVE MISSABLE OPPORTUNITY — no_applicable_resource (positivo) vs uncertain (bloqueado por algo sin resolver).
  const strategic = sorted.filter((c) => c.createsMissableOpportunity || c.materiallyUnresolved);
  if (!strategic.length) {
    return {
      usageEngaged,
      usedSpellIds,
      responseVerdict: 'no_applicable_resource',
      reason: 'El build de este jugador no tiene ningún recurso personal estratégico, resuelto o pendiente de resolver.',
      coveredBySpellId: null,
      confidence: 'verified',
      decisiveSpellIds: [],
      uncertaintyBlockers: [],
    };
  }

  const relevantStrategic = strategic.filter((c) => c.damageApplicability !== 'no' && c.temporalOpportunity !== 'no');
  if (!relevantStrategic.length) {
    return {
      usageEngaged,
      usedSpellIds,
      responseVerdict: 'no_applicable_resource',
      reason: 'El build tenía recursos estratégicos, pero ninguno demuestra aplicabilidad (de daño o de timing) a este episodio.',
      coveredBySpellId: null,
      confidence: weakestConfidence(...strategic.map((c) => c.confidence)),
      decisiveSpellIds: strategic.map((c) => c.spellId).sort((a, b) => a - b),
      uncertaintyBlockers: [],
    };
  }

  const unresolvedBlockers = relevantStrategic.filter(
    (c) =>
      c.materiallyUnresolved ||
      c.damageApplicability === 'unknown' ||
      c.temporalOpportunity === 'unknown' ||
      c.statusAtPeak === 'unknown',
  );
  if (unresolvedBlockers.length) {
    return {
      usageEngaged,
      usedSpellIds,
      responseVerdict: 'uncertain',
      reason: `spellId ${unresolvedBlockers.map((c) => c.spellId).join(', ')} podría ser la respuesta correcta, pero su relevancia o aplicabilidad todavía no está resuelta — no se afirma no_applicable_resource sin poder demostrarlo.`,
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: [],
      uncertaintyBlockers: unresolvedBlockers.map((c) => c.spellId).sort((a, b) => a - b),
      causalUpgradeEligible: false,
    };
  }

  // Todo lo estratégico-aplicable-demostrado está on_cooldown/activo en el
  // pico — la causa exacta exige la cadena de episodios anteriores (ver
  // resolveEpisodeVerdictWithCausalAvailability). Sin ella, uncertain: no se
  // acusa sin poder demostrarlo.
  return {
    usageEngaged,
    usedSpellIds,
    responseVerdict: 'uncertain',
    reason: 'Todo lo estratégico y aplicable estaba en cooldown o activo en el pico del episodio — la causa (uso legítimo previo vs. sin explicación) todavía no se ha reconstruido en este veredicto base.',
    coveredBySpellId: null,
    confidence: 'uncertain',
    decisiveSpellIds: relevantStrategic.map((c) => c.spellId).sort((a, b) => a - b),
    uncertaintyBlockers: relevantStrategic.map((c) => c.spellId).sort((a, b) => a - b),
    causalUpgradeEligible: true,
  };
}

/** Contexto temporal mínimo necesario para reconstruir si un cast pasado cubrió un episodio anterior — mismos campos que consume evaluateTemporalCoverage(), sin duplicar su lógica. */
export interface CausalTimingContext {
  timingRelation: TimingRelation | null;
  effectiveDurationMs: number | null;
  afterDamageResponseWindowMs: number;
  evaluationEndMs: number | null;
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
 * retrocediendo por los episodios ANTERIORES, si ese cast demuestra
 * cobertura de alguno de verdad — vía el MISMO evaluador temporal puro que
 * decide el candidato actual (nunca una heurística de mechanisms aparte).
 *
 * Busca desde el episodio más cercano hacia atrás — el primer match es la
 * explicación más probable, no cualquier coincidencia lejana.
 */
export function reconstructCausalAvailability(
  timing: CausalTimingContext,
  castsForSpellMs: readonly number[],
  episodes: readonly EpisodeWindow[],
  episodeIndex: number,
): CausalAvailabilityResult {
  const sortedCasts = normalizeCastTimestamps(castsForSpellMs);
  const atMs = episodes[episodeIndex].peakMs;
  let lastCastBefore: number | undefined;
  for (const t of sortedCasts) {
    if (t <= atMs) lastCastBefore = t;
    else break;
  }
  if (lastCastBefore === undefined) {
    return { classification: 'uncertain', reason: 'No hay cast previo que explique el cooldown en este pico — inconsistencia de datos, no se acusa.' };
  }

  for (let i = episodeIndex - 1; i >= 0; i--) {
    const result = evaluateTemporalCoverage({
      timingRelation: timing.timingRelation,
      effectiveDurationMs: timing.effectiveDurationMs,
      castsForSpellMs: [lastCastBefore],
      episode: episodes[i],
      afterDamageResponseWindowMs: timing.afterDamageResponseWindowMs,
      evaluationEndMs: timing.evaluationEndMs,
    });
    if (result.castCoverage === 'yes') {
      return {
        classification: 'unavailable_legitimate',
        reason: `El cast anterior (${lastCastBefore}ms) demuestra cobertura del episodio #${i}; el cooldown es consecuencia de un uso correcto.`,
        justifyingEpisodeIndex: i,
      };
    }
  }

  // Sin evidencia positiva de mal uso (eso vive en el evaluator de Plan —
  // reserva rota, asignación incumplida — o en una fuente futura de "gasto
  // demostrablemente injustificado"). La AUSENCIA de un episodio anterior
  // que lo explique no es esa evidencia.
  return {
    classification: 'uncertain',
    reason: `El cast anterior (${lastCastBefore}ms) no demuestra cobertura de ningún episodio anterior conocido — puede ser uso legítimo contra una amenaza que el detector no capturó. Sin evidencia positiva de mal uso, no se demuestra mistime.`,
  };
}

export interface CausallyAwareCandidate extends EpisodeVerdictCandidate {
  castsForSpellMs: number[];
  timing: CausalTimingContext;
}

/**
 * Envoltorio de resolveEpisodeVerdict(): cuando el veredicto base es
 * 'uncertain' Y está marcado `causalUpgradeEligible` (es decir, PORQUE todo
 * lo estratégico-aplicable estaba en cooldown, sin ningún otro bloqueador
 * sin resolver mezclado), reconstruye la causa de cada uno y decide el
 * veredicto FINAL del episodio.
 *
 * Precedencia cuando SÍ hace falta reconstrucción causal:
 *  - todos los on_cooldown resultan unavailable_legitimate → el episodio es
 *    unavailable_legitimate.
 *  - cualquier otra combinación (alguno uncertain) → el episodio se queda
 *    uncertain — no se acusa sin que TODOS estén demostrados.
 */
export function resolveEpisodeVerdictWithCausalAvailability(
  candidates: CausallyAwareCandidate[],
  episodes: readonly EpisodeWindow[],
  episodeIndex: number,
): EpisodeVerdictResult {
  const base = resolveEpisodeVerdict(candidates);
  if (base.responseVerdict !== 'uncertain' || !base.causalUpgradeEligible) return base;

  const onCooldownMissable = candidates.filter(
    (c) => c.createsMissableOpportunity && c.damageApplicability === 'yes' && c.temporalOpportunity === 'yes' && c.statusAtPeak === 'on_cooldown',
  );
  if (!onCooldownMissable.length) return base; // el uncertain venía de status 'active'/'unknown' — nada que reconstruir con causalidad

  const causalResults = onCooldownMissable.map((c) => ({
    spellId: c.spellId,
    confidence: c.confidence,
    ...reconstructCausalAvailability(c.timing, c.castsForSpellMs, episodes, episodeIndex),
  }));

  if (causalResults.every((r) => r.classification === 'unavailable_legitimate')) {
    return {
      ...base,
      responseVerdict: 'unavailable_legitimate',
      reason: `Todo lo estratégico y aplicable estaba en cooldown por un uso previo demostrablemente legítimo (${causalResults.map((r) => r.spellId).join(', ')}).`,
      confidence: weakestConfidence(...causalResults.map((r) => r.confidence)),
      decisiveSpellIds: causalResults.map((r) => r.spellId).sort((a, b) => a - b),
    };
  }

  return base; // al menos uno sin evidencia positiva — se queda uncertain
}
