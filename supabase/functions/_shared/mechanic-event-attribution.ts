export interface MechanicCastLike {
  timestamp?: number;
  abilityGameID?: number;
  sourceID?: number;
  targetID?: number;
}

export interface MechanicDamageLike {
  timestamp?: number;
  abilityGameID?: number;
  sourceID?: number;
  targetID?: number;
}

export interface MechanicDeathLike {
  timestamp?: number;
  targetID?: number;
  killingAbilityGameID?: number;
}

export interface AttributedMechanicOccurrence<
  C extends MechanicCastLike,
  D extends MechanicDamageLike,
> {
  /** Posición estable después de ordenar/deduplicar los casts válidos. */
  occurrenceIndex: number;
  /** Índice del primer cast crudo que representa esta ocurrencia. */
  castIndex: number;
  cast: C;
  timestamp: number;
  damageEvents: D[];
  damageEventIndexes: number[];
}

export interface MechanicDamageAttribution<
  C extends MechanicCastLike,
  D extends MechanicDamageLike,
> {
  occurrences: AttributedMechanicOccurrence<C, D>[];
  /** DamageTaken de la mecánica que no pudo pertenecer causalmente a ningún cast. */
  unassignedDamageEvents: D[];
  unassignedDamageEventIndexes: number[];
}

