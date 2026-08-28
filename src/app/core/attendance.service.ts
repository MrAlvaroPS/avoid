// Colocar en: src/app/core/attendance.service.ts
// §"la asistencia en el roster sigue saliendo rara... yo soy Pandokie y pone
// 50% cuando solo hemos raideado una vez" (feedback real, investigado a
// fondo contra la API real de wowaudit): attended_percentage de wowaudit
// SÍ es correcto para lo que wowaudit calcula — pero calcula sobre SU
// PROPIO calendario de eventos programados/firmas (verificado: Pandokie
// tenía 2/4 según wowaudit — 4 eventos programados en su calendario, no 4
// noches de raid reales), no sobre "noches en las que de verdad se raideó".
// Esta asistencia es otra cosa, deliberadamente más simple y más honesta
// para este uso: de los reports YA IMPORTADOS EN AVOID desde que empezó la
// season, ¿en cuántos aparece este jugador? Sin ambigüedad de firmas,
// cancelaciones o calendario — datos reales de WCL, la misma fuente de
// verdad que ya usa todo el resto de la app.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';

export interface RealAttendanceEntry {
  attended: number;
  total: number;
  pct: number | null;
}

@Injectable({ providedIn: 'root' })
export class AttendanceService {
  private supabase = inject(SupabaseService);

  async getSeasonStartDate(): Promise<string | null> {
    const { data } = await this.supabase.client.from('wowaudit_season').select('start_date').maybeSingle();
    return (data as { start_date: string } | null)?.start_date ?? null;
  }

  /**
   * Map keyed por player_name — solo trae entradas de jugadores que
   * aparecen en al menos un report desde el inicio de season.
   *
   * §bug real encontrado verificando esto contra datos reales: la noche del
   * 19 de agosto quedó guardada como DOS reports distintos
   * ("qtK3xYXRFkfdan6M" y "ZYKJhgnCmaxz6LVr", mismos bosses, mismo orden,
   * inicios a 3 minutos de diferencia) — dos personas subieron el log de la
   * MISMA noche con dos clientes distintos. Contar por report_code habría
   * vuelto a romper la asistencia exactamente igual que el bug original que
   * se estaba arreglando (una noche real contando como 2, cualquiera
   * presente en un solo upload de los dos sale como "ausente" de la otra
   * mitad). Se cuenta por FECHA (UTC) del report, no por report_code — dos
   * uploads del mismo día son la misma noche.
   */
  async listRealAttendance(): Promise<Map<string, RealAttendanceEntry>> {
    const seasonStart = await this.getSeasonStartDate();
    if (!seasonStart) return new Map(); // sin sync de wowaudit todavía — sin fecha de corte, no se puede acotar a "la season actual"
    const seasonStartMs = new Date(seasonStart).getTime();

    const { data: reportsData, error: reportsErr } = await this.supabase.client.from('reports').select('code, start_time').gte('start_time', seasonStartMs);
    if (reportsErr) throw reportsErr;
    const reportRows = (reportsData ?? []) as { code: string; start_time: number }[];
    if (!reportRows.length) return new Map();

    const dateByCode = new Map(reportRows.map((r) => [r.code, new Date(r.start_time).toISOString().slice(0, 10)]));
    const nights = new Set(dateByCode.values());
    const total = nights.size;

    const { data: recordsData, error: recordsErr } = await this.supabase.client
      .from('player_pull_records')
      .select('player_name, pulls!inner(report_code)')
      .in(
        'pulls.report_code',
        [...dateByCode.keys()],
      );
    if (recordsErr) throw recordsErr;

    const attendedByPlayer = new Map<string, Set<string>>();
    for (const row of (recordsData ?? []) as unknown as { player_name: string; pulls: { report_code: string } }[]) {
      const night = dateByCode.get(row.pulls.report_code);
      if (!night) continue;
      if (!attendedByPlayer.has(row.player_name)) attendedByPlayer.set(row.player_name, new Set());
      attendedByPlayer.get(row.player_name)!.add(night);
    }

    const result = new Map<string, RealAttendanceEntry>();
    for (const [name, attendedNights] of attendedByPlayer) {
      result.set(name, { attended: attendedNights.size, total, pct: Math.round((attendedNights.size / total) * 1000) / 10 });
    }
    return result;
  }

  /**
   * §rendimiento (2026-08-29): misma fórmula que listRealAttendance (noches
   * reales distintas por FECHA, no por report_code), pero el escaneo de
   * player_pull_records queda acotado a UN jugador — listRealAttendance trae
   * esa tabla para TODA la guild, útil para el Roster (§12) pero
   * desproporcionado cuando el dosier de un jugador (night-player-summary.
   * service.ts) solo necesita attended/total de una persona concreta.
   */
  async getPlayerRealAttendance(playerName: string): Promise<RealAttendanceEntry | null> {
    const seasonStart = await this.getSeasonStartDate();
    if (!seasonStart) return null;
    const seasonStartMs = new Date(seasonStart).getTime();

    const { data: reportsData, error: reportsErr } = await this.supabase.client.from('reports').select('code, start_time').gte('start_time', seasonStartMs);
    if (reportsErr) throw reportsErr;
    const reportRows = (reportsData ?? []) as { code: string; start_time: number }[];
    if (!reportRows.length) return null;

    const dateByCode = new Map(reportRows.map((r) => [r.code, new Date(r.start_time).toISOString().slice(0, 10)]));
    const total = new Set(dateByCode.values()).size;

    const { data: recordsData, error: recordsErr } = await this.supabase.client
      .from('player_pull_records')
      .select('pulls!inner(report_code)')
      .eq('player_name', playerName)
      .in('pulls.report_code', [...dateByCode.keys()]);
    if (recordsErr) throw recordsErr;

    const attendedNights = new Set<string>();
    for (const row of (recordsData ?? []) as unknown as { pulls: { report_code: string } }[]) {
      const night = dateByCode.get(row.pulls.report_code);
      if (night) attendedNights.add(night);
    }
    return {
      attended: attendedNights.size,
      total,
      pct: total > 0 ? Math.round((attendedNights.size / total) * 1000) / 10 : null,
    };
  }
}
