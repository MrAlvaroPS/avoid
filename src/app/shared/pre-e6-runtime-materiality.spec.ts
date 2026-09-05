import { describe, expect, it } from 'vitest';
import {
  evaluateDefensiveEpisodesForPlayer,
  type DefensiveEpisodeEvaluatorInput,
} from '../../../supabase/functions/_shared/defensive-episode-evaluator';
import type { DamageApplicability } from '../../../supabase/functions/_shared/defensive-applicability';
import type { AbilityCombatTableCounts, DecodedSchoolMask } from '../../../supabase/functions/_shared/damage-descriptor-wcl';
import {
  resolveEffectiveDefensiveKit,
  type EffectiveDefensiveCatalogEntry,
  type EffectiveDefensiveSemanticEntry,
  type EffectiveDefensiveSemanticRule,
  type ResolvedDefensive,
  type ResolveDefensiveKitInput,
} from '../../../supabase/functions/_shared/effective-defensives';

const GAME_BUILD = '12.1.0.68914';
const NORMAL_SPELL_ID = 900001;
const RUNTIME_SPELL_ID = 900002;

function unrestrictedApplicability(timingRelation: DamageApplicability['timingRelation'] = 'before_or_during'): DamageApplicability {
  return {
    schoolScope: 'all',
    schools: null,
    deliveryScopes: ['all'],
    requiresDodgeable: null,
    requiresParryable: null,
    requiresBlockable: null,
    requiresSourceAffectedBySpell: null,
    timingRelation,
  };
}

function resolvedDefensive(overrides: Partial<ResolvedDefensive> = {}): ResolvedDefensive {
  return {
    spellId: NORMAL_SPELL_ID,
    name: 'Fixture defensive',
    className: 'Monk',
    specName: 'Windwalker',
    category: 'personal_defensive',
    survivalType: 'mitigation',
    targetingMode: 'self',
    activationMode: 'active',
    effectiveCooldownMs: 60_000,
    effectiveDurationMs: 10_000,
    charges: 1,
    rechargeMs: null,
    eligible: true,
    buildFingerprint: 'sha256:pre-e6-fixture',
    gameBuild: GAME_BUILD,
    resolverVersion: 'effective-defensives@2.1.0',
    confidence: 'verified',
    provenance: [],
    conditionalModifiers: [],
    semanticResolved: true,
    usageRole: 'personal_survival',
    activationScope: 'self',
    primaryBeneficiary: 'self',
    secondaryPropagation: 'none',
    mechanisms: ['mitigation'],
    opportunityMode: 'normal',
    defensiveIntent: 'primary',
    semanticStatus: 'verified',
    semanticVersion: 'defensive-semantics@1.0.0',
    semanticConfidence: 'verified',
    semanticResolverVersion: 'effective-defensive-semantics@1.3.1',
    semanticProvenance: [],
    buildPresence: 'present',
    buildPresenceReason: 'baseline',
    buildPresenceConfidence: 'verified',
    buildPresenceEvidence: 'baseline_kit',
    applicability: unrestrictedApplicability(),
    applicabilityConfidence: 'high',
    resolutionStatus: 'resolved',
    unresolvedRuntimeRules: [],
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    ...overrides,
  };
}

function runtimeUtility(overrides: Partial<ResolvedDefensive> = {}): ResolvedDefensive {
  return resolvedDefensive({
    spellId: RUNTIME_SPELL_ID,
    name: 'Runtime utility fixture',
    category: 'utility',
    survivalType: null,
    targetingMode: 'self',
    usageRole: 'utility',
    primaryBeneficiary: 'none',
    mechanisms: [],
    opportunityMode: 'none',
    defensiveIntent: 'hybrid',
    applicability: unrestrictedApplicability('unknown'),
    applicabilityConfidence: 'high',
    isDefensiveKitMember: false,
    createsMissableOpportunity: false,
    unresolvedRuntimeRules: [
      {
        ruleId: 'runtime-fixture',
        condition: 'runtime_state',
        reason: 'Fixture runtime branch is intentionally unresolved.',
      },
    ],
    ...overrides,
  });
}

