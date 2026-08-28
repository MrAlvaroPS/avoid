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
  mechanics: RepeatOffenderMechanic[];
}

export interface RepeatOffenderMechanic {
  bossId: string;
  bossName: string;
  difficulty: string;
  abilityId: number;
  mechanicName: string;
  mechanicNameEs: string | null;
  description: string | null;
  resolution: string | null;
  coachingNote: string | null;
  sources: string[];
  occurrenceCount: number;
  evidence: RepeatOffenderEvidence[];
}

export interface RepeatOffenderEvidence {
  pullId: string;
  occurrenceCount: number;
  reportCode: string | null;
  fightId: number | null;
  pullNumber: number | null;
  occurredAt: string;
  wclUrl: string | null;
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
  pull_id: string;
  player_name: string;
  category: MechanicCategory;
  boss_id: string;
  difficulty: string;
  ability_id: number;
  mechanic_name: string;
  closed_at: string;
}

interface PullEvidenceRow {
  id: string;
  report_code: string;
  fight_id: number;
  pull_number: number;
}

interface CandidateEvidenceRow {
  boss_id: string;
  difficulty: string;
  ability_id: number;
  name: string;
  name_es: string | null;
  description: string | null;
  resolution: string | null;
  ai_classification: { notes?: string; sources?: string[] } | null;
}

@Injectable({ providedIn: 'root' })
export class OffendersService {
  private supabase = inject(SupabaseService);

  async listRepeatOffenders(): Promise<RepeatOffenderRow[]> {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const { data, error } = await this.supabase.client
      .from('player_mechanic_offenses')
      .select(
        'pull_id, player_name, category, boss_id, difficulty, ability_id, mechanic_name, closed_at',
      )
      .gte('closed_at', since);
    if (error) throw error;

    const rawRows = ((data ?? []) as RawRow[]).filter((row) =>
      isActionableRepeatOffense(row.category),
    );
    if (!rawRows.length) return [];

    const pullIds = [...new Set(rawRows.map((row) => row.pull_id))];
    const bossIds = [...new Set(rawRows.map((row) => row.boss_id))];
    const [pullsResponse, bossesResponse, candidatesResponse] = await Promise.all([
      this.supabase.client
        .from('pulls')
        .select('id, report_code, fight_id, pull_number')
        .in('id', pullIds),
      this.supabase.client
        .from('known_raid_bosses')
        .select('encounter_id, boss_name')
        .in('encounter_id', bossIds.map(Number).filter(Number.isFinite)),
      this.supabase.client
        .from('boss_mechanics_candidates')
        .select(
          'boss_id, difficulty, ability_id, name, name_es, description, resolution, ai_classification',
        )
        .in('boss_id', bossIds),
    ]);

    const pullById = new Map(
      ((pullsResponse.data ?? []) as PullEvidenceRow[]).map((pull) => [pull.id, pull]),
    );
    const bossNameById = new Map(
      ((bossesResponse.data ?? []) as { encounter_id: string | number; boss_name: string }[]).map(
        (boss) => [String(boss.encounter_id), boss.boss_name],
      ),
    );
    const candidateByKey = new Map(
      ((candidatesResponse.data ?? []) as CandidateEvidenceRow[]).map((candidate) => [
        `${candidate.boss_id}|${candidate.difficulty}|${candidate.ability_id}`,
        candidate,
      ]),
    );

    const byKey = new Map<
      string,
      { playerName: string; category: MechanicCategory; instances: RawRow[] }
    >();
    for (const row of rawRows) {
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
        mechanics: this.buildMechanicEvidence(instances, pullById, bossNameById, candidateByKey),
      });
    }

    // Más bosses distintos primero (el patrón más extendido), instancias como desempate.
    return results.sort(
      (a, b) => b.distinctBossCount - a.distinctBossCount || b.instanceCount - a.instanceCount,
    );
  }

  private buildMechanicEvidence(
    instances: RawRow[],
    pullById: Map<string, PullEvidenceRow>,
    bossNameById: Map<string, string>,
    candidateByKey: Map<string, CandidateEvidenceRow>,
  ): RepeatOffenderMechanic[] {
    const byMechanic = new Map<string, RawRow[]>();
    for (const instance of instances) {
      const key = `${instance.boss_id}|${instance.difficulty}|${instance.ability_id}`;
      const rows = byMechanic.get(key) ?? [];
      rows.push(instance);
      byMechanic.set(key, rows);
    }

    return [...byMechanic.entries()]
      .map(([key, rows]) => {
        const first = rows[0];
        const candidate = candidateByKey.get(key) ?? null;
        const rowsByPull = new Map<string, RawRow[]>();
        for (const row of rows) {
          const pullRows = rowsByPull.get(row.pull_id) ?? [];
          pullRows.push(row);
          rowsByPull.set(row.pull_id, pullRows);
        }
        const evidence = [...rowsByPull.values()]
          .map((pullRows): RepeatOffenderEvidence => {
            const row = pullRows[0];
            const pull = pullById.get(row.pull_id) ?? null;
            return {
              pullId: row.pull_id,
              occurrenceCount: pullRows.length,
              reportCode: pull?.report_code ?? null,
              fightId: pull?.fight_id ?? null,
              pullNumber: pull?.pull_number ?? null,
              occurredAt: row.closed_at,
              wclUrl:
                pull == null
                  ? null
                  : `https://www.warcraftlogs.com/reports/${pull.report_code}#fight=${pull.fight_id}&type=damage-taken&ability=${first.ability_id}`,
            };
          })
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
        const sources = candidate?.ai_classification?.sources ?? [];
        return {
          bossId: first.boss_id,
          bossName: bossNameById.get(first.boss_id) ?? `Boss ${first.boss_id}`,
          difficulty: first.difficulty,
          abilityId: first.ability_id,
          mechanicName: candidate?.name ?? first.mechanic_name,
          mechanicNameEs: candidate?.name_es ?? null,
          description: candidate?.description ?? null,
          resolution: candidate?.resolution ?? null,
          coachingNote: candidate?.ai_classification?.notes ?? null,
          sources,
          occurrenceCount: rows.length,
          evidence,
        };
      })
      .sort(
        (a, b) =>
          b.occurrenceCount - a.occurrenceCount || a.bossName.localeCompare(b.bossName, 'es'),
      );
  }
}
