import { describe, expect, it } from 'vitest';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION,
  computeDemonstratedPersistentCastSpellIds,
  effectiveDefensiveDataFromDatabaseRows,
  fingerprintTalentBuild,
  inferCurrentGameBuildObservation,
  resolveEffectiveDefensiveKit,
  type EffectiveDefensiveCatalogEntry,
  type EffectiveDefensiveData,
  type EffectiveDefensiveModifierRule,
  type EffectiveDefensiveSemanticEntry,
  type EffectiveDefensiveSemanticRule,
  type ObservedCastForEvidence,
  type ResolveDefensiveKitInput,
  type ResolvedDefensive,
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
    applicability: null,
    applicabilityConfidence: null,
    applicabilityError: null,
    specSemanticProfiles: [],
    invalidSpecSemanticProfiles: [],
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
    // §E1: condition es obligatorio para que la regla sea AUTOMÁTICA
    // (talent_selected/hero_talent_selected) — payload sin condition (o con
    // runtime_state/other) queda en unresolvedRuntimeRules, no se aplica.
    payload: { condition: 'talent_selected' },
    source: 'test',
    verified: true,
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

  // §E2.1 (2026-09-04) — corrección de build-provenance: el E2 audit
  // encontró que TODO el roster tiene un nodo seleccionado sin spellId que
  // en realidad es un TraitNodeEntry real del DB2 (probablemente el selector
  // de Hero Talents) — no un talento genuinamente sin resolver.
  // knownTalentEntryIds es lo que permite distinguirlos sin inventar spellIds.
  describe('knownTalentEntryIds — nodo estructural vs. genuinamente sin resolver', () => {
    const heroTalentSelectorNodeId = 123325; // fixture only — nunca hardcoded en lógica de producción
    const otherTalent = { ...fade, spellId: 19236, name: 'Desperate Prayer' };

    // §E2.5: el REPLACEMENT_TARGET (Ice Cold-style) sigue siendo la única
    // ruta donde buildPresence='absent' es alcanzable con evidencia directa
    // de talento — la ruta DIRECTA (entry.spellId ∈ allTalentSpellIds) ya
    // nunca produce 'absent' por sí sola (ver el describe de más abajo). El
    // valor de knownTalentEntryIds ahora vive aquí: sin reconocer el nodo
    // estructural, unresolvedSelectedNodes bloquearía incluso esta 'absent'
    // legítima, degradándola a 'unknown'.
    it('un nodo estructural conocido no bloquea buildPresence=absent en la ruta de reemplazo entrante (modificador demostrablemente no seleccionado)', () => {
      const replacementSpellId = 555555;
      const resolved = resolveEffectiveDefensiveKit(
        input({ talentBuild: [{ id: heroTalentSelectorNodeId, nodeID: 500, rank: 1 }], knownTalentEntryIds: new Set([heroTalentSelectorNodeId]) }),
        data({
          catalog: [fade, { ...fade, spellId: replacementSpellId, name: 'Replacement' }],
          semantics: [semanticEntry()],
          semanticRules: [semanticRule({ ruleType: 'replace', payload: { condition: 'talent_selected', replacementSpellId } })],
        }),
      );
      const replacement = resolved.find((d) => d.spellId === replacementSpellId)!;
      expect(replacement.buildPresence).toBe('absent');
      expect(replacement.buildPresenceEvidence).toBe('replacement_not_selected');
      expect(replacement.isDefensiveKitMember).toBe(false);
    });

    it('sin reconocer el nodo estructural, la misma ruta de reemplazo degrada a unknown en vez de absent (fail-closed, nunca inventa)', () => {
      const replacementSpellId = 555555;
      const resolved = resolveEffectiveDefensiveKit(
        input({ talentBuild: [{ id: heroTalentSelectorNodeId, nodeID: 500, rank: 1 }] }), // knownTalentEntryIds omitido
        data({
          catalog: [fade, { ...fade, spellId: replacementSpellId, name: 'Replacement' }],
          semantics: [semanticEntry()],
          semanticRules: [semanticRule({ ruleType: 'replace', payload: { condition: 'talent_selected', replacementSpellId } })],
        }),
      );
      const replacement = resolved.find((d) => d.spellId === replacementSpellId)!;
      expect(replacement.buildPresence).toBe('unknown');
    });

    it('el mismo nodo sin spellId, si NO está en el DB2 snapshot, sigue bloqueando (fail-closed preservado)', () => {
      const [resolved] = resolveEffectiveDefensiveKit(
        input({
          talentBuild: [{ id: heroTalentSelectorNodeId, nodeID: 500, rank: 1 }],
          allTalentSpellIds: new Set([otherTalent.spellId]),
          talentLookupComplete: true,
          knownTalentEntryIds: new Set([999999]), // el nodo real NO está en el snapshot conocido
        }),
        data({ catalog: [otherTalent] }),
      );
      expect(resolved.buildPresence).toBe('unknown');
      expect(resolved.eligible).toBe(true); // no se oculta — sigue sin demostrarse que falte
    });

    it('sin knownTalentEntryIds en absoluto (caller no actualizado), comportamiento previo sin cambios: unknown, nunca absent', () => {
      const [resolved] = resolveEffectiveDefensiveKit(
        input({
          talentBuild: [{ id: heroTalentSelectorNodeId, nodeID: 500, rank: 1 }],
          allTalentSpellIds: new Set([otherTalent.spellId]),
          talentLookupComplete: true,
          // knownTalentEntryIds omitido a propósito
        }),
        data({ catalog: [otherTalent] }),
      );
      expect(resolved.buildPresence).toBe('unknown');
    });

    it('unknown nunca penaliza: ni eligible ni createsMissableOpportunity se ven afectados por el nodo estructural reconocido', () => {
      const survivalSemantics = [
        { spellId: otherTalent.spellId, className: 'Priest', usageRole: 'personal_survival' as const, activationScope: 'self' as const, primaryBeneficiary: 'self' as const, secondaryPropagation: 'none' as const, mechanisms: ['mitigation' as const], opportunityMode: 'normal' as const, defensiveIntent: 'primary' as const, semanticStatus: 'verified' as const, semanticVersion: 'v', semanticConfidence: 'inferred' as const, locked: false, applicability: null, applicabilityConfidence: null, applicabilityError: null, specSemanticProfiles: [], invalidSpecSemanticProfiles: [] },
      ];
      const [resolved] = resolveEffectiveDefensiveKit(
        input({
          talentBuild: [
            { id: heroTalentSelectorNodeId, nodeID: 500, rank: 1 }, // estructural, reconocido
            { id: 90, nodeID: 91, rank: 1, spellId: otherTalent.spellId }, // el talento SÍ seleccionado
          ],
          allTalentSpellIds: new Set([otherTalent.spellId]),
          talentLookupComplete: true,
          knownTalentEntryIds: new Set([heroTalentSelectorNodeId]),
        }),
        data({ catalog: [otherTalent], semantics: survivalSemantics }),
      );
      expect(resolved.buildPresence).toBe('present');
      expect(resolved.isDefensiveKitMember).toBe(true);
      expect(resolved.createsMissableOpportunity).toBe(true);
    });
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
            payload: {
              condition: 'talent_selected',
              modifierName: 'Refractive Images',
              setUsageRole: 'personal_survival',
              setOpportunityMode: 'normal',
              addMechanisms: ['mitigation'],
            },
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

  it('a replace rule marks the original spell ineligible and records the replacement spellId in the provenance (replacement resolvable in the catalog)', () => {
    const replacementSpellId = 555555;
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        // §E1 §12: el sustituto debe poder resolverse en el catálogo de esta
        // clase para que el replace cuente como resuelto — sin esta fila el
        // resolver lo marca semantic_rule_replace_unresolved (ver el test
        // dedicado a Ice Cold más abajo).
        catalog: [fade, { ...fade, spellId: replacementSpellId, name: 'Ice Cold' }],
        semantics: [semanticEntry()],
        semanticRules: [semanticRule({ ruleType: 'replace', payload: { condition: 'talent_selected', replacementSpellId } })],
      }),
    );
    expect(resolved.eligible).toBe(false);
    expect(resolved.semanticProvenance.some((step) => step.kind === 'semantic_rule_replace' && step.description.includes(String(replacementSpellId)))).toBe(true);
  });

  // §E1 §12 — fixture de aceptación explícito de la especificación: Ice Cold
  // reemplaza a Ice Block por talento, pero si el sustituto no existe en el
  // catálogo de esta clase, el original queda reemplazado (no missable) y el
  // sustituto queda unresolved — nunca se inventa un recurso.
  it('Ice Cold-style replacement whose target cannot be resolved in the catalog: original stays replaced (non-missable), flagged unresolved — no resource is invented', () => {
    const replacementSpellId = 414658; // Ice Cold — deliberadamente ausente del catálogo de este fixture
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        semantics: [semanticEntry()],
        semanticRules: [
          semanticRule({ id: 'ice-cold-replace', ruleType: 'replace', payload: { condition: 'talent_selected', replacementSpellId } }),
        ],
      }),
    );
    expect(resolved.eligible).toBe(false);
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.resolutionStatus).toBe('unresolved');
    expect(
      resolved.semanticProvenance.some(
        (step) => step.kind === 'semantic_rule_replace_unresolved' && step.description.includes(String(replacementSpellId)),
      ),
    ).toBe(true);
  });
});

