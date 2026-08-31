import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { CooldownCatalogRow } from '../shared/models/domain';
import {
  resolveEffectiveDefensives,
  talentSpellIdsFromBuild,
  type DefensiveCooldownSpecOverride,
  type DefensiveCooldownTalentModifier,
  type EffectiveDefensive,
} from '../shared/mrt/effective-defensive.util';

export interface PlannerRosterPlayer {
  name: string;
  className: string;
  rank: string | null;
  spec: string | null;
  talentBuild: unknown;
  observedAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class DefensivePlannerService {
  private supabase = inject(SupabaseService).client;
  private rulesCache: { specOverrides: DefensiveCooldownSpecOverride[]; talentModifiers: DefensiveCooldownTalentModifier[] } | null = null;

  async listRosterPlayersWithLatestBuild(): Promise<PlannerRosterPlayer[]> {
    const [{ data: roster, error: rosterError }, { data: builds, error: buildError }] = await Promise.all([
      this.supabase.from('wowaudit_roster').select('name,class,rank').order('name'),
      this.supabase.from('player_latest_build').select('player_name,class,spec,talent_build,observed_at'),
    ]);
    if (rosterError) throw rosterError;
    if (buildError) throw buildError;

    const buildByName = new Map((builds ?? []).map((row) => [String(row.player_name).toLocaleLowerCase(), row]));
    return (roster ?? []).map((row) => {
      const build = buildByName.get(String(row.name).toLocaleLowerCase());
      return {
        name: String(row.name),
        className: String(build?.class ?? row.class ?? ''),
        rank: row.rank == null ? null : String(row.rank),
        spec: build?.spec == null ? null : String(build.spec),
        talentBuild: build?.talent_build ?? null,
        observedAt: build?.observed_at == null ? null : String(build.observed_at),
      };
    });
  }

  async resolvePlayerKit(catalog: CooldownCatalogRow[], player: PlannerRosterPlayer): Promise<EffectiveDefensive[]> {
    if (!player.spec) return [];
    const rules = await this.loadRules();
    return resolveEffectiveDefensives(
      catalog,
      { className: player.className, spec: player.spec, talentSpellIds: talentSpellIdsFromBuild(player.talentBuild) },
      rules.specOverrides,
      rules.talentModifiers,
    );
  }

  async refreshRules(): Promise<void> {
    this.rulesCache = null;
    await this.loadRules();
  }

  private async loadRules(): Promise<{ specOverrides: DefensiveCooldownSpecOverride[]; talentModifiers: DefensiveCooldownTalentModifier[] }> {
    if (this.rulesCache) return this.rulesCache;
    const [{ data: overrides, error: overridesError }, { data: modifiers, error: modifiersError }] = await Promise.all([
      this.supabase
        .from('defensive_cooldown_spec_overrides')
        .select('class,spec,spell_id,base_cooldown_ms,base_duration_ms,source,source_note,updated_at'),
      this.supabase
        .from('defensive_cooldown_talent_modifiers')
        .select('class,spec,defensive_spell_id,talent_spell_id,cooldown_delta_ms,cooldown_multiplier,duration_delta_ms,source,source_note,updated_at'),
    ]);
    if (overridesError) throw overridesError;
    if (modifiersError) throw modifiersError;
    this.rulesCache = {
      specOverrides: (overrides ?? []).map((row) => ({
        class: String(row.class), spec: String(row.spec), spell_id: Number(row.spell_id),
        base_cooldown_ms: Number(row.base_cooldown_ms), base_duration_ms: row.base_duration_ms == null ? null : Number(row.base_duration_ms),
        source: String(row.source), source_note: row.source_note == null ? null : String(row.source_note), updated_at: row.updated_at == null ? undefined : String(row.updated_at),
      })),
      talentModifiers: (modifiers ?? []).map((row) => ({
        class: String(row.class), spec: String(row.spec), defensive_spell_id: Number(row.defensive_spell_id), talent_spell_id: Number(row.talent_spell_id),
        cooldown_delta_ms: Number(row.cooldown_delta_ms), cooldown_multiplier: Number(row.cooldown_multiplier), duration_delta_ms: Number(row.duration_delta_ms),
        source: String(row.source), source_note: row.source_note == null ? null : String(row.source_note), updated_at: row.updated_at == null ? undefined : String(row.updated_at),
      })),
    };
    return this.rulesCache;
  }
}
