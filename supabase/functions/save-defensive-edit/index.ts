import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

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

// §"no puedo editar el campo de cd... no poner el cd de un defensivo falsea
// muchísimo los datos, medias y baremos" (feedback real, 2026-08-29):
// verificado en real — Fortifying Brew (Monk) tenía base_cooldown_ms null
// pese a tener un cooldown de 3 min bien documentado en Wowhead, y eso
// dejaba al único defensivo de una healer en estado 'unknown' tras su
// primer cast del pull en vez de "en cooldown"/"disponible", inflando su
// eje de Fiabilidad defensiva. Mismo patrón que survivalType: editable a
// mano aquí, o rellenable en bloque desde el prompt de classify-defensives.
interface EditRequest {
  class: string;
  spellId: number;
  survivalType?: string | null;
  reviewed?: boolean;
  baseCooldownMs?: number | null;
  baseDurationMs?: number | null;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

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

  // §"editarlo para que sea en segundos" (feedback real, 2026-08-29): el
  // componente ya convierte segundos->ms antes de llamar aquí — esta
  // función solo persiste ms, igual unidad que ya usa la columna real.
  // Los dos campos son opcionales AQUÍ (a diferencia de survivalType, que
  // siempre se manda): un guardado que solo toca survivalType no debe
  // borrar un cooldown/duración ya puestos por no venir en el body.
  const patch: Record<string, unknown> = {
    survival_type: body.survivalType ?? null,
    reviewed: body.reviewed ?? true,
  };
  if ('baseCooldownMs' in body) patch['base_cooldown_ms'] = body.baseCooldownMs;
  if ('baseDurationMs' in body) patch['base_duration_ms'] = body.baseDurationMs;

  const { error } = await supabase
    .from('cooldown_catalog')
    .update(patch)
    .eq('class', body.class)
    .eq('spell_id', body.spellId);

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  // §"cuando cambio la duracion y cd de un defensivo... se calculan de
  // nuevo? porque he puesto el fortifying brew y sale lo mismo en todos
  // lados" (feedback real, 2026-08-29): confirmado, NO se recalculaba solo
  // — defensive_pressure_windows (el estado active/on_cooldown/
  // available_unused por ventana) se calcula UNA VEZ en analyze-report/
  // reanalyze-defensive-pressure y se persiste tal cual; editar el catálogo
  // después no tocaba ese JSON ya guardado, así que el dosier/infografía/
  // Fiabilidad seguían leyendo el estado viejo ('unknown', calculado con el
  // cooldown en null) indefinidamente. Solo cuando de verdad se edita
  // cooldown/duración (no cuando solo se toca survival_type/reviewed, que
  // no afecta a ese cálculo) se dispara un reanálisis de cada pull donde
  // haya participado algún jugador de esta clase — mismo mecanismo que ya
  // usa el backfill manual, pero automático en cada edición.
  //
  // §bug real encontrado en producción (2026-08-29, verificado con
  // Fortifying Brew/47 pulls de Monk): reanalizar los pulls uno detrás de
  // otro EN ESTE MISMO bucle agotaba la cuota de CPU del isolate a mitad de
  // camino (WORKER_RESOURCE_LIMIT) — la función moría en silencio antes de
  // reanalizar nada y esta respuesta nunca llegaba a devolverse. Se probó
  // encadenar invocaciones en el propio backend (fire-and-forget +
  // EdgeRuntime.waitUntil) pero, verificado empíricamente, el runtime mata
  // el isolate al responder y el segundo eslabón nunca llega a salir. Así
  // que esta función ya no reanaliza nada ella misma: solo devuelve la
  // lista de pulls afectados, y es el CLIENTE (defensive-catalog.component)
  // quien llama a reanalyze-defensive-pressure una vez por pull, en
  // secuencia — cada llamada es una invocación de edge function limpia con
  // su propia cuota de CPU, y el navegador no tiene ese límite.
  let pullIds: string[] = [];
  if ('baseCooldownMs' in body || 'baseDurationMs' in body) {
    const { data: affectedRecords, error: affectedError } = await supabase
      .from('player_pull_records')
      .select('pull_id')
      .eq('class', body.class);
    if (!affectedError) {
      pullIds = [...new Set((affectedRecords ?? []).map((r) => (r as { pull_id: string }).pull_id))];
    }
  }

  return jsonResponse({ ok: true, pullIds });
});
