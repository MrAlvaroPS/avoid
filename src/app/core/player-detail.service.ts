// Colocar en: src/app/core/player-detail.service.ts
// §"detalle de jugador con su tendencia en el tiempo" (feedback real): el
// desplegable de roster.component es una foto fija (los últimos 60 días en
// bloque, un único breakdown de 4 ejes). Aquí se parte la MISMA fórmula de
// reliability.service.ts (computeOverall, reexportada) en cubos semanales —
// nada de una fórmula nueva — y se añade la lista de muertes recientes con
// causa: las dos preguntas que un RL hace de un jugador concreto, "¿va a
// mejor o a peor semana a semana?" y "¿cómo ha muerto últimamente?".
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { WowauditRosterService } from './wowaudit-roster.service';
import { computeReliabilityBreakdown, ReliabilityService, type ReliabilityInputRow } from './reliability.service';
import { loadMechanicNotesByName } from './mechanic-notes';
import { mechanicDisplayName } from '../shared/format.util';
import type { DeathCause, MechanicCategory } from '../shared/models/domain';
import type { RaidRole } from '../shared/role-icon.component';

const HISTORY_WEEKS = 10; // suficiente para ver una tendencia real sin diluirla en meses de ruido
const RECENT_DEATHS_LIMIT = 15;

export interface WeeklyScorePoint {
  weekStartLabel: string; // "12 jun"
  score: number | null; // null = sin pulls evaluables esa semana
  consistencyScore: number | null;
  sampleSize: number;
  isCurrent: boolean;
}

export interface RecentDeathRow {
  pullId: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  closedAt: string;
  isWipeCall: boolean;
  statisticalExclusionReason: DeathCause['statisticalExclusionReason'];
  mechanicName: string | null;
  mechanicId: number | null;
  category: MechanicCategory | null;
  rootCause: DeathCause['rootCause'];
  preventableWithDefensive: boolean | null;
  /** §"poner una 'I' de información junto a la mecánica con la nota descriptiva que haya traído la IA" (feedback real). */
  aiNote: string | null;
}

export interface RecentNight {
  reportCode: string;
  title: string;
  date: string;
}

export interface PlayerDetail {
  playerName: string;
  role: RaidRole;
  rank: 'Main' | 'Trial' | null;
  weeklyScores: WeeklyScorePoint[];
  recentDeaths: RecentDeathRow[];
  /** §"un dosier de personaje de una noche concreta": entrada al dosier por noche desde el histórico del jugador. */
  recentNights: RecentNight[];
}

const RECENT_NIGHTS_LIMIT = 8;

@Injectable({ providedIn: 'root' })
export class PlayerDetailService {
  private supabase = inject(SupabaseService);
  private wowauditRoster = inject(WowauditRosterService);
  private reliabilityService = inject(ReliabilityService);

