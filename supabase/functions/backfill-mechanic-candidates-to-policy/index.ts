import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

interface CandidateRow {
  id: string;
  boss_id: string;
  difficulty: string;
  ability_id: number | null;
  mechanic_key: string | null;
  name: string;
  category: string | null;
  responsibility: string | null;
  created_at: string;
}

function responsibilityModeFromLegacy(
  responsibility: CandidateRow['responsibility'],
): 'target' | 'tank_role' | 'healer_role' | 'dps_role' | 'raid' | 'none' {
  switch (responsibility) {
    case 'tank':
      return 'tank_role';
    case 'healer':
      return 'healer_role';
    case 'dps':
      return 'dps_role';
    case 'personal':
      return 'target';
    case 'raid':
      return 'raid';
    default:
      return 'none';
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // La vista conserva el criterio de aplicabilidad por dificultad sin
    // depender de una columna legacy `excluded` que esta tabla no tiene.
    const { data: candidates, error: readErr } = await client
      .from('applicable_boss_mechanics_candidates')
      .select('*')
      .not('ability_id', 'is', null);

    if (readErr) throw readErr;

    if (!candidates || candidates.length === 0) {
      return jsonResponse({
        ok: true,
        action: 'backfill_mechanic_candidates_to_policy',
        totalCandidates: 0,
        policiesCreated: 0,
        aliasesCreated: 0,
        message: 'No hay candidates aplicables con ability_id para generar policies.',
      });
    }

    const now = new Date().toISOString();
    const policiesToInsert: any[] = [];
    const aliasesToInsert: any[] = [];
    const bossesSeen = new Set<string>();

    for (const candidate of candidates as CandidateRow[]) {
      const mechanicKey = candidate.mechanic_key ?? `ability:${candidate.ability_id}`;
      if (!candidate.mechanic_key) {
        const { error: keyError } = await client
          .from('boss_mechanics_candidates')
          .update({ mechanic_key: mechanicKey })
          .eq('id', candidate.id);
        if (keyError) throw keyError;
      }
      const key = `${candidate.boss_id}/${candidate.difficulty}/${mechanicKey}`;
      const responsibilityMode = responsibilityModeFromLegacy(candidate.responsibility);

      // Crear una policy por candidato única (una sola vez por clave)
      if (!bossesSeen.has(key)) {
        bossesSeen.add(key);
        policiesToInsert.push({
          boss_id: candidate.boss_id,
          difficulty: candidate.difficulty,
          mechanic_key: mechanicKey,
          policy_version: 1,
          display_name: candidate.name?.trim() || mechanicKey,
          display_category: candidate.category || null,
          targeting_mode: 'none',
          required_response: null,
          responsibility_mode: responsibilityMode,
          damage_semantics: 'none',
          failure_propagation: 'none',
          assignment_mode: 'none',
          defensive_expectation: 'none',
          credit_scope: 'none',
          penalty_scope: 'none',
          causal_rule: {},
          confidence: 'fallback',
          provenance: { source: 'legacy_backfill', from_candidates: true },
          verified_at: null,
          reviewed_by: guard.userId,
          created_by: guard.userId,
          created_at: now,
          updated_at: now,
        });
      }

      // Crear alias si tiene ability_id
      if (candidate.ability_id) {
        aliasesToInsert.push({
          boss_id: candidate.boss_id,
          difficulty: candidate.difficulty,
          mechanic_key: mechanicKey,
          ability_id: candidate.ability_id,
          normalized_name: null,
          source: 'legacy',
          confidence: 'fallback',
          provenance: { from_candidates: true },
          active: true,
          created_by: guard.userId,
          created_at: now,
          updated_at: now,
        });
      }
    }

    // UPSERT policies
    let policiesCreated = 0;
    if (policiesToInsert.length > 0) {
      const { error: policyErr } = await client
        .from('boss_mechanic_policy')
        .upsert(policiesToInsert, {
          onConflict: 'boss_id,difficulty,mechanic_key',
          ignoreDuplicates: true,
        });

      if (policyErr) throw policyErr;
      policiesCreated = policiesToInsert.length;
    }

    // M12 define uniques parciales por ability_id/nombre activo, no un
    // conflicto compuesto que PostgREST pueda usar en UPSERT. Se omiten
    // identidades ya activas para preservar su mechanic_key canónica.
    let aliasesCreated = 0;
    if (aliasesToInsert.length > 0) {
      const { data: existingAliases, error: existingErr } = await client
        .from('boss_mechanic_aliases')
        .select('boss_id,difficulty,ability_id')
        .eq('active', true)
        .in('ability_id', aliasesToInsert.map((alias) => alias.ability_id));
      if (existingErr) throw existingErr;
      const existingKeys = new Set(
        (existingAliases ?? []).map((alias) => `${alias.boss_id}:${alias.difficulty}:${alias.ability_id}`),
      );
      const aliasesToCreate = aliasesToInsert.filter(
        (alias) => !existingKeys.has(`${alias.boss_id}:${alias.difficulty}:${alias.ability_id}`),
      );
      if (aliasesToCreate.length) {
        const { error: aliasErr } = await client.from('boss_mechanic_aliases').insert(aliasesToCreate);
        if (aliasErr) throw aliasErr;
      }
      aliasesCreated = aliasesToCreate.length;
    }

    return jsonResponse({
      ok: true,
      action: 'backfill_mechanic_candidates_to_policy',
      totalCandidates: candidates.length,
      policiesCreated,
      aliasesCreated,
      message: `Se realizó backfill de ${policiesCreated} políticas y ${aliasesCreated} aliases desde legacy candidates.`,
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error('backfill-mechanic-candidates-to-policy error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
