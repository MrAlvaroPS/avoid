import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import type {
  EvaluationConfidence,
  MechanicOccurrenceEvaluationContract,
  MechanicPolicyContract,
  PullEvaluationContextContract,
} from '../_shared/combat-evaluation-contract.ts';
import {
  EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION,
  resolveEventBackedMechanicOccurrences,
  type EventBackedMechanicEvent,
  type MechanicAliasForOccurrence,
} from '../_shared/mechanic-occurrence-event-resolver.ts';

interface Body {
  pullId?: unknown;
  contextResolverVersion?: unknown;
}

function rowToOccurrence(row: Record<string, unknown>): MechanicOccurrenceEvaluationContract {
  return {
    id: row['id'] as string,
    pullId: row['pull_id'] as string,
    bossId: row['boss_id'] as string,
    difficulty: row['difficulty'] as string,
    mechanicKey: row['mechanic_key'] as string,
    occurrenceIndex: row['occurrence_index'] as number,
    startMs: row['start_ms'] as number,
    resolveMs: row['resolve_ms'] as number,
    endMs: row['end_ms'] as number,
    targetActorIds: (row['target_actor_ids'] as number[]) || [],
    outcome: row['outcome'] as MechanicOccurrenceEvaluationContract['outcome'],
    failureMode: row['failure_mode'] as string | null,
    evidence: row['evidence'] as Record<string, unknown>,
    confidence: row['confidence'] as EvaluationConfidence,
    policyVersion: row['policy_version'] as number,
    contextResolverVersion: row['context_resolver_version'] as string,
    occurrenceResolverVersion: row['occurrence_resolver_version'] as string,
  };
}

function rowToPolicy(row: Record<string, unknown>): MechanicPolicyContract {
  return {
    bossId: row['boss_id'] as string,
    difficulty: row['difficulty'] as string,
    mechanicKey: row['mechanic_key'] as string,
    policyVersion: row['policy_version'] as number,
    displayCategory: row['display_category'] as string | null,
    targetingMode: row['targeting_mode'] as MechanicPolicyContract['targetingMode'],
    requiredResponse: row['required_response'] as string | null,
    responsibilityMode: row['responsibility_mode'] as MechanicPolicyContract['responsibilityMode'],
    damageSemantics: row['damage_semantics'] as MechanicPolicyContract['damageSemantics'],
    failurePropagation: row['failure_propagation'] as MechanicPolicyContract['failurePropagation'],
    assignmentMode: row['assignment_mode'] as MechanicPolicyContract['assignmentMode'],
    defensiveExpectation: row['defensive_expectation'] as MechanicPolicyContract['defensiveExpectation'],
    creditScope: row['credit_scope'] as MechanicPolicyContract['creditScope'],
    penaltyScope: row['penalty_scope'] as MechanicPolicyContract['penaltyScope'],
    causalRule: (row['causal_rule'] as Record<string, unknown>) ?? {},
    confidence: row['confidence'] as EvaluationConfidence,
  };
}

