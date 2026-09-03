import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §"si a Gusmi le marco que tiene Barkskin y Frenzied Regeneration, no tiene
// sentido que cada vez que entre en Gusmi tenga que quitarle el check de
// Ironfur y ponerle el check de Frenzied Regeneration" (feedback real,
// 2026-09-03): único punto de escritura de player_planning_resource_
// selections (RLS de solo lectura, ver migración 20260903120000). Reemplaza
// SIEMPRE el conjunto completo de spellIds seleccionados — el cliente ya
// materializa el conjunto entero antes de llamar, nunca manda un diff.

interface RequestBody {
  action?: 'health';
  characterId?: number | null;
  playerName?: string;
  className?: string;
  selectedSpellIds?: number[];
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (body.action === 'health') {
    return jsonResponse({ ok: true, selectionVersion: 'planning-resource-selection@1.0.0' });
  }

  const playerName = body.playerName?.trim() ?? '';
  const className = body.className?.trim() ?? '';
  const characterId = body.characterId ?? null;
  if (!playerName) return jsonResponse({ ok: false, error: 'playerName es obligatorio' }, 400);
  if (!className) return jsonResponse({ ok: false, error: 'className es obligatorio' }, 400);
  if (characterId != null && (!Number.isInteger(characterId) || characterId <= 0)) {
    return jsonResponse({ ok: false, error: 'characterId inválido' }, 400);
  }
  if (
    !Array.isArray(body.selectedSpellIds) ||
    body.selectedSpellIds.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    return jsonResponse({ ok: false, error: 'selectedSpellIds debe ser un array de spellId válidos' }, 400);
  }
  const selectedSpellIds = [...new Set(body.selectedSpellIds)].sort((a, b) => a - b);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const { data, error } = await supabase.rpc('save_planning_resource_selection', {
      p_character_id: characterId,
      p_player_name: playerName,
      p_class: className,
      p_selected_spell_ids: selectedSpellIds,
      p_changed_by: guard.userId,
    });
    if (error) throw error;
    return jsonResponse({ ok: true, selection: data });
  } catch (err) {
    console.error('save-planning-resource-selection error:', err);
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
