import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

// §"pantalla nueva para clasificar defensivos... parecida a la de
// mecánicas de bosses pero para defensivos" (feedback real): mismo patrón
// que save-mechanic-edit, pero para cooldown_catalog. Se identifica la fila
// por (class, spell_id) — mismo par que su UNIQUE constraint real (ver
// 20260822030000_cooldown_catalog.sql) — no por id, para no depender de
// haber traído el uuid al cliente.
//
// Sin resync: a diferencia de mecánicas, survival_type nunca se copia
// dentro de player_pull_records/pull_mechanic_events (defensive_casts y
// DefensiveOption solo guardan spellId/name/status) — cualquier pantalla
// que lo necesite lo cruza en el momento de leer contra cooldown_catalog,
// así que no hay histórico materializado que se quede desactualizado.

const VALID_SURVIVAL_TYPES = new Set(['mitigation', 'absorption', 'sustain', 'emergency']);

interface EditRequest {
  class: string;
  spellId: number;
  survivalType?: string | null;
  reviewed?: boolean;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  let body: EditRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.class || typeof body.spellId !== 'number') {
    return jsonResponse({ ok: false, error: 'class y spellId son obligatorios' }, 400);
  }
  if (body.survivalType && !VALID_SURVIVAL_TYPES.has(body.survivalType)) {
    return jsonResponse({ ok: false, error: `survivalType inválido: ${body.survivalType}` }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error } = await supabase
    .from('cooldown_catalog')
    .update({
      survival_type: body.survivalType ?? null,
      reviewed: body.reviewed ?? true,
    })
    .eq('class', body.class)
    .eq('spell_id', body.spellId);

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  return jsonResponse({ ok: true });
});
