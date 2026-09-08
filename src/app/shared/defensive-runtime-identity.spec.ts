import { describe, expect, it } from 'vitest';
import {
  defensivesForClass,
  type CooldownCatalog,
} from '../../../supabase/functions/_shared/defensive-cooldowns';
import {
  effectiveDefensiveDataFromDatabaseRows,
  resolveEffectiveDefensiveKit,
} from '../../../supabase/functions/_shared/effective-defensives';

const GAME_BUILD = '12.1.0.68914';

const legacyCatalog: CooldownCatalog = [
  {
    spellId: 498,
    name: 'Divine Protection',
    class: 'Paladin',
    spec: 'Holy',
    specOverride: ['Holy'],
    category: 'personal_defensive',
    baseCooldownMs: 60_000,
    durationMs: 8_000,
    survivalType: 'mitigation',
  },
  {
    spellId: 403876,
    name: 'Divine Protection',
    class: 'Paladin',
    spec: 'Retribution',
    specOverride: ['Retribution'],
    category: 'personal_defensive',
    baseCooldownMs: 60_000,
    durationMs: 8_000,
    survivalType: 'mitigation',
  },
];

const canonicalRows = legacyCatalog.map((entry) => ({
  class: entry.class,
  spec: entry.spec,
  spec_override: entry.specOverride,
  spell_id: entry.spellId,
  name: entry.name,
  category: entry.category,
  survival_type: entry.survivalType,
  targeting_mode: 'self',
  activation_mode: 'active',
  passive_conversion_spell_ids: [],
  activation_game_build: GAME_BUILD,
  base_cooldown_ms: entry.baseCooldownMs,
  base_duration_ms: entry.durationMs,
  reviewed: true,
  excluded: false,
}));

function canonicalEligibleSpellIds(specName: 'Holy' | 'Retribution' | 'Protection'): number[] {
  const data = effectiveDefensiveDataFromDatabaseRows({ catalogRows: canonicalRows });
  const kit = resolveEffectiveDefensiveKit(
    {
      className: 'Paladin',
      specName,
      talentBuild: [],
      buildFingerprint: 'sha256:runtime-identity-fixture',
      gameBuild: GAME_BUILD,
      gameBuildConfidence: 'verified',
      playerIdentity: { playerName: 'RuntimeIdentityFixture' },
      allTalentSpellIds: new Set<number>(),
      talentLookupComplete: true,
      knownTalentEntryIds: new Set<number>(),
    },
    data,
  );
  return kit.filter((entry) => entry.eligible).map((entry) => entry.spellId).sort((a, b) => a - b);
}

describe('Paladin Divine Protection runtime identity is spec-scoped', () => {
  it('legacy/catalog consumers never expose both runtime spellIds to the same spec', () => {
    expect(defensivesForClass('Paladin', 'Holy', legacyCatalog).map((entry) => entry.spellId)).toEqual([498]);
    expect(defensivesForClass('Paladin', 'Retribution', legacyCatalog).map((entry) => entry.spellId)).toEqual([403876]);
    expect(defensivesForClass('Paladin', 'Protection', legacyCatalog).map((entry) => entry.spellId)).toEqual([]);
  });

  it('the effective defensive resolver uses the same mutually-exclusive identity', () => {
    expect(canonicalEligibleSpellIds('Holy')).toEqual([498]);
    expect(canonicalEligibleSpellIds('Retribution')).toEqual([403876]);
    expect(canonicalEligibleSpellIds('Protection')).toEqual([]);
  });
});
