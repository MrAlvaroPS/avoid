import { describe, expect, it } from 'vitest';
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
