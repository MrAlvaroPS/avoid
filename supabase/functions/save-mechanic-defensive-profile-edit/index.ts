import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §Persiste los campos MANUALES de boss_mechanic_defensive_profile —
// requires_defensive/requires_group_split/group_split_notes/reviewed. Los
// campos reference_* SOLO los escribe sync-mechanic-defensive-profile,
// nunca esta función (mismo contrato que category/avoidable en
// boss_mechanics_candidates frente a sync-boss-mechanics, ver
// save-mechanic-edit). upsert (no update): la fila puede no existir todavía
// si nadie ha sincronizado este boss+dificultad — marcar a mano
// requires_group_split antes de tener evidencia de logs es un caso real
// (una mecánica de posicionamiento que un humano ya sabe que exige turnos,
// sin depender del sync). Al hacer upsert especificando solo estas
// columnas, un conflicto NO toca reference_* — Postgres/PostgREST solo
// actualiza las columnas presentes en el payload.

interface EditRequest {
  bossId: string;
  difficulty: string;
  abilityId: number;
  requiresDefensive?: boolean | null;
  requiresGroupSplit?: boolean;
  groupSplitNotes?: string | null;
  reviewed?: boolean;
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
  if (!body.bossId || !body.difficulty || !body.abilityId) {
    return jsonResponse({ ok: false, error: 'bossId, difficulty y abilityId son obligatorios' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const patch: Record<string, unknown> = {
    boss_id: body.bossId,
    difficulty: body.difficulty,
    ability_id: body.abilityId,
    updated_at: new Date().toISOString(),
  };
  // Presencia en el body, no verdad del valor — mismo bug real ya arreglado
  // en save-mechanic-edit (volver a poner algo a null/false es una edición
  // legítima, se distingue de "no tocado" por si la clave vino o no).
  if ('requiresDefensive' in body) {
    patch['requires_defensive'] = body.requiresDefensive ?? null;
    patch['requires_defensive_source'] = body.requiresDefensive == null ? null : 'manual_override';
  }
  if ('requiresGroupSplit' in body) patch['requires_group_split'] = body.requiresGroupSplit ?? false;
  if ('groupSplitNotes' in body) patch['group_split_notes'] = body.groupSplitNotes ?? null;
  if ('reviewed' in body) patch['reviewed'] = body.reviewed ?? false;

  const { error } = await supabase.from('boss_mechanic_defensive_profile').upsert(patch, { onConflict: 'boss_id,difficulty,ability_id' });
  if (error) return jsonResponse({ ok: false, error: error.message }, 500);

  return jsonResponse({ ok: true });
});
