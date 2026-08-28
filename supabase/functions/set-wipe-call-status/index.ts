import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

// §"que autoexcluya pero que permita también editarlo y decir que no lo
// era, para restaurar los valores" (feedback real): analyze-report ya deja
// pulls.wipe_call_excluded en su valor por defecto (confidence >= umbral)
// al detectar el cluster — esta función es el único sitio que lo cambia
// después, siempre a mano y siempre explícito. Mismo patrón que
// save-mechanic-edit (RLS de escritura solo vía Edge Function con
// service_role, sin usuario/sesión).

interface Body {
  pullId: string;
  excluded: boolean;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.pullId || typeof body.excluded !== 'boolean') {
    return jsonResponse({ ok: false, error: 'pullId y excluded (boolean) son obligatorios' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Solo tiene sentido tocar pulls donde de verdad se detectó un cluster —
  // evita que una llamada mal formada active wipe_call_excluded en un pull
  // sin wipe_call_signals (no habría nada que excluir: wipe_call_cluster
  // seguiría en false en todos sus player_pull_records).
  const { data: pull, error: fetchError } = await supabase.from('pulls').select('id,wipe_call_signals').eq('id', body.pullId).maybeSingle();
  if (fetchError) return jsonResponse({ ok: false, error: fetchError.message }, 500);
  if (!pull) return jsonResponse({ ok: false, error: `Pull ${body.pullId} no encontrado` }, 404);
  if (!pull.wipe_call_signals) return jsonResponse({ ok: false, error: 'Este pull no tiene un wipe call detectado — nada que marcar/restaurar.' }, 400);

  // updated_at: señal que consume roster-snapshot-cache.service.ts para
  // saber que este pull cambió DESPUÉS de su análisis original — sin esto
  // el snapshot cacheado del roster se queda desfasado indefinidamente (ver
  // 20260828100000_pulls_updated_at_cache_invalidation.sql).
  const { error } = await supabase.from('pulls').update({ wipe_call_excluded: body.excluded, updated_at: new Date().toISOString() }).eq('id', body.pullId);
  if (error) return jsonResponse({ ok: false, error: error.message }, 500);

  return jsonResponse({ ok: true, pullId: body.pullId, excluded: body.excluded });
});
