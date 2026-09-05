import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  computeDemonstratedPersistentCastSpellIds,
  effectiveDefensiveDataFromDatabaseRows,
  fingerprintTalentBuild,
  normalizeTalentBuild,
  resolveEffectiveDefensiveKit,
  type DefensiveResolutionConfidence,
  type ObservedCastForEvidence,
  type TalentBuildNode,
} from '../_shared/effective-defensives.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

interface RequestBody {
  action?: 'health';
  playerName?: string;
  characterId?: number;
  className?: string;
  specName?: string | null;
  talentBuild?: TalentBuildNode[] | null;
  buildFingerprint?: string | null;
  gameBuild?: string | null;
  gameBuildConfidence?: DefensiveResolutionConfidence;
  includeExternal?: boolean;
}

interface LatestBuildRow {
  player_name: string;
  class: string;
  spec: string;
  talent_build: TalentBuildNode[] | null;
  talent_build_fingerprint: string | null;
  game_build: string | null;
  game_build_source: string | null;
  game_build_confidence: DefensiveResolutionConfidence;
  observed_at: string;
  report_code: string;
  pull_id: string;
}

/** Fila mínima de player_pull_records necesaria para §E2.5 (evidencia de cast persistente). */
interface DefensiveCastPullRow {
  pull_id: string;
  talent_build_fingerprint?: string | null;
  defensive_casts: { spellId?: number; timestampsMs?: number[] }[] | null;
}

