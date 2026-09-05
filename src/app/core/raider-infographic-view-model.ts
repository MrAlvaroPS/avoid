import type {
  NightDefensiveDecision,
  NightDefensiveManagementV2,
  NightEvolutionMetric,
  NightMechanicDefensiveStat,
  NightPlayerSummary,
} from './night-player-summary.service';
import type {
  RaiderEvidenceDefensive,
  RaiderEvidenceItem,
  RaiderEvidenceProjection,
  RaiderEvidenceVerdict,
} from './raider-evidence-projection';
import { classDisplayName, formatDuration, safeSpellName } from '../shared/format.util';

export type RaiderInfographicTone =
  | 'positive'
  | 'danger'
  | 'warning'
  | 'information'
  | 'neutral';

export interface RaiderInfographicMetric {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: RaiderInfographicTone;
}

export interface RaiderCoachingCard {
  id: string;
  priority: number;
  title: string;
  bossId: string | null;
  bossName: string | null;
  iconSpellId: number | null;
  difficulty: string | null;
  pullLabel: string | null;
  timeLabel: string | null;
  verdict: RaiderEvidenceVerdict;
  verdictLabel: string;
  tone: RaiderInfographicTone;
  confidenceLabel: string;
  /** "Qué es la habilidad", bajo boss/pull/hora — null si no hay clasificación revisada. */
  mechanicDescription: string | null;
  whatHappened: string;
  evidence: string;
  correction: string | null;
  correctionSource: string;
  /** "Cómo resolver" en el pie — resolución de la mecánica (distinta de
   * `correction`, que en cards defensivas es la instrucción sobre el CD). */
  resolutionSummary: string | null;
  preventionKey: string | null;
  defensives: Array<RaiderEvidenceDefensive & { statusLabel: string }>;
}

export interface RaiderInfographicTimelineGroup {
  key: string;
  bossName: string;
  difficulty: string;
  /** Boss + dificultad abreviada (N/HC/M), para la etiqueta flotante de la
   * banda continua — con 8-10 bosses en una noche, un grupo puede ser un
   * único pull de ~40px y no cabe "Nombre largo · Heroic" sin solaparse con
   * el siguiente grupo. */
  bossLabel: string;
  cells: {
    pullId: string;
    pullNumber: number;
    scoreLabel: string;
    state: RaiderEvidenceProjection['timeline'][number]['state'];
    stateLabel: string;
  }[];
}

export interface RaiderMechanicDefensiveRow {
  spellId: number;
  name: string;
  coveredCount: number;
  freeUnusedCount: number;
  onCooldownCount: number;
  reservedCount: number | null;
  unknownCount: number;
  totalCount: number;
}

export interface RaiderMechanicCard {
  key: string;
  mechanicId: number;
  mechanicName: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  coveredCount: number;
  totalCount: number;
  coverageLabel: string;
  /** "Qué es la habilidad", entre el nombre y el ratio — null si no hay clasificación revisada. */
  description: string | null;
  /** "Cómo resolverla", debajo de description. */
  resolution: string | null;
  /** Una línea al pie: por qué esta mecánica aparece aquí (frecuencia esta noche). Siempre presente. */
  relevanceNote: string;
  timingLabel: string | null;
  occurrenceGroups: {
    pullNumber: number;
    cells: {
      key: string;
      state: 'covered' | 'uncovered' | 'reserved';
      label: string;
    }[];
  }[];
  defensives: RaiderMechanicDefensiveRow[];
}

export interface RaiderInfographicSignal {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: RaiderInfographicTone;
}

export interface RaiderInfographicDeathCard {
  id: string;
  title: string;
  bossName: string | null;
  when: string;
  verdictLabel: string;
  tone: RaiderInfographicTone;
  observation: string;
  evidence: string | null;
  /** Cifra de daño destacada (serif grande), separada de `evidence` para
   * poder tratarla tipográficamente aparte; null cuando no hay daño medido. */
  damageLabel: string | null;
  defensives: Array<RaiderEvidenceDefensive & { statusLabel: string }>;
}

export interface RaiderInfographicPattern {
  key: string;
  mechanicId: number | null;
  mechanicName: string;
  bossNames: string;
  /** Etiqueta de dificultad solo si el patrón no cruza dificultades esta noche. */
  difficultyLabel: string | null;
  instanceLabel: string;
  /** "Qué es" — null cuando el patrón cruza dificultades o no hay clasificación revisada. */
  description: string | null;
  /** "Cómo resolverla" — mismo criterio que description. */
  resolution: string | null;
}

