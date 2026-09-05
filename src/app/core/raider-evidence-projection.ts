import type {
  CanonicalDefensiveEpisodeView,
  NightCanonicalDefensiveSummary,
  NightDefensiveDecision,
  NightDefensiveManagementV2,
  NightMechanicFailRow,
  NightPlayerSummary,
} from './night-player-summary.service';
import { formatDuration, safeSpellName } from '../shared/format.util';
import { PERSONAL_RESPONSIBILITY_CATEGORIES } from '../shared/pull-consistency.util';

export type RaiderEvidenceVerdict =
  | 'success'
  | 'confirmed_error'
  | 'coaching'
  | 'correct_hold'
  | 'context'
  | 'no_verdict';

export type RaiderEvidenceConfidence = 'verified' | 'inferred' | 'uncertain';
export type RaiderEvidenceQuality = 'high' | 'partial' | 'limited';

export interface RaiderEvidenceRef {
  source:
    | 'pull_mechanic_events'
    | 'player_pull_records.death_cause'
    | 'player_pull_defensive_evaluations'
    | 'player_pull_defensive_episode_evaluations'
    | 'player_pull_records.gear';
  key: string;
  version: string | null;
}

export interface RaiderEvidenceOccurrence {
  pullId: string;
  pullNumber: number;
  atMs: number;
}

export interface RaiderEvidenceDefensive {
  spellId: number;
  name: string;
  status: 'planned' | 'used' | 'available_unused' | 'candidate';
}

/**
 * Proyección estable que consume la UI. Los textos son observaciones
 * factuales, resoluciones revisadas o copy determinista del evaluator; la
 * plantilla no reinterpreta tablas raw ni fabrica causalidad.
 */
export interface RaiderEvidenceItem {
  id: string;
  kind: 'defensive' | 'mechanic' | 'death' | 'preparation';
  pullId: string | null;
  pullNumber: number | null;
  bossId: string | null;
  bossName: string | null;
  difficulty: string | null;
  atMs: number | null;
  mechanicId: number | null;
  mechanicName: string | null;
  title: string;
  verdict: RaiderEvidenceVerdict;
  reasonCode: string;
  observation: string;
  whyItMatters: string | null;
  action: string | null;
  /** Síntesis de una frase, memorizable para el siguiente pull; null cuando
   * no hay una segunda formulación distinta de `action` que no sea inventada
   * (la spec visual permite mostrar "—" en ese caso, sección 9). */
  preventionKey: string | null;
  /** Nota descriptiva de la mecánica ("qué es"), misma fuente que aiNote en el resto de la app; null si no hay clasificación revisada. */
  mechanicDescription: string | null;
  /** Resolución esperada ("cómo resolverla"), distinta de `action` — action puede ser una instrucción defensiva concreta mientras esto es la táctica general de la mecánica. */
  resolutionText: string | null;
  defensives: RaiderEvidenceDefensive[];
  confidence: RaiderEvidenceConfidence;
  occurrences: RaiderEvidenceOccurrence[];
  provenance: RaiderEvidenceRef[];
  /** Menor es más importante. Solo lo usa la selección determinista. */
  priorityTier: number;
  damageTotal: number;
}

export interface RaiderPullTimelineCell {
  pullId: string;
  pullNumber: number;
  bossId: string;
  bossName: string;
  difficulty: string;
  score: number;
  state: 'confirmed_error' | 'coaching' | 'correct_hold' | 'clean' | 'no_data';
  evidenceCount: number;
}

export interface RaiderEvidenceProjection {
  reportCode: string;
  playerName: string;
  evaluatedPullIds: string[];
  quality: RaiderEvidenceQuality;
  qualityReason: string;
  items: RaiderEvidenceItem[];
  coaching: RaiderEvidenceItem[];
  additionalCoachingCount: number;
  timeline: RaiderPullTimelineCell[];
  defensiveGeneration: {
    evaluatorVersion: string;
    resolverVersion: string;
    solverVersion: string;
    gameBuild: string;
    buildFingerprint: string;
  } | null;
}

export interface RaiderEvidenceProjectionOptions {
  /** Pasar null cuando el feature gate visible esté apagado. Nunca se pasa a la vez que canonicalDefensive — son dos fuentes de verdad defensiva incompatibles (V2/legacy vs. generación v7 publicada) y solo una debe alimentar la infografía a la vez. */
  defensiveManagementV2?: NightDefensiveManagementV2 | null;
  /** §Frontend cutover (2026-09-05): cuando se pasa (la v3 canvas SIEMPRE la pasa), sustituye por completo la
   * fuente V2 para los items `kind:'defensive'` — se construyen desde episodios canónicos
   * (missed_ready/missed_due_to_mistime) en vez de decisiones V2, y las muertes dejan de afirmar
   * disponibilidad defensiva (§45: no existe linkage canónico episodio↔muerte en v7 todavía). La vista legacy
   * (v1) nunca pasa esto. */
  canonicalDefensive?: NightCanonicalDefensiveSummary | null;
  /** Nombres reales de spell resueltos en night-player-summary.service.ts (defensive_casts/death_defensive_options_v2) — reutilizados aquí solo para presentación de los defensivos citados en items canónicos; nunca decide semántica. */
  spellNameById?: ReadonlyMap<number, string>;
}

const KNOWN_DEFENSIVE_REASONS = new Set([
  'PLANNED_CAST_IN_WINDOW',
  'SUBSTITUTE_VALID_NO_FUTURE_COST',
  'SUBSTITUTE_CAUSED_FUTURE_CONFLICT',
  'RESERVED_HIGHER_PRIORITY',
  'SAFE_EXTRA_USE',
  'COUNTERFACTUAL_FEASIBLE',
  'EARLY_CAST_CAUSED_MISS',
  'READY_NOT_CAST_IN_WINDOW',
  'DEATH_COUNTERFACTUAL_FEASIBLE',
  'DEATH_READY_AT_END_ONLY',
  'NO_COUNTERFACTUAL_SCHEDULE',
  'TARGET_MISMATCH',
  'UNRESOLVED_BUILD_OR_RULE',
]);

const VERDICT_ORDER: Record<RaiderEvidenceVerdict, number> = {
  confirmed_error: 0,
  coaching: 1,
  correct_hold: 2,
  success: 3,
  context: 4,
  no_verdict: 5,
};

function verifiableMechanic(id: number | null, name: string | null): boolean {
  return id != null && id > 0 && !!name && !/^unknown(?: ability| cause)?$/i.test(name.trim());
}