function singlePeakGraph(peakAtMs: number, pointIntervalMs = 1000, baseline = 1000, peak = baseline * 5) {
  const peakIndex = Math.round(peakAtMs / pointIntervalMs);
  const points: number[] = [];
  for (let i = 0; i <= peakIndex + 5; i++) points.push(i === peakIndex ? peak : baseline);
  return { points, pointIntervalMs };
}

function baseEpisodeInput(overrides: Partial<DefensiveEpisodeEvaluatorInput> = {}): DefensiveEpisodeEvaluatorInput {
  const { points, pointIntervalMs } = singlePeakGraph(11_000);
  return {
    pullId: 'pre-e6-pull',
    playerName: 'PreE6Fixture',
    bossActorId: null,
    evaluationEndMs: null,
    resolvedDefensives: [],
    damageTakenGraphPoints: points,
    graphPointStartMs: 0,
    graphPointIntervalMs: pointIntervalMs,
    rawDamageHits: [{ timestamp: 11_000, abilityGameID: 999, amount: 5000, isAoE: false, tick: false }],
    castsBySpellId: new Map(),
    schoolByAbilityId: new Map<number, DecodedSchoolMask>([[999, { schoolMask: 4, schools: ['Fire'] }]]),
    combatTableObservations: new Map<number, AbilityCombatTableCounts>(),
    bossDebuffIntervals: [],
    dataConfidence: 'verified',
    ...overrides,
  };
}

describe('pre-E6 — fail-closed semantic/runtime materiality', () => {
  it('M: pending + unknown role blocks no_applicable_resource and can never create missed_ready', () => {
    const pending = resolvedDefensive({
      spellId: 900010,
      usageRole: 'unknown',
      activationScope: 'unknown',
      primaryBeneficiary: 'unknown',
      opportunityMode: 'none',
      defensiveIntent: 'unknown',
      semanticStatus: 'pending',
      semanticConfidence: 'uncertain',
      resolutionStatus: 'unresolved',
      applicability: null,
      applicabilityConfidence: null,
      isDefensiveKitMember: false,
      createsMissableOpportunity: false,
    });

    const [episode] = evaluateDefensiveEpisodesForPlayer(baseEpisodeInput({ resolvedDefensives: [pending] }));
    expect(episode.responseVerdict).toBe('uncertain');
    expect(episode.responseVerdict).not.toBe('no_applicable_resource');
    expect(episode.responseVerdict).not.toBe('missed_ready');
  });

  it('resolved utility with no defensive runtime intent does not contaminate no_applicable_resource', () => {
    const utility = runtimeUtility({ defensiveIntent: 'none' });
    const [episode] = evaluateDefensiveEpisodesForPlayer(baseEpisodeInput({ resolvedDefensives: [utility] }));
    expect(episode.responseVerdict).toBe('no_applicable_resource');
  });

  it('utility + hybrid + unresolved runtime branch is a material blocker, but remains nonmember/nonmissable', () => {
    const runtime = runtimeUtility();
    expect(runtime.isDefensiveKitMember).toBe(false);
    expect(runtime.createsMissableOpportunity).toBe(false);

    const [episode] = evaluateDefensiveEpisodesForPlayer(baseEpisodeInput({ resolvedDefensives: [runtime] }));
    expect(episode.responseVerdict).toBe('uncertain');
    expect(episode.usageEngaged).toBe(false);
  });

  it('UNUSED material runtime uncertainty does not excuse a known, ready, applicable miss', () => {
    const [episode] = evaluateDefensiveEpisodesForPlayer(
      baseEpisodeInput({ resolvedDefensives: [resolvedDefensive(), runtimeUtility()] }),
    );
    expect(episode.responseVerdict).toBe('missed_ready');
    expect(episode.usageEngaged).toBe(false);
  });

  it('USED material runtime action blocks an unjustified missed_ready but does not receive Usage credit as a nonmember', () => {
    const [episode] = evaluateDefensiveEpisodesForPlayer(
      baseEpisodeInput({
        resolvedDefensives: [resolvedDefensive(), runtimeUtility()],
        castsBySpellId: new Map([[RUNTIME_SPELL_ID, [11_000]]]),
      }),
    );
    expect(episode.responseVerdict).toBe('uncertain');
    expect(episode.responseVerdict).not.toBe('missed_ready');
    expect(episode.usageEngaged).toBe(false);
    expect(episode.usedSpellIds).toEqual([]);
    expect(episode.uncertaintyBlockers).toContain(RUNTIME_SPELL_ID);
  });
});

