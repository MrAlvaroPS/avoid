// §E3 manual closure regression tests (2026-09-04) — proves that the
// persisted E3 decisions (see supabase/migrations/20260904150000_e3_defensive_semantic_closure.sql)
// work together with the EXISTING resolver contract (resolveEffectiveDefensiveKit,
// automatic augment rules, isDefensiveKitMember/createsMissableOpportunity)
// without any new runtime engine. Spell IDs here mirror the real migration
// data only as fixtures — never hardcoded in production scoring logic.

import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveDefensiveKit,
  type EffectiveDefensiveCatalogEntry,
  type EffectiveDefensiveData,
  type EffectiveDefensiveSemanticEntry,
  type EffectiveDefensiveSemanticRule,
  type ResolveDefensiveKitInput,
} from '../../../supabase/functions/_shared/effective-defensives';
import { defensiveSemanticError } from '../../../supabase/functions/_shared/defensive-classification-semantics';
import { parseSpecSemanticProfiles } from '../../../supabase/functions/_shared/defensive-semantic-payload-validation';

const GAME_BUILD = '12.1.0.68914';

function catalogEntry(overrides: Partial<EffectiveDefensiveCatalogEntry>): EffectiveDefensiveCatalogEntry {
  return {
    spellId: 0,
    name: 'test',
    className: 'Monk',
    specName: null,
    specOverride: null,
    category: 'personal_defensive',
    survivalType: null,
    targetingMode: 'self',
    activationMode: 'active',
    passiveConversionSpellIds: [],
    activationGameBuild: GAME_BUILD,
    baseCooldownMs: 60_000,
    baseDurationMs: null,
    ...overrides,
  };
}

function semanticEntry(spellId: number, className: string, overrides: Partial<EffectiveDefensiveSemanticEntry>): EffectiveDefensiveSemanticEntry {
  return {
    spellId,
    className,
    usageRole: 'unknown',
    activationScope: 'unknown',
    primaryBeneficiary: 'unknown',
    secondaryPropagation: 'none',
    mechanisms: [],
    opportunityMode: 'none',
    defensiveIntent: 'unknown',
    semanticStatus: 'verified',
    semanticVersion: 'defensive-semantics@1.0.0',
    semanticConfidence: 'inferred',
    locked: true,
    applicability: null,
    applicabilityConfidence: null,
    applicabilityError: null,
    specSemanticProfiles: [],
    invalidSpecSemanticProfiles: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<ResolveDefensiveKitInput> = {}): ResolveDefensiveKitInput {
  return {
    className: 'Monk',
    specName: 'Brewmaster',
    talentBuild: [],
    buildFingerprint: 'sha256:e3-fixture',
    gameBuild: GAME_BUILD,
    gameBuildConfidence: 'verified',
    ...overrides,
  };
}

describe('E3 closure — A. Shield Block', () => {
  it('verified active_mitigation → never a personal Response opportunity regardless of gear', () => {
    const catalog = catalogEntry({ spellId: 2565, name: 'Shield Block', className: 'Warrior', specName: 'Protection' });
    const semantics = [
      semanticEntry(2565, 'Warrior', {
        usageRole: 'active_mitigation',
        activationScope: 'self',
        primaryBeneficiary: 'self',
        mechanisms: ['mitigation'],
        opportunityMode: 'none',
      }),
    ];
    const [resolved] = resolveEffectiveDefensiveKit(
      baseInput({ className: 'Warrior', specName: 'Protection' }),
      { catalog: [catalog], specProfiles: [], modifierRules: [], semantics, semanticRules: [] },
    );
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });
});

describe('E3 closure — B. Fortifying Brew', () => {
  it('present + resolved personal_survival → member + missable', () => {
    const catalog = catalogEntry({ spellId: 115203, name: 'Fortifying Brew', className: 'Monk', specName: null });
    const semantics = [
      semanticEntry(115203, 'Monk', {
        usageRole: 'personal_survival',
        activationScope: 'self',
        primaryBeneficiary: 'self',
        mechanisms: ['mitigation', 'effective_health'],
        opportunityMode: 'normal',
      }),
    ];
    const [resolved] = resolveEffectiveDefensiveKit(baseInput(), { catalog: [catalog], specProfiles: [], modifierRules: [], semantics, semanticRules: [] });
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.usageRole).toBe('personal_survival');
    expect(resolved.opportunityMode).toBe('normal');
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);
  });
});

