// Colocar en: src/app/core/night-report.service.ts
// §"echo de menos un informe... no solo a nivel individual sino a nivel de
// raid también" (feedback real): night-player-summary.service.ts ya cubre
// jugador × noche — esto es el complemento raid-wide × noche, la cuarta
// combinación que faltaba junto a boss+dificultad, jugador+histórico y
// jugador+noche. Mismos datos ya guardados, agregados a nivel de report
// entero en vez de por jugador o por pull.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { WowauditRosterService, type WowauditRosterEntry } from './wowaudit-roster.service';
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
import { validAttemptOrdinal } from '../shared/pull-consistency.util';

/** Tanks primero, luego healers, luego dps (melee y ranged juntos). */
const ROLE_SORT_ORDER: WowauditRosterEntry['role'][] = ['Tank', 'Heal', 'Melee', 'Ranged'];

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

/** §"ponles el icono de clase al lado y colorea el nombre... primero tanks, luego healers y luego dps" (feedback real). */
export interface NightAttendee {
  name: string;
  class: string | null;
  role: WowauditRosterEntry['role'] | null;
}

/** §"stat de cobertura a nivel de raid" (feedback real, 2026-08-29): cuántos
 * intentos de este boss+dificultad tuvieron a ALGUIEN resolviendo esta
 * mecánica sin asignar, esta noche. Solo catálogo con
 * has_confirmed_detection=true entra aquí (mismo gate que analyze-report/
 * reanalyze-unassigned-mechanics) — nunca puede decir "0/3" por falta de
 * detección real, solo por falta real de alguien haciéndolo.
 * §CORRECCIÓN (feedback real, 2026-08-29 — "eso de que no afecta a
 * puntuación individual no es correcto no?"): lo único "puramente
 * informativo" es este AGREGADO en sí (el X/Y de cobertura de raid no es la
 * puntuación de nadie) — cada ocurrencia individual que resume SÍ sube el %
 * de Mecánica de quien la hizo (ver UNASSIGNED_MECHANIC_BONUS_PER_OCCURRENCE
 * en pull-analysis.service.ts). No decir lo contrario en la UI. */
export interface NightUnassignedMechanicCoverage {
  bossId: string;
  bossName: string;
  difficulty: string;
  mechanicName: string;
  /** Intentos válidos de este boss+dificultad esta noche (excluye ninja pulls, igual criterio que el resto de la app). */
  totalPulls: number;
  pullsWithAnyOccurrence: number;
  totalOccurrences: number;
  uniqueResolvers: number;
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
  /** Ordenados tanks → healers → dps, como se pide para "identificarlos rápido" en el roster de la noche. */
  attendingMain: NightAttendee[];
  attendingTrial: NightAttendee[];
  /** Miembros Main del roster de wowaudit que NO aparecen en ningún pull de esta noche — "quién faltó". Vacío si el roster de wowaudit no está sincronizado todavía. */
  absentMain: NightAttendee[];
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
  /** §"stat de cobertura a nivel de raid" (feedback real, 2026-08-29): solo bosses de esta noche con al menos una fila confirmada en unassigned_mechanic_catalog — vacío si ninguno de los bosses pulleados esta noche tiene todavía una mecánica sin asignar confirmada. */
  unassignedMechanicCoverage: NightUnassignedMechanicCoverage[];
}

@Injectable({ providedIn: 'root' })
export class NightReportService {
  private supabase = inject(SupabaseService);
  private wowauditRoster = inject(WowauditRosterService);

  /** §"recalcular todo" (feedback real, 2026-08-31): ids de pulls de este report, para poder reanalizarlos de verdad (no solo releer el caché) desde el botón de recálculo. */
  async listPullIds(reportCode: string): Promise<string[]> {
    const { data, error } = await this.supabase.client.from('pulls').select('id').eq('report_code', reportCode);
    if (error) throw error;
    return (data ?? []).map((p) => p.id as string);
  }

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

