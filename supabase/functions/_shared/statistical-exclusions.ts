export interface PullExclusionState {
  wipe_call_excluded: boolean;
  wipe_call_signals?: Record<string, unknown> | null;
}

export interface DeathExclusionState {
  wipe_call_cluster: boolean;
  death_cause?: { statisticalExclusionReason?: string | null } | null;
}

export function isDeathExcludedFromStatistics(pull: PullExclusionState, record: DeathExclusionState): boolean {
  return (
    (record.wipe_call_cluster && pull.wipe_call_excluded) ||
    record.death_cause?.statisticalExclusionReason === 'boss_melee_on_non_tank'
  );
}

export function isMechanicExcludedByWipeCall(pull: PullExclusionState, triggerTimeMs: number): boolean {
  if (!pull.wipe_call_excluded) return false;
  const startMs = pull.wipe_call_signals?.['wipeCallStartMs'];
  return typeof startMs === 'number' && Number.isFinite(startMs) && triggerTimeMs >= startMs;
}

