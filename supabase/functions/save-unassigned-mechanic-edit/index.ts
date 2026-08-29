import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §"UI en Ajustes para gestionar el catálogo a mano" (feedback real,
// 2026-08-29) — mismo patrón que save-mechanic-edit/save-defensive-edit:
// única puerta de escritura para unassigned_mechanic_catalog, ahora que la
// tabla tiene RLS de solo-lectura (ver migración 20260829080000). Soporta
// las 3 operaciones que necesita la pantalla: crear fila nueva (sin `id`),
// editar una existente (`id` presente) y borrar (`delete: true` + `id`).
//
// §"que todo sea consistente" (mismo motivo que save-defensive-edit): si el
// campo que cambia afecta a CÓMO se detecta (detectionType/abilityId/
// actorNamePattern/appliedBy/hasConfirmedDetection), se devuelven los
// pullIds de ese boss+dificultad para que el cliente reanalice uno a uno
// (reanalyze-unassigned-mechanics ya existe y ya soporta esto — no hace
// falta código nuevo de detección, solo disparar el mismo pipeline). Un
// cambio de solo ai_notes/reviewed/eligible_roles no mueve pullIds: no hay
// nada que reanalizar.

const VALID_DETECTION_TYPES = new Set(['cast', 'debuff_applied', 'buff_applied', 'npc_interaction']);
const VALID_APPLIED_BY = new Set(['npc', 'self']);
const DETECTION_RELEVANT_FIELDS = ['detectionType', 'abilityId', 'actorNamePattern', 'appliedBy', 'hasConfirmedDetection'] as const;

interface EditRequest {
  id?: string;
  delete?: boolean;
  bossId?: string;
  difficulty?: string;
  name?: string;
  detectionType?: 'cast' | 'debuff_applied' | 'buff_applied' | 'npc_interaction';
  abilityId?: number | null;
  actorNamePattern?: string | null;
  appliedBy?: 'npc' | 'self' | null;
  eligibleRoles?: string[] | null;
  consequenceAbilityId?: number | null;
  hasConfirmedDetection?: boolean;
  reviewed?: boolean;
  aiConfidence?: string | null;
  aiNotes?: string | null;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: EditRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // --- Borrado ---
  if (body.delete) {
    if (!body.id) return jsonResponse({ ok: false, error: 'id es obligatorio para borrar' }, 400);
    const { data: row } = await supabase.from('unassigned_mechanic_catalog').select('boss_id,difficulty').eq('id', body.id).maybeSingle();
    const { error } = await supabase.from('unassigned_mechanic_catalog').delete().eq('id', body.id);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const pullIds = row ? await pullIdsFor(supabase, row.boss_id, row.difficulty) : [];
    return jsonResponse({ ok: true, pullIds });
  }

  // --- Validación común a crear/editar ---
  if (body.detectionType && !VALID_DETECTION_TYPES.has(body.detectionType)) {
    return jsonResponse({ ok: false, error: `detectionType inválido: ${body.detectionType}` }, 400);
  }
  if (body.appliedBy && !VALID_APPLIED_BY.has(body.appliedBy)) {
    return jsonResponse({ ok: false, error: `appliedBy inválido: ${body.appliedBy}` }, 400);
  }

  const detectionRelevantFieldTouched = DETECTION_RELEVANT_FIELDS.some((f) => f in body);

  if (body.id) {
    // --- Editar fila existente ---
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ('name' in body) patch.name = body.name;
    if ('detectionType' in body) patch.detection_type = body.detectionType;
    if ('abilityId' in body) patch.ability_id = body.abilityId;
    if ('actorNamePattern' in body) patch.actor_name_pattern = body.actorNamePattern;
    if ('appliedBy' in body) patch.applied_by = body.appliedBy;
    if ('eligibleRoles' in body) patch.eligible_roles = body.eligibleRoles;
    if ('consequenceAbilityId' in body) patch.consequence_ability_id = body.consequenceAbilityId;
    if ('hasConfirmedDetection' in body) patch.has_confirmed_detection = body.hasConfirmedDetection;
    if ('reviewed' in body) patch.reviewed = body.reviewed;
    if ('aiConfidence' in body) patch.ai_confidence = body.aiConfidence;
    if ('aiNotes' in body) patch.ai_notes = body.aiNotes;

    const { data: updated, error } = await supabase
      .from('unassigned_mechanic_catalog')
      .update(patch)
      .eq('id', body.id)
      .select('boss_id,difficulty,ability_id,actor_name_pattern')
      .maybeSingle();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!updated) return jsonResponse({ ok: false, error: `Fila ${body.id} no encontrada` }, 404);
    if (!updated.ability_id && !updated.actor_name_pattern) {
      return jsonResponse({ ok: false, error: 'La fila necesita ability_id o actor_name_pattern (al menos uno)' }, 400);
    }

    const pullIds = detectionRelevantFieldTouched ? await pullIdsFor(supabase, updated.boss_id, updated.difficulty) : [];
    return jsonResponse({ ok: true, pullIds });
  }

  // --- Crear fila nueva ---
  if (!body.bossId || !body.difficulty || !body.name || !body.detectionType) {
    return jsonResponse({ ok: false, error: 'bossId, difficulty, name y detectionType son obligatorios para crear' }, 400);
  }
  if (!body.abilityId && !body.actorNamePattern) {
    return jsonResponse({ ok: false, error: 'Hace falta ability_id o actor_name_pattern (al menos uno)' }, 400);
  }

  const { data: inserted, error: insertError } = await supabase
    .from('unassigned_mechanic_catalog')
    .insert({
      boss_id: body.bossId,
      difficulty: body.difficulty,
      name: body.name,
      detection_type: body.detectionType,
      ability_id: body.abilityId ?? null,
      actor_name_pattern: body.actorNamePattern ?? null,
      applied_by: body.appliedBy ?? null,
      eligible_roles: body.eligibleRoles ?? null,
      consequence_ability_id: body.consequenceAbilityId ?? null,
      has_confirmed_detection: body.hasConfirmedDetection ?? false,
      reviewed: body.reviewed ?? true,
      ai_confidence: body.aiConfidence ?? null,
      ai_notes: body.aiNotes ?? null,
    })
    .select('id')
    .single();
  if (insertError) return jsonResponse({ ok: false, error: insertError.message }, 500);

  const pullIds = body.hasConfirmedDetection ? await pullIdsFor(supabase, body.bossId, body.difficulty) : [];
  return jsonResponse({ ok: true, id: inserted.id, pullIds });
});

async function pullIdsFor(
  supabase: ReturnType<typeof createClient>,
  bossId: string,
  difficulty: string,
): Promise<string[]> {
  const { data } = await supabase.from('pulls').select('id').eq('boss_id', bossId).eq('difficulty', difficulty);
  return ((data ?? []) as { id: string }[]).map((p) => p.id);
}
