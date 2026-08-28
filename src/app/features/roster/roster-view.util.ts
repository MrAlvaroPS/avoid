import type { RepeatOffenderRow } from '../../core/offenders.service';
import type { PlayerReliability } from '../../core/reliability.service';
import { mechanicCategoryMeta } from '../../shared/format.util';

export type RosterStatus = 'action' | 'review' | 'healthy' | 'no-data';
export type RosterFilter = 'all' | 'attention' | 'no-data' | 'trial';

export interface RosterSignal {
  kind: 'preparation' | 'defensive' | 'mechanic' | 'trend';
  severity: 'action' | 'review';
  title: string;
  detail: string;
  lastOccurredAt: string | null;
  pattern?: RepeatOffenderRow;
}

export interface RosterPlayerView {
  player: PlayerReliability;
  status: RosterStatus;
  statusLabel: string;
  summaryTitle: string;
  summaryDetail: string;
  signals: RosterSignal[];
  patterns: RepeatOffenderRow[];
  evidenceLabel: string;
  evidenceLevel: 'none' | 'low' | 'medium' | 'high';
}

export interface RosterRoleGroup {
  key: 'tanks' | 'healers' | 'dps' | 'unknown';
  label: string;
  description: string;
  players: RosterPlayerView[];
}

export interface RosterPatternSummary {
  category: RepeatOffenderRow['category'];
  label: string;
  players: number;
  instances: number;
  bosses: number;
}

const STATUS_LABEL: Record<RosterStatus, string> = {
  action: 'Antes de raid',
  review: 'Revisar',
  healthy: 'Correcto',
  'no-data': 'Sin datos',
};

const STATUS_ORDER: Record<RosterStatus, number> = {
  action: 0,
  review: 1,
  healthy: 2,
  'no-data': 3,
};

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function preparationSignal(player: PlayerReliability): RosterSignal | null {
  const missingEnchants =
    player.latestEnchantableSlotCount == null || player.latestEnchantedSlotCount == null
      ? 0
      : Math.max(0, player.latestEnchantableSlotCount - player.latestEnchantedSlotCount);
  const missingGemSlots =
    player.latestGemmableSlotCount == null || player.latestGemmedSlotCount == null
      ? 0
      : Math.max(0, player.latestGemmableSlotCount - player.latestGemmedSlotCount);
  if (!missingEnchants && !missingGemSlots) return null;

  const pending = [
    missingEnchants
      ? player.latestMissingEnchantSlots?.length
        ? `enchants: ${player.latestMissingEnchantSlots.join(', ')}`
        : plural(missingEnchants, 'enchant')
      : null,
    missingGemSlots
      ? player.latestMissingGemSlots?.length
        ? `gemas: ${player.latestMissingGemSlots.join(', ')}`
        : plural(missingGemSlots, 'slot de gema', 'slots de gema')
      : null,
  ].filter((value): value is string => value != null);
  return {
    kind: 'preparation',
    severity: 'action',
    title: 'Preparación incompleta',
    detail: `Faltan ${pending.join(' · ')} al inicio de la última noche observada.`,
    lastOccurredAt: player.latestPreparationObservedAt ?? player.lastObservedAt,
  };
}

function defensiveSignal(player: PlayerReliability): RosterSignal | null {
  const score = player.breakdown.defensiva;
  if (score == null || score >= 60 || player.defensiveOpportunityCount < 3) return null;
  return {
    kind: 'defensive',
    severity: 'review',
    title: 'Uso defensivo por revisar',
    detail: [
      `Puntuación ${Math.round(score)}/100`,
      `${player.defensiveUseCount}/${player.defensiveOpportunityCount} pulls con uso registrado`,
      player.defensiveDeathOpportunityCount
        ? `${player.defensiveDeathUseCount}/${player.defensiveDeathOpportunityCount} muertes con respuesta defensiva`
        : null,
    ]
      .filter((part): part is string => part != null)
      .join(' · '),
    lastOccurredAt: player.lastObservedAt,
  };
}

function mechanicSignals(patterns: RepeatOffenderRow[]): RosterSignal[] {
  return patterns.map((pattern) => {
    const mechanics = pattern.mechanics ?? [];
    const primary = mechanics[0] ?? null;
    const title = primary
      ? mechanics.length === 1
        ? `Patrón repetido: ${primary.mechanicNameEs ?? primary.mechanicName}`
        : `Patrón repetido: ${primary.mechanicNameEs ?? primary.mechanicName} y ${mechanics.length - 1} más`
      : `Patrón repetido: ${mechanicCategoryMeta(pattern.category)?.label ?? pattern.category}`;
    const locations = mechanics
      .slice(0, 3)
      .map(
        (mechanic) => `${mechanic.bossName} (${mechanic.mechanicNameEs ?? mechanic.mechanicName})`,
      );
    return {
      kind: 'mechanic',
      severity: 'review',
      title,
      detail: locations.length
        ? `${plural(pattern.instanceCount, 'impacto')} confirmados: ${locations.join(' · ')}.`
        : `${plural(pattern.instanceCount, 'impacto')} en ${plural(pattern.distinctBossCount, 'boss', 'bosses')} distintos.`,
      lastOccurredAt: pattern.lastOccurredAt,
      pattern,
    };
  });
}

