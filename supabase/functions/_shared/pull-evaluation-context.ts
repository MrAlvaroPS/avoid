// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import { PULL_CONTEXT_RESOLVER_VERSION, type NinjaStatus, type PullEvaluationContextContract } from './combat-evaluation-contract.ts';

export const PULL_CONTEXT_COMMAND_VERSION = `${PULL_CONTEXT_RESOLVER_VERSION}:commands-v3`;

export type PullEvaluationContextAction =
  | { action: 'confirm_wipe'; boundaryMs: number; reason?: string }
  | { action: 'clear_wipe'; reason?: string }
  | { action: 'move_wipe_boundary'; boundaryMs: number; reason?: string }
  | { action: 'accept_inferred_wipe'; reason?: string }
  | { action: 'confirm_ninja'; reason?: string }
  | { action: 'mark_valid'; reason?: string }
  | { action: 'mark_probable_ninja'; reason?: string }
  | {
      action: 'override_context';
      evaluationEligible: boolean;
      evaluationStartMs: number;
      evaluationEndMs: number;
      wipeCallAtMs: number | null;
      wipeCallVerified: boolean;
      ninjaConfirmed: boolean;
      reason?: string;
    };

export interface PullContextFacts {
  pullId: string;
  durationMs: number;
  bossHpAtBoundaryPct?: number | null;
  inferredWipeCandidate?: { boundaryMs: number; confidence: number | null; evidence?: Record<string, unknown> } | null;
  /**
   * `ninjaCandidate` no es una sospecha genérica: solo existe después de que
   * detectNinjaPull haya superado su contrato estricto (no kill, <45 s y
   * apenas engagement o apenas daño al boss). Por eso sí es una decisión
   * automática de validez estadística. La evidencia cruda se conserva para
   * auditoría y un RL siempre puede restaurar el pull con `mark_valid`.
   */
  ninjaCandidate?: { confidence: number | null; evidence?: Record<string, unknown> } | null;
}

function finiteBoundary(value: number, durationMs: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > durationMs) {
    throw new Error(`boundaryMs debe ser un entero entre 0 y ${durationMs}.`);
  }
  return value;
}

export function initialPullEvaluationContext(facts: PullContextFacts, now = new Date().toISOString()): PullEvaluationContextContract {
  const autoConfirmedNinja = Boolean(facts.ninjaCandidate);
  const ninjaStatus: NinjaStatus = autoConfirmedNinja ? 'confirmed' : 'valid';
  return {
    pullId: facts.pullId,
    evaluationEligible: !autoConfirmedNinja,
    evaluationStartMs: 0,
    evaluationEndMs: facts.durationMs,
    cutoffReason: autoConfirmedNinja ? 'invalid_pull' : 'fight_end',
    wipeCallAtMs: null,
    wipeCallBossHpPct: null,
    wipeCallSource: 'none',
    wipeCallConfidence: null,
    wipeCallVerified: false,
    ninjaStatus,
    ninjaSource: autoConfirmedNinja ? 'heuristic' : 'imported',
    ninjaConfidence: facts.ninjaCandidate?.confidence ?? null,
    evidence: {
      ...(facts.inferredWipeCandidate ? { wipeCallCandidate: facts.inferredWipeCandidate } : {}),
      ...(facts.ninjaCandidate ? { ninjaPullCandidate: facts.ninjaCandidate } : {}),
    },
    resolverVersion: PULL_CONTEXT_COMMAND_VERSION,
    updatedAt: now,
  };
}

/**
 * Único reductor de decisiones autoritativas del bloque B.
 *
 * Los candidatos de wipe siguen siendo no autoritativos hasta una acción
 * explícita. `ninjaCandidate`, en cambio, ya es la salida del detector
 * estricto de pull inválido y nace auto-confirmado para que nunca contamine
 * denominadores. Toda acción manual (`mark_valid`, `confirm_ninja`,
 * `mark_probable_ninja`) cambia `ninjaSource` a `manual`; la capa SQL impide
 * que una escritura heurística posterior pueda pisarla.
 */
