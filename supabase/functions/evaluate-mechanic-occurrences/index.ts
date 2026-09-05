import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import type { MechanicOccurrenceEvaluationContract, MechanicPolicyContract } from '../_shared/combat-evaluation-contract.ts';

interface Body {
  pullId?: unknown;
  policyVersion?: unknown;
  contextResolverVersion?: unknown;
}

const OCCURRENCE_RESOLVER_VERSION = 'mechanic-occurrence-resolver@1.0.0';

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
    outcome: row['outcome'] as any,
    failureMode: row['failure_mode'] as string | null,
    evidence: row['evidence'] as Record<string, unknown>,
    confidence: row['confidence'] as any,
    policyVersion: row['policy_version'] as number,
    contextResolverVersion: row['context_resolver_version'] as string,
    occurrenceResolverVersion: row['occurrence_resolver_version'] as string,
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
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Leer pull_evaluation_context para autoridad
    const { data: contextData, error: contextErr } = await client
      .from('pull_evaluation_context')
      .select('*')
      .eq('pull_id', body.pullId)
      .single();

    if (contextErr || !contextData) {
      return jsonResponse(
        { ok: false, error: `No se encontró evaluación de contexto para pull ${body.pullId}` },
        404,
      );
    }

    const pullContext = contextData as any;

    // Verificar que el evaluator es válido
    if (!pullContext.evaluation_eligible) {
      return jsonResponse(
        { ok: false, error: 'El pull no es evaluable (evaluation_eligible=false)' },
        400,
      );
    }

    // Leer pulls para obtener boss_id, difficulty, warcraftlogs_id
    const { data: pullData, error: pullErr } = await client
      .from('pulls')
      .select('*')
      .eq('id', body.pullId)
      .single();

    if (pullErr || !pullData) {
      return jsonResponse({ ok: false, error: `No se encontró pull ${body.pullId}` }, 404);
    }

    const pull = pullData as any;

    // Leer boss_mechanic_policy para este boss + difficulty
    const { data: policies, error: policyErr } = await client
      .from('boss_mechanic_policy')
      .select('*')
      .eq('boss_id', pull.boss_id)
      .eq('difficulty', pull.difficulty);

    if (policyErr) throw policyErr;

    if (!policies || policies.length === 0) {
      return jsonResponse(
        {
          ok: false,
          error: `No se encontró policy para ${pull.boss_id}/${pull.difficulty}`,
        },
        400,
      );
    }

    // Por ahora, crear un placeholder de ocurrencias
    // (En producción, se correlacionaría con WCL events, ability timings, etc.)
    // Esta es una versión simplificada que marca toda la duración evaluable como éxito por defecto

    const evaluationStartMs = pullContext.evaluation_start_ms;
    const evaluationEndMs = pullContext.evaluation_end_ms;

    const occurrencesToInsert: any[] = [];

    // Crear una ocurrencia por cada mechanic_key en la policy.
    // M13 reserva índices positivos para que 0 nunca se confunda con ausencia.
    for (const policyRow of policies) {
      const policyContract = policyRow as MechanicPolicyContract;

      occurrencesToInsert.push({
        pull_id: body.pullId,
        boss_id: pull.boss_id,
        difficulty: pull.difficulty,
        mechanic_key: policyContract.mechanicKey,
        occurrence_index: 1, // Simplificado
        start_ms: evaluationStartMs,
        resolve_ms: evaluationEndMs,
        end_ms: evaluationEndMs,
        target_actor_ids: [],
        outcome: 'not_evaluable', // Sin datos WCL, no evaluable
        failure_mode: null,
        evidence: { source: 'placeholder', reason: 'WCL events not analyzed yet' },
        confidence: 'uncertain',
        policy_version: policyContract.policyVersion,
        context_resolver_version: body.contextResolverVersion,
        occurrence_resolver_version: OCCURRENCE_RESOLVER_VERSION,
        created_by: guard.userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    // UPSERT occurrences
    const { data: inserted, error: upsertErr } = await client
      .from('mechanic_occurrence_evaluations')
      .upsert(occurrencesToInsert, {
        onConflict: 'pull_id,mechanic_key,occurrence_index,occurrence_resolver_version',
        ignoreDuplicates: false,
      })
      .select('*');

    if (upsertErr) throw upsertErr;

    const result = (inserted as Record<string, unknown>[] | null)?.map((row) => rowToOccurrence(row)) || [];

    return jsonResponse({
      ok: true,
      action: 'evaluate_mechanic_occurrences',
      pullId: body.pullId,
      bossId: pull.boss_id,
      difficulty: pull.difficulty,
      occurrencesCreated: result.length,
      resolverVersion: OCCURRENCE_RESOLVER_VERSION,
      occurrences: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('evaluate-mechanic-occurrences error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