// §E1 — Effective Defensive Semantics Closure. Fixtures de aceptación
// tomados directamente de datos reales de Supabase (2026-09-04): la fila de
// Fade/Translucent Image, la de Avatar Arms/Protection (con la corrupción
// real encontrada), la de Shield Block (semantic_status=pending real) y la
// de Shield of the Righteous/Protection (specSemanticProfiles real).
describe('resolveEffectiveDefensiveKit — E1 Effective Defensive Semantics Closure', () => {
  const ICE_COLD_TALENT_SPELL_ID = 373446; // Translucent Image, en la vida real
  const IGNORE_PAIN_SPELL_ID = 190456;
  const SHIELD_BLOCK_SPELL_ID = 2565;
  const AVATAR_SPELL_ID = 107574;
  const SOTR_SPELL_ID = 53600;

  function fadeInput(overrides: Partial<ResolveDefensiveKitInput> = {}): ResolveDefensiveKitInput {
    return input({ className: 'Priest', specName: 'Shadow', ...overrides });
  }

  it('Fade + Translucent Image: base utility row becomes hybrid_survival/credit_only with a merged applicabilityPatch when the talent is selected (real Supabase rule)', () => {
    const semantics: EffectiveDefensiveSemanticEntry[] = [
      {
        spellId: fade.spellId,
        className: 'Priest',
        usageRole: 'utility',
        activationScope: 'self',
        primaryBeneficiary: 'none',
        secondaryPropagation: 'none',
        mechanisms: [],
        opportunityMode: 'none',
        defensiveIntent: 'unknown',
        semanticStatus: 'verified',
        semanticVersion: 'defensive-semantics@v10',
        semanticConfidence: 'inferred',
        locked: false,
        applicability: { schoolScope: 'none', schools: null, deliveryScopes: null, requiresDodgeable: null, requiresParryable: null, requiresBlockable: null, requiresSourceAffectedBySpell: null, timingRelation: 'unknown' },
        applicabilityConfidence: 'high',
        applicabilityError: null,
        specSemanticProfiles: [],
        invalidSpecSemanticProfiles: [],
      },
    ];
    const translucentImage = semanticRule({
      id: 'translucent-image',
      modifierSpellId: ICE_COLD_TALENT_SPELL_ID,
      targetSpellId: fade.spellId,
      payload: {
        condition: 'talent_selected',
        modifierName: 'Translucent Image',
        setUsageRole: 'hybrid_survival',
        setDefensiveIntent: 'hybrid',
        setOpportunityMode: 'credit_only',
        setPrimaryBeneficiary: 'self',
        addMechanisms: ['mitigation'],
        applicabilityPatch: {
          schoolScope: 'all',
          schools: [],
          deliveryScopes: ['all'],
          requiresDodgeable: false,
          requiresParryable: false,
          requiresBlockable: false,
          requiresSourceAffectedBySpell: false,
          timingRelation: 'before_or_during',
        },
      },
    });

    const [withTalent] = resolveEffectiveDefensiveKit(
      fadeInput({ talentBuild: [{ id: 1, nodeID: 2, rank: 1, spellId: ICE_COLD_TALENT_SPELL_ID }] }),
      data({ semantics, semanticRules: [translucentImage] }),
    );
    expect(withTalent.usageRole).toBe('hybrid_survival');
    expect(withTalent.primaryBeneficiary).toBe('self');
    expect(withTalent.mechanisms).toEqual(['mitigation']);
    expect(withTalent.opportunityMode).toBe('credit_only');
    // hybrid_survival cuenta para Uso (kit member) pero nunca fabrica missed_ready — solo personal_survival+normal puede.
    expect(withTalent.isDefensiveKitMember).toBe(true);
    expect(withTalent.createsMissableOpportunity).toBe(false);
    expect(withTalent.applicability).toMatchObject({ schoolScope: 'all', deliveryScopes: ['all'], timingRelation: 'before_or_during', requiresBlockable: false });
    expect(withTalent.resolutionStatus).toBe('resolved');

    const [withoutTalent] = resolveEffectiveDefensiveKit(fadeInput({ talentBuild: [] }), data({ semantics, semanticRules: [translucentImage] }));
    expect(withoutTalent.usageRole).toBe('utility');
    expect(withoutTalent.isDefensiveKitMember).toBe(false);
    expect(withoutTalent.applicability).toMatchObject({ schoolScope: 'none' });
  });

  it('Avatar Arms specSemanticProfile: only the matching spec overrides base semantics — Fury (no matching profile) keeps the base utility row', () => {
    const avatarCatalog: EffectiveDefensiveCatalogEntry = { ...fade, spellId: AVATAR_SPELL_ID, name: 'Avatar', className: 'Warrior', specName: 'Arms/Fury/Protection' };
    const rows = effectiveDefensiveDataFromDatabaseRows({
      catalogRows: [],
      semanticRows: [
        {
          spell_id: AVATAR_SPELL_ID,
          class: 'Warrior',
          usage_role: 'utility',
          activation_scope: 'self',
          primary_beneficiary: 'self',
          secondary_propagation: 'none',
          mechanisms: [],
          opportunity_mode: 'none',
          defensive_intent: 'unknown',
          semantic_status: 'verified',
          semantic_version: 'defensive-semantics@v10',
          confidence: 'inferred',
          locked: false,
          applicability: { schoolScope: 'none', schools: [], deliveryScopes: [], timingRelation: 'unknown' },
          applicability_confidence: 'high',
          spec_semantic_profiles: [
            {
              spec: 'Arms',
              usageRole: 'hybrid_survival',
              defensiveIntent: 'hybrid',
              activationScope: 'self',
              primaryBeneficiary: 'self',
              secondaryPropagation: 'none',
              mechanisms: ['mitigation'],
              opportunityMode: 'credit_only',
              applicability: { schoolScope: 'all', schools: [], deliveryScopes: ['aoe'], timingRelation: 'before_or_during' },
              source: 'wowhead',
              confidence: 'high',
            },
          ],
        },
      ],
    });

    const [arms] = resolveEffectiveDefensiveKit(
      input({ className: 'Warrior', specName: 'Arms' }),
      data({ catalog: [avatarCatalog], semantics: rows.semantics }),
    );
    expect(arms.usageRole).toBe('hybrid_survival');
    expect(arms.mechanisms).toEqual(['mitigation']);
    expect(arms.applicability).toMatchObject({ schoolScope: 'all', deliveryScopes: ['aoe'] });
    expect(arms.isDefensiveKitMember).toBe(true);
    expect(arms.resolutionStatus).toBe('resolved');

    const [fury] = resolveEffectiveDefensiveKit(
      input({ className: 'Warrior', specName: 'Fury' }),
      data({ catalog: [avatarCatalog], semantics: rows.semantics }),
    );
    expect(fury.usageRole).toBe('utility');
    expect(fury.isDefensiveKitMember).toBe(false);
  });

  it('malformed Avatar/Protection specSemanticProfile (real corruption: a markdown-link fragment merged into the requiresDodgeable key) is rejected — Arms keeps resolving normally', () => {
    // Reproduce EXACTAMENTE la corrupción real encontrada en Supabase: el
    // objeto de applicability del perfil Protection trae una clave
    // desconocida (fragmento de markdown-link fusionado con
    // "requiresDodgeable") en vez de la clave real — JSON válido, semántica
    // corrupta.
    const corruptedKey =
      'requiresDodgeable](https://www.wowhead.com/spell=107574/avatar%22,%22confidence%22:%22high%22},{%22spec%22:%22Protection%22,%22usageRole%22:%22hybrid_survival%22,%22requiresDodgeable)';
    const rows = effectiveDefensiveDataFromDatabaseRows({
      catalogRows: [],
      semanticRows: [
        {
          spell_id: AVATAR_SPELL_ID,
          class: 'Warrior',
          usage_role: 'utility',
          activation_scope: 'self',
          primary_beneficiary: 'self',
          secondary_propagation: 'none',
          mechanisms: [],
          opportunity_mode: 'none',
          defensive_intent: 'unknown',
          semantic_status: 'verified',
          semantic_version: 'defensive-semantics@v10',
          confidence: 'inferred',
          locked: false,
          applicability: { schoolScope: 'none', schools: [], deliveryScopes: [], timingRelation: 'unknown' },
          applicability_confidence: 'high',
          spec_semantic_profiles: [
            {
              spec: 'Arms',
              usageRole: 'hybrid_survival',
              defensiveIntent: 'hybrid',
              activationScope: 'self',
              primaryBeneficiary: 'self',
              secondaryPropagation: 'none',
              mechanisms: ['mitigation'],
              opportunityMode: 'credit_only',
              applicability: { schoolScope: 'all', schools: [], deliveryScopes: ['aoe'], timingRelation: 'before_or_during' },
              source: 'wowhead',
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
                timingRelation: 'before_or_during',
                requiresBlockable: null,
                requiresParryable: null,
                requiresSourceAffectedBySpell: null,
                [corruptedKey]: null,
              },
              source: 'wowhead',
              confidence: 'high',
            },
          ],
        },
      ],
    });

    const semanticEntryRow = rows.semantics![0];
    // El parser aísla el elemento corrupto — Arms sigue siendo válido, solo Protection cae a invalid.
    expect(semanticEntryRow.specSemanticProfiles).toHaveLength(1);
    expect(semanticEntryRow.specSemanticProfiles[0].spec).toBe('Arms');
    expect(semanticEntryRow.invalidSpecSemanticProfiles).toHaveLength(1);
    expect(semanticEntryRow.invalidSpecSemanticProfiles[0].spec).toBe('Protection');

    const avatarCatalog: EffectiveDefensiveCatalogEntry = { ...fade, spellId: AVATAR_SPELL_ID, name: 'Avatar', className: 'Warrior', specName: 'Arms/Fury/Protection' };
    const [protection] = resolveEffectiveDefensiveKit(
      input({ className: 'Warrior', specName: 'Protection' }),
      data({ catalog: [avatarCatalog], semantics: rows.semantics }),
    );
    // El perfil corrupto NUNCA se adivina como bueno: no se aplica ningún
    // override, la fila queda en conflict, nunca member ni missable.
    expect(protection.resolutionStatus).toBe('conflict');
    expect(protection.isDefensiveKitMember).toBe(false);
    expect(protection.createsMissableOpportunity).toBe(false);
    expect(protection.semanticProvenance.some((step) => step.kind === 'spec_profile_invalid')).toBe(true);

    const [arms] = resolveEffectiveDefensiveKit(
      input({ className: 'Warrior', specName: 'Arms' }),
      data({ catalog: [avatarCatalog], semantics: rows.semantics }),
    );
    expect(arms.resolutionStatus).toBe('resolved');
    expect(arms.usageRole).toBe('hybrid_survival');
  });

  it('Shield of the Righteous Protection specSemanticProfile: active_mitigation is never a personal kit member (rotational tank maintenance, not a strategic cooldown)', () => {
    const sotrCatalog: EffectiveDefensiveCatalogEntry = { ...fade, spellId: SOTR_SPELL_ID, name: 'Shield of the Righteous', className: 'Paladin', specName: 'Holy/Protection/Retribution' };
    const rows = effectiveDefensiveDataFromDatabaseRows({
      catalogRows: [],
      semanticRows: [
        {
          spell_id: SOTR_SPELL_ID,
          class: 'Paladin',
          usage_role: 'rotational_survival',
          activation_scope: 'enemy',
          primary_beneficiary: 'self',
          secondary_propagation: 'none',
          mechanisms: ['mitigation'],
          opportunity_mode: 'none',
          defensive_intent: 'unknown',
          semantic_status: 'verified',
          semantic_version: 'defensive-semantics@v10',
          confidence: 'inferred',
          locked: false,
          applicability: { schoolScope: 'physical', schools: [], deliveryScopes: ['all'], timingRelation: 'before_or_during' },
          applicability_confidence: 'high',
          spec_semantic_profiles: [
            {
              spec: 'Protection',
              usageRole: 'active_mitigation',
              defensiveIntent: 'primary',
              activationScope: 'enemy',
              primaryBeneficiary: 'self',
              secondaryPropagation: 'none',
              mechanisms: ['mitigation'],
              opportunityMode: 'none',
              applicability: { schoolScope: 'physical', schools: [], deliveryScopes: ['all'], timingRelation: 'before_or_during' },
              source: 'wowhead',
              confidence: 'high',
            },
          ],
        },
      ],
    });

    const [protection] = resolveEffectiveDefensiveKit(
      input({ className: 'Paladin', specName: 'Protection' }),
      data({ catalog: [sotrCatalog], semantics: rows.semantics }),
    );
    expect(protection.usageRole).toBe('active_mitigation');
    expect(protection.isDefensiveKitMember).toBe(false);
    expect(protection.createsMissableOpportunity).toBe(false);
    expect(protection.resolutionStatus).toBe('resolved');
  });

  it('Ignore Pain with unresolved build presence: a semantically perfect personal_survival never becomes a member while presence is unknown ("cannot prove it is missing")', () => {
    const ignorePain: EffectiveDefensiveCatalogEntry = { ...fade, spellId: IGNORE_PAIN_SPELL_ID, name: 'Ignore Pain', className: 'Warrior', specName: 'Arms' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        className: 'Warrior',
        specName: 'Arms',
        talentBuild: null, // sin snapshot de build
        allTalentSpellIds: new Set([IGNORE_PAIN_SPELL_ID]), // pero SÍ sabemos que es un nodo de talento
      }),
      data({
        catalog: [ignorePain],
        semantics: [semanticEntry({ spellId: IGNORE_PAIN_SPELL_ID, className: 'Warrior', usageRole: 'personal_survival', mechanisms: ['absorption'] })],
      }),
    );
    expect(resolved.buildPresence).toBe('unknown');
    expect(resolved.eligible).toBe(true); // no se oculta — sin evidencia de que falte
    expect(resolved.isDefensiveKitMember).toBe(false); // pero tampoco se demuestra que esté: nunca member
    expect(resolved.createsMissableOpportunity).toBe(false);
  });

  it('Shield Block pending (real semantic_status in Supabase): never a member, resolutionStatus unresolved, regardless of how solid the build presence is', () => {
    const shieldBlock: EffectiveDefensiveCatalogEntry = { ...fade, spellId: SHIELD_BLOCK_SPELL_ID, name: 'Shield Block', className: 'Warrior', specName: 'Protection' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ className: 'Warrior', specName: 'Protection' }),
      data({
        catalog: [shieldBlock],
        semantics: [
          semanticEntry({
            spellId: SHIELD_BLOCK_SPELL_ID,
            className: 'Warrior',
            semanticStatus: 'pending',
            usageRole: 'unknown',
            primaryBeneficiary: 'unknown',
            mechanisms: [],
            opportunityMode: 'none',
          }),
        ],
      }),
    );
    expect(resolved.buildPresence).toBe('present'); // no talent-gated en este fixture — baseline
    expect(resolved.semanticStatus).toBe('pending');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.resolutionStatus).toBe('unresolved');
  });

  it('AMS-style multiple simultaneous hero-talent augments merge order-independently (real Blood DK data: Vestigial Shell + Blood Feast + Osmosis + Unyielding Will)', () => {
    const amsSpellId = 48707;
    const ams: EffectiveDefensiveCatalogEntry = { ...fade, spellId: amsSpellId, name: 'Anti-Magic Shell', className: 'DeathKnight', specName: 'Blood/Frost/Unholy' };
    const vestigialShell = semanticRule({
      id: 'vestigial-shell',
      modifierSpellId: 454851,
      targetSpellId: amsSpellId,
      specNames: ['Blood', 'Frost', 'Unholy'],
      payload: { condition: 'talent_selected', modifierName: 'Vestigial Shell', setSecondaryPropagation: 'automatic_ally' },
    });
    const bloodFeast = semanticRule({
      id: 'blood-feast',
      modifierSpellId: 391386,
      targetSpellId: amsSpellId,
      specNames: ['Blood'],
      payload: { condition: 'talent_selected', modifierName: 'Blood Feast', addMechanisms: ['sustain'] },
    });
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        className: 'DeathKnight',
        specName: 'Blood',
        talentBuild: [
          { id: 1, nodeID: 10, rank: 1, spellId: 454851 },
          { id: 2, nodeID: 11, rank: 1, spellId: 391386 },
        ],
      }),
      data({
        catalog: [ams],
        semantics: [semanticEntry({ spellId: amsSpellId, className: 'DeathKnight', mechanisms: ['absorption'] })],
        semanticRules: [vestigialShell, bloodFeast],
      }),
    );
    // Ambas reglas se aplican a la vez sin conflicto — union de mechanisms, secondaryPropagation del único rule que lo propone.
    expect(resolved.mechanisms).toEqual(expect.arrayContaining(['absorption', 'sustain']));
    expect(resolved.secondaryPropagation).toBe('automatic_ally');
    expect(resolved.resolutionStatus).toBe('resolved');
    expect(resolved.isDefensiveKitMember).toBe(true);
  });

  it('two automatic rules proposing incompatible values for the same field never pick one by arbitrary order — resolutionStatus=conflict, never missable', () => {
    const ruleA = semanticRule({ id: 'rule-a', payload: { condition: 'talent_selected', setUsageRole: 'personal_survival' } });
    const ruleB = semanticRule({ id: 'rule-b', modifierSpellId: MODIFIER_SPELL_ID + 1, payload: { condition: 'talent_selected', setUsageRole: 'utility' } });
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        talentBuild: [
          { id: 1, nodeID: 10, rank: 1, spellId: MODIFIER_SPELL_ID },
          { id: 2, nodeID: 11, rank: 1, spellId: MODIFIER_SPELL_ID + 1 },
        ],
      }),
      data({ semantics: [semanticEntry({ usageRole: 'unknown', mechanisms: [], opportunityMode: 'none' })], semanticRules: [ruleA, ruleB] }),
    );
    expect(resolved.resolutionStatus).toBe('conflict');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.semanticProvenance.some((step) => step.kind === 'semantic_rule_conflict')).toBe(true);
  });

  it('runtime_state condition is never applied automatically — surfaces in unresolvedRuntimeRules without increasing certainty', () => {
    const runtimeRule = semanticRule({ payload: { condition: 'runtime_state', setUsageRole: 'personal_survival', addMechanisms: ['mitigation'] } });
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 1, nodeID: 10, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({ semantics: [semanticEntry({ usageRole: 'utility', mechanisms: [], opportunityMode: 'none' })], semanticRules: [runtimeRule] }),
    );
    expect(resolved.usageRole).toBe('utility'); // no se aplicó
    expect(resolved.unresolvedRuntimeRules).toHaveLength(1);
    expect(resolved.unresolvedRuntimeRules[0]).toMatchObject({ ruleId: 'rule-1', condition: 'runtime_state' });
    expect(resolved.isDefensiveKitMember).toBe(false);
  });

  it('an unverified rule never changes anything, including suppress/replace/convert_to_passive (bug fix: the original resolver only checked verified for augment)', () => {
    const [suppressed] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 1, nodeID: 10, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        semantics: [semanticEntry()],
        semanticRules: [semanticRule({ ruleType: 'suppress', verified: false })],
      }),
    );
    expect(suppressed.eligible).toBe(true);
    expect(suppressed.isDefensiveKitMember).toBe(true);
    expect(suppressed.semanticProvenance.some((step) => step.kind === 'semantic_rule_unverified')).toBe(true);
  });

  it('a semantic rule from a different game build never modifies anything, even with no legacy fallback (stricter than timing modifierRules on purpose)', () => {
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [{ id: 1, nodeID: 10, rank: 1, spellId: MODIFIER_SPELL_ID }] }),
      data({
        semantics: [semanticEntry({ usageRole: 'utility', mechanisms: [], opportunityMode: 'none' })],
        semanticRules: [semanticRule({ gameBuild: '12.0.0.60000', payload: { condition: 'talent_selected', setUsageRole: 'personal_survival' } })],
      }),
    );
    expect(resolved.usageRole).toBe('utility');
  });

  it('a spec-profile that is individually well-formed but produces an incoherent final combination fails final validation — resolutionStatus=conflict, never member', () => {
    const rows = effectiveDefensiveDataFromDatabaseRows({
      catalogRows: [],
      semanticRows: [
        {
          spell_id: fade.spellId,
          class: 'Priest',
          usage_role: 'utility',
          activation_scope: 'self',
          primary_beneficiary: 'none',
          secondary_propagation: 'none',
          mechanisms: [],
          opportunity_mode: 'none',
          defensive_intent: 'unknown',
          semantic_status: 'verified',
          semantic_version: 'defensive-semantics@v10',
          confidence: 'inferred',
          locked: false,
          spec_semantic_profiles: [
            {
              // survival_state exige opportunityMode=credit_only por contrato
              // (defensiveSemanticError) — normal es incoherente. Cada campo
              // es individualmente válido, así que el parser estructural lo
              // deja pasar; la validación FINAL debe cazarlo igualmente.
              spec: 'Shadow',
              usageRole: 'survival_state',
              defensiveIntent: 'primary',
              activationScope: 'self',
              primaryBeneficiary: 'self',
              secondaryPropagation: 'none',
              mechanisms: ['mitigation'],
              opportunityMode: 'normal',
              applicability: null,
              source: 'test',
              confidence: 'high',
            },
          ],
        },
      ],
    });

    const [resolved] = resolveEffectiveDefensiveKit(input(), data({ semantics: rows.semantics }));
    expect(resolved.resolutionStatus).toBe('conflict');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
    expect(resolved.semanticProvenance.some((step) => step.kind === 'final_validation_conflict')).toBe(true);
  });

  it('a demonstrated persistent cast can only upgrade buildPresence, never downgrade or prove absence', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        talentBuild: [],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[talentDefensive.spellId, 'observed_cast_same_pull']]),
      }),
      data({ catalog: [talentDefensive] }),
    );
    // §E2.5: sin evidencia de cast este defensivo queda 'unknown' (candidato
    // de allTalentSpellIds, no seleccionado, sin prueba positiva de
    // exclusión — nunca 'absent', ver el describe de más abajo) — la
    // evidencia de cast lo sube a 'present'.
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_pull');

    const [withoutEvidence] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [], allTalentSpellIds: new Set([talentDefensive.spellId]), talentLookupComplete: true }),
      data({ catalog: [talentDefensive] }),
    );
    expect(withoutEvidence.buildPresence).toBe('unknown');
  });
});

