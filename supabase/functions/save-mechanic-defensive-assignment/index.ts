import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §Única puerta de escritura de mechanic_defensive_assignments (RLS de solo
// lectura, ver migración 20260830130000) — mismo patrón que
// save-unassigned-mechanic-edit. Crear/editar manualmente es un upsert sobre
// la unique key real (boss_id, difficulty, ability_id, class, spec): la
// pantalla piensa en "un hueco de asignación por mecánica+spec", no en ids
// opacos. Borrado sigue siendo por `id` (`delete: true`).
//
// IMPORTANTE — garantía anti-pérdida para AUTO (2026-08-31): la cascada
// automática manda únicamente los campos mínimos (no bossmodSpellId/notes/
// assignedGroups), mientras que el formulario manual manda esas tres claves
// explícitamente incluso cuando valen null. Ese contrato permite detectar la
// escritura automática sin cambiar el payload público: AUTO usa INSERT puro
// y NUNCA upsert. Si otra pestaña/oficial creó la misma asignación desde que
// el cliente cargó la pantalla, el UNIQUE devuelve 23505 y respondemos 409;
// la fila existente queda intacta, incluyendo defensivo, prewarn, trigger,
// notas y grupos. Así la protección no depende solo de un snapshot cliente
// potencialmente desactualizado.

interface UpsertRequest {
  bossId: string;
  difficulty: string;
  abilityId: number;
  class: string;
  spec: string;
  defensiveSpellId: number;
  prewarnSeconds?: number;
  triggerType?: 'bossmod' | 'time';
  bossmodSpellId?: number | null;
  notes?: string | null;
  /** Grupos de raid (1-6) a los que aplica — null/undefined = todos. Solo informativo, ver migración 20260831130000. */
  assignedGroups?: number[] | null;
}
interface DeleteRequest {
  id: string;
  delete: true;
}

const VALID_TRIGGER_TYPES = new Set(['bossmod', 'time']);

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: UpsertRequest | DeleteRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if ('delete' in body && body.delete) {
    if (!body.id) return jsonResponse({ ok: false, error: 'id es obligatorio para borrar' }, 400);
    const { error } = await supabase.from('mechanic_defensive_assignments').delete().eq('id', body.id);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  const upsertBody = body as UpsertRequest;
  if (!upsertBody.bossId || !upsertBody.difficulty || !upsertBody.abilityId || !upsertBody.class || !upsertBody.spec || !upsertBody.defensiveSpellId) {
    return jsonResponse({ ok: false, error: 'bossId, difficulty, abilityId, class, spec y defensiveSpellId son obligatorios' }, 400);
  }
  const triggerType = upsertBody.triggerType ?? 'bossmod';
  if (!VALID_TRIGGER_TYPES.has(triggerType)) return jsonResponse({ ok: false, error: `triggerType inválido: ${triggerType}` }, 400);

  const payload = {
    boss_id: upsertBody.bossId,
    difficulty: upsertBody.difficulty,
    ability_id: upsertBody.abilityId,
    class: upsertBody.class,
    spec: upsertBody.spec,
    defensive_spell_id: upsertBody.defensiveSpellId,
    prewarn_seconds: upsertBody.prewarnSeconds ?? 5,
    trigger_type: triggerType,
    bossmod_spell_id: upsertBody.bossmodSpellId ?? null,
    notes: upsertBody.notes ?? null,
    assigned_groups: upsertBody.assignedGroups?.length ? upsertBody.assignedGroups : null,
    updated_at: new Date().toISOString(),
  };

  const hasOwn = (key: keyof UpsertRequest): boolean => Object.prototype.hasOwnProperty.call(upsertBody, key);
  const automaticCreateOnly = !hasOwn('bossmodSpellId') && !hasOwn('notes') && !hasOwn('assignedGroups');

  if (automaticCreateOnly) {
    const { data: inserted, error } = await supabase
      .from('mechanic_defensive_assignments')
      .insert(payload)
      .select('id')
      .single();
    if (error?.code === '23505') {
      return jsonResponse(
        {
          ok: false,
          error: 'La asignación ya existe. AUTO no la ha sobrescrito porque la planificación cambió desde que se cargó la pantalla; recarga Preparación y vuelve a ejecutar la cascada.',
        },
        409,
      );
    }
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, id: inserted.id });
  }

  const { data: upserted, error } = await supabase
    .from('mechanic_defensive_assignments')
    .upsert(payload, { onConflict: 'boss_id,difficulty,ability_id,class,spec' })
    .select('id')
    .single();
  if (error) return jsonResponse({ ok: false, error: error.message }, 500);

  return jsonResponse({ ok: true, id: upserted.id });
});