export function applyPullEvaluationAction(
  current: PullEvaluationContextContract | null,
  facts: PullContextFacts,
  action: PullEvaluationContextAction,
  now = new Date().toISOString(),
): PullEvaluationContextContract {
  if (!Number.isInteger(facts.durationMs) || facts.durationMs < 0) throw new Error('La duración del pull no es válida.');
  const base = current ?? initialPullEvaluationContext(facts, now);
  const next: PullEvaluationContextContract = {
    ...base,
    pullId: facts.pullId,
    evidence: { ...base.evidence },
    resolverVersion: PULL_CONTEXT_COMMAND_VERSION,
    updatedAt: now,
  };

  if (action.action === 'confirm_wipe' || action.action === 'move_wipe_boundary') {
    if (base.ninjaStatus === 'confirmed') throw new Error('Restaura primero el pull confirmado como ninja.');
    const boundaryMs = finiteBoundary(action.boundaryMs, facts.durationMs);
    return {
      ...next,
      evaluationEligible: true,
      evaluationStartMs: 0,
      evaluationEndMs: boundaryMs,
      cutoffReason: 'wipe_call',
      wipeCallAtMs: boundaryMs,
      wipeCallBossHpPct: facts.bossHpAtBoundaryPct ?? null,
      wipeCallSource: 'manual_rl',
      wipeCallConfidence: 100,
      wipeCallVerified: true,
    };
  }

  if (action.action === 'accept_inferred_wipe') {
    if (base.ninjaStatus === 'confirmed') throw new Error('Restaura primero el pull confirmado como ninja.');
    const candidate = facts.inferredWipeCandidate ?? candidateFromEvidence(base.evidence);
    if (!candidate) throw new Error('No hay candidato inferido que aceptar.');
    const boundaryMs = finiteBoundary(candidate.boundaryMs, facts.durationMs);
    return {
      ...next,
      evaluationEligible: true,
      evaluationStartMs: 0,
      evaluationEndMs: boundaryMs,
      cutoffReason: 'wipe_call',
      wipeCallAtMs: boundaryMs,
      wipeCallBossHpPct: facts.bossHpAtBoundaryPct ?? null,
      wipeCallSource: 'manual_rl',
      wipeCallConfidence: candidate.confidence,
      wipeCallVerified: true,
      evidence: { ...next.evidence, wipeCallCandidate: candidate },
    };
  }

  if (action.action === 'clear_wipe') {
    return {
      ...next,
      evaluationEligible: base.ninjaStatus !== 'confirmed',
      evaluationStartMs: 0,
      evaluationEndMs: facts.durationMs,
      cutoffReason: base.ninjaStatus === 'confirmed' ? 'invalid_pull' : 'fight_end',
      wipeCallAtMs: null,
      wipeCallBossHpPct: null,
      wipeCallSource: 'none',
      wipeCallConfidence: null,
      wipeCallVerified: false,
    };
  }

  if (action.action === 'confirm_ninja') {
    return {
      ...next,
      evaluationEligible: false,
      evaluationStartMs: 0,
      evaluationEndMs: facts.durationMs,
      cutoffReason: 'invalid_pull',
      wipeCallAtMs: null,
      wipeCallBossHpPct: null,
      wipeCallSource: 'none',
      wipeCallConfidence: null,
      wipeCallVerified: false,
      ninjaStatus: 'confirmed',
      ninjaSource: 'manual',
      ninjaConfidence: 100,
    };
  }

  if (action.action === 'override_context') {
    const evaluationStartMs = finiteBoundary(action.evaluationStartMs, facts.durationMs);
    const evaluationEndMs = finiteBoundary(action.evaluationEndMs, facts.durationMs);
    if (evaluationEndMs < evaluationStartMs) throw new Error('evaluationEndMs no puede ser anterior al inicio.');
    if (action.wipeCallAtMs != null && (action.wipeCallAtMs < evaluationStartMs || action.wipeCallAtMs > evaluationEndMs)) {
      throw new Error('wipeCallAtMs debe estar dentro del intervalo evaluable.');
    }
    if (action.ninjaConfirmed) {
      return {
        ...next,
        evaluationEligible: false,
        evaluationStartMs,
        evaluationEndMs,
        cutoffReason: 'invalid_pull',
        wipeCallAtMs: null,
        wipeCallBossHpPct: null,
        wipeCallSource: 'none',
        wipeCallConfidence: null,
        wipeCallVerified: false,
        ninjaStatus: 'confirmed',
        ninjaSource: 'manual',
        ninjaConfidence: 100,
      };
    }
    const wipeCallAtMs = action.wipeCallAtMs;
    return {
      ...next,
      evaluationEligible: action.evaluationEligible,
      evaluationStartMs,
      evaluationEndMs,
      cutoffReason: wipeCallAtMs == null ? 'fight_end' : 'wipe_call',
      wipeCallAtMs,
      wipeCallBossHpPct: wipeCallAtMs == null ? null : facts.bossHpAtBoundaryPct ?? null,
      wipeCallSource: wipeCallAtMs == null ? 'none' : 'manual_rl',
      wipeCallConfidence: wipeCallAtMs == null ? null : 100,
      wipeCallVerified: wipeCallAtMs != null && action.wipeCallVerified,
      ninjaStatus: 'valid',
      ninjaSource: 'manual',
      ninjaConfidence: 100,
    };
  }

  const probable = action.action === 'mark_probable_ninja';
  return {
    ...next,
    evaluationEligible: true,
    evaluationStartMs: 0,
    evaluationEndMs: base.wipeCallAtMs ?? facts.durationMs,
    cutoffReason: base.wipeCallAtMs == null ? 'fight_end' : 'wipe_call',
    ninjaStatus: probable ? 'probable' : 'valid',
    ninjaSource: 'manual',
    ninjaConfidence: probable ? (facts.ninjaCandidate?.confidence ?? base.ninjaConfidence) : 100,
  };
}

export function candidateFromEvidence(evidence: Record<string, unknown>): PullContextFacts['inferredWipeCandidate'] {
  const raw = evidence['wipeCallCandidate'];
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate['boundaryMs'] !== 'number') return null;
  return {
    boundaryMs: candidate['boundaryMs'],
    confidence: typeof candidate['confidence'] === 'number' ? candidate['confidence'] : null,
    evidence: candidate['evidence'] && typeof candidate['evidence'] === 'object' ? (candidate['evidence'] as Record<string, unknown>) : undefined,
  };
}

export function actionReason(action: PullEvaluationContextAction): string {
  const reason = action.reason?.trim();
  if (reason) return reason;
  const defaults: Record<PullEvaluationContextAction['action'], string> = {
    confirm_wipe: 'Wipe call confirmado manualmente por raid leader.',
    clear_wipe: 'Candidato de wipe call rechazado manualmente.',
    move_wipe_boundary: 'Límite de wipe call corregido manualmente.',
    accept_inferred_wipe: 'Candidato inferido de wipe call aceptado manualmente.',
    confirm_ninja: 'Pull confirmado manualmente como ninja.',
    mark_valid: 'Pull restaurado manualmente como intento válido.',
    mark_probable_ninja: 'Pull marcado para revisión como probable ninja.',
    override_context: 'Contexto de evaluación corregido manualmente.',
  };
  return defaults[action.action];
}