// --- Celestial Conduit / Jade Sanctuary (443059) — C, D --------------------

const celestialConduit = catalogEntry({ spellId: 443028, name: 'Celestial Conduit', className: 'Monk', specName: 'Mistweaver' });

function celestialConduitSemantics(): EffectiveDefensiveSemanticEntry[] {
  return [
    semanticEntry(443028, 'Monk', {
      usageRole: 'utility',
      activationScope: 'self',
      primaryBeneficiary: 'none',
      mechanisms: [],
      opportunityMode: 'none',
      defensiveIntent: 'hybrid',
    }),
  ];
}

const jadeSanctuaryRule: EffectiveDefensiveSemanticRule = {
  id: 'jade-sanctuary',
  modifierSpellId: 443059,
  targetSpellId: 443028,
  specNames: ['Mistweaver', 'Windwalker'],
  gameBuild: GAME_BUILD,
  ruleType: 'augment',
  payload: {
    condition: 'hero_talent_selected',
    setUsageRole: 'hybrid_survival',
    setDefensiveIntent: 'hybrid',
    setOpportunityMode: 'credit_only',
    setPrimaryBeneficiary: 'self',
    addMechanisms: ['mitigation', 'sustain'],
    applicabilityPatch: { timingRelation: 'either' },
  },
  source: 'test',
  verified: true,
};

describe('E3 closure — C/D. Celestial Conduit + Jade Sanctuary (443059)', () => {
  it('C: without Jade Sanctuary selected → no personal defensive membership/opportunity', () => {
    const [resolved] = resolveEffectiveDefensiveKit(baseInput({ className: 'Monk', specName: 'Mistweaver', talentBuild: [] }), {
      catalog: [celestialConduit],
      specProfiles: [],
      modifierRules: [],
      semantics: celestialConduitSemantics(),
      semanticRules: [jadeSanctuaryRule],
    });
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.unresolvedRuntimeRules).toEqual([]); // hero_talent_selected is automatic — simply not selected, not "unresolved"
  });

  it('D: with Jade Sanctuary selected → hybrid_survival/credit_only, member true, missable false', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      baseInput({
        className: 'Monk',
        specName: 'Mistweaver',
        talentBuild: [{ id: 1, nodeID: 1, rank: 1, spellId: 443059 }],
      }),
      {
        catalog: [celestialConduit],
        specProfiles: [],
        modifierRules: [],
        semantics: celestialConduitSemantics(),
        semanticRules: [jadeSanctuaryRule],
      },
    );
    expect(resolved.usageRole).toBe('hybrid_survival');
    expect(resolved.opportunityMode).toBe('credit_only');
    expect(resolved.mechanisms).toEqual(expect.arrayContaining(['mitigation', 'sustain']));
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });
});

// --- Touch of Death / Chi Transfer (1272452) — E, F -------------------------

function touchOfDeathCatalog(className: string, specName: string | null): EffectiveDefensiveCatalogEntry {
  return catalogEntry({ spellId: 322109, name: 'Touch of Death', className, specName });
}

function touchOfDeathBaseSemantics(className: string): EffectiveDefensiveSemanticEntry {
  return semanticEntry(322109, className, {
    usageRole: 'utility',
    activationScope: 'enemy',
    primaryBeneficiary: 'none',
    mechanisms: [],
    opportunityMode: 'none',
    defensiveIntent: 'none',
  });
}

function touchOfDeathBrewmasterSemantics(): EffectiveDefensiveSemanticEntry {
  return semanticEntry(322109, 'Monk', {
    usageRole: 'utility',
    activationScope: 'enemy',
    primaryBeneficiary: 'none',
    mechanisms: [],
    opportunityMode: 'none',
    defensiveIntent: 'none',
    specSemanticProfiles: parseSpecSemanticProfiles([
      {
        spec: 'Brewmaster',
        usageRole: 'rotational_survival',
        defensiveIntent: 'hybrid',
        activationScope: 'enemy',
        primaryBeneficiary: 'self',
        secondaryPropagation: 'none',
        mechanisms: ['mitigation'],
        opportunityMode: 'none',
        applicability: null,
        source: 'test',
        confidence: 'high',
      },
    ]).profiles,
  });
}