    const [{ data: recordsData, error: recordsErr }, { data: mechEventsData, error: mechErr }, notesByMechanicName, { data: briefRow }, { data: unassignedCatalogData }] = await Promise.all([
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
      // §"stat de cobertura a nivel de raid" (feedback real, 2026-08-29):
      // solo catálogo confirmado (mismo gate que analyze-report), acotado a
      // los bosses que de verdad se pullearon esta noche — no trae la tabla
      // entera para descartar el resto en cliente.
      pulls.length
        ? client
            .from('unassigned_mechanic_catalog')
            .select('id,boss_id,difficulty,name')
            .in('boss_id', [...new Set(pulls.map((p) => p.boss_id))])
            .eq('has_confirmed_detection', true)
        : Promise.resolve({ data: [] as { id: string; boss_id: string; difficulty: string; name: string }[] }),
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
        // §"la numeracion no es global de toda la noche si no por boss y así
        // deberia serlo en toda la app" (feedback real, 2026-08-29): mismo
        // criterio que raid-session.component.ts (validAttemptOrdinal contra
        // g.pulls, ya agrupado por boss+dificultad aquí mismo) — p.pull_number
        // crudo es la numeración global del report entero, no la de este boss.
        progressBars: g.pulls.map((p) => {
          const ordinal = validAttemptOrdinal(g.pulls, p.id) ?? p.pull_number;
          return {
            label: `#${ordinal}`,
            value: Math.round(100 - (p.wipe_pct ?? 100)),
            isKill: p.wipe_pct === 0,
            isCurrent: false,
            tooltip: `Intento #${ordinal}: ${p.wipe_pct === 0 ? 'Kill' : `Wipe al ${(p.wipe_pct ?? 100).toFixed(1)}%`}`,
          };
        }),
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
      .map((p) => {
        const group = bossGroups.get(`${p.boss_id}|${p.difficulty}`)?.pulls ?? [p];
        return {
          bossName: bossNameByFightId.get(p.fight_id) ?? `Boss ${p.boss_id}`,
          difficulty: p.difficulty,
          pullNumber: validAttemptOrdinal(group, p.id) ?? p.pull_number,
          confidence: p.wipe_call_confidence!,
        };
      });

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
    const toAttendee = (r: WowauditRosterEntry): NightAttendee => ({ name: r.name, class: r.class, role: r.role });
    const byRoleThenName = (a: NightAttendee, b: NightAttendee) =>
      ROLE_SORT_ORDER.indexOf(a.role ?? 'Ranged') - ROLE_SORT_ORDER.indexOf(b.role ?? 'Ranged') || a.name.localeCompare(b.name);
    const attendingMain = roster.filter((r) => r.rank === 'Main' && attendedNames.has(r.name)).map(toAttendee).sort(byRoleThenName);
    const attendingTrial = roster.filter((r) => r.rank === 'Trial' && attendedNames.has(r.name)).map(toAttendee).sort(byRoleThenName);
    const absentMain = roster.filter((r) => r.rank === 'Main' && !attendedNames.has(r.name)).map(toAttendee).sort(byRoleThenName);
    const playerClasses = new Map(roster.filter((r) => attendedNames.has(r.name)).map((r) => [r.name, r.class]));

    // §"stat de cobertura a nivel de raid" (feedback real, 2026-08-29): una
    // fila del catálogo -> una fila de cobertura, agregando SOLO los pulls
    // de esta noche que casan boss+dificultad. Sin exclusión por wipe call
    // a propósito (mismo criterio que unassignedMechanicCredits en
    // night-player-summary.service.ts — resolverla es mérito real aunque el
    // intento acabe en wipe); sí se excluyen ninja pulls, igual que el
    // resto de esta pantalla.
    const unassignedMechanicCoverage: NightUnassignedMechanicCoverage[] = ((unassignedCatalogData ?? []) as { id: string; boss_id: string; difficulty: string; name: string }[])
      .map((catalogRow) => {
        const scopedPulls = pulls.filter((p) => p.boss_id === catalogRow.boss_id && p.difficulty === catalogRow.difficulty && !p.ninja_pull_excluded);
        let pullsWithAnyOccurrence = 0;
        let totalOccurrences = 0;
        const resolvers = new Set<string>();
        for (const pull of scopedPulls) {
          const occurrences = (pull.unassigned_mechanic_occurrences ?? []).filter((occ) => occ.catalogId === catalogRow.id);
          if (occurrences.length) pullsWithAnyOccurrence++;
          totalOccurrences += occurrences.length;
          for (const occ of occurrences) resolvers.add(occ.actorName);
        }
        return {
          bossId: catalogRow.boss_id,
          bossName: bossNameByFightId.get(scopedPulls[0]?.fight_id ?? -1) ?? `Boss ${catalogRow.boss_id}`,
          difficulty: catalogRow.difficulty,
          mechanicName: catalogRow.name,
          totalPulls: scopedPulls.length,
          pullsWithAnyOccurrence,
          totalOccurrences,
          uniqueResolvers: resolvers.size,
        };
      })
      // Sin ningún intento de este boss+dificultad esta noche (catálogo de
      // otra noche/otra season vista de refilón por el filtro de boss_id) —
      // no aporta nada mostrar un "0/0".
      .filter((row) => row.totalPulls > 0);

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
      unassignedMechanicCoverage,
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
