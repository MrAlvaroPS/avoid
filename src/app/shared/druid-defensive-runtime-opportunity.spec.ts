import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveDefensiveKit,
  type EffectiveDefensiveCatalogEntry,
  type EffectiveDefensiveData,
  type EffectiveDefensiveSemanticEntry,
  type EffectiveDefensiveSpecProfile,
  type ResolvedDefensive,
} from '../../../supabase/functions/_shared/effective-defensives';
import { evaluateDefensiveEpisodesForPlayer } from '../../../supabase/functions/_shared/defensive-episode-evaluator';

const GAME_BUILD = '12.1.0.68914';
const BARKSKIN = 22812;
const FRENZIED_REGENERATION = 22842;

type DruidSpec = 'Balance' | 'Feral' | 'Guardian' | 'Restoration';

const barkskinCatalog: EffectiveDefensiveCatalogEntry = {
  spellId: BARKSKIN,
  name: 'Barkskin',
  className: 'Druid',
  specName: 'Balance/Feral/Guardian/Restoration',
  specOverride: null,
  category: 'personal_defensive',
  survivalType: 'mitigation',
  targetingMode: 'self',
  activationMode: 'active',
  passiveConversionSpellIds: [],
  activationGameBuild: GAME_BUILD,
  baseCooldownMs: 60_000,
  baseDurationMs: 8_000,
  reviewed: true,
  excluded: false,
};

const frenziedCatalog: EffectiveDefensiveCatalogEntry = {
  spellId: FRENZIED_REGENERATION,
  name: 'Frenzied Regeneration',
  className: 'Druid',
  specName: 'Balance/Feral/Guardian/Restoration',
  specOverride: ['Guardian', 'Restoration', 'Balance', 'Feral'],
  category: 'personal_defensive',
  survivalType: 'sustain',
  targetingMode: 'self',
  activationMode: 'active',
  passiveConversionSpellIds: [],
  activationGameBuild: GAME_BUILD,
  baseCooldownMs: 36_000,
  baseDurationMs: 3_000,
  reviewed: true,
  excluded: false,
};

function semantic(
  spellId: number,
  overrides: Partial<EffectiveDefensiveSemanticEntry> = {},
): EffectiveDefensiveSemanticEntry {
  return {
    spellId,
    className: 'Druid',
    usageRole: 'personal_survival',
    activationScope: 'self',
    primaryBeneficiary: 'self',
    secondaryPropagation: 'none',
    mechanisms: spellId === BARKSKIN ? ['mitigation'] : ['sustain'],
    opportunityMode: spellId === BARKSKIN ? 'normal' : 'credit_only',
    defensiveIntent: 'primary',
    semanticStatus: 'verified',
    semanticVersion: 'defensive-semantics@1.0.0',
    semanticConfidence: 'verified',
    locked: spellId === FRENZIED_REGENERATION,
    applicability: {
      schoolScope: 'all',
      schools: [],
      deliveryScopes: ['all'],
      requiresDodgeable: false,
      requiresParryable: false,
      requiresBlockable: false,
      requiresSourceAffectedBySpell: false,
      timingRelation: spellId === BARKSKIN ? 'before_or_during' : 'after_damage',
    },
    applicabilityConfidence: 'high',
    applicabilityError: null,
    specSemanticProfiles: [],
    invalidSpecSemanticProfiles: [],
    ...overrides,
  };
}

function barkskinProfile(specName: DruidSpec, durationMs: number): EffectiveDefensiveSpecProfile {
  return {
    className: 'Druid',
    specName,
    spellId: BARKSKIN,
    gameBuild: GAME_BUILD,
    baseCooldownMs: 60_000,
    baseDurationMs: durationMs,
    charges: 1,
    rechargeMs: null,
    source: 'IRIS Druid runtime opportunity safety 2026-09-10',
    sourceNote: `Barkskin ${durationMs}ms for ${specName}`,
  };
}

const resolverData: EffectiveDefensiveData = {
  catalog: [barkskinCatalog, frenziedCatalog],
  specProfiles: [
    barkskinProfile('Balance', 8_000),
    barkskinProfile('Guardian', 8_000),
    barkskinProfile('Feral', 12_000),
    barkskinProfile('Restoration', 12_000),
  ],
  modifierRules: [],
  overrides: [],
  semantics: [semantic(BARKSKIN), semantic(FRENZIED_REGENERATION)],
  semanticRules: [],
};

