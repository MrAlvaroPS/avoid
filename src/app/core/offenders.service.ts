// Colocar en: src/app/core/offenders.service.ts
// §"atascos constantes... a través de todos los bosses" (feedback real):
// distinto de reliability.service.ts (un número agregado por jugador, sin
// desglosar por categoría) y de boss-history.service.ts (tendencia por
// categoría, pero acotada a un solo boss) — aquí la pregunta es "¿este
// jugador falla SIEMPRE la misma categoría de mecánica, en varios bosses
// distintos?". La parte cara (unnest + join pull_mechanic_events↔pulls)
// vive en player_mechanic_offenses (SQL); aquí solo se aplica la ventana de
// tiempo y el umbral de "esto ya es un patrón, no un mal pull puntual".
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { MechanicCategory } from '../shared/models/domain';

const WINDOW_DAYS = 60; // misma ventana que reliability.service.ts — "constante" es "sigue pasando ahora", no "pasó una vez hace 3 meses"
const MIN_DISTINCT_BOSSES = 2; // por debajo de esto es un boss concreto que le cuesta, no un patrón cross-boss
const MIN_INSTANCES = 3; // 1-2 instancias es ruido, no un patrón

export interface RepeatOffenderRow {
  playerName: string;
  category: MechanicCategory;
  instanceCount: number;
  distinctBossCount: number;
  lastOccurredAt: string;
}

/**
 * La vista histórica anterior llamaba "ofensa" a cualquier jugador que
 * apareciese en players_hit_names. Eso incluye daño de raid inevitable,
 * tankbusters y explosiones de spread que alcanzan a inocentes. Hasta que
 * la migración estricta esté desplegada, este filtro cliente evita volver a
 * convertir esos impactos en una acusación individual. Una zona evitable
 * sí identifica directamente a quien permaneció dentro de ella.
 */
export function isActionableRepeatOffense(category: MechanicCategory): boolean {
  return category === 'avoidable-ground';
}

interface RawRow {
  player_name: string;
  category: MechanicCategory;
  boss_id: string;
  closed_at: string;
}

@Injectable({ providedIn: 'root' })
export class OffendersService {
  private supabase = inject(SupabaseService);

  async listRepeatOffenders(): Promise<RepeatOffenderRow[]> {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const { data, error } = await this.supabase.client
      .from('player_mechanic_offenses')
      .select('player_name, category, boss_id, closed_at')
      .gte('closed_at', since);
    if (error) throw error;

    const byKey = new Map<
      string,
      { playerName: string; category: MechanicCategory; instances: RawRow[] }
    >();
    for (const row of (data ?? []) as RawRow[]) {
      if (!isActionableRepeatOffense(row.category)) continue;
      const key = `${row.player_name}|${row.category}`;
      if (!byKey.has(key))
        byKey.set(key, { playerName: row.player_name, category: row.category, instances: [] });
      byKey.get(key)!.instances.push(row);
    }

    const results: RepeatOffenderRow[] = [];
    for (const { playerName, category, instances } of byKey.values()) {
      const distinctBossCount = new Set(instances.map((i) => i.boss_id)).size;
      if (distinctBossCount < MIN_DISTINCT_BOSSES || instances.length < MIN_INSTANCES) continue;
      const lastOccurredAt = instances.reduce(
        (max, i) => (i.closed_at > max ? i.closed_at : max),
        instances[0].closed_at,
      );
      results.push({
        playerName,
        category,
        instanceCount: instances.length,
        distinctBossCount,
        lastOccurredAt,
      });
    }

    // Más bosses distintos primero (el patrón más extendido), instancias como desempate.
    return results.sort(
      (a, b) => b.distinctBossCount - a.distinctBossCount || b.instanceCount - a.instanceCount,
    );
  }
}