// §E2.5 "Acquisition Safety Closure" (2026-09-04) — E2.2-E2.4 demostraron
// empíricamente que "spellId ∈ allTalentSpellIds + no aparece seleccionado
// en un build resuelto" NO es prueba de ausencia (30 de 31 "absent"
// auditadas resultaron ser falsos negativos: AMS, Death Pact, Halo, Numbing
// Poison, Healing Tide Totem, Ironfur, Intervene/Interpose/Demolish...).
// Regla canónica: prueba positiva de presencia → present; prueba positiva
// de EXCLUSIÓN → absent; ninguna de las dos → unknown. La ruta directa
// (entry.spellId ∈ allTalentSpellIds) ya NUNCA produce 'absent' por sí
// sola — solo la ruta de reemplazo entrante (un modificador verificado
// demostrablemente no seleccionado, ver el describe de knownTalentEntryIds
// más arriba) preserva un negativo explícito.
describe('resolveEffectiveDefensiveKit — E2.5 Acquisition Safety Closure', () => {
  it('spell in allTalentSpellIds but not selected in a fully resolved build → unknown, never absent', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [], allTalentSpellIds: new Set([talentDefensive.spellId]), talentLookupComplete: true }),
      data({ catalog: [talentDefensive] }),
    );
    expect(resolved.buildPresence).toBe('unknown');
    expect(resolved.buildPresenceEvidence).toBe('unresolved_acquisition');
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });

  it('a selected talent still resolves to present (positive proof preserved)', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        talentBuild: [{ id: 90, nodeID: 91, rank: 1, spellId: talentDefensive.spellId }],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
      }),
      data({ catalog: [talentDefensive] }),
    );
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceEvidence).toBe('selected_talent');
  });

  it('Ice Block / Ice Cold: exactly one missable, unchanged by the acquisition-safety closure', () => {
    const iceBlockSpellId = 45438;
    const iceColdSpellId = 414658;
    const iceColdModifierId = 414659;
    const iceBlock: EffectiveDefensiveCatalogEntry = { ...fade, spellId: iceBlockSpellId, name: 'Ice Block', className: 'Mage', specName: null };
    const iceCold: EffectiveDefensiveCatalogEntry = { ...fade, spellId: iceColdSpellId, name: 'Ice Cold', className: 'Mage', specName: null };
    const replaceRule = semanticRule({
      id: 'ice-cold-replace',
      modifierSpellId: iceColdModifierId,
      targetSpellId: iceBlockSpellId,
      ruleType: 'replace',
      payload: { condition: 'talent_selected', replacementSpellId: iceColdSpellId },
    });
    const semantics = [
      semanticEntry({ spellId: iceBlockSpellId, className: 'Mage', mechanisms: ['immunity'] }),
      semanticEntry({ spellId: iceColdSpellId, className: 'Mage', mechanisms: ['mitigation'] }),
    ];
    const mageInput = (overrides: Partial<ResolveDefensiveKitInput> = {}) => input({ className: 'Mage', specName: null, ...overrides });
    const mageData = data({ catalog: [iceBlock, iceCold], semantics, semanticRules: [replaceRule] });

    for (const talentBuild of [[], [{ id: 1, nodeID: 10, rank: 1, spellId: iceColdModifierId }]]) {
      const kit = resolveEffectiveDefensiveKit(mageInput({ talentBuild }), mageData);
      const missableCount = kit.filter((d) => (d.spellId === iceBlockSpellId || d.spellId === iceColdSpellId) && d.createsMissableOpportunity).length;
      expect(missableCount).toBe(1);
    }
  });

  it('Healthstone / Demonic Healthstone: exactly one missable, unchanged by the acquisition-safety closure', () => {
    const healthstoneSpellId = 6262;
    const demonicSpellId = 452930;
    const modifierId = 386689;
    const catalog = [
      { ...fade, spellId: healthstoneSpellId, name: 'Healthstone', className: 'Warlock', specName: null },
      { ...fade, spellId: demonicSpellId, name: 'Demonic Healthstone', className: 'Warlock', specName: null },
    ];
    const semantics = [
      semanticEntry({ spellId: healthstoneSpellId, className: 'Warlock', mechanisms: ['sustain'] }),
      semanticEntry({ spellId: demonicSpellId, className: 'Warlock', mechanisms: ['sustain'] }),
    ];
    const replaceRule = semanticRule({
      id: 'demonic-healthstone-replace',
      modifierSpellId: modifierId,
      targetSpellId: healthstoneSpellId,
      ruleType: 'replace',
      payload: { condition: 'talent_selected', replacementSpellId: demonicSpellId },
    });
    const warlockInput = (overrides: Partial<ResolveDefensiveKitInput> = {}) => input({ className: 'Warlock', specName: null, ...overrides });
    const warlockData = data({ catalog, semantics, semanticRules: [replaceRule] });

    for (const talentBuild of [[], [{ id: 1, nodeID: 10, rank: 1, spellId: modifierId }]]) {
      const kit = resolveEffectiveDefensiveKit(warlockInput({ talentBuild }), warlockData);
      const missableCount = kit.filter((d) => (d.spellId === healthstoneSpellId || d.spellId === demonicSpellId) && d.createsMissableOpportunity).length;
      expect(missableCount).toBe(1);
    }
  });

  it('same-pull cast evidence upgrades unknown to present', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        talentBuild: [],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[talentDefensive.spellId, 'observed_cast_same_pull']]),
      }),
      data({ catalog: [talentDefensive] }),
    );
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_pull');
  });

  it('same exact non-null build-fingerprint historical cast evidence upgrades unknown to present', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        talentBuild: [],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[talentDefensive.spellId, 'observed_cast_same_build_fingerprint']]),
      }),
      data({ catalog: [talentDefensive] }),
    );
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_build_fingerprint');
  });

  it('a spellId absent from demonstratedPersistentCastSpellIds gets no proof at all (caller already excluded different-fingerprint/null-fingerprint casts)', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        talentBuild: [],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map(), // caller determined no valid evidence exists (different fingerprint / null fingerprint cases never make it into this map)
      }),
      data({ catalog: [talentDefensive] }),
    );
    expect(resolved.buildPresence).toBe('unknown');
  });
});

