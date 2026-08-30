// Colocar en: src/app/core/boss-mechanic-defensive-profile.service.ts
// §"Preparación" (ver plan guardado, conversación real 2026-08-30): lectura
// de boss_mechanic_defensive_profile/mechanic_defensive_assignments — mismo
// patrón que ManifestService para boss_mechanics_candidates. Las escrituras
// van por edge-functions.service.ts (save-mechanic-defensive-profile-edit /
// save-mechanic-defensive-assignment), nunca directas desde aquí.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { BossMechanicDefensiveProfileRow, MechanicDefensiveAssignmentRow } from '../shared/models/domain';

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
}
