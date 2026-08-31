import { defensivesForSpec } from '../defensive-spec-match.util';
import type {
  CooldownCatalogRow,
  DefensiveModifierRuleRow,
  DefensiveSpecProfileRow,
  PlayerLatestLoadoutRow,
} from '../models/domain';

export interface EffectiveDefensive {
  spellId: number;
  name: string;
  category: CooldownCatalogRow['category'];
  survivalType: CooldownCatalogRow['survival_type'];
  baseCooldownMs: number | null;
  effectiveCooldownMs: number | null;
  durationMs: number | null;
  charges: number;
  explanation: string;
  appliedModifierSpellIds: number[];
  warnings: string[];
}

export interface EffectiveDefensiveResolution {
  player: PlayerLatestLoadoutRow;
  talentSpellIds: number[];
  loadoutHash: string;
  defensives: EffectiveDefensive[];
  unresolvedTalentCount: number;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function defensiveLoadoutHash(player: Pick<PlayerLatestLoadoutRow, 'character_id' | 'class' | 'spec' | 'talent_build'>): string {
  const talents = (player.talent_build ?? [])
    .map((talent) => `${talent.spellId ?? `entry:${talent.id}`}:${talent.rank ?? 1}`)
    .sort()
    .join(',');
  return fnv1a(`${player.character_id}|${player.class ?? ''}|${player.spec ?? ''}|${talents}`);
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

function ruleAppliesToSpec(rule: DefensiveModifierRuleRow, spec: string): boolean {
  return rule.specs == null || rule.specs.length === 0 || rule.specs.includes(spec);
}

const OPERATION_ORDER: Record<DefensiveModifierRuleRow['operation'], number> = {
  set_ms: 0,
  multiply: 1,
  subtract_ms: 2,
  add_ms: 2,
  charges_add: 3,
};

/**
 * Resuelve el kit garantizado de un jugador: spec base + talentos elegidos.
 * Las reducciones condicionales se enseñan, pero no se descuentan del CD de
 * planificación porque asumir procs/rotación perfectos produciría reminders
 * imposibles en un pull real.
 */
export function resolveEffectiveDefensives(args: {
  player: PlayerLatestLoadoutRow;
  catalog: CooldownCatalogRow[];
  specProfiles: DefensiveSpecProfileRow[];
  modifierRules: DefensiveModifierRuleRow[];
  allTalentSpellIds: ReadonlySet<number> | null;
}): EffectiveDefensiveResolution {
  const { player, catalog, specProfiles, modifierRules, allTalentSpellIds } = args;
  const playerClass = player.class ?? player.roster_class;
  const spec = player.spec;
  const talentBuild = player.talent_build ?? [];
  const talentRanks = new Map<number, number>();
  let unresolvedTalentCount = 0;
  for (const talent of talentBuild) {
    if (typeof talent.spellId !== 'number') {
      unresolvedTalentCount++;
      continue;
    }
    talentRanks.set(talent.spellId, Math.max(1, talent.rank ?? 1));
  }
  const talentSpellIds = [...talentRanks.keys()].sort((a, b) => a - b);

  if (!spec) {
    return {
      player,
      talentSpellIds,
      loadoutHash: defensiveLoadoutHash(player),
      defensives: [],
      unresolvedTalentCount,
    };
  }

  const possible = defensivesForSpec(catalog, playerClass, spec).filter((cd) => {
    if (!allTalentSpellIds) return true;
    return !allTalentSpellIds.has(cd.spell_id) || talentRanks.has(cd.spell_id);
  });

  const defensives = possible.map((cd): EffectiveDefensive => {
    const profile = specProfiles.find((row) => row.class === playerClass && row.spec === spec && row.spell_id === cd.spell_id);
    const baseCooldownMs = profile ? profile.base_cooldown_ms : cd.base_cooldown_ms;
    const durationMs = profile?.base_duration_ms ?? cd.base_duration_ms;
    let effectiveCooldownMs = baseCooldownMs;
    let charges = profile?.charges ?? 1;
    const explanationParts = [
      baseCooldownMs == null
        ? `CD base sin resolver (${profile ? spec : 'catálogo'})`
        : `${formatSeconds(baseCooldownMs)} base ${profile ? spec : 'catálogo'}`,
    ];
    const warnings: string[] = [];
    const appliedModifierSpellIds: number[] = [];

    const rules = modifierRules
      .filter(
        (rule) =>
          rule.active &&
          rule.class === playerClass &&
          rule.target_spell_id === cd.spell_id &&
          ruleAppliesToSpec(rule, spec) &&
          talentRanks.has(rule.modifier_spell_id),
      )
      .sort((a, b) => OPERATION_ORDER[a.operation] - OPERATION_ORDER[b.operation] || a.modifier_spell_id - b.modifier_spell_id);

    for (const rule of rules) {
      const rankMultiplier = rule.per_rank ? (talentRanks.get(rule.modifier_spell_id) ?? 1) : 1;
      const value = Number(rule.value) * rankMultiplier;
      if (rule.condition === 'conditional') {
        warnings.push(`${rule.description} No se descuenta porque depende de condiciones durante el combate.`);
        continue;
      }
      if (rule.operation === 'charges_add') {
        charges = Math.max(1, charges + Math.round(value));
      } else if (rule.operation === 'set_ms') {
        effectiveCooldownMs = Math.max(0, Math.round(value));
      } else if (effectiveCooldownMs == null) {
        warnings.push(`${rule.description} No se puede aplicar porque falta el cooldown base.`);
        continue;
      } else if (rule.operation === 'multiply') {
        effectiveCooldownMs = Math.max(0, Math.round(effectiveCooldownMs * value));
      } else if (rule.operation === 'subtract_ms') {
        effectiveCooldownMs = Math.max(0, Math.round(effectiveCooldownMs - value));
      } else if (rule.operation === 'add_ms') {
        effectiveCooldownMs = Math.max(0, Math.round(effectiveCooldownMs + value));
      }
      appliedModifierSpellIds.push(rule.modifier_spell_id);
      explanationParts.push(rule.description);
    }

    if (effectiveCooldownMs != null && effectiveCooldownMs !== baseCooldownMs) {
      explanationParts.push(`= ${formatSeconds(effectiveCooldownMs)} efectivo`);
    } else if (effectiveCooldownMs != null) {
      explanationParts.push(`= ${formatSeconds(effectiveCooldownMs)} efectivo`);
    }

    return {
      spellId: cd.spell_id,
      name: cd.name,
      category: cd.category,
      survivalType: cd.survival_type,
      baseCooldownMs,
      effectiveCooldownMs,
      durationMs,
      charges,
      explanation: explanationParts.join(' · '),
      appliedModifierSpellIds,
      warnings,
    };
  });

  return {
    player,
    talentSpellIds,
    loadoutHash: defensiveLoadoutHash(player),
    defensives,
    unresolvedTalentCount,
  };
}
