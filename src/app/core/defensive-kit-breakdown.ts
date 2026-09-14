// §defensive-kit-panel (2026-09-11, feedback real: "así el raider puede verificar correctamente su kit y
// detectar inconsistencias" — Gusmï viendo Barkskin/Bear Form/Frenzied Regeneration con su propio cooldown y
// si cuenta o no en contra). Hoja pura, reutilizada tanto por el dosier interactivo como por la imagen v3 de
// Discord — una sola fuente de verdad para "qué hay en mi kit y qué de eso cuenta". opportunityMode viene
// directo de effective_kit (nunca de applicableCandidates, que solo existe si el spell llegó a ser candidato
// de algún episodio real esta noche — un spell del kit que nunca tuvo ocasión sigue debiendo aparecer aquí
// con sus contadores en 0, no desaparecer).
import type { CanonicalDefensiveEpisodeFact } from './canonical-defensive-summary.service';
import type { EffectiveKitEntry } from './canonical-defensive-summary.service';

export interface DefensiveKitBreakdownEntry {
  spellId: number;
  name: string;
  /** true = "normal" (opportunity_mode): un pico sin cubrir con este spell disponible resta en Reacción/
   * Respuesta. false = "credit_only": aparece en el kit, pero nunca resta — solo suma si se usó. */
  countsAgainstKpi: boolean;
  effectiveCooldownMs: number | null;
  charges: number | null;
  timesDecisive: number;
  timesCovering: number;
  timesUsed: number;
}

/**
 * `effective_kit` se persiste desde EffectiveDefensiveAuditFact y YA contiene
 * el nombre canónico resuelto por el backend. El mirror frontend histórico
 * EffectiveKitEntry no expone ese campo todavía, así que lo leemos de forma
 * aditiva y compatible con filas antiguas: snapshot > mapa de casts > fallback.
 * Esto evita que un defensivo real que no se casteó esa noche aparezca como
 * "Spell 5277" solo porque no existe en spellNameById.
 */
function spellName(entry: EffectiveKitEntry, spellNameById: ReadonlyMap<number, string>): string {
  const persistedName = (entry as EffectiveKitEntry & { name?: unknown }).name;
  if (typeof persistedName === 'string' && persistedName.trim()) return persistedName.trim();
  return spellNameById.get(entry.spellId) ?? `Spell ${entry.spellId}`;
}

export function buildDefensiveKitBreakdown(
  kit: readonly EffectiveKitEntry[],
  episodes: readonly CanonicalDefensiveEpisodeFact[],
  spellNameById: ReadonlyMap<number, string>,
): DefensiveKitBreakdownEntry[] {
  const bySpell = new Map<number, DefensiveKitBreakdownEntry>();
  for (const entry of kit ?? []) {
    bySpell.set(entry.spellId, {
      spellId: entry.spellId,
      name: spellName(entry, spellNameById),
      countsAgainstKpi: entry.opportunityMode === 'normal',
      effectiveCooldownMs: entry.effectiveCooldownMs,
      charges: entry.charges,
      timesDecisive: 0,
      timesCovering: 0,
      timesUsed: 0,
    });
  }

  for (const episode of episodes) {
    for (const candidate of episode.applicableCandidates) {
      const stat = bySpell.get(candidate.spellId);
      if (!stat) continue; // §candidato de un spell que el kit no resolvió como miembro — nunca se fabrica una fila nueva aquí, kit es la única fuente de membership
      if (episode.decisiveSpellIds.includes(candidate.spellId)) stat.timesDecisive += 1;
      if (episode.coveredBySpellId === candidate.spellId) stat.timesCovering += 1;
      if (candidate.engagement) stat.timesUsed += 1;
    }
  }

  return [...bySpell.values()].sort((a, b) => a.name.localeCompare(b.name));
}