export interface RaiderInfographicEvolutionCard {
  key: NightEvolutionMetric['key'];
  label: string;
  current: string;
  previous: string;
  delta: string;
  evidence: string;
  direction: NightEvolutionMetric['direction'];
}

export interface RaiderInfographicViewModel {
  identity: {
    playerName: string;
    reportCode: string;
    reportTitle: string;
    reportDateLabel: string;
    avatarUrl: string | null;
    className: string | null;
    specName: string | null;
    role: string | null;
    evaluatedPullCount: number;
    evaluatedBossCount: number;
    bossKillCount: number;
  };
  heroMetrics: RaiderInfographicMetric[];
  nightMetrics: RaiderInfographicMetric[];
  coachingCards: RaiderCoachingCard[];
  additionalCoachingCount: number;
  timelineGroups: RaiderInfographicTimelineGroup[];
  positiveSignals: RaiderInfographicSignal[];
  defensiveMetrics: RaiderInfographicMetric[];
  mechanics: RaiderMechanicCard[];
  additionalMechanicCount: number;
  deaths: RaiderInfographicDeathCard[];
  additionalDeathCount: number;
  patterns: RaiderInfographicPattern[];
  additionalPatternCount: number;
  evolution: {
    previousNightLabel: string | null;
    cards: RaiderInfographicEvolutionCard[];
  };
  evidenceNote: string;
  generationLabel: string | null;
  layout: {
    pullDensity: 'normal' | 'compact' | 'dense';
    mechanicColumns: 2 | 3;
    defensiveDensity: 'normal' | 'compact';
    coachingDensity: 'normal' | 'compact';
  };
}

const VERDICT_LABEL: Record<RaiderEvidenceVerdict, string> = {
  success: 'Éxito',
  confirmed_error: 'Error confirmado',
  coaching: 'Coaching',
  correct_hold: 'Reserva correcta',
  context: 'Contexto',
  no_verdict: 'Sin veredicto',
};

const TIMELINE_LABEL: Record<RaiderEvidenceProjection['timeline'][number]['state'], string> = {
  confirmed_error: 'Error confirmado',
  coaching: 'Coaching',
  correct_hold: 'Reserva correcta',
  clean: 'Sin fallo personal ni muerte evaluable',
  no_data: 'Sin veredicto suficiente',
};

const DEFENSIVE_STATUS_LABEL: Record<RaiderEvidenceDefensive['status'], string> = {
  planned: 'Planificado',
  used: 'Usado',
  available_unused: 'Libre sin usar',
  candidate: 'Alternativa factible',
};

