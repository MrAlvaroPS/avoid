import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import type { MechanicIdentityResolutionResult, MechanicAliasContract } from '../_shared/combat-evaluation-contract.ts';

interface Body {
  bossId?: unknown;
  difficulty?: unknown;
  ability_id?: unknown;
  normalized_name?: unknown;
}

function rowToAlias(row: Record<string, unknown>): MechanicAliasContract {
  return {
    id: row['id'] as string,
    bossId: row['boss_id'] as string,
    difficulty: row['difficulty'] as string,
    mechanicKey: row['mechanic_key'] as string,
    abilityId: row['ability_id'] as number | null,
    normalizedName: row['normalized_name'] as string | null,
    source: row['source'] as any,
    confidence: row['confidence'] as any,
    active: row['active'] as boolean,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido.' }, 400);
  }

  if (typeof body.bossId !== 'string' || !body.bossId) {
    return jsonResponse({ ok: false, error: 'bossId es obligatorio.' }, 400);
  }
  if (typeof body.difficulty !== 'string' || !body.difficulty) {
    return jsonResponse({ ok: false, error: 'difficulty es obligatorio.' }, 400);
  }

  const abilityId = typeof body.ability_id === 'number' ? body.ability_id : null;
  const normalizedName = typeof body.normalized_name === 'string' ? body.normalized_name.trim() : null;

  if (abilityId == null && !normalizedName) {
    return jsonResponse(
      { ok: false, error: 'Debes proporcionar ability_id o normalized_name.' },
      400,
    );
  }

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    let query = client
      .from('boss_mechanic_aliases')
      .select('*')
      .eq('boss_id', body.bossId)
      .eq('difficulty', body.difficulty)
      .eq('active', true)
      .order('confidence', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);

    if (abilityId != null) {
      query = query.eq('ability_id', abilityId);
    } else if (normalizedName) {
      query = query.ilike('normalized_name', normalizedName);
    }

    const { data, error } = await query;

    if (error) throw error;

    if (!data || data.length === 0) {
      return jsonResponse(
        {
          ok: false,
          error: `No se encontró mechanic en ${body.bossId}/${body.difficulty} para ability_id=${abilityId} o nombre="${normalizedName}".`,
        },
        404,
      );
    }

    const alias = rowToAlias(data[0] as Record<string, unknown>);
    const result: MechanicIdentityResolutionResult = {
      mechanicKey: alias.mechanicKey,
      abilityId: alias.abilityId,
      normalizedName: alias.normalizedName,
      source: alias.source,
      confidence: alias.confidence,
      aliasId: alias.id,
    };

    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('resolve-mechanic-identity error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
