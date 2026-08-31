import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type {
  DefensiveModifierRuleRow,
  DefensivePlanAssignmentRow,
  DefensivePlanRunRow,
  DefensiveSpecProfileRow,
  PlayerLatestLoadoutRow,
} from '../shared/models/domain';

export interface DefensivePlanningReference {
  specProfiles: DefensiveSpecProfileRow[];
  modifierRules: DefensiveModifierRuleRow[];
  loadouts: PlayerLatestLoadoutRow[];
  allTalentSpellIds: Set<number> | null;
}

export interface StoredDefensivePlan {
  run: DefensivePlanRunRow;
  assignments: DefensivePlanAssignmentRow[];
}

@Injectable({ providedIn: 'root' })
export class DefensivePlanningService {
  private supabase = inject(SupabaseService);

  async loadReference(): Promise<DefensivePlanningReference> {
    const [profilesResult, rulesResult, loadoutsResult, lookupResult] = await Promise.all([
      this.supabase.client.from('defensive_spec_profiles').select('*'),
      this.supabase.client.from('defensive_modifier_rules').select('*').eq('active', true),
      this.supabase.client.from('player_latest_loadout').select('*').order('player_name', { ascending: true }),
      this.supabase.client.from('talent_spell_lookup').select('entry_to_spell').order('synced_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (profilesResult.error) throw profilesResult.error;
    if (rulesResult.error) throw rulesResult.error;
    if (loadoutsResult.error) throw loadoutsResult.error;
    if (lookupResult.error) throw lookupResult.error;

    const lookup = lookupResult.data?.entry_to_spell as Record<string, number> | null | undefined;
    return {
      specProfiles: (profilesResult.data ?? []) as DefensiveSpecProfileRow[],
      modifierRules: (rulesResult.data ?? []) as DefensiveModifierRuleRow[],
      loadouts: (loadoutsResult.data ?? []) as PlayerLatestLoadoutRow[],
      allTalentSpellIds: lookup ? new Set(Object.values(lookup).filter((value): value is number => typeof value === 'number')) : null,
    };
  }

  async listPlans(bossId: string, difficulty: string): Promise<StoredDefensivePlan[]> {
    const { data: runs, error: runsError } = await this.supabase.client
      .from('defensive_plan_runs')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('player_name', { ascending: true });
    if (runsError) throw runsError;
    const typedRuns = (runs ?? []) as DefensivePlanRunRow[];
    if (!typedRuns.length) return [];
    const { data: assignments, error: assignmentsError } = await this.supabase.client
      .from('defensive_plan_assignments')
      .select('*')
      .in('plan_id', typedRuns.map((run) => run.id))
      .order('planned_time_ms', { ascending: true });
    if (assignmentsError) throw assignmentsError;
    const typedAssignments = (assignments ?? []) as DefensivePlanAssignmentRow[];
    return typedRuns.map((run) => ({ run, assignments: typedAssignments.filter((assignment) => assignment.plan_id === run.id) }));
  }
}