function percent(value: number | null, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits).replace('.', ',')}%`;
}

function metricNumber(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace(/\.0$/, '').replace('.', ',');
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('es-ES', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function verdictTone(verdict: RaiderEvidenceVerdict): RaiderInfographicTone {
  if (verdict === 'confirmed_error') return 'danger';
  if (verdict === 'coaching') return 'warning';
  if (verdict === 'success' || verdict === 'correct_hold') return 'positive';
  if (verdict === 'no_verdict') return 'neutral';
  return 'information';
}

function evidenceSource(item: RaiderEvidenceItem): string {
  const labels = new Set(
    item.provenance.map((ref) => {
      switch (ref.source) {
        case 'pull_mechanic_events':
          return 'eventos WCL + manifiesto revisado';
        case 'player_pull_records.death_cause':
          return 'muerte y ventana temporal WCL';
        case 'player_pull_defensive_evaluations':
          return 'replay defensivo versionado';
        case 'player_pull_records.gear':
          return 'equipo observado en el primer pull';
      }
    }),
  );
  return [...labels].join(' · ');
}

function defensiveView(defensive: RaiderEvidenceDefensive) {
  return { ...defensive, statusLabel: DEFENSIVE_STATUS_LABEL[defensive.status] };
}

function coachingCard(item: RaiderEvidenceItem, index: number): RaiderCoachingCard {
  return {
    id: item.id,
    priority: index + 1,
    title: item.title,
    bossId: item.bossId,
    bossName: item.bossName,
    iconSpellId: item.mechanicId ?? item.defensives[0]?.spellId ?? null,
    difficulty: item.difficulty,
    pullLabel: item.pullNumber == null ? null : `Pull ${item.pullNumber}`,
    timeLabel: item.atMs == null ? null : formatDuration(item.atMs),
    verdict: item.verdict,
    verdictLabel: VERDICT_LABEL[item.verdict],
    tone: verdictTone(item.verdict),
    confidenceLabel:
      item.confidence === 'verified'
        ? 'Evidencia verificada'
        : item.confidence === 'inferred'
          ? 'Evidencia parcial'
          : 'Sin veredicto fuerte',
    mechanicDescription: item.mechanicDescription,
    whatHappened: item.observation,
    evidence: item.whyItMatters ?? 'No hay una inferencia adicional publicable.',
    correction: item.action,
    correctionSource: evidenceSource(item),
    resolutionSummary: item.resolutionText,
    preventionKey: item.preventionKey,
    defensives: item.defensives.map(defensiveView),
  };
}

function shortDifficulty(difficulty: string): string {
  const normalized = difficulty.trim().toLowerCase();
  if (normalized.startsWith('mythic')) return 'M';
  if (normalized.startsWith('heroic')) return 'HC';
  if (normalized.startsWith('normal')) return 'N';
  if (normalized.startsWith('lfr')) return 'LFR';
  return difficulty;
}

function groupTimeline(projection: RaiderEvidenceProjection): RaiderInfographicTimelineGroup[] {
  const groups = new Map<string, RaiderInfographicTimelineGroup>();
  for (const cell of projection.timeline) {
    const key = `${cell.bossId}|${cell.difficulty}`;
    const group = groups.get(key) ?? {
      key,
      bossName: cell.bossName,
      difficulty: cell.difficulty,
      bossLabel: `${cell.bossName} · ${shortDifficulty(cell.difficulty)}`,
      cells: [],
    };
    group.cells.push({
      pullId: cell.pullId,
      pullNumber: cell.pullNumber,
      scoreLabel: percent(cell.score * 100),
      state: cell.state,
      stateLabel: TIMELINE_LABEL[cell.state],
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function decisionEpisode(decision: NightDefensiveDecision): string {
  return (
    decision.causalGroupId ??
    `${decision.pullId}|${decision.windowId ?? decision.slotId ?? decision.abilityId ?? 'decision'}|${decision.atMs}`
  );
}

function reservedCounts(v2: NightDefensiveManagementV2 | null): Map<string, number> {
  const episodes = new Set<string>();
  const counts = new Map<string, number>();
  for (const decision of v2?.decisions ?? []) {
    if (decision.state !== 'correct_hold' || decision.abilityId == null) continue;
    for (const spellId of decision.candidateSpellIds ?? []) {
      const episode = `${decisionEpisode(decision)}|${spellId}`;
      if (episodes.has(episode)) continue;
      episodes.add(episode);
      const key = `${decision.bossId}|${decision.difficulty}|${decision.abilityId}|${spellId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function defensiveRow(
  stat: NightMechanicDefensiveStat,
  mechanicKey: string,
  reservations: Map<string, number>,
  hasV2: boolean,
): RaiderMechanicDefensiveRow {
  const reserved = hasV2
    ? Math.min(stat.timesAvailableUnused, reservations.get(`${mechanicKey}|${stat.spellId}`) ?? 0)
    : null;
  const freeUnused = Math.max(0, stat.timesAvailableUnused - (reserved ?? 0));
  return {
    spellId: stat.spellId,
    name: safeSpellName(stat.name),
    coveredCount: stat.timesCovered,
    freeUnusedCount: freeUnused,
    onCooldownCount: stat.timesOnCooldown,
    reservedCount: reserved,
    unknownCount: stat.timesUnknown,
    totalCount:
      stat.timesCovered +
      freeUnused +
      stat.timesOnCooldown +
      (reserved ?? 0) +
      stat.timesUnknown,
  };
}

// §"el literal de 'Buena ejecución' podemos quitarlo porque se entiende bien
// viendo el resto de colores... en su lugar un texto muy breve de por qué
// esa mecánica es relevante (para que aparezca ahí)" (feedback real,
// 2026-09-03): ya no es un veredicto de cobertura (eso lo dicen los colores
// de la tabla) — es la razón cuantitativa de inclusión en esta lista.
function mechanicRelevanceNote(totalCount: number): string {
  return totalCount === 1
    ? 'Ventana defensiva única esta noche.'
    : `Se repitió ${totalCount} veces esta noche.`;
}

function mechanicCards(
  summary: NightPlayerSummary,
  v2: NightDefensiveManagementV2 | null,
): RaiderMechanicCard[] {
  const reservations = reservedCounts(v2);
  const heldOccurrences = new Set(
    (v2?.decisions ?? [])
      .filter((decision) => decision.state === 'correct_hold' && decision.abilityId != null)
      .map((decision) => `${decision.pullId}|${decision.abilityId}|${decision.atMs}`),
  );
  return (summary.defensiveSummary.mechanicPressureBreakdown ?? []).map((mechanic) => {
    const mechanicKey = `${mechanic.bossId}|${mechanic.difficulty}|${mechanic.mechanicId}`;
    const occurrenceGroups = new Map<number, RaiderMechanicCard['occurrenceGroups'][number]>();
    for (const occurrence of mechanic.occurrences) {
      const group = occurrenceGroups.get(occurrence.pullNumber) ?? {
        pullNumber: occurrence.pullNumber,
        cells: [],
      };
      const held = heldOccurrences.has(
        `${occurrence.pullId}|${mechanic.mechanicId}|${occurrence.timeMs}`,
      );
      const state = occurrence.covered ? 'covered' : held ? 'reserved' : 'uncovered';
      group.cells.push({
        key: `${occurrence.pullId}|${occurrence.timeMs}`,
        state,
        label: `Pull ${occurrence.pullNumber} · ${formatDuration(occurrence.timeMs)} · ${
          state === 'covered'
            ? `cubierta${occurrence.coveredBySpellName ? ` con ${safeSpellName(occurrence.coveredBySpellName)}` : ''}`
            : state === 'reserved'
              ? 'reserva correcta'
              : 'sin cobertura'
        }`,
      });
      occurrenceGroups.set(occurrence.pullNumber, group);
    }
    const timingLabel = mechanic.timingPattern
      ? mechanic.timingPattern.kind === 'fixed'
        ? `Suele ocurrir sobre ${formatDuration(mechanic.timingPattern.ms)} · ${mechanic.timingPattern.sampleSize} pulls históricos`
        : `Se repite cada ~${formatDuration(mechanic.timingPattern.ms)} · ${mechanic.timingPattern.sampleSize} repeticiones históricas`
      : null;
    return {
      key: mechanicKey,
      mechanicId: mechanic.mechanicId,
      mechanicName: mechanic.mechanicName,
      bossId: mechanic.bossId,
      bossName: mechanic.bossName,
      difficulty: mechanic.difficulty,
      coveredCount: mechanic.coveredCount,
      totalCount: mechanic.totalCount,
      coverageLabel: percent(
        mechanic.totalCount > 0 ? (mechanic.coveredCount / mechanic.totalCount) * 100 : null,
      ),
      description: mechanic.aiNote,
      resolution: mechanic.resolution,
      relevanceNote: mechanicRelevanceNote(mechanic.totalCount),
      timingLabel,
      occurrenceGroups: [...occurrenceGroups.values()],
      defensives: mechanic.defensives.map((stat) =>
        defensiveRow(stat, mechanicKey, reservations, v2 != null),
      ),
    };
  });
}

// §"no quiero que se genere una nueva página... 2 columnas, 3 columnas, y
// únicamente las que quepan en ese espacio... esas otras mecánicas se
// tienen en cuenta para las métricas y valores pero no se enseñan en la
// infografía porque no caben" (feedback real, 2026-09-03): reemplaza la
// paginación por láminas adicionales — nunca crece verticalmente, solo
// cambia de 2 a 3 columnas (misma altura de 3 filas) cuando hay más de 6.
const MECHANIC_TWO_COLUMN_CAPACITY = 6;
const MECHANIC_THREE_COLUMN_CAPACITY = 9;

function selectMechanics(rows: RaiderMechanicCard[]): {
  visible: RaiderMechanicCard[];
  additionalCount: number;
  columns: 2 | 3;
} {
  if (rows.length <= MECHANIC_TWO_COLUMN_CAPACITY) {
    return { visible: rows, additionalCount: 0, columns: 2 };
  }
  return {
    visible: rows.slice(0, MECHANIC_THREE_COLUMN_CAPACITY),
    additionalCount: Math.max(0, rows.length - MECHANIC_THREE_COLUMN_CAPACITY),
    columns: 3,
  };
}

function positiveSignals(
  summary: NightPlayerSummary,
  v2: NightDefensiveManagementV2 | null,
): RaiderInfographicSignal[] {
  const rows: RaiderInfographicSignal[] = [];
  if (summary.execution.avoidableEligible > 0) {
    rows.push({
      key: 'avoidance',
      label: 'Esquivas verificadas',
      value: `${summary.execution.avoidableSucceeded}/${summary.execution.avoidableEligible}`,
      detail: `${percent(summary.execution.avoidableSuccessRate)} de oportunidades mientras seguía vivo.`,
      tone: 'positive',
    });
  }
  if (summary.interrupts.length > 0) {
    rows.push({
      key: 'interrupts',
      label: 'Interrupciones atribuidas',
      value: String(summary.interrupts.length),
      detail: summary.interrupts
        .slice(0, 4)
        .map((row) => `${row.mechanicName} · Pull ${row.pullNumber}`)
        .join(' · '),
      tone: 'positive',
    });
  }
  const goodDefensiveDecisions = (v2?.decisions ?? []).filter(
    (decision) => decision.state === 'correct_hold' || decision.state === 'safe_extra_use',
  );
  if (goodDefensiveDecisions.length > 0) {
    rows.push({
      key: 'defensive',
      label: 'Decisiones defensivas correctas',
      value: String(goodDefensiveDecisions.length),
      detail: `${v2!.correctHoldCount} reservas correctas · ${goodDefensiveDecisions.filter((row) => row.state === 'safe_extra_use').length} usos extra seguros.`,
      tone: 'positive',
    });
  }
  if (summary.unassignedMechanicCredits.length > 0) {
    const unique = new Map<string, string>();
    for (const credit of summary.unassignedMechanicCredits) {
      const key = `${credit.mechanicName}|${credit.bossName}`;
      if (!unique.has(key)) unique.set(key, `${credit.mechanicName} (${credit.bossName})`);
    }
    rows.push({
      key: 'voluntary',
      label: 'Mecánicas voluntarias resueltas',
      value: String(summary.unassignedMechanicCredits.length),
      detail: [...unique.values()].join(' · '),
      tone: 'positive',
    });
  }
  return rows;
}

// §"0/0 slots required cubiertos... por qué el score no es 100% o sin dato"
// (feedback real, 2026-09-03): managementScore sale de
// computeDefensiveManagementScore, que pondera death_with_viable_cd/
// plan_broken/extras además de los slots required — no solo required. La
// leyenda anterior citaba únicamente required (0/0 esa noche) y parecía
// contradecir un score que en realidad venía sobre todo de 2 muertes con CD
// viable. Ahora la leyenda sigue al dato que de verdad domina el score.
function defensiveScoreDetail(v2: NightDefensiveManagementV2 | null): string {
  // §"esto no es información útil para un raider" (feedback real,
  // 2026-09-03): la explicación anterior hablaba del propio sistema
  // (v2/legacy) en vez de lo que el número representa para el jugador.
  if (!v2) return '% de ventanas de presión con algún defensivo usado.';
  if (v2.planRequiredCount > 0) {
    return `${v2.requiredCoverageSuccessCount}/${v2.planRequiredCount} slots required cubiertos · ${v2.correctHoldCount} reservas correctas`;
  }
  if (v2.deathViableCdCount > 0) {
    return `${v2.deathViableCdCount} muerte${v2.deathViableCdCount === 1 ? '' : 's'} con CD viable sin usar · ${v2.correctHoldCount} reservas correctas`;
  }
  if (v2.brokenReservationCount > 0) {
    return `${v2.brokenReservationCount} reserva${v2.brokenReservationCount === 1 ? '' : 's'} rota${v2.brokenReservationCount === 1 ? '' : 's'} · ${v2.correctHoldCount} reservas correctas`;
  }
  return `${v2.correctHoldCount} reservas correctas · sin slots required esta noche`;
}

function evolutionValue(value: number, unit: NightEvolutionMetric['unit']): string {
  return unit === 'percent' ? percent(value) : metricNumber(value);
}

function evolutionDelta(metric: NightEvolutionMetric): string {
  const sign = metric.delta > 0 ? '+' : metric.delta < 0 ? '−' : '';
  return `${sign}${evolutionValue(Math.abs(metric.delta), metric.unit)}`;
}

export function buildRaiderInfographicViewModel(
  summary: NightPlayerSummary,
  projection: RaiderEvidenceProjection,
  v2: NightDefensiveManagementV2 | null,
): RaiderInfographicViewModel {
  const evaluatedPulls = summary.pulls.filter((pull) => pull.pullScore != null);
  const evaluatedBosses = new Set(
    evaluatedPulls.map((pull) => `${pull.bossId}|${pull.difficulty}`),
  );
  const bossKills = evaluatedPulls.filter((pull) => pull.kill).length;
  const mechanics = mechanicCards(summary, v2);
  const mechanicSelection = selectMechanics(mechanics);
  // Coverage/KPIs siempre sobre TODAS las mecánicas, aunque algunas no quepan
  // en el grid visible — "se tienen en cuenta para las métricas... pero no
  // se enseñan en la infografía porque no caben" (feedback real, 2026-09-03).
  const coverage = mechanics.reduce(
    (totals, mechanic) => ({
      covered: totals.covered + mechanic.coveredCount,
      total: totals.total + mechanic.totalCount,
    }),
    { covered: 0, total: 0 },
  );
  const maxDefensiveRows = Math.max(0, ...mechanics.map((mechanic) => mechanic.defensives.length));
  const className = summary.gearSnapshot?.class ?? summary.roster?.class ?? null;
  const executionScore = summary.nightScore == null ? null : summary.nightScore * 100;
  const defensiveScore = v2?.managementScore ?? summary.nightReliability?.breakdown.defensiva ?? null;
  // §Hallazgo 4 (2026-09-03): antes este contador leía v2.deathViableCdCount
  // (o el agregado legacy) mientras las cards de muerte de abajo se
  // construyen mezclando episodios v2 y legacy pull a pull — un episodio de
  // muerte concreto puede no tener decisión v2 aunque v2 exista para la
  // noche, y ese contador global no lo veía. El resumen y las cards podían
  // contradecirse en la misma lámina ("0 muertes con respuesta viable"
  // arriba, dos cards de muerte con CD libre debajo). Ahora el contador
  // cuenta exactamente las mismas cards que se van a pintar.
  const deathItems = projection.items.filter(
    (item) => item.kind === 'death' || item.reasonCode.startsWith('DEATH_'),
  );
  const deaths = deathItems.map(
    (item): RaiderInfographicDeathCard => ({
      id: item.id,
      title: item.title,
      bossName: item.bossName,
      when: [
        item.pullNumber == null ? null : `Pull ${item.pullNumber}`,
        item.atMs == null ? null : formatDuration(item.atMs),
      ]
        .filter(Boolean)
        .join(' · '),
      verdictLabel: VERDICT_LABEL[item.verdict],
      tone: verdictTone(item.verdict),
      observation: item.observation,
      evidence: item.whyItMatters,
      damageLabel: item.damageTotal > 0 ? compactNumber(item.damageTotal) : null,
      defensives: item.defensives.map(defensiveView),
    }),
  );
  const deathResponseCount = deathItems.filter(
    (item) => item.verdict === 'coaching' && item.defensives.length > 0,
  ).length;
  const deathResponseDetail =
    'defensivo disponible identificado en la card de muerte correspondiente; no prueba que hubiera evitado la muerte';

  return {
    identity: {
      playerName: summary.playerName,
      reportCode: summary.reportCode,
      reportTitle: summary.reportTitle,
      reportDateLabel: summary.reportDate
        ? new Intl.DateTimeFormat('es-ES', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }).format(new Date(summary.reportDate))
        : summary.reportTitle,
      avatarUrl: summary.roster?.avatarUrl ?? null,
      className: className ? classDisplayName(className) : null,
      specName: summary.gearSnapshot?.spec ?? null,
      role: summary.roster?.role ?? null,
      evaluatedPullCount: evaluatedPulls.length,
      evaluatedBossCount: evaluatedBosses.size,
      bossKillCount: bossKills,
    },
    heroMetrics: [
      {
        // §"'6/13 pulls sin fallo personal ni muerte evaluable' porque ya
        // está en la card de abajo" (feedback real, 2026-09-03): ese mismo
        // par ya es el KPI "Pulls limpios" del stat-strip; aquí describe qué
        // pesa el % en vez de repetir la fracción.
        key: 'execution',
        label: 'Ejecución de la noche',
        value: percent(executionScore),
        detail: 'Combina fallos personales, muertes evaluables y consistencia por pull.',
        tone:
          executionScore == null
            ? 'neutral'
            : executionScore < 50
              ? 'danger'
              : executionScore < 75
                ? 'warning'
                : 'positive',
      },
      {
        // §"No debería existir el literal de defensivos V2 en la
        // infografía porque todo tiene que adaptarse al nuevo" (feedback
        // real, 2026-09-03): una sola etiqueta para el jugador,
        // independientemente de qué generación interna resolvió el número
        // — mismo criterio que ya siguen sus dos hermanas ('Ejecución de la
        // noche', 'Calidad de evidencia'), que tampoco revelan su fuente.
        key: 'defensive',
        label: 'Gestión defensiva',
        value: percent(defensiveScore),
        detail: defensiveScoreDetail(v2),
        tone:
          defensiveScore == null
            ? 'neutral'
            : defensiveScore < 50
              ? 'danger'
              : defensiveScore < 75
                ? 'warning'
                : 'positive',
      },
      {
        key: 'evidence',
        label: 'Calidad de evidencia',
        value:
          projection.quality === 'high'
            ? 'ALTA'
            : projection.quality === 'partial'
              ? 'PARCIAL'
              : 'LIMITADA',
        // §"PARCIAL / CALIDAD DE EVIDENCIA / Algunas cards se basan en menos
        // datos... no es útil" (feedback real, 2026-09-03): esa frase ya se
        // había reescrito una vez el mismo día citando esta misma queja y
        // seguía sin aportar nada que las propias cards no dijeran ya cada
        // una con su confidenceLabel. Se retira aquí; la nota fina de
        // evidencia sigue viva en el pie de página (view.evidenceNote) para
        // quien la busque, y este hueco pasa a describir la métrica en sí
        // — mismo patrón que sus dos hermanas ('Ejecución de la noche',
        // 'Gestión defensiva V2'), que explican qué miden, no cuánto fiarse.
        detail: 'Cuánta de la noche está verificada u observada directamente, no solo inferida.',
        tone:
          projection.quality === 'high'
            ? 'positive'
            : projection.quality === 'partial'
              ? 'warning'
              : 'neutral',
      },
    ],
    nightMetrics: [
      {
        key: 'clean-pulls',
        label: 'Pulls limpios',
        value: `${summary.execution.cleanPulls}/${summary.execution.evaluatedPulls}`,
        detail: percent(summary.execution.cleanPullRate),
        tone:
          summary.execution.cleanPullRate == null
            ? 'neutral'
            : summary.execution.cleanPullRate < 50
              ? 'danger'
              : summary.execution.cleanPullRate < 75
                ? 'warning'
                : 'positive',
      },
      {
        key: 'personal-errors',
        label: 'Fallos personales',
        value: String(summary.execution.actionableIncidents),
        detail: `${metricNumber(summary.execution.actionableIncidentRatePer10)} por 10 pulls`,
        tone: summary.execution.actionableIncidents > 0 ? 'danger' : 'positive',
      },
      {
        key: 'deaths',
        label: 'Muertes evaluables',
        value: String(summary.totalDeaths),
        detail: `${metricNumber(summary.execution.deathRatePer10)} por 10 pulls`,
        tone: summary.totalDeaths > 0 ? 'danger' : 'positive',
      },
      {
        key: 'interrupts',
        label: 'Kicks atribuidos',
        value: String(summary.interrupts.length),
        detail: 'solo casts atribuidos al jugador',
        tone: summary.interrupts.length > 0 ? 'positive' : 'neutral',
      },
      {
        // §Spec visual sección 6: "Pulls evaluados" no debe ocupar un KPI
        // porque ya aparece junto a la identidad del jugador (hero, arriba).
        // En su lugar vuelve "Ventanas de presión", que aporta una
        // dimensión distinta (misma fuente que el strip de la página
        // derecha, `coverage`, para no introducir un segundo cálculo).
        key: 'pressure-windows',
        label: 'Ventanas de presión',
        value: `${coverage.covered}/${coverage.total}`,
        detail: percent(coverage.total > 0 ? (coverage.covered / coverage.total) * 100 : null) + ' cubiertas',
        tone: coverage.total === 0 ? 'neutral' : coverage.covered === coverage.total ? 'positive' : 'warning',
      },
      {
        key: 'bosses',
        label: 'Bosses evaluados',
        value: String(evaluatedBosses.size),
        detail: `${bossKills} kills de boss`,
        tone: 'information',
      },
    ],
    coachingCards: projection.coaching.map(coachingCard),
    additionalCoachingCount: projection.additionalCoachingCount,
    timelineGroups: groupTimeline(projection),
    positiveSignals: positiveSignals(summary, v2),
    defensiveMetrics: [
      {
        key: 'casts',
        label: 'Casts defensivos',
        value: String(summary.defensiveSummary.totalCasts),
        detail: `en ${summary.defensiveSummary.pullsWithCasts}/${evaluatedPulls.length} pulls`,
        tone: 'information',
      },
      {
        key: 'coverage',
        label: 'Ventanas cubiertas',
        value: `${coverage.covered}/${coverage.total}`,
        detail: percent(coverage.total > 0 ? (coverage.covered / coverage.total) * 100 : null),
        tone:
          coverage.total === 0
            ? 'neutral'
            : coverage.covered === coverage.total
              ? 'positive'
              : 'warning',
      },
      {
        key: 'uncovered',
        label: 'Sin cobertura',
        value: String(Math.max(0, coverage.total - coverage.covered)),
        detail: 'ocurrencias evaluables, no culpabilidad automática',
        tone: coverage.total - coverage.covered > 0 ? 'warning' : 'positive',
      },
      {
        key: 'holds',
        label: 'Reservas correctas',
        value: v2 ? String(v2.correctHoldCount) : '—',
        detail: v2 ? 'holds confirmados por el replay' : 'sin datos suficientes esta noche',
        tone: v2?.correctHoldCount ? 'information' : 'neutral',
      },
      {
        key: 'death-response',
        label: 'Muertes con respuesta disponible',
        value: String(deathResponseCount),
        detail: deathResponseDetail,
        tone: deathResponseCount > 0 ? 'danger' : 'neutral',
      },
      // §Spec visual sección 12: 5 columnas, no 6 — "Kills del boss" no
      // pertenece a este strip (ya está en la identidad de página izquierda
      // y en las propias cards) y comprimía las otras cinco.
    ],
    mechanics: mechanicSelection.visible,
    additionalMechanicCount: mechanicSelection.additionalCount,
    deaths,
    additionalDeathCount: Math.max(0, deaths.length - 3),
    patterns: summary.repeatedPatterns
      .filter((pattern) => pattern.instanceCount >= 2)
      .map((pattern) => ({
        key: `${pattern.mechanicId ?? pattern.mechanicName}|${pattern.bossNames.join('|')}`,
        mechanicId: pattern.mechanicId,
        mechanicName: pattern.mechanicName,
        bossNames: pattern.bossNames.join(' · '),
        difficultyLabel: pattern.difficulty,
        instanceLabel: `${pattern.instanceCount} incidencias en ${pattern.distinctBossCount} boss${pattern.distinctBossCount === 1 ? '' : 'es'}`,
        description: pattern.aiNote,
        resolution: pattern.resolution,
      })),
    additionalPatternCount: Math.max(
      0,
      summary.repeatedPatterns.filter((pattern) => pattern.instanceCount >= 2).length - 3,
    ),
    evolution: {
      previousNightLabel: summary.evolution
        ? `${summary.evolution.previousReportTitle} · ${new Intl.DateTimeFormat('es-ES', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }).format(new Date(summary.evolution.previousReportDate))}`
        : null,
      cards: (summary.evolution?.metrics ?? []).map((metric) => ({
        key: metric.key,
        label: metric.label,
        current: evolutionValue(metric.current, metric.unit),
        previous: evolutionValue(metric.previous, metric.unit),
        delta: evolutionDelta(metric),
        evidence: metric.evidence,
        direction: metric.direction,
      })),
    },
    evidenceNote: projection.qualityReason,
    generationLabel: projection.defensiveGeneration
      ? `${projection.defensiveGeneration.evaluatorVersion} · ${projection.defensiveGeneration.resolverVersion} · ${projection.defensiveGeneration.solverVersion}`
      : null,
    layout: {
      pullDensity:
        evaluatedPulls.length > 22 ? 'dense' : evaluatedPulls.length > 12 ? 'compact' : 'normal',
      mechanicColumns: mechanicSelection.columns,
      defensiveDensity: maxDefensiveRows > 3 ? 'compact' : 'normal',
      // §"solo aparecen 3 cards y creo que caben 4 (o 5)" (feedback real,
      // 2026-09-03): el tope editorial subió de 3 a 4 (raider-evidence-
      // projection.ts); la página es de altura fija con recorte, así que la
      // 4ª card usa una variante compacta en vez de asumir que el hueco
      // libre siempre alcanza a tamaño normal.
      coachingDensity: projection.coaching.length > 3 ? 'compact' : 'normal',
    },
  };
}
