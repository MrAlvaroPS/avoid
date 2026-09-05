import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { executePullEvaluationCommand, type PullContextCommandClient } from '../_shared/pull-evaluation-context-command.ts';

/** Adaptador legacy. Permite confirmar/restaurar cualquier pull, tenga o no señales. */
interface Body { pullId: string; excluded: boolean }

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: Body;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: 'Body JSON inválido.' }, 400); }
  if (!body.pullId || typeof body.excluded !== 'boolean') {
    return jsonResponse({ ok: false, error: 'pullId y excluded (boolean) son obligatorios.' }, 400);
  }

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const action = body.excluded
      ? { action: 'confirm_ninja' as const, reason: 'Compatibilidad set-ninja-pull-status: ninja confirmado.' }
      : { action: 'mark_valid' as const, reason: 'Compatibilidad set-ninja-pull-status: intento válido confirmado.' };
    const result = await executePullEvaluationCommand(client as unknown as PullContextCommandClient, body.pullId, action, guard.userId);
    return jsonResponse({ ok: true, pullId: body.pullId, excluded: !result.context.evaluationEligible, context: result.context, reanalysisQueued: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, /no encontrado/i.test(message) ? 404 : 500);
  }
});
