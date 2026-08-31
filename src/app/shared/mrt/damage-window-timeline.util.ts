export interface DamageWindowMechanicInput {
  abilityId: number;
  name: string;
  offsetSamplesMs: number[];
  offsetsByFight?: { fightKey: string; offsetsMs: number[] }[];
  sampleFightCount: number;
  impactScore: number;
  priority: number | null;
}

export interface DamageWindowOccurrence {
  abilityId: number;
  name: string;
  occurrenceIndex: number;
  timeMs: number;
  sampleCount: number;
  supportFraction: number;
  impactScore: number;
  priority: number | null;
}

export interface DamageWindow {
  key: string;
  timeMs: number;
  impactScore: number;
  priority: number | null;
  occurrences: DamageWindowOccurrence[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Agrupa el mismo ordinal observado en pulls distintos. El perfil histórico
 * disponible todavía es un array plano, por eso se usa una tolerancia corta
 * de jitter. La salida ya es occurrence-level y deja de reducir toda la
 * habilidad a una sola mediana.
 */
export function clusterMechanicOccurrences(samples: number[], toleranceMs = 8_000): number[][] {
  const sorted = samples.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const sample of sorted) {
    const current = clusters.at(-1);
    if (!current || Math.abs(sample - median(current)) > toleranceMs) clusters.push([sample]);
    else current.push(sample);
  }
  return clusters;
}

/** Une habilidades que caen prácticamente a la vez en una sola ventana de presión. */
export function buildDamageWindowTimeline(
  mechanics: DamageWindowMechanicInput[],
  overlapToleranceMs = 4_000,
  minSupportFraction = 0.25,
): DamageWindow[] {
  const occurrences: DamageWindowOccurrence[] = [];
  for (const mechanic of mechanics) {
    const byFight = (mechanic.offsetsByFight ?? [])
      .map((fight) => ({ ...fight, offsetsMs: fight.offsetsMs.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b) }))
      .filter((fight) => fight.offsetsMs.length > 0);
    const inferredClusters = clusterMechanicOccurrences(mechanic.offsetSamplesMs).map((cluster, index) => ({ cluster, occurrenceIndex: index + 1 }));
    const exactClusters = byFight.length
      ? Array.from({ length: Math.max(...byFight.map((fight) => fight.offsetsMs.length)) }, (_, index) => ({
          cluster: byFight.map((fight) => fight.offsetsMs[index]).filter((value): value is number => value != null),
          occurrenceIndex: index + 1,
        }))
      : [];
    const clusters = exactClusters.length ? exactClusters : inferredClusters;
    const denominator = Math.max(1, byFight.length || mechanic.sampleFightCount);
    const minSupport = Math.max(2, Math.ceil(denominator * minSupportFraction));
    clusters
      .filter(({ cluster }) => denominator === 1 || cluster.length >= minSupport)
      .forEach(({ cluster, occurrenceIndex }) => {
      occurrences.push({
        abilityId: mechanic.abilityId,
        name: mechanic.name,
        occurrenceIndex,
        timeMs: Math.round(median(cluster)),
        sampleCount: cluster.length,
        supportFraction: Math.min(1, cluster.length / denominator),
        impactScore: mechanic.impactScore,
        priority: mechanic.priority,
      });
      });
  }
  occurrences.sort((a, b) => a.timeMs - b.timeMs || b.impactScore - a.impactScore || a.abilityId - b.abilityId);

  const groups: DamageWindowOccurrence[][] = [];
  for (const occurrence of occurrences) {
    const current = groups.at(-1);
    const currentCenter = current?.length ? median(current.map((item) => item.timeMs)) : null;
    if (!current || currentCenter == null || occurrence.timeMs - currentCenter > overlapToleranceMs) groups.push([occurrence]);
    else current.push(occurrence);
  }

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => a.abilityId - b.abilityId || a.occurrenceIndex - b.occurrenceIndex);
    const totalImpact = group.reduce((sum, item) => sum + Math.max(0, item.impactScore), 0);
    return {
      key: ordered.map((item) => `${item.abilityId}:${item.occurrenceIndex}`).join('+'),
      timeMs: totalImpact > 0
        ? Math.round(group.reduce((sum, item) => sum + item.timeMs * Math.max(0, item.impactScore), 0) / totalImpact)
        : Math.round(median(group.map((item) => item.timeMs))),
      impactScore: totalImpact,
      priority: group.reduce<number | null>((max, item) => (item.priority == null ? max : Math.max(max ?? 0, item.priority)), null),
      occurrences: ordered,
    };
  });
}