const CONFIDENCES = new Set<DefensiveResolutionConfidence>(['verified', 'inferred', 'fallback', 'uncertain']);

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
    return jsonResponse({ ok: true, resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION });
  }
  if (body.playerName != null && (typeof body.playerName !== 'string' || !body.playerName.trim())) {
    return jsonResponse({ ok: false, error: 'playerName inválido' }, 400);
  }
  if (body.className != null && (typeof body.className !== 'string' || !body.className.trim())) {
    return jsonResponse({ ok: false, error: 'className inválido' }, 400);
  }
  if (body.specName != null && (typeof body.specName !== 'string' || !body.specName.trim())) {
    return jsonResponse({ ok: false, error: 'specName inválido' }, 400);
  }
  if (body.characterId != null && (!Number.isInteger(body.characterId) || body.characterId <= 0)) {
    return jsonResponse({ ok: false, error: 'characterId inválido' }, 400);
  }
  if (body.talentBuild !== undefined && body.talentBuild !== null && (!Array.isArray(body.talentBuild) || body.talentBuild.length > 500)) {
    return jsonResponse({ ok: false, error: 'talentBuild debe ser un array de hasta 500 nodos o null' }, 400);
  }
  if (
    Array.isArray(body.talentBuild) &&
    body.talentBuild.some(
      (node) =>
        !node ||
        !Number.isInteger(node.id) ||
        node.id <= 0 ||
        !Number.isInteger(node.nodeID) ||
        node.nodeID <= 0 ||
        !Number.isInteger(node.rank) ||
        node.rank < 0 ||
        (node.spellId != null && (!Number.isInteger(node.spellId) || node.spellId <= 0)),
    )
  ) {
    return jsonResponse({ ok: false, error: 'talentBuild contiene nodos inválidos' }, 400);
  }
  if (body.gameBuild != null && (typeof body.gameBuild !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(body.gameBuild.trim()))) {
    return jsonResponse({ ok: false, error: 'gameBuild inválido' }, 400);
  }
  if (body.buildFingerprint != null && (typeof body.buildFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.buildFingerprint))) {
    return jsonResponse({ ok: false, error: 'buildFingerprint inválido' }, 400);
  }
  if (body.includeExternal != null && typeof body.includeExternal !== 'boolean') {
    return jsonResponse({ ok: false, error: 'includeExternal inválido' }, 400);
  }
  if (body.gameBuildConfidence != null && !CONFIDENCES.has(body.gameBuildConfidence)) {
    return jsonResponse({ ok: false, error: 'gameBuildConfidence inválido' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    let latest: LatestBuildRow | null = null;
    if (body.playerName?.trim()) {
      const { data, error } = await supabase
        .from('player_latest_build')
        .select('*')
        .eq('player_name', body.playerName.trim())
        .maybeSingle();
      if (error) throw error;
      latest = data as LatestBuildRow | null;
    }

    const className = body.className?.trim() || latest?.class || null;
    const specName = body.specName !== undefined ? body.specName?.trim() || null : latest?.spec ?? null;
    const rawTalentBuild = normalizeTalentBuild(body.talentBuild !== undefined ? body.talentBuild : latest?.talent_build ?? null);
    const gameBuild = body.gameBuild !== undefined ? body.gameBuild?.trim() || null : latest?.game_build ?? null;
    const gameBuildConfidence = body.gameBuildConfidence ?? latest?.game_build_confidence ?? 'uncertain';
    const playerName = body.playerName?.trim() || latest?.player_name || null;

    if (!className) return jsonResponse({ ok: false, error: 'className es obligatorio si no existe player_latest_build' }, 400);

    const warnings: string[] = [];
    if (!gameBuild) warnings.push('No hay game_build exacto: las reglas versionadas no pueden considerarse verificadas.');
    if (!rawTalentBuild) warnings.push('No hay talent_build: los talentos y modificadores quedan sin resolver.');
    if (!specName) warnings.push('No hay spec resuelta: los defensivos exclusivos de spec quedan con confidence uncertain.');

    const catalogPromise = supabase
      .from('cooldown_catalog')
      .select('class,spec,spec_override,spell_id,name,category,survival_type,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,excluded')
      .eq('class', className)
      .eq('excluded', false);
    const profilesPromise = supabase.from('defensive_spec_profiles').select('*').eq('class', className);
    const rulesPromise = supabase.from('defensive_modifier_rules').select('*').eq('class', className).eq('active', true);
    // Se cargan en batch los overrides del alcance clase/build y el resolver
    // puro selecciona la identidad exacta. Así un characterId sigue
    // encontrando también el override global por nombre, sin construir un
    // filtro PostgREST con texto proporcionado por el cliente.
    const overridesPromise = playerName && gameBuild
      ? supabase.from('player_defensive_overrides').select('*').eq('class', className).eq('game_build', gameBuild).eq('active', true)
      : Promise.resolve({ data: [], error: null });
    const talentLookupPromise = gameBuild
      ? supabase.from('talent_spell_lookup').select('entry_to_spell,known_entry_ids').eq('build', gameBuild).maybeSingle()
      : Promise.resolve({ data: null, error: null });
    // §E2 (iris-defensive-canonicalization-v1-plan.md — "Conectar
    // resolve-player-defensive-kit a semantic catalog/rules"): la VISTA ya
    // trae class resuelto, igual que cooldown_catalog. defensive_semantic_rules
    // no tiene columna class propia (una regla vive por spellId, no por
    // clase) — se carga completa (tabla pequeña, ~120 filas) y es
    // resolveEffectiveDefensiveKit() quien filtra por targetSpellId/spec/
    // gameBuild; el endpoint no reimplementa esa lógica.
    const semanticsPromise = supabase.from('defensive_ability_semantic_catalog').select('*').eq('class', className);
    const semanticRulesPromise = supabase.from('defensive_semantic_rules').select('*');

    const [catalogResult, profilesResult, rulesResult, overridesResult, talentLookupResult, semanticsResult, semanticRulesResult] = await Promise.all([
      catalogPromise,
      profilesPromise,
      rulesPromise,
      overridesPromise,
      talentLookupPromise,
      semanticsPromise,
      semanticRulesPromise,
    ]);
    for (const result of [catalogResult, profilesResult, rulesResult, overridesResult, talentLookupResult, semanticsResult, semanticRulesResult]) {
      if (result.error) throw result.error;
    }

    const resolverData = effectiveDefensiveDataFromDatabaseRows({
      catalogRows: catalogResult.data ?? [],
      specProfileRows: profilesResult.data ?? [],
      modifierRuleRows: rulesResult.data ?? [],
      overrideRows: overridesResult.data ?? [],
      semanticRows: semanticsResult.data ?? [],
      semanticRuleRows: semanticRulesResult.data ?? [],
    });

    const entryToSpell = talentLookupResult.data?.entry_to_spell as Record<string, number> | undefined;
    const lookupValues = entryToSpell ? Object.values(entryToSpell) : null;
    const allTalentSpellIds = lookupValues ? new Set(lookupValues.map(Number).filter((value) => Number.isInteger(value) && value > 0)) : null;
    if (gameBuild && !allTalentSpellIds) warnings.push(`No existe talent_spell_lookup para ${gameBuild}; eligibility puede quedar en fallback.`);
    // §E2.1: TraitNodeEntry conocidos del DB2, resuelvan o no a spell — sin
    // esto un nodo estructural (p. ej. selector de Hero Talents) se trata
    // como "genuinamente sin resolver" y bloquea buildPresence='absent'
    // para TODO el build (ver known_entry_ids en talent_spell_lookup).
    const knownEntryIdsRaw = talentLookupResult.data?.known_entry_ids as number[] | undefined;
    const knownTalentEntryIds = knownEntryIdsRaw?.length ? new Set(knownEntryIdsRaw) : null;

    // Los nodos persistidos por versiones anteriores pueden no llevar
    // spellId. El id de WCL es TraitNodeEntry.ID, justo la clave del lookup.
    // Se enriquece antes del fingerprint para que la misma build produzca la
    // misma identidad independientemente de cuándo se importó el pull.
    const talentBuild = normalizeTalentBuild(
      rawTalentBuild?.map((node) => {
        const resolvedSpellId = gameBuild ? (node.spellId ?? (entryToSpell ? Number(entryToSpell[String(node.id)]) : undefined)) : undefined;
        return typeof resolvedSpellId === 'number' && Number.isInteger(resolvedSpellId) && resolvedSpellId > 0
          ? { ...node, spellId: resolvedSpellId }
          : { id: node.id, nodeID: node.nodeID, rank: node.rank };
      }) ?? null,
    );
    const computedFingerprint = gameBuild ? await fingerprintTalentBuild(className, specName, gameBuild, talentBuild) : null;
    if (body.buildFingerprint && computedFingerprint && body.buildFingerprint !== computedFingerprint) {
      warnings.push('buildFingerprint no coincide con el payload normalizado; se usa el fingerprint calculado por backend.');
    }
    const buildFingerprint = gameBuild ? (computedFingerprint ?? body.buildFingerprint ?? latest?.talent_build_fingerprint ?? null) : null;

    const resolverInput = {
      className,
      specName,
      talentBuild,
      buildFingerprint,
      gameBuild,
      gameBuildConfidence,
      playerIdentity: playerName ? { characterId: body.characterId, playerName } : undefined,
      includeExternal: body.includeExternal,
      allTalentSpellIds,
      talentLookupComplete: allTalentSpellIds != null,
      knownTalentEntryIds,
    };

    // §E2.5 "Acquisition Safety Closure": primera resolución SIN evidencia de
    // cast — necesaria para el "persistent ability guard" (activationMode/
    // unresolvedRuntimeRules por spellId, ver computeDemonstratedPersistentCastSpellIds).
    const firstPassKit = resolveEffectiveDefensiveKit(resolverInput, resolverData);

    // Casts reales: same-pull (este mismo pull_id) + cross-pull con el MISMO
    // talent_build_fingerprint exacto no nulo, misma clase/spec/game_build
    // (§E2.5 — nunca se propaga evidencia entre fingerprints distintos ni se
    // usa un pull sin fingerprintar como prueba de build). Best-effort: un
    // fallo aquí nunca bloquea la resolución, solo la deja sin evidencia de
    // cast (degrada a la primera pasada, fail-closed).
    let demonstratedPersistentCastSpellIds: ReturnType<typeof computeDemonstratedPersistentCastSpellIds> | null = null;
    try {
      const samePullPromise = playerName && latest?.pull_id
        ? supabase.from('player_pull_records').select('pull_id,talent_build_fingerprint,defensive_casts').eq('pull_id', latest.pull_id).eq('player_name', playerName).maybeSingle()
        : Promise.resolve({ data: null, error: null });
      const crossPullPromise = playerName && gameBuild && buildFingerprint
        ? supabase
            .from('player_pull_records')
            .select('pull_id,talent_build_fingerprint,defensive_casts')
            .eq('player_name', playerName)
            .eq('class', className)
            .eq('game_build', gameBuild)
            .eq('talent_build_fingerprint', buildFingerprint)
            .not('talent_build_fingerprint', 'is', null)
            .limit(200)
        : Promise.resolve({ data: [], error: null });
      const [samePullResult, crossPullResult] = await Promise.all([samePullPromise, crossPullPromise]);
      if (samePullResult.error) throw samePullResult.error;
      if (crossPullResult.error) throw crossPullResult.error;

      const observedCasts: ObservedCastForEvidence[] = [];
      const pushCastsFromRow = (row: DefensiveCastPullRow, samePull: boolean) => {
        for (const cast of row.defensive_casts ?? []) {
          if (typeof cast.spellId !== 'number' || !(cast.timestampsMs?.length)) continue; // solo casts realmente observados, nunca "elegible pero nunca lanzado"
          observedCasts.push({ spellId: cast.spellId, samePull, pullTalentBuildFingerprint: samePull ? null : (row.talent_build_fingerprint ?? null) });
        }
      };
      const samePullRow = samePullResult.data as DefensiveCastPullRow | null;
      if (samePullRow) pushCastsFromRow(samePullRow, true);
      for (const row of (crossPullResult.data ?? []) as DefensiveCastPullRow[]) {
        if (row.pull_id === latest?.pull_id) continue; // ya cubierto arriba como same-pull
        pushCastsFromRow(row, false);
      }

      if (observedCasts.length) {
        demonstratedPersistentCastSpellIds = computeDemonstratedPersistentCastSpellIds(observedCasts, buildFingerprint, firstPassKit);
      }
    } catch (err) {
      warnings.push(`No se pudo cargar evidencia de cast persistente (no bloqueante): ${errorMessage(err)}`);
    }

    // Segunda resolución CON la evidencia de cast validada — no-op total si
    // no se encontró ninguna (demonstratedPersistentCastSpellIds queda null).
    const kit = demonstratedPersistentCastSpellIds?.size
      ? resolveEffectiveDefensiveKit({ ...resolverInput, demonstratedPersistentCastSpellIds }, resolverData)
      : firstPassKit;

    return jsonResponse({
      ok: true,
      kit,
      sourceBuild: {
        fingerprint: buildFingerprint,
        gameBuild,
        source: latest?.game_build_source ?? null,
        observedAt: latest?.observed_at ?? null,
        confidence: gameBuildConfidence,
        reportCode: latest?.report_code ?? null,
        pullId: latest?.pull_id ?? null,
      },
      resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
      warnings,
    });
  } catch (err) {
    console.error('resolve-player-defensive-kit error:', err);
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
