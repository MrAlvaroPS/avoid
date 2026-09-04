import { describe, expect, it } from 'vitest';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION,
  effectiveDefensiveDataFromDatabaseRows,
  fingerprintTalentBuild,
  inferCurrentGameBuildObservation,
  resolveEffectiveDefensiveKit,
  type EffectiveDefensiveCatalogEntry,
  type EffectiveDefensiveData,
  type EffectiveDefensiveModifierRule,
  type EffectiveDefensiveSemanticEntry,
  type EffectiveDefensiveSemanticRule,
  type ResolveDefensiveKitInput,
} from '../../../supabase/functions/_shared/effective-defensives';

const GAME_BUILD = '12.1.0.68914';
const MODIFIER_SPELL_ID = 12345;

const fade: EffectiveDefensiveCatalogEntry = {
  spellId: 586,
  name: 'Fade',
  className: 'Priest',
  specName: null,
  specOverride: null,
  category: 'personal_defensive',
  survivalType: 'mitigation',
  targetingMode: 'self',
  activationMode: 'active',
  passiveConversionSpellIds: [],
  activationGameBuild: GAME_BUILD,
  baseCooldownMs: 30_000,
  baseDurationMs: 10_000,
};

function input(overrides: Partial<ResolveDefensiveKitInput> = {}): ResolveDefensiveKitInput {
  return {
    className: 'Priest',
    specName: 'Shadow',
    talentBuild: [],
    buildFingerprint: 'sha256:build-a',
    gameBuild: GAME_BUILD,
    gameBuildConfidence: 'verified',
    playerIdentity: { characterId: 7, playerName: 'Pandokie' },
    ...overrides,
  };
}

function modifier(overrides: Partial<EffectiveDefensiveModifierRule> = {}): EffectiveDefensiveModifierRule {
  return {
    id: 'improved-fade',
    className: 'Priest',
    specNames: null,
    modifierSpellId: MODIFIER_SPELL_ID,
    targetSpellId: fade.spellId,
    operation: 'subtract_ms',
    effectField: 'cooldown_ms',
    value: 5_000,
    perRank: true,
    condition: 'always',
    gameBuild: GAME_BUILD,
    applicationOrder: 100,
    description: 'Improved Fade',
    source: 'test',
    active: true,
    ...overrides,
  };
}

function data(overrides: Partial<EffectiveDefensiveData> = {}): EffectiveDefensiveData {
  return {
    catalog: [fade],
    specProfiles: [],
    modifierRules: [],
    overrides: [],
    ...overrides,
  };
}

