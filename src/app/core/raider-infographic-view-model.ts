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
import { classDisplayName, formatDuration } from '../shared/format.util';

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
  whatHappened: string;
  evidence: string;
  correction: string | null;
  correctionSource: string;
  observedImpact: string;
  whyItMatters: string | null;
  defensives: Array<RaiderEvidenceDefensive & { statusLabel: string }>;
}

export interface RaiderInfographicTimelineGroup {
  key: string;
  bossName: string;
  difficulty: string;
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
  defensives: Array<RaiderEvidenceDefensive & { statusLabel: string }>;
}

export interface RaiderInfographicPattern {
  key: string;
  mechanicId: number | null;
  mechanicName: string;
  bossNames: string;
  instanceLabel: string;
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
  mechanicPages: RaiderMechanicCard[][];
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
    mechanicDensity: 'normal' | 'compact' | 'dense';
    defensiveDensity: 'normal' | 'compact';
    spreadCount: number;
  };
}

const PRIMARY_MECHANIC_CAPACITY = 6;
const CONTINUATION_MECHANIC_CAPACITY = 8;

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

function observedImpact(item: RaiderEvidenceItem): string {
  if (item.kind === 'death' || item.reasonCode.startsWith('DEATH_')) return 'Muerte registrada';
  if (item.damageTotal > 0) return `${compactNumber(item.damageTotal)} de daño observado`;
  if (item.occurrences.length > 1) return `${item.occurrences.length} incidencias observadas`;
  return 'Incidencia observada';
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
    whatHappened: item.observation,
    evidence: item.whyItMatters ?? 'No hay una inferencia adicional publicable.',
    correction: item.action,
    correctionSource: evidenceSource(item),
    observedImpact: observedImpact(item),
    whyItMatters: item.whyItMatters,
    defensives: item.defensives.map(defensiveView),
  };
}

function groupTimeline(projection: RaiderEvidenceProjection): RaiderInfographicTimelineGroup[] {
  const groups = new Map<string, RaiderInfographicTimelineGroup>();
  for (const cell of projection.timeline) {
    const key = `${cell.bossId}|${cell.difficulty}`;
    const group = groups.get(key) ?? {
      key,
      bossName: cell.bossName,
      difficulty: cell.difficulty,
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
    name: stat.name,
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
            ? `cubierta${occurrence.coveredBySpellName ? ` con ${occurrence.coveredBySpellName}` : ''}`
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
      timingLabel,
      occurrenceGroups: [...occurrenceGroups.values()],
      defensives: mechanic.defensives.map((stat) =>
        defensiveRow(stat, mechanicKey, reservations, v2 != null),
      ),
    };
  });
}

function chunk<T>(rows: T[], size: number): T[][] {
  if (!rows.length) return [[]];
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

function mechanicSpreads(rows: RaiderMechanicCard[]): RaiderMechanicCard[][] {
  if (!rows.length) return [[]];
  return [
    rows.slice(0, PRIMARY_MECHANIC_CAPACITY),
    ...chunk(rows.slice(PRIMARY_MECHANIC_CAPACITY), CONTINUATION_MECHANIC_CAPACITY).filter(
      (page) => page.length > 0,
    ),
  ];
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
  const mechanicPages = mechanicSpreads(mechanics);
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
  const deathResponseCount = v2?.deathViableCdCount ?? summary.defensiveSummary.deathsWithDefensiveAvailable;
  const deathResponseDetail = v2
    ? 'con respuesta viable durante la secuencia letal'
    : 'con un CD libre al final; no prueba que fuera viable antes';
  const deaths = projection.items
    .filter((item) => item.kind === 'death' || item.reasonCode.startsWith('DEATH_'))
    .map((item): RaiderInfographicDeathCard => ({
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
      defensives: item.defensives.map(defensiveView),
    }));

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
        key: 'execution',
        label: 'Ejecución de la noche',
        value: percent(executionScore),
        detail: `${summary.execution.cleanPulls}/${summary.execution.evaluatedPulls} pulls sin fallo personal ni muerte evaluable`,
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
        key: 'defensive',
        label: v2 ? 'Gestión defensiva V2' : 'Cobertura defensiva legacy',
        value: percent(defensiveScore),
        detail: v2
          ? `${v2.requiredCoverageSuccessCount}/${v2.planRequiredCount} slots required cubiertos · ${v2.correctHoldCount} reservas correctas`
          : 'La métrica legacy no se presenta como score V2.',
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
        detail: projection.qualityReason,
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
        tone: 'positive',
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
        key: 'bosses',
        label: 'Bosses evaluados',
        value: String(evaluatedBosses.size),
        detail: `${bossKills} kills de boss`,
        tone: 'information',
      },
      {
        key: 'pulls',
        label: 'Pulls evaluados',
        value: String(evaluatedPulls.length),
        detail: 'mismo universo en toda la lámina',
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
        detail: v2 ? 'holds confirmados por el replay' : 'requiere evaluación V2 homogénea',
        tone: v2?.correctHoldCount ? 'information' : 'neutral',
      },
      {
        key: 'death-response',
        label: v2 ? 'Muertes con respuesta viable' : 'CD libre al morir · legacy',
        value: String(deathResponseCount),
        detail: deathResponseDetail,
        tone: deathResponseCount > 0 ? 'danger' : 'neutral',
      },
      {
        key: 'kills',
        label: 'Kills de boss',
        value: String(bossKills),
        detail: `${evaluatedBosses.size} bosses evaluados`,
        tone: bossKills > 0 ? 'positive' : 'neutral',
      },
    ],
    mechanicPages,
    deaths,
    additionalDeathCount: Math.max(0, deaths.length - 3),
    patterns: summary.repeatedPatterns
      .filter((pattern) => pattern.instanceCount >= 2)
      .map((pattern) => ({
        key: `${pattern.mechanicId ?? pattern.mechanicName}|${pattern.bossNames.join('|')}`,
        mechanicId: pattern.mechanicId,
        mechanicName: pattern.mechanicName,
        bossNames: pattern.bossNames.join(' · '),
        instanceLabel: `${pattern.instanceCount} incidencias en ${pattern.distinctBossCount} boss${pattern.distinctBossCount === 1 ? '' : 'es'}`,
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
      mechanicDensity: mechanics.length > 6 ? 'dense' : mechanics.length > 4 ? 'compact' : 'normal',
      defensiveDensity: maxDefensiveRows > 3 ? 'compact' : 'normal',
      spreadCount: mechanicPages.length,
    },
  };
}
