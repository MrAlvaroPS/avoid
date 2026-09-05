import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import {
  effectiveDefensiveDataFromDatabaseRows,
  fingerprintTalentBuild,
  normalizeTalentBuild,
  resolveEffectiveDefensiveKit,
  type DefensiveResolutionConfidence,
  type TalentBuildNode,
} from '../_shared/effective-defensives.ts';

interface RequestBody {
  action?: 'health' | 'save' | 'deactivate';
  characterId?: number;
  playerName?: string;
  className?: string;
  specName?: string | null;
  spellId?: number;
  gameBuild?: string;
  buildFingerprint?: string;
  effectiveCooldownMs?: number | null;
  effectiveDurationMs?: number | null;
  reason?: string;
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
    return jsonResponse({ ok: true, overrideVersion: 'exact-player-defensive-override@1.0.0' });
  }
  const action = body.action ?? 'save';
  const playerName = body.playerName?.trim() ?? '';
  const className = body.className?.trim() ?? '';
  const specName = body.specName?.trim() || null;
  const gameBuild = body.gameBuild?.trim() ?? '';
  const buildFingerprint = body.buildFingerprint?.trim() ?? '';
  const reason = body.reason?.trim() ?? '';
  if (!['save', 'deactivate'].includes(action)) return jsonResponse({ ok: false, error: 'action inválida' }, 400);
  if (!Number.isInteger(body.characterId) || body.characterId! <= 0) return jsonResponse({ ok: false, error: 'characterId inválido' }, 400);
  if (!playerName || !className || !specName) return jsonResponse({ ok: false, error: 'playerName, className y specName son obligatorios' }, 400);
  if (!Number.isInteger(body.spellId) || body.spellId! <= 0) return jsonResponse({ ok: false, error: 'spellId inválido' }, 400);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(gameBuild)) return jsonResponse({ ok: false, error: 'gameBuild exacto inválido' }, 400);
  if (!/^sha256:[a-f0-9]{64}$/.test(buildFingerprint)) return jsonResponse({ ok: false, error: 'buildFingerprint exacto inválido' }, 400);
  if (!reason) return jsonResponse({ ok: false, error: 'El motivo auditable es obligatorio' }, 400);
  for (const [field, value] of [
    ['effectiveCooldownMs', body.effectiveCooldownMs],
    ['effectiveDurationMs', body.effectiveDurationMs],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 0)) return jsonResponse({ ok: false, error: `${field} inválido` }, 400);
  }
  if (action === 'save' && body.effectiveCooldownMs == null && body.effectiveDurationMs == null) {
    return jsonResponse({ ok: false, error: 'Debe corregirse cooldown o duración' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const { data: latest, error: latestError } = await supabase
      .from('player_latest_build')
      .select('*')
      .eq('player_name', playerName)
      .maybeSingle();
    if (latestError) throw latestError;
    if (!latest) return jsonResponse({ ok: false, error: 'No existe un build observado para este jugador' }, 409);
    if (latest.class !== className || latest.spec !== specName) {
      return jsonResponse({ ok: false, error: 'La clase/spec observada cambió; vuelve a seleccionar el jugador' }, 409);
    }
    if (latest.game_build !== gameBuild) {
      return jsonResponse({ ok: false, error: 'El game_build observado cambió; el override anterior está stale' }, 409);
    }

    const { data: lookup, error: lookupError } = await supabase
      .from('talent_spell_lookup')
      .select('entry_to_spell,known_entry_ids')
      .eq('build', gameBuild)
      .maybeSingle();
    if (lookupError) throw lookupError;
    const entryToSpell = lookup?.entry_to_spell as Record<string, number> | undefined;
    if (!entryToSpell) return jsonResponse({ ok: false, error: `Falta talent_spell_lookup exacto para ${gameBuild}` }, 409);
    // §E2.1: ver knownTalentEntryIds en effective-defensives.ts.
    const knownEntryIdsRaw = lookup?.known_entry_ids as number[] | undefined;
    const knownTalentEntryIds = knownEntryIdsRaw?.length ? new Set(knownEntryIdsRaw) : null;
    const talentBuild = normalizeTalentBuild(
      (latest.talent_build as TalentBuildNode[] | null)?.map((node) => {
        const spellId = node.spellId ?? Number(entryToSpell[String(node.id)]);
        return Number.isInteger(spellId) && spellId > 0 ? { ...node, spellId } : node;
      }) ?? null,
    );
    const computedFingerprint = await fingerprintTalentBuild(className, specName, gameBuild, talentBuild);
    if (!computedFingerprint || computedFingerprint !== buildFingerprint || (latest.talent_build_fingerprint && latest.talent_build_fingerprint !== computedFingerprint)) {
      return jsonResponse({ ok: false, error: 'El fingerprint observado cambió; recarga el kit antes de guardar' }, 409);
    }

    const [catalogResult, profilesResult, rulesResult] = await Promise.all([
      supabase
        .from('cooldown_catalog')
        .select('class,spec,spec_override,spell_id,name,category,survival_type,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,excluded')
        .eq('class', className)
        .eq('excluded', false),
      supabase.from('defensive_spec_profiles').select('*').eq('class', className),
      supabase.from('defensive_modifier_rules').select('*').eq('class', className).eq('active', true),
    ]);
    for (const result of [catalogResult, profilesResult, rulesResult]) if (result.error) throw result.error;
    const automaticKit = resolveEffectiveDefensiveKit(
      {
        className,
        specName,
        talentBuild,
        buildFingerprint: computedFingerprint,
        gameBuild,
        gameBuildConfidence: latest.game_build_confidence as DefensiveResolutionConfidence,
        playerIdentity: { characterId: body.characterId, playerName },
        includeExternal: true,
        allTalentSpellIds: new Set(Object.values(entryToSpell).map(Number).filter((value) => Number.isInteger(value) && value > 0)),
        talentLookupComplete: true,
        knownTalentEntryIds,
      },
      effectiveDefensiveDataFromDatabaseRows({
        catalogRows: catalogResult.data ?? [],
        specProfileRows: profilesResult.data ?? [],
        modifierRuleRows: rulesResult.data ?? [],
        overrideRows: [],
      }),
    );
    const automatic = automaticKit.find((entry) => entry.spellId === body.spellId);
    if (!automatic || !automatic.eligible) return jsonResponse({ ok: false, error: 'El defensivo no pertenece al kit efectivo actual' }, 409);

    const { data: override, error: saveError } = await supabase.rpc('save_exact_player_defensive_override', {
      p_character_id: body.characterId,
      p_player_name: playerName,
      p_class: className,
      p_spec: specName,
      p_spell_id: body.spellId,
      p_game_build: gameBuild,
      p_build_fingerprint: computedFingerprint,
      p_effective_cooldown_ms: action === 'save' ? (body.effectiveCooldownMs ?? null) : null,
      p_effective_duration_ms: action === 'save' ? (body.effectiveDurationMs ?? null) : null,
      p_automatic_cooldown_ms: automatic.effectiveCooldownMs,
      p_automatic_duration_ms: automatic.effectiveDurationMs,
      p_reason: reason,
      p_changed_by: guard.userId,
      p_active: action === 'save',
    });
    if (saveError) throw saveError;
    return jsonResponse({
      ok: true,
      action,
      override,
      automatic: {
        effectiveCooldownMs: automatic.effectiveCooldownMs,
        effectiveDurationMs: automatic.effectiveDurationMs,
      },
      historicalReanalysisScheduled: false,
      draftInvalidated: true,
    });
  } catch (err) {
    console.error('manage-player-defensive-override error:', err);
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
