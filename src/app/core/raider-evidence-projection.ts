import type {
  NightDefensiveDecision,
  NightDefensiveManagementV2,
  NightMechanicFailRow,
  NightPlayerSummary,
} from './night-player-summary.service';
import { formatDuration } from '../shared/format.util';
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
  /** Pasar null cuando el feature gate visible esté apagado. */
  defensiveManagementV2?: NightDefensiveManagementV2 | null;
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

function defensiveNames(decision: NightDefensiveDecision): RaiderEvidenceDefensive[] {
  const rows: RaiderEvidenceDefensive[] = [];
  if (decision.plannedSpellId != null) {
    rows.push({
      spellId: decision.plannedSpellId,
      name: decision.plannedSpellName ?? `#${decision.plannedSpellId}`,
      status: 'planned',
    });
  }
  if (decision.actualSpellId != null) {
    rows.push({
      spellId: decision.actualSpellId,
      name: decision.actualSpellName ?? `#${decision.actualSpellId}`,
      status: 'used',
    });
  }
  for (let index = 0; index < (decision.candidateSpellIds ?? []).length; index++) {
    const spellId = decision.candidateSpellIds![index];
    rows.push({
      spellId,
      name: decision.candidateSpellNames[index] ?? `#${spellId}`,
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
    decision.plannedSpellName ??
    (decision.plannedSpellId == null ? 'el defensivo asignado' : `#${decision.plannedSpellId}`);
  const actual =
    decision.actualSpellName ??
    (decision.actualSpellId == null ? 'el cooldown' : `#${decision.actualSpellId}`);
  const mechanic =
    decision.mechanicName ??
    (decision.abilityId == null ? 'la ventana observada' : `mecánica #${decision.abilityId}`);
  const candidates = decision.candidateSpellNames.join(' / ') || 'un defensivo propio';
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
    decision.plannedSpellName ??
    (decision.plannedSpellId == null ? 'el defensivo asignado' : `#${decision.plannedSpellId}`);
  const mechanic =
    decision.mechanicName ??
    (decision.abilityId == null ? 'esa ventana' : `mecánica #${decision.abilityId}`);
  const candidates = decision.candidateSpellNames.join(' / ') || 'el defensivo factible';
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

function defensivePriority(decision: NightDefensiveDecision): number {
  if (decision.state === 'plan_broken' || decision.state === 'reminder_missed') return 0;
  if (decision.state === 'death_with_viable_cd') return 1;
  if (decision.state === 'missed_extra_opportunity') return 3;
  if (decision.state === 'death_with_ready_cd') return 4;
  return 6;
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
    const totalDamage = group.reduce((sum, row) => sum + Math.max(0, row.damageTaken), 0);
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
      whyItMatters:
        totalDamage > 0
          ? `${Math.round(totalDamage).toLocaleString('es-ES')} de daño registrado en ${group.length} exposición${
              group.length === 1 ? '' : 'es'
            }.`
          : `${group.length} exposición${group.length === 1 ? '' : 'es'} verificable${
              group.length === 1 ? '' : 's'
            }.` ,
      action: resolutions.length === 1 ? resolutions[0] : null,
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
  const items: RaiderEvidenceItem[] = [];
  const v2DeathPulls = new Set<string>();

  if (v2) {
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
        damageTotal: 0,
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
    const canCoachDefensiveResponse = mechanicIsVerifiable && hasResponse;
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
      observation: canCoachDefensiveResponse
        ? `Murió con ${death.defensivesAvailable.map((row) => row.name).join(' / ')} disponible al final.`
        : mechanicIsVerifiable
          ? 'Muerte evaluable registrada sin una respuesta defensiva disponible identificada.'
          : 'Muerte evaluable registrada sin una causa mitigable identificada.',
      whyItMatters:
        !mechanicIsVerifiable
          ? 'Se contabiliza la muerte, pero no se atribuye a una mecánica ni se recomienda un defensivo sin ese vínculo.'
          : death.damageWindowTotal == null
          ? 'La muestra temporal de daño es insuficiente para una afirmación contrafactual.'
          : `${Math.round(death.damageWindowTotal).toLocaleString('es-ES')} de daño observado en los 5 s previos.`,
      action: mechanicIsVerifiable ? death.resolution : null,
      defensives: mechanicIsVerifiable
        ? death.defensivesAvailable.map((row) => ({
            ...row,
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
  const coaching = actionable.slice(0, 3);
  const uncertainVisible = coaching.some((item) => item.confidence === 'uncertain');
  const quality: RaiderEvidenceQuality =
    evaluatedPulls.length === 0
      ? 'limited'
      : v2 && !uncertainVisible
        ? 'high'
        : items.some((item) => item.confidence !== 'uncertain')
          ? 'partial'
          : 'limited';
  const qualityReason =
    quality === 'high'
      ? 'Todos los pulls evaluables comparten una generación defensiva completa; las cards visibles conservan su confianza.'
      : quality === 'partial'
        ? 'Alguna sección usa evidencia legacy o una card no alcanza confianza homogénea; cada veredicto mantiene su gate.'
        : 'No hay muestra suficiente para publicar coaching fuerte; se prioriza contexto o ausencia de veredicto.';

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
