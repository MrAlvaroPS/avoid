// Colocar en: src/app/core/boss-history.service.ts
// §"además de poder revisar pull por pull, un 'todos los pulls' que reúna
// datos de los pulls de ese boss en esa dificultad, ver progresos en
// mecánicas, mejoras, etc" (feedback real). Todo lo que trae este servicio
// sale de tablas que YA existen (pulls, pull_mechanic_events,
// player_pull_records, boss_reference_stats) — ninguna llamada nueva a WCL,
// es agregación pura sobre lo que ya se guarda pull a pull.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { ReliabilityService, type PlayerReliability } from './reliability.service';
import { buildReferencePacingFromDuration } from './pull-analysis.service';
import { loadMechanicNotesByName } from './mechanic-notes';
import { mechanicDisplayName } from '../shared/format.util';
import type { BossReferenceStatsRow, MechanicCategory, PullMechanicEventRow, PullRow } from '../shared/models/domain';
import type { ReferencePacing } from '../shared/models/ui';

export interface ProgressionPoint {
  pullNumber: number;
  closedAt: string;
  wipePct: number;
  kill: boolean;
  durationMs: number | null;
}

export interface MechanicTrendRow {
  abilityId: number;
  name: string;
  category: MechanicCategory | null;
  /** Fallos (partial_fail+fail) / instancias totales, primera mitad cronológica de los pulls vistos. */
  firstHalfFailRate: number | null;
  secondHalfFailRate: number | null;
  totalInstances: number;
  totalFails: number;
  /** null = sin suficiente muestra en alguna mitad para comparar honestamente (menos de MIN_INSTANCES_PER_HALF). */
  trend: 'improving' | 'worsening' | 'flat' | null;
  /** §"poner una 'I' de información junto a la mecánica con la nota descriptiva que haya traído la IA" (feedback real). */
  aiNote: string | null;
}

export interface DeathCauseRow {
  mechanicName: string;
  wowheadSpellId: number | null;
  deathCount: number;
  distinctPlayers: number;
  aiNote: string | null;
}

export interface BossHistoryData {
  bossId: string;
  bossName: string;
  difficulty: string;
  totalPulls: number;
  totalKills: number;
  firstKillAt: string | null;
  bestKillDurationMs: number | null;
  referenceStats: BossReferenceStatsRow | null;
  /** Mejor kill de TODA la historia del boss vs. mediana pública — mismo componente que ya usa la vista de un pull (compare-bar-row), aquí con el mejor tiempo histórico en vez del de un pull concreto. */
  referencePacing: ReferencePacing | null;
  progression: ProgressionPoint[];
  mechanicTrends: MechanicTrendRow[];
  topDeathCauses: DeathCauseRow[];
  roster: PlayerReliability[];
}

// Umbral de muestra para hablar de "tendencia" en una mecánica concreta —
// mismo espíritu que buildMechanicFailurePatterns (pull-analysis.service.ts):
// mejor no señalar que señalar con 1-2 instancias de ruido.
const MIN_INSTANCES_PER_HALF = 3;

@Injectable({ providedIn: 'root' })
export class BossHistoryService {
  private supabase = inject(SupabaseService);
  private reliability = inject(ReliabilityService);

  async load(bossId: string, difficulty: string): Promise<BossHistoryData> {
    const client = this.supabase.client;

    const { data: pullsData, error: pullsErr } = await client
      .from('pulls')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('closed_at', { ascending: true });
    if (pullsErr) throw pullsErr;
    const pulls = (pullsData ?? []) as PullRow[];
    const pullIds = pulls.map((p) => p.id);

    const [bossNameRes, mechEventsRes, deathsRes, referenceStatsRes, roster] = await Promise.all([
      client.from('known_raid_bosses').select('boss_name').eq('encounter_id', Number(bossId)).maybeSingle(),
      pullIds.length
        ? client.from('pull_mechanic_events').select('ability_id, mechanic_name, category, outcome, pull_id').in('pull_id', pullIds)
        : Promise.resolve({ data: [] as PullMechanicEventRow[], error: null }),
      pullIds.length
        ? client.from('player_pull_records').select('player_name, died, death_cause, pull_id, wipe_call_cluster').in('pull_id', pullIds).eq('died', true)
        : Promise.resolve({
            data: [] as { player_name: string; died: boolean; death_cause: { mechanicId: number; mechanicName: string | null } | null; pull_id: string; wipe_call_cluster: boolean }[],
            error: null,
          }),
      client.from('boss_reference_stats').select('*').eq('boss_id', bossId).eq('difficulty', difficulty).maybeSingle(),
      this.reliability.listPlayerReliability({ bossId, difficulty }),
    ]);
    const notesByMechanicName = await loadMechanicNotesByName(client, [bossId]).catch(() => new Map<string, string>());

    // §"quién muere más" no cambia el resto de la petición si el nombre no
    // se resolvió (known_raid_bosses sin sincronizar todavía) — mejor un
    // fallback legible que tumbar toda la pantalla.
    const bossName = (bossNameRes.data as { boss_name: string } | null)?.boss_name ?? `Boss ${bossId}`;

    const kills = pulls.filter((p) => p.wipe_pct === 0);
    const killDurations = kills.filter((p) => p.duration_ms != null).map((p) => p.duration_ms!);
    const bestKillDurationMs = killDurations.length ? Math.min(...killDurations) : null;
    const referenceStats = (referenceStatsRes.data as BossReferenceStatsRow | null) ?? null;

    const progression: ProgressionPoint[] = pulls.map((p) => ({
      pullNumber: p.pull_number,
      closedAt: p.closed_at,
      wipePct: p.wipe_pct ?? 100,
      kill: p.wipe_pct === 0,
      durationMs: p.duration_ms,
    }));

    const mechanicTrends = this.buildMechanicTrends((mechEventsRes.data ?? []) as (PullMechanicEventRow & { pull_id: string })[], pullIds, notesByMechanicName);
    // §"no debería... contar como muerte, marcado como wipe call" (feedback
    // real): "causas de muerte más repetidas" es literalmente sobre
    // muertes, así que las de un cluster de wipe call confirmado/excluido
    // no deben inflar el recuento — mismo criterio que ya aplica
    // pull-analysis.service.ts a un pull individual, aquí agregado sobre
    // TODA la historia del boss.
    const pullById = new Map(pulls.map((p) => [p.id, p]));
    const deathRows = (deathsRes.data ?? []) as { player_name: string; death_cause: { mechanicId: number; mechanicName: string | null } | null; pull_id: string; wipe_call_cluster: boolean }[];
    const topDeathCauses = this.buildTopDeathCauses(
      deathRows.filter((d) => !(d.wipe_call_cluster && pullById.get(d.pull_id)?.wipe_call_excluded)),
      notesByMechanicName,
    );

    return {
      bossId,
      bossName,
      difficulty,
      totalPulls: pulls.length,
      totalKills: kills.length,
      firstKillAt: kills[0]?.closed_at ?? null,
      bestKillDurationMs,
      referenceStats,
      referencePacing: buildReferencePacingFromDuration(bestKillDurationMs, referenceStats),
      progression,
      mechanicTrends,
      topDeathCauses,
      roster,
    };
  }

