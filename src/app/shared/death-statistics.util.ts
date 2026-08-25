import type { PlayerPullRecordRow, PullMechanicEventRow, PullRow } from './models/domain';

/** Razones por las que una muerte se muestra como contexto pero no evalúa al jugador. */
export type DeathStatisticalExclusionReason = 'boss_melee_on_non_tank';

export function hasIntrinsicDeathExclusion(record: Pick<PlayerPullRecordRow, 'death_cause'>): boolean {
  return record.death_cause?.statisticalExclusionReason === 'boss_melee_on_non_tank';
}

/**
 * Una muerte de wipe call depende del toggle del pull; un Melee del boss a
 * un no-tank nunca es una oportunidad defensiva atribuible a ese jugador.
 */
export function isDeathExcludedFromStatistics(
  pull: Pick<PullRow, 'wipe_call_excluded'>,
  record: Pick<PlayerPullRecordRow, 'wipe_call_cluster' | 'death_cause'>,
): boolean {
  return hasIntrinsicDeathExclusion(record) || (record.wipe_call_cluster && pull.wipe_call_excluded);
}

export function wipeCallStartMs(pull: Pick<PullRow, 'wipe_call_excluded' | 'wipe_call_signals'>): number | null {
  if (!pull.wipe_call_excluded) return null;
  const raw = pull.wipe_call_signals?.['wipeCallStartMs'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** Solo deja fuera las mecánicas ocurridas después del límite, nunca el pull entero. */
export function isMechanicExcludedByWipeCall(
  pull: Pick<PullRow, 'wipe_call_excluded' | 'wipe_call_signals'>,
  event: Pick<PullMechanicEventRow, 'trigger_time_ms'>,
): boolean {
  const startMs = wipeCallStartMs(pull);
  return startMs != null && event.trigger_time_ms >= startMs;
}