// §E2.6 (Acquisition Safety Closure — false-negative fix, 2026-09-04): E2.5
// correctly upgrades buildPresence from 'unknown' to 'present' via validated
// cast evidence, but the legacy direct-acquisition gate ("candidate in
// allTalentSpellIds, not found selected") set eligible=false and the cast
// upgrade never restored it — isDefensiveKitMember/createsMissableOpportunity
// require `eligible && buildPresence==='present'`, so the upgrade was
// silently discarded downstream. Real fixture: Wargreymon / Anti-Magic Shell
// (48707) resolved to buildPresence='present' via
// observed_cast_same_build_fingerprint but eligible stayed false.
describe('resolveEffectiveDefensiveKit — E2.6 false-negative fix: eligible restoration on cast-evidence upgrade', () => {
  it('unselected allTalentSpellIds candidate without cast evidence: unknown / eligible=false / non-member (unchanged from E2.5)', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({ talentBuild: [], allTalentSpellIds: new Set([talentDefensive.spellId]), talentLookupComplete: true }),
      data({ catalog: [talentDefensive], semantics: [semanticEntry({ spellId: talentDefensive.spellId })] }),
    );
    expect(resolved.buildPresence).toBe('unknown');
    expect(resolved.eligible).toBe(false);
    expect(resolved.isDefensiveKitMember).toBe(false);
    expect(resolved.createsMissableOpportunity).toBe(false);
  });

  it('same-pull validated cast + verified personal_survival semantics: present / eligible=true / member=true / missable=true', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const kit = resolveEffectiveDefensiveKit(
      input({
        talentBuild: [],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[talentDefensive.spellId, 'observed_cast_same_pull']]),
      }),
      data({ catalog: [talentDefensive], semantics: [semanticEntry({ spellId: talentDefensive.spellId })] }),
    );
    const resolved = kit.find((d) => d.spellId === talentDefensive.spellId)!;
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_pull');
    expect(resolved.buildPresenceConfidence).toBe('verified');
    expect(resolved.confidence).toBe('verified');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);
  });

  it('exact-fingerprint historical cast: same result as same-pull evidence', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const kit = resolveEffectiveDefensiveKit(
      input({
        talentBuild: [],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[talentDefensive.spellId, 'observed_cast_same_build_fingerprint']]),
      }),
      data({ catalog: [talentDefensive], semantics: [semanticEntry({ spellId: talentDefensive.spellId })] }),
    );
    const resolved = kit.find((d) => d.spellId === talentDefensive.spellId)!;
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_build_fingerprint');
    expect(resolved.buildPresenceConfidence).toBe('inferred');
    expect(resolved.confidence).toBe('inferred');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);
  });

  it('cast proof preserves unrelated confidence uncertainty that existed before the acquisition gate', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        gameBuild: null,
        gameBuildConfidence: 'uncertain',
        talentBuild: [],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[talentDefensive.spellId, 'observed_cast_same_pull']]),
      }),
      data({ catalog: [talentDefensive], semantics: [semanticEntry({ spellId: talentDefensive.spellId })] }),
    );
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceConfidence).toBe('verified');
    expect(resolved.confidence).toBe('uncertain');
  });

  it('pre-existing legitimate eligible=false blocker (talent-selected passive conversion) + cast evidence: remains eligible=false', () => {
    const converterSpellId = 99001; // fixture-only — talento que convierte la ability en pasiva
    const talentDefensive: EffectiveDefensiveCatalogEntry = {
      ...fade,
      spellId: 19236,
      name: 'Desperate Prayer',
      passiveConversionSpellIds: [converterSpellId],
    };
    const kit = resolveEffectiveDefensiveKit(
      input({
        // El conversor está seleccionado (bloqueo legítimo, activationMode
        // pasa a 'passive' y eligible=false) — el propio spellId 19236 NO
        // está seleccionado, así que además atraviesa la puerta de
        // adquisición directa no probada (buildPresence='unknown').
        talentBuild: [{ id: 1, nodeID: 10, rank: 1, spellId: converterSpellId }],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[talentDefensive.spellId, 'observed_cast_same_pull']]),
      }),
      data({ catalog: [talentDefensive], semantics: [semanticEntry({ spellId: talentDefensive.spellId })] }),
    );
    const resolved = kit.find((d) => d.spellId === talentDefensive.spellId)!;
    // El cast evidence sí sube buildPresence a 'present' (nunca se pierde),
    // pero eligible se restaura al valor PREVIO a la puerta de adquisición
    // directa — que ya era false por el bloqueo legítimo de conversión a
    // pasiva, no por la puerta en sí. No se fuerza a true a ciegas.
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.eligible).toBe(false);
    expect(resolved.isDefensiveKitMember).toBe(false);
  });

  it('Wargreymon-style Anti-Magic Shell fixture: observed cast evidence resolves a real kit member', () => {
    const amsSpellId = 48707;
    const ams: EffectiveDefensiveCatalogEntry = { ...fade, spellId: amsSpellId, name: 'Anti-Magic Shell', className: 'DeathKnight', specName: null };
    const kit = resolveEffectiveDefensiveKit(
      input({
        className: 'DeathKnight',
        specName: 'Frost',
        talentBuild: [],
        allTalentSpellIds: new Set([amsSpellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[amsSpellId, 'observed_cast_same_build_fingerprint']]),
      }),
      data({ catalog: [ams], semantics: [semanticEntry({ spellId: amsSpellId, className: 'DeathKnight' })] }),
    );
    const resolved = kit.find((d) => d.spellId === amsSpellId)!;
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_build_fingerprint');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);
  });
});

