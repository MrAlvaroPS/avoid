import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { enqueueDefensiveReanalysis, type QueueClient } from '../_shared/defensive-reanalysis-queue.ts';
import { defensiveTargetingError } from '../_shared/defensive-classification-semantics.ts';

// §"pantalla nueva para clasificar defensivos... parecida a la de
// mecánicas de bosses pero para defensivos" (feedback real): mismo patrón
// que save-mechanic-edit, pero para cooldown_catalog. Se identifica la fila
// por (class, spell_id) — mismo par que su UNIQUE constraint real (ver
// 20260822030000_cooldown_catalog.sql) — no por id, para no depender de
// haber traído el uuid al cliente.
//
// §bug real reportado (2026-08-31, tank de Paladin — Ardent Defender
// clasificado como emergency cuando lo usa a CD como mitigación): el
// comentario que había aquí ("survival_type nunca se copia... no hay
// histórico materializado") era FALSO para defensive_pressure_windows —
// evaluateWindowCoverage (damage-pressure-windows.ts) SÍ copia
// `cd.survivalType` dentro de `options[]` en el momento de analizar/
// reanalizar un pull, y `coverable` se calcula en ese mismo instante
// excluyendo 'emergency' — reclasificar después no tocaba nada de eso.
// Mismo problema con spec_override (§"un tank de paladin... ya no la
// tiene", 2026-08-31): defensivesForClass() decide con qué catálogo se
// construyen death_cause.defensiveOptions/defensive_pressure_windows.options
// — cambiar qué specs tienen un defensivo SÍ afecta ese cálculo, igual que
// cooldown/duración. Las tres cosas disparan reanálisis ahora.
const VALID_SURVIVAL_TYPES = new Set(['mitigation', 'absorption', 'sustain', 'emergency']);
const VALID_CATEGORIES = new Set(['personal_defensive', 'semi_defensive', 'external_defensive', 'utility']);
const VALID_TARGETING_MODES = new Set(['self', 'ally', 'both', 'raid', 'unknown']);

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
  category?: string;
  targetingMode?: string;
  reviewed?: boolean;
  baseCooldownMs?: number | null;
  baseDurationMs?: number | null;
  /** Corrección manual de specs (ver spec_override en cooldown_catalog) — undefined = no tocar, null = borrar la corrección (volver a derivar de `spec`), array = la lista real. */
  specOverride?: string[] | null;
  /** §"el greater invisibility del mago ya no es un defensivo... no tengo opción de quitarlo" (feedback real, 2026-08-31) — true = ya no cuenta como defensivo real, ver excluded en cooldown_catalog. undefined = no tocar. */
  excluded?: boolean;
}

