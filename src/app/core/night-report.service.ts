// Colocar en: src/app/core/night-report.service.ts
// §"echo de menos un informe... no solo a nivel individual sino a nivel de
// raid también" (feedback real): night-player-summary.service.ts ya cubre
// jugador × noche — esto es el complemento raid-wide × noche, la cuarta
// combinación que faltaba junto a boss+dificultad, jugador+histórico y
// jugador+noche. Mismos datos ya guardados, agregados a nivel de report
// entero en vez de por jugador o por pull.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { WowauditRosterService } from './wowaudit-roster.service';
import { loadMechanicNotesByName } from './mechanic-notes';
import { mapBrief } from './pull-analysis.service';
import { mechanicCategoryMeta, mechanicDisplayName } from '../shared/format.util';
import type { DeathCause, MechanicCategory, PullRow } from '../shared/models/domain';
import type { TrendBar } from '../shared/charts/trend-bars.component';
import type { DonutSegment } from '../shared/charts/donut-chart.component';
import type { LlmPullAnalysis } from '../shared/models/ui';
import type { NightFullReport, StoredNightFullReport } from '../shared/models/night-full-report';
import { isDeathExcludedFromStatistics, isMechanicExcludedByWipeCall } from '../shared/death-statistics.util';
import { withSupabaseRelationFallback } from '../shared/supabase-query.util';

export interface NightBossSummary {
  bossId: string;
  bossName: string;
  difficulty: string;
  attempts: number;
  kills: number;
  bestWipePct: number | null;
  bestKillDurationMs: number | null;
  progressBars: TrendBar[];
}

export interface NightTopDeathCause {
  mechanicName: string;
  wowheadSpellId: number | null;
  deathCount: number;
  distinctPlayers: number;
  /** §"poner una 'I' de información junto a la mecánica con la nota descriptiva que haya traído la IA" (feedback real). */
  aiNote: string | null;
}

export interface NightTopOffender {
  playerName: string;
  deathCount: number;
}

export interface NightWipeCallPull {
  bossName: string;
  difficulty: string;
  pullNumber: number;
  confidence: number;
}

export interface NightReport {
  reportCode: string;
  reportTitle: string;
  reportDate: string;
  bosses: NightBossSummary[];
  totalPulls: number;
  totalKills: number;
  totalWipes: number;
  totalDurationMs: number;
  attendingMain: string[];
  attendingTrial: string[];
  /** Miembros Main del roster de wowaudit que NO aparecen en ningún pull de esta noche — "quién faltó". Vacío si el roster de wowaudit no está sincronizado todavía. */
  absentMain: string[];
  totalDeaths: number;
  totalWipeCallDeathsExcluded: number;
  wipeCallPulls: NightWipeCallPull[];
  topDeathCauses: NightTopDeathCause[];
  topOffenders: NightTopOffender[];
  mechanicCategoryBreakdown: DonutSegment[];
  defensiveStatusBreakdown: DonutSegment[];
  /** §"pintar cada jugador de su clase" (feedback real): nombre -> clase WCL de todo el roster que participó, para app-brief-text. */
  playerClasses: Map<string, string>;
  /** §"un resumen de una noche... la consulta de IA" (feedback real): cacheado desde night_briefs, null si nunca se ha generado. */
  brief: LlmPullAnalysis | null;
}

@Injectable({ providedIn: 'root' })
export class NightReportService {
  private supabase = inject(SupabaseService);
  private wowauditRoster = inject(WowauditRosterService);

  async loadFullReport(reportCode: string): Promise<StoredNightFullReport | null> {
    const { data, error } = await this.supabase.client
      .from('night_full_reports')
      .select('report, generated_at')
      .eq('report_code', reportCode)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const report = data.report as unknown as NightFullReport;
    if (report.schemaVersion !== 15) return null;
    return { report, generatedAt: data.generated_at as string };
  }

