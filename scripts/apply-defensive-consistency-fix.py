from pathlib import Path
import argparse

ROOT = Path('.')


def replace_exact(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly 1 occurrence, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new))


def write_new(path: str, content: str) -> None:
    p = ROOT / path
    if p.exists():
        raise SystemExit(f'{path}: already exists')
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def step1() -> None:
    # Version bump: this is an observable effective-kit/materialization contract change.
    replace_exact(
        'supabase/functions/_shared/effective-defensives.ts',
        "export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION = 'effective-defensives@2.3.0';",
        "export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION = 'effective-defensives@2.4.0';",
    )

    helper = r'''import {
  computeDemonstratedPersistentCastSpellIds,
  resolveEffectiveDefensiveKit,
  type EffectiveDefensiveData,
  type ResolveDefensiveKitInput,
  type ResolvedDefensive,
} from './effective-defensives.ts';
import { mergeObservedCastEvidenceV6 } from './defensive-evidence-v6.ts';

const PAGE_SIZE = 1_000;

export interface StoredDefensiveCastEvidenceRow {
  pull_id: string;
  talent_build_fingerprint: string | null;
  defensive_casts: { spellId?: number; timestampsMs?: number[] }[] | null;
}

export function storedDefensiveCastRowsToObservedEvidence(
  rows: readonly StoredDefensiveCastEvidenceRow[],
  currentPullId: string,
  fingerprint: string | null,
): { spellId: number; samePull: boolean; pullTalentBuildFingerprint: string | null }[] {
  const out: { spellId: number; samePull: boolean; pullTalentBuildFingerprint: string | null }[] = [];
  for (const row of rows) {
    const samePull = row.pull_id === currentPullId;
    if (!samePull && (!fingerprint || row.talent_build_fingerprint !== fingerprint)) continue;
    for (const cast of row.defensive_casts ?? []) {
      if (!Number.isInteger(cast?.spellId) || !Array.isArray(cast?.timestampsMs) || !cast.timestampsMs.length) continue;
      out.push({
        spellId: Number(cast.spellId),
        samePull,
        pullTalentBuildFingerprint: samePull ? null : row.talent_build_fingerprint ?? null,
      });
    }
  }
  return out;
}

export function resolveEffectiveDefensiveKitFromObservedCastEvidence(params: {
  input: ResolveDefensiveKitInput;
  data: EffectiveDefensiveData;
  storedRows: readonly StoredDefensiveCastEvidenceRow[];
  currentPullId: string;
  liveSpellIds: readonly number[];
}): {
  kit: ResolvedDefensive[];
  firstPassKit: ResolvedDefensive[];
  demonstratedSpellIds: ReadonlyMap<number, 'observed_cast_same_pull' | 'observed_cast_same_build_fingerprint'>;
} {
  const firstPassKit = resolveEffectiveDefensiveKit(params.input, params.data);
  const stored = storedDefensiveCastRowsToObservedEvidence(
    params.storedRows,
    params.currentPullId,
    params.input.buildFingerprint,
  );
  const observed = mergeObservedCastEvidenceV6(stored, params.liveSpellIds);
  const demonstratedSpellIds = computeDemonstratedPersistentCastSpellIds(
    observed,
    params.input.buildFingerprint,
    firstPassKit,
  );
  const kit = demonstratedSpellIds.size
    ? resolveEffectiveDefensiveKit(
        { ...params.input, demonstratedPersistentCastSpellIds: demonstratedSpellIds },
        params.data,
      )
    : firstPassKit;
  return { kit, firstPassKit, demonstratedSpellIds };
}

/**
 * Single authoritative observed-cast path for analyze/reanalyze.
 *
 * Historical evidence is deliberately scoped by exact player + game build +
 * non-null exact talent fingerprint. It is paginated rather than relying on
 * Supabase's 1,000-row default, so a long-lived character cannot silently lose
 * acquisition evidence. Live WCL spell ids are merged as same-pull evidence.
 */
export async function resolveEffectiveDefensiveKitWithObservedCastEvidence(params: {
  client: any;
  input: ResolveDefensiveKitInput;
  data: EffectiveDefensiveData;
  currentPullId: string;
  liveSpellIds: readonly number[];
}): Promise<{
  kit: ResolvedDefensive[];
  firstPassKit: ResolvedDefensive[];
  demonstratedSpellIds: ReadonlyMap<number, 'observed_cast_same_pull' | 'observed_cast_same_build_fingerprint'>;
}> {
  const playerName = params.input.playerIdentity?.playerName?.trim() ?? '';
  const fingerprint = params.input.buildFingerprint;
  const gameBuild = params.input.gameBuild;
  const storedRows: StoredDefensiveCastEvidenceRow[] = [];

  if (playerName && fingerprint && gameBuild) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await params.client
        .from('player_pull_records')
        .select('pull_id,talent_build_fingerprint,defensive_casts')
        .eq('player_name', playerName)
        .eq('game_build', gameBuild)
        .eq('talent_build_fingerprint', fingerprint)
        .order('pull_id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        throw new Error(`No se pudo cargar evidencia histórica de casts defensivos para ${playerName}: ${error.message}`);
      }
      const page = (data ?? []) as StoredDefensiveCastEvidenceRow[];
      storedRows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }

  return resolveEffectiveDefensiveKitFromObservedCastEvidence({
    input: params.input,
    data: params.data,
    storedRows,
    currentPullId: params.currentPullId,
    liveSpellIds: params.liveSpellIds,
  });
}
'''
    write_new('supabase/functions/_shared/defensive-observed-cast-evidence.ts', helper)

    # analyze-report: use reviewed catalog facts, required semantic sources and observed-cast two-pass resolver.
    replace_exact(
        'supabase/functions/analyze-report/index.ts',
        "  normalizeTalentBuild,\n  resolveEffectiveDefensiveKit,\n  type TalentBuildNode,\n} from '../_shared/effective-defensives.ts';\n",
        "  normalizeTalentBuild,\n  type TalentBuildNode,\n} from '../_shared/effective-defensives.ts';\nimport { resolveEffectiveDefensiveKitWithObservedCastEvidence } from '../_shared/defensive-observed-cast-evidence.ts';\n",
    )
    replace_exact(
        'supabase/functions/analyze-report/index.ts',
        "select('class,spec,spec_override,spell_id,name,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,survival_type,excluded')",
        "select('class,spec,spec_override,spell_id,name,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,survival_type,reviewed,excluded')",
    )
    replace_exact(
        'supabase/functions/analyze-report/index.ts',
        """      const [specProfilesResult, modifierRulesResult, overridesResult] = await Promise.all([\n        supabase.from('defensive_spec_profiles').select('*'),\n        supabase.from('defensive_modifier_rules').select('*').eq('active', true),\n        currentGameBuild\n          ? supabase.from('player_defensive_overrides').select('*').eq('game_build', currentGameBuild).eq('active', true)\n          : Promise.resolve({ data: [], error: null }),\n      ]);\n      if (specProfilesResult.error) resolverShadowWarnings.push(`defensive_spec_profiles: ${specProfilesResult.error.message}`);\n      if (modifierRulesResult.error) resolverShadowWarnings.push(`defensive_modifier_rules: ${modifierRulesResult.error.message}`);\n      if (overridesResult.error) resolverShadowWarnings.push(`player_defensive_overrides: ${overridesResult.error.message}`);\n      const resolverData = effectiveDefensiveDataFromDatabaseRows({\n        catalogRows: catalogRows ?? [],\n        specProfileRows: specProfilesResult.data ?? [],\n        modifierRuleRows: modifierRulesResult.data ?? [],\n        overrideRows: overridesResult.data ?? [],\n      });\n""",
        """      const [specProfilesResult, modifierRulesResult, semanticsResult, semanticRulesResult, overridesResult] = await Promise.all([\n        supabase.from('defensive_spec_profiles').select('*'),\n        supabase.from('defensive_modifier_rules').select('*').eq('active', true),\n        supabase.from('defensive_ability_semantic_catalog').select('*'),\n        supabase.from('defensive_semantic_rules').select('*'),\n        currentGameBuild\n          ? supabase.from('player_defensive_overrides').select('*').eq('game_build', currentGameBuild).eq('active', true)\n          : Promise.resolve({ data: [], error: null }),\n      ]);\n      for (const [source, result] of [\n        ['defensive_spec_profiles', specProfilesResult],\n        ['defensive_modifier_rules', modifierRulesResult],\n        ['defensive_ability_semantic_catalog', semanticsResult],\n        ['defensive_semantic_rules', semanticRulesResult],\n        ['player_defensive_overrides', overridesResult],\n      ] as const) {\n        if (result.error) throw new Error(`No se pudo cargar ${source} para resolver defensivos: ${result.error.message}`);\n      }\n      const resolverData = effectiveDefensiveDataFromDatabaseRows({\n        catalogRows: catalogRows ?? [],\n        specProfileRows: specProfilesResult.data ?? [],\n        modifierRuleRows: modifierRulesResult.data ?? [],\n        semanticRows: semanticsResult.data ?? [],\n        semanticRuleRows: semanticRulesResult.data ?? [],\n        overrideRows: overridesResult.data ?? [],\n      });\n""",
    )
    replace_exact(
        'supabase/functions/analyze-report/index.ts',
        """          const resolvedKit = actor\n            ? resolveEffectiveDefensiveKit(\n              {\n                className: actor.subType,\n                specName: playerSpec,\n                talentBuild,\n                buildFingerprint: talentBuildFingerprint,\n                gameBuild: observedBuild.gameBuild,\n                gameBuildConfidence: observedBuild.confidence,\n                playerIdentity: { playerName: actor.name },\n                allTalentSpellIds: shadowTalentLookup ? new Set(shadowTalentLookup.values()) : null,\n                talentLookupComplete: shadowTalentLookup != null,\n                knownTalentEntryIds: shadowKnownEntryIds,\n              },\n              resolverData,\n            )\n            : [];\n""",
        """          const resolverInput = actor\n            ? {\n                className: actor.subType,\n                specName: playerSpec,\n                talentBuild,\n                buildFingerprint: talentBuildFingerprint,\n                gameBuild: observedBuild.gameBuild,\n                gameBuildConfidence: observedBuild.confidence,\n                playerIdentity: { playerName: actor.name },\n                allTalentSpellIds: shadowTalentLookup ? new Set(shadowTalentLookup.values()) : null,\n                talentLookupComplete: shadowTalentLookup != null,\n                knownTalentEntryIds: shadowKnownEntryIds,\n              }\n            : null;\n          const liveDefensiveSpellIds = actor\n            ? [...(defensiveCastTimestampsByActor.get(actorId)?.entries() ?? [])]\n                .filter(([, timestamps]) => timestamps.length > 0)\n                .map(([spellId]) => spellId)\n            : [];\n          const resolvedKit = resolverInput\n            ? (await resolveEffectiveDefensiveKitWithObservedCastEvidence({\n                client: supabase,\n                input: resolverInput,\n                data: resolverData,\n                currentPullId: insertedPull.id,\n                liveSpellIds: liveDefensiveSpellIds,\n              })).kit\n            : [];\n""",
    )

    # reanalyze: same canonical sources + same two-pass observed-cast resolver.
    replace_exact(
        'supabase/functions/reanalyze-defensive-pressure/index.ts',
        "  normalizeTalentBuild,\n  resolveEffectiveDefensiveKit,\n  type DefensiveResolutionConfidence,\n",
        "  normalizeTalentBuild,\n  type DefensiveResolutionConfidence,\n",
    )
    replace_exact(
        'supabase/functions/reanalyze-defensive-pressure/index.ts',
        "} from '../_shared/effective-defensives.ts';\nimport { effectiveDeathOptions, evaluateEffectiveWindowCoverage } from '../_shared/effective-defensive-state.ts';\n",
        "} from '../_shared/effective-defensives.ts';\nimport { resolveEffectiveDefensiveKitWithObservedCastEvidence } from '../_shared/defensive-observed-cast-evidence.ts';\nimport { effectiveDeathOptions, evaluateEffectiveWindowCoverage } from '../_shared/effective-defensive-state.ts';\n",
    )
    replace_exact(
        'supabase/functions/reanalyze-defensive-pressure/index.ts',
        "select('class,spec,spec_override,spell_id,name,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,survival_type,excluded')",
        "select('class,spec,spec_override,spell_id,name,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,survival_type,reviewed,excluded')",
    )
    replace_exact(
        'supabase/functions/reanalyze-defensive-pressure/index.ts',
        """    const [specProfilesResult, modifierRulesResult, overridesResult] = await Promise.all([\n      supabase.from('defensive_spec_profiles').select('*'),\n      supabase.from('defensive_modifier_rules').select('*').eq('active', true),\n      supabase.from('player_defensive_overrides').select('*').eq('active', true),\n    ]);\n    if (specProfilesResult.error) resolverShadowWarnings.push(`defensive_spec_profiles: ${specProfilesResult.error.message}`);\n    if (modifierRulesResult.error) resolverShadowWarnings.push(`defensive_modifier_rules: ${modifierRulesResult.error.message}`);\n    if (overridesResult.error) resolverShadowWarnings.push(`player_defensive_overrides: ${overridesResult.error.message}`);\n    const resolverData = effectiveDefensiveDataFromDatabaseRows({\n      catalogRows: catalogRows ?? [],\n      specProfileRows: specProfilesResult.data ?? [],\n      modifierRuleRows: modifierRulesResult.data ?? [],\n      overrideRows: overridesResult.data ?? [],\n    });\n""",
        """    const [specProfilesResult, modifierRulesResult, semanticsResult, semanticRulesResult, overridesResult] = await Promise.all([\n      supabase.from('defensive_spec_profiles').select('*'),\n      supabase.from('defensive_modifier_rules').select('*').eq('active', true),\n      supabase.from('defensive_ability_semantic_catalog').select('*'),\n      supabase.from('defensive_semantic_rules').select('*'),\n      supabase.from('player_defensive_overrides').select('*').eq('active', true),\n    ]);\n    for (const [source, result] of [\n      ['defensive_spec_profiles', specProfilesResult],\n      ['defensive_modifier_rules', modifierRulesResult],\n      ['defensive_ability_semantic_catalog', semanticsResult],\n      ['defensive_semantic_rules', semanticRulesResult],\n      ['player_defensive_overrides', overridesResult],\n    ] as const) {\n      if (result.error) throw new Error(`No se pudo cargar ${source} para resolver defensivos: ${result.error.message}`);\n    }\n    const resolverData = effectiveDefensiveDataFromDatabaseRows({\n      catalogRows: catalogRows ?? [],\n      specProfileRows: specProfilesResult.data ?? [],\n      modifierRuleRows: modifierRulesResult.data ?? [],\n      semanticRows: semanticsResult.data ?? [],\n      semanticRuleRows: semanticRulesResult.data ?? [],\n      overrideRows: overridesResult.data ?? [],\n    });\n""",
    )
    replace_exact(
        'supabase/functions/reanalyze-defensive-pressure/index.ts',
        """      const resolvedKit = resolveEffectiveDefensiveKit(\n        {\n          className: playerClass,\n          specName: playerSpec,\n          talentBuild,\n          buildFingerprint: talentBuildFingerprint,\n          gameBuild: observedBuild.gameBuild,\n          gameBuildConfidence: observedBuild.confidence,\n          playerIdentity: { playerName: record.player_name },\n          allTalentSpellIds: lookupForObservedBuild ? new Set(lookupForObservedBuild.values()) : null,\n          talentLookupComplete: lookupForObservedBuild != null,\n          knownTalentEntryIds: observedBuild.gameBuild ? (knownEntryIdsByBuild.get(observedBuild.gameBuild) ?? null) : null,\n        },\n        resolverData,\n      );\n""",
        """      const resolverInput = {\n        className: playerClass,\n        specName: playerSpec,\n        talentBuild,\n        buildFingerprint: talentBuildFingerprint,\n        gameBuild: observedBuild.gameBuild,\n        gameBuildConfidence: observedBuild.confidence,\n        playerIdentity: { playerName: record.player_name },\n        allTalentSpellIds: lookupForObservedBuild ? new Set(lookupForObservedBuild.values()) : null,\n        talentLookupComplete: lookupForObservedBuild != null,\n        knownTalentEntryIds: observedBuild.gameBuild ? (knownEntryIdsByBuild.get(observedBuild.gameBuild) ?? null) : null,\n      };\n      const liveDefensiveSpellIds = [...(castTimestampsByActor.get(actorId)?.entries() ?? [])]\n        .filter(([, timestamps]) => timestamps.length > 0)\n        .map(([spellId]) => spellId);\n      const resolvedKit = (await resolveEffectiveDefensiveKitWithObservedCastEvidence({\n        client: supabase,\n        input: resolverInput,\n        data: resolverData,\n        currentPullId: pull.id,\n        liveSpellIds: liveDefensiveSpellIds,\n      })).kit;\n""",
    )


