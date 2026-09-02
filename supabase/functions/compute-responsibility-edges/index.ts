import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { resolveOccurrenceOwnership } from '../_shared/mechanic-occurrence-evaluator.ts';
import { buildResponsibilityEdges, deduplicateEdges } from '../_shared/responsibility-edge-builder.ts';
import type { MechanicOccurrenceEvaluationContract, MechanicPolicyContract, MechanicResponsibilityEdgeContract } from '../_shared/combat-evaluation-contract.ts';

interface Body {
  pullId?: unknown;
  occurrenceIds?: unknown;
}

function rowToEdge(row: Record<string, unknown>): MechanicResponsibilityEdgeContract {
  return {
    id: row['id'] as string,
    occurrenceId: row['occurrence_id'] as string,
    playerName: row['player_name'] as string,
    actorId: row['actor_id'] as number | null,
    relationship: row['relationship'] as any,
    damageCaused: row['damage_caused'] as number,
    damageTaken: row['damage_taken'] as number,
    victimCount: row['victim_count'] as number,
    creditEligible: row['credit_eligible'] as boolean,
    penaltyEligible: row['penalty_eligible'] as boolean,
    reasonCode: row['reason_code'] as any,
    confidence: row['confidence'] as any,
    evidence: row['evidence'] as Record<string, unknown>,
    createdAt: row['created_at'] as string,
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

  const pullId = typeof body.pullId === 'string' ? body.pullId : null;
  const occurrenceIds = Array.isArray(body.occurrenceIds) ? (body.occurrenceIds as string[]) : [];

  if (!pullId && occurrenceIds.length === 0) {
    return jsonResponse({ ok: false, error: 'Proporciona pullId u occurrenceIds.' }, 400);
  }

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Leer occurrences
    let query = client.from('mechanic_occurrence_evaluations').select('*');

    if (pullId) {
      query = query.eq('pull_id', pullId);
    } else if (occurrenceIds.length > 0) {
      query = query.in('id', occurrenceIds);
    }

    const { data: occurrencesData, error: occErr } = await query;

    if (occErr) throw occErr;

    if (!occurrencesData || occurrencesData.length === 0) {
      return jsonResponse(
        { ok: false, error: 'No se encontraron ocurrencias' },
        404,
      );
    }

    // Leer policies (usamos los primeros pull_id, boss_id, difficulty)
    const firstOcc = (occurrencesData[0] as any);
    const { data: policiesData, error: policyErr } = await client
      .from('boss_mechanic_policy')
      .select('*')
      .eq('boss_id', firstOcc.boss_id)
      .eq('difficulty', firstOcc.difficulty);

    if (policyErr) throw policyErr;

    const policyMap = new Map<string, MechanicPolicyContract>();
    (policiesData as any[] | null)?.forEach((row) => {
      policyMap.set(row.mechanic_key, {
        bossId: row.boss_id,
        difficulty: row.difficulty,
        mechanicKey: row.mechanic_key,
        policyVersion: row.policy_version,
        displayCategory: row.display_category,
        targetingMode: row.targeting_mode,
        requiredResponse: row.required_response,
        responsibilityMode: row.responsibility_mode,
        damageSemantics: row.damage_semantics,
        failurePropagation: row.failure_propagation,
        assignmentMode: row.assignment_mode,
        defensiveExpectation: row.defensive_expectation,
        creditScope: row.credit_scope,
        penaltyScope: row.penalty_scope,
        causalRule: row.causal_rule,
        confidence: row.confidence,
      });
    });

    // Leer roster (para role-based responsibility)
    const { data: rosterData, error: rosterErr } = await client
      .from('players')
      .select('name, role')
      .eq('active', true);

    if (rosterErr) throw rosterErr;

    const rosterByRole = new Map<string, string[]>();
    (rosterData as any[] | null)?.forEach((row) => {
      const role = row.role || 'dps';
      if (!rosterByRole.has(role)) {
        rosterByRole.set(role, []);
      }
      rosterByRole.get(role)!.push(row.name);
    });

    // Construir edges
    const edgesToInsert: any[] = [];

    for (const occData of occurrencesData as any[]) {
      const occurrence: MechanicOccurrenceEvaluationContract = {
        id: occData.id,
        pullId: occData.pull_id,
        bossId: occData.boss_id,
        difficulty: occData.difficulty,
        mechanicKey: occData.mechanic_key,
        occurrenceIndex: occData.occurrence_index,
        startMs: occData.start_ms,
        resolveMs: occData.resolve_ms,
        endMs: occData.end_ms,
        targetActorIds: occData.target_actor_ids || [],
        outcome: occData.outcome,
        failureMode: occData.failure_mode,
        evidence: occData.evidence,
        confidence: occData.confidence,
        policyVersion: occData.policy_version,
        contextResolverVersion: occData.context_resolver_version,
        occurrenceResolverVersion: occData.occurrence_resolver_version,
      };

      const policy = policyMap.get(occurrence.mechanicKey);
      if (!policy) continue;

      // Resolver ownership
      const ownership = resolveOccurrenceOwnership(occurrence, policy, null, rosterByRole);

      // Construir edges (sin defensive_plan_slots ni damage_by_player por ahora)
      const edgeDecisions = buildResponsibilityEdges(occurrence, policy, ownership, [], new Map());
      const dedupedEdges = deduplicateEdges(edgeDecisions);

      for (const edge of dedupedEdges) {
        edgesToInsert.push({
          occurrence_id: occurrence.id,
          player_name: edge.playerName,
          actor_id: edge.actorId,
          relationship: edge.relationship,
          damage_caused: 0,
          damage_taken: 0,
          victim_count: 0,
          credit_eligible: edge.creditEligible,
          penalty_eligible: edge.penaltyEligible,
          reason_code: edge.reasonCode,
          confidence: edge.confidence,
          evidence: { source: 'responsibility_edge_builder', occurrence_resolver_version: occurrence.occurrenceResolverVersion },
          created_by: guard.userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }

    // UPSERT edges
    const { data: inserted, error: upsertErr } = await client
      .from('mechanic_responsibility_edges')
      .upsert(edgesToInsert, {
        onConflict: 'occurrence_id,player_name,relationship,reason_code',
        ignoreDuplicates: false,
      })
      .select('*');

    if (upsertErr) throw upsertErr;

    const result = (inserted as Record<string, unknown>[] | null)?.map((row) => rowToEdge(row)) || [];

    return jsonResponse({
      ok: true,
      action: 'compute_responsibility_edges',
      pullId,
      edgesCreated: result.length,
      edges: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('compute-responsibility-edges error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
