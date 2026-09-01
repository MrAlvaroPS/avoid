export type DefensiveReanalysisHealth = 'healthy' | 'running' | 'failed';

export interface DefensiveReanalysisQueueCounts {
  queued: number;
  running: number;
  retryableErrors: number;
  blockedErrors: number;
}

/**
 * Contrato único de salud de la cola. Un error conserva prioridad sobre el
 * trabajo activo para que un batch parcialmente fallido nunca parezca sano.
 * `unreachable` se resuelve en el cliente porque significa que este contrato
 * no pudo consultarse (función, red o migración ausente).
 */
export function defensiveReanalysisHealth(
  counts: DefensiveReanalysisQueueCounts,
): DefensiveReanalysisHealth {
  if (counts.retryableErrors > 0 || counts.blockedErrors > 0) return 'failed';
  if (counts.queued > 0 || counts.running > 0) return 'running';
  return 'healthy';
}