const chiTransferRule: EffectiveDefensiveSemanticRule = {
  id: 'chi-transfer',
  modifierSpellId: 1272452,
  targetSpellId: 322109,
  specNames: ['Brewmaster', 'Mistweaver', 'Windwalker'],
  gameBuild: GAME_BUILD,
  ruleType: 'augment',
  payload: {
    condition: 'talent_selected',
    setUsageRole: 'hybrid_survival',
    setDefensiveIntent: 'hybrid',
    setOpportunityMode: 'credit_only',
    setPrimaryBeneficiary: 'self',
    addMechanisms: ['sustain'],
    applicabilityPatch: { timingRelation: 'after_damage' },
  },
  source: 'test',
  verified: true,
};

describe('E3 closure — E. Touch of Death without Chi Transfer', () => {
  it('non-Brewmaster → base utility, nonmember', () => {
    const [resolved] = resolveEffectiveDefensiveKit(baseInput({ className: 'Monk', specName: 'Windwalker' }), {
      catalog: [touchOfDeathCatalog('Monk', 'Windwalker')],
      specProfiles: [],
      modifierRules: [],
      semantics: [touchOfDeathBaseSemantics('Monk')],
      semanticRules: [chiTransferRule],
    });
    expect(resolved.usageRole).toBe('utility');
    expect(resolved.isDefensiveKitMember).toBe(false);
  });

  it('Brewmaster (spec profile applied) → rotational_survival/none, nonmember (opportunityMode none never entered by credit_only/normal paths)', () => {
    const [resolved] = resolveEffectiveDefensiveKit(baseInput({ className: 'Monk', specName: 'Brewmaster' }), {
      catalog: [touchOfDeathCatalog('Monk', null)],
      specProfiles: [],
      modifierRules: [],
      semantics: [touchOfDeathBrewmasterSemantics()],
      semanticRules: [chiTransferRule],
    });
    expect(resolved.usageRole).toBe('rotational_survival');
    expect(resolved.opportunityMode).toBe('none');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });
});

describe('E3 closure — F. Touch of Death WITH Chi Transfer (1272452)', () => {
  it('hybrid_survival + sustain added, credit_only, member true, missable false', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      baseInput({
        className: 'Monk',
        specName: 'Brewmaster',
        talentBuild: [{ id: 1, nodeID: 1, rank: 1, spellId: 1272452 }],
      }),
      {
        catalog: [touchOfDeathCatalog('Monk', null)],
        specProfiles: [],
        modifierRules: [],
        semantics: [touchOfDeathBrewmasterSemantics()],
        semanticRules: [chiTransferRule],
      },
    );
    expect(resolved.usageRole).toBe('hybrid_survival');
    expect(resolved.mechanisms).toContain('sustain');
    expect(resolved.opportunityMode).toBe('credit_only');
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });
});

// --- Transcendence: Transfer / Healing Winds (450560) — G, H ----------------

const transcendenceTransfer = catalogEntry({ spellId: 434766, name: 'Transcendence: Transfer', className: 'Shaman', specName: null });

function transcendenceSemantics(): EffectiveDefensiveSemanticEntry[] {
  return [
    semanticEntry(434766, 'Shaman', {
      usageRole: 'utility',
      activationScope: 'self',
      primaryBeneficiary: 'none',
      mechanisms: [],
      opportunityMode: 'none',
      defensiveIntent: 'none',
    }),
  ];
}

const healingWindsRule: EffectiveDefensiveSemanticRule = {
  id: 'healing-winds',
  modifierSpellId: 450560,
  targetSpellId: 434766,
  specNames: null,
  gameBuild: GAME_BUILD,
  ruleType: 'augment',
  payload: {
    condition: 'talent_selected',
    setUsageRole: 'hybrid_survival',
    setDefensiveIntent: 'hybrid',
    setOpportunityMode: 'credit_only',
    setPrimaryBeneficiary: 'self',
    addMechanisms: ['sustain'],
    applicabilityPatch: { timingRelation: 'after_damage' },
  },
  source: 'test',
  verified: true,
};

