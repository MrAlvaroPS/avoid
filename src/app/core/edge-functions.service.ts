// Colocar en: src/app/core/edge-functions.service.ts
// Envoltorio fino de las 5 Edge Functions ya desplegadas. Sin JWT/usuario:
// este proyecto es de uso personal sin login, la anon key basta (RLS es
// lectura pública; las escrituras las hacen las funciones con service_role).
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { GenerateNightFullReportResult } from '../shared/models/night-full-report';

export interface AnalyzeReportResult {
  ok: true;
  processed: number;
  remaining: number;
  newestPullId: string | null;
  /** §"la noche duplicada... dos personas subieron el mismo log" (bug real, arreglado a mano): report_code de otro report ya importado que parece la misma sesión (inicio a ±6h, ≥2 bosses en común) — null = sin sospecha. Solo se calcula al crear el report, se repite igual en cada respuesta mientras exista. */
  possibleDuplicateOf: string | null;
}

export interface PullBriefRow {
  pull_id: string;
  headline: string;
  improved: string[];
  regressed: string[];
  next_pull_actions: string[];
  model: string;
}

export interface GeneratePullBriefResult {
  ok: true;
  cached: boolean;
  brief: PullBriefRow;
}

// §"meter en el dosier de un jugador y en el resumen de toda la noche
// completa también la consulta de IA" (feedback real): mismos campos que
// PullBriefRow, dos ámbitos nuevos — jugador×noche y raid×noche.
export interface NightPlayerBriefRow {
  report_code: string;
  player_name: string;
  headline: string;
  improved: string[];
  regressed: string[];
  next_pull_actions: string[];
  model: string;
}
export interface NightBriefRow {
  report_code: string;
  headline: string;
  improved: string[];
  regressed: string[];
  next_pull_actions: string[];
  model: string;
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

  /** §"copiar el prompt completo": el MISMO contexto que generatePullBrief construiría, listo para copiar y pegar en cualquier chat de LLM — no gasta presupuesto ni llama a Anthropic. */
  async getManualPullBriefPrompt(pullId: string): Promise<{ ok: true; systemPrompt: string; userMessage: string }> {
    return this.invoke('manual-pull-brief', { pullId, action: 'prompt' });
  }

  /** §"pegar el resultado... procesarlo como si fuese a través de la API": parsea el texto pegado con el MISMO parseo que la respuesta real, y lo guarda igual (pull_briefs, model:'manual'). */
  async submitManualPullBrief(pullId: string, rawResponseText: string): Promise<{ ok: true; brief: PullBriefRow }> {
    return this.invoke('manual-pull-brief', { pullId, action: 'submit', rawResponseText });
  }

  /** Genera (o devuelve cacheado) el brief LLM de un jugador para UNA noche concreta. Idempotente por report_code+player_name salvo force:true. */
  async generateNightPlayerBrief(reportCode: string, playerName: string, force = false): Promise<{ ok: true; cached: boolean; brief: NightPlayerBriefRow }> {
    return this.invoke('generate-night-player-brief', { reportCode, playerName, force });
  }
  async getManualNightPlayerBriefPrompt(reportCode: string, playerName: string): Promise<{ ok: true; systemPrompt: string; userMessage: string }> {
    return this.invoke('manual-night-player-brief', { reportCode, playerName, action: 'prompt' });
  }
  async submitManualNightPlayerBrief(reportCode: string, playerName: string, rawResponseText: string): Promise<{ ok: true; brief: NightPlayerBriefRow }> {
    return this.invoke('manual-night-player-brief', { reportCode, playerName, action: 'submit', rawResponseText });
  }

  /** Genera (o devuelve cacheado) el brief LLM de TODA una noche de raid. Idempotente por report_code salvo force:true. */
  async generateNightBrief(reportCode: string, force = false): Promise<{ ok: true; cached: boolean; brief: NightBriefRow }> {
    return this.invoke('generate-night-brief', { reportCode, force });
  }

  /** Genera o recalcula el informe determinista completo de una noche. No llama a ningún LLM. */
  async generateNightFullReport(reportCode: string, force = false): Promise<GenerateNightFullReportResult> {
    return this.invoke<GenerateNightFullReportResult>('generate-night-full-report', { reportCode, force });
  }
  async getManualNightBriefPrompt(reportCode: string): Promise<{ ok: true; systemPrompt: string; userMessage: string }> {
    return this.invoke('manual-night-brief', { reportCode, action: 'prompt' });
  }
  async submitManualNightBrief(reportCode: string, rawResponseText: string): Promise<{ ok: true; brief: NightBriefRow }> {
    return this.invoke('manual-night-brief', { reportCode, action: 'submit', rawResponseText });
  }

  /** §"que autoexcluya pero que permita también editarlo... para restaurar" — confirma o revierte la exclusión de un wipe call detectado. */
  async setWipeCallStatus(pullId: string, excluded: boolean): Promise<{ ok: true; pullId: string; excluded: boolean }> {
    return this.invoke('set-wipe-call-status', { pullId, excluded });
  }

  /** §"un prompt para pasar a la IA y que investigue... clasificar todas las mecánicas" — mismo patrón que manual-pull-brief, sin gastar la API propia. */
  async getMechanicClassificationPrompt(bossId: string, difficulty: string): Promise<{ ok: true; promptVersion: number; systemPrompt: string; userMessage: string; mechanicCount: number }> {
    return this.invoke('classify-mechanics', { bossId, difficulty, action: 'prompt' });
  }

  async submitMechanicClassification(
    bossId: string,
    difficulty: string,
    rawResponseText: string,
  ): Promise<{
    ok: true;
    applied: { abilityId: number; name: string; category: string }[];
    skippedLowConfidence: { abilityId: number; name: string; category: string | null; notes: string }[];
    skippedUndetermined: { abilityId: number; name: string }[];
    invalid: { abilityId: unknown; reason: string }[];
    resolutionsApplied: { abilityId: number; name: string; resolution: string }[];
    resolutionsSkipped: { abilityId: number; name: string; reason: string }[];
    resolutionContractMissing: boolean;
    responsibilitiesApplied: { abilityId: number; name: string; responsibility: string }[];
    responsibilitiesSkipped: { abilityId: number; name: string; reason: string }[];
    responsibilityContractMissing: boolean;
    avoidablesApplied: { abilityId: number; name: string; avoidable: boolean }[];
    avoidablesSkipped: { abilityId: number; name: string; reason: string }[];
    avoidableContractMissing: boolean;
  }> {
    return this.invoke('classify-mechanics', { bossId, difficulty, action: 'submit', rawResponseText });
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
    responsibility?: string | null;
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

  /** §9.1: siembra known_raid_bosses (+ boss_reference_stats) para TODA la instancia de una vez, aunque la guild no haya pulleado la mitad de los bosses todavía. Sin zoneId usa el del report más reciente. */
  async syncSeasonBosses(zoneId?: number): Promise<{
    ok: true;
    zoneId: number;
    zoneName: string;
    wclEncountersSeen: number;
    journalEncountersMatched: number;
    bossesSeeded: number;
    referenceStatsUpserts: number;
  }> {
    return this.invoke('sync-season-bosses', zoneId ? { zoneId } : {});
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
