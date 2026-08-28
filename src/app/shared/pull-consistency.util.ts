import type { MechanicCategory } from './models/domain';

export const PERSONAL_RESPONSIBILITY_CATEGORIES = new Set<MechanicCategory>([
  'avoidable-ground',
  'spread',
  'soak',
  'personal-target',
]);

export interface IncidentBreakdownItem {
  label: string;
  count: number;
}

/**
 * Un "incidente" siempre es una instancia temporal, nunca una fila de
 * jugador. De esta forma el total de la tarjeta y su desglose comparten
 * unidad incluso cuando una misma mecánica alcanza a varias personas.
 */
export interface ExecutionIncidentSummary {
  totalEvents: number;
  personalEvents: number;
  groupEvents: number;
  unclassifiedEvents: number;
  uncoveredDeathEvents: number;
  personalBreakdown: IncidentBreakdownItem[];
  groupBreakdown: IncidentBreakdownItem[];
  unclassifiedBreakdown: IncidentBreakdownItem[];
}

type IncidentEvent = {
  mechanic_name: string;
  outcome: string;
  category: MechanicCategory | null;
};

function breakdown(events: IncidentEvent[]): IncidentBreakdownItem[] {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.mechanic_name, (counts.get(event.mechanic_name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function summarizeExecutionIncidents(
  events: IncidentEvent[],
  uncoveredDeathEvents = 0,
): ExecutionIncidentSummary {
  const failed = events.filter((event) => event.outcome !== 'clean');
  const personal = failed.filter(
    (event) => event.category != null && PERSONAL_RESPONSIBILITY_CATEGORIES.has(event.category),
  );
  const group = failed.filter(
    (event) => event.category != null && !PERSONAL_RESPONSIBILITY_CATEGORIES.has(event.category),
  );
  const unclassified = failed.filter((event) => event.category == null);

  return {
    totalEvents: failed.length + uncoveredDeathEvents,
    personalEvents: personal.length,
    groupEvents: group.length,
    unclassifiedEvents: unclassified.length,
    uncoveredDeathEvents,
    personalBreakdown: breakdown(personal),
    groupBreakdown: breakdown(group),
    unclassifiedBreakdown: breakdown(unclassified),
  };
}

export interface ValidAttemptLike {
  id: string;
  ninja_pull_excluded: boolean;
}

/** Ordinal 1..N entre intentos válidos del grupo visible; null = pull excluido. */
export function validAttemptOrdinal(pulls: ValidAttemptLike[], pullId: string): number | null {
  let ordinal = 0;
  for (const pull of pulls) {
    if (pull.ninja_pull_excluded) {
      if (pull.id === pullId) return null;
      continue;
    }
    ordinal++;
    if (pull.id === pullId) return ordinal;
  }
  return null;
}

export interface AttemptComparison {
  previousAttemptNumber: number;
  progressDeltaPp: number;
  deathsDelta: number;
  incidentsDelta: number;
  verdict: 'improved' | 'regressed' | 'mixed' | 'unchanged';
}

/**
 * Comparación transparente de tres magnitudes reales. No fabrica un
 * porcentaje compuesto: cada delta conserva su unidad y dirección.
 */
export function buildAttemptComparison(args: {
  previousAttemptNumber: number;
  currentWipePct: number | null;
  previousWipePct: number | null;
  currentDeaths: number;
  previousDeaths: number;
  currentIncidents: number;
  previousIncidents: number;
}): AttemptComparison {
  const progressDeltaPp = (args.previousWipePct ?? 100) - (args.currentWipePct ?? 100);
  const deathsDelta = args.currentDeaths - args.previousDeaths;
  const incidentsDelta = args.currentIncidents - args.previousIncidents;

  const directions = [Math.sign(progressDeltaPp), Math.sign(-deathsDelta), Math.sign(-incidentsDelta)];
  const hasBetter = directions.some((value) => value > 0);
  const hasWorse = directions.some((value) => value < 0);
  const verdict = hasBetter && hasWorse ? 'mixed' : hasBetter ? 'improved' : hasWorse ? 'regressed' : 'unchanged';

  return {
    previousAttemptNumber: args.previousAttemptNumber,
    progressDeltaPp: Math.round(progressDeltaPp * 10) / 10,
    deathsDelta,
    incidentsDelta,
    verdict,
  };
}
