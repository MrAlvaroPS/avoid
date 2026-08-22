import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

interface EditRequest {
  bossId: string;
  difficulty: string;
  abilityId: number;
  category?: string | null;
  avoidable?: boolean | null;
  expectedResponse?: { type: string; scope: string } | null;
  severityThreshold?: number | null;
  reviewed?: boolean;
}

const VALID_CATEGORIES = new Set([
  'tankbuster',
  'raid-damage',
  'avoidable-ground',
  'debuff-stack',
  'interrupt',
  'soak',
  'spread',
]);

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error } = await supabase
    .from('boss_mechanics_candidates')
    .update({
      category: body.category ?? null,
      avoidable: body.avoidable ?? null,
      expected_response: body.expectedResponse ?? null,
      severity_threshold: body.severityThreshold ?? null,
      reviewed: body.reviewed ?? true,
      updated_at: new Date().toISOString(),
    })
    .eq('boss_id', body.bossId)
    .eq('difficulty', body.difficulty)
    .eq('ability_id', body.abilityId);

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
});
