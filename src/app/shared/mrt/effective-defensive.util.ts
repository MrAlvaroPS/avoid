import type { CooldownCatalogRow } from '../models/domain';
import { defensiveSpecApplies } from '../defensive-spec-match.util';

export interface DefensiveCooldownSpecOverride {
  class: string;
  spec: string;
  spell_id: number;
  base_cooldown_ms: number;
  base_duration_ms: number | null;
  source: string;
  source_note: string | null;
  updated_at?: string;
}

export interface DefensiveCooldownTalentModifier {
  class: string;
  spec: string;
  defensive_spell_id: number;
  talent_spell_id: number;
  cooldown_delta_ms: number;
  cooldown_multiplier: number;
  duration_delta_ms: number;
  source: string;
  source_note: string | null;
  updated_at?: string;
}

export interface EffectiveDefensive {
  spellId: number;
  name: string;
  category: CooldownCatalogRow['category'];
  survivalType: CooldownCatalogRow['survival_type'];
  catalogBaseCooldownMs: number | null;
  specBaseCooldownMs: number | null;
  effectiveCooldownMs: number | null;
  effectiveDurationMs: number | null;
  appliedTalentSpellIds: number[];
  provenance: string[];
  /** AUTO personal solo usa defensivos propios/semi; externals y utility necesitan otro modelo de objetivo. */
  planningEligible: boolean;
}

export interface EffectiveDefensiveContext {
  className: string;
  spec: string;
  talentSpellIds: ReadonlySet<number>;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resuelve el cooldown que debe usar el planificador para ESTE jugador:
 * catálogo -> override base de spec -> modificadores de talentos realmente
 * seleccionados. No hay ifs por clase en el algoritmo; las excepciones son
 * datos versionables en Supabase.
 */
export function resolveEffectiveDefensives(
  catalog: CooldownCatalogRow[],
  context: EffectiveDefensiveContext,
  specOverrides: DefensiveCooldownSpecOverride[],
  talentModifiers: DefensiveCooldownTalentModifier[],
): EffectiveDefensive[] {
  return catalog
    .filter((cd) => cd.class === context.className && !cd.excluded && defensiveSpecApplies(cd, context.spec))
    .map((cd) => {
      const override = specOverrides.find(
        (row) => row.class === context.className && row.spec === context.spec && row.spell_id === cd.spell_id,
      );
      const catalogBase = finiteNumber(cd.base_cooldown_ms);
      const specBase = override ? finiteNumber(override.base_cooldown_ms) : catalogBase;
      let cooldown = specBase;
      let duration = override?.base_duration_ms != null ? finiteNumber(override.base_duration_ms) : finiteNumber(cd.base_duration_ms);
      const provenance: string[] = [];
      if (override) {
        provenance.push(`base ${Math.round((override.base_cooldown_ms ?? 0) / 1000)}s por spec (${override.source})`);
      } else if (catalogBase != null) {
        provenance.push(`base ${Math.round(catalogBase / 1000)}s del catálogo`);
      } else {
        provenance.push('cooldown base sin resolver');
      }

      const appliedTalentSpellIds: number[] = [];
      if (cooldown != null) {
        const modifiers = talentModifiers.filter(
          (row) =>
            row.class === context.className &&
            row.spec === context.spec &&
            row.defensive_spell_id === cd.spell_id &&
            context.talentSpellIds.has(row.talent_spell_id),
        );
        for (const modifier of modifiers) {
          const delta = finiteNumber(modifier.cooldown_delta_ms) ?? 0;
          const multiplier = finiteNumber(modifier.cooldown_multiplier) ?? 1;
          cooldown = Math.max(0, Math.round((cooldown + delta) * multiplier));
          if (duration != null) duration = Math.max(0, Math.round(duration + (finiteNumber(modifier.duration_delta_ms) ?? 0)));
          appliedTalentSpellIds.push(modifier.talent_spell_id);
          const deltaSeconds = delta / 1000;
          const deltaText = deltaSeconds ? `${deltaSeconds > 0 ? '+' : ''}${deltaSeconds}s` : '';
          const multiplierText = multiplier !== 1 ? `×${multiplier}` : '';
          provenance.push(`talento #${modifier.talent_spell_id}: ${[deltaText, multiplierText].filter(Boolean).join(' ')} (${modifier.source})`);
        }
      }

      const categoryEligible = cd.category === 'personal_defensive' || cd.category === 'semi_defensive';
      const survivalEligible = cd.survival_type != null && cd.survival_type !== 'emergency';
      return {
        spellId: cd.spell_id,
        name: cd.name,
        category: cd.category,
        survivalType: cd.survival_type,
        catalogBaseCooldownMs: catalogBase,
        specBaseCooldownMs: specBase,
        effectiveCooldownMs: cooldown,
        effectiveDurationMs: duration,
        appliedTalentSpellIds,
        provenance,
        planningEligible: categoryEligible && survivalEligible && cooldown != null,
      };
    });
}

export function talentSpellIdsFromBuild(build: unknown): Set<number> {
  if (!Array.isArray(build)) return new Set();
  return new Set(
    build
      .map((node) => (node && typeof node === 'object' ? Number((node as { spellId?: unknown }).spellId) : NaN))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}