function resolveDruid(specName: DruidSpec): ResolvedDefensive[] {
  return resolveEffectiveDefensiveKit(
    {
      className: 'Druid',
      specName,
      talentBuild: [],
      buildFingerprint: `fp-${specName.toLowerCase()}`,
      gameBuild: GAME_BUILD,
      gameBuildConfidence: 'verified',
      playerIdentity: { playerName: specName === 'Balance' ? 'Gusmï' : `Test-${specName}` },
    },
    resolverData,
  );
}

function pressureGraph() {
  const points = Array.from({ length: 17 }, () => 1_000);
  points[11] = 5_000;
  return points;
}

function episodeInput(resolvedDefensives: ResolvedDefensive[], castsBySpellId = new Map<number, number[]>()) {
  return {
    pullId: 'druid-runtime-opportunity-fixture',
    playerName: 'Gusmï',
    bossActorId: null,
    evaluationEndMs: 30_000,
    resolvedDefensives,
    damageTakenGraphPoints: pressureGraph(),
    graphPointStartMs: 0,
    graphPointIntervalMs: 1_000,
    rawDamageHits: [{ timestamp: 11_000, abilityGameID: 999, amount: 5_000, isAoE: true, tick: false }],
    castsBySpellId,
    observedActiveIntervalsBySpellId: new Map(),
    schoolByAbilityId: new Map([[999, { schoolMask: 4, schools: ['Fire'] }]]),
    combatTableObservations: new Map(),
    bossDebuffIntervals: [],
    dataConfidence: 'verified' as const,
  };
}

describe('Druid runtime defensive opportunity safety', () => {
  it.each<[DruidSpec, number]>([
    ['Balance', 8_000],
    ['Guardian', 8_000],
    ['Feral', 12_000],
    ['Restoration', 12_000],
  ])('%s resolves Barkskin timing and Frenzied fail-closed semantics', (specName, expectedBarkskinDurationMs) => {
    const kit = resolveDruid(specName);
    const barkskin = kit.find((spell) => spell.spellId === BARKSKIN)!;
    const frenzied = kit.find((spell) => spell.spellId === FRENZIED_REGENERATION)!;

    expect(barkskin.effectiveDurationMs).toBe(expectedBarkskinDurationMs);
    expect(barkskin.isDefensiveKitMember).toBe(true);
    expect(barkskin.createsMissableOpportunity).toBe(true);

    // FR remains valid positive defensive evidence, but off-CD alone is not
    // enough to prove the Bear/resource/runtime preconditions needed to blame.
    expect(frenzied.isDefensiveKitMember).toBe(true);
    expect(frenzied.opportunityMode).toBe('credit_only');
    expect(frenzied.createsMissableOpportunity).toBe(false);
    expect(frenzied.applicability?.timingRelation).toBe('after_damage');
  });

  it('FR alone and unused never manufactures missed_ready', () => {
    const frenzied = resolveDruid('Balance').filter((spell) => spell.spellId === FRENZIED_REGENERATION);
    const [episode] = evaluateDefensiveEpisodesForPlayer(episodeInput(frenzied));

    expect(episode.responseVerdict).toBe('no_applicable_resource');
    expect(episode.responseVerdict).not.toBe('missed_ready');
  });

  it('Barkskin on cooldown + FR merely available cannot make the episode missed_ready', () => {
    const kit = resolveDruid('Balance');
    const [episode] = evaluateDefensiveEpisodesForPlayer(
      episodeInput(kit, new Map([[BARKSKIN, [-40_000]]])),
    );

    expect(episode.responseVerdict).not.toBe('missed_ready');
    expect(episode.evidence['decisiveSpellIds']).not.toContain(FRENZIED_REGENERATION);
  });

  it('real reactive FR use still receives positive credit and can cover an existing core opportunity', () => {
    const kit = resolveDruid('Balance');
    const [episode] = evaluateDefensiveEpisodesForPlayer(
      episodeInput(kit, new Map([[FRENZIED_REGENERATION, [12_000]]])),
    );

    expect(episode.usageEngaged).toBe(true);
    expect(episode.usedSpellIds).toContain(FRENZIED_REGENERATION);
    expect(episode.responseVerdict).toBe('covered_verified');
    expect(episode.coveredBySpellId).toBe(FRENZIED_REGENERATION);
  });
});
