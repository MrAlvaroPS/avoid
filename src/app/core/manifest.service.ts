// Colocar en: src/app/core/manifest.service.ts
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { BossMechanicCandidateRow } from '../shared/models/domain';

export interface ObservedHitStat {
  avgPlayersHit: number;
  instances: number;
}

@Injectable({ providedIn: 'root' })
export class ManifestService {
  private supabase = inject(SupabaseService);

  async listCandidates(bossId: string, difficulty: string): Promise<BossMechanicCandidateRow[]> {
    const { data, error } = await this.supabase.client
      .from('boss_mechanics_candidates')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []) as BossMechanicCandidateRow[];
  }

  /**
   * Clasificación automática, pero de verdad (no de un repo de 2017): cuánta
   * gente golpea cada habilidad en vuestros propios pulls ya importados
   * (pull_mechanic_events, rellenado por analyze-report para TODAS las
   * candidatas del manifiesto, revisadas o no). No sustituye tu criterio —
   * es una sugerencia que se enseña junto al desplegable de "Evitable" en
   * Ajustes; tú sigues decidiendo.
   */
  async listObservedHitStats(bossId: string, difficulty: string): Promise<Map<number, ObservedHitStat>> {
    const { data, error } = await this.supabase.client
      .from('pull_mechanic_events')
      .select('ability_id, players_hit, pulls!inner(boss_id, difficulty)')
      .eq('pulls.boss_id', bossId)
      .eq('pulls.difficulty', difficulty);
    if (error) throw error;

    const byAbility = new Map<number, number[]>();
    for (const row of (data ?? []) as { ability_id: number; players_hit: number }[]) {
      if (!byAbility.has(row.ability_id)) byAbility.set(row.ability_id, []);
      byAbility.get(row.ability_id)!.push(row.players_hit);
    }
    const stats = new Map<number, ObservedHitStat>();
    for (const [abilityId, hits] of byAbility) {
      stats.set(abilityId, { avgPlayersHit: hits.reduce((a, b) => a + b, 0) / hits.length, instances: hits.length });
    }
    return stats;
  }
}
