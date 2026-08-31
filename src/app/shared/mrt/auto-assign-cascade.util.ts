// Colocar en: src/app/shared/mrt/auto-assign-cascade.util.ts
// §"la idea de la parte de 'Preparación' es que AUTO asigne defensivos de
// cada spec en las ventanas... empezando en cascada: primero en las que
// más pico hace a toda la raid, luego la segunda..." (feedback real,
// 2026-08-31): algoritmo greedy puro (sin Angular, sin red) — recibe las
// mecánicas YA rankeadas por impacto y el kit de defensivos de una spec, y
// decide qué cubre qué, respetando cooldowns reales a lo largo del fight
// ("si el pico más grande está en el minuto 4 pero el defensivo tiene
// cooldown de 2 minutos, hay opción de haberlo usado 1 o 2 veces antes" —
// exactamente lo que hace: un mismo defensivo puede cubrir VARIOS picos
// mientras el cooldown se lo permita, no un único uso fijo).
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
}

export interface CascadeAssignment {
  abilityId: number;
  defensiveSpellId: number;
}

// mitigation/absorption reducen el golpe en sí; sustain repara después —
// preferir lo primero para picos de daño puro, mismo orden que ya usa la
// guía de la infografía al explicar los ejes de supervivencia.
const SURVIVAL_TYPE_PRIORITY: Record<string, number> = { mitigation: 0, absorption: 1, sustain: 2 };

export function autoAssignCascade(mechanics: CascadeMechanicInput[], defensives: CascadeDefensiveInput[]): CascadeAssignment[] {
  const ranked = mechanics
    .filter((m) => m.timeMs != null)
    .slice()
    .sort((a, b) => b.impactScore - a.impactScore);

  const usable = defensives.filter((d) => d.survivalType != null && d.survivalType !== 'emergency' && d.baseCooldownMs != null);

  const nextAvailableMs = new Map<number, number>(); // spellId -> próximo instante en que vuelve a estar libre
  const assignments: CascadeAssignment[] = [];

  for (const mech of ranked) {
    const t = mech.timeMs!;
    const available = usable
      .filter((d) => (nextAvailableMs.get(d.spellId) ?? 0) <= t)
      .sort((a, b) => (SURVIVAL_TYPE_PRIORITY[a.survivalType!] ?? 9) - (SURVIVAL_TYPE_PRIORITY[b.survivalType!] ?? 9) || (b.baseCooldownMs ?? 0) - (a.baseCooldownMs ?? 0));
    const chosen = available[0];
    if (!chosen) continue; // nada libre para este pico — se deja sin asignar, el humano decide a mano
    assignments.push({ abilityId: mech.abilityId, defensiveSpellId: chosen.spellId });
    nextAvailableMs.set(chosen.spellId, t + (chosen.baseCooldownMs ?? 0));
  }

  return assignments;
}
