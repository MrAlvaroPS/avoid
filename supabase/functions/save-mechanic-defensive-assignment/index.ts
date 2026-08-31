import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §Única puerta de escritura de mechanic_defensive_assignments (RLS de solo
// lectura, ver migración 20260830130000) — mismo patrón que
// save-unassigned-mechanic-edit. Crear/editar es un único upsert sobre la
// unique key real (boss_id, difficulty, ability_id, class, spec): la
// pantalla ya piensa en "un hueco de asignación por mecánica+spec", no en
// ids opacos — más simple para el cliente que id-based create/update.
// Borrado sigue siendo por `id` (`delete: true`).

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

  const { data: upserted, error } = await supabase
    .from('mechanic_defensive_assignments')
    .upsert(
      {
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
      },
      { onConflict: 'boss_id,difficulty,ability_id,class,spec' },
    )
    .select('id')
    .single();
  if (error) return jsonResponse({ ok: false, error: error.message }, 500);

  return jsonResponse({ ok: true, id: upserted.id });
});
