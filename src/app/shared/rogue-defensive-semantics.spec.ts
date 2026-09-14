import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveDefensiveKit,
  type EffectiveDefensiveCatalogEntry,
  type EffectiveDefensiveData,
  type EffectiveDefensiveSemanticEntry,
  type EffectiveDefensiveSemanticRule,
  type ResolveDefensiveKitInput,
} from '../../../supabase/functions/_shared/effective-defensives';

const GAME_BUILD = '12.1.0.68914';
const EVASION = 5277;
const ELUSIVENESS = 79008;
const CHEAT_DEATH = 31230;
const BAIT_AND_SWITCH = 457034;
const CRIMSON_VIAL = 185311;

const catalog: EffectiveDefensiveCatalogEntry[] = [
  {
    spellId: EVASION,
    name: 'Evasion',
    className: 'Rogue',
    specName: null,
    specOverride: null,
    category: 'personal_defensive',
    survivalType: 'mitigation',
    targetingMode: 'self',
    activationMode: 'active',
    passiveConversionSpellIds: [],
    activationGameBuild: GAME_BUILD,
    baseCooldownMs: 120_000,
    baseDurationMs: 10_000,
    reviewed: true,
  },
  {
    spellId: CRIMSON_VIAL,
    name: 'Crimson Vial',
    className: 'Rogue',
    specName: null,
    specOverride: null,
    category: 'personal_defensive',
    survivalType: 'sustain',
    targetingMode: 'self',
    activationMode: 'active',
    passiveConversionSpellIds: [],
    activationGameBuild: GAME_BUILD,
    baseCooldownMs: 30_000,
    baseDurationMs: 4_000,
    reviewed: true,
  },
];

function semanticEntry(
  overrides: Partial<EffectiveDefensiveSemanticEntry>,
): EffectiveDefensiveSemanticEntry {
  return {
    spellId: EVASION,
    className: 'Rogue',
    usageRole: 'personal_survival',
    activationScope: 'self',
    primaryBeneficiary: 'self',
    secondaryPropagation: 'none',
    mechanisms: ['avoidance'],
    opportunityMode: 'credit_only',
    defensiveIntent: 'primary',
    semanticStatus: 'verified',
    semanticVersion: 'defensive-semantics@1.0.0',
    semanticConfidence: 'verified',
    locked: true,
    applicability: {
      schoolScope: 'physical',
      schools: [],
      deliveryScopes: ['direct'],
      requiresDodgeable: true,
      requiresParryable: false,
      requiresBlockable: false,
      requiresSourceAffectedBySpell: false,
      timingRelation: 'before_or_during',
    },
    applicabilityConfidence: 'high',
    applicabilityError: null,
    specSemanticProfiles: [],
    invalidSpecSemanticProfiles: [],
    ...overrides,
  };
}

const semantics: EffectiveDefensiveSemanticEntry[] = [
  semanticEntry({}),
  semanticEntry({
    spellId: CRIMSON_VIAL,
    mechanisms: ['sustain'],
    opportunityMode: 'credit_only',
    applicability: {
      schoolScope: 'all',
      schools: [],
      deliveryScopes: ['all'],
      requiresDodgeable: false,
      requiresParryable: false,
      requiresBlockable: false,
      requiresSourceAffectedBySpell: false,
      timingRelation: 'after_damage',
    },
  }),
];

function augmentRule(
  id: string,
  modifierSpellId: number,
  modifierName: string,
  specs: string[],
): EffectiveDefensiveSemanticRule {
  return {
    id,
    modifierSpellId,
    targetSpellId: EVASION,
    specNames: specs,
    gameBuild: GAME_BUILD,
    ruleType: 'augment',
    payload: {
      condition: modifierSpellId === BAIT_AND_SWITCH ? 'hero_talent_selected' : 'talent_selected',
      modifierName,
      setUsageRole: null,
      setDefensiveIntent: null,
      setOpportunityMode: 'normal',
      setPrimaryBeneficiary: null,
      setSecondaryPropagation: null,
      addMechanisms: ['mitigation'],
      removeMechanisms: [],
      applicabilityPatch: {
        schoolScope: 'all',
        schools: [],
        deliveryScopes: ['all'],
        requiresDodgeable: false,
        requiresParryable: null,
        requiresBlockable: null,
        requiresSourceAffectedBySpell: false,
        timingRelation: 'before_or_during',
      },
    },
    source: 'IRIS Rogue 12.1 defensive semantics fixture',
    verified: true,
  };
}

