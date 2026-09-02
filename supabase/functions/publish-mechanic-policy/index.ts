import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import type { MechanicPolicyContract } from '../_shared/combat-evaluation-contract.ts';

interface Body {
  policy?: unknown;
  reason?: unknown;
  reviewedBy?: unknown;
}

const VALID_TARGETING_MODES = new Set(['tank', 'selected_player', 'group', 'raid', 'ground', 'object', 'none', 'mixed']);
const VALID_RESPONSIBILITY_MODES = new Set(['target', 'tank_role', 'healer_role', 'dps_role', 'assigned_player', 'assigned_group', 'volunteer', 'raid', 'none']);
const VALID_DAMAGE_SEMANTICS = new Set(['mandatory', 'avoidable', 'partly_avoidable', 'failure_consequence', 'none']);
const VALID_FAILURE_PROPAGATION = new Set(['self', 'nearby_players', 'group', 'raid', 'chained', 'none']);
const VALID_ASSIGNMENT_MODES = new Set(['none', 'target_derived', 'role_derived', 'plan_optional', 'plan_required']);
const VALID_DEFENSIVE_EXPECTATIONS = new Set(['none', 'optional', 'recommended', 'required', 'contingency_only']);
const VALID_CREDIT_SCOPES = new Set(['resolver', 'target', 'group', 'raid', 'none']);
const VALID_PENALTY_SCOPES = new Set(['owner', 'assignee', 'role', 'raid_only', 'none']);
const VALID_CONFIDENCES = new Set(['verified', 'inferred', 'fallback', 'uncertain']);
const VALID_CATEGORIES = new Set(['tankbuster', 'raid-damage', 'avoidable-ground', 'debuff-stack', 'interrupt', 'soak', 'spread', 'healing-absorb', 'personal-target', 'enrage']);

function validatePolicy(policy: Record<string, unknown>): string | null {
  if (typeof policy.bossId !== 'string' || !policy.bossId) return 'bossId es obligatorio';
  if (typeof policy.difficulty !== 'string' || !policy.difficulty) return 'difficulty es obligatorio';
  if (typeof policy.mechanicKey !== 'string' || !policy.mechanicKey) return 'mechanicKey es obligatorio';
  if (typeof policy.targetingMode !== 'string' || !VALID_TARGETING_MODES.has(policy.targetingMode)) return `targetingMode inválido: ${policy.targetingMode}`;
  if (typeof policy.responsibilityMode !== 'string' || !VALID_RESPONSIBILITY_MODES.has(policy.responsibilityMode)) return `responsibilityMode inválido`;
  if (typeof policy.damageSemantics !== 'string' || !VALID_DAMAGE_SEMANTICS.has(policy.damageSemantics)) return `damageSemantics inválido`;
  if (typeof policy.failurePropagation !== 'string' || !VALID_FAILURE_PROPAGATION.has(policy.failurePropagation)) return `failurePropagation inválido`;
  if (typeof policy.assignmentMode !== 'string' || !VALID_ASSIGNMENT_MODES.has(policy.assignmentMode)) return `assignmentMode inválido`;
  if (typeof policy.defensiveExpectation !== 'string' || !VALID_DEFENSIVE_EXPECTATIONS.has(policy.defensiveExpectation)) return `defensiveExpectation inválido`;
  if (typeof policy.creditScope !== 'string' || !VALID_CREDIT_SCOPES.has(policy.creditScope)) return `creditScope inválido`;
  if (typeof policy.penaltyScope !== 'string' || !VALID_PENALTY_SCOPES.has(policy.penaltyScope)) return `penaltyScope inválido`;
  if (typeof policy.confidence !== 'string' || !VALID_CONFIDENCES.has(policy.confidence)) return `confidence inválido`;
  if (policy.displayCategory && !VALID_CATEGORIES.has(policy.displayCategory as string)) return `displayCategory inválido`;
  if (policy.confidence === 'verified' && !policy.displayCategory) return 'displayCategory es obligatorio si confidence=verified';
  return null;
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

  const policy = body.policy as Record<string, unknown>;
  if (!policy) return jsonResponse({ ok: false, error: 'policy es obligatorio.' }, 400);

  const validationError = validatePolicy(policy);
  if (validationError) return jsonResponse({ ok: false, error: validationError }, 400);

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return jsonResponse({ ok: false, error: 'reason es obligatorio.' }, 400);

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Obtener versión actual
    const { data: current, error: readErr } = await client
      .from('boss_mechanic_policy')
      .select('*')
      .eq('boss_id', policy.bossId)
      .eq('difficulty', policy.difficulty)
      .eq('mechanic_key', policy.mechanicKey)
      .order('policy_version', { ascending: false })
      .limit(1);

    if (readErr) throw readErr;

    const previousPolicy = (current?.[0] as Record<string, unknown> | undefined) ?? null;
    const nextVersion = previousPolicy ? Number(previousPolicy['policy_version']) + 1 : 1;

    // Preparar row para insertar
    const now = new Date().toISOString();
    const insertRow = {
      boss_id: policy.bossId,
      difficulty: policy.difficulty,
      mechanic_key: policy.mechanicKey,
      policy_version: nextVersion,
      display_name: policy.mechanicKey, // Usar mechanic_key como display_name por defecto
      display_category: policy.displayCategory ?? null,
      targeting_mode: policy.targetingMode,
      required_response: policy.requiredResponse ?? null,
      responsibility_mode: policy.responsibilityMode,
      damage_semantics: policy.damageSemantics,
      failure_propagation: policy.failurePropagation,
      assignment_mode: policy.assignmentMode,
      defensive_expectation: policy.defensiveExpectation,
      credit_scope: policy.creditScope,
      penalty_scope: policy.penaltyScope,
      causal_rule: policy.causalRule ?? {},
      confidence: policy.confidence,
      provenance: { source: 'officer_override', timestamp: now },
      verified_at: policy.confidence === 'verified' ? now : null,
      reviewed_by: guard.userId,
      created_by: guard.userId,
      created_at: now,
      updated_at: now,
    };

    // UPSERT
    const { data: result, error: upsertErr } = await client
      .from('boss_mechanic_policy')
      .upsert([insertRow], {
        onConflict: 'boss_id,difficulty,mechanic_key',
        ignoreDuplicates: false,
      })
      .select('*');

    if (upsertErr) throw upsertErr;

    const publishedPolicy = rowToPolicy((result![0] as Record<string, unknown>));

    // Crear auditoría
    const auditRow = {
      boss_id: policy.bossId,
      difficulty: policy.difficulty,
      mechanic_key: policy.mechanicKey,
      previous_policy_version: previousPolicy ? Number(previousPolicy['policy_version']) : null,
      new_policy_version: nextVersion,
      before_state: previousPolicy,
      after_state: insertRow,
      reason: reason,
      changed_by: guard.userId,
      changed_at: now,
    };

    const { error: auditErr } = await client
      .from('boss_mechanic_policy_audit')
      .insert([auditRow]);

    if (auditErr) throw auditErr;

    return jsonResponse({
      ok: true,
      action: 'publish_mechanic_policy',
      previousVersion: previousPolicy ? Number(previousPolicy['policy_version']) : null,
      newVersion: nextVersion,
      policy: publishedPolicy,
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error('publish-mechanic-policy error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
