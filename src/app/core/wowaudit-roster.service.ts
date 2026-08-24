// Colocar en: src/app/core/wowaudit-roster.service.ts
// §"roster de verdad en lugar de deducirlo": lee wowaudit_roster (poblada
// por la Edge Function sync-wowaudit-roster) — el roster CANÓNICO real de
// la guild, no "quién ha aparecido en algún pull". Rol de raid (Tank/Heal/
// Melee/Ranged) y Main/Trial vienen de aquí; la spec sigue viniendo de WCL
// por pull (más precisa — puede cambiar de talento entre pulls, wowaudit
// solo da un valor fijo por personaje).
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { roleFromSpec } from '../shared/spec-role.util';

export interface WowauditRosterEntry {
  characterId: number;
  name: string;
  realm: string;
  class: string;
  role: 'Tank' | 'Heal' | 'Melee' | 'Ranged';
  rank: 'Main' | 'Trial';
  attendedAmountOfRaids: number;
  totalAmountOfRaids: number;
  /** null = wowaudit no tiene ninguna raid registrada todavía para este personaje en la ventana pedida. */
  attendedPercentage: number | null;
  /** §"cómo se clasifica la gente... sale de dps cuando el log pone tank" (feedback real): true = `role` viene de la spec REAL más reciente jugada (player_latest_spec), no de la config de wowaudit — porque discrepaban. false = wowaudit y la spec real coinciden (o no hay spec real todavía). */
  roleOverriddenFromObservedSpec: boolean;
  /** §"un dosier de personaje... una foto suya de perfil" (feedback real): retrato de Character Media API, resuelto en sync-wowaudit-roster. null = no se pudo resolver (nombre/reino no encontrado, perfil oculto...). */
  avatarUrl: string | null;
}

interface WowauditRosterRow {
  character_id: number;
  name: string;
  realm: string;
  class: string;
  role: string;
  rank: string;
  attended_amount_of_raids: number;
  total_amount_of_raids: number;
  attended_percentage: number | null;
  avatar_url: string | null;
}

@Injectable({ providedIn: 'root' })
export class WowauditRosterService {
  private supabase = inject(SupabaseService);

  async listRoster(): Promise<WowauditRosterEntry[]> {
    const [{ data, error }, { data: specData, error: specError }] = await Promise.all([
      this.supabase.client.from('wowaudit_roster').select('*').order('name', { ascending: true }),
      this.supabase.client.from('player_latest_spec').select('player_name, class, spec'),
    ]);
    if (error) throw error;
    if (specError) throw specError;
    const specByName = new Map(((specData ?? []) as { player_name: string; class: string; spec: string }[]).map((s) => [s.player_name, s]));

    return ((data ?? []) as WowauditRosterRow[]).map((r) => {
      const observed = specByName.get(r.name);
      // §"cómo se clasifica la gente": la spec real más reciente jugada
      // gana sobre la config de wowaudit CUANDO discrepan — es evidencia
      // directa de combate, no una config manual que puede quedarse
      // desactualizada (verificado en real: wowaudit sí decía "Melee" para
      // un Protection Warrior). Si no hay spec observada, o el mapeo no la
      // reconoce, se sigue con wowaudit tal cual (comportamiento de antes).
      const observedRole = observed ? roleFromSpec(observed.class, observed.spec) : null;
      const roleOverridden = observedRole != null && observedRole !== r.role;
      return {
        characterId: r.character_id,
        name: r.name,
        realm: r.realm,
        class: r.class,
        role: (roleOverridden ? observedRole : r.role) as WowauditRosterEntry['role'],
        rank: r.rank as WowauditRosterEntry['rank'],
        attendedAmountOfRaids: r.attended_amount_of_raids,
        totalAmountOfRaids: r.total_amount_of_raids,
        attendedPercentage: r.attended_percentage,
        roleOverriddenFromObservedSpec: roleOverridden,
        avatarUrl: r.avatar_url,
      };
    });
  }
}
