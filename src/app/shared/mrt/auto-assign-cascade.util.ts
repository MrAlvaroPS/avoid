// Colocar en: src/app/shared/mrt/auto-assign-cascade.util.ts
// §"la idea de la parte de 'Preparación' es que AUTO asigne defensivos de
// cada spec en las ventanas... empezando en cascada: primero en las que
// más pico hace a toda la raid, luego la segunda..." (feedback real,
// 2026-08-31): algoritmo greedy puro (sin Angular, sin red) — recibe las
// mecánicas YA rankeadas por impacto y el kit de defensivos de una spec, y
// decide qué cubre qué, respetando cooldowns reales a lo largo del fight.
//
// IMPORTANTE: el orden de decisión es por IMPACTO, no cronológico. Por eso
// no sirve un único `nextAvailableMs`: si reservamos primero un pico fuerte
// en 4:00, un CD de 2 min todavía puede usarse en 1:00 y volver a estar
// disponible a las 4:00. Guardamos todas las reservas temporales por spell y
// comprobamos distancia de cooldown contra CADA uso ya reservado. Así se
// preserva la prioridad sin inventar conflictos hacia atrás en el tiempo.
//
// `reservedTimesMs` representa usos ya fijados manualmente. La cascada los
// respeta como reservas inmutables y solo rellena huecos nuevos; nunca debe
// obligar a sobrescribir una planificación humana para poder cuadrar el CD.
//
// Nunca asigna un defensivo 'emergency' — mismo criterio que
// evaluateWindowCoverage en damage-pressure-windows.ts: guardarlo es la
// jugada correcta la mayoría de las veces, no algo que automatizar.
// Tampoco asigna uno con cooldown desconocido (baseCooldownMs null) — sin
// ese dato no hay forma de razonar su disponibilidad a lo largo del fight,
// mejor dejarlo para que un humano lo asigne a mano que adivinar.

export interface CascadeMechanicInput {
  abilityId: number;
  name: string;
  /** Ms desde pull-start, momento representativo (mediana de ocurrencias observadas) — mecánicas sin este dato quedan fuera de la cascada. */
  timeMs: number | null;
  /** Puntuación de impacto a la raid — desempata el orden, mayor primero. */
  impactScore: number;
}

export interface CascadeDefensiveInput {
  spellId: number;
  survivalType: string | null;
  baseCooldownMs: number | null;
  /** Usos ya fijados manualmente para esta spec. Se respetan y nunca se mueven. */
  reservedTimesMs?: number[];
}

export interface CascadeAssignment {
  abilityId: number;
  defensiveSpellId: number;
}

// mitigation/absorption reducen el golpe en sí; sustain repara después —
// preferir lo primero para picos de daño puro, mismo orden que ya usa la
// guía de la infografía al explicar los ejes de supervivencia.
const SURVIVAL_TYPE_PRIORITY: Record<string, number> = { mitigation: 0, absorption: 1, sustain: 2 };

function canReserveAt(timeMs: number, cooldownMs: number, reservedTimesMs: number[]): boolean {
  return reservedTimesMs.every((reserved) => Math.abs(timeMs - reserved) >= cooldownMs);
}

export function autoAssignCascade(mechanics: CascadeMechanicInput[], defensives: CascadeDefensiveInput[]): CascadeAssignment[] {
  const ranked = mechanics
    .filter((m) => m.timeMs != null)
    .slice()
    .sort((a, b) => b.impactScore - a.impactScore || a.timeMs! - b.timeMs! || a.abilityId - b.abilityId);

  const usable = defensives.filter(
    (d): d is CascadeDefensiveInput & { survivalType: string; baseCooldownMs: number } =>
      d.survivalType != null && d.survivalType !== 'emergency' && d.baseCooldownMs != null,
  );

  const reservationsBySpellId = new Map<number, number[]>();
  for (const defensive of usable) {
    reservationsBySpellId.set(
      defensive.spellId,
      [...(defensive.reservedTimesMs ?? [])].filter(Number.isFinite).sort((a, b) => a - b),
    );
  }

  const assignments: CascadeAssignment[] = [];

  for (const mech of ranked) {
    const timeMs = mech.timeMs!;
    const available = usable
      .filter((d) => canReserveAt(timeMs, d.baseCooldownMs, reservationsBySpellId.get(d.spellId) ?? []))
      .sort(
        (a, b) =>
          (SURVIVAL_TYPE_PRIORITY[a.survivalType] ?? 9) - (SURVIVAL_TYPE_PRIORITY[b.survivalType] ?? 9) ||
          b.baseCooldownMs - a.baseCooldownMs ||
          a.spellId - b.spellId,
      );
    const chosen = available[0];
    if (!chosen) continue; // nada libre para este pico — se deja sin asignar, el humano decide a mano

    assignments.push({ abilityId: mech.abilityId, defensiveSpellId: chosen.spellId });
    const reservations = reservationsBySpellId.get(chosen.spellId) ?? [];
    reservations.push(timeMs);
    reservations.sort((a, b) => a - b);
    reservationsBySpellId.set(chosen.spellId, reservations);
  }

  return assignments;
}
