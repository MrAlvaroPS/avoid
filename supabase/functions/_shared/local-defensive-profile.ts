export interface LocalDefensiveEvidence {
  abilityId: number;
  damageSamples: number[];
  unmitigatedEstimateSamples: number[];
  maxHealthPctSamples: number[];
  playerHitCountSamples: number[];
  deathCount: number;
  nearDeathCount: number;
  samplePullCount: number;
}

export interface LocalDefensiveMetrics {
  raidImpactScore: number | null;
  individualLethalityScore: number;
}

export function finiteNumber(value: unknown): number | null {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function positiveAbilityId(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed != null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function calculateLocalDefensiveMetrics(evidence: LocalDefensiveEvidence): LocalDefensiveMetrics {
  const damageBasis = evidence.unmitigatedEstimateSamples.length
    ? evidence.unmitigatedEstimateSamples
    : evidence.damageSamples;
  const medianDamage = median(damageBasis);
  const medianPlayersHit = median(evidence.playerHitCountSamples);
  const samplePulls = Math.max(evidence.samplePullCount, 1);

  return {
    raidImpactScore: medianDamage == null ? null : medianDamage * (medianPlayersHit ?? 1),
    individualLethalityScore:
      (percentile(evidence.maxHealthPctSamples, 0.9) ?? 0) +
      Math.min(100, (evidence.deathCount / samplePulls) * 100) +
      Math.min(50, (evidence.nearDeathCount / samplePulls) * 50),
  };
}

export function rankLocalDefensivePriorities(
  entries: { abilityId: number; raidImpactScore: number | null; individualLethalityScore: number | null }[],
): Map<number, number> {
  const maxRaidImpact = Math.max(0, ...entries.map((entry) => entry.raidImpactScore ?? 0));
  const maxLethality = Math.max(0, ...entries.map((entry) => entry.individualLethalityScore ?? 0));
  const ranked = entries
    .map((entry) => ({
      entry,
      score:
        (maxRaidImpact > 0 ? ((entry.raidImpactScore ?? 0) / maxRaidImpact) * 0.45 : 0) +
        (maxLethality > 0 ? ((entry.individualLethalityScore ?? 0) / maxLethality) * 0.55 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.entry.abilityId - right.entry.abilityId);

  return new Map(
    ranked.map(({ entry }, index) => [
      entry.abilityId,
      Math.max(1, 5 - Math.floor((index / Math.max(ranked.length, 1)) * 5)),
    ]),
  );
}
