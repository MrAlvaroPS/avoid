import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { evaluateDefensivePull } from '../_shared/defensive-execution-persistence.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  try {
    const body = (await req.json()) as { pullId?: string };
    if (!body.pullId?.trim()) return jsonResponse({ ok: false, error: 'pullId es obligatorio.' }, 400);
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const pullId = body.pullId.trim();
    await evaluateDefensivePull(supabase, pullId);
    const { data: evaluations, error } = await supabase
      .from('player_pull_defensive_evaluations')
      .select('*')
      .eq('pull_id', pullId)
      .order('player_name');
    if (error) throw error;
    return jsonResponse({ ok: true, pullId, evaluations: evaluations ?? [] });
  } catch (error) {
    console.error('evaluate-defensive-execution error:', error);
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  }
});