const semanticRules: EffectiveDefensiveSemanticRule[] = [
  augmentRule(
    'elusiveness-evasion',
    ELUSIVENESS,
    'Elusiveness',
    ['Assassination', 'Outlaw', 'Subtlety'],
  ),
  augmentRule(
    'bait-and-switch-evasion',
    BAIT_AND_SWITCH,
    'Bait and Switch',
    ['Assassination', 'Subtlety'],
  ),
];

function input(
  specName: 'Assassination' | 'Outlaw' | 'Subtlety',
  selectedSpellIds: number[] = [],
): ResolveDefensiveKitInput {
  return {
    className: 'Rogue',
    specName,
    talentBuild: selectedSpellIds.map((spellId, index) => ({
      id: 100_000 + index,
      nodeID: 200_000 + index,
      rank: 1,
      spellId,
    })),
    buildFingerprint: `rogue:${specName}:${selectedSpellIds.join(',')}`,
    gameBuild: GAME_BUILD,
    gameBuildConfidence: 'verified',
    playerIdentity: { characterId: 1, playerName: 'Rivax' },
    talentLookupComplete: true,
    knownTalentEntryIds: new Set(selectedSpellIds.map((_, index) => 100_000 + index)),
  };
}

const data: EffectiveDefensiveData = {
  catalog,
  specProfiles: [],
  modifierRules: [],
  overrides: [],
  semantics,
  semanticRules,
};

function resolved(spellId: number, selectedSpellIds: number[] = [], spec: 'Assassination' | 'Outlaw' | 'Subtlety' = 'Assassination') {
  return resolveEffectiveDefensiveKit(input(spec, selectedSpellIds), data).find((entry) => entry.spellId === spellId)!;
}

describe('Rogue 12.1 defensive semantics', () => {
  it('keeps baseline Evasion as conditional bonus: visible, creditable, but never a generic missed raid defensive', () => {
    const evasion = resolved(EVASION);

    expect(evasion.isDefensiveKitMember).toBe(true);
    expect(evasion.opportunityMode).toBe('credit_only');
    expect(evasion.createsMissableOpportunity).toBe(false);
    expect(evasion.mechanisms).toEqual(['avoidance']);
    expect(evasion.applicability?.schoolScope).toBe('physical');
    expect(evasion.applicability?.requiresDodgeable).toBe(true);
  });

  it('does not confuse Rivax-style Cheat Death selection with Elusiveness', () => {
    const evasion = resolved(EVASION, [CHEAT_DEATH]);

    expect(evasion.opportunityMode).toBe('credit_only');
    expect(evasion.createsMissableOpportunity).toBe(false);
    expect(evasion.mechanisms).not.toContain('mitigation');
    expect(evasion.semanticProvenance.some((step) => step.kind === 'semantic_rule_augment')).toBe(false);
  });

  it('promotes Evasion to a normal general mitigator only when Elusiveness is selected', () => {
    const evasion = resolved(EVASION, [ELUSIVENESS]);

    expect(evasion.isDefensiveKitMember).toBe(true);
    expect(evasion.opportunityMode).toBe('normal');
    expect(evasion.createsMissableOpportunity).toBe(true);
    expect(evasion.mechanisms).toContain('avoidance');
    expect(evasion.mechanisms).toContain('mitigation');
    expect(evasion.applicability?.schoolScope).toBe('all');
    expect(evasion.applicability?.requiresDodgeable).toBe(false);
    expect(evasion.semanticProvenance).toContainEqual(
      expect.objectContaining({ kind: 'semantic_rule_augment', ruleId: 'elusiveness-evasion' }),
    );
  });

  it('preserves Deathstalker Bait and Switch as a normal mitigation opportunity after baseline Evasion becomes credit_only', () => {
    const evasion = resolved(EVASION, [BAIT_AND_SWITCH], 'Assassination');

    expect(evasion.opportunityMode).toBe('normal');
    expect(evasion.createsMissableOpportunity).toBe(true);
    expect(evasion.mechanisms).toContain('mitigation');
    expect(evasion.semanticProvenance).toContainEqual(
      expect.objectContaining({ kind: 'semantic_rule_augment', ruleId: 'bait-and-switch-evasion' }),
    );
  });

  it('keeps Crimson Vial as personal sustain credit without manufacturing missed spike coverage', () => {
    const vial = resolved(CRIMSON_VIAL);

    expect(vial.isDefensiveKitMember).toBe(true);
    expect(vial.opportunityMode).toBe('credit_only');
    expect(vial.createsMissableOpportunity).toBe(false);
    expect(vial.mechanisms).toEqual(['sustain']);
    expect(vial.applicability?.timingRelation).toBe('after_damage');
  });
});