def step2() -> None:
    # Shared state sensor: only real semantic kit members are options; only missable ones create negative opportunities.
    replace_exact(
        'supabase/functions/_shared/effective-defensive-state.ts',
        "  cooldownRemainingMs?: number;\n  nextChargeAtMs?: number;\n}",
        "  cooldownRemainingMs?: number;\n  nextChargeAtMs?: number;\n  /** True only for verified personal_survival + opportunity_mode=normal. */\n  createsMissableOpportunity: boolean;\n}",
    )
    replace_exact(
        'supabase/functions/_shared/effective-defensive-state.ts',
        "      defensive.eligible &&\n      defensive.category === 'personal_defensive' &&\n      defensive.targetingMode === 'self',",
        "      defensive.eligible &&\n      defensive.isDefensiveKitMember &&\n      defensive.category === 'personal_defensive' &&\n      defensive.targetingMode === 'self',",
    )
    replace_exact(
        'supabase/functions/_shared/effective-defensive-state.ts',
        "    confidence: defensive.confidence,\n    ...effectiveDefensiveStateAt(defensive, castsBySpellId.get(defensive.spellId) ?? [], deathAtMs, activeSpellIds.has(defensive.spellId)),",
        "    confidence: defensive.confidence,\n    createsMissableOpportunity: defensive.createsMissableOpportunity,\n    ...effectiveDefensiveStateAt(defensive, castsBySpellId.get(defensive.spellId) ?? [], deathAtMs, activeSpellIds.has(defensive.spellId)),",
    )
    replace_exact(
        'supabase/functions/_shared/effective-defensive-state.ts',
        "      confidence: defensive.confidence,\n      ...atStart,",
        "      confidence: defensive.confidence,\n      createsMissableOpportunity: defensive.createsMissableOpportunity,\n      ...atStart,",
    )
    replace_exact(
        'supabase/functions/_shared/effective-defensive-state.ts',
        "        option.status === 'available_unused' &&\n        option.survivalType !== 'emergency' &&",
        "        option.createsMissableOpportunity &&\n        option.status === 'available_unused' &&\n        option.survivalType !== 'emergency' &&",
    )

    # Materialize only semantic personal-kit entries. Keep full v2 death options, but legacy projection contains only missable resources.
    replace_exact(
        'supabase/functions/analyze-report/index.ts',
        "            defensive_casts: actor\n              ? resolvedKit.filter((defensive) => defensive.eligible).map((cd) => ({",
        "            defensive_casts: actor\n              ? resolvedKit.filter((defensive) => defensive.isDefensiveKitMember).map((cd) => ({",
    )
    replace_exact(
        'supabase/functions/reanalyze-defensive-pressure/index.ts',
        "      updatePatch['defensive_casts'] = resolvedKit.filter((defensive) => defensive.eligible).map((defensive) => ({",
        "      updatePatch['defensive_casts'] = resolvedKit.filter((defensive) => defensive.isDefensiveKitMember).map((defensive) => ({",
    )
    replace_exact(
        'supabase/functions/analyze-report/index.ts',
        """          const defensiveOptions = (deathDefensiveOptionsV2 ?? []).map((option) => ({\n            spellId: option.spellId,\n            name: option.name,\n            status: option.status,\n            cooldownRemainingMs: option.cooldownRemainingMs,\n          }));\n""",
        """          const defensiveOptions = (deathDefensiveOptionsV2 ?? [])\n            .filter((option) => option.createsMissableOpportunity)\n            .map((option) => ({\n              spellId: option.spellId,\n              name: option.name,\n              status: option.status,\n              cooldownRemainingMs: option.cooldownRemainingMs,\n            }));\n""",
    )
    replace_exact(
        'supabase/functions/reanalyze-defensive-pressure/index.ts',
        """          defensiveOptions: deathDefensiveOptionsV2.map((option) => ({\n            spellId: option.spellId,\n            name: option.name,\n            status: option.status,\n            cooldownRemainingMs: option.cooldownRemainingMs,\n          })),\n""",
        """          defensiveOptions: deathDefensiveOptionsV2\n            .filter((option) => option.createsMissableOpportunity)\n            .map((option) => ({\n              spellId: option.spellId,\n              name: option.name,\n              status: option.status,\n              cooldownRemainingMs: option.cooldownRemainingMs,\n            })),\n""",
    )

    # The legacy boolean now uses the same semantic availability sensor instead of "no active buff".
    replace_exact(
        'supabase/functions/analyze-report/index.ts',
        "                preventableWithDefensive: bossMeleeOnNonTank ? null : buffsSnapshotIsFresh ? defensivesAtDeath.length === 0 : null,",
        "                preventableWithDefensive: bossMeleeOnNonTank\n                  ? null\n                  : (() => {\n                      const missableOptions = (deathDefensiveOptionsV2 ?? []).filter((option) => option.createsMissableOpportunity);\n                      if (missableOptions.some((option) => option.status === 'available_unused')) return true;\n                      if (missableOptions.some((option) => option.status === 'unknown')) return null;\n                      return missableOptions.length ? false : null;\n                    })(),",
    )

    # Upgrade existing effective-state fixture before the state sensor tests run in this same step.
    replace_exact(
        'src/app/shared/effective-defensive-state.spec.ts',
        "    conditionalModifiers: [],\n    ...overrides,",
        "    conditionalModifiers: [],\n    semanticResolved: true,\n    usageRole: 'personal_survival',\n    activationScope: 'self',\n    primaryBeneficiary: 'self',\n    secondaryPropagation: 'none',\n    mechanisms: ['mitigation'],\n    opportunityMode: 'normal',\n    defensiveIntent: 'primary',\n    semanticStatus: 'verified',\n    semanticVersion: 'defensive-semantics@1.0.0',\n    semanticConfidence: 'verified',\n    semanticResolverVersion: 'effective-defensive-semantics@1.5.0',\n    semanticProvenance: [],\n    buildPresence: 'present',\n    buildPresenceReason: 'fixture',\n    buildPresenceConfidence: 'verified',\n    buildPresenceEvidence: 'baseline_kit',\n    applicability: null,\n    applicabilityConfidence: 'verified',\n    resolutionStatus: 'resolved',\n    unresolvedRuntimeRules: [],\n    isDefensiveKitMember: true,\n    createsMissableOpportunity: true,\n    ...overrides,",
    )
    replace_exact(
        'src/app/shared/effective-defensive-state.spec.ts',
        """  it('keeps actual use as positive evidence even when resolution is uncertain', () => {\n    const result = evaluateEffectiveWindowCoverage(\n      10_000,\n      12_000,\n      [defensive({ confidence: 'uncertain', effectiveDurationMs: null })],\n      new Map([[586, [11_000]]]),\n    );\n\n    expect(result.covered).toBe(true);\n    expect(result.options[0].status).toBe('used_during_window');\n  });\n});\n""",
        """  it('keeps actual use as positive evidence even when resolution is uncertain', () => {\n    const result = evaluateEffectiveWindowCoverage(\n      10_000,\n      12_000,\n      [defensive({ confidence: 'uncertain', effectiveDurationMs: null })],\n      new Map([[586, [11_000]]]),\n    );\n\n    expect(result.covered).toBe(true);\n    expect(result.options[0].status).toBe('used_during_window');\n  });\n\n  it('excludes a replaced/non-member resource even if legacy category still says personal_defensive', () => {\n    const replaced = defensive({ spellId: 45438, name: 'Ice Block', isDefensiveKitMember: false, createsMissableOpportunity: false });\n    const replacement = defensive({ spellId: 414658, name: 'Ice Cold' });\n    const result = evaluateEffectiveWindowCoverage(10_000, 12_000, [replaced, replacement], new Map());\n\n    expect(result.options.map((option) => option.spellId)).toEqual([414658]);\n  });\n\n  it('credits credit_only use but never fabricates an available-unused opportunity from it', () => {\n    const creditOnly = defensive({\n      spellId: 34428,\n      name: 'Victory Rush',\n      usageRole: 'hybrid_survival',\n      opportunityMode: 'credit_only',\n      createsMissableOpportunity: false,\n      effectiveDurationMs: null,\n    });\n    const unused = evaluateEffectiveWindowCoverage(10_000, 12_000, [creditOnly], new Map());\n    expect(unused.options[0].status).toBe('available_unused');\n    expect(unused.availableOpportunity).toBe(false);\n\n    const used = evaluateEffectiveWindowCoverage(10_000, 12_000, [creditOnly], new Map([[34428, [11_000]]]));\n    expect(used.covered).toBe(true);\n    expect(used.availableOpportunity).toBe(false);\n  });\n});\n""",
    )



def step3() -> None:
    evidence_test = r'''import { describe, expect, it } from 'vitest';
import { effectiveDefensiveDataFromDatabaseRows } from '../../../supabase/functions/_shared/effective-defensives';
import { resolveEffectiveDefensiveKitFromObservedCastEvidence } from '../../../supabase/functions/_shared/defensive-observed-cast-evidence';

const GAME_BUILD = '12.1.0.68914';
const FINGERPRINT = 'sha256:ams-fixture';

function amsData() {
  return effectiveDefensiveDataFromDatabaseRows({
    catalogRows: [{
      class: 'DeathKnight',
      spec: 'Blood/Frost/Unholy',
      spec_override: null,
      spell_id: 48707,
      name: 'Anti-Magic Shell',
      category: 'personal_defensive',
      survival_type: 'mitigation',
      targeting_mode: 'self',
      activation_mode: 'active',
      passive_conversion_spell_ids: [],
      activation_game_build: GAME_BUILD,
      base_cooldown_ms: 60000,
      base_duration_ms: 5000,
      reviewed: true,
      excluded: false,
    }],
    semanticRows: [{
      spell_id: 48707,
      class: 'DeathKnight',
      usage_role: 'personal_survival',
      activation_scope: 'self',
      primary_beneficiary: 'self',
      secondary_propagation: 'none',
      mechanisms: ['mitigation'],
      opportunity_mode: 'normal',
      defensive_intent: 'primary',
      semantic_status: 'verified',
      semantic_version: 'defensive-semantics@1.0.0',
      confidence: 'verified',
      locked: true,
      applicability: null,
      applicability_confidence: 'high',
      spec_semantic_profiles: [],
    }],
  });
}

function input() {
  return {
    className: 'DeathKnight',
    specName: 'Frost',
    talentBuild: [],
    buildFingerprint: FINGERPRINT,
    gameBuild: GAME_BUILD,
    gameBuildConfidence: 'verified' as const,
    playerIdentity: { playerName: 'WargreymonFixture' },
    // Reproduces the real acquisition ambiguity: lookup says AMS is a
    // candidate, but the WCL build snapshot does not expose it as selected.
    allTalentSpellIds: new Set([48707]),
    talentLookupComplete: true,
    knownTalentEntryIds: new Set<number>(),
  };
}

describe('observed-cast acquisition parity', () => {
  it('restores AMS from a same-pull WCL cast instead of dropping a real defensive', () => {
    const result = resolveEffectiveDefensiveKitFromObservedCastEvidence({
      input: input(),
      data: amsData(),
      storedRows: [],
      currentPullId: 'pull-current',
      liveSpellIds: [48707],
    });
    expect(result.firstPassKit[0]).toMatchObject({ eligible: false, buildPresence: 'unknown', isDefensiveKitMember: false });
    expect(result.kit[0]).toMatchObject({
      eligible: true,
      buildPresence: 'present',
      buildPresenceEvidence: 'observed_cast_same_pull',
      isDefensiveKitMember: true,
      createsMissableOpportunity: true,
    });
  });

  it('restores AMS cross-pull only for the exact same non-null build fingerprint', () => {
    const sameBuild = resolveEffectiveDefensiveKitFromObservedCastEvidence({
      input: input(),
      data: amsData(),
      storedRows: [{
        pull_id: 'older-pull',
        talent_build_fingerprint: FINGERPRINT,
        defensive_casts: [{ spellId: 48707, timestampsMs: [1234] }],
      }],
      currentPullId: 'pull-current',
      liveSpellIds: [],
    });
    expect(sameBuild.kit[0]).toMatchObject({
      buildPresence: 'present',
      buildPresenceEvidence: 'observed_cast_same_build_fingerprint',
      isDefensiveKitMember: true,
    });

    const otherBuild = resolveEffectiveDefensiveKitFromObservedCastEvidence({
      input: input(),
      data: amsData(),
      storedRows: [{
        pull_id: 'older-pull',
        talent_build_fingerprint: 'sha256:other-build',
        defensive_casts: [{ spellId: 48707, timestampsMs: [1234] }],
      }],
      currentPullId: 'pull-current',
      liveSpellIds: [],
    });
    expect(otherBuild.kit[0]).toMatchObject({ buildPresence: 'unknown', isDefensiveKitMember: false });
  });
});
'''
    write_new('src/app/shared/defensive-observed-cast-evidence.spec.ts', evidence_test)

    integration_guard = r'''import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = [
  'supabase/functions/analyze-report/index.ts',
  'supabase/functions/reanalyze-defensive-pressure/index.ts',
] as const;

describe('defensive materialization integration guard', () => {
  for (const file of files) {
    it(`${file} uses the canonical semantic + observed-cast contract`, () => {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('resolveEffectiveDefensiveKitWithObservedCastEvidence');
      expect(source).toContain('semanticRows: semanticsResult.data ?? []');
      expect(source).toContain('semanticRuleRows: semanticRulesResult.data ?? []');
      expect(source).toContain('filter((defensive) => defensive.isDefensiveKitMember)');
      expect(source).toContain('filter((option) => option.createsMissableOpportunity)');
      expect(source).not.toContain('filter((defensive) => defensive.eligible).map');
    });
  }
});
'''
    write_new('src/app/shared/defensive-materialization-consistency.spec.ts', integration_guard)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--step', type=int, choices=[1, 2, 3], required=True)
    args = parser.parse_args()
    {1: step1, 2: step2, 3: step3}[args.step]()