describe('resolveEffectiveDefensiveKit', () => {
  it('uses the catalog baseline when no profile, rule or override applies', () => {
    const [resolved] = resolveEffectiveDefensiveKit(input(), data());

    expect(resolved.effectiveCooldownMs).toBe(30_000);
    expect(resolved.effectiveDurationMs).toBe(10_000);
    expect(resolved.charges).toBe(1);
    expect(resolved.confidence).toBe('verified');
    expect(resolved.resolverVersion).toBe(EFFECTIVE_DEFENSIVE_RESOLVER_VERSION);
  });

  it('does not describe an unversioned historical catalog baseline as verified', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ gameBuild: null, gameBuildConfidence: 'uncertain', buildFingerprint: null }),
      data(),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
    expect(resolved.confidence).toBe('uncertain');
  });

  it('downgrades confidence when the caller could not load the talent lookup', () => {
    const [resolved] = resolveEffectiveDefensiveKit(input({ talentLookupComplete: false }), data());

    expect(resolved.eligible).toBe(true);
    expect(resolved.confidence).toBe('fallback');
  });

  it('marks an unselected talent-gated defensive as ineligible', () => {
    const talentDefensive = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ allTalentSpellIds: new Set([talentDefensive.spellId]) }),
      data({ catalog: [talentDefensive] }),
    );

    expect(resolved.eligible).toBe(false);
  });

  it('marks an active defensive passive and ineligible when its conversion talent is selected', () => {
    const conversionSpellId = 999001;
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: conversionSpellId }] }),
      data({ catalog: [{ ...fade, passiveConversionSpellIds: [conversionSpellId] }] }),
    );

    expect(resolved.activationMode).toBe('passive');
    expect(resolved.eligible).toBe(false);
    expect(resolved.provenance).toContainEqual(expect.objectContaining({ kind: 'availability_rule', field: 'activation_mode' }));
  });

  it('excludes a conditional active/passive defensive when its rule belongs to another build', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input(),
      data({ catalog: [{ ...fade, passiveConversionSpellIds: [999001], activationGameBuild: '12.0.0.60000' }] }),
    );

    expect(resolved.eligible).toBe(false);
    expect(resolved.confidence).toBe('uncertain');
  });

  it('does not invent ineligibility when the talent build is missing', () => {
    const talentDefensive = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: null, allTalentSpellIds: new Set([talentDefensive.spellId]) }),
      data({ catalog: [talentDefensive] }),
    );

    expect(resolved.eligible).toBe(true);
    expect(resolved.confidence).toBe('uncertain');
  });

  it('applies a per-rank modifier and resolves Fade 30s to 20s at rank 2', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 2, spellId: MODIFIER_SPELL_ID }] }),
      data({ modifierRules: [modifier()] }),
    );

    expect(resolved.effectiveCooldownMs).toBe(20_000);
    expect(resolved.provenance.some((step) => step.ruleId === 'improved-fade' && step.after === 20_000)).toBe(true);
  });

  it('applies one rank exactly once', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({ modifierRules: [modifier()] }),
    );

    expect(resolved.effectiveCooldownMs).toBe(25_000);
  });

  it('lets an exact spec profile replace catalog values before modifiers', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input(),
      data({
        specProfiles: [
          {
            className: 'Priest',
            specName: 'Shadow',
            spellId: fade.spellId,
            gameBuild: GAME_BUILD,
            baseCooldownMs: 25_000,
            baseDurationMs: 8_000,
            charges: 2,
            rechargeMs: 25_000,
            source: 'test',
          },
        ],
      }),
    );

    expect(resolved.effectiveCooldownMs).toBe(25_000);
    expect(resolved.effectiveDurationMs).toBe(8_000);
    expect(resolved.charges).toBe(2);
    expect(resolved.rechargeMs).toBe(25_000);
  });

  it('uses the final effective cooldown as recharge when multiple charges have no separate recharge', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input(),
      data({
        specProfiles: [
          {
            className: 'Priest',
            specName: 'Shadow',
            spellId: fade.spellId,
            gameBuild: GAME_BUILD,
            baseCooldownMs: 25_000,
            baseDurationMs: null,
            charges: 2,
            rechargeMs: null,
          },
        ],
      }),
    );

    expect(resolved.charges).toBe(2);
    expect(resolved.rechargeMs).toBe(25_000);
  });

  it('returns conditional rules as metadata without reducing guaranteed cooldown', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 2, spellId: MODIFIER_SPELL_ID }] }),
      data({ modifierRules: [modifier({ condition: 'conditional' })] }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
    expect(resolved.conditionalModifiers).toHaveLength(1);
  });

  it('lets an exact fingerprint override win and keeps the automatic value in provenance', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input(),
      data({
        overrides: [
          {
            id: 'override-1',
            characterId: 7,
            playerName: 'Pandokie',
            className: 'Priest',
            specName: 'Shadow',
            spellId: fade.spellId,
            buildFingerprint: 'sha256:build-a',
            gameBuild: GAME_BUILD,
            effectiveCooldownMs: 17_000,
            effectiveDurationMs: null,
            charges: null,
            targetingMode: null,
            reason: 'Verificación manual',
            active: true,
          },
        ],
      }),
    );

    expect(resolved.effectiveCooldownMs).toBe(17_000);
    expect(resolved.provenance.at(-1)).toMatchObject({ kind: 'player_override', before: 30_000, after: 17_000 });
  });

  it('does not apply a fingerprint-specific override after the build changes', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ buildFingerprint: 'sha256:build-b' }),
      data({
        overrides: [
          {
            id: 'override-1',
            characterId: 7,
            playerName: 'Pandokie',
            className: 'Priest',
            specName: 'Shadow',
            spellId: fade.spellId,
            buildFingerprint: 'sha256:build-a',
            gameBuild: GAME_BUILD,
            effectiveCooldownMs: 17_000,
            effectiveDurationMs: null,
            charges: null,
            targetingMode: null,
            reason: 'Verificación manual',
            active: true,
          },
        ],
      }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
  });

  it('does not apply reusable overrides without an exact fingerprint', () => {
    const baseOverride = {
      characterId: 7,
      playerName: 'Pandokie',
      className: 'Priest',
      spellId: fade.spellId,
      buildFingerprint: null,
      gameBuild: GAME_BUILD,
      effectiveDurationMs: null,
      charges: null,
      targetingMode: null,
      reason: 'Test',
      active: true,
    };
    const [resolved] = resolveEffectiveDefensiveKit(
      input(),
      data({
        overrides: [
          { ...baseOverride, id: 'global', specName: null, effectiveCooldownMs: 22_000 },
          { ...baseOverride, id: 'shadow', specName: 'Shadow', effectiveCooldownMs: 18_000 },
        ],
      }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
  });

  it('does not apply a rule from a different game build', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 2, spellId: MODIFIER_SPELL_ID }] }),
      data({ modifierRules: [modifier({ gameBuild: '12.0.0.60000' })] }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
  });

  it('does not revive a legacy spec scope when the exact build changed it', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 2, spellId: MODIFIER_SPELL_ID }] }),
      data({
        modifierRules: [
          modifier({ id: 'legacy-shadow', gameBuild: 'legacy-current', specNames: ['Shadow'] }),
          modifier({ id: 'exact-holy', gameBuild: GAME_BUILD, specNames: ['Holy'] }),
        ],
      }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
  });

  it('uses legacy-current only as an explicit fallback', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 2, spellId: MODIFIER_SPELL_ID }] }),
      data({ modifierRules: [modifier({ gameBuild: 'legacy-current' })] }),
    );

    expect(resolved.effectiveCooldownMs).toBe(20_000);
    expect(resolved.confidence).toBe('fallback');
  });

  it('rejects a modifier result that would make a cooldown negative', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({ modifierRules: [modifier({ value: 40_000, perRank: false })] }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
    expect(resolved.confidence).toBe('uncertain');
  });

  it('marks incompatible set rules uncertain instead of choosing one', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        modifierRules: [
          modifier({ id: 'set-a', operation: 'set_ms', value: 20_000, perRank: false }),
          modifier({ id: 'set-b', operation: 'set_ms', value: 25_000, perRank: false }),
        ],
      }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
    expect(resolved.confidence).toBe('uncertain');
  });

  it('does not apply a spec-scoped override when player spec is unknown', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ specName: null }),
      data({
        overrides: [
          {
            id: 'holy-only',
            characterId: 7,
            playerName: 'Pandokie',
            className: 'Priest',
            specName: 'Holy',
            spellId: fade.spellId,
            buildFingerprint: 'sha256:build-a',
            gameBuild: GAME_BUILD,
            effectiveCooldownMs: 17_000,
            effectiveDurationMs: null,
            charges: null,
            targetingMode: null,
            reason: 'Solo Holy',
            active: true,
          },
        ],
      }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
  });

  it('does not apply a spec-scoped modifier when player spec is unknown', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ specName: null, talentBuild: [{ id: 90, nodeID: 91, rank: 2, spellId: MODIFIER_SPELL_ID }] }),
      data({ modifierRules: [modifier({ specNames: ['Holy'] })] }),
    );

    expect(resolved.effectiveCooldownMs).toBe(30_000);
    expect(resolved.confidence).toBe('uncertain');
  });
});

