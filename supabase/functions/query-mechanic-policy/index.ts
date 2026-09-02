import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import type { MechanicPolicyContract } from '../_shared/combat-evaluation-contract.ts';

interface Body {
  bossId?: unknown;
  difficulty?: unknown;
  mechanicKey?: unknown;
  policyVersion?: unknown;
}

function rowToPolicy(row: Record<string, unknown>): MechanicPolicyContract {
  return {
    bossId: row['boss_id'] as string,
    difficulty: row['difficulty'] as string,
    mechanicKey: row['mechanic_key'] as string,
    policyVersion: row['policy_version'] as number,
    displayCategory: row['display_category'] as string | null,
    targetingMode: row['targeting_mode'] as any,
    requiredResponse: row['required_response'] as string | null,
    responsibilityMode: row['responsibility_mode'] as any,
    damageSemantics: row['damage_semantics'] as any,
    failurePropagation: row['failure_propagation'] as any,
    assignmentMode: row['assignment_mode'] as any,
    defensiveExpectation: row['defensive_expectation'] as any,
    creditScope: row['credit_scope'] as any,
    penaltyScope: row['penalty_scope'] as any,
    causalRule: row['causal_rule'] as Record<string, unknown>,
    confidence: row['confidence'] as any,
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

  if (typeof body.bossId !== 'string' || !body.bossId) {
    return jsonResponse({ ok: false, error: 'bossId es obligatorio.' }, 400);
  }
  if (typeof body.difficulty !== 'string' || !body.difficulty) {
    return jsonResponse({ ok: false, error: 'difficulty es obligatorio.' }, 400);
  }
  if (typeof body.mechanicKey !== 'string' || !body.mechanicKey) {
    return jsonResponse({ ok: false, error: 'mechanicKey es obligatorio.' }, 400);
  }

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const versionRequested = typeof body.policyVersion === 'number' && body.policyVersion > 0;
    const { data, error } = versionRequested
      ? await client
          .from('boss_mechanic_policy_versions')
          .select('snapshot')
          .eq('boss_id', body.bossId)
          .eq('difficulty', body.difficulty)
          .eq('mechanic_key', body.mechanicKey)
          .eq('policy_version', body.policyVersion)
          .limit(1)
      : await client
          .from('boss_mechanic_policy')
          .select('*')
          .eq('boss_id', body.bossId)
          .eq('difficulty', body.difficulty)
          .eq('mechanic_key', body.mechanicKey)
          .limit(1);

    if (error) throw error;

    if (!data || data.length === 0) {
      return jsonResponse(
        {
          ok: false,
          error: `No se encontró policy para ${body.bossId}/${body.difficulty}/${body.mechanicKey}${typeof body.policyVersion === 'number' ? ` v${body.policyVersion}` : ' (última versión)'}`,
        },
        404,
      );
    }

    const row = data[0] as Record<string, unknown>;
    const policy = rowToPolicy(
      (versionRequested ? row['snapshot'] : row) as Record<string, unknown>,
    );
    return jsonResponse({ ok: true, policy });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('query-mechanic-policy error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
