import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import type { MechanicAliasContract } from '../_shared/combat-evaluation-contract.ts';

interface AliasUpsertRequest {
  ability_id?: number | null;
  normalized_name?: string | null;
  source: 'journal' | 'wcl' | 'manual' | 'classifier' | 'legacy';
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  active?: boolean;
}

interface Body {
  bossId?: unknown;
  difficulty?: unknown;
  mechanicKey?: unknown;
  aliases?: unknown;
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
  if (typeof body.mechanicKey !== 'string' || !body.mechanicKey) {
    return jsonResponse({ ok: false, error: 'mechanicKey es obligatorio.' }, 400);
  }
  if (!Array.isArray(body.aliases) || body.aliases.length === 0) {
    return jsonResponse({ ok: false, error: 'aliases debe ser un array no vacío.' }, 400);
  }

  const aliases = body.aliases as AliasUpsertRequest[];

  // Validar cada alias
  for (let i = 0; i < aliases.length; i++) {
    const alias = aliases[i];
    if (!alias.source || !alias.confidence) {
      return jsonResponse({ ok: false, error: `alias[${i}]: source y confidence son obligatorios.` }, 400);
    }
    if (alias.ability_id == null && !alias.normalized_name) {
      return jsonResponse(
        { ok: false, error: `alias[${i}]: debe tener ability_id o normalized_name.` },
        400,
      );
    }
    if (alias.confidence === 'uncertain' && alias.active !== false) {
      return jsonResponse(
        { ok: false, error: `alias[${i}]: confidence='uncertain' solo permite active=false.` },
        400,
      );
    }
  }

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const result: MechanicAliasContract[] = [];
    for (const alias of aliases) {
      const values = {
      boss_id: body.bossId,
      difficulty: body.difficulty,
      mechanic_key: body.mechanicKey,
      ability_id: alias.ability_id ?? null,
      normalized_name: alias.normalized_name ?? null,
      source: alias.source,
      confidence: alias.confidence,
      active: alias.active !== false,
      };
      let existing: Record<string, unknown> | null = null;
      if (values.ability_id != null) {
        const { data, error } = await client
          .from('boss_mechanic_aliases')
          .select('*')
          .eq('boss_id', body.bossId)
          .eq('difficulty', body.difficulty)
          .eq('ability_id', values.ability_id)
          .eq('active', true)
          .maybeSingle();
        if (error) throw error;
        existing = data as Record<string, unknown> | null;
      }
      if (!existing && values.normalized_name) {
        const { data, error } = await client
          .from('boss_mechanic_aliases')
          .select('*')
          .eq('boss_id', body.bossId)
          .eq('difficulty', body.difficulty)
          .eq('normalized_name', values.normalized_name)
          .eq('active', true)
          .maybeSingle();
        if (error) throw error;
        existing = data as Record<string, unknown> | null;
      }
      const write = existing
        ? client.from('boss_mechanic_aliases').update(values).eq('id', existing['id'])
        : client.from('boss_mechanic_aliases').insert(values);
      const { data, error } = await write.select('*').single();
      if (error) throw error;
      result.push(rowToAlias(data as Record<string, unknown>));
    }

    return jsonResponse({
      ok: true,
      action: 'sync_mechanic_aliases',
      bossId: body.bossId,
      difficulty: body.difficulty,
      mechanicKey: body.mechanicKey,
      synced: result.length,
      aliases: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('sync-mechanic-aliases error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
