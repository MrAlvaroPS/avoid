import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { invalidateNightFullReportsForBossDifficulty, resyncMechanicAvoidable, resyncMechanicCategory, resyncMechanicResponsibility } from '../_shared/resync-mechanic-category.ts';

interface EditRequest {
  bossId: string;
  difficulty: string;
  abilityId: number;
  category?: string | null;
  responsibility?: string | null;
  avoidable?: boolean | null;
  expectedResponse?: { type: string; scope: string } | null;
  severityThreshold?: number | null;
  reviewed?: boolean;
}

// §bug real encontrado (2026-08-23): faltaban 'healing-absorb' y
// 'personal-target' — ambas categorías válidas desde hace tiempo (ver el
// enum de boss_mechanics_candidates y CATEGORIES en manifest.component.ts),
// pero guardar cualquiera de las dos a mano desde Ajustes fallaba en
// silencio contra esta lista desactualizada.
const VALID_CATEGORIES = new Set([
  'tankbuster',
  'raid-damage',
  'avoidable-ground',
  'debuff-stack',
  'interrupt',
  'soak',
  'spread',
  'healing-absorb',
  'personal-target',
  'enrage',
]);
const VALID_RESPONSIBILITIES = new Set(['tank', 'dps', 'healer', 'raid', 'personal']);

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
  if (!body.bossId || !body.difficulty || !body.abilityId) {
    return jsonResponse({ ok: false, error: 'bossId, difficulty y abilityId son obligatorios' }, 400);
  }
  if (body.category && !VALID_CATEGORIES.has(body.category)) {
    return jsonResponse({ ok: false, error: `category inválida: ${body.category}` }, 400);
  }
  if (body.responsibility && !VALID_RESPONSIBILITIES.has(body.responsibility)) {
    return jsonResponse({ ok: false, error: `responsibility inválida: ${body.responsibility}` }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: updated, error } = await supabase
    .from('boss_mechanics_candidates')
    .update({
      category: body.category ?? null,
      responsibility: body.responsibility ?? null,
      avoidable: body.avoidable ?? null,
      expected_response: body.expectedResponse ?? null,
      severity_threshold: body.severityThreshold ?? null,
      reviewed: body.reviewed ?? true,
      updated_at: new Date().toISOString(),
    })
    .eq('boss_id', body.bossId)
    .eq('difficulty', body.difficulty)
    .eq('ability_id', body.abilityId)
    .select('name')
    .maybeSingle();

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  // §"Uncoiling sale sin clasificar... confirmada en Ajustes — falta ahí
  // cruce de datos" (feedback real): sin esto, confirmar una categoría
  // aquí no llegaba nunca a los pulls YA analizados (pull_mechanic_events/
  // death_cause quedan congelados desde analyze-report) — ver
  // resync-mechanic-category.ts. Se re-marca por NOMBRE, no por
  // ability_id — el ability_id del manifiesto (Journal) casi nunca
  // coincide con el que WCL guardó de verdad en los eventos.
  //
  // §bug real encontrado (2026-08-27): el guard era `if (body.category && ...)`
  // / `typeof body.avoidable === 'boolean'` — comprobaba el VALOR, no si el
  // campo venía en la petición. La fila de boss_mechanics_candidates de
  // arriba (línea ~64) SIEMPRE se escribe con `body.x ?? null` sin importar
  // esto, así que volver a poner una mecánica en "sin decidir" (null) desde
  // Ajustes actualizaba el candidato pero el resync se saltaba entero — el
  // histórico se quedaba con la clasificación vieja para siempre. El
  // frontend (manifest.component.ts) ya manda los tres campos en cada
  // guardado (con `'x' in patch ? patch.x : candidate.x`), así que "¿vino
  // el campo en el body?" es la misma pregunta que "¿lo estoy tocando en
  // este guardado?" — se comprueba presencia, no verdad del valor.
  if ('category' in body && updated?.name) {
    await resyncMechanicCategory(supabase, body.bossId, body.difficulty, updated.name, body.category ?? null);
  }
  if ('responsibility' in body && updated?.name) {
    await resyncMechanicResponsibility(supabase, body.bossId, body.difficulty, updated.name, body.responsibility ?? null);
  }
  if ('avoidable' in body && updated?.name) {
    await resyncMechanicAvoidable(supabase, body.bossId, body.difficulty, updated.name, body.avoidable ?? null);
  }

  // §"Daño evitable de toda la noche — solo hay cobertura en 1 de 3
  // combinaciones boss/dificultad" (feedback real): un informe de noche ya
  // generado se queda con la cobertura de cuando se generó — invalida el
  // caché para que la próxima apertura lo reconstruya con esta edición ya
  // aplicada, en vez de esperar a que alguien pulse "Actualizar" a mano.
  if (('category' in body || 'responsibility' in body || 'avoidable' in body) && updated?.name) {
    await invalidateNightFullReportsForBossDifficulty(supabase, body.bossId, body.difficulty);
  }

  return jsonResponse({ ok: true });
});
