import type { DamagePlanningWindow } from './mechanic-occurrences.util';

export interface RosterPlannerDefensive {
  spellId: number;
  name: string;
  survivalType: string;
  effectiveCooldownMs: number;
  reservedTimesMs?: number[];
}

export interface RosterPlannerAssignment {
  windowId: string;
  timeMs: number;
  defensiveSpellId: number;
  defensiveName: string;
  effectiveCooldownMs: number;
}

export interface RosterDefensivePlan {
  assignments: RosterPlannerAssignment[];
  uncoveredWindowIds: string[];
}

const SURVIVAL_TYPE_PRIORITY: Record<string, number> = { mitigation: 0, absorption: 1, sustain: 2 };

function canReserveAt(timeMs: number, cooldownMs: number, reservations: number[]): boolean {
  return reservations.every((reserved) => Math.abs(timeMs - reserved) >= cooldownMs);
}

/**
 * Planner v2. Tras CADA reserva vuelve a recorrer las ventanas desde la de
 * mayor impacto. Así una reserva prioritaria en 4:00 no impide descubrir un
 * uso compatible en 1:00, ni usos posteriores. Termina solo cuando ninguna
 * pareja ventana+defensivo restante es viable.
 *
 * Entre varios defensivos libres en el mismo pico, usa un look-ahead pequeño:
 * prefiere el que pierda menos oportunidades futuras al reservarse ahora.
 * Esto evita desperdiciar gratuitamente un CD flexible si otro encaja igual
 * de bien en el pico actual.
 */
export function buildRosterDefensivePlan(
  windows: DamagePlanningWindow[],
  defensives: RosterPlannerDefensive[],
): RosterDefensivePlan {
  const remaining = new Map(windows.map((w) => [w.windowId, w]));
  const reservationsBySpellId = new Map<number, number[]>();
  for (const defensive of defensives) {
    reservationsBySpellId.set(defensive.spellId, [...(defensive.reservedTimesMs ?? [])].filter(Number.isFinite).sort((a, b) => a - b));
  }

  const assignments: RosterPlannerAssignment[] = [];

  while (remaining.size) {
    const rankedWindows = [...remaining.values()].sort(
      (a, b) => b.impactScore - a.impactScore || (b.priority ?? 0) - (a.priority ?? 0) || a.timeMs - b.timeMs,
    );

    let selected: { window: DamagePlanningWindow; defensive: RosterPlannerDefensive } | null = null;

    for (const window of rankedWindows) {
      const available = defensives.filter((d) =>
        canReserveAt(window.timeMs, d.effectiveCooldownMs, reservationsBySpellId.get(d.spellId) ?? []),
      );
      if (!available.length) continue;

      const scored = available.map((defensive) => {
        const beforeReservations = reservationsBySpellId.get(defensive.spellId) ?? [];
        const before = rankedWindows.filter(
          (candidate) => candidate.windowId !== window.windowId && canReserveAt(candidate.timeMs, defensive.effectiveCooldownMs, beforeReservations),
        ).length;
        const afterReservations = [...beforeReservations, window.timeMs];
        const after = rankedWindows.filter(
          (candidate) => candidate.windowId !== window.windowId && canReserveAt(candidate.timeMs, defensive.effectiveCooldownMs, afterReservations),
        ).length;
        return { defensive, opportunityLoss: before - after };
      });

      scored.sort(
        (a, b) =>
          a.opportunityLoss - b.opportunityLoss ||
          (SURVIVAL_TYPE_PRIORITY[a.defensive.survivalType] ?? 9) - (SURVIVAL_TYPE_PRIORITY[b.defensive.survivalType] ?? 9) ||
          b.defensive.effectiveCooldownMs - a.defensive.effectiveCooldownMs ||
          a.defensive.spellId - b.defensive.spellId,
      );
      selected = { window, defensive: scored[0].defensive };
      break;
    }

    if (!selected) break;

    assignments.push({
      windowId: selected.window.windowId,
      timeMs: selected.window.timeMs,
      defensiveSpellId: selected.defensive.spellId,
      defensiveName: selected.defensive.name,
      effectiveCooldownMs: selected.defensive.effectiveCooldownMs,
    });
    const reservations = reservationsBySpellId.get(selected.defensive.spellId) ?? [];
    reservations.push(selected.window.timeMs);
    reservations.sort((a, b) => a - b);
    reservationsBySpellId.set(selected.defensive.spellId, reservations);
    remaining.delete(selected.window.windowId);
  }

  return {
    assignments: assignments.sort((a, b) => a.timeMs - b.timeMs),
    uncoveredWindowIds: [...remaining.keys()],
  };
}