// §E1 audit fix (2026-09-04) — "static replacement target presence": Ice
// Cold (414658) y Demonic Healthstone (452930) NO están, ellos mismos, en
// talent_spell_lookup (no son un nodo de talento) — solo se conceden cuando
// su modificador respectivo (414659 / 386689) está seleccionado. Antes de
// este fix, el resolver los trataba como "no talent-gated" → baseline
// buildPresence='present' incondicional, violando "original + replacement
// nunca representan dos oportunidades independientes". Los spellIds de
// abajo son EXCLUSIVAMENTE fixtures — la lógica de producción nunca los
// menciona por nombre (ver inboundReplacementsBySpellId en
// effective-defensives.ts, genérico para cualquier regla replace).
describe('resolveEffectiveDefensiveKit — E1 audit fix: static replacement target presence', () => {
  const ICE_BLOCK_SPELL_ID = 45438;
  const ICE_COLD_SPELL_ID = 414658;
  const ICE_COLD_TALENT_MODIFIER_ID = 414659;
  const HEALTHSTONE_SPELL_ID = 6262;
  const DEMONIC_HEALTHSTONE_SPELL_ID = 452930;
  const DEMONIC_HEALTHSTONE_TALENT_MODIFIER_ID = 386689;

  function iceBlock(): EffectiveDefensiveCatalogEntry {
    return { ...fade, spellId: ICE_BLOCK_SPELL_ID, name: 'Ice Block', className: 'Mage', specName: null };
  }
  function iceCold(): EffectiveDefensiveCatalogEntry {
    return { ...fade, spellId: ICE_COLD_SPELL_ID, name: 'Ice Cold', className: 'Mage', specName: null };
  }
  function iceColdReplaceRule(): EffectiveDefensiveSemanticRule {
    return semanticRule({
      id: 'ice-cold-replace',
      modifierSpellId: ICE_COLD_TALENT_MODIFIER_ID,
      targetSpellId: ICE_BLOCK_SPELL_ID,
      ruleType: 'replace',
      payload: { condition: 'talent_selected', replacementSpellId: ICE_COLD_SPELL_ID, triggerName: 'Ice Cold' },
    });
  }
  function mageSemantics(): EffectiveDefensiveSemanticEntry[] {
    return [
      semanticEntry({ spellId: ICE_BLOCK_SPELL_ID, className: 'Mage', mechanisms: ['immunity'] }),
      semanticEntry({ spellId: ICE_COLD_SPELL_ID, className: 'Mage', mechanisms: ['mitigation'] }),
    ];
  }
  function mageInput(overrides: Partial<ResolveDefensiveKitInput> = {}): ResolveDefensiveKitInput {
    return input({ className: 'Mage', specName: null, ...overrides });
  }
  function mageData(overrides: Partial<EffectiveDefensiveData> = {}): EffectiveDefensiveData {
    return data({ catalog: [iceBlock(), iceCold()], semantics: mageSemantics(), semanticRules: [iceColdReplaceRule()], ...overrides });
  }

  it('Ice Cold talent NOT selected: Ice Block present/member, Ice Cold absent/non-member', () => {
    const kit = resolveEffectiveDefensiveKit(mageInput({ talentBuild: [] }), mageData());
    const iceBlockResolved = kit.find((d) => d.spellId === ICE_BLOCK_SPELL_ID)!;
    const iceColdResolved = kit.find((d) => d.spellId === ICE_COLD_SPELL_ID)!;

    expect(iceBlockResolved.buildPresence).toBe('present');
    expect(iceBlockResolved.eligible).toBe(true);
    expect(iceBlockResolved.isDefensiveKitMember).toBe(true);

    // El bug real: antes de este fix, Ice Cold no siendo él mismo un nodo de
    // talento caía al baseline 'present' incondicional. Ahora depende del
    // modificador que lo concede.
    expect(iceColdResolved.buildPresence).toBe('absent');
    expect(iceColdResolved.isDefensiveKitMember).toBe(false);
    expect(iceColdResolved.createsMissableOpportunity).toBe(false);
  });

  it('Ice Cold talent selected: Ice Block replaced/non-member, Ice Cold present/member', () => {
    const kit = resolveEffectiveDefensiveKit(
      mageInput({ talentBuild: [{ id: 1, nodeID: 10, rank: 1, spellId: ICE_COLD_TALENT_MODIFIER_ID }] }),
      mageData(),
    );
    const iceBlockResolved = kit.find((d) => d.spellId === ICE_BLOCK_SPELL_ID)!;
    const iceColdResolved = kit.find((d) => d.spellId === ICE_COLD_SPELL_ID)!;

    expect(iceBlockResolved.eligible).toBe(false); // reemplazado — mecanismo ya existente, sin cambios
    expect(iceBlockResolved.isDefensiveKitMember).toBe(false);

    expect(iceColdResolved.buildPresence).toBe('present');
    expect(iceColdResolved.eligible).toBe(true);
    expect(iceColdResolved.isDefensiveKitMember).toBe(true);
    expect(iceColdResolved.createsMissableOpportunity).toBe(true);
  });

  it('at no build state may Ice Block + Ice Cold create two simultaneous missable opportunities (not-selected / selected / build-unresolved)', () => {
    const states: ResolveDefensiveKitInput[] = [
      mageInput({ talentBuild: [] }),
      mageInput({ talentBuild: [{ id: 1, nodeID: 10, rank: 1, spellId: ICE_COLD_TALENT_MODIFIER_ID }] }),
      mageInput({ talentBuild: null }), // build no resuelto en absoluto
    ];
    for (const state of states) {
      const kit = resolveEffectiveDefensiveKit(state, mageData());
      const missableCount = kit.filter((d) => d.spellId === ICE_BLOCK_SPELL_ID || d.spellId === ICE_COLD_SPELL_ID).filter((d) => d.createsMissableOpportunity).length;
      expect(missableCount).toBeLessThanOrEqual(1);
    }
  });

  it('same invariant for Healthstone/Demonic Healthstone: talent not selected → Healthstone present/member, Demonic Healthstone absent/non-member', () => {
    const catalog = [
      { ...fade, spellId: HEALTHSTONE_SPELL_ID, name: 'Healthstone', className: 'Warlock', specName: null },
      { ...fade, spellId: DEMONIC_HEALTHSTONE_SPELL_ID, name: 'Demonic Healthstone', className: 'Warlock', specName: null },
    ];
    const semantics = [
      semanticEntry({ spellId: HEALTHSTONE_SPELL_ID, className: 'Warlock', mechanisms: ['sustain'] }),
      semanticEntry({ spellId: DEMONIC_HEALTHSTONE_SPELL_ID, className: 'Warlock', mechanisms: ['sustain'] }),
    ];
    const replaceRule = semanticRule({
      id: 'demonic-healthstone-replace',
      modifierSpellId: DEMONIC_HEALTHSTONE_TALENT_MODIFIER_ID,
      targetSpellId: HEALTHSTONE_SPELL_ID,
      ruleType: 'replace',
      payload: { condition: 'talent_selected', replacementSpellId: DEMONIC_HEALTHSTONE_SPELL_ID, triggerName: 'Pact of Gluttony' },
    });
    const warlockInput = (overrides: Partial<ResolveDefensiveKitInput> = {}) => input({ className: 'Warlock', specName: null, ...overrides });
    const warlockData = data({ catalog, semantics, semanticRules: [replaceRule] });

    const notSelected = resolveEffectiveDefensiveKit(warlockInput({ talentBuild: [] }), warlockData);
    const healthstoneNotSelected = notSelected.find((d) => d.spellId === HEALTHSTONE_SPELL_ID)!;
    const demonicNotSelected = notSelected.find((d) => d.spellId === DEMONIC_HEALTHSTONE_SPELL_ID)!;
    expect(healthstoneNotSelected.buildPresence).toBe('present');
    expect(healthstoneNotSelected.isDefensiveKitMember).toBe(true);
    expect(demonicNotSelected.buildPresence).toBe('absent');
    expect(demonicNotSelected.isDefensiveKitMember).toBe(false);

    const selected = resolveEffectiveDefensiveKit(
      warlockInput({ talentBuild: [{ id: 1, nodeID: 10, rank: 1, spellId: DEMONIC_HEALTHSTONE_TALENT_MODIFIER_ID }] }),
      warlockData,
    );
    const healthstoneSelected = selected.find((d) => d.spellId === HEALTHSTONE_SPELL_ID)!;
    const demonicSelected = selected.find((d) => d.spellId === DEMONIC_HEALTHSTONE_SPELL_ID)!;
    expect(healthstoneSelected.eligible).toBe(false);
    expect(healthstoneSelected.isDefensiveKitMember).toBe(false);
    expect(demonicSelected.buildPresence).toBe('present');
    expect(demonicSelected.isDefensiveKitMember).toBe(true);

    for (const kit of [notSelected, selected]) {
      const missableCount = kit
        .filter((d) => d.spellId === HEALTHSTONE_SPELL_ID || d.spellId === DEMONIC_HEALTHSTONE_SPELL_ID)
        .filter((d) => d.createsMissableOpportunity).length;
      expect(missableCount).toBeLessThanOrEqual(1);
    }
  });

  it('a replacement target that is ALSO independently talent-gated preserves that independent route (OR — never silently overridden by the replacement route)', () => {
    // Caso genérico defendido por la especificación ("preservar cualquier
    // ruta de adquisición genuinamente independiente") — no corresponde a
    // ninguna ability real conocida hoy: aquí Ice Cold es (hipotéticamente)
    // TAMBIÉN su propio nodo de talento, seleccionado, mientras el
    // modificador del reemplazo (414659) NO lo está. La ruta directa por sí
    // sola ya demuestra presencia — el resolver no debe perderla al combinar
    // con la ruta de reemplazo (que aquí es 'absent').
    const selectedDirectlyNotViaReplacement: ResolveDefensiveKitInput = {
      ...mageInput({ talentBuild: [{ id: 2, nodeID: 20, rank: 1, spellId: ICE_COLD_SPELL_ID }] }),
      allTalentSpellIds: new Set([ICE_COLD_SPELL_ID]),
    };
    const kit = resolveEffectiveDefensiveKit(selectedDirectlyNotViaReplacement, mageData());
    const iceColdResolved = kit.find((d) => d.spellId === ICE_COLD_SPELL_ID)!;
    expect(iceColdResolved.buildPresence).toBe('present');
    expect(iceColdResolved.isDefensiveKitMember).toBe(true);
  });
});

