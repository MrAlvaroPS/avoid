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
  /** §"cuando habla de 'Llamada colectiva', no sale ni tooltip ni información de la habilidad" (feedback real, 2026-08-28): mismo ability_id que ya lleva pull_mechanic_events, solo faltaba propagarlo hasta aquí — null en los tests que no lo traen (dato sintético) o si el evento no tenía ability_id resoluble. */
  wowheadSpellId: number | null;
  /** Misma nota de boss_mechanics_candidates.ai_classification que ya se enseña en Personales/Muertes vía app-mechanic-info-icon — null si esta mecánica no vino del flujo de clasificación por IA. */
  notes: string | null;
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
  /** Opcional: los tests de este módulo pasan eventos sintéticos sin ability_id — pull_mechanic_events real siempre lo trae. */
  ability_id?: number;
};

function breakdown(events: IncidentEvent[], notesByName?: Map<string, string>): IncidentBreakdownItem[] {
  const counts = new Map<string, { count: number; abilityId: number | null }>();
  for (const event of events) {
    const entry = counts.get(event.mechanic_name);
    if (entry) entry.count++;
    else counts.set(event.mechanic_name, { count: 1, abilityId: event.ability_id || null });
  }
  return [...counts.entries()]
    .map(([label, { count, abilityId }]) => ({ label, count, wowheadSpellId: abilityId, notes: notesByName?.get(label) ?? null }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function summarizeExecutionIncidents(
  events: IncidentEvent[],
  uncoveredDeathEvents = 0,
  /** §mismo cruce por NOMBRE que ya usa buildCallouts/buildMechanicFails en pull-analysis.service.ts (el ability_id del manifiesto casi nunca coincide con el real de WCL) — solo hace falta para el desglose que de verdad se enseña con tooltip (groupBreakdown, "Llamada colectiva"), pero se aplica a los tres por si algún consumidor futuro los enseña igual. */
  notesByMechanicName?: Map<string, string>,
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
    personalBreakdown: breakdown(personal, notesByMechanicName),
    groupBreakdown: breakdown(group, notesByMechanicName),
    unclassifiedBreakdown: breakdown(unclassified, notesByMechanicName),
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
