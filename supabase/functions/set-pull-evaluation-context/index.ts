import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { executePullEvaluationCommand, type PullContextCommandClient } from '../_shared/pull-evaluation-context-command.ts';
import type { PullEvaluationContextAction } from '../_shared/pull-evaluation-context.ts';

interface Body {
  pullId?: unknown;
  action?: unknown;
  boundaryMs?: unknown;
  evaluationEligible?: unknown;
  evaluationStartMs?: unknown;
  evaluationEndMs?: unknown;
  wipeCallAtMs?: unknown;
  wipeCallVerified?: unknown;
  ninjaConfirmed?: unknown;
  reason?: unknown;
}

const ACTIONS = new Set([
  'confirm_wipe', 'clear_wipe', 'move_wipe_boundary', 'accept_inferred_wipe',
  'confirm_ninja', 'mark_valid', 'mark_probable_ninja',
  'override_context',
]);

function parseAction(body: Body): PullEvaluationContextAction {
  if (typeof body.action !== 'string' || !ACTIONS.has(body.action)) throw new Error('action no soportada.');
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  if (body.action === 'confirm_wipe' || body.action === 'move_wipe_boundary') {
    if (typeof body.boundaryMs !== 'number') throw new Error('boundaryMs es obligatorio para esta acción.');
    return { action: body.action, boundaryMs: body.boundaryMs, reason };
  }
  if (body.action === 'override_context') {
    if (
      typeof body.evaluationEligible !== 'boolean' ||
      typeof body.evaluationStartMs !== 'number' ||
      typeof body.evaluationEndMs !== 'number' ||
      (body.wipeCallAtMs !== null && typeof body.wipeCallAtMs !== 'number') ||
      typeof body.wipeCallVerified !== 'boolean' ||
      typeof body.ninjaConfirmed !== 'boolean'
    ) {
      throw new Error('override_context requiere todos los campos de contexto.');
    }
    return {
      action: 'override_context',
      evaluationEligible: body.evaluationEligible,
      evaluationStartMs: body.evaluationStartMs,
      evaluationEndMs: body.evaluationEndMs,
      wipeCallAtMs: body.wipeCallAtMs,
      wipeCallVerified: body.wipeCallVerified,
      ninjaConfirmed: body.ninjaConfirmed,
      reason,
    };
  }
  return { action: body.action, reason } as PullEvaluationContextAction;
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
  if (typeof body.pullId !== 'string' || !body.pullId) return jsonResponse({ ok: false, error: 'pullId es obligatorio.' }, 400);

  try {
    const action = parseAction(body);
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const result = await executePullEvaluationCommand(client as unknown as PullContextCommandClient, body.pullId, action, guard.userId);
    return jsonResponse({ ok: true, pullId: body.pullId, action: action.action, ...result, reanalysisQueued: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /no encontrado/i.test(message) ? 404 : /obligatorio|no soportada|debe ser|entre 0|Restaura primero/i.test(message) ? 400 : 500;
    console.error('set-pull-evaluation-context error:', error);
    return jsonResponse({ ok: false, error: message }, status);
  }
});
