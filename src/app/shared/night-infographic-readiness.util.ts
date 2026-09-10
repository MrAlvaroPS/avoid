export interface NightInfographicSummaryReadinessInput {
  playerName: string;
  pulls: unknown[];
  nightScore: number | null;
  nightReliability: unknown | null;
  canonicalDefensive: {
    state: string;
    coverage: { evaluatedPulls: number; expectedPulls: number };
    generation: { id: string } | null;
  };
  defensiveAudit?: {
    state: string;
    metadata: { evaluatedPulls: number; expectedPulls: number };
  };
}

/**
 * Final player-level gate used after the report-level queues are complete.
 * KPI values may legitimately be null when there is no evaluable opportunity;
 * freshness is proven by generation identity and complete pull coverage, not
 * by manufacturing a percentage.
 */
export function nightInfographicSummaryReadinessError(
  summary: NightInfographicSummaryReadinessInput,
): string | null {
  if (summary.pulls.length > 0 && summary.nightScore == null) {
    return `${summary.playerName}: la ejecución de la noche no está disponible.`;
  }
  if (summary.pulls.length > 0 && summary.nightReliability == null) {
    return `${summary.playerName}: la fiabilidad de la noche no está disponible.`;
  }

  const canonical = summary.canonicalDefensive;
  if (canonical.state !== 'available') {
    return `${summary.playerName}: defensivos canónicos en estado ${canonical.state}.`;
  }
  if (canonical.coverage.evaluatedPulls !== canonical.coverage.expectedPulls) {
    return `${summary.playerName}: cobertura defensiva incompleta (${canonical.coverage.evaluatedPulls}/${canonical.coverage.expectedPulls} pulls).`;
  }
  if (canonical.coverage.expectedPulls > 0 && !canonical.generation?.id) {
    return `${summary.playerName}: falta la generación defensiva publicada.`;
  }

  const audit = summary.defensiveAudit;
  if (!audit || audit.state !== 'available') {
    return `${summary.playerName}: la auditoría defensiva no está disponible.`;
  }
  if (audit.metadata.evaluatedPulls !== audit.metadata.expectedPulls) {
    return `${summary.playerName}: auditoría defensiva incompleta (${audit.metadata.evaluatedPulls}/${audit.metadata.expectedPulls} pulls).`;
  }
  return null;
}
