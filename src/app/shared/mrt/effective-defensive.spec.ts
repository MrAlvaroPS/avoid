import { describe, expect, it } from 'vitest';
import { resolveEffectiveDefensives, talentSpellIdsFromBuild } from './effective-defensive.util';
import type { CooldownCatalogRow } from '../models/domain';

function cd(patch: Partial<CooldownCatalogRow> = {}): CooldownCatalogRow {
  return {
    id: 'x', class: 'Monk', spec: null, spec_override: null, spell_id: 243435, name: 'Fortifying Brew',
    category: 'personal_defensive', base_cooldown_ms: 180000, base_duration_ms: 15000,
    synced_from_commit: null, synced_at: null, created_at: '', updated_at: '', survival_type: 'mitigation',
    inferred_survival_type: null, ai_classification: null, reviewed: true, excluded: false, ...patch,
  };
}

describe('resolveEffectiveDefensives', () => {
  it('uses the spec base before applying a selected talent modifier', () => {
    const [result] = resolveEffectiveDefensives(
      [cd()],
      { className: 'Monk', spec: 'Mistweaver', talentSpellIds: new Set([388813]) },
      [{ class: 'Monk', spec: 'Mistweaver', spell_id: 243435, base_cooldown_ms: 120000, base_duration_ms: 15000, source: 'verified', source_note: null }],
      [{ class: 'Monk', spec: 'Mistweaver', defensive_spell_id: 243435, talent_spell_id: 388813, cooldown_delta_ms: -30000, cooldown_multiplier: 1, duration_delta_ms: 0, source: 'verified', source_note: null }],
    );
    expect(result.effectiveCooldownMs).toBe(90000);
    expect(result.appliedTalentSpellIds).toEqual([388813]);
  });

  it('keeps the 120s spec base when the modifier talent is not selected', () => {
    const [result] = resolveEffectiveDefensives(
      [cd()],
      { className: 'Monk', spec: 'Mistweaver', talentSpellIds: new Set() },
      [{ class: 'Monk', spec: 'Mistweaver', spell_id: 243435, base_cooldown_ms: 120000, base_duration_ms: 15000, source: 'verified', source_note: null }],
      [{ class: 'Monk', spec: 'Mistweaver', defensive_spell_id: 243435, talent_spell_id: 388813, cooldown_delta_ms: -30000, cooldown_multiplier: 1, duration_delta_ms: 0, source: 'verified', source_note: null }],
    );
    expect(result.effectiveCooldownMs).toBe(120000);
  });

  it('does not let an external defensive enter personal AUTO planning', () => {
    const [result] = resolveEffectiveDefensives(
      [cd({ spell_id: 116849, name: 'Life Cocoon', category: 'external_defensive', base_cooldown_ms: 120000, survival_type: 'absorption' })],
      { className: 'Monk', spec: 'Mistweaver', talentSpellIds: new Set() }, [], [],
    );
    expect(result.planningEligible).toBe(false);
  });
});

describe('talentSpellIdsFromBuild', () => {
  it('uses enriched spellIds from the real WCL talent build', () => {
    expect([...talentSpellIdsFromBuild([{ id: 1, spellId: 388813 }, { id: 2 }, { spellId: 123 }])]).toEqual([388813, 123]);
  });
});