  /** §"ver progresos en mecánicas": divide los pulls vistos en dos mitades CRONOLÓGICAS (por orden de llegada, ya vienen ordenados por closed_at) y compara el % de fallo de cada mecánica entre una mitad y otra — "mejorando" = falla menos ahora que antes. */
  private buildMechanicTrends(events: (PullMechanicEventRow & { pull_id: string })[], orderedPullIds: string[], notesByMechanicName: Map<string, string>): MechanicTrendRow[] {
    const halfIndex = Math.ceil(orderedPullIds.length / 2);
    const firstHalfPullIds = new Set(orderedPullIds.slice(0, halfIndex));

    const byAbility = new Map<number, { name: string; category: MechanicCategory | null; firstTotal: number; firstFail: number; secondTotal: number; secondFail: number }>();
    for (const ev of events) {
      if (!byAbility.has(ev.ability_id)) byAbility.set(ev.ability_id, { name: ev.mechanic_name, category: ev.category, firstTotal: 0, firstFail: 0, secondTotal: 0, secondFail: 0 });
      const entry = byAbility.get(ev.ability_id)!;
      const isFail = ev.outcome !== 'clean';
      if (firstHalfPullIds.has(ev.pull_id)) {
        entry.firstTotal++;
        if (isFail) entry.firstFail++;
      } else {
        entry.secondTotal++;
        if (isFail) entry.secondFail++;
      }
    }

    return [...byAbility.entries()]
      .map(([abilityId, e]) => {
        const totalInstances = e.firstTotal + e.secondTotal;
        const totalFails = e.firstFail + e.secondFail;
        const enoughSample = e.firstTotal >= MIN_INSTANCES_PER_HALF && e.secondTotal >= MIN_INSTANCES_PER_HALF;
        const firstHalfFailRate = e.firstTotal > 0 ? e.firstFail / e.firstTotal : null;
        const secondHalfFailRate = e.secondTotal > 0 ? e.secondFail / e.secondTotal : null;
        let trend: MechanicTrendRow['trend'] = null;
        if (enoughSample && firstHalfFailRate != null && secondHalfFailRate != null) {
          const delta = secondHalfFailRate - firstHalfFailRate;
          // 8pp de diferencia mínima — mismo espíritu que TREND_THRESHOLD de
          // reliability.service.ts: no marcar como movimiento real un
          // vaivén de una sola instancia entre mitades pequeñas.
          trend = delta <= -0.08 ? 'improving' : delta >= 0.08 ? 'worsening' : 'flat';
        }
        return { abilityId, name: e.name, category: e.category, firstHalfFailRate, secondHalfFailRate, totalInstances, totalFails, trend, aiNote: notesByMechanicName.get(e.name) ?? null };
      })
      .filter((row) => row.totalFails > 0) // limpio de principio a fin no es una "mecánica a vigilar" — no aporta a esta lista
      .sort((a, b) => b.totalFails - a.totalFails);
  }

  private buildTopDeathCauses(
    deaths: { player_name: string; death_cause: { mechanicId: number; mechanicName: string | null } | null }[],
    notesByMechanicName: Map<string, string>,
  ): DeathCauseRow[] {
    const byMechanic = new Map<string, { wowheadSpellId: number | null; count: number; players: Set<string> }>();
    for (const d of deaths) {
      if (!d.death_cause) continue;
      const name = mechanicDisplayName(d.death_cause.mechanicName);
      if (!byMechanic.has(name)) byMechanic.set(name, { wowheadSpellId: d.death_cause.mechanicId || null, count: 0, players: new Set() });
      const entry = byMechanic.get(name)!;
      entry.count++;
      entry.players.add(d.player_name);
    }
    return [...byMechanic.entries()]
      .map(([mechanicName, e]) => ({ mechanicName, wowheadSpellId: e.wowheadSpellId, deathCount: e.count, distinctPlayers: e.players.size, aiNote: notesByMechanicName.get(mechanicName) ?? null }))
      .sort((a, b) => b.deathCount - a.deathCount);
  }
}