function sameStringArray(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const na = a ?? null;
  const nb = b ?? null;
  if (na === null || nb === null) return na === nb;
  return na.length === nb.length && [...na].sort().join('\u0000') === [...nb].sort().join('\u0000');
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
  if (body.category != null && !VALID_CATEGORIES.has(body.category)) {
    return jsonResponse({ ok: false, error: `category inválida: ${body.category}` }, 400);
  }
  if (body.targetingMode != null && !VALID_TARGETING_MODES.has(body.targetingMode)) {
    return jsonResponse({ ok: false, error: `targetingMode inválido: ${body.targetingMode}` }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // §survivalType se manda SIEMPRE desde el cliente (incluso al tocar solo
  // "reviewed") — a diferencia de baseCooldownMs/baseDurationMs/specOverride
  // (solo presentes cuando de verdad se editan), presencia-en-body no sirve
  // aquí para decidir si hay que reanalizar: haría falta reanalizar 47 pulls
  // cada vez que alguien marca un checkbox sin cambiar nada más. Se lee el
  // valor ANTERIOR real y se compara contra el nuevo — la única forma
  // correcta de saber qué cambió de verdad.
  const { data: before } = await supabase.from('cooldown_catalog').select('survival_type, category, targeting_mode, spec_override, excluded').eq('class', body.class).eq('spell_id', body.spellId).maybeSingle();
  if (!before) return jsonResponse({ ok: false, error: 'Defensivo no encontrado.' }, 404);

  const nextCategory = body.category ?? before.category;
  const nextTargetingMode = body.targetingMode ?? before.targeting_mode;
  if (nextCategory != null && nextTargetingMode != null) {
    const targetingError = defensiveTargetingError(nextCategory, nextTargetingMode);
    if (targetingError) return jsonResponse({ ok: false, error: targetingError }, 400);
  }

  // §"editarlo para que sea en segundos" (feedback real, 2026-08-29): el
  // componente ya convierte segundos->ms antes de llamar aquí — esta
  // función solo persiste ms, igual unidad que ya usa la columna real.
  // baseCooldownMs/baseDurationMs/specOverride/excluded son opcionales AQUÍ
  // (igual que survivalType, desde §"confirmar exclusión sugerida sin
  // conocer el survival_type actual de esa fila" 2026-08-31 — antes
  // survivalType SIEMPRE se aplicaba con `?? null`, así que omitirlo lo
  // borraba sin querer; ahora, igual que el resto, solo se toca si la clave
  // vino en el body). El cliente (defensive-catalog.component.ts) sigue
  // mandando survivalType siempre que edita esa columna, así que no cambia
  // nada para ese flujo — esto solo abre la puerta a editar OTRA columna
  // (ej. excluded desde una sugerencia de IA de otra clase) sin tener
  // cargado el survival_type actual de esa fila.
  const patch: Record<string, unknown> = {
    reviewed: body.reviewed ?? true,
    updated_at: new Date().toISOString(),
  };
  if ('survivalType' in body) patch['survival_type'] = body.survivalType ?? null;
  if ('category' in body) patch['category'] = body.category;
  if ('targetingMode' in body) patch['targeting_mode'] = body.targetingMode;
  if ('baseCooldownMs' in body) patch['base_cooldown_ms'] = body.baseCooldownMs;
  if ('baseDurationMs' in body) patch['base_duration_ms'] = body.baseDurationMs;
  if ('specOverride' in body) patch['spec_override'] = body.specOverride;
  if ('excluded' in body) patch['excluded'] = body.excluded;

  const { error } = await supabase
    .from('cooldown_catalog')
    .update(patch)
    .eq('class', body.class)
    .eq('spell_id', body.spellId);

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  const survivalTypeChanged = 'survivalType' in body && (before?.survival_type ?? null) !== (body.survivalType ?? null);
  const categoryChanged = 'category' in body && before.category !== body.category;
  const targetingModeChanged = 'targetingMode' in body && before.targeting_mode !== body.targetingMode;
  const specOverrideChanged = 'specOverride' in body && !sameStringArray(before?.spec_override as string[] | null | undefined, body.specOverride);
  const excludedChanged = 'excluded' in body && (before?.excluded ?? false) !== (body.excluded ?? false);

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
  // que esta función ya no reanaliza nada ella misma: persiste batch+jobs y
  // devuelve la lista de pulls afectados. El cliente llama a
  // reanalyze-defensive-pressure una vez por pull, en secuencia; si se cierra
  // la pestaña, otra sesión recupera los jobs que sigan pendientes.
  let pullIds: string[] = [];
  let pullDiscoveryError: string | null = null;
  if ('baseCooldownMs' in body || 'baseDurationMs' in body || survivalTypeChanged || categoryChanged || targetingModeChanged || specOverrideChanged || excludedChanged) {
    const { data: affectedRecords, error: affectedError } = await supabase
      .from('player_pull_records')
      .select('pull_id')
      .eq('class', body.class);
    if (affectedError) {
      pullDiscoveryError = `No se pudieron descubrir los pulls afectados: ${affectedError.message}`;
    } else {
      pullIds = [...new Set((affectedRecords ?? []).map((r) => (r as { pull_id: string }).pull_id))];
    }
  }

  let reanalysisBatchId: string | null = null;
  let reanalysisJobs: { id: string; pullId: string }[] = [];
  let reanalysisQueueError: string | null = pullDiscoveryError;
  if (pullIds.length) {
    try {
      const queued = await enqueueDefensiveReanalysis(supabase as unknown as QueueClient, {
        pullIds,
        reason: `cooldown_catalog:${body.class}:${body.spellId}`,
        scope: {
          kind: 'catalog_edit',
          class: body.class,
          spellId: body.spellId,
          changedFields: Object.keys(patch).filter((field) => field !== 'updated_at'),
        },
        requestedBy: guard.userId,
      });
      reanalysisBatchId = queued.batchId;
      reanalysisJobs = queued.jobs;
    } catch (queueError) {
      // El cambio de catálogo ya está persistido. Se conservan pullIds para
      // ejecutar el fallback cliente y se hace visible que la cola durable no
      // pudo registrarse, en vez de fingir una transacción que no existe.
      reanalysisQueueError = queueError instanceof Error ? queueError.message : String(queueError);
      console.error('No se pudo persistir la cola de reanálisis:', queueError);
    }
  }

  return jsonResponse({ ok: true, pullIds, reanalysisBatchId, reanalysisJobs, reanalysisQueueError });
});