interface NormalizedCast<C extends MechanicCastLike> {
  cast: C;
  originalIndex: number;
  timestamp: number;
  abilityId: number;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function castIdentity(cast: MechanicCastLike, timestamp: number, abilityId: number): string {
  // WCL puede exponer el mismo cast más de una vez. Un cast duplicado exacto
  // no puede convertirse en dos ocurrencias mecánicas distintas. sourceID
  // preserva dos NPC que lancen lo mismo simultáneamente; targetID evita
  // fusionar dos casts dirigidos a objetivos distintos del mismo caster.
  const source = finiteNumber(cast.sourceID) ? cast.sourceID : 'unknown';
  const target = finiteNumber(cast.targetID) ? cast.targetID : 'unknown';
  return `${abilityId}:${Math.round(timestamp)}:${source}:${target}`;
}

function preferMatchingSource<C extends MechanicCastLike>(
  candidates: NormalizedCast<C>[],
  sourceID: number | undefined,
): NormalizedCast<C>[] {
  if (!finiteNumber(sourceID)) return candidates;
  const exact = candidates.filter((candidate) => candidate.cast.sourceID === sourceID);
  return exact.length ? exact : candidates;
}

function preferMatchingTarget<C extends MechanicCastLike>(
  candidates: NormalizedCast<C>[],
  targetID: number | undefined,
): NormalizedCast<C>[] {
  if (!finiteNumber(targetID)) return candidates;
  const exact = candidates.filter((candidate) => candidate.cast.targetID === targetID);
  return exact.length ? exact : candidates;
}

function preferExactAbility<C extends MechanicCastLike>(
  candidates: NormalizedCast<C>[],
  abilityId: number | undefined,
): NormalizedCast<C>[] {
  if (!finiteNumber(abilityId)) return candidates;
  const exact = candidates.filter((candidate) => candidate.abilityId === abilityId);
  return exact.length ? exact : candidates;
}

/**
 * Atribuye cada DamageTaken crudo a COMO MÁXIMO un cast de la misma mecánica.
 *
 * Invariante principal: una ventana de reacción puede solaparse con muchas
 * otras (Axegrinder es el caso real que destapó el problema), pero volver a
 * recorrer el mismo array de DamageTaken por cast no convierte un golpe en
 * N golpes. La propiedad del evento se decide una sola vez y después los
 * consumidores agregan exclusivamente los eventos de su ocurrencia.
 *
 * La resolución de colisiones es conservadora:
 *  1. misma abilityGameID exacta si existe entre los candidatos;
 *  2. mismo sourceID si WCL permite demostrarlo;
 *  3. mismo targetID si el cast es dirigido y WCL lo aporta;
 *  4. cast causal anterior más próximo al golpe.
 *
 * sourceID/targetID son preferencias, no requisitos: algunos encuentros
 * castea el boss pero el daño lo emite un area-trigger/actor distinto.
 */
export function attributeDamageToMechanicCasts<
  C extends MechanicCastLike,
  D extends MechanicDamageLike,
>(
  casts: readonly C[],
  damageEvents: readonly D[],
  acceptedAbilityIds: Iterable<number>,
  reactionWindowMs: number,
): MechanicDamageAttribution<C, D> {
  const acceptedIds = new Set(acceptedAbilityIds);
  if (!Number.isFinite(reactionWindowMs) || reactionWindowMs < 0) {
    throw new Error('reactionWindowMs debe ser un número finito >= 0');
  }

  const deduped = new Map<string, NormalizedCast<C>>();
  casts.forEach((cast, originalIndex) => {
    if (!finiteNumber(cast.timestamp) || !finiteNumber(cast.abilityGameID)) return;
    if (!acceptedIds.has(cast.abilityGameID)) return;
    const timestamp = cast.timestamp;
    const identity = castIdentity(cast, timestamp, cast.abilityGameID);
    // Conserva la primera representación cruda: hace el resultado estable
    // aunque la API devuelva un duplicado exacto más tarde en otra página.
    if (!deduped.has(identity)) {
      deduped.set(identity, {
        cast,
        originalIndex,
        timestamp,
        abilityId: cast.abilityGameID,
      });
    }
  });

  const normalizedCasts = [...deduped.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.originalIndex - b.originalIndex,
  );
  const occurrenceByOriginalCastIndex = new Map<number, AttributedMechanicOccurrence<C, D>>();
  const occurrences = normalizedCasts.map((entry, occurrenceIndex) => {
    const occurrence: AttributedMechanicOccurrence<C, D> = {
      occurrenceIndex,
      castIndex: entry.originalIndex,
      cast: entry.cast,
      timestamp: entry.timestamp,
      damageEvents: [],
      damageEventIndexes: [],
    };
    occurrenceByOriginalCastIndex.set(entry.originalIndex, occurrence);
    return occurrence;
  });

  const unassignedDamageEvents: D[] = [];
  const unassignedDamageEventIndexes: number[] = [];

  damageEvents.forEach((damage, damageIndex) => {
    if (!finiteNumber(damage.abilityGameID) || !acceptedIds.has(damage.abilityGameID)) return;
    if (!finiteNumber(damage.timestamp) || !finiteNumber(damage.targetID)) {
      unassignedDamageEvents.push(damage);
      unassignedDamageEventIndexes.push(damageIndex);
      return;
    }

    let candidates = normalizedCasts.filter(
      (cast) => damage.timestamp! >= cast.timestamp && damage.timestamp! <= cast.timestamp + reactionWindowMs,
    );
    if (!candidates.length) {
      unassignedDamageEvents.push(damage);
      unassignedDamageEventIndexes.push(damageIndex);
      return;
    }

    candidates = preferExactAbility(candidates, damage.abilityGameID);
    candidates = preferMatchingSource(candidates, damage.sourceID);
    candidates = preferMatchingTarget(candidates, damage.targetID);
    // Todos son anteriores al hit. El timestamp mayor equivale al delta
    // causal más pequeño; originalIndex rompe empates de forma estable.
    const owner = [...candidates].sort(
      (a, b) => b.timestamp - a.timestamp || a.originalIndex - b.originalIndex,
    )[0];
    const occurrence = occurrenceByOriginalCastIndex.get(owner.originalIndex)!;
    occurrence.damageEvents.push(damage);
    occurrence.damageEventIndexes.push(damageIndex);
  });

  return {
    occurrences,
    unassignedDamageEvents,
    unassignedDamageEventIndexes,
  };
}

/**
 * Decide qué única ocurrencia puede ser la responsable de una muerte.
 * Primero hereda la propiedad del DamageTaken terminal ya atribuido; solo
 * si WCL no expuso ese hit usa el mismo selector causal sobre los casts.
 */
export function ownerOccurrenceIndexForDeath<
  C extends MechanicCastLike,
  D extends MechanicDamageLike,
>(
  death: MechanicDeathLike,
  occurrences: readonly AttributedMechanicOccurrence<C, D>[],
  reactionWindowMs: number,
): number | null {
  if (!finiteNumber(death.timestamp) || !finiteNumber(death.targetID)) return null;

  const terminalCandidates: { occurrenceIndex: number; timestamp: number; exactAbility: boolean }[] = [];
  for (const occurrence of occurrences) {
    for (const damage of occurrence.damageEvents) {
      if (!finiteNumber(damage.timestamp) || damage.targetID !== death.targetID) continue;
      if (damage.timestamp > death.timestamp || death.timestamp - damage.timestamp > reactionWindowMs) continue;
      terminalCandidates.push({
        occurrenceIndex: occurrence.occurrenceIndex,
        timestamp: damage.timestamp,
        exactAbility:
          finiteNumber(death.killingAbilityGameID) &&
          finiteNumber(damage.abilityGameID) &&
          death.killingAbilityGameID === damage.abilityGameID,
      });
    }
  }
  if (terminalCandidates.length) {
    const exact = terminalCandidates.filter((candidate) => candidate.exactAbility);
    const pool = exact.length ? exact : terminalCandidates;
    return [...pool].sort((a, b) => b.timestamp - a.timestamp || b.occurrenceIndex - a.occurrenceIndex)[0].occurrenceIndex;
  }

  let castCandidates = occurrences.filter(
    (occurrence) => death.timestamp! >= occurrence.timestamp && death.timestamp! <= occurrence.timestamp + reactionWindowMs,
  );
  if (!castCandidates.length) return null;

  if (finiteNumber(death.killingAbilityGameID)) {
    const exact = castCandidates.filter((occurrence) => occurrence.cast.abilityGameID === death.killingAbilityGameID);
    if (exact.length) castCandidates = exact;
  }
  const targeted = castCandidates.filter((occurrence) => occurrence.cast.targetID === death.targetID);
  if (targeted.length) castCandidates = targeted;

  return [...castCandidates].sort(
    (a, b) => b.timestamp - a.timestamp || b.occurrenceIndex - a.occurrenceIndex,
  )[0].occurrenceIndex;
}
