// Colocar en: src/app/core/reports.service.ts
// Lecturas directas a Supabase (RLS = lectura pública, no hace falta pasar
// por una Edge Function para esto). Alimenta el picker de pulls de la
// pantalla principal y el desplegable de bosses del manifiesto.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { PullRow, ReportEncounterRow, ReportRow } from '../shared/models/domain';
import { STANDARD_DIFFICULTY_IDS, WCL_DIFFICULTY_NAME_BY_ID } from '../shared/format.util';
import type { RaidRole } from '../shared/role-icon.component';
import {
  resolveNightPlayerIdentity,
  type PlayerPullSpecObservation,
} from './night-player-identity.util';

export interface PullListItem extends PullRow {
  bossName: string;
  kill: boolean;
}

export interface KnownBoss {
  encounterId: number;
  bossName: string;
  difficulties: number[]; // wcl_difficulty_id vistos
  /** false = conocido solo por known_raid_bosses (§9.1), la guild nunca lo ha pulleado todavía — sync-boss-mechanics puede clasificarlo igual desde Journal+DB2+logs públicos, pero observed_in_logs se queda siempre en false. */
  hasRealPulls: boolean;
  /** Orden real de la instancia (Blizzard) — null para bosses vistos solo en report_encounters sin catálogo de season sincronizado todavía. */
  orderIndex: number | null;
  /** §"las notas del MRT no saltan... he pasado a 4-5 raiders y ninguna
   * salta donde debe" (feedback real, 2026-09-03): encounterId es el ID de
   * Warcraft Logs — el cliente del juego (y por tanto MRT/BigWigs) nunca lo
   * ha oído nombrar. journalEncounterId es el ID real de Blizzard
   * (EJ_GetEncounterInfo) que MRT espera en su campo bossID. null si
   * known_raid_bosses todavía no tiene sincronizado este boss. */
  journalEncounterId: number | null;
  /** ID de instancia de Blizzard (known_raid_bosses.blizzard_zone_id) — el que usa MRT como zoneID, distinto del zone_id de WCL. null si no está sembrado todavía para esta raid. */
  blizzardZoneId: number | null;
}

/** Compartido por listAllReports/listRecentReports — mismo join en memoria, distinto alcance de la consulta. */
function joinReportsWithBosses(
  reports: ReportRow[],
  encounters: { report_code: string; boss_name: string }[],
): { report: ReportRow; bossesAttempted: string[] }[] {
  const bossesByReport = new Map<string, Set<string>>();
  for (const e of encounters) {
    if (!bossesByReport.has(e.report_code)) bossesByReport.set(e.report_code, new Set());
    bossesByReport.get(e.report_code)!.add(e.boss_name);
  }
  return reports.map((report) => ({
    report,
    bossesAttempted: [...(bossesByReport.get(report.code) ?? [])],
  }));
}

export interface NightPlayerListItem {
  name: string;
  className: string | null;
  spec: string | null;
  /** Rol observado ESTA noche (ver night-player-identity.util.ts) — nunca el
   * de wowaudit_roster, ese fallback vive en ReportParticipantsService. */
  role: RaidRole;
}

@Injectable({ providedIn: 'root' })
export class ReportsService {
  private supabase = inject(SupabaseService);

  async getReport(code: string): Promise<ReportRow | null> {
    const { data, error } = await this.supabase.client
      .from('reports')
      .select('*')
      .eq('code', code)
      .maybeSingle();
    if (error) throw error;
    return data as ReportRow | null;
  }

