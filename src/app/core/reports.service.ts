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
  async listKnownBosses(): Promise<KnownBoss[]> {
    const { data, error } = await this.supabase.client
      .from('report_encounters')
      .select('encounter_id,boss_name,wcl_difficulty_id')
      .order('boss_name', { ascending: true });
    if (error) throw error;
    const byEncounter = new Map<number, KnownBoss>();
    for (const row of (data ?? []) as Pick<ReportEncounterRow, 'encounter_id' | 'boss_name' | 'wcl_difficulty_id'>[]) {
      let entry = byEncounter.get(row.encounter_id);
      if (!entry) {
        entry = { encounterId: row.encounter_id, bossName: row.boss_name, difficulties: [] };
        byEncounter.set(row.encounter_id, entry);
      }
      if (row.wcl_difficulty_id != null && !entry.difficulties.includes(row.wcl_difficulty_id)) {
        entry.difficulties.push(row.wcl_difficulty_id);
      }
    }
    return [...byEncounter.values()];
  }
}
