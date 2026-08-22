// Colocar en: src/app/core/edge-functions.service.ts
// Envoltorio fino de las 5 Edge Functions ya desplegadas. Sin JWT/usuario:
// este proyecto es de uso personal sin login, la anon key basta (RLS es
// lectura pública; las escrituras las hacen las funciones con service_role).
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';

export interface AnalyzeReportResult {
  ok: true;
  processed: number;
  remaining: number;
  newestPullId: string | null;
}

export interface GeneratePullBriefResult {
  ok: true;
  cached: boolean;
  brief: {
    pull_id: string;
    headline: string;
    improved: string[];
    regressed: string[];
    next_pull_actions: string[];
    model: string;
  };
}

export interface SyncBossMechanicsResult {
  ok: true;
  bossName: string;
  journalEncounterId: number;
  candidates: number;
  upserts: number;
  difficulties: { difficulty: string; mappingStatus: string; db2DifficultyId: number | null; abilities: number }[];
}

export interface SyncReportsResult {
  ok: true;
  reportsScanned: number;
  reportsUpserted: number;
  encountersUpserted: number;
  skippedNonRaid: number;
  remaining: number;
}

@Injectable({ providedIn: 'root' })
export class EdgeFunctionsService {
  private supabase = inject(SupabaseService);

  /** Trae fights nuevos de un report y genera pulls/player_pull_records/pull_mechanic_events. Idempotente: reintentar no duplica (avanza por last_processed_fight_id). */
  async analyzeReport(reportCode: string, maxFights = 5): Promise<AnalyzeReportResult> {
    return this.invoke<AnalyzeReportResult>('analyze-report', { reportCode, maxFights });
  }

  /** Llama analyzeReport en bucle hasta que remaining llega a 0. Devuelve el pull_id más reciente que haya quedado procesado. */
  async analyzeReportFully(reportCode: string, onProgress?: (r: AnalyzeReportResult) => void): Promise<string | null> {
    let newestPullId: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const result = await this.analyzeReport(reportCode);
      onProgress?.(result);
      if (result.newestPullId) newestPullId = result.newestPullId;
      if (result.remaining <= 0) break;
    }
    return newestPullId;
  }

  /** Genera (o devuelve cacheado) el brief LLM de un pull. Idempotente por pull_id salvo force:true. */
  async generatePullBrief(pullId: string, force = false): Promise<GeneratePullBriefResult> {
    return this.invoke<GeneratePullBriefResult>('generate-pull-brief', { pullId, force });
  }

  /**
   * Auto-descubre mecánicas de un boss (Blizzard Journal + Wago DB2) sin
   * pisar ediciones humanas previas. `deepSync` cambia de 3 a 20 los logs
   * públicos de referencia usados para inferir categoría/percentil — mucha
   * más señal real, tarda más (~35s verificado en real, contra ~15s del
   * sync normal).
   */
  async syncBossMechanics(bossId: string, difficulties?: number[], deepSync = false): Promise<SyncBossMechanicsResult> {
    return this.invoke<SyncBossMechanicsResult>('sync-boss-mechanics', { bossId, difficulties, deepSync });
  }

  /** Persiste una edición humana de una mecánica candidata (categoría, avoidable, umbral...). */
  async saveMechanicEdit(edit: {
    bossId: string;
    difficulty: string;
    abilityId: number;
    category?: string | null;
    avoidable?: boolean | null;
    expectedResponse?: { type: string; scope: string } | null;
    severityThreshold?: number | null;
    reviewed?: boolean;
  }): Promise<{ ok: true }> {
    return this.invoke('save-mechanic-edit', edit);
  }

  /** Barrido del histórico de reports de la guild — puebla reports/report_encounters sin pegar cada código a mano. */
  async syncReports(params: { guildName: string; serverSlug: string; serverRegion: string; sinceMs?: number }): Promise<SyncReportsResult> {
    return this.invoke<SyncReportsResult>('sync-reports', params);
  }

  private async invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.supabase.client.functions.invoke(fn, { body });
    if (error) throw await describeFunctionError(error);
    if (data && typeof data === 'object' && 'ok' in data && !(data as { ok: boolean }).ok) {
      throw new Error((data as { error?: string }).error ?? `${fn} falló sin detalle`);
    }
    return data as T;
  }
}

/**
 * Cuando una Edge Function responde con un HTTP no-2xx (ej. 500 del guard de
 * §14), supabase-js lanza un FunctionsHttpError genérico ("Edge Function
 * returned a non-2xx status code") y descarta el cuerpo — que es justo donde
 * está el mensaje real (`{ ok: false, error: "..." }`). El cuerpo original
 * sigue accesible en `error.context` (el Response crudo del fetch), así que
 * se relee de ahí antes de rendirse al mensaje genérico.
 */
async function describeFunctionError(error: unknown): Promise<Error> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      if (body?.error) return new Error(body.error);
    } catch {
      // el cuerpo no era JSON (ej. un 502 de la propia infraestructura) — se cae al mensaje genérico de abajo
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