// §E2.5 — computeDemonstratedPersistentCastSpellIds: función pura que
// decide qué casts observados cuentan como prueba positiva de presencia,
// aplicando la regla de alcance de fingerprint y el "persistent ability
// guard" descritos en la especificación. Dos-pasadas real (sin evidencia →
// calcular evidencia → con evidencia) para que las pruebas sean honestas
// sobre cómo la usa el caller real, en vez de fabricar ResolvedDefensive a
// mano.
describe('computeDemonstratedPersistentCastSpellIds', () => {
  const CURRENT_FINGERPRINT = 'sha256:' + 'a'.repeat(64);
  const OTHER_FINGERPRINT = 'sha256:' + 'b'.repeat(64);
  const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };

  function firstPassKit(overrides: Partial<ResolveDefensiveKitInput> = {}, dataOverrides: Partial<EffectiveDefensiveData> = {}): ResolvedDefensive[] {
    return resolveEffectiveDefensiveKit(
      input({ talentBuild: [], allTalentSpellIds: new Set([talentDefensive.spellId]), talentLookupComplete: true, ...overrides }),
      data({ catalog: [talentDefensive], ...dataOverrides }),
    );
  }

  it('a same-pull cast is valid evidence regardless of fingerprints', () => {
    const kit = firstPassKit();
    const casts: ObservedCastForEvidence[] = [{ spellId: talentDefensive.spellId, samePull: true, pullTalentBuildFingerprint: null }];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, null, kit);
    expect(evidence.get(talentDefensive.spellId)).toBe('observed_cast_same_pull');
  });

  it('a cross-pull cast with the exact same non-null build fingerprint is valid evidence', () => {
    const kit = firstPassKit();
    const casts: ObservedCastForEvidence[] = [{ spellId: talentDefensive.spellId, samePull: false, pullTalentBuildFingerprint: CURRENT_FINGERPRINT }];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, CURRENT_FINGERPRINT, kit);
    expect(evidence.get(talentDefensive.spellId)).toBe('observed_cast_same_build_fingerprint');
  });

  it('a cross-pull cast with a DIFFERENT fingerprint proves nothing', () => {
    const kit = firstPassKit();
    const casts: ObservedCastForEvidence[] = [{ spellId: talentDefensive.spellId, samePull: false, pullTalentBuildFingerprint: OTHER_FINGERPRINT }];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, CURRENT_FINGERPRINT, kit);
    expect(evidence.has(talentDefensive.spellId)).toBe(false);
  });

  it('a cross-pull cast whose origin pull was never fingerprinted (null) proves nothing, even if the current build has a fingerprint', () => {
    const kit = firstPassKit();
    const casts: ObservedCastForEvidence[] = [{ spellId: talentDefensive.spellId, samePull: false, pullTalentBuildFingerprint: null }];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, CURRENT_FINGERPRINT, kit);
    expect(evidence.has(talentDefensive.spellId)).toBe(false);
  });

  it('a cross-pull cast proves nothing when the CURRENT build itself has no fingerprint, even if the historical pull happens to share the same string', () => {
    const kit = firstPassKit();
    const casts: ObservedCastForEvidence[] = [{ spellId: talentDefensive.spellId, samePull: false, pullTalentBuildFingerprint: CURRENT_FINGERPRINT }];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, null, kit);
    expect(evidence.has(talentDefensive.spellId)).toBe(false);
  });

  it('persistent ability guard: a cast for a runtime-conditioned replacement route proves nothing', () => {
    const replacementSpellId = 555555;
    const nonAutomaticRule = semanticRule({
      id: 'runtime-replace',
      ruleType: 'replace',
      payload: { condition: 'runtime_state', replacementSpellId },
    });
    const kit = resolveEffectiveDefensiveKit(
      input({ talentBuild: [] }),
      data({
        catalog: [fade, { ...fade, spellId: replacementSpellId, name: 'Replacement' }],
        semantics: [semanticEntry()],
        semanticRules: [nonAutomaticRule],
      }),
    );
    const replacementEntry = kit.find((d) => d.spellId === replacementSpellId)!;
    expect(replacementEntry.unresolvedRuntimeRules.length).toBeGreaterThan(0); // confirma que el guard tiene señal real que leer
    const casts: ObservedCastForEvidence[] = [{ spellId: replacementSpellId, samePull: true, pullTalentBuildFingerprint: null }];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, null, kit);
    expect(evidence.has(replacementSpellId)).toBe(false);
  });

  it('persistent ability guard: a cast for a passive-activation entry proves nothing', () => {
    const passiveDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 77001, name: 'Some Passive', activationMode: 'passive' };
    const kit = firstPassKit({}, { catalog: [talentDefensive, passiveDefensive] });
    const casts: ObservedCastForEvidence[] = [{ spellId: passiveDefensive.spellId, samePull: true, pullTalentBuildFingerprint: null }];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, null, kit);
    expect(evidence.has(passiveDefensive.spellId)).toBe(false);
  });

  it('a same-pull cast wins over an already-recorded cross-pull entry for the same spellId (strongest evidence kept)', () => {
    const kit = firstPassKit();
    const casts: ObservedCastForEvidence[] = [
      { spellId: talentDefensive.spellId, samePull: false, pullTalentBuildFingerprint: CURRENT_FINGERPRINT },
      { spellId: talentDefensive.spellId, samePull: true, pullTalentBuildFingerprint: null },
    ];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, CURRENT_FINGERPRINT, kit);
    expect(evidence.get(talentDefensive.spellId)).toBe('observed_cast_same_pull');
  });

  it('end-to-end: valid evidence from the first pass upgrades buildPresence to present in a second pass', () => {
    const kit = firstPassKit();
    expect(kit[0].buildPresence).toBe('unknown'); // sin evidencia, candidato de allTalentSpellIds no seleccionado
    const casts: ObservedCastForEvidence[] = [{ spellId: talentDefensive.spellId, samePull: true, pullTalentBuildFingerprint: null }];
    const evidence = computeDemonstratedPersistentCastSpellIds(casts, null, kit);
    const secondPass = firstPassKit({ demonstratedPersistentCastSpellIds: evidence });
    expect(secondPass[0].buildPresence).toBe('present');
    expect(secondPass[0].buildPresenceEvidence).toBe('observed_cast_same_pull');
  });
});
