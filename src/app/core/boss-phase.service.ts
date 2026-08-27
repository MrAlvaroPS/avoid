// Colocar en: src/app/core/boss-phase.service.ts
// §"WCL tiene fases de encuentro, importarlas e implementarlas en todos los
// sitios donde corresponda" (feedback real): boss_encounter_phases es pura
// referencia (nombre + metadata de cada fase, igual para todos los pulls de
// ese boss) sincronizada por analyze-report — este servicio solo la lee y
// cachea en memoria por boss_id, mismo patrón que otros lookups estáticos
// pequeños de la app (mechanic-notes.ts).
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { BossEncounterPhaseRow } from '../shared/models/domain';

@Injectable({ providedIn: 'root' })
export class BossPhaseService {
  private supabase = inject(SupabaseService);
  private cache = new Map<string, Promise<BossEncounterPhaseRow[]>>();

  /** Fases de un boss, ordenadas por phase_id — [] si WCL no tiene fases definidas para él (no es un error). */
  async listPhases(bossId: string): Promise<BossEncounterPhaseRow[]> {
    if (!this.cache.has(bossId)) {
      this.cache.set(
        bossId,
        Promise.resolve(
          this.supabase.client
            .from('boss_encounter_phases')
            .select('*')
            .eq('boss_id', bossId)
            .order('phase_id', { ascending: true }),
        ).then(({ data, error }) => {
          if (error) throw error;
          return (data ?? []) as BossEncounterPhaseRow[];
        }),
      );
    }
    return this.cache.get(bossId)!;
  }

  /** Varios bosses de golpe (picker de raid-session, histórico...) — evita N llamadas secuenciales. */
  async listPhasesForBosses(bossIds: string[]): Promise<Map<string, BossEncounterPhaseRow[]>> {
    const distinctIds = [...new Set(bossIds)];
    const lists = await Promise.all(distinctIds.map((id) => this.listPhases(id).catch(() => [] as BossEncounterPhaseRow[])));
    return new Map(distinctIds.map((id, i) => [id, lists[i]]));
  }
}
