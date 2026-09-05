import type { PullEvaluationContextContract } from './combat-evaluation-contract.ts';
import {
  actionReason,
  applyPullEvaluationAction,
  type PullContextFacts,
  type PullEvaluationContextAction,
} from './pull-evaluation-context.ts';

interface QueryResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface PullContextCommandClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        maybeSingle(): PromiseLike<QueryResult<Record<string, unknown>>>;
      };
    };
  };
  rpc(name: string, params: Record<string, unknown>): PromiseLike<QueryResult<Record<string, unknown>>>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function contextFromRow(row: Record<string, unknown>): PullEvaluationContextContract {
  return {
    pullId: String(row['pull_id']),
    evaluationEligible: Boolean(row['evaluation_eligible']),
    evaluationStartMs: Number(row['evaluation_start_ms']),
    evaluationEndMs: Number(row['evaluation_end_ms']),
    cutoffReason: row['cutoff_reason'] as PullEvaluationContextContract['cutoffReason'],
    wipeCallAtMs: numberOrNull(row['wipe_call_at_ms']),
    wipeCallBossHpPct: numberOrNull(row['wipe_call_boss_hp_pct']),
    wipeCallSource: row['wipe_call_source'] as PullEvaluationContextContract['wipeCallSource'],
    wipeCallConfidence: numberOrNull(row['wipe_call_confidence']),
    wipeCallVerified: Boolean(row['wipe_call_verified']),
    ninjaStatus: row['ninja_status'] as PullEvaluationContextContract['ninjaStatus'],
    ninjaSource: row['ninja_source'] as PullEvaluationContextContract['ninjaSource'],
    ninjaConfidence: numberOrNull(row['ninja_confidence']),
    evidence: objectOrEmpty(row['evidence']),
    resolverVersion: String(row['resolver_version']),
    updatedAt: String(row['updated_at']),
  };
}

export async function executePullEvaluationCommand(
  client: PullContextCommandClient,
  pullId: string,
  action: PullEvaluationContextAction,
  changedBy: string,
): Promise<{ context: PullEvaluationContextContract; before: PullEvaluationContextContract | null }> {
  const { data: pull, error: pullError } = await client
    .from('pulls')
    .select('id,duration_ms,wipe_call_confidence,wipe_call_signals,ninja_pull_signals')
    .eq('id', pullId)
    .maybeSingle();
  if (pullError) throw new Error(pullError.message);
  if (!pull) throw new Error(`Pull ${pullId} no encontrado.`);

  const { data: contextRow, error: contextError } = await client
    .from('pull_evaluation_context')
    .select('*')
    .eq('pull_id', pullId)
    .maybeSingle();
  if (contextError) throw new Error(contextError.message);

  const wipeSignals = objectOrEmpty(pull['wipe_call_signals']);
  const wipeBoundary = numberOrNull(wipeSignals['wipeCallStartMs']);
  const ninjaSignals = objectOrEmpty(pull['ninja_pull_signals']);
  const facts: PullContextFacts = {
    pullId,
    durationMs: Math.max(0, Math.trunc(numberOrNull(pull['duration_ms']) ?? 0)),
    bossHpAtBoundaryPct: null,
    inferredWipeCandidate:
      wipeBoundary == null
        ? null
        : { boundaryMs: wipeBoundary, confidence: numberOrNull(pull['wipe_call_confidence']), evidence: wipeSignals },
    ninjaCandidate:
      Object.keys(ninjaSignals).length === 0
        ? null
        : { confidence: numberOrNull(ninjaSignals['confidence']), evidence: ninjaSignals },
  };
  const before = contextRow ? contextFromRow(contextRow) : null;
  const next = applyPullEvaluationAction(before, facts, action);

  const { data, error } = await client.rpc('set_pull_evaluation_context_v2', {
    p_pull_id: pullId,
    p_evaluation_eligible: next.evaluationEligible,
    p_evaluation_start_ms: next.evaluationStartMs,
    p_evaluation_end_ms: next.evaluationEndMs,
    p_cutoff_reason: next.cutoffReason,
    p_wipe_call_at_ms: next.wipeCallAtMs,
    p_wipe_call_boss_hp_pct: next.wipeCallBossHpPct,
    p_wipe_call_source: next.wipeCallSource,
    p_wipe_call_confidence: next.wipeCallConfidence,
    p_wipe_call_verified: next.wipeCallVerified,
    p_ninja_status: next.ninjaStatus,
    p_ninja_source: next.ninjaSource,
    p_ninja_confidence: next.ninjaConfidence,
    p_evidence: next.evidence,
    p_resolver_version: next.resolverVersion,
    p_reason: actionReason(action),
    p_changed_by: changedBy,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('La RPC no devolvió el contexto actualizado.');
  return { context: contextFromRow(data), before };
}
