import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §"necesito un botón en ajustes → defensivos en una clase para limpiar
// sus defensivos y volver a calcularlos con el prompt, porque alguno se
// desactualiza" (feedback real, 2026-08-31): borra SOLO lo que rellena el
// flujo de IA (survival_type/reviewed/ai_classification/
// inferred_survival_type) — nunca spec_override (corrección manual, ver
// migración 20260831090000) ni base_cooldown_ms/base_duration_ms (vienen
// del extractor de WoWAnalyzer o de edición manual aparte, ajenos al
// prompt de clasificación). Deja la clase entera en "sin clasificar" para
// que el botón ya existente "…o clasificar solo <clase> con IA" la rellene
// de nuevo, esta vez con el prompt actualizado.

interface ResetRequest {
  class: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: ResetRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.class) return jsonResponse({ ok: false, error: 'class es obligatorio' }, 400);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: updated, error } = await supabase
    .from('cooldown_catalog')
    .update({ survival_type: null, reviewed: false, ai_classification: null, inferred_survival_type: null, updated_at: new Date().toISOString() })
    .eq('class', body.class)
    .select('spell_id');
  if (error) return jsonResponse({ ok: false, error: error.message }, 500);

  // §mismo motivo que save-defensive-edit: borrar survival_type deja
  // desactualizado defensive_pressure_windows de cada pull con algún
  // jugador de esta clase — se devuelven los pullIds para que el cliente
  // los reanalice en secuencia (nunca en bucle dentro de un edge function).
  const { data: affectedRecords } = await supabase.from('player_pull_records').select('pull_id').eq('class', body.class);
  const pullIds = [...new Set((affectedRecords ?? []).map((r) => (r as { pull_id: string }).pull_id))];

  return jsonResponse({ ok: true, resetCount: updated?.length ?? 0, pullIds });
});
