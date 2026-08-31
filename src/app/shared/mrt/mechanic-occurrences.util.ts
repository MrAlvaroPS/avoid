export interface MechanicOccurrenceInput {
  abilityId: number;
  name: string;
  castOffsetSamplesMs: number[];
  sampleFightCount: number;
  impactScore: number;
  priority: number | null;
}

export interface MechanicOccurrence {
  occurrenceId: string;
  abilityId: number;
  name: string;
  occurrenceIndex: number;
  timeMs: number;
  support: number;
  supportFraction: number;
  impactScore: number;
  priority: number | null;
}

export interface DamagePlanningWindow {
  windowId: string;
  timeMs: number;
  impactScore: number;
  priority: number | null;
  occurrences: MechanicOccurrence[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * `reference_cast_offset_ms_samples` contiene todos los casts observados en
 * muchos fights. Una mediana global destruye el patrón repetido. Esta función
 * reconstruye los "carriles" temporales: casts de distintos logs alrededor
 * del mismo instante se agrupan, y solo sobreviven clusters observados en una
 * fracción suficiente de la muestra.
 *
 * No intenta inventar un cast que los logs no apoyan: si el soporte es bajo,
 * el cluster se descarta. Así una kill atípica o un wipe corto no genera una
 * ventana falsa en el plan.
 */
export function reconstructMechanicOccurrences(
  input: MechanicOccurrenceInput,
  toleranceMs = 8000,
  minSupportFraction = 0.25,
): MechanicOccurrence[] {
  const samples = input.castOffsetSamplesMs.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!samples.length) return [];

  const clusters: number[][] = [];
  for (const sample of samples) {
    const last = clusters.at(-1);
    if (!last) {
      clusters.push([sample]);
      continue;
    }
    const center = median(last);
    if (Math.abs(sample - center) <= toleranceMs) last.push(sample);
    else clusters.push([sample]);
  }

  const denominator = Math.max(1, input.sampleFightCount);
  const minSupport = Math.max(2, Math.ceil(denominator * minSupportFraction));
  return clusters
    .filter((cluster) => cluster.length >= minSupport || denominator === 1)
    .map((cluster, index) => ({
      occurrenceId: `${input.abilityId}:${index}`,
      abilityId: input.abilityId,
      name: input.name,
      occurrenceIndex: index,
      timeMs: Math.round(median(cluster)),
      support: cluster.length,
      supportFraction: Math.min(1, cluster.length / denominator),
      impactScore: input.impactScore,
      priority: input.priority,
    }));
}

/**
 * Varias mecánicas que caen prácticamente juntas son UNA ventana de presión
 * para un personal. Suma sus impactos y evita gastar dos personales sobre el
 * mismo solapamiento solo porque haya dos spellIds distintos a 2:27/2:28.
 */
export function combineOccurrencesIntoDamageWindows(
  occurrences: MechanicOccurrence[],
  overlapToleranceMs = 4000,
): DamagePlanningWindow[] {
  const sorted = [...occurrences].sort((a, b) => a.timeMs - b.timeMs || b.impactScore - a.impactScore);
  const groups: MechanicOccurrence[][] = [];
  for (const occurrence of sorted) {
    const last = groups.at(-1);
    if (!last) {
      groups.push([occurrence]);
      continue;
    }
    const lastTime = Math.max(...last.map((o) => o.timeMs));
    if (occurrence.timeMs - lastTime <= overlapToleranceMs) last.push(occurrence);
    else groups.push([occurrence]);
  }

  return groups.map((group) => {
    const ids = group.map((o) => o.occurrenceId).sort();
    const totalImpact = group.reduce((sum, o) => sum + Math.max(0, o.impactScore), 0);
    const weightedTime = totalImpact > 0
      ? Math.round(group.reduce((sum, o) => sum + o.timeMs * Math.max(0, o.impactScore), 0) / totalImpact)
      : Math.round(median(group.map((o) => o.timeMs)));
    return {
      windowId: ids.join('+'),
      timeMs: weightedTime,
      impactScore: totalImpact,
      priority: group.reduce<number | null>((max, o) => (o.priority == null ? max : Math.max(max ?? o.priority, o.priority)), null),
      occurrences: group,
    };
  });
}
