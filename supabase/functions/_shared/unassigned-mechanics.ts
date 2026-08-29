// Colocar en: supabase/functions/_shared/unassigned-mechanics.ts
// §"la raid debe hacerlo, lo que pasa que no marca a nadie a propósito para
// hacerlo y es el RL quien lo dice o la propia voluntad del raider" (feedback
// real, 2026-08-29): detección de mecánicas sin asignación fija (huevos,
// orbes, ítems que cualquier jugador elegible puede resolver). Verificado
// empíricamente contra un log real (Lvp1VCbzmwTRHdQ7) antes de escribir esto
// — 3 modos de detección reales, no hipotéticos:
//  - 'npc_interaction': el objeto es un NPC-actor (huevos/orbe de Ula'tek y
//    Altar) — NUNCA aparece en applicable_boss_mechanics_candidates (esa
//    tabla es 100% Journal, y el Journal no documenta objetos del suelo,
//    solo hechizos del boss). Se detecta por Casts/DamageDone del jugador
//    CONTRA ese NPC — no hace falta ninguna llamada nueva a WCL, ambos
//    arrays ya se traen siempre en analyze-report.
//  - 'cast': el jugador casta un hechizo real (el pez de Lost Explorers,
//    ability 1296535 confirmado contra un Cast real de un jugador) —
//    tampoco hace falta llamada nueva, ya viene en friendlyCastEvents.
//  - 'debuff_applied'/'buff_applied': un NPC (o el propio jugador) aplica un
//    buff/debuff real — esto SÍ requiere pedir dataType Debuffs/Buffs, que
//    hoy no se pide nunca (solo Dispels, un tipo de evento distinto) — se
//    pide condicionalmente, solo si el catálogo de este boss+dificultad
//    tiene alguna fila que lo necesite (ver analyze-report/index.ts).

export interface UnassignedMechanicCatalogEntry {
  id: string;
  abilityId: number | null;
  actorNamePattern: string | null;
  name: string;
  detectionType: 'cast' | 'debuff_applied' | 'buff_applied' | 'npc_interaction';
  appliedBy: 'npc' | 'self' | null;
}

export interface UnassignedMechanicOccurrence {
  catalogId: string;
  mechanicName: string;
  actorId: number;
  actorName: string;
  /** Relativo al inicio del fight, igual criterio que defensive_pressure_windows. */
  timestampMs: number;
}

// Exportado para que analyze-report pueda castear (`as GenericEvent[]`) los
// arrays crudos de WCL que ya trae para otras cosas — mismo idioma que ya usa
// ese archivo con ThroughputEvent (ver `damageDoneEvents as ThroughputEvent[]`).
export interface GenericEvent {
  type?: string;
  timestamp?: number;
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
}

export interface ActorLite {
  name: string;
  type: string;
}

export function detectUnassignedMechanicOccurrences(params: {
  catalog: UnassignedMechanicCatalogEntry[];
  fightStartTime: number;
  /** friendlyCastEvents ya traídas — ninguna llamada nueva. */
  castEvents: GenericEvent[];
  /** damageDoneEvents ya traídas — cubre el "DPS the eggs down to zero health" de la guía, no solo el interact limpio. */
  damageDoneEvents: GenericEvent[];
  /** Solo si algún catálogo de este boss+dificultad pide 'debuff_applied' — si no, se pasa un array vacío sin gastar cuota de WCL. */
  debuffEvents: GenericEvent[];
  buffEvents: GenericEvent[];
  actorById: Map<number, ActorLite>;
  playerActorIds: Set<number>;
}): UnassignedMechanicOccurrence[] {
  const occurrences: UnassignedMechanicOccurrence[] = [];

  for (const entry of params.catalog) {
    if (entry.detectionType === 'npc_interaction') {
      if (!entry.actorNamePattern) continue;
      const matchingNpcIds = new Set(
        [...params.actorById.entries()]
          .filter(([, actor]) => actor.type === 'NPC' && actor.name === entry.actorNamePattern)
          .map(([id]) => id),
      );
      if (!matchingNpcIds.size) continue;
      // Un jugador puede pegarle varias veces al mismo huevo/orbe (varios
      // Casts o varios ticks de DamageDone) — se cuenta UNA vez por
      // (jugador, instancia de NPC), no una por evento, para no inflar el
      // recuento de un raider que simplemente hizo cleave normal sobre él.
      const seen = new Set<string>();
      for (const raw of [...params.castEvents, ...params.damageDoneEvents]) {
        if (typeof raw.targetID !== 'number' || !matchingNpcIds.has(raw.targetID)) continue;
        if (typeof raw.sourceID !== 'number' || !params.playerActorIds.has(raw.sourceID)) continue;
        const dedupKey = `${raw.sourceID}|${raw.targetID}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        occurrences.push({
          catalogId: entry.id,
          mechanicName: entry.name,
          actorId: raw.sourceID,
          actorName: params.actorById.get(raw.sourceID)?.name ?? 'Desconocido',
          timestampMs: (raw.timestamp ?? 0) - params.fightStartTime,
        });
      }
      continue;
    }

    if (entry.detectionType === 'cast') {
      if (entry.abilityId == null) continue;
      for (const raw of params.castEvents) {
        if (raw.abilityGameID !== entry.abilityId) continue;
        if (typeof raw.sourceID !== 'number' || !params.playerActorIds.has(raw.sourceID)) continue;
        occurrences.push({
          catalogId: entry.id,
          mechanicName: entry.name,
          actorId: raw.sourceID,
          actorName: params.actorById.get(raw.sourceID)?.name ?? 'Desconocido',
          timestampMs: (raw.timestamp ?? 0) - params.fightStartTime,
        });
      }
      continue;
    }

    // 'debuff_applied' / 'buff_applied'
    if (entry.abilityId == null) continue;
    const events = entry.detectionType === 'debuff_applied' ? params.debuffEvents : params.buffEvents;
    const applyType = entry.detectionType === 'debuff_applied' ? 'applydebuff' : 'applybuff';
    for (const raw of events) {
      if (raw.abilityGameID !== entry.abilityId || raw.type !== applyType) continue;
      if (typeof raw.targetID !== 'number' || !params.playerActorIds.has(raw.targetID)) continue;
      // applied_by documenta QUIÉN debe aplicarlo — filtra falsos positivos
      // (ej. dos jugadores intercambiándose el mismo buff por otro motivo).
      if (entry.appliedBy === 'self' && raw.sourceID !== raw.targetID) continue;
      if (entry.appliedBy === 'npc' && params.playerActorIds.has(raw.sourceID ?? -1)) continue;
      occurrences.push({
        catalogId: entry.id,
        mechanicName: entry.name,
        actorId: raw.targetID,
        actorName: params.actorById.get(raw.targetID)?.name ?? 'Desconocido',
        timestampMs: (raw.timestamp ?? 0) - params.fightStartTime,
      });
    }
  }

  return occurrences;
}