  async listEncounters(code: string): Promise<ReportEncounterRow[]> {
    const { data, error } = await this.supabase.client
      .from('report_encounters')
      .select('*')
      .eq('report_code', code)
      .order('fight_id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ReportEncounterRow[];
  }

  /** Pulls de un report, con el nombre real del boss (join en memoria contra report_encounters, misma tabla que ya trae kill/boss_name). */
  async listPulls(code: string): Promise<PullListItem[]> {
    const [{ data: pulls, error: pullsErr }, encounters] = await Promise.all([
      this.supabase.client
        .from('pulls')
        .select('*')
        .eq('report_code', code)
        .order('fight_id', { ascending: true }),
      this.listEncounters(code),
    ]);
    if (pullsErr) throw pullsErr;
    const byFightId = new Map(encounters.map((e) => [e.fight_id, e]));
    return ((pulls ?? []) as PullRow[]).map((p) => {
      const enc = byFightId.get(p.fight_id);
      return {
        ...p,
        bossName: enc?.boss_name ?? `Boss ${p.boss_id}`,
        kill: enc?.kill ?? p.wipe_pct === 0,
      };
    });
  }

  /**
   * §"un dosier de personaje de una noche concreta": quién participó en
   * algún pull de este report — la lista de entrada al dosier por jugador
   * desde el resumen de la noche, y la base del Report Workspace (§33/§35
   * del plan IRIS). class/spec/role responden a "cómo jugó ESTA noche", no
   * a un valor cualquiera de la primera fila que llegue — ver
   * resolveNightPlayerIdentity para el porqué (un jugador puede cambiar de
   * spec durante la noche).
   */
  async listNightPlayers(code: string): Promise<NightPlayerListItem[]> {
    const { data: pullRows, error: pullsErr } = await this.supabase.client
      .from('pulls')
      .select('id,fight_id')
      .eq('report_code', code)
      .order('fight_id', { ascending: true });
    if (pullsErr) throw pullsErr;
    const orderedPullIds = ((pullRows ?? []) as { id: string; fight_id: number }[]).map(
      (p) => p.id,
    );
    if (!orderedPullIds.length) return [];
    const orderIndexByPullId = new Map(orderedPullIds.map((id, index) => [id, index]));

    const { data, error } = await this.supabase.client
      .from('player_pull_records')
      .select('player_name,class,spec,pull_id')
      .in('pull_id', orderedPullIds);
    if (error) throw error;

    const observationsByName = new Map<string, PlayerPullSpecObservation[]>();
    for (const row of (data ?? []) as {
      player_name: string;
      class: string | null;
      spec: string | null;
      pull_id: string;
    }[]) {
      const orderIndex = orderIndexByPullId.get(row.pull_id) ?? -1;
      const list = observationsByName.get(row.player_name);
      const observation: PlayerPullSpecObservation = {
        className: row.class,
        spec: row.spec,
        orderIndex,
      };
      if (list) list.push(observation);
      else observationsByName.set(row.player_name, [observation]);
    }

    return [...observationsByName.entries()]
      .map(([name, observations]) => ({ name, ...resolveNightPlayerIdentity(observations) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Catálogo de reports para el navegador de histórico (§16: "history/ -- navegador de raids/pulls pasados"). */
  async listAllReports(): Promise<{ report: ReportRow; bossesAttempted: string[] }[]> {
    const [{ data: reports, error: reportsErr }, { data: encounters, error: encountersErr }] =
      await Promise.all([
        this.supabase.client.from('reports').select('*').order('start_time', { ascending: false }),
        this.supabase.client.from('report_encounters').select('report_code,boss_name'),
      ]);
    if (reportsErr) throw reportsErr;
    if (encountersErr) throw encountersErr;
    return joinReportsWithBosses(
      (reports ?? []) as ReportRow[],
      (encounters ?? []) as { report_code: string; boss_name: string }[],
    );
  }

  /**
   * §PR4 del plan IRIS (Report Workspace): versión ligera de listAllReports()
   * para el selector de noches del sidebar — "Recientes" no necesita cargar
   * TODA la tabla de reports ni TODOS los report_encounters para enseñar
   * solo las últimas `limit` noches; el `.in(codes)` sobre encounters queda
   * acotado a esos pocos reports, no a toda la temporada.
   */
  async listRecentReports(
    limit: number,
  ): Promise<{ report: ReportRow; bossesAttempted: string[] }[]> {
    const { data: reports, error: reportsErr } = await this.supabase.client
      .from('reports')
      .select('*')
      .order('start_time', { ascending: false })
      .limit(limit);
    if (reportsErr) throw reportsErr;
    const codes = ((reports ?? []) as ReportRow[]).map((r) => r.code);
    if (!codes.length) return [];
    const { data: encounters, error: encountersErr } = await this.supabase.client
      .from('report_encounters')
      .select('report_code,boss_name')
      .in('report_code', codes);
    if (encountersErr) throw encountersErr;
    return joinReportsWithBosses(
      reports as ReportRow[],
      (encounters ?? []) as { report_code: string; boss_name: string }[],
    );
  }

  /** Todos los bosses vistos alguna vez en algún report sincronizado — alimenta el desplegable del manifiesto (§5, tarea manual #1) sin teclear nada. */
  // §9.1: la lista completa de bosses de la season (known_raid_bosses, ver
  // sync-season-bosses) SIEMPRE gana como base — así un boss nunca pulleado
  // sigue apareciendo. report_encounters solo aporta qué dificultades se han
  // visto de verdad. Sin sincronizar la season todavía, se degrada
  // limpiamente a la lista de antes (solo lo visto en vuestros reports).
  async listKnownBosses(): Promise<KnownBoss[]> {
    const [catalogRes, encountersRes] = await Promise.all([
      this.supabase.client
        .from('known_raid_bosses')
        .select('encounter_id,boss_name,order_index,journal_encounter_id,blizzard_zone_id')
        .order('order_index', { ascending: true }),
      this.supabase.client
        .from('report_encounters')
        .select('encounter_id,boss_name,wcl_difficulty_id'),
    ]);
    if (catalogRes.error) throw catalogRes.error;
    if (encountersRes.error) throw encountersRes.error;

    const byEncounter = new Map<number, KnownBoss>();
    for (const row of (catalogRes.data ?? []) as {
      encounter_id: number;
      boss_name: string;
      order_index: number | null;
      journal_encounter_id: number | null;
      blizzard_zone_id: number | null;
    }[]) {
      byEncounter.set(row.encounter_id, {
        encounterId: row.encounter_id,
        bossName: row.boss_name,
        difficulties: [],
        hasRealPulls: false,
        orderIndex: row.order_index,
        journalEncounterId: row.journal_encounter_id,
        blizzardZoneId: row.blizzard_zone_id,
      });
    }
    for (const row of (encountersRes.data ?? []) as Pick<
      ReportEncounterRow,
      'encounter_id' | 'boss_name' | 'wcl_difficulty_id'
    >[]) {
      let entry = byEncounter.get(row.encounter_id);
      if (!entry) {
        entry = {
          encounterId: row.encounter_id,
          bossName: row.boss_name,
          difficulties: [],
          hasRealPulls: true,
          orderIndex: null,
          journalEncounterId: null,
          blizzardZoneId: null,
        };
        byEncounter.set(row.encounter_id, entry);
      }
      entry.hasRealPulls = true;
      if (row.wcl_difficulty_id != null && !entry.difficulties.includes(row.wcl_difficulty_id)) {
        entry.difficulties.push(row.wcl_difficulty_id);
      }
    }
    return [...byEncounter.values()].sort(
      (a, b) => (a.orderIndex ?? 99) - (b.orderIndex ?? 99) || a.bossName.localeCompare(b.bossName),
    );
  }

  // §"quitar la card de progreso de temporada de portada y ponerlo en la
  // cabecera... recuerda que el progreso va por dificultad" (feedback
  // real): la versión anterior colapsaba "matado" a CUALQUIER dificultad —
  // contrastado en real que eso miente (Normal 8/8 y Heroic 3/8 a la vez se
  // habrían mostrado como un solo "8/8" engañoso, dando el clear por hecho
  // en Heroic). "Matado" sigue siendo wipe_pct=0 (pulls.kill no existe como
  // columna, mismo fallback de siempre), pero agrupado por pulls.difficulty
  // — el total de bosses es el mismo para las 4 dificultades (misma
  // instancia), solo cambia cuántos están matados en cada una. Solo se
  // devuelven las dificultades con AL MENOS un pull real (ni LFR ni Mythic
  // tenían ninguno en real todavía) — así el hueco aparece solo se cuando
  // de verdad se empieza a intentar, no como un "0/8" permanente sin dato.
  async getSeasonProgress(): Promise<{
    total: number;
    byDifficulty: { difficulty: string; killed: number }[];
  }> {
    const [bossesRes, pullsRes] = await Promise.all([
      this.supabase.client.from('known_raid_bosses').select('encounter_id'),
      this.supabase.client.from('pulls').select('boss_id,difficulty,wipe_pct'),
    ]);
    if (bossesRes.error) throw bossesRes.error;
    if (pullsRes.error) throw pullsRes.error;
    const total = new Set(
      (bossesRes.data ?? []).map((r) => String((r as { encounter_id: number }).encounter_id)),
    ).size;
    const pulls = (pullsRes.data ?? []) as {
      boss_id: string;
      difficulty: string;
      wipe_pct: number | null;
    }[];
    const seenDifficulties = new Set<string>();
    const killedByDifficulty = new Map<string, Set<string>>();
    for (const p of pulls) {
      seenDifficulties.add(p.difficulty);
      if (p.wipe_pct === 0) {
        if (!killedByDifficulty.has(p.difficulty)) killedByDifficulty.set(p.difficulty, new Set());
        killedByDifficulty.get(p.difficulty)!.add(p.boss_id);
      }
    }
    const byDifficulty = STANDARD_DIFFICULTY_IDS.map((id) => WCL_DIFFICULTY_NAME_BY_ID[id])
      .filter((difficulty) => seenDifficulties.has(difficulty))
      .map((difficulty) => ({ difficulty, killed: killedByDifficulty.get(difficulty)?.size ?? 0 }));
    return { total, byDifficulty };
  }
}
