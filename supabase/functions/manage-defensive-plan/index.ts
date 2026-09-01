import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { validateDefensivePlanDraft, type CreateDraftRequest } from '../_shared/defensive-plan-contract.ts';
import { persistDefensivePlanDraft } from '../_shared/defensive-plan-persistence.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

interface PublishRequest {
  action: 'publish';
  planVersionId: string;
}

interface BindRequest {
  action: 'bind_pull';
  planVersionId: string;
  pullId: string;
  reason: string;
}


Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: CreateDraftRequest | PublishRequest | BindRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    if (body.action === 'publish') {
      if (!body.planVersionId) return jsonResponse({ ok: false, error: 'planVersionId es obligatorio.' }, 400);
      const { data, error } = await supabase.rpc('publish_defensive_plan', {
        p_plan_version_id: body.planVersionId,
        p_published_by: guard.userId,
      });
      if (error) throw error;
      return jsonResponse({ ok: true, plan: data });
    }

    if (body.action === 'bind_pull') {
      if (!body.planVersionId || !body.pullId || !body.reason?.trim()) return jsonResponse({ ok: false, error: 'planVersionId, pullId y reason son obligatorios.' }, 400);
      const { data, error } = await supabase.rpc('bind_pull_to_defensive_plan', {
        p_pull_id: body.pullId,
        p_plan_version_id: body.planVersionId,
        p_binding_reason: 'manual',
        p_bound_by: guard.userId,
        p_manual_reason: body.reason.trim(),
      });
      if (error) throw error;
      return jsonResponse({ ok: true, binding: data });
    }

    if (body.action !== 'create_draft') return jsonResponse({ ok: false, error: 'action inválida.' }, 400);
    const validationError = validateDefensivePlanDraft(body);
    if (validationError) return jsonResponse({ ok: false, error: validationError }, 400);

    const plan = await persistDefensivePlanDraft(supabase, { ...body, backendResolved: false }, guard.userId);

    return jsonResponse({ ok: true, plan });
  } catch (error) {
    console.error('manage-defensive-plan error:', error);
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  }
});
