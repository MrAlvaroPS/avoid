import type { PullEvidenceRef } from './models/night-player-audit';

function assertBossPullNumber(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`bossPullNumber must be a positive integer, got ${value}`);
  }
}

/** Lenguaje humano canónico para un pull en toda la aplicación. */
export function pullEvidenceLabel(ref: Pick<PullEvidenceRef, 'bossName' | 'bossPullNumber'>): string {
  assertBossPullNumber(ref.bossPullNumber);
  return `${ref.bossName} · Pull #${ref.bossPullNumber}`;
}

/** CTA contextualizado; nunca expone fightId como nombre del intento. */
export function pullWclLabel(ref: Pick<PullEvidenceRef, 'bossName' | 'bossPullNumber'>): string {
  return `${pullEvidenceLabel(ref)} · WCL`;
}

/**
 * Identidad estable para joins del dossier. fightId no participa porque es un
 * locator externo; pullId es la identidad interna inequívoca del intento.
 */
export function pullEvidenceKey(ref: Pick<PullEvidenceRef, 'reportCode' | 'pullId'>): string {
  return `${ref.reportCode}:${ref.pullId}`;
}