function rowToContext(row: Record<string, unknown>): PullEvaluationContextContract {
  return {
    pullId: row['pull_id'] as string,
    evaluationEligible: row['evaluation_eligible'] as boolean,
    evaluationStartMs: row['evaluation_start_ms'] as number,
    evaluationEndMs: row['evaluation_end_ms'] as number,
    cutoffReason: row['cutoff_reason'] as PullEvaluationContextContract['cutoffReason'],
    wipeCallAtMs: row['wipe_call_at_ms'] as number | null,
    wipeCallBossHpPct: row['wipe_call_boss_hp_pct'] as number | null,
    wipeCallSource: row['wipe_call_source'] as PullEvaluationContextContract['wipeCallSource'],
    wipeCallConfidence: row['wipe_call_confidence'] as number | null,
    wipeCallVerified: row['wipe_call_verified'] as boolean,
    ninjaStatus: row['ninja_status'] as PullEvaluationContextContract['ninjaStatus'],
    ninjaSource: row['ninja_source'] as PullEvaluationContextContract['ninjaSource'],
    ninjaConfidence: row['ninja_confidence'] as number | null,
    evidence: (row['evidence'] as Record<string, unknown>) ?? {},
    resolverVersion: row['resolver_version'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido.' }, 400);
  }

  if (typeof body.pullId !== 'string' || !body.pullId) {
    return jsonResponse({ ok: false, error: 'pullId es obligatorio.' }, 400);
  }
  if (typeof body.contextResolverVersion !== 'string' || !body.contextResolverVersion) {
    return jsonResponse({ ok: false, error: 'contextResolverVersion es obligatorio.' }, 400);
  }

  try {
    const client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const [{ data: contextData, error: contextErr }, { data: pullData, error: pullErr }] =
      await Promise.all([
        client.from('pull_evaluation_context').select('*').eq('pull_id', body.pullId).single(),
        client
          .from('pulls')
          .select('id,boss_id,difficulty,ingestion_status')
          .eq('id', body.pullId)
          .single(),
      ]);

    if (contextErr || !contextData) {
      return jsonResponse(
        { ok: false, error: `No se encontró evaluación de contexto para pull ${body.pullId}` },
        404,
      );
    }
    if (pullErr || !pullData) {
      return jsonResponse({ ok: false, error: `No se encontró pull ${body.pullId}` }, 404);
    }
    if ((pullData as Record<string, unknown>)['ingestion_status'] !== 'complete') {
      return jsonResponse({ ok: false, error: 'El pull no tiene ingesta completa.' }, 400);
    }

    const context = rowToContext(contextData as Record<string, unknown>);
    if (!context.evaluationEligible) {
      return jsonResponse(
        { ok: false, error: 'El pull no es evaluable (evaluation_eligible=false).' },
        400,
      );
    }
    if (context.resolverVersion !== body.contextResolverVersion) {
      return jsonResponse(
        {
          ok: false,
          error: `contextResolverVersion no coincide con el contexto persistido (${context.resolverVersion}).`,
        },
        409,
      );
    }

    const pull = pullData as { id: string; boss_id: string; difficulty: string };

    const [policyResult, aliasResult, eventResult] = await Promise.all([
      client
        .from('boss_mechanic_policy')
        .select('*')
        .eq('boss_id', pull.boss_id)
        .eq('difficulty', pull.difficulty),
      client
        .from('boss_mechanic_aliases')
        .select('ability_id,mechanic_key,confidence,active')
        .eq('boss_id', pull.boss_id)
        .eq('difficulty', pull.difficulty)
        .eq('active', true)
        .not('ability_id', 'is', null),
      // The applicable view is the canonical difficulty-filtered event population.
      // Identity is resolved through active aliases because historical event rows
      // legitimately have mechanic_key=null.
      client
        .from('applicable_pull_mechanic_events')
        .select(
          'id,pull_id,ability_id,mechanic_name,category,responsibility,trigger_time_ms,outcome,players_hit_names,player_hit_details,comparison_source,comparison_percentile,phase_id',
        )
        .eq('pull_id', body.pullId)
        .order('trigger_time_ms', { ascending: true })
        .order('id', { ascending: true }),
    ]);

    if (policyResult.error) throw policyResult.error;
    if (aliasResult.error) throw aliasResult.error;
    if (eventResult.error) throw eventResult.error;

    const policies = ((policyResult.data ?? []) as Record<string, unknown>[]).map(rowToPolicy);
    const aliases: MechanicAliasForOccurrence[] = ((aliasResult.data ?? []) as Record<string, unknown>[])
      .filter((row) => typeof row['ability_id'] === 'number' && typeof row['mechanic_key'] === 'string')
      .map((row) => ({
        abilityId: row['ability_id'] as number,
        mechanicKey: row['mechanic_key'] as string,
        confidence: row['confidence'] as EvaluationConfidence,
      }));

    const events: EventBackedMechanicEvent[] = ((eventResult.data ?? []) as Record<string, unknown>[]).map(
      (row) => ({
        id: row['id'] as string,
        pullId: row['pull_id'] as string,
        abilityId: row['ability_id'] as number,
        mechanicName: row['mechanic_name'] as string,
        mechanicKey: null,
        category: row['category'] as string | null,
        responsibility: row['responsibility'] as string | null,
        triggerTimeMs: row['trigger_time_ms'] as number,
        outcome: row['outcome'] as EventBackedMechanicEvent['outcome'],
        playersHitNames: (row['players_hit_names'] as string[]) ?? [],
        playerHitDetails: (row['player_hit_details'] as Array<Record<string, unknown>>) ?? [],
        comparisonSource: row['comparison_source'] as string | null,
        comparisonPercentile: row['comparison_percentile'] as number | null,
        phaseId: row['phase_id'] as number | null,
      }),
    );

    const resolution = resolveEventBackedMechanicOccurrences({
      pullId: pull.id,
      bossId: pull.boss_id,
      difficulty: pull.difficulty,
      context,
      events,
      aliases,
      policies,
    });

    const rows = resolution.occurrences.map((occurrence) => ({
      pull_id: occurrence.pullId,
      boss_id: occurrence.bossId,
      difficulty: occurrence.difficulty,
      mechanic_key: occurrence.mechanicKey,
      occurrence_index: occurrence.occurrenceIndex,
      start_ms: occurrence.startMs,
      resolve_ms: occurrence.resolveMs,
      end_ms: occurrence.endMs,
      phase_id: occurrence.phaseId,
      target_actor_ids: occurrence.targetActorIds,
      assignment_snapshot: {},
      outcome: occurrence.outcome,
      failure_mode: occurrence.failureMode,
      evidence: occurrence.evidence,
      confidence: occurrence.confidence,
      policy_version: occurrence.policyVersion,
      context_resolver_version: occurrence.contextResolverVersion,
      occurrence_resolver_version: occurrence.occurrenceResolverVersion,
      created_by: guard.userId,
      evaluated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    let result: MechanicOccurrenceEvaluationContract[] = [];
    if (rows.length > 0) {
      const { data: inserted, error: upsertErr } = await client
        .from('mechanic_occurrence_evaluations')
        .upsert(rows, {
          onConflict: 'pull_id,mechanic_key,occurrence_index,occurrence_resolver_version',
          ignoreDuplicates: false,
        })
        .select('*');
      if (upsertErr) throw upsertErr;
      result = ((inserted ?? []) as Record<string, unknown>[]).map(rowToOccurrence);
    }

    return jsonResponse({
      ok: true,
      action: 'evaluate_mechanic_occurrences',
      pullId: body.pullId,
      bossId: pull.boss_id,
      difficulty: pull.difficulty,
      resolverVersion: EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION,
      sourceEventCount: resolution.sourceEventCount,
      occurrencesCreated: result.length,
      mapping: {
        mappedEventCount: resolution.mappedEventCount,
        unmappedEventCount: resolution.unmappedEventIds.length,
        missingPolicyEventCount: resolution.missingPolicyEventIds.length,
        outOfScopeEventCount: resolution.outOfScopeEventIds.length,
      },
      unmappedEventIds: resolution.unmappedEventIds,
      missingPolicyEventIds: resolution.missingPolicyEventIds,
      occurrences: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('evaluate-mechanic-occurrences error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