describe('E3 closure — G/H. Transcendence: Transfer + Healing Winds (450560)', () => {
  it('G: without Healing Winds → utility, nonmember', () => {
    const [resolved] = resolveEffectiveDefensiveKit(baseInput({ className: 'Shaman', specName: 'Restoration', talentBuild: [] }), {
      catalog: [transcendenceTransfer],
      specProfiles: [],
      modifierRules: [],
      semantics: transcendenceSemantics(),
      semanticRules: [healingWindsRule],
    });
    expect(resolved.usageRole).toBe('utility');
    expect(resolved.isDefensiveKitMember).toBe(false);
  });

  it('H: with Healing Winds selected → hybrid_survival/sustain/credit_only, member true, missable false', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      baseInput({
        className: 'Shaman',
        specName: 'Restoration',
        talentBuild: [{ id: 1, nodeID: 1, rank: 1, spellId: 450560 }],
      }),
      {
        catalog: [transcendenceTransfer],
        specProfiles: [],
        modifierRules: [],
        semantics: transcendenceSemantics(),
        semanticRules: [healingWindsRule],
      },
    );
    expect(resolved.usageRole).toBe('hybrid_survival');
    expect(resolved.mechanisms).toContain('sustain');
    expect(resolved.opportunityMode).toBe('credit_only');
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });
});

// --- Heart of the Wild runtime (1261867) — I ---------------------------------

describe('E3 closure — I. Heart of the Wild selected, no runtime Bear evidence', () => {
  it('runtime rule stays unresolved — never becomes a normal missable, no engine invented', () => {
    const hotw = catalogEntry({ spellId: 1261867, name: 'Heart of the Wild', className: 'Druid', specName: null });
    const semantics = [
      semanticEntry(1261867, 'Druid', {
        usageRole: 'utility',
        activationScope: 'self',
        primaryBeneficiary: 'none',
        mechanisms: [],
        opportunityMode: 'none',
        defensiveIntent: 'hybrid',
      }),
    ];
    const hotwRule: EffectiveDefensiveSemanticRule = {
      id: 'hotw-bear',
      modifierSpellId: 1261867,
      targetSpellId: 1261867,
      specNames: ['Balance', 'Feral', 'Guardian', 'Restoration'],
      gameBuild: GAME_BUILD,
      ruleType: 'augment',
      payload: {
        condition: 'runtime_state', // NOT automatic — must never auto-apply
        setUsageRole: 'hybrid_survival',
        setOpportunityMode: 'credit_only',
        setPrimaryBeneficiary: 'self',
        addMechanisms: ['effective_health'],
      },
      source: 'test',
      verified: true,
    };
    const [resolved] = resolveEffectiveDefensiveKit(
      baseInput({
        className: 'Druid',
        specName: 'Restoration',
        talentBuild: [{ id: 1, nodeID: 1, rank: 1, spellId: 1261867 }], // HotW itself selected — the Bear-form branch is NOT
      }),
      { catalog: [hotw], specProfiles: [], modifierRules: [], semantics, semanticRules: [hotwRule] },
    );
    expect(resolved.usageRole).toBe('utility'); // never auto-promoted to hybrid_survival
    expect(resolved.opportunityMode).toBe('none');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.unresolvedRuntimeRules).toHaveLength(1);
    expect(resolved.unresolvedRuntimeRules[0].condition).toBe('runtime_state');
  });
});

// --- Shadow Bulwark / Grimoire of Sacrifice (108503) — J ---------------------

describe('E3 closure — J. Shadow Bulwark / Grimoire of Sacrifice runtime', () => {
  it('runtime rule stays unresolved without runtime evidence — never a silent baseline personal missable', () => {
    const shadowBulwark = catalogEntry({ spellId: 132413, name: 'Shadow Bulwark', className: 'Warlock', specName: null });
    const semantics = [
      semanticEntry(132413, 'Warlock', {
        usageRole: 'utility',
        activationScope: 'self',
        primaryBeneficiary: 'none',
        mechanisms: [],
        opportunityMode: 'none',
        defensiveIntent: 'hybrid',
      }),
    ];
    const grimoireRule: EffectiveDefensiveSemanticRule = {
      id: 'grimoire-shadow-bulwark',
      modifierSpellId: 108503,
      targetSpellId: 132413,
      specNames: ['Affliction', 'Destruction'],
      gameBuild: GAME_BUILD,
      ruleType: 'augment',
      payload: {
        condition: 'runtime_state',
        setUsageRole: 'personal_survival',
        setOpportunityMode: 'normal',
        setPrimaryBeneficiary: 'self',
        addMechanisms: ['effective_health', 'sustain'],
      },
      source: 'test',
      verified: true,
    };
    const [resolved] = resolveEffectiveDefensiveKit(baseInput({ className: 'Warlock', specName: 'Destruction', talentBuild: [] }), {
      catalog: [shadowBulwark],
      specProfiles: [],
      modifierRules: [],
      semantics,
      semanticRules: [grimoireRule],
    });
    expect(resolved.usageRole).toBe('utility');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.unresolvedRuntimeRules).toHaveLength(1);
  });
});