  async load(reportCode: string): Promise<NightReport> {
    const client = this.supabase.client;

    const [{ data: reportRow }, { data: pullsData, error: pullsErr }, { data: encounters }, roster] = await Promise.all([
      client.from('reports').select('title, start_time').eq('code', reportCode).maybeSingle(),
      client.from('pulls').select('*').eq('report_code', reportCode).order('pull_number', { ascending: true }),
      client.from('report_encounters').select('fight_id, boss_name').eq('report_code', reportCode),
      this.wowauditRoster.listRoster().catch(() => []),
    ]);
    if (pullsErr) throw pullsErr;

    const bossNameByFightId = new Map(((encounters ?? []) as { fight_id: number; boss_name: string }[]).map((e) => [e.fight_id, e.boss_name]));
    const pulls = (pullsData ?? []) as (PullRow & { fight_id: number })[];
    const pullIds = pulls.map((p) => p.id);
    const pullById = new Map(pulls.map((p) => [p.id, p]));

    const [{ data: recordsData, error: recordsErr }, { data: mechEventsData, error: mechErr }, notesByMechanicName, { data: briefRow }] = await Promise.all([
      pullIds.length
        ? client.from('player_pull_records').select('pull_id, player_name, died, death_cause, wipe_call_cluster').in('pull_id', pullIds)
        : Promise.resolve({ data: [] as RecordLite[], error: null }),
      pullIds.length
        ? withSupabaseRelationFallback(
            'applicable_pull_mechanic_events',
            () => client.from('applicable_pull_mechanic_events').select('pull_id, category, outcome, players_hit, trigger_time_ms').in('pull_id', pullIds),
            () => client.from('pull_mechanic_events').select('pull_id, category, outcome, players_hit, trigger_time_ms').in('pull_id', pullIds),
          )
        : Promise.resolve({ data: [] as MechEventLite[], error: null }),
      loadMechanicNotesByName(client, pulls.map((p) => p.boss_id)).catch(() => new Map<string, string>()),
      client.from('night_briefs').select('*').eq('report_code', reportCode).maybeSingle(),
    ]);
    if (recordsErr) throw recordsErr;
    if (mechErr) throw mechErr;

    const records = (recordsData ?? []) as RecordLite[];
    const mechEvents = ((mechEventsData ?? []) as MechEventLite[]).filter((event) => {
      const eventPull = pullById.get(event.pull_id);
      return eventPull != null && !isMechanicExcludedByWipeCall(eventPull, event as import('../shared/models/domain').PullMechanicEventRow);
    });

    // §"a nivel de raid, no solo individual": bosses agrupados con el mismo
    // criterio que ya usa raid-session.component.ts (pullGroups) — aquí
    // servido desde el backend para que el informe completo no dependa de
    // recalcularlo en la pantalla que lo pidió primero.
    const bossGroups = new Map<string, { bossId: string; bossName: string; difficulty: string; pulls: (PullRow & { fight_id: number })[] }>();
    for (const p of pulls) {
      const key = `${p.boss_id}|${p.difficulty}`;
      if (!bossGroups.has(key)) bossGroups.set(key, { bossId: p.boss_id, bossName: bossNameByFightId.get(p.fight_id) ?? `Boss ${p.boss_id}`, difficulty: p.difficulty, pulls: [] });
      bossGroups.get(key)!.pulls.push(p);
    }
    const bosses: NightBossSummary[] = [...bossGroups.values()].map((g) => {
      const kills = g.pulls.filter((p) => p.wipe_pct === 0);
      const killDurations = kills.filter((p) => p.duration_ms != null).map((p) => p.duration_ms!);
      const wipePcts = g.pulls.filter((p) => p.wipe_pct != null).map((p) => p.wipe_pct!);
      return {
        bossId: g.bossId,
        bossName: g.bossName,
        difficulty: g.difficulty,
        attempts: g.pulls.length,
        kills: kills.length,
        bestWipePct: wipePcts.length ? Math.min(...wipePcts) : null,
        bestKillDurationMs: killDurations.length ? Math.min(...killDurations) : null,
        progressBars: g.pulls.map((p) => ({
          label: `#${p.pull_number}`,
          value: Math.round(100 - (p.wipe_pct ?? 100)),
          isKill: p.wipe_pct === 0,
          isCurrent: false,
          tooltip: `Intento #${p.pull_number}: ${p.wipe_pct === 0 ? 'Kill' : `Wipe al ${(p.wipe_pct ?? 100).toFixed(1)}%`}`,
        })),
      };
    });

    const totalKills = pulls.filter((p) => p.wipe_pct === 0).length;
    const totalDurationMs = pulls.reduce((sum, p) => sum + (p.duration_ms ?? 0), 0);

    // §"esa gente no debería... contar como muerte, marcado como wipe
    // call": mismo criterio de siempre, aplicado a TODAS las muertes de la
    // noche, no solo las de un pull.
    const isExcludedWipeCallDeath = (r: RecordLite) => {
      const pull = pullById.get(r.pull_id);
      return Boolean(r.wipe_call_cluster && pull?.wipe_call_excluded);
    };
    const realDeaths = records.filter((record) => {
      const recordPull = pullById.get(record.pull_id);
      return record.died && record.death_cause && recordPull != null && !isDeathExcludedFromStatistics(recordPull, record as import('../shared/models/domain').PlayerPullRecordRow);
    });
    const wipeCallDeaths = records.filter((r) => r.died && isExcludedWipeCallDeath(r));

    const wipeCallPulls: NightWipeCallPull[] = pulls
      .filter((p) => p.wipe_call_excluded && p.wipe_call_confidence != null)
      .map((p) => ({ bossName: bossNameByFightId.get(p.fight_id) ?? `Boss ${p.boss_id}`, difficulty: p.difficulty, pullNumber: p.pull_number, confidence: p.wipe_call_confidence! }));

    const deathsByMechanic = new Map<string, { wowheadSpellId: number | null; count: number; players: Set<string> }>();
    const deathsByPlayer = new Map<string, number>();
    for (const r of realDeaths) {
      const dc = r.death_cause!;
      const name = mechanicDisplayName(dc.mechanicName);
      if (!deathsByMechanic.has(name)) deathsByMechanic.set(name, { wowheadSpellId: dc.mechanicId || null, count: 0, players: new Set() });
      const entry = deathsByMechanic.get(name)!;
      entry.count++;
      entry.players.add(r.player_name);
      deathsByPlayer.set(r.player_name, (deathsByPlayer.get(r.player_name) ?? 0) + 1);
    }
    const topDeathCauses: NightTopDeathCause[] = [...deathsByMechanic.entries()]
      .map(([mechanicName, e]) => ({ mechanicName, wowheadSpellId: e.wowheadSpellId, deathCount: e.count, distinctPlayers: e.players.size, aiNote: notesByMechanicName.get(mechanicName) ?? null }))
      .sort((a, b) => b.deathCount - a.deathCount)
      .slice(0, 10);
    const topOffenders: NightTopOffender[] = [...deathsByPlayer.entries()]
      .map(([playerName, deathCount]) => ({ playerName, deathCount }))
      .filter((o) => o.deathCount >= 2) // una muerte suelta no es un patrón de la noche
      .sort((a, b) => b.deathCount - a.deathCount)
      .slice(0, 10);

    // §"a nivel de raid": mismo criterio que buildMechanicCategoryBreakdown/
    // buildDefensiveStatusBreakdown de un pull (pull-analysis.service.ts),
    // agregado sobre TODOS los pulls de la noche en vez de uno solo.
    const categoryCounts = new Map<MechanicCategory | null, number>();
    for (const ev of mechEvents) {
      categoryCounts.set(ev.category, (categoryCounts.get(ev.category) ?? 0) + 1);
    }
    const mechanicCategoryBreakdown: DonutSegment[] = [...categoryCounts.entries()].map(([category, value]) => {
      const meta = mechanicCategoryMeta(category);
      return { label: meta?.label ?? 'Sin categoría', value, color: meta?.color ?? 'var(--text-faint)' };
    });

    const DEFENSIVE_STATUS_META: Record<string, { label: string; color: string }> = {
      active: { label: 'Activo al morir', color: 'var(--success)' },
      available_unused: { label: 'Disponible y sin usar', color: 'var(--warning)' },
      on_cooldown: { label: 'En cooldown', color: 'var(--neutral)' },
      unknown: { label: 'Sin dato de cooldown', color: 'var(--text-faint)' },
    };
    const defStatusCounts = new Map<string, number>();
    for (const r of realDeaths) {
      for (const opt of r.death_cause!.defensiveOptions ?? []) {
        defStatusCounts.set(opt.status, (defStatusCounts.get(opt.status) ?? 0) + 1);
      }
    }
    const defensiveStatusBreakdown: DonutSegment[] = [...defStatusCounts.entries()].map(([status, value]) => ({
      label: DEFENSIVE_STATUS_META[status]?.label ?? status,
      value,
      color: DEFENSIVE_STATUS_META[status]?.color ?? 'var(--text-faint)',
    }));

    // §"a nivel de raid... quién faltó": comparado contra el roster
    // CANÓNICO de wowaudit (Main), no contra "quién ha aparecido alguna
    // vez" — mismo principio que el resto de la app.
    const attendedNames = new Set(records.map((r) => r.player_name));
    const attendingMain = roster.filter((r) => r.rank === 'Main' && attendedNames.has(r.name)).map((r) => r.name);
    const attendingTrial = roster.filter((r) => r.rank === 'Trial' && attendedNames.has(r.name)).map((r) => r.name);
    const absentMain = roster.filter((r) => r.rank === 'Main' && !attendedNames.has(r.name)).map((r) => r.name);
    const playerClasses = new Map(roster.filter((r) => attendedNames.has(r.name)).map((r) => [r.name, r.class]));

    return {
      reportCode,
      reportTitle: (reportRow as { title: string } | null)?.title ?? reportCode,
      reportDate: (reportRow as { start_time: number } | null)?.start_time ? new Date((reportRow as { start_time: number }).start_time).toISOString() : '',
      bosses,
      totalPulls: pulls.length,
      totalKills,
      totalWipes: pulls.length - totalKills,
      totalDurationMs,
      attendingMain,
      attendingTrial,
      absentMain,
      totalDeaths: realDeaths.length,
      totalWipeCallDeathsExcluded: wipeCallDeaths.length,
      wipeCallPulls,
      topDeathCauses,
      topOffenders,
      mechanicCategoryBreakdown,
      defensiveStatusBreakdown,
      playerClasses,
      brief: briefRow ? mapBrief(briefRow as unknown as Parameters<typeof mapBrief>[0]) : null,
    };
  }
}

interface RecordLite {
  pull_id: string;
  player_name: string;
  died: boolean;
  death_cause: DeathCause | null;
  wipe_call_cluster: boolean;
}

interface MechEventLite {
  pull_id: string;
  category: MechanicCategory | null;
  outcome: string;
  players_hit: number;
  trigger_time_ms: number;
}