describe('fingerprintTalentBuild', () => {
  it('is stable across input order and changes when rank changes', async () => {
    const a = await fingerprintTalentBuild('Priest', 'Shadow', GAME_BUILD, [
      { id: 2, nodeID: 20, rank: 1, spellId: 200 },
      { id: 1, nodeID: 10, rank: 2, spellId: 100 },
    ]);
    const reordered = await fingerprintTalentBuild('Priest', 'Shadow', GAME_BUILD, [
      { id: 1, nodeID: 10, rank: 2, spellId: 100 },
      { id: 2, nodeID: 20, rank: 1, spellId: 200 },
    ]);
    const otherRank = await fingerprintTalentBuild('Priest', 'Shadow', GAME_BUILD, [
      { id: 1, nodeID: 10, rank: 1, spellId: 100 },
      { id: 2, nodeID: 20, rank: 1, spellId: 200 },
    ]);

    expect(a).toBe(reordered);
    expect(a).not.toBe(otherRank);
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('database row adapter and game-build observation', () => {
  it('maps v5 modifier rows to an explicit legacy fallback', () => {
    const mapped = effectiveDefensiveDataFromDatabaseRows({
      catalogRows: [],
      modifierRuleRows: [
        {
          id: 'legacy-rule',
          class: 'Priest',
          modifier_spell_id: MODIFIER_SPELL_ID,
          target_spell_id: fade.spellId,
          operation: 'subtract_ms',
          value: 5_000,
          per_rank: true,
          condition: 'always',
          description: 'v5 row',
          active: true,
        },
      ],
    });

    expect(mapped.modifierRules[0]).toMatchObject({
      gameBuild: 'legacy-current',
      effectField: 'cooldown_ms',
      applicationOrder: 100,
    });
  });

  it('only infers the current Blizzard build for a report observed within 48 hours', () => {
    const now = Date.UTC(2026, 7, 31, 12);
    const recent = inferCurrentGameBuildObservation({
      currentGameBuild: GAME_BUILD,
      reportStartTimeMs: now - 60 * 60 * 1000,
      fightStartTimeMs: 30 * 60 * 1000,
      analyzedAtMs: now,
    });
    const historical = inferCurrentGameBuildObservation({
      currentGameBuild: GAME_BUILD,
      reportStartTimeMs: now - 8 * 24 * 60 * 60 * 1000,
      fightStartTimeMs: 0,
      analyzedAtMs: now,
    });

    expect(recent).toMatchObject({ gameBuild: GAME_BUILD, confidence: 'inferred' });
    expect(historical).toEqual({ gameBuild: null, source: null, confidence: 'uncertain' });
  });
});

// §Paso C (iris-defensive-canonicalization-v1-plan.md §5): resolución
// semántica del resolver — ortogonal al timing de arriba. Fixtures tomadas
// de los casos de aceptación del plan (§7): Bear Form, AMS, Death Strike,
// Mirror Image + Refractive Images.
describe('resolveEffectiveDefensiveKit — Paso C semantic resolution', () => {
  function semanticEntry(overrides: Partial<EffectiveDefensiveSemanticEntry> = {}): EffectiveDefensiveSemanticEntry {
    return {
      spellId: fade.spellId,
      className: 'Priest',
      usageRole: 'personal_survival',
      activationScope: 'self',
      primaryBeneficiary: 'self',
      secondaryPropagation: 'none',
      mechanisms: ['mitigation'],
      opportunityMode: 'normal',
      defensiveIntent: 'primary',
      semanticStatus: 'verified',
      semanticVersion: 'defensive-semantics@1.0.0',
      semanticConfidence: 'inferred',
      locked: false,
      ...overrides,
    };
  }

  function semanticRule(overrides: Partial<EffectiveDefensiveSemanticRule> = {}): EffectiveDefensiveSemanticRule {
    return {
      id: 'rule-1',
      modifierSpellId: MODIFIER_SPELL_ID,
      targetSpellId: fade.spellId,
      specNames: null,
      gameBuild: GAME_BUILD,
      ruleType: 'augment',
      payload: {},
      source: 'test',
      verified: true,
      ...overrides,
    };
  }

  it('leaves every semantic field at its neutral default when the caller does not pass data.semantics (legacy timing-only callers stay unaffected)', () => {
    const [resolved] = resolveEffectiveDefensiveKit(input(), data());
    expect(resolved.semanticResolved).toBe(false);
    expect(resolved.usageRole).toBe('unknown');
    expect(resolved.semanticStatus).toBe('pending');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.semanticResolverVersion).toBe(EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION);
  });

  it('resolves pending (never counts) when semantics were requested but no row matches this spellId/class', () => {
    const [resolved] = resolveEffectiveDefensiveKit(input(), data({ semantics: [] }));
    expect(resolved.semanticResolved).toBe(true);
    expect(resolved.semanticStatus).toBe('pending');
    expect(resolved.isDefensiveKitMember).toBe(false);
  });

  it('a verified personal_survival counts as kit member and can miss (Barkskin-style)', () => {
    const [resolved] = resolveEffectiveDefensiveKit(input(), data({ semantics: [semanticEntry()] }));
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);
  });

  it('survival_state (Bear Form) counts as kit member but never misses, even verified+active', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input(),
      data({ semantics: [semanticEntry({ usageRole: 'survival_state', opportunityMode: 'credit_only' })] }),
    );
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });

  it('AMS-style automatic ally propagation still counts as personal kit (propagation never changes primaryBeneficiary)', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input(),
      data({ semantics: [semanticEntry({ mechanisms: ['absorption'], secondaryPropagation: 'automatic_ally' })] }),
    );
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);
  });

  it('Death Strike-style rotational_survival (self-beneficiary, cast at an enemy) never counts as personal kit', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input(),
      data({
        semantics: [
          semanticEntry({ usageRole: 'rotational_survival', activationScope: 'enemy', mechanisms: ['sustain'], opportunityMode: 'none' }),
        ],
      }),
    );
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });

  it('perfect semantics never count if the ability is not eligible in this build (talent not selected) — invariant 1', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [], allTalentSpellIds: new Set([fade.spellId]), talentLookupComplete: true }),
      data({ semantics: [semanticEntry()] }),
    );
    expect(resolved.eligible).toBe(false); // no seleccionado en un build resuelto
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });

  it('an unverified semantic rule never applies automatically, even if the talent is selected', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        semantics: [semanticEntry({ usageRole: 'utility', mechanisms: [] })],
        semanticRules: [semanticRule({ verified: false, payload: { setUsageRole: 'personal_survival', addMechanisms: ['mitigation'] } })],
      }),
    );
    expect(resolved.usageRole).toBe('utility');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.semanticProvenance.some((step) => step.kind === 'semantic_rule_unverified')).toBe(true);
  });

  it('Mirror Image + Refractive Images: a verified augment rule turns a base utility row into personal_survival when the talent is selected', () => {
    const [withTalent] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        semantics: [semanticEntry({ usageRole: 'utility', mechanisms: [], opportunityMode: 'none' })],
        semanticRules: [
          semanticRule({
            payload: { modifierName: 'Refractive Images', setUsageRole: 'personal_survival', setOpportunityMode: 'normal', addMechanisms: ['mitigation'] },
          }),
        ],
      }),
    );
    expect(withTalent.usageRole).toBe('personal_survival');
    expect(withTalent.mechanisms).toEqual(['mitigation']);
    expect(withTalent.isDefensiveKitMember).toBe(true);
    expect(withTalent.createsMissableOpportunity).toBe(true);

    // Sin el talento seleccionado, la fila base (utility) no sobreclasifica.
    const [withoutTalent] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [] }),
      data({
        semantics: [semanticEntry({ usageRole: 'utility', mechanisms: [], opportunityMode: 'none' })],
        semanticRules: [semanticRule({ payload: { setUsageRole: 'personal_survival', addMechanisms: ['mitigation'] } })],
      }),
    );
    expect(withoutTalent.usageRole).toBe('utility');
    expect(withoutTalent.isDefensiveKitMember).toBe(false);
  });

  it('Ice Cold-style suppress rule makes the suppressed ability ineligible when the talent is selected', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        semantics: [semanticEntry()],
        semanticRules: [semanticRule({ ruleType: 'suppress' })],
      }),
    );
    expect(resolved.eligible).toBe(false);
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.semanticProvenance.some((step) => step.kind === 'semantic_rule_suppress')).toBe(true);
  });

  it('a replace rule marks the original spell ineligible and records the replacement spellId in the provenance', () => {
    const replacementSpellId = 555555;
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        semantics: [semanticEntry()],
        semanticRules: [semanticRule({ ruleType: 'replace', payload: { replacementSpellId } })],
      }),
    );
    expect(resolved.eligible).toBe(false);
    expect(resolved.semanticProvenance.some((step) => step.kind === 'semantic_rule_replace' && step.description.includes(String(replacementSpellId)))).toBe(true);
  });
});