function catalogEntry(overrides: Partial<EffectiveDefensiveCatalogEntry> = {}): EffectiveDefensiveCatalogEntry {
  return {
    spellId: 434766,
    name: 'Transcendence: Transfer',
    className: 'Monk',
    specName: null,
    specOverride: null,
    category: 'utility',
    survivalType: null,
    targetingMode: 'self',
    activationMode: 'active',
    passiveConversionSpellIds: [],
    activationGameBuild: GAME_BUILD,
    baseCooldownMs: 30_000,
    baseDurationMs: null,
    ...overrides,
  };
}

function semanticEntry(): EffectiveDefensiveSemanticEntry {
  return {
    spellId: 434766,
    className: 'Monk',
    usageRole: 'utility',
    activationScope: 'self',
    primaryBeneficiary: 'none',
    secondaryPropagation: 'none',
    mechanisms: [],
    opportunityMode: 'none',
    defensiveIntent: 'none',
    semanticStatus: 'verified',
    semanticVersion: 'defensive-semantics@1.0.0',
    semanticConfidence: 'inferred',
    locked: true,
    applicability: null,
    applicabilityConfidence: null,
    applicabilityError: null,
    specSemanticProfiles: [],
    invalidSpecSemanticProfiles: [],
  };
}

const healingWindsRule: EffectiveDefensiveSemanticRule = {
  id: 'healing-winds-pre-e6-fixture',
  modifierSpellId: 450560,
  targetSpellId: 434766,
  specNames: ['Brewmaster', 'Mistweaver', 'Windwalker'],
  gameBuild: GAME_BUILD,
  ruleType: 'augment',
  payload: {
    condition: 'talent_selected',
    modifierName: 'Healing Winds',
    setUsageRole: 'hybrid_survival',
    setDefensiveIntent: 'hybrid',
    setOpportunityMode: 'credit_only',
    setPrimaryBeneficiary: 'self',
    addMechanisms: ['sustain'],
    applicabilityPatch: { timingRelation: 'after_damage' },
  },
  source: 'IRIS pre-E6 regression fixture',
  verified: true,
};

function resolveInput(talentBuild: ResolveDefensiveKitInput['talentBuild']): ResolveDefensiveKitInput {
  return {
    className: 'Monk',
    specName: 'Windwalker',
    talentBuild,
    buildFingerprint: 'sha256:monk-healing-winds',
    gameBuild: GAME_BUILD,
    gameBuildConfidence: 'verified',
  };
}

describe('pre-E6 — real Monk fixture for Transcendence: Transfer / Healing Winds', () => {
  it('uses the real Monk class/spec and resolves Healing Winds 450560 as credit-only survival', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      resolveInput([{ id: 1, nodeID: 1, rank: 1, spellId: 450560 }]),
      {
        catalog: [catalogEntry()],
        specProfiles: [],
        modifierRules: [],
        semantics: [semanticEntry()],
        semanticRules: [healingWindsRule],
      },
    );

    expect(resolved.className).toBe('Monk');
    expect(resolved.specName).toBe('Windwalker');
    expect(resolved.usageRole).toBe('hybrid_survival');
    expect(resolved.opportunityMode).toBe('credit_only');
    expect(resolved.mechanisms).toContain('sustain');
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });
});
