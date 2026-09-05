import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { executePullEvaluationCommand, type PullContextCommandClient } from '../_shared/pull-evaluation-context-command.ts';

/** Adaptador legacy. La autoridad y la auditoría viven ya en PullEvaluationContext. */
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
      ? { action: 'accept_inferred_wipe' as const, reason: 'Compatibilidad set-wipe-call-status: candidato aceptado.' }
      : { action: 'clear_wipe' as const, reason: 'Compatibilidad set-wipe-call-status: wipe call restaurado.' };
    const result = await executePullEvaluationCommand(client as unknown as PullContextCommandClient, body.pullId, action, guard.userId);
    return jsonResponse({ ok: true, pullId: body.pullId, excluded: result.context.wipeCallAtMs != null, context: result.context, reanalysisQueued: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, /no encontrado/i.test(message) ? 404 : /No hay candidato/i.test(message) ? 400 : 500);
  }
});
