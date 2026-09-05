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
const DIVINE_SHIELD = 642;
const FINAL_STAND = 204077;

const catalog: EffectiveDefensiveCatalogEntry = {
  spellId: DIVINE_SHIELD,
  name: 'Divine Shield',
  className: 'Paladin',
  specName: 'Holy/Protection/Retribution',
  specOverride: null,
  category: 'personal_defensive',
  survivalType: 'emergency',
  targetingMode: 'self',
  activationMode: 'active',
  passiveConversionSpellIds: [],
  activationGameBuild: GAME_BUILD,
  baseCooldownMs: 210_000,
  baseDurationMs: 8_000,
  reviewed: true,
};

const semantics: EffectiveDefensiveSemanticEntry = {
  spellId: DIVINE_SHIELD,
  className: 'Paladin',
  usageRole: 'personal_survival',
  activationScope: 'self',
  primaryBeneficiary: 'self',
  secondaryPropagation: 'none',
  mechanisms: ['immunity'],
  opportunityMode: 'normal',
  defensiveIntent: 'primary',
  semanticStatus: 'verified',
  semanticVersion: 'defensive-semantics@1.0.1',
  semanticConfidence: 'verified',
  locked: false,
  applicability: {
    schoolScope: 'all',
    schools: [],
    deliveryScopes: ['all'],
    requiresDodgeable: false,
    requiresParryable: false,
    requiresBlockable: false,
    requiresSourceAffectedBySpell: false,
    timingRelation: 'before_or_during',
  },
  applicabilityConfidence: 'high',
  applicabilityError: null,
  specSemanticProfiles: [
    {
      spec: 'Protection',
      usageRole: 'personal_survival',
      defensiveIntent: 'primary',
      activationScope: 'self',
      primaryBeneficiary: 'self',
      secondaryPropagation: 'none',
      mechanisms: ['immunity'],
      opportunityMode: 'credit_only',
      applicability: null,
      source: 'test',
      confidence: 'high',
    },
  ],
  invalidSpecSemanticProfiles: [],
};

const finalStandRule: EffectiveDefensiveSemanticRule = {
  id: 'final-stand-divine-shield',
  modifierSpellId: FINAL_STAND,
  targetSpellId: DIVINE_SHIELD,
  specNames: ['Protection'],
  gameBuild: GAME_BUILD,
  ruleType: 'augment',
  payload: {
    condition: 'talent_selected',
    modifierName: 'Final Stand',
    setOpportunityMode: 'normal',
    addMechanisms: [],
    removeMechanisms: [],
  },
  source: 'test',
  verified: true,
};

function input(specName: 'Protection' | 'Holy' | 'Retribution', finalStand = false): ResolveDefensiveKitInput {
  return {
    className: 'Paladin',
    specName,
    talentBuild: finalStand ? [{ id: 102473, nodeID: 1, rank: 1, spellId: FINAL_STAND }] : [],
    buildFingerprint: `test:${specName}:${finalStand}`,
    gameBuild: GAME_BUILD,
    gameBuildConfidence: 'verified',
    playerIdentity: { characterId: 1, playerName: 'Fixture' },
    talentLookupComplete: true,
    knownTalentEntryIds: new Set([102473]),
  };
}

const data: EffectiveDefensiveData = {
  catalog: [catalog],
  specProfiles: [],
  modifierRules: [],
  overrides: [],
  semantics: [semantics],
  semanticRules: [finalStandRule],
};

describe('Protection Divine Shield / Final Stand opportunity semantics', () => {
  it('is credit_only for Protection without Final Stand: usage can receive credit but availability cannot manufacture a miss', () => {
    const [resolved] = resolveEffectiveDefensiveKit(input('Protection'), data);

    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.opportunityMode).toBe('credit_only');
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.semanticProvenance).toContainEqual(expect.objectContaining({ kind: 'spec_profile_applied' }));
  });

  it('becomes normal for Protection when Final Stand is selected', () => {
    const [resolved] = resolveEffectiveDefensiveKit(input('Protection', true), data);

    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.opportunityMode).toBe('normal');
    expect(resolved.createsMissableOpportunity).toBe(true);
    expect(resolved.semanticProvenance).toContainEqual(expect.objectContaining({ kind: 'semantic_rule_augment', ruleId: 'final-stand-divine-shield' }));
  });

  it.each(['Holy', 'Retribution'] as const)('leaves %s Divine Shield on the base normal opportunity semantics', (specName) => {
    const [resolved] = resolveEffectiveDefensiveKit(input(specName), data);

    expect(resolved.opportunityMode).toBe('normal');
    expect(resolved.createsMissableOpportunity).toBe(true);
    expect(resolved.semanticProvenance.some((step) => step.kind === 'spec_profile_applied')).toBe(false);
  });
});