/** El nombre puede venir ausente (fallback `#id`) o presente pero corrupto
 * (JSON/markdown sin terminar de parsear desde un envío manual anterior);
 * safeSpellName() cubre el segundo caso, este helper cubre el primero. */
function cleanSpellName(rawName: string | null | undefined, spellId: number): string {
  return rawName == null ? `#${spellId}` : safeSpellName(rawName);
}

function defensiveNames(decision: NightDefensiveDecision): RaiderEvidenceDefensive[] {
  const rows: RaiderEvidenceDefensive[] = [];
  if (decision.plannedSpellId != null) {
    rows.push({
      spellId: decision.plannedSpellId,
      name: cleanSpellName(decision.plannedSpellName, decision.plannedSpellId),
      status: 'planned',
    });
  }
  if (decision.actualSpellId != null) {
    rows.push({
      spellId: decision.actualSpellId,
      name: cleanSpellName(decision.actualSpellName, decision.actualSpellId),
      status: 'used',
    });
  }
  for (let index = 0; index < (decision.candidateSpellIds ?? []).length; index++) {
    const spellId = decision.candidateSpellIds![index];
    rows.push({
      spellId,
      name: cleanSpellName(decision.candidateSpellNames[index], spellId),
      status: 'candidate',
    });
  }
  return [...new Map(rows.map((row) => [`${row.spellId}|${row.status}`, row])).values()];
}

function decisionVerdict(decision: NightDefensiveDecision): RaiderEvidenceVerdict {
  if (!KNOWN_DEFENSIVE_REASONS.has(decision.reason)) return 'no_verdict';
  switch (decision.state) {
    case 'plan_broken':
    case 'reminder_missed':
      return 'confirmed_error';
    case 'death_with_viable_cd':
    case 'death_with_ready_cd':
    case 'missed_extra_opportunity':
      return 'coaching';
    case 'covered_with_substitution':
      return decision.managementOutcome === 'failure' ? 'coaching' : 'success';
    case 'correct_hold':
      return 'correct_hold';
    case 'safe_extra_use':
    case 'plan_covered':
      return 'success';
    case 'no_feasible_alternative':
      return 'context';
    case 'uncertain_data':
      return 'no_verdict';
  }
}

function decisionTitle(decision: NightDefensiveDecision): string {
  const titles: Record<NightDefensiveDecision['state'], string> = {
    plan_covered: 'Plan defensivo cubierto',
    covered_with_substitution:
      decision.managementOutcome === 'failure' ? 'Sustitución con coste futuro' : 'Sustitución válida',
    correct_hold: 'Reserva defensiva respetada',
    safe_extra_use: 'Uso defensivo extra seguro',
    missed_extra_opportunity: 'Oportunidad defensiva factible',
    plan_broken: 'Reserva defensiva rota',
    reminder_missed: 'Reminder defensivo omitido',
    death_with_viable_cd: 'Muerte con respuesta defensiva viable',
    death_with_ready_cd: 'CD disponible solo al morir',
    no_feasible_alternative: 'Sin alternativa defensiva factible',
    uncertain_data: 'Decisión defensiva sin veredicto',
  };
  return titles[decision.state];
}

function decisionObservation(decision: NightDefensiveDecision): string {
  const planned =
    decision.plannedSpellName != null
      ? safeSpellName(decision.plannedSpellName)
      : decision.plannedSpellId == null
        ? 'el defensivo asignado'
        : `#${decision.plannedSpellId}`;
  const actual =
    decision.actualSpellName != null
      ? safeSpellName(decision.actualSpellName)
      : decision.actualSpellId == null
        ? 'el cooldown'
        : `#${decision.actualSpellId}`;
  const mechanic =
    decision.mechanicName ??
    (decision.abilityId == null ? 'la ventana observada' : `mecánica #${decision.abilityId}`);
  const candidates = decision.candidateSpellNames.map(safeSpellName).join(' / ') || 'un defensivo propio';
  const untilFuture =
    decision.relatedFutureAtMs == null
      ? null
      : Math.max(0, decision.relatedFutureAtMs - decision.atMs);

  switch (decision.state) {
    case 'plan_broken':
      if (decision.reason === 'TARGET_MISMATCH') {
        return `${actual} se lanzó sobre otro objetivo y no cubrió ${mechanic}.`;
      }
      return `${actual} se usó${
        decision.actualCastAtMs == null
          ? ''
          : ` ${formatDuration(Math.max(0, decision.atMs - decision.actualCastAtMs))} antes`
      }; faltaban ${formatDuration(decision.cooldownRemainingMs ?? 0)} al llegar ${mechanic}.`;
    case 'reminder_missed':
      return `${planned} estaba listo en la ventana de ${mechanic}, pero no se lanzó.`;
    case 'covered_with_substitution':
      return `${actual} cubrió el slot de ${planned}${
        decision.reason === 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT'
          ? ', consumiendo una reserva posterior.'
          : ' sin coste futuro detectado.'
      }`;
    case 'correct_hold':
      return `${candidates} estaba listo, pero usarlo habría roto la reserva${
        untilFuture == null ? ' posterior.' : ` ${formatDuration(untilFuture)} después.`
      }`;
    case 'safe_extra_use':
      return `${actual} aportó cobertura adicional y recuperó sin romper una reserva superior.`;
    case 'missed_extra_opportunity':
      return `El replay encontró una secuencia segura con ${candidates} para cubrir ${mechanic}.`;
    case 'death_with_viable_cd':
      return `${candidates} estuvo disponible durante la secuencia letal observada.`;
    case 'death_with_ready_cd':
      return `${candidates} estaba disponible al morir, pero no consta que lo estuviera al comenzar la secuencia previa.`;
    case 'no_feasible_alternative':
      return 'El replay no encontró una secuencia defensiva mejor sin sacrificar la siguiente ventana crítica.';
    case 'plan_covered':
      return `${planned} cubrió correctamente ${mechanic}.`;
    case 'uncertain_data':
      return 'Build, objetivo o timing insuficiente para evaluar la decisión.';
  }
}

function decisionAction(decision: NightDefensiveDecision): string | null {
  const planned =
    decision.plannedSpellName != null
      ? safeSpellName(decision.plannedSpellName)
      : decision.plannedSpellId == null
        ? 'el defensivo asignado'
        : `#${decision.plannedSpellId}`;
  const mechanic =
    decision.mechanicName ??
    (decision.abilityId == null ? 'esa ventana' : `mecánica #${decision.abilityId}`);
  const candidates = decision.candidateSpellNames.map(safeSpellName).join(' / ') || 'el defensivo factible';
  switch (decision.reason) {
    case 'TARGET_MISMATCH':
      return `Lanza ${planned} sobre el objetivo publicado para ${mechanic}.`;
    case 'EARLY_CAST_CAUSED_MISS':
      return `Conserva ${planned} hasta su ventana publicada de ${mechanic}.`;
    case 'READY_NOT_CAST_IN_WINDOW':
      return `Ejecuta ${planned} dentro de la ventana publicada de ${mechanic}.`;
    case 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT':
      return `Evita consumir la reserva posterior al sustituir ${planned}; usa una alternativa que el replay marque sin conflicto.`;
    case 'COUNTERFACTUAL_FEASIBLE':
      return `Usa ${candidates} en ${mechanic}; el replay confirma que recupera sin romper otra reserva.`;
    case 'DEATH_COUNTERFACTUAL_FEASIBLE':
      return `Prepara ${candidates} para la secuencia letal observada; existe una respuesta factible, sin afirmar supervivencia garantizada.`;
    case 'RESERVED_HIGHER_PRIORITY':
      return 'Mantén la reserva: no usar el cooldown en esa ventana fue la decisión correcta.';
    case 'PLANNED_CAST_IN_WINDOW':
    case 'SUBSTITUTE_VALID_NO_FUTURE_COST':
    case 'SAFE_EXTRA_USE':
    case 'NO_COUNTERFACTUAL_SCHEDULE':
      return null;
    case 'DEATH_READY_AT_END_ONLY':
    case 'UNRESOLVED_BUILD_OR_RULE':
      return null;
    default:
      return null;
  }
}

/** Versión de una frase de `decisionAction`, para la franja Impacto/Por qué
 * importa/Prevención de la card (spec visual sección 7-8). Solo cubre los
 * reason codes donde existe una síntesis corta que no repite ni inventa
 * nada nuevo respecto a `action`; el resto queda `null` y la franja muestra
 * "—" en esa celda sin romper la anatomía (permitido explícitamente por la
 * spec, sección 9). */
function decisionPreventionKey(decision: NightDefensiveDecision): string | null {
  const planned =
    decision.plannedSpellName != null ? safeSpellName(decision.plannedSpellName) : 'el CD asignado';
  switch (decision.reason) {
    case 'TARGET_MISMATCH':
      return 'Confirma el objetivo antes de lanzarlo.';
    case 'EARLY_CAST_CAUSED_MISS':
      return `Espera a la ventana antes de usar ${planned}.`;
    case 'READY_NOT_CAST_IN_WINDOW':
      return `No dejes ${planned} listo sin usar en la ventana.`;
    case 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT':
      return 'No sustituyas si rompe la siguiente reserva.';
    case 'COUNTERFACTUAL_FEASIBLE':
      return 'Ten la alternativa lista para la próxima vez.';
    case 'DEATH_COUNTERFACTUAL_FEASIBLE':
      return 'Prepara el CD antes de que empiece la secuencia letal.';
    case 'RESERVED_HIGHER_PRIORITY':
      return 'Sigue reservando: fue la decisión correcta.';
    default:
      return null;
  }
}

function defensivePriority(decision: NightDefensiveDecision): number {
  if (decision.state === 'plan_broken' || decision.state === 'reminder_missed') return 0;
  if (decision.state === 'death_with_viable_cd') return 1;
  if (decision.state === 'missed_extra_opportunity') return 3;
  if (decision.state === 'death_with_ready_cd') return 4;
  return 6;
}

/**
 * Proyección de spells canónicos para coaching. El evaluator ya decidió qué spells sostienen el veredicto:
 * - missed_ready -> decisiveSpellIds son el/los recursos cuya disponibilidad probada crea el fallo.
 * - missed_due_to_mistime -> decisiveSpellIds son los recursos vinculados al fallo temporal.
 *
 * Nunca volvemos a elegir candidatos mirando `available_unused` ni a recalcular el verdict en frontend. Los
 * `usedSpellIds` se conservan como contexto, pero si un mismo spell es decisivo en missed_ready prevalece la
 * etiqueta "available_unused" para no publicar dos chips contradictorios del mismo recurso.
 */
function canonicalEpisodeDefensives(
  episode: CanonicalDefensiveEpisodeView,
  spellNameById: ReadonlyMap<number, string> | undefined,
): RaiderEvidenceDefensive[] {
  const rows: RaiderEvidenceDefensive[] = [];
  const decisive = new Set(episode.decisiveSpellIds);
  const decisiveStatus = episode.responseVerdict === 'missed_ready' ? 'available_unused' : 'used';

  for (const spellId of episode.decisiveSpellIds) {
    rows.push({
      spellId,
      name: safeSpellName(spellNameById?.get(spellId) ?? `#${spellId}`),
      status: decisiveStatus,
    });
  }
  for (const spellId of episode.usedSpellIds) {
    if (decisive.has(spellId)) continue;
    rows.push({
      spellId,
      name: safeSpellName(spellNameById?.get(spellId) ?? `#${spellId}`),
      status: 'used',
    });
  }
  return [...new Map(rows.map((row) => [`${row.spellId}|${row.status}`, row])).values()];
}

function canonicalDecisiveNames(
  episode: CanonicalDefensiveEpisodeView,
  spellNameById: ReadonlyMap<number, string> | undefined,
): string | null {
  if (!episode.decisiveSpellIds.length) return null;
  return episode.decisiveSpellIds
    .map((spellId) => safeSpellName(spellNameById?.get(spellId) ?? `#${spellId}`))
    .join(' / ');
}

interface CanonicalMechanicCoachingMetadata {
  mechanicName: string;
  description: string | null;
  resolution: string | null;
}

function canonicalMechanicMetadataKey(bossId: string, difficulty: string, abilityId: number): string {
  return `${bossId}|${difficulty}|${abilityId}`;
}

/**
 * Bridge de PRESENTACIÓN, no de scoring. v7 sigue siendo la única autoridad para decidir si el episodio es
 * missed_ready/missed_due_to_mistime y qué spell es decisivo. Para poder volver a enseñar coaching útil se
 * reutiliza la metadata descriptiva ya resuelta en el resumen de la noche por identidad exacta
 * boss+dificultad+abilityId. No hay join por proximidad temporal, ni se usa `covered/coverable/options` para
 * alterar el verdict. El orden de autoridad es: metadata ya presente en el episodio canónico > breakdown
 * descriptivo de mecánicas > fallos/muertes exactos de esa misma ability.
 */
function buildCanonicalMechanicCoachingMetadata(
  summary: NightPlayerSummary,
): ReadonlyMap<string, CanonicalMechanicCoachingMetadata> {
  const map = new Map<string, CanonicalMechanicCoachingMetadata>();
  const upsert = (
    bossId: string,
    difficulty: string,
    abilityId: number,
    mechanicName: string | null | undefined,
    description: string | null | undefined,
    resolution: string | null | undefined,
  ) => {
    if (!mechanicName) return;
    const key = canonicalMechanicMetadataKey(bossId, difficulty, abilityId);
    const current = map.get(key);
    map.set(key, {
      mechanicName: current?.mechanicName ?? mechanicName,
      description: current?.description ?? description ?? null,
      resolution: current?.resolution ?? resolution ?? null,
    });
  };

  for (const row of summary.defensiveSummary?.mechanicPressureBreakdown ?? []) {
    upsert(row.bossId, row.difficulty, row.mechanicId, row.mechanicName, row.aiNote, row.resolution);
  }
  for (const row of summary.mechanicFails ?? []) {
    upsert(row.bossId, row.difficulty, row.mechanicId, row.mechanicName, row.aiNote, row.resolution);
  }
  for (const row of summary.deaths ?? []) {
    if (row.mechanicId == null || !row.mechanicName) continue;
    upsert(row.bossId, row.difficulty, row.mechanicId, row.mechanicName, row.aiNote, row.resolution);
  }
  return map;
}

function enrichCanonicalEpisodeForCoaching(
  episode: CanonicalDefensiveEpisodeView,
  metadata: ReadonlyMap<string, CanonicalMechanicCoachingMetadata>,
): CanonicalDefensiveEpisodeView {
  if (episode.dominantAbilityGameId == null) return episode;
  const fallback = metadata.get(
    canonicalMechanicMetadataKey(episode.bossId, episode.difficulty, episode.dominantAbilityGameId),
  );
  if (!fallback) return episode;
  return {
    ...episode,
    mechanicName: episode.mechanicName ?? fallback.mechanicName,
    mechanicDescription: episode.mechanicDescription ?? fallback.description,
    mechanicResolution: episode.mechanicResolution ?? fallback.resolution,
  };
}

/** Compacta copy revisado sin cambiar su significado: solo normaliza espacios y corta en un límite visual. */
function compactCoachingText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const candidate = normalized.slice(0, maxLength + 1);
  const wordBoundary = candidate.lastIndexOf(' ');
  const cutAt = wordBoundary >= Math.floor(maxLength * 0.65) ? wordBoundary : maxLength;
  return `${candidate.slice(0, cutAt).replace(/[,:;\s]+$/, '')}…`;
}

/** "Prevención clave" deriva solo de la primera instrucción ya revisada de `resolution`. */
function preventionFromResolution(resolution: string): string {
  const normalized = resolution.replace(/\s+/g, ' ').trim();
  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  return compactCoachingText(firstSentence, 110);
}

/** Copy humano para los dos únicos responseVerdict que generan coaching accionable (§76 — nunca mostrar
 * covered_verified/missed_ready/uncertain/etc. en crudo al raider). El texto se limita a proyectar el verdict
 * y sus decisiveSpellIds ya persistidos; no reinterpreta candidates ni crea una segunda decisión. */
function canonicalDefensiveItem(
  episode: CanonicalDefensiveEpisodeView,
  spellNameById: ReadonlyMap<number, string> | undefined,
): RaiderEvidenceItem {
  const mechanic = episode.mechanicName ?? 'esta ventana defensiva';
  const isMistimed = episode.responseVerdict === 'missed_due_to_mistime';
  const decisiveNames = canonicalDecisiveNames(episode, spellNameById);
  const baseTitle = isMistimed ? 'Mal timing demostrado' : 'CD disponible sin cubrir';
  const title = episode.mechanicName ? `${episode.mechanicName} · ${baseTitle}` : baseTitle;
  const observation = isMistimed
    ? decisiveNames
      ? `El uso de ${decisiveNames} no mantuvo cobertura en el momento decisivo de ${mechanic}.`
      : `El uso previo de tu defensivo demostrablemente no llegó a cubrir ${mechanic}.`
    : decisiveNames
      ? episode.usageEngaged
        ? `Hubo uso defensivo durante ${mechanic}, pero la ventana quedó sin cobertura; ${decisiveNames} fue la respuesta que IRIS confirmó disponible en el momento decisivo.`
        : `${decisiveNames} estaba disponible como respuesta válida para ${mechanic}, pero la ventana quedó sin cobertura.`
      : episode.usageEngaged
        ? `Usaste algo durante ${mechanic}, pero ninguna acción cubrió la ventana; había un cooldown listo sin usar.`
        : `Había un cooldown listo para ${mechanic} y no se usó.`;
  const defensiveEvidence = isMistimed
    ? decisiveNames
      ? `IRIS vinculó el fallo de timing a ${decisiveNames}; el veredicto procede de la evidencia temporal canónica de este episodio.`
      : 'IRIS demostró un fallo de timing defensivo en esta ventana mediante la evidencia temporal canónica del episodio.'
    : decisiveNames
      ? `IRIS verificó que ${decisiveNames} era una respuesta aplicable y estaba disponible en el momento evaluado; esa evidencia sostiene este fallo.`
      : 'IRIS verificó una respuesta defensiva aplicable y disponible en el momento evaluado; esa evidencia sostiene este fallo.';
  const action = isMistimed
    ? decisiveNames
      ? `Ajusta el timing de ${decisiveNames} para que su efecto coincida con la ventana de ${mechanic}.`
      : `Ajusta el timing de tu defensivo para que siga activo cuando llegue ${mechanic}.`
    : decisiveNames
      ? `Usa ${decisiveNames} como respuesta a ${mechanic}; IRIS lo identificó como disponible y aplicable en esta oportunidad.`
      : `Ejecuta tu cooldown como respuesta a ${mechanic}; estaba disponible y no se usó.`;
  const preventionKey = isMistimed
    ? decisiveNames
      ? `Alinea ${decisiveNames} con el momento decisivo de la ventana.`
      : 'Guarda margen de timing antes del impacto.'
    : decisiveNames
      ? `No dejes ${decisiveNames} disponible sin usar en esta oportunidad.`
      : 'No dejes el cooldown listo sin usar.';

  const mechanicDescription = episode.mechanicDescription?.trim() || null;
  const mechanicResolution = episode.mechanicResolution?.trim() || null;
  // Contrato visual estable: "Qué sabemos" aporta contexto; "Cómo resolver" SIEMPRE conserva la
  // resolución táctica revisada cuando existe. La acción defensiva personal solo ocupa "Cómo resolver"
  // cuando no tenemos una resolución de mecánica publicable.
  const whyItMatters = mechanicDescription
    ? mechanicDescription
    : mechanicResolution
      ? `${mechanic} tiene una resolución táctica revisada: ${compactCoachingText(mechanicResolution, 145)}`
      : defensiveEvidence;
  const resolutionText = mechanicResolution ?? action;

  return {
    id: `defensive|canonical|${episode.episodeId}`,
    kind: 'defensive',
    pullId: episode.pullId,
    pullNumber: episode.pullNumber,
    bossId: episode.bossId,
    bossName: episode.bossName,
    difficulty: episode.difficulty,
    atMs: episode.peakMs,
    mechanicId: episode.dominantAbilityGameId,
    mechanicName: episode.mechanicName,
    title,
    // missed_ready/missed_due_to_mistime solo los produce el evaluator con confidence punitiva
    // (verified/inferred) — para cuando lleguen aquí ya son un fallo demostrado, no una sugerencia (§25/§29).
    verdict: 'confirmed_error',
    reasonCode: episode.responseVerdict === 'missed_ready' ? 'DEFENSIVE_READY_NOT_USED' : 'DEFENSIVE_MISTIMED',
    observation,
    whyItMatters,
    action,
    preventionKey,
    // En v3 el texto descriptivo ya se proyecta en "Qué sabemos"; dejarlo también bajo el nombre del boss
    // duplicaría exactamente el mismo copy dentro de la misma card. La metadata original permanece en
    // summary.canonicalDefensive.episodes para cualquier drill-down posterior.
    mechanicDescription: null,
    resolutionText,
    defensives: canonicalEpisodeDefensives(episode, spellNameById),
    confidence: episode.confidence === 'verified' ? 'verified' : episode.confidence === 'inferred' ? 'inferred' : 'uncertain',
    occurrences: [{ pullId: episode.pullId, pullNumber: episode.pullNumber, atMs: episode.peakMs }],
    provenance: [
      {
        source: 'player_pull_defensive_episode_evaluations',
        key: episode.episodeId,
        version: episode.confidence,
      },
    ],
    priorityTier: 0,
    damageTotal: 0,
  };
}