// --- rejected semantic — K ----------------------------------------------------

describe('E3 closure — K. rejected semantic', () => {
  it('never member, never missable, regardless of mechanisms/applicability being asked for', () => {
    const runeTap = catalogEntry({ spellId: 194679, name: 'Rune Tap', className: 'Rogue', specName: null });
    const semantics = [
      semanticEntry(194679, 'Rogue', {
        semanticStatus: 'rejected',
        usageRole: 'unknown',
        activationScope: 'unknown',
        primaryBeneficiary: 'unknown',
        mechanisms: [],
        opportunityMode: 'none',
      }),
    ];
    const [resolved] = resolveEffectiveDefensiveKit(baseInput({ className: 'Rogue', specName: 'Subtlety' }), {
      catalog: [runeTap],
      specProfiles: [],
      modifierRules: [],
      semantics,
      semanticRules: [],
    });
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });
});

// --- Avatar clean profile — L -------------------------------------------------

describe('E3 closure — L. Avatar clean Protection/Arms profiles', () => {
  it('strict parser accepts both repaired profiles with zero invalid entries', () => {
    const parsed = parseSpecSemanticProfiles([
      {
        spec: 'Arms',
        usageRole: 'hybrid_survival',
        defensiveIntent: 'hybrid',
        activationScope: 'self',
        primaryBeneficiary: 'self',
        secondaryPropagation: 'none',
        mechanisms: ['mitigation'],
        opportunityMode: 'credit_only',
        applicability: {
          schoolScope: 'all',
          schools: [],
          deliveryScopes: ['aoe'],
          requiresDodgeable: null,
          requiresParryable: null,
          requiresBlockable: null,
          requiresSourceAffectedBySpell: null,
          timingRelation: 'before_or_during',
        },
        source: 'IRIS E3 manual closure 2026-09-04',
        confidence: 'high',
      },
      {
        spec: 'Protection',
        usageRole: 'hybrid_survival',
        defensiveIntent: 'hybrid',
        activationScope: 'self',
        primaryBeneficiary: 'self',
        secondaryPropagation: 'none',
        mechanisms: ['mitigation'],
        opportunityMode: 'credit_only',
        applicability: {
          schoolScope: 'all',
          schools: [],
          deliveryScopes: ['all'],
          requiresDodgeable: null,
          requiresParryable: null,
          requiresBlockable: null,
          requiresSourceAffectedBySpell: null,
          timingRelation: 'before_or_during',
        },
        source: 'IRIS E3 manual closure 2026-09-04',
        confidence: 'high',
      },
    ]);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.profiles).toHaveLength(2);
    expect(parsed.profiles.map((p) => p.spec).sort()).toEqual(['Arms', 'Protection']);
  });

  it('the repaired Protection profile itself is defensiveSemanticError-clean', () => {
    const parsed = parseSpecSemanticProfiles([
      {
        spec: 'Protection',
        usageRole: 'hybrid_survival',
        defensiveIntent: 'hybrid',
        activationScope: 'self',
        primaryBeneficiary: 'self',
        secondaryPropagation: 'none',
        mechanisms: ['mitigation'],
        opportunityMode: 'credit_only',
        applicability: null,
        source: null,
        confidence: null,
      },
    ]);
    const [protection] = parsed.profiles;
    expect(
      defensiveSemanticError({
        usageRole: protection.usageRole,
        activationScope: protection.activationScope,
        primaryBeneficiary: protection.primaryBeneficiary,
        secondaryPropagation: protection.secondaryPropagation,
        mechanisms: protection.mechanisms,
        opportunityMode: protection.opportunityMode,
      }),
    ).toBeNull();
  });
});