  async load(playerName: string): Promise<PlayerDetail> {
    const client = this.supabase.client;
    const since = new Date(Date.now() - HISTORY_WEEKS * 7 * 86_400_000).toISOString();

    const [reliabilityInputs, deathsRes, roster] = await Promise.all([
      this.reliabilityService.getPlayerReliabilityInputs(playerName, since),
      client
        .from('player_pull_records')
        .select('pull_id, death_cause, wipe_call_cluster, pulls!inner(boss_id, difficulty, closed_at, wipe_call_excluded)')
        .eq('player_name', playerName)
        .eq('died', true)
        .order('created_at', { ascending: false })
        .limit(RECENT_DEATHS_LIMIT),
      this.wowauditRoster.listRoster().catch(() => []),
    ]);
    if (deathsRes.error) throw deathsRes.error;

    const rosterEntry = roster.find((r) => r.name === playerName) ?? null;

    const weeklyScores = this.buildWeeklyScores(reliabilityInputs);

    const bossIds = [...new Set((deathsRes.data ?? []).map((d) => (d as unknown as { pulls: { boss_id: string } }).pulls.boss_id))];
    const bossNames = bossIds.length
      ? await client
          .from('known_raid_bosses')
          .select('encounter_id, boss_name')
          .in(
            'encounter_id',
            bossIds.map((id) => Number(id)),
          )
      : { data: [] as { encounter_id: number; boss_name: string }[] };
    const bossNameByEncounterId = new Map((bossNames.data ?? []).map((b) => [String(b.encounter_id), b.boss_name]));
    const notesByMechanicName = await loadMechanicNotesByName(client, bossIds).catch(() => new Map<string, string>());

    const recentDeaths: RecentDeathRow[] = (deathsRes.data ?? []).map((row) => {
      const r = row as unknown as {
        pull_id: string;
        death_cause: DeathCause | null;
        wipe_call_cluster: boolean;
        pulls: { boss_id: string; difficulty: string; closed_at: string; wipe_call_excluded: boolean };
      };
      return {
        pullId: r.pull_id,
        bossId: r.pulls.boss_id,
        bossName: bossNameByEncounterId.get(r.pulls.boss_id) ?? `Boss ${r.pulls.boss_id}`,
        difficulty: r.pulls.difficulty,
        closedAt: r.pulls.closed_at,
        // §"un wipe call confirmado seguiría contando en... muertes
        // recientes de un jugador" (feedback real, ya identificado y
        // resuelto): se sigue mostrando la fila (el RL quiere verla), solo
        // marcada — mismo criterio que "a quién dirigir" en un pull.
        isWipeCall: r.wipe_call_cluster && r.pulls.wipe_call_excluded,
        statisticalExclusionReason: r.death_cause?.statisticalExclusionReason ?? null,
        mechanicName: mechanicDisplayName(r.death_cause?.mechanicName ?? null),
        mechanicId: r.death_cause?.mechanicId || null,
        category: r.death_cause?.category ?? null,
        rootCause: r.death_cause?.rootCause ?? 'unclassified',
        preventableWithDefensive: r.death_cause?.statisticalExclusionReason ? null : (r.death_cause?.preventableWithDefensive ?? null),
        aiNote: (r.death_cause?.mechanicName && notesByMechanicName.get(r.death_cause.mechanicName)) || null,
      };
    });

    const recentNights = await this.listRecentNights(playerName);

    return {
      playerName,
      role: rosterEntry?.role ?? null,
      rank: rosterEntry?.rank ?? null,
      weeklyScores,
      recentDeaths,
      recentNights,
    };
  }

  /** §"un dosier de personaje de una noche concreta": qué reports (noches) tienen algún pull de este jugador, más recientes primero — la entrada al dosier desde el histórico del jugador. */
  private async listRecentNights(playerName: string): Promise<RecentNight[]> {
    const client = this.supabase.client;
    const { data: pullRows, error: pullsErr } = await client.from('player_pull_records').select('pulls!inner(report_code)').eq('player_name', playerName);
    if (pullsErr) throw pullsErr;
    const codes = [...new Set(((pullRows ?? []) as unknown as { pulls: { report_code: string } }[]).map((r) => r.pulls.report_code))];
    if (!codes.length) return [];

    const { data: reportRows, error: reportsErr } = await client.from('reports').select('code, title, start_time').in('code', codes).order('start_time', { ascending: false }).limit(RECENT_NIGHTS_LIMIT);
    if (reportsErr) throw reportsErr;
    return ((reportRows ?? []) as { code: string; title: string; start_time: number }[]).map((r) => ({
      reportCode: r.code,
      title: r.title,
      date: new Date(r.start_time).toISOString(),
    }));
  }

  /** Cubos de 7 días desde hoy hacia atrás (no semana natural lun-dom, evita líos de timezone) — cada cubo reutiliza computeOverall tal cual, la misma fórmula que el score de roster, aplicada a un subconjunto más pequeño de filas. */
  private buildWeeklyScores(rows: ReliabilityInputRow[]): WeeklyScorePoint[] {
    const now = Date.now();
    const buckets: ReliabilityInputRow[][] = Array.from({ length: HISTORY_WEEKS }, () => []);
    for (const row of rows) {
      const daysAgo = (now - new Date(row.closed_at).getTime()) / 86_400_000;
      const weekIndex = Math.floor(daysAgo / 7);
      if (weekIndex >= 0 && weekIndex < HISTORY_WEEKS) buckets[weekIndex].push(row);
    }

    const points: WeeklyScorePoint[] = [];
    for (let weekIndex = HISTORY_WEEKS - 1; weekIndex >= 0; weekIndex--) {
      const bucketRows = buckets[weekIndex];
      const weekStartMs = now - (weekIndex + 1) * 7 * 86_400_000;
      const result = computeReliabilityBreakdown(bucketRows, now);
      points.push({
        weekStartLabel: new Date(weekStartMs).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }),
        score: result?.overall ?? null,
        consistencyScore: result?.consistency?.score ?? null,
        sampleSize: bucketRows.length,
        isCurrent: weekIndex === 0,
      });
    }
    return points;
  }
}