function groupMechanicFails(rows: NightMechanicFailRow[]): RaiderEvidenceItem[] {
  const grouped = new Map<string, NightMechanicFailRow[]>();
  for (const row of rows) {
    if (!verifiableMechanic(row.mechanicId, row.mechanicName)) continue;
    const key = `${row.bossId}|${row.difficulty}|${row.mechanicId}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  return [...grouped.entries()].map(([key, group]) => {
    group.sort((left, right) => left.pullNumber - right.pullNumber || left.timeMs - right.timeMs);
    const first = group[0];
    const personal = group.every(
      (row) => row.category != null && PERSONAL_RESPONSIBILITY_CATEGORIES.has(row.category),
    );
    const resolutions = [...new Set(group.map((row) => row.resolution).filter((value): value is string => !!value))];
    // Mismo criterio de consenso que ya usa repeatedPatterns.aiNote: solo se
    // publica si todas las instancias verificables coinciden.
    const aiNotes = [...new Set(group.map((row) => row.aiNote).filter((value): value is string => !!value))];
    const totalDamage = group.reduce((sum, row) => sum + Math.max(0, row.damageTaken), 0);
  const mechanicContext = aiNotes.length === 1 ? aiNotes[0].trim() : null;
  const quantitativeEvidence =
    totalDamage > 0
      ? `${Math.round(totalDamage).toLocaleString('es-ES')} de daño registrado en ${group.length} exposición${
          group.length === 1 ? '' : 'es'
        }.`
      : `${group.length} exposición${group.length === 1 ? '' : 'es'} verificable${
          group.length === 1 ? '' : 's'
        }.`;
    return {
      id: `mechanic|${key}`,
      kind: 'mechanic',
      pullId: first.pullId,
      pullNumber: first.pullNumber,
      bossId: first.bossId,
      bossName: first.bossName,
      difficulty: first.difficulty,
      atMs: first.timeMs,
      mechanicId: first.mechanicId,
      mechanicName: first.mechanicName,
      title: first.mechanicName,
      verdict: personal ? 'confirmed_error' : first.resolution ? 'coaching' : 'no_verdict',
      reasonCode: personal ? `PERSONAL_${first.category}` : 'CATEGORY_UNRESOLVED',
      observation: `${group.length} incidencia${group.length === 1 ? '' : 's'} registrada${
        group.length === 1 ? '' : 's'
      } en ${first.bossName}.`,
      whyItMatters: mechanicContext
      ? `${compactCoachingText(mechanicContext, 135)} · ${quantitativeEvidence}`
      : quantitativeEvidence,
    action: resolutions.length === 1 ? resolutions[0] : null,
    // No inventa una segunda táctica: condensa la primera instrucción de la resolución revisada.
    preventionKey: resolutions.length === 1 ? preventionFromResolution(resolutions[0]) : null,
      mechanicDescription: aiNotes.length === 1 ? aiNotes[0] : null,
      resolutionText: resolutions.length === 1 ? resolutions[0] : null,
      defensives: [],
      confidence: personal ? 'verified' : 'uncertain',
      occurrences: group.map((row) => ({
        pullId: row.pullId,
        pullNumber: row.pullNumber,
        atMs: row.timeMs,
      })),
      provenance: group.map((row) => ({
        source: 'pull_mechanic_events',
        key: `${row.pullId}|${row.mechanicId}|${row.timeMs}`,
        version: row.comparisonSource,
      })),
      priorityTier: 2,
      damageTotal: totalDamage,
    } satisfies RaiderEvidenceItem;
  });
}

function compareEvidence(left: RaiderEvidenceItem, right: RaiderEvidenceItem): number {
  const leftDeath = left.kind === 'death' || left.reasonCode.startsWith('DEATH_') ? 1 : 0;
  const rightDeath = right.kind === 'death' || right.reasonCode.startsWith('DEATH_') ? 1 : 0;
  return (
    left.priorityTier - right.priorityTier ||
    rightDeath - leftDeath ||
    right.occurrences.length - left.occurrences.length ||
    right.damageTotal - left.damageTotal ||
    (left.pullNumber ?? Number.MAX_SAFE_INTEGER) - (right.pullNumber ?? Number.MAX_SAFE_INTEGER) ||
    (left.atMs ?? Number.MAX_SAFE_INTEGER) - (right.atMs ?? Number.MAX_SAFE_INTEGER) ||
    VERDICT_ORDER[left.verdict] - VERDICT_ORDER[right.verdict] ||
    left.id.localeCompare(right.id)
  );
}

/**
 * La portada de coaching tiene cuatro huecos. Una familia de error muy abundante (p. ej. 15 missed_ready)
 * no debe expulsar toda la información mecánica/preparación si existen otros hallazgos accionables. Se
 * conserva el ranking global y solo se reserva espacio editorial: hasta dos huecos para hallazgos no defensivos
 * cuando los hay. Si solo existe uno, se muestran 3 defensivas + ese hallazgo; si no existe ninguno, pueden
 * mostrarse las 4 defensivas. Esto NO cambia puntuaciones, verdicts ni `items`, solo qué cuatro cards se imprimen.
 */
export function selectCoachingItems(actionable: RaiderEvidenceItem[], limit = 4): RaiderEvidenceItem[] {
  if (limit <= 0 || actionable.length === 0) return [];
  if (actionable.length <= limit) return actionable.slice();

  const nonDefensiveCount = actionable.filter((item) => item.kind !== 'defensive').length;
  const reservedNonDefensive = Math.min(2, nonDefensiveCount, limit);
  const maxDefensive = Math.max(0, limit - reservedNonDefensive);
  const selected: RaiderEvidenceItem[] = [];
  const selectedIds = new Set<string>();
  let defensiveCount = 0;

  for (const item of actionable) {
    if (selected.length >= limit) break;
    if (item.kind === 'defensive' && defensiveCount >= maxDefensive) continue;
    selected.push(item);
    selectedIds.add(item.id);
    if (item.kind === 'defensive') defensiveCount++;
  }

  if (selected.length < limit) {
    for (const item of actionable) {
      if (selected.length >= limit) break;
      if (selectedIds.has(item.id)) continue;
      selected.push(item);
      selectedIds.add(item.id);
    }
  }
  return selected;
}

export function buildRaiderEvidenceProjection(
  summary: NightPlayerSummary,
  options: RaiderEvidenceProjectionOptions = {},
): RaiderEvidenceProjection {
  const evaluatedPulls = summary.pulls.filter((pull) => pull.pullScore != null);
  const evaluatedPullIds = new Set(evaluatedPulls.map((pull) => pull.pullId));
  const v2 =
    'defensiveManagementV2' in options
      ? (options.defensiveManagementV2 ?? null)
      : summary.defensiveManagementV2;
  const canonical = options.canonicalDefensive ?? null;
  const spellNameById = options.spellNameById;
  const items: RaiderEvidenceItem[] = [];
  const v2DeathPulls = new Set<string>();

  if (canonical) {
    const mechanicMetadata = buildCanonicalMechanicCoachingMetadata(summary);
    for (const episode of canonical.episodes) {
      if (episode.responseVerdict !== 'missed_ready' && episode.responseVerdict !== 'missed_due_to_mistime') continue;
      if (!evaluatedPullIds.has(episode.pullId)) continue;
      const enrichedEpisode = enrichCanonicalEpisodeForCoaching(episode, mechanicMetadata);
      items.push(canonicalDefensiveItem(enrichedEpisode, spellNameById));
    }
  } else if (v2) {
    const byEpisode = new Map<string, NightDefensiveDecision>();
    for (const decision of v2.decisions) {
      if (!evaluatedPullIds.has(decision.pullId)) continue;
      const episode =
        decision.causalGroupId ??
        `${decision.pullId}|${decision.windowId ?? decision.slotId ?? decision.abilityId ?? 'decision'}|${decision.atMs}`;
      const current = byEpisode.get(episode);
      if (!current || (decision.primaryPenalty === true && current.primaryPenalty !== true)) {
        byEpisode.set(episode, decision);
      }
    }

    for (const [episode, decision] of byEpisode) {
      const isDeathDecision =
        decision.state === 'death_with_viable_cd' || decision.state === 'death_with_ready_cd';
      if (isDeathDecision) v2DeathPulls.add(decision.pullId);
      // Tener un cooldown listo no identifica la causa de una muerte. Sin
      // habilidad verificable (p. ej. caída/entorno con mechanicId=0), la
      // proyección conserva la muerte como contexto pero no publica una
      // recomendación defensiva ni expone candidatos como si fueran receta.
      const causeIsVerifiable =
        !isDeathDecision || verifiableMechanic(decision.abilityId ?? null, decision.mechanicName);
      const knownReason = causeIsVerifiable && KNOWN_DEFENSIVE_REASONS.has(decision.reason);
      const verdict = causeIsVerifiable ? decisionVerdict(decision) : 'context';
      items.push({
        id: `defensive|${episode}`,
        kind: 'defensive',
        pullId: decision.pullId,
        pullNumber: decision.pullNumber,
        bossId: decision.bossId,
        bossName: decision.bossName,
        difficulty: decision.difficulty,
        atMs: decision.atMs,
        mechanicId: decision.abilityId ?? null,
        mechanicName: decision.mechanicName,
        title: causeIsVerifiable ? decisionTitle(decision) : 'Causa no identificada',
        verdict,
        reasonCode: causeIsVerifiable ? decision.reason : 'DEATH_CAUSE_UNIDENTIFIED',
        observation: causeIsVerifiable
          ? decisionObservation(decision)
          : 'Muerte evaluable registrada sin una causa mitigable identificada.',
        whyItMatters:
          !causeIsVerifiable
            ? 'La disponibilidad de un cooldown al final no demuestra que respondiera a la causa ni que pudiera cambiar el desenlace.'
            : decision.state === 'death_with_viable_cd'
            ? 'Había una respuesta factible durante la secuencia; no demuestra cuánto daño habría prevenido.'
            : decision.state === 'death_with_ready_cd'
              ? 'La disponibilidad exacta al morir es contexto y no demuestra que el cooldown pudiera alterar el desenlace.'
              : null,
        action: knownReason ? decisionAction(decision) : null,
        preventionKey: knownReason ? decisionPreventionKey(decision) : null,
        mechanicDescription: causeIsVerifiable ? decision.mechanicDescription : null,
        resolutionText: causeIsVerifiable ? decision.mechanicResolution : null,
        defensives: causeIsVerifiable ? defensiveNames(decision) : [],
        confidence: knownReason ? v2.dataConfidence : 'uncertain',
        occurrences: [
          { pullId: decision.pullId, pullNumber: decision.pullNumber, atMs: decision.atMs },
        ],
        provenance: [
          {
            source: 'player_pull_defensive_evaluations',
            key: `${decision.pullId}|${episode}`,
            version: `${v2.evaluatorVersion}|${v2.resolverVersion}|${v2.solverVersion}`,
          },
        ],
        priorityTier: knownReason ? defensivePriority(decision) : 9,
        // §"si en ese momento tenía un defensivo en CD (mal usado)... si lo
        // tiró en las mecánicas de más daño" (feedback real, 2026-09-03):
        // antes siempre 0 — el pico de daño real de la ventana (cuando la
        // decisión viene de una ventana de presión, no de un slot de plan o
        // una muerte) ahora viaja hasta aquí vía peakValue.
        damageTotal: decision.peakValue ?? 0,
      });
    }
  }

  for (const death of summary.deaths) {
    if (
      !evaluatedPullIds.has(death.pullId) ||
      death.isWipeCall ||
      death.isNinjaPull ||
      death.statisticalExclusionReason
    ) {
      continue;
    }
    // El evaluator v2 representa el mismo episodio con una prueba temporal
    // más fuerte; no se crea una segunda card legacy para esa muerte.
    if (v2DeathPulls.has(death.pullId)) continue;
    const mechanicIsVerifiable = verifiableMechanic(death.mechanicId, death.mechanicName);
    const hasResponse = death.defensivesAvailable.length > 0;
    // §45 (cutover frontend, corregido en revisión): v7 no tiene linkage canónico episodio↔muerte hoy — ni por
    // identidad ni por proximidad temporal (un join "misma pull ± N segundos" sería el mismo problema con
    // disfraz canónico). `death.defensivesAvailable` es legacy (death_cause.defensiveOptions, sin vínculo
    // canónico) — en el modo canónico (v3) nunca se usa para acusar; la muerte se sigue mostrando como
    // muerte/contexto, solo deja de afirmar "tenías X disponible" hasta que exista ese vínculo real.
    const canCoachDefensiveResponse = !canonical && mechanicIsVerifiable && hasResponse;
    const availableDefensiveNames = death.defensivesAvailable.map((row) => safeSpellName(row.name)).join(' / ');
    // §"no tenemos en ningún lado el uso de poción / piedra de brujo" (feedback
    // real, 2026-09-03): usedHealthstoneInPull/usedHealthPotionInPull ya
    // existen en NightDeathRow (night-player-summary.service.ts) pero no se
    // mostraban en ningún sitio de la infografía. Son solo "se usó" — no
    // "estaba disponible y no se usó" (eso exigiría saber si había Warlock en
    // el pull, que no está aquí) — así que solo se afirma el caso positivo,
    // nunca se interpreta `false` como una omisión.
    const consumableNote = [
      death.usedHealthstoneInPull ? 'usó piedra de brujo' : null,
      death.usedHealthPotionInPull ? 'usó poción de vida' : null,
    ].filter((note): note is string => note != null).join(' y ');
    items.push({
      id: `death|${death.pullId}|${death.timeMs}`,
      kind: 'death',
      pullId: death.pullId,
      pullNumber: death.pullNumber,
      bossId: death.bossId,
      bossName: death.bossName,
      difficulty: death.difficulty,
      atMs: death.timeMs,
      mechanicId: mechanicIsVerifiable ? death.mechanicId : null,
      mechanicName: mechanicIsVerifiable ? death.mechanicName : null,
      title: mechanicIsVerifiable ? death.mechanicName! : 'Causa no identificada',
      verdict: canCoachDefensiveResponse ? 'coaching' : 'context',
      reasonCode: !mechanicIsVerifiable
        ? 'DEATH_CAUSE_UNIDENTIFIED'
        : canCoachDefensiveResponse
          ? 'DEATH_READY_AT_END_LEGACY'
          : 'EVALUABLE_DEATH_CONTEXT',
      observation:
        (canCoachDefensiveResponse
          ? `Murió con ${availableDefensiveNames} disponible al final.`
          : mechanicIsVerifiable
            ? 'Muerte evaluable registrada sin una respuesta defensiva disponible identificada.'
            : 'Muerte evaluable registrada sin una causa mitigable identificada.') +
        (consumableNote ? ` En este pull ${consumableNote}.` : ''),
      whyItMatters:
        !mechanicIsVerifiable
          ? 'Se contabiliza la muerte, pero no se atribuye a una mecánica ni se recomienda un defensivo sin ese vínculo.'
          : death.damageWindowTotal == null
          ? 'La muestra temporal de daño es insuficiente para una afirmación contrafactual.'
          : `${Math.round(death.damageWindowTotal).toLocaleString('es-ES')} de daño observado en los 5 s previos.`,
      // §Hallazgo 3 (2026-09-03): antes esta card usaba siempre
      // `death.resolution` (nota táctica general de la mecánica: cómo
      // esquivarla) también cuando el hallazgo real de la card es "murió con
      // un defensivo libre" — dos preguntas distintas ("¿cómo evito esto?"
      // vs. "¿qué hago con mi cooldown?"). El resultado eran cards donde la
      // corrección hablaba de posicionamiento sin mencionar el defensivo que
      // la propia card acababa de mostrar como disponible. Cuando el
      // hallazgo es de disponibilidad defensiva, la corrección debe salir
      // del mismo dato (nombres de `defensivesAvailable`), no de la
      // resolución general de la mecánica.
      action: canCoachDefensiveResponse
        ? `Ten ${availableDefensiveNames} preparado para esa ventana; estaba disponible y no se usó, sin que esto demuestre que habría evitado la muerte.`
        : mechanicIsVerifiable
          ? death.resolution
          : null,
      preventionKey: canCoachDefensiveResponse
        ? `Prepara ${availableDefensiveNames} antes de esa ventana.`
        : null,
      mechanicDescription: mechanicIsVerifiable ? death.aiNote : null,
      resolutionText: mechanicIsVerifiable ? death.resolution : null,
      // §45 (corregido en revisión): en modo canónico (v3) esta lista se suprime por completo, no solo el
      // verdict/action — death.defensivesAvailable es legacy sin vínculo canónico con el episodio, y mostrarla
      // como chips informativos seguiría siendo la misma afirmación de disponibilidad sin poder sostenerla.
      defensives:
        !canonical && mechanicIsVerifiable
          ? death.defensivesAvailable.map((row) => ({
              ...row,
              name: safeSpellName(row.name),
              status: 'available_unused' as const,
            }))
          : [],
      confidence: mechanicIsVerifiable ? 'inferred' : 'uncertain',
      occurrences: [{ pullId: death.pullId, pullNumber: death.pullNumber, atMs: death.timeMs }],
      provenance: [
        {
          source: 'player_pull_records.death_cause',
          key: `${death.pullId}|${death.timeMs}`,
          version: null,
        },
      ],
      priorityTier: canCoachDefensiveResponse ? 1 : 8,
      damageTotal: death.damageWindowTotal ?? 0,
    });
  }

  items.push(
    ...groupMechanicFails(
      summary.mechanicFails.filter((row) => evaluatedPullIds.has(row.pullId)),
    ),
  );

  const preparation = summary.startingPreparation;
  if (preparation) {
    const missingEnchants = Math.max(
      0,
      preparation.enchantableSlotCount - preparation.enchantedSlotCount,
    );
    const missingGems = Math.max(0, preparation.gemmableSlotCount - preparation.gemmedSlotCount);
    if (missingEnchants || missingGems) {
      items.push({
        id: 'preparation|first-pull',
        kind: 'preparation',
        pullId: null,
        pullNumber: preparation.fromPullNumber,
        bossId: null,
        bossName: preparation.bossName,
        difficulty: null,
        atMs: null,
        mechanicId: null,
        mechanicName: null,
        title: 'Preparación antes de entrar',
        verdict: 'confirmed_error',
        reasonCode: 'FIRST_PULL_GEAR_INCOMPLETE',
        observation: `${missingEnchants} enchant${missingEnchants === 1 ? '' : 's'} y ${missingGems} hueco${
          missingGems === 1 ? '' : 's'
        } de gema sin cubrir en el primer pull.`,
        whyItMatters: 'La medición usa el equipo del primer pull y no el obtenido durante la raid.',
        action: 'Completa los enchants y gemas indicados antes de la próxima raid.',
        preventionKey: 'Revisa enchants/gemas antes de pullear, no durante la noche.',
        mechanicDescription: null,
        resolutionText: null,
        defensives: [],
        confidence: preparation.preparationSource === 'ledger_v3' ? 'verified' : 'inferred',
        occurrences: [],
        provenance: [
          {
            source: 'player_pull_records.gear',
            key: `pull-number|${preparation.fromPullNumber}`,
            version: preparation.preparationLedgerVersion,
          },
        ],
        priorityTier: 4,
        damageTotal: 0,
      });
    }
  }

  items.sort(compareEvidence);
  const actionable = items.filter(
    (item) =>
      item.verdict === 'confirmed_error' ||
      item.verdict === 'coaching' ||
      (item.verdict === 'no_verdict' && item.kind === 'defensive'),
  );
  // §"solo aparecen 3 cards y creo que caben 4 (o 5)" (feedback real,
  // 2026-09-03): cuatro huecos fijos, pero la selección es ahora diversa: una sola familia defensiva no puede
  // expulsar toda la mecánica/preparación accionable. selectCoachingItems no toca verdicts ni scoring.
  const coaching = selectCoachingItems(actionable, 4);
  const uncertainVisible = coaching.some((item) => item.confidence === 'uncertain');
  // §Frontend cutover: la v3 canvas nunca pasa v2, así que "high" no puede seguir dependiendo solo de su
  // presencia — canonicalStrong exige cobertura completa (state='available'), no solo "hay canonicalDefensive".
  // Una noche con datos parciales (state='partial') cae a 'partial'/'limited' igual que antes lo hacía v2=null.
  const canonicalStrong = canonical != null && canonical.state === 'available';
  const quality: RaiderEvidenceQuality =
    evaluatedPulls.length === 0
      ? 'limited'
      : (v2 || canonicalStrong) && !uncertainVisible
        ? 'high'
        : items.some((item) => item.confidence !== 'uncertain')
          ? 'partial'
          : 'limited';
  // §"esto no es información útil para un raider" (feedback real,
  // 2026-09-03): las tres frases anteriores explicaban mecanismos internos
  // (gate, generación, confianza homogénea) en vez de lo que el jugador
  // puede confiar de esta lámina.
  const qualityReason =
    quality === 'high'
      ? 'Todos los datos de la noche están completos y verificados.'
      : quality === 'partial'
        ? 'Algunas cards se basan en menos datos que otras; el veredicto de cada una ya lo indica.'
        : 'No hay datos suficientes esta noche para dar consejos firmes.';

  const itemsByPull = new Map<string, RaiderEvidenceItem[]>();
  for (const item of items) {
    if (!item.pullId) continue;
    const rows = itemsByPull.get(item.pullId) ?? [];
    rows.push(item);
    itemsByPull.set(item.pullId, rows);
  }
  const timeline = evaluatedPulls.map((pull): RaiderPullTimelineCell => {
    const evidence = itemsByPull.get(pull.pullId) ?? [];
    const state = evidence.some((item) => item.verdict === 'confirmed_error')
      ? 'confirmed_error'
      : evidence.some((item) => item.verdict === 'coaching')
        ? 'coaching'
        : evidence.some((item) => item.verdict === 'correct_hold')
          ? 'correct_hold'
          : pull.scoreBreakdown.mechanicFailCount === 0 && !pull.scoreBreakdown.died
            ? 'clean'
            : 'no_data';
    return {
      pullId: pull.pullId,
      pullNumber: pull.pullNumber,
      bossId: pull.bossId,
      bossName: pull.bossName,
      difficulty: pull.difficulty,
      score: pull.pullScore!,
      state,
      evidenceCount: evidence.length,
    };
  });

  return {
    reportCode: summary.reportCode,
    playerName: summary.playerName,
    evaluatedPullIds: evaluatedPulls.map((pull) => pull.pullId),
    quality,
    qualityReason,
    items,
    coaching,
    additionalCoachingCount: Math.max(0, actionable.length - coaching.length),
    timeline,
    defensiveGeneration: v2
      ? {
          evaluatorVersion: v2.evaluatorVersion,
          resolverVersion: v2.resolverVersion,
          solverVersion: v2.solverVersion,
          gameBuild: v2.gameBuild,
          buildFingerprint: v2.buildFingerprint,
        }
      : null,
  };
}
