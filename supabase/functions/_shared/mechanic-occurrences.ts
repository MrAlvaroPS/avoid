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

const DEFAULT_CLUSTER_TOLERANCE_MS = 5_000;
const MIN_CLUSTER_TOLERANCE_MS = 1_000;

/**
 * §"si una habilidad pasó en un pull en el 0:03 y en otro en el 0:04, te
 * marca que uses dos defensivos distintos sin identificar que es la misma
 * habilidad" (feedback real, 2026-09-03; bug confirmado): la versión
 * anterior alineaba #1 con #1 por POSICIÓN dentro de cada fight (el primer
 * cast de cada pull es "#1", el segundo "#2"...). Eso solo funciona si
 * TODOS los pulls tienen exactamente el mismo número de casts en el mismo
 * orden — un wipe temprano, un cast condicional que no siempre ocurre, o
 * cualquier variación real entre pulls desplaza la numeración de todo lo que
 * viene después para ese pull, mezclando ocurrencias que no son la misma
 * mecánica real y separando otras que sí lo son.
 *
 * Ahora se agrupa por PROXIMIDAD TEMPORAL entre todos los pulls a la vez
 * (todas las muestras juntas, ordenadas, clustering greedy), no por
 * posición. El margen de tolerancia nunca puede superar la mitad del hueco
 * real más corto observado ENTRE DOS CASTS DISTINTOS DEL MISMO PULL — ese
 * hueco es la prueba de que dos ocurrencias tan próximas SÍ son reales y
 * distintas, así que la tolerancia entre pulls jamás las fusiona por error.
 *
 * §"esta cubriendo varias mecanicas con distintos defensivos... no debe
 * estar teniendo en cuenta... duracion" (feedback real, 2026-09-03, con
 * capturas de Magzil y Gusmï mostrando ventanas de ±70s en una sola
 * "ocurrencia"): encadenar solo contra el elemento anterior permite que un
 * cluster DERIVE sin límite — A-B cerca, B-C cerca, C-D cerca... aunque A y
 * D estén a 70s de distancia. Con ráfagas ddentro de un pull tan juntas
 * como decenas de ms, una tolerancia de solo 1-5s bastaba para encadenar
 * decenas de muestras de pulls distintos en un cluster gigante. Ahora,
 * además del hueco al anterior, el cluster completo (última - primera
 * muestra) nunca puede superar la tolerancia: dos muestras a más de
 * clusterToleranceMs entre sí JAMÁS terminan en la misma ocurrencia, sin
 * importar cuántos pasos intermedios las conecten.
 */
export function groupMechanicOccurrenceOffsets(
  offsetsByFight: number[][],
): Map<number, number[]> {
  const cleanByFight = offsetsByFight.map((offsets) =>
    offsets.filter((offsetMs) => Number.isFinite(offsetMs) && offsetMs >= 0).map((offsetMs) => Math.round(offsetMs)),
  );

  const intraFightGaps: number[] = [];
  for (const offsets of cleanByFight) {
    const sorted = [...offsets].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) intraFightGaps.push(sorted[i] - sorted[i - 1]);
  }
  const minRealGapMs = intraFightGaps.length ? Math.min(...intraFightGaps) : Infinity;
  const clusterToleranceMs = Math.min(
    DEFAULT_CLUSTER_TOLERANCE_MS,
    Math.max(MIN_CLUSTER_TOLERANCE_MS, minRealGapMs / 2),
  );

  const flatSorted = cleanByFight.flat().sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const offsetMs of flatSorted) {
    const current = clusters.at(-1);
    const withinPreviousGap = current != null && offsetMs - current[current.length - 1] <= clusterToleranceMs;
    const withinClusterSpan = current != null && offsetMs - current[0] <= clusterToleranceMs;
    if (current && withinPreviousGap && withinClusterSpan) {
      current.push(offsetMs);
    } else {
      clusters.push([offsetMs]);
    }
  }

  const grouped = new Map<number, number[]>();
  clusters.forEach((cluster, index) => grouped.set(index + 1, cluster));
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