export function buildRosterPlayerView(
  player: PlayerReliability,
  patterns: RepeatOffenderRow[],
): RosterPlayerView {
  if (!player.sampleSize) {
    return {
      player,
      patterns: [],
      signals: [],
      status: 'no-data',
      statusLabel: STATUS_LABEL['no-data'],
      summaryTitle: 'Sin evidencia reciente',
      summaryDetail:
        'Pertenece al roster oficial, pero no aparece en pulls evaluables de los últimos 60 días.',
      evidenceLabel: 'Sin muestra',
      evidenceLevel: 'none',
    };
  }

  const signals: RosterSignal[] = [];
  const preparation = preparationSignal(player);
  if (preparation) signals.push(preparation);
  signals.push(...mechanicSignals(patterns));
  const defensive = defensiveSignal(player);
  if (defensive) signals.push(defensive);
  if (player.trend === 'down' && player.sampleNightCount >= 2) {
    signals.push({
      kind: 'trend',
      severity: 'review',
      title: 'Tendencia a la baja',
      detail: 'La ejecución reciente está por debajo del tramo anterior con datos.',
      lastOccurredAt: player.lastObservedAt,
    });
  }

  signals.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'action' ? -1 : 1));
  const status: RosterStatus = signals.some((signal) => signal.severity === 'action')
    ? 'action'
    : signals.length
      ? 'review'
      : 'healthy';
  const primary = signals[0] ?? null;
  const evidenceLevel =
    player.sampleNightCount >= 4 && player.sampleSize >= 20
      ? 'high'
      : player.sampleNightCount >= 2 && player.sampleSize >= 10
        ? 'medium'
        : 'low';

  return {
    player,
    patterns,
    signals,
    status,
    statusLabel: STATUS_LABEL[status],
    summaryTitle: primary?.title ?? 'Sin señales accionables recientes',
    summaryDetail:
      primary?.detail ??
      'No hay preparación pendiente ni patrones individuales confirmados en la muestra disponible.',
    evidenceLabel: `${plural(player.sampleNightCount, 'noche')} · ${plural(player.sampleSize, 'pull')}`,
    evidenceLevel,
  };
}

export function sortRosterViews(views: RosterPlayerView[]): RosterPlayerView[] {
  return [...views].sort((a, b) => {
    const statusDelta = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDelta) return statusDelta;
    return a.player.playerName.localeCompare(b.player.playerName, 'es');
  });
}

export function groupRosterViews(views: RosterPlayerView[]): RosterRoleGroup[] {
  const groups: RosterRoleGroup[] = [
    { key: 'tanks', label: 'Tanks', description: 'Primera línea y control del boss', players: [] },
    {
      key: 'healers',
      label: 'Healers',
      description: 'Sostenimiento y respuesta de raid',
      players: [],
    },
    { key: 'dps', label: 'DPS', description: 'Cuerpo a cuerpo y distancia', players: [] },
    {
      key: 'unknown',
      label: 'Sin rol',
      description: 'Pendientes de cruzar con wowaudit',
      players: [],
    },
  ];
  for (const view of sortRosterViews(views)) {
    const role = view.player.role;
    const key =
      role === 'Tank'
        ? 'tanks'
        : role === 'Heal'
          ? 'healers'
          : role === 'Melee' || role === 'Ranged'
            ? 'dps'
            : 'unknown';
    groups.find((group) => group.key === key)!.players.push(view);
  }
  return groups.filter((group) => group.players.length > 0);
}

export function filterRosterViews(
  views: RosterPlayerView[],
  filter: RosterFilter,
  search: string,
): RosterPlayerView[] {
  const query = search.trim().toLocaleLowerCase('es');
  return views.filter((view) => {
    if (query && !view.player.playerName.toLocaleLowerCase('es').includes(query)) return false;
    if (filter === 'attention' && view.status !== 'action' && view.status !== 'review')
      return false;
    if (filter === 'no-data' && view.status !== 'no-data') return false;
    if (filter === 'trial' && view.player.rank !== 'Trial') return false;
    return true;
  });
}

export function summarizeRosterPatterns(patterns: RepeatOffenderRow[]): RosterPatternSummary[] {
  const byCategory = new Map<RepeatOffenderRow['category'], RosterPatternSummary>();
  for (const pattern of patterns) {
    const current = byCategory.get(pattern.category) ?? {
      category: pattern.category,
      label: mechanicCategoryMeta(pattern.category)?.label ?? pattern.category,
      players: 0,
      instances: 0,
      bosses: 0,
    };
    current.players += 1;
    current.instances += pattern.instanceCount;
    current.bosses = Math.max(current.bosses, pattern.distinctBossCount);
    byCategory.set(pattern.category, current);
  }
  return [...byCategory.values()].sort(
    (a, b) => b.players - a.players || b.instances - a.instances,
  );
}

export function sortAttentionViews(views: RosterPlayerView[]): RosterPlayerView[] {
  return [...views]
    .filter((view) => view.status === 'action' || view.status === 'review')
    .sort((a, b) => {
      const statusDelta = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (statusDelta) return statusDelta;
      const signalDelta = b.signals.length - a.signals.length;
      if (signalDelta) return signalDelta;
      return a.player.playerName.localeCompare(b.player.playerName, 'es');
    });
}
