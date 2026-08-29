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
  difficulties: {
    difficulty: string;
    mappingStatus: string;
    db2DifficultyId: number | null;
    abilities: number;
    /** Nº de logs públicos de referencia contrastados de verdad — 0 no siempre es "sin muestra pública", puede ser referenceFetchError (ver ese campo). */
    referenceBundleCount?: number;
    /** Non-null si el contraste de referencia falló para esta dificultad (best-effort — el resto del sync sigue igual) — normalmente rate limit de WCL bajo carga (varias dificultades seguidas). */
    referenceFetchError?: string | null;
    /** Non-null si Wago DB2 (mapeo oficial de dificultad) falló para este boss — mappingStatus cae a "difficulty-metadata-unavailable" sin más explicación si no se muestra este campo. */
    snapshotFetchError?: string | null;
  }[];
}

export interface DiscordRosterLink {
  character_id: number;
  character_name: string;
  discord_user_id: string;
  discord_display_name: string | null;
  discord_channel_id: string | null;
  is_officer: boolean;
  linked_at: string;
  channel_synced_at: string | null;
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

  /**
   * §"dejar preparada una capa para interactuar en discord para enviar la
   * infografía directamente a discord" (feedback real): REST directo
   * (POST /channels/{id}/messages con el bot token), sin gateway — el
   * servidor comprueba que el canal pertenece al guild autorizado antes de
   * publicar nada (ver send-discord-message/index.ts).
   */
  async sendDiscordMessage(params: { channelId: string; content?: string; imageBase64?: string; imageFilename?: string }): Promise<{ ok: true; messageId: string; channelName: string | null }> {
    return this.invoke('send-discord-message', params);
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

  /** §"un ninja pull... habría que clasificarlo de otra manera" — confirma o revierte la exclusión de un ninja pull detectado. Mismo patrón que setWipeCallStatus. */
  async setNinjaPullStatus(pullId: string, excluded: boolean): Promise<{ ok: true; pullId: string; excluded: boolean }> {
    return this.invoke('set-ninja-pull-status', { pullId, excluded });
  }

  /**
   * §"Hay que ver la manera de centralizar esta información y, sobretodo,
   * en hacerla fiable" (feedback real, 2026-08-28): vuelve a pedir a WCL
   * las muertes/sanación/daño de un pull YA analizado y recalcula su
   * veredicto de wipe call con el algoritmo actual — para cuando el
   * algoritmo cambia y un pull antiguo quedó mal clasificado (caso real:
   * Pandokie, ver reanalyze-wipe-call/index.ts). No toca nada más del pull.
   */
  async reanalyzeWipeCall(pullId: string): Promise<{
    ok: true;
    pullId: string;
    before: { confidence: number | null; excluded: boolean };
    after: { confidence: number | null; excluded: boolean; signals: Record<string, number | boolean | null> | null };
    excludedDecisionPreserved: boolean;
    clusterChanges: { playerName: string; before: boolean; after: boolean }[];
  }> {
    return this.invoke('reanalyze-wipe-call', { pullId });
  }

  /** §"un prompt para pasar a la IA y que investigue... clasificar todas las mecánicas" — mismo patrón que manual-pull-brief, sin gastar la API propia. */
  // difficulties=undefined/[] => todas las dificultades que tengan
  // candidatas para este boss en un único prompt (feedback real,
  // 2026-08-27: "el prompt de mecánicas de bosses no puede consultar las 4
  // dificultades a la vez... asegurando la calidad de datos obviamente") —
  // mismo criterio que getDefensiveClassificationPrompt(null), pero aquí
  // cada fila de la lista sigue llevando su propia difficulty (a diferencia
  // de defensivos, el mismo abilityId SÍ se repite una vez por dificultad).
  async getMechanicClassificationPrompt(bossId: string, difficulties?: string[]): Promise<{ ok: true; promptVersion: number; systemPrompt: string; userMessage: string; mechanicCount: number }> {
    return this.invoke('classify-mechanics', { bossId, difficulties, action: 'prompt' });
  }

  async submitMechanicClassification(
    bossId: string,
    difficulties: string[] | undefined,
    rawResponseText: string,
  ): Promise<{
    ok: true;
    applied: { abilityId: number; difficulty: string; name: string; category: string }[];
    skippedLowConfidence: { abilityId: number; difficulty: string; name: string; category: string | null; notes: string }[];
    skippedUndetermined: { abilityId: number; difficulty: string; name: string }[];
    invalid: { abilityId: unknown; difficulty: unknown; reason: string }[];
    resolutionsApplied: { abilityId: number; difficulty: string; name: string; resolution: string }[];
    resolutionsSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[];
    resolutionContractMissing: boolean;
    responsibilitiesApplied: { abilityId: number; difficulty: string; name: string; responsibility: string }[];
    responsibilitiesSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[];
    responsibilityContractMissing: boolean;
    avoidablesApplied: { abilityId: number; difficulty: string; name: string; avoidable: boolean }[];
    avoidablesSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[];
    avoidableContractMissing: boolean;
  }> {
    return this.invoke('classify-mechanics', { bossId, difficulties, action: 'submit', rawResponseText });
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

  /** §"pantalla nueva para clasificar defensivos... parecida a la de mecánicas" — mismo patrón de prompt/pegar-respuesta que classify-mechanics, acotado a una clase. */
  // className=null => catálogo entero (todas las clases en un único prompt,
  // feedback real: "la cantidad de habilidades defensivas no es
  // desorbitante... un único prompt que clasifique todas las specs a la vez").
  async getDefensiveClassificationPrompt(className: string | null): Promise<{ ok: true; promptVersion: number; systemPrompt: string; userMessage: string; defensiveCount: number }> {
    return this.invoke('classify-defensives', { class: className, action: 'prompt' });
  }

  async submitDefensiveClassification(
    className: string | null,
    rawResponseText: string,
  ): Promise<{
    ok: true;
    applied: { spellId: number; name: string; survivalType: string }[];
    skippedLowConfidence: { spellId: number; name: string; survivalType: string | null; notes: string }[];
    skippedUndetermined: { spellId: number; name: string }[];
    invalid: { spellId: unknown; reason: string }[];
  }> {
    return this.invoke('classify-defensives', { class: className, action: 'submit', rawResponseText });
  }

  /**
   * Persiste una edición humana de un defensivo del catálogo (survival_type,
   * cooldown/duración en ms, revisado). §"se calculan de nuevo... sale lo
   * mismo en todos lados" (feedback real, 2026-08-29): al tocar cooldown/
   * duración, defensive_pressure_windows de cada pull con algún jugador de
   * esta clase queda desactualizado (se calculó con el CD/duración viejos) —
   * pullIds es la lista completa a reanalizar.
   *
   * §bug real en producción (2026-08-29, verificado con Fortifying Brew/47
   * pulls de Monk): reanalizarlos todos DENTRO de esta misma llamada (o
   * encadenando invocaciones en el propio backend) agotaba la cuota de CPU
   * del edge function (WORKER_RESOURCE_LIMIT) y la respuesta nunca llegaba.
   * Por eso esta función ya NO reanaliza nada — solo devuelve la lista, y es
   * quien la llama (ver reanalyzeDefensivePressure más abajo, usado en
   * defensive-catalog.component.ts) quien la recorre en secuencia.
   */
  async saveDefensiveEdit(edit: {
    class: string;
    spellId: number;
    survivalType?: string | null;
    reviewed?: boolean;
    baseCooldownMs?: number | null;
    baseDurationMs?: number | null;
  }): Promise<{ ok: true; pullIds?: string[] }> {
    return this.invoke('save-defensive-edit', edit);
  }

  /**
   * Recalcula defensive_pressure_windows de UN pull ya importado contra el
   * catálogo/talentos actuales — mismo patrón que reanalyzeWipeCall, pero
   * para la ventana de presión defensiva (ver reanalyze-defensive-pressure/
   * index.ts). Se llama una vez por pull, en secuencia, desde
   * defensive-catalog.component.ts tras editar un cooldown/duración —
   * nunca en bucle dentro de un edge function (ver saveDefensiveEdit).
   */
  async reanalyzeDefensivePressure(pullId: string): Promise<{ ok: true; pullId: string; updated: number; skipped: number }> {
    return this.invoke('reanalyze-defensive-pressure', { pullId });
  }

  /**
   * §"UI en Ajustes para gestionar el catálogo a mano" (feedback real,
   * 2026-08-29): recalcula unassigned_mechanic_occurrences de UN pull ya
   * importado contra el catálogo actual — mismo patrón que
   * reanalyzeDefensivePressure, llamado en secuencia (nunca en bucle server-
   * side) tras editar una fila desde unassigned-mechanics-catalog.component.ts.
   */
  async reanalyzeUnassignedMechanics(pullId: string): Promise<{
    ok: true;
    pullId: string;
    skipped?: boolean;
    reason?: string;
    catalogSize?: number;
    before?: number;
    after?: number;
  }> {
    return this.invoke('reanalyze-unassigned-mechanics', { pullId });
  }

  /** Crear/editar/borrar una fila de unassigned_mechanic_catalog — única puerta de escritura (RLS de solo-lectura en la tabla, ver migración 20260829080000). `pullIds` viene relleno solo si el campo tocado afecta a la detección (ver save-unassigned-mechanic-edit/index.ts), para poder reanalizar en secuencia igual que saveDefensiveEdit. */
  async saveUnassignedMechanicEdit(edit: {
    id?: string;
    delete?: boolean;
    bossId?: string;
    difficulty?: string;
    name?: string;
    detectionType?: 'cast' | 'debuff_applied' | 'buff_applied' | 'npc_interaction';
    abilityId?: number | null;
    actorNamePattern?: string | null;
    appliedBy?: 'npc' | 'self' | null;
    eligibleRoles?: string[] | null;
    consequenceAbilityId?: number | null;
    hasConfirmedDetection?: boolean;
    reviewed?: boolean;
    aiConfidence?: string | null;
    aiNotes?: string | null;
  }): Promise<{ ok: true; id?: string; pullIds: string[] }> {
    return this.invoke('save-unassigned-mechanic-edit', edit);
  }

  /** Barrido del histórico de reports de la guild — puebla reports/report_encounters sin pegar cada código a mano. */
  async syncReports(params: { guildName: string; serverSlug: string; serverRegion: string; sinceMs?: number }): Promise<SyncReportsResult> {
    return this.invoke<SyncReportsResult>('sync-reports', params);
  }

  // §"un botón de sincronizar para traer los datos de wowaudit actualizados"
  // (feedback real, 2026-08-28): wowaudit_roster (rango Main/Trial, rol,
  // asistencia — de donde sale la tabla de Ajustes→Discord y buena parte de
  // fiabilidad) se pobló UNA vez a mano al construir la función y nunca más
  // — comprobado empíricamente: las 30 filas compartían el mismo synced_at
  // de hace 5 días. Sin botón, un ascenso Trial→Main hecho en wowaudit no
  // llega a esta app hasta el próximo log importado (analyze-report no
  // toca esta tabla) o hasta que alguien lo dispare a mano por API.
  async syncWowauditRoster(): Promise<{ ok: true; charactersSynced: number }> {
    return this.invoke('sync-wowaudit-roster', {});
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

  /**
   * §"un bot que crea canales privados dentro de una categoría... solo para
   * rango Raider, ni trial ni oficial. Esas personas concretas las podemos
   * traer de wowaudit" (feedback real, 2026-08-28): una función, varias
   * `action` — mismo patrón que classify-mechanics/manual-pull-brief.
   * WoWAudit no expone Discord ID (comprobado empíricamente), así que la
   * vinculación personaje↔Discord es manual (saveDiscordRosterLink).
   */
  async getDiscordRosterConfig(): Promise<{
    ok: true;
    guildId: string;
    settings: { category_id: string | null; officers_role_id: string | null };
    links: DiscordRosterLink[];
    roster: { character_id: number; name: string; rank: string }[];
  }> {
    return this.invoke('discord-roster-channels', { action: 'get-config' });
  }

  async listDiscordCategories(): Promise<{ ok: true; categories: { id: string; name: string }[] }> {
    return this.invoke('discord-roster-channels', { action: 'list-guild-categories' });
  }

  async listDiscordRoles(): Promise<{ ok: true; roles: { id: string; name: string }[] }> {
    return this.invoke('discord-roster-channels', { action: 'list-guild-roles' });
  }

  async saveDiscordRosterConfig(categoryId: string, officersRoleId: string): Promise<{ ok: true }> {
    return this.invoke('discord-roster-channels', { action: 'save-config', categoryId, officersRoleId });
  }

  /** Pega el Discord User ID (número largo, con el modo desarrollador de Discord activado: clic derecho sobre la persona → Copiar ID de usuario). */
  async saveDiscordRosterLink(characterId: number, characterName: string, discordUserId: string): Promise<{ ok: true; displayName: string; isOfficer: boolean }> {
    return this.invoke('discord-roster-channels', { action: 'save-link', characterId, characterName, discordUserId });
  }

  /** Desvincula y borra el canal de Discord (si existe) ya mismo, sin esperar a la próxima sincronización. */
  async removeDiscordRosterLink(characterId: number): Promise<{ ok: true }> {
    return this.invoke('discord-roster-channels', { action: 'remove-link', characterId });
  }

  /** Reconciliación: crea/actualiza/borra canales para que Discord refleje el roster (rank=Main, sin el rol de Oficiales) tal cual está AHORA. Idempotente. */
  async syncDiscordRosterChannels(): Promise<{ ok: true; created: string[]; updated: string[]; deleted: string[]; unlinked: string[]; skippedNoDiscordMember: string[] }> {
    return this.invoke('discord-roster-channels', { action: 'sync' });
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
