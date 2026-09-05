// Colocar en: src/app/core/boss-mechanic-defensive-profile.service.ts
// §"Preparación" (ver plan guardado, conversación real 2026-08-30): lectura
// de boss_mechanic_defensive_profile/mechanic_defensive_assignments — mismo
// patrón que ManifestService para boss_mechanics_candidates. Las escrituras
// van por edge-functions.service.ts (save-mechanic-defensive-profile-edit /
// save-mechanic-defensive-assignment), nunca directas desde aquí.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type {
  BossMechanicDefensiveProfileRow,
  BossMechanicDefensiveLocalProfileRow,
  BossMechanicDefensivePlanningProfileRow,
  BossMechanicOccurrenceProfileRow,
  DefensivePlanMemberRow,
  DefensivePlanSlotRow,
  DefensivePlanVersionRow,
  MechanicDefensiveAssignmentRow,
} from '../shared/models/domain';

@Injectable({ providedIn: 'root' })
export class BossMechanicDefensiveProfileService {
  private supabase = inject(SupabaseService);

  async listProfiles(bossId: string, difficulty: string): Promise<BossMechanicDefensiveProfileRow[]> {
    const { data, error } = await this.supabase.client
      .from('boss_mechanic_defensive_profile')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty);
    if (error) throw error;
    return (data ?? []) as BossMechanicDefensiveProfileRow[];
  }

  async listAssignments(bossId: string, difficulty: string): Promise<MechanicDefensiveAssignmentRow[]> {
    const { data, error } = await this.supabase.client
      .from('mechanic_defensive_assignments')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('class', { ascending: true })
      .order('spec', { ascending: true });
    if (error) throw error;
    return (data ?? []) as MechanicDefensiveAssignmentRow[];
  }

  async listOccurrenceProfiles(
    bossId: string,
    difficulty: string,
  ): Promise<BossMechanicOccurrenceProfileRow[]> {
    const { data, error } = await this.supabase.client
      .from('boss_mechanic_occurrence_profile')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('median_offset_ms', { ascending: true })
      .order('ability_id', { ascending: true })
      .order('occurrence_index', { ascending: true });
    if (error) throw error;
    return (data ?? []) as BossMechanicOccurrenceProfileRow[];
  }

  async listLocalProfiles(
    bossId: string,
    difficulty: string,
  ): Promise<BossMechanicDefensiveLocalProfileRow[]> {
    const { data, error } = await this.supabase.client
      .from('boss_mechanic_defensive_local_profile')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('local_priority', { ascending: false })
      .order('ability_id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as BossMechanicDefensiveLocalProfileRow[];
  }

  async listPlanningProfiles(
    bossId: string,
    difficulty: string,
  ): Promise<BossMechanicDefensivePlanningProfileRow[]> {
    const { data, error } = await this.supabase.client
      .from('boss_mechanic_defensive_planning_view')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('combined_planning_priority', { ascending: false })
      .order('ability_id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as BossMechanicDefensivePlanningProfileRow[];
  }

  async listPlanVersions(bossId: string, difficulty: string): Promise<DefensivePlanVersionRow[]> {
    const { data, error } = await this.supabase.client
      .from('defensive_plan_versions')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as DefensivePlanVersionRow[];
  }

  async getPlanContents(planVersionId: string): Promise<{
    members: DefensivePlanMemberRow[];
    slots: DefensivePlanSlotRow[];
  }> {
    const [membersResult, slotsResult] = await Promise.all([
      this.supabase.client
        .from('defensive_plan_members')
        .select('*')
        .eq('plan_version_id', planVersionId)
        .order('player_name', { ascending: true }),
      this.supabase.client
        .from('defensive_plan_slots')
        .select('*')
        .eq('plan_version_id', planVersionId)
        .order('occurrence_time_ms', { ascending: true })
        .order('slot_index', { ascending: true }),
    ]);
    if (membersResult.error) throw membersResult.error;
    if (slotsResult.error) throw slotsResult.error;
    return {
      members: (membersResult.data ?? []) as DefensivePlanMemberRow[],
      slots: (slotsResult.data ?? []) as DefensivePlanSlotRow[],
    };
  }

  /** §"saber cuántos logs tenemos sincronizados (kills) para ir acumulando" (feedback real, 2026-08-31) — ver boss_reference_sync_state, migración 20260831110000. */
  async getSyncState(bossId: string, difficulty: string): Promise<{ referenceFightsConsumed: number; lastSyncedAt: string | null } | null> {
    const { data, error } = await this.supabase.client
      .from('boss_reference_sync_state')
      .select('reference_fights_consumed, last_synced_at')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { referenceFightsConsumed: data.reference_fights_consumed as number, lastSyncedAt: data.last_synced_at as string | null };
  }
}
