import type { EffectiveDefensive } from './effective-defensive-resolver.util';
import type { DamageWindow } from './damage-window-timeline.util';

export interface LockedPlanReservation {
  windowKey: string;
  defensiveSpellId: number;
}

export interface RosterPlanAssignment {
  window: DamageWindow;
  defensive: EffectiveDefensive;
  locked: boolean;
}

const SURVIVAL_PRIORITY: Record<string, number> = { mitigation: 0, absorption: 1, sustain: 2 };

/** Simula cargas con recarga secuencial, que es más conservador que asumir que todas recargan a la vez. */
function canScheduleUses(timesMs: number[], cooldownMs: number, maxCharges: number): boolean {
  const sorted = [...timesMs].sort((a, b) => a - b);
  let available = Math.max(1, maxCharges);
  let nextRechargeAt: number | null = null;
  for (const timeMs of sorted) {
    while (nextRechargeAt != null && nextRechargeAt <= timeMs) {
      available++;
      if (available < maxCharges) nextRechargeAt += cooldownMs;
      else nextRechargeAt = null;
    }
    if (available <= 0) return false;
    available--;
    if (nextRechargeAt == null && available < maxCharges) nextRechargeAt = timeMs + cooldownMs;
  }
  return true;
}

/**
 * Planificador iterativo. En cada vuelta busca la ventana sin cubrir de más
 * impacto que todavía tenga alguna combinación válida. Las reservas se
 * comprueban de nuevo en todo el eje temporal, hacia atrás y hacia delante.
 */
export function planRosterCooldowns(args: {
  windows: DamageWindow[];
  defensives: EffectiveDefensive[];
  locked?: LockedPlanReservation[];
}): RosterPlanAssignment[] {
  const { windows } = args;
  const usable = args.defensives.filter(
    (defensive): defensive is EffectiveDefensive & { survivalType: string; effectiveCooldownMs: number } =>
      (defensive.category === 'personal_defensive' || defensive.category === 'semi_defensive') &&
      defensive.survivalType != null &&
      defensive.survivalType !== 'emergency' &&
      defensive.effectiveCooldownMs != null,
  );
  const bySpellId = new Map(usable.map((defensive) => [defensive.spellId, defensive]));
  const assignments: RosterPlanAssignment[] = [];
  const usedWindowKeys = new Set<string>();
  const usesBySpellId = new Map<number, number[]>();

  for (const reservation of args.locked ?? []) {
    const window = windows.find((candidate) => candidate.key === reservation.windowKey);
    const defensive = bySpellId.get(reservation.defensiveSpellId);
    if (!window || !defensive || usedWindowKeys.has(window.key)) continue;
    const proposed = [...(usesBySpellId.get(defensive.spellId) ?? []), window.timeMs];
    if (!canScheduleUses(proposed, defensive.effectiveCooldownMs, defensive.charges)) continue;
    assignments.push({ window, defensive, locked: true });
    usedWindowKeys.add(window.key);
    usesBySpellId.set(defensive.spellId, proposed);
  }

  while (true) {
    const candidates = windows
      .filter((window) => !usedWindowKeys.has(window.key))
      .map((window) => {
        const available = usable
          .filter((defensive) =>
            canScheduleUses(
              [...(usesBySpellId.get(defensive.spellId) ?? []), window.timeMs],
              defensive.effectiveCooldownMs,
              defensive.charges,
            ),
          )
          .map((defensive) => {
            const existingUses = usesBySpellId.get(defensive.spellId) ?? [];
            const otherWindows = windows.filter((candidate) => candidate.key !== window.key && !usedWindowKeys.has(candidate.key));
            const opportunitiesBefore = otherWindows.filter((candidate) =>
              canScheduleUses([...existingUses, candidate.timeMs], defensive.effectiveCooldownMs, defensive.charges),
            ).length;
            const opportunitiesAfter = otherWindows.filter((candidate) =>
              canScheduleUses([...existingUses, window.timeMs, candidate.timeMs], defensive.effectiveCooldownMs, defensive.charges),
            ).length;
            return { defensive, opportunityLoss: opportunitiesBefore - opportunitiesAfter };
          })
          .sort(
            (a, b) =>
              a.opportunityLoss - b.opportunityLoss ||
              (SURVIVAL_PRIORITY[a.defensive.survivalType] ?? 9) - (SURVIVAL_PRIORITY[b.defensive.survivalType] ?? 9) ||
              b.defensive.effectiveCooldownMs - a.defensive.effectiveCooldownMs ||
              a.defensive.spellId - b.defensive.spellId,
          );
        return { window, defensive: available[0]?.defensive ?? null };
      })
      .filter((candidate): candidate is { window: DamageWindow; defensive: (typeof usable)[number] } => candidate.defensive != null)
      .sort(
        (a, b) =>
          b.window.impactScore - a.window.impactScore ||
          (b.window.priority ?? 0) - (a.window.priority ?? 0) ||
          a.window.timeMs - b.window.timeMs,
      );
    const chosen = candidates[0];
    if (!chosen) break;
    assignments.push({ window: chosen.window, defensive: chosen.defensive, locked: false });
    usedWindowKeys.add(chosen.window.key);
    usesBySpellId.set(chosen.defensive.spellId, [...(usesBySpellId.get(chosen.defensive.spellId) ?? []), chosen.window.timeMs]);
  }

  return assignments.sort((a, b) => a.window.timeMs - b.window.timeMs);
}
