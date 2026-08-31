import { resolveEffectiveDefensives } from './effective-defensive-resolver.util';
import type { CooldownCatalogRow, DefensiveModifierRuleRow, DefensiveSpecProfileRow, PlayerLatestLoadoutRow } from '../models/domain';

const fortifying = {
  class: 'Monk', spec: null, spec_override: null, spell_id: 115203, name: 'Fortifying Brew',
  category: 'personal_defensive', base_cooldown_ms: 180_000, base_duration_ms: 15_000,
  survival_type: 'mitigation', excluded: false,
} as CooldownCatalogRow;

const profile = {
  class: 'Monk', spec: 'Mistweaver', spell_id: 115203, base_cooldown_ms: 120_000,
  base_duration_ms: 15_000, charges: 1,
} as DefensiveSpecProfileRow;

const rule = {
  id: 'expeditious', class: 'Monk', specs: ['Mistweaver'], modifier_spell_id: 388813,
  target_spell_id: 115203, operation: 'subtract_ms', value: 30_000, per_rank: false,
  condition: 'always', description: 'Expeditious Fortification: -30 s', active: true,
} as DefensiveModifierRuleRow;

function player(withTalent: boolean): PlayerLatestLoadoutRow {
  return {
    character_id: 1, player_name: 'Pandokie', realm: 'Dun Modr', roster_class: 'Monk', class: 'Monk', spec: 'Mistweaver',
    talent_build: withTalent ? [{ id: 10, nodeID: 20, rank: 1, spellId: 388813 }] : [], pull_id: 'p', loadout_observed_at: '2026-08-31',
  };
}

describe('resolveEffectiveDefensives', () => {
  it('aplica base de spec y reducción garantizada del talento real', () => {
    const result = resolveEffectiveDefensives({ player: player(true), catalog: [fortifying], specProfiles: [profile], modifierRules: [rule], allTalentSpellIds: new Set([388813]) });
    expect(result.defensives[0].effectiveCooldownMs).toBe(90_000);
    expect(result.defensives[0].explanation).toContain('120 s base Mistweaver');
    expect(result.defensives[0].explanation).toContain('90 s efectivo');
  });

  it('mantiene 120 s si el jugador no lleva el talento', () => {
    const result = resolveEffectiveDefensives({ player: player(false), catalog: [fortifying], specProfiles: [profile], modifierRules: [rule], allTalentSpellIds: new Set([388813]) });
    expect(result.defensives[0].effectiveCooldownMs).toBe(120_000);
  });

  it('no aplica reducciones condicionales como cooldown garantizado', () => {
    const conditional = { ...rule, condition: 'conditional' as const };
    const result = resolveEffectiveDefensives({ player: player(true), catalog: [fortifying], specProfiles: [profile], modifierRules: [conditional], allTalentSpellIds: new Set([388813]) });
    expect(result.defensives[0].effectiveCooldownMs).toBe(120_000);
    expect(result.defensives[0].warnings).toHaveLength(1);
  });
});
