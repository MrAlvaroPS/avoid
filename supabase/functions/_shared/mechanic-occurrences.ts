export interface MechanicCastLike {
  timestamp?: number;
  abilityGameID?: number;
  sourceID?: number;
}

export interface OccurrenceTimingSummary {
  medianOffsetMs: number;
  p10OffsetMs: number;
  p90OffsetMs: number;
}

/**
 * Reconstruye #1..#N dentro de UN fight. Los IDs reales pueden variar entre
 * reports aunque la ability lógica del Journal sea la misma. Dos eventos con
 * el mismo timestamp y caster se deduplican para no inventar una ocurrencia
 * si WCL expone aliases del mismo cast. Dos enemigos distintos que lanzan a
 * la vez siguen siendo dos ocurrencias reales.
 */
export function mechanicOccurrenceOffsetsForFight(
  casts: MechanicCastLike[],
  realAbilityIds: Iterable<number>,
  fightStartTimeMs: number,
): number[] {
  const acceptedIds = new Set(realAbilityIds);
  const timestampsByCastIdentity = new Map<string, number>();
  for (const cast of casts) {
    if (
      typeof cast.timestamp !== 'number' ||
      !Number.isFinite(cast.timestamp) ||
      typeof cast.abilityGameID !== 'number' ||
      !acceptedIds.has(cast.abilityGameID) ||
      cast.timestamp < fightStartTimeMs
    ) {
      continue;
    }
    const timestamp = Math.round(cast.timestamp);
    const sourceIdentity = typeof cast.sourceID === 'number' ? cast.sourceID : 'unknown';
    timestampsByCastIdentity.set(`${timestamp}:${sourceIdentity}`, timestamp);
  }
  return [...timestampsByCastIdentity.values()]
    .sort((a, b) => a - b)
    .map((timestamp) => timestamp - Math.round(fightStartTimeMs));
}

/** Alinea #1 con #1 entre fights; una #N ausente no recibe una muestra falsa. */
export function groupMechanicOccurrenceOffsets(
  offsetsByFight: number[][],
): Map<number, number[]> {
  const grouped = new Map<number, number[]>();
  for (const offsets of offsetsByFight) {
    offsets.forEach((offsetMs, index) => {
      if (!Number.isFinite(offsetMs) || offsetMs < 0) return;
      const occurrenceIndex = index + 1;
      if (!grouped.has(occurrenceIndex)) grouped.set(occurrenceIndex, []);
      grouped.get(occurrenceIndex)!.push(Math.round(offsetMs));
    });
  }
  return grouped;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  return Math.round(lower + (upper - lower) * (position - lowerIndex));
}

/** Resume offsets de una occurrence concreta con interpolación lineal. */
export function summarizeOccurrenceOffsets(offsets: number[]): OccurrenceTimingSummary | null {
  const sorted = offsets
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map(Math.round)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    medianOffsetMs: percentile(sorted, 0.5),
    p10OffsetMs: percentile(sorted, 0.1),
    p90OffsetMs: percentile(sorted, 0.9),
  };
}
