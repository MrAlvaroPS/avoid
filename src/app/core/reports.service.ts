// Colocar en: src/app/core/reports.service.ts
// Lecturas directas a Supabase (RLS = lectura pública, no hace falta pasar
// por una Edge Function para esto). Alimenta el picker de pulls de la
// pantalla principal y el desplegable de bosses del manifiesto.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { PullRow, ReportEncounterRow, ReportRow } from '../shared/models/domain';

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
}

@Injectable({ providedIn: 'root' })
export class ReportsService {
  private supabase = inject(SupabaseService);

  async getReport(code: string): Promise<ReportRow | null> {
    const { data, error } = await this.supabase.client.from('reports').select('*').eq('code', code).maybeSingle();
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
      this.supabase.client.from('pulls').select('*').eq('report_code', code).order('fight_id', { ascending: true }),
      this.listEncounters(code),
    ]);
    if (pullsErr) throw pullsErr;
    const byFightId = new Map(encounters.map((e) => [e.fight_id, e]));
    return ((pulls ?? []) as PullRow[]).map((p) => {
      const enc = byFightId.get(p.fight_id);
      return { ...p, bossName: enc?.boss_name ?? `Boss ${p.boss_id}`, kill: enc?.kill ?? p.wipe_pct === 0 };
    });
  }

  /** §"un dosier de personaje de una noche concreta": quién participó en algún pull de este report — la lista de entrada al dosier por jugador desde el resumen de la noche. */
  async listNightPlayers(code: string): Promise<string[]> {
    const { data: pulls, error: pullsErr } = await this.supabase.client.from('pulls').select('id').eq('report_code', code);
    if (pullsErr) throw pullsErr;
    const pullIds = (pulls ?? []).map((p) => (p as { id: string }).id);
    if (!pullIds.length) return [];
    const { data, error } = await this.supabase.client.from('player_pull_records').select('player_name').in('pull_id', pullIds);
    if (error) throw error;
    return [...new Set((data ?? []).map((r) => (r as { player_name: string }).player_name))].sort((a, b) => a.localeCompare(b));
  }

  /** Catálogo de reports para el navegador de histórico (§16: "history/ -- navegador de raids/pulls pasados"). */
  async listAllReports(): Promise<{ report: ReportRow; bossesAttempted: string[] }[]> {
    const [{ data: reports, error: reportsErr }, { data: encounters, error: encountersErr }] = await Promise.all([
      this.supabase.client.from('reports').select('*').order('start_time', { ascending: false }),
      this.supabase.client.from('report_encounters').select('report_code,boss_name'),
    ]);
    if (reportsErr) throw reportsErr;
    if (encountersErr) throw encountersErr;

    const bossesByReport = new Map<string, Set<string>>();
    for (const e of (encounters ?? []) as { report_code: string; boss_name: string }[]) {
      if (!bossesByReport.has(e.report_code)) bossesByReport.set(e.report_code, new Set());
      bossesByReport.get(e.report_code)!.add(e.boss_name);
    }
    return ((reports ?? []) as ReportRow[]).map((report) => ({
      report,
      bossesAttempted: [...(bossesByReport.get(report.code) ?? [])],
    }));
  }

  /** Todos los bosses vistos alguna vez en algún report sincronizado — alimenta el desplegable del manifiesto (§5, tarea manual #1) sin teclear nada. */
  // §9.1: la lista completa de bosses de la season (known_raid_bosses, ver
  // sync-season-bosses) SIEMPRE gana como base — así un boss nunca pulleado
  // sigue apareciendo. report_encounters solo aporta qué dificultades se han
  // visto de verdad. Sin sincronizar la season todavía, se degrada
  // limpiamente a la lista de antes (solo lo visto en vuestros reports).
  async listKnownBosses(): Promise<KnownBoss[]> {
    const [catalogRes, encountersRes] = await Promise.all([
      this.supabase.client.from('known_raid_bosses').select('encounter_id,boss_name,order_index').order('order_index', { ascending: true }),
      this.supabase.client.from('report_encounters').select('encounter_id,boss_name,wcl_difficulty_id'),
    ]);
    if (catalogRes.error) throw catalogRes.error;
    if (encountersRes.error) throw encountersRes.error;

    const byEncounter = new Map<number, KnownBoss>();
    for (const row of (catalogRes.data ?? []) as { encounter_id: number; boss_name: string; order_index: number | null }[]) {
      byEncounter.set(row.encounter_id, { encounterId: row.encounter_id, bossName: row.boss_name, difficulties: [], hasRealPulls: false, orderIndex: row.order_index });
    }
    for (const row of (encountersRes.data ?? []) as Pick<ReportEncounterRow, 'encounter_id' | 'boss_name' | 'wcl_difficulty_id'>[]) {
      let entry = byEncounter.get(row.encounter_id);
      if (!entry) {
        entry = { encounterId: row.encounter_id, bossName: row.boss_name, difficulties: [], hasRealPulls: true, orderIndex: null };
        byEncounter.set(row.encounter_id, entry);
      }
      entry.hasRealPulls = true;
      if (row.wcl_difficulty_id != null && !entry.difficulties.includes(row.wcl_difficulty_id)) {
        entry.difficulties.push(row.wcl_difficulty_id);
      }
    }
    return [...byEncounter.values()].sort((a, b) => (a.orderIndex ?? 99) - (b.orderIndex ?? 99) || a.bossName.localeCompare(b.bossName));
  }

  /** §7.3: bosses matados / totales de la temporada — antes bloqueado por no tener "todos los bosses" en ningún sitio, known_raid_bosses (§9.1) ya lo da. "Matado" = algún pull con wipe_pct=0 en CUALQUIER dificultad (pulls.kill no existe como columna — mismo fallback que ya usa listPulls cuando report_encounters.kill no está disponible), no distingue dificultad (el desglose por dificultad ya vive en el picker de pulls). */
  async getSeasonProgress(): Promise<{ killed: number; total: number }> {
    const [bossesRes, killsRes] = await Promise.all([
      this.supabase.client.from('known_raid_bosses').select('encounter_id'),
      this.supabase.client.from('pulls').select('boss_id').eq('wipe_pct', 0),
    ]);
    if (bossesRes.error) throw bossesRes.error;
    if (killsRes.error) throw killsRes.error;
    const total = new Set((bossesRes.data ?? []).map((r) => String((r as { encounter_id: number }).encounter_id))).size;
    const killed = new Set((killsRes.data ?? []).map((r) => String((r as { boss_id: string }).boss_id))).size;
    return { killed, total };
  }
}
