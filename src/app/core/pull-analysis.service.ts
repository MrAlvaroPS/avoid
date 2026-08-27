// Colocar en: src/app/core/pull-analysis.service.ts
// El motor de comparación pull-a-pull (§13 de la hoja de ruta), pero
// calculado al vuelo en el cliente en vez de cacheado en una tabla
// `pull_diffs`: el esquema real (schema.sql) no la tiene, y comparar 2-3
// pulls pequeños (unas pocas filas de player_pull_records/pull_mechanic_events
// cada uno) es barato — no hace falta persistir el resultado. Si con el
// tiempo esto se nota lento, el sitio natural para cachearlo es una tabla
// nueva con la misma forma; no cambia nada de esta lógica, solo dónde vive.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { EdgeFunctionsService } from './edge-functions.service';
import { WowauditRosterService } from './wowaudit-roster.service';
import { BossPhaseService } from './boss-phase.service';
import { formatDuration, formatPct, formatPhaseReached, formatTimeLabel, mechanicCategoryMeta, mechanicDisplayName, normalizeDifficulty } from '../shared/format.util';
import type { BossReferenceStatsRow, DefensiveOption, PlayerPullRecordRow, PullBriefRow, PullMechanicEventRow, PullRow, ReportEncounterRow } from '../shared/models/domain';
import type { CoachingCallout, LlmPullAnalysis, MechanicFailRow, MetricCardData, PullDifficulty, PullResult, ReferencePacing, TimelineChip } from '../shared/models/ui';
import type { DonutSegment } from '../shared/charts/donut-chart.component';
import type { TrendBar } from '../shared/charts/trend-bars.component';
import { isDeathExcludedFromStatistics, isMechanicExcludedByWipeCall } from '../shared/death-statistics.util';
import { withSupabaseRelationFallback } from '../shared/supabase-query.util';

export interface PullHeaderData {
  encounterName: string;
  difficulty: PullDifficulty;
  attemptNumber: number;
  durationLabel: string;
  /** Mismo dato que durationLabel pero en ms crudos — hace falta para fijar el dominio del eje X de la gráfica de daño, no solo para leerlo en texto. Null en pulls sin duration_ms (no debería pasar en la práctica, pero WCL es la fuente y a veces no llega). */
  durationMs: number | null;
  bossHpRemainingPct: number;
  result: PullResult;
  /** Ritmo contra el mejor kill público (boss_reference_stats) — null si no hay benchmark todavía. */
  referencePacing: ReferencePacing | null;
  /** §"fases de encuentro... en todos los sitios donde corresponda" (feedback real): "Fase X/N — Nombre", null si el boss no tiene fases o el pull no las trajo. */
  phaseLabel: string | null;
}

export interface PlayerStatRow {
  playerName: string;
  died: boolean;
  class: string | null;
  spec: string | null;
  /** §"todo el roster de todas las pantallas... tiene que ser el oficial de wowaudit": null = no cruza con el roster de wowaudit (nombre distinto, o sin sincronizar todavía). */
  role: 'Tank' | 'Heal' | 'Melee' | 'Ranged' | null;
  dps: number;
  hps: number;
  absorbedDamageTaken: number;
  /** §3.1/§7.1: percentil real de WCL contra el mundo, misma clase/spec, este boss+dificultad. Null si WCL no pudo rankear este pull (log privado, boss no rankeable todavía...). */
  worldRankPercent: number | null;
  worldTotalParses: number | null;
  /** Solo los talentos con spellId resuelto (cruce TraitNodeEntry/TraitDefinition en analyze-report) — se pintan como iconos con tooltip de Wowhead, sin texto (el ID en pantalla no dice nada a nadie). */
  talents: { spellId: number; rank: number }[];
  /** Nodos elegidos que NO se pudieron resolver a un spellId (p.ej. algunos nodos de elección sin definición directa) — se cuentan en vez de ocultarse sin más, para no dar la sensación de un build incompleto. */
  talentUnresolvedCount: number;
  /** TODO el equipo, no solo los trinkets — icono + tooltip de Wowhead basta, no hace falta resolver el nombre en analyze-report. */
  gear: { slot: number; itemId: number; itemLevel: number }[];
  /** Compendio de uso de defensivos durante TODO el pull — no solo el instante de morir. Cada cast lleva su minuto y si cayó pegado a una muerte (más peso: lo usó y aun así no bastó, o llegó a tiempo). Solo se incluyen los que se usaron al menos una vez. */
  defensivesUsed: { spellId: number; name: string; casts: { timeMs: number; closeToDeath: boolean }[] }[];
  /** Estado de cooldown de CADA defensivo de su catálogo en el momento exacto de morir — null si no murió (no aplica). Mismo dato que ya vive en death_cause.defensiveOptions, expuesto aquí para el desplegable del roster. */
  defensiveStatusAtDeath: import('../shared/models/domain').DefensiveOption[] | null;
  consumables: PlayerPullRecordRow['consumables'];
}

export interface PullDetail {
  pullId: string;
  reportCode: string;
  fightId: number;
  header: PullHeaderData;
  metrics: MetricCardData[];
  timeline: TimelineChip[];
  /** Mecánicas 'clean' repetidas que NO se pintan como chip individual (su primera aparición sí) — ver buildTimeline. */
  backgroundMechanics: BackgroundMechanicSummary[];
  /** Daño recibido por la raid en el tiempo — la gráfica real que sustituye al timeline de solo-chips. Null si WCL no respondió al analizar este pull. */
  raidDamageSeries: { pointIntervalMs: number; points: number[] } | null;
  callouts: CoachingCallout[];
  /** Mecánicas de responsabilidad individual falladas SIN morir — pestaña "Mecánicas" de A quién dirigir, separada de "Muertes" (callouts). */
  mechanicFails: MechanicFailRow[];
  /** §"pone mecánicas fallidas y luego 'a quién dirigir' no tiene nada" (feedback real, verificado): fallos reales de categorías de GRUPO (raid-damage/tankbuster/interrupt/debuff-stack/healing-absorb) — cuentan en la tarjeta "Mecánicas falladas" pero nunca en esta pestaña (no son culpa de una persona). Se expone para poder explicar la diferencia en vez de dejarla como una contradicción muda. */
  groupMechanicFailCount: number;
  playerStats: PlayerStatRow[];
  brief: LlmPullAnalysis | null;
  isFirstPullOfNight: boolean; // sin comparación posible — las 4 tarjetas van sin delta
  /** Score compuesto de §13 menos el del pull anterior — positivo = mejor intento. Null si no hay pull anterior con el que comparar. */
  progressDeltaPct: number | null;
  /** Reparto de las mecánicas de ESTE pull por categoría (pull_mechanic_events.category, confirmada o inferida) — de qué está hecho el pull, no solo cuántas fallaron. */
  mechanicCategoryBreakdown: DonutSegment[];
  /** Reparto de TODOS los defensivos evaluados en las muertes de este pull, por estado — cuánta "defensa desperdiciada" (available_unused) hubo en conjunto, no solo por jugador. */
  defensiveStatusBreakdown: DonutSegment[];
  /** Progreso (100 - wipe_pct) de los últimos intentos + este, más reciente a la derecha. */
  progressTrend: TrendBar[];
  /** §"cuándo se determina un wipe global... vamos a wipear": null = sin cluster detectado en este pull (o fue kill). */
  wipeCall: { confidence: number; excluded: boolean; signals: Record<string, number | boolean | null> } | null;
  /** §"un ninja pull... también cuenta en la estadística de wipes": null = la heurística no lo marcó (duración/enganche normales, o fue kill). */
  ninjaPull: { excluded: boolean; signals: Record<string, number | boolean | null> } | null;
}

// §"los defensivos ganan peso si están pegados a la muerte": un cast dentro
// de estos ms antes de morir se marca closeToDeath en el roster.
const CLOSE_TO_DEATH_MS = 10_000;

// Misma ventana que usa analyze-report para atribuir daño/muerte a un cast
// concreto — se repite aquí (no se comparte módulo con Deno) para poder
// agrupar una muerte bajo el chip de mecánica que la causó en vez de
// duplicarla como chip suelto.
const MECHANIC_ATTRIBUTION_WINDOW_MS = 4000;

/** §"esa gente no debería... contar como muerte, marcado como wipe call": true solo cuando la muerte formó parte del cluster detectado EN ESE PULL y el RL no la ha restaurado (pull.wipe_call_excluded). La fila se sigue mostrando en "a quién dirigir" — esto solo decide si cuenta en métricas/fiabilidad/racha. */
function isExcludedStatisticalDeath(pull: PullRow, record: PlayerPullRecordRow): boolean {
  return isDeathExcludedFromStatistics(pull, record);
}

@Injectable({ providedIn: 'root' })
export class PullAnalysisService {
  private supabase = inject(SupabaseService);
  private edgeFunctions = inject(EdgeFunctionsService);
  private wowauditRoster = inject(WowauditRosterService);
  private bossPhase = inject(BossPhaseService);

  async loadPullDetail(pullId: string): Promise<PullDetail> {
    const client = this.supabase.client;

    const { data: pullData, error: pullErr } = await client.from('pulls').select('*').eq('id', pullId).single();
    if (pullErr) throw pullErr;
    const pull = pullData as PullRow;

    // §"todo el roster de todas las pantallas... tiene que ser el oficial de
    // wowaudit": el icono de rol de la tabla de jugadores de ESTE pull sale
    // de aquí también, no de una deducción propia — best-effort (sin sync
    // todavía, la tabla sigue funcionando sin icono de rol).
    const rosterByNamePromise = this.wowauditRoster
      .listRoster()
      .then((roster) => new Map(roster.map((r) => [r.name, r.role])))
      .catch(() => new Map<string, string>());
    // §"fases de encuentro... en todos los sitios donde corresponda"
    // (feedback real): lanzado ya, se espera justo antes de construir
    // `header` — mismo patrón que rosterByNamePromise.
    const bossPhasesPromise = this.bossPhase.listPhases(pull.boss_id).catch(() => []);

    const [encounterRes, recordsRes, mechEventsRes, briefRes, candidatesRes, priorPullsRes, referenceStatsRes] = await Promise.all([
      client.from('report_encounters').select('*').eq('report_code', pull.report_code).eq('fight_id', pull.fight_id).maybeSingle(),
      client.from('player_pull_records').select('*').eq('pull_id', pullId),
      withSupabaseRelationFallback(
        'applicable_pull_mechanic_events',
        () => client.from('applicable_pull_mechanic_events').select('*').eq('pull_id', pullId).order('trigger_time_ms', { ascending: true }),
        () => client.from('pull_mechanic_events').select('*').eq('pull_id', pullId).order('trigger_time_ms', { ascending: true }),
      ),
      client.from('pull_briefs').select('*').eq('pull_id', pullId).maybeSingle(),
      // §"la 'i' que abra... las notas que trajimos con el prompt en
      // Ajustes" (feedback real): se trae name+ai_classification en la
      // misma consulta que ya existía solo para saber si había manifiesto
      // (antes head:true/count, sin filas) — mismo viaje de red, ahora con
      // lo necesario para cruzar por nombre en buildMechanicFails.
      withSupabaseRelationFallback(
        'applicable_boss_mechanics_candidates',
        () => client.from('applicable_boss_mechanics_candidates').select('name, ai_classification').eq('boss_id', pull.boss_id).eq('difficulty', pull.difficulty),
        () => client.from('boss_mechanics_candidates').select('name, ai_classification').eq('boss_id', pull.boss_id).eq('difficulty', pull.difficulty),
      ),
      client
        .from('pulls')
        .select('*')
        .eq('boss_id', pull.boss_id)
        .eq('difficulty', pull.difficulty)
        .lt('pull_number', pull.pull_number)
        .order('pull_number', { ascending: false })
        .limit(6),
      // §"a qué estamos llegando tarde": ritmo del mejor kill público del
      // mismo boss+dificultad (ver boss_reference_stats, poblado por
      // sync-boss-mechanics). Puede no existir todavía (raid nueva, o nadie
      // ha sincronizado el manifiesto de este boss) — se trata como "sin
      // benchmark todavía", no como error.
      client.from('boss_reference_stats').select('*').eq('boss_id', pull.boss_id).eq('difficulty', pull.difficulty).maybeSingle(),
    ]);

    const encounter = encounterRes.data as ReportEncounterRow | null;
    const records = (recordsRes.data ?? []) as PlayerPullRecordRow[];
    const mechEvents = (mechEventsRes.data ?? []) as PullMechanicEventRow[];
    const briefRow = briefRes.data as PullBriefRow | null;
    const candidateRows = (candidatesRes.data ?? []) as { name: string; ai_classification: { notes: string } | null }[];
    const hasManifest = candidateRows.length > 0;
    const notesByMechanicName = new Map(candidateRows.filter((c) => c.ai_classification?.notes).map((c) => [c.name, c.ai_classification!.notes]));
    const priorPulls = (priorPullsRes.data ?? []) as PullRow[];
    const previousPull = priorPulls[0] ?? null;
    const pullByIdForEvaluation = new Map([pull, ...priorPulls].map((p) => [p.id, p]));
    const referenceStats = referenceStatsRes.data as BossReferenceStatsRow | null;
    const evaluatedMechEvents = mechEvents.filter((event) => !isMechanicExcludedByWipeCall(pull, event));

    let previousRecords: PlayerPullRecordRow[] = [];
    let previousMechFailCount = 0;
    const priorRecordsByPullId = new Map<string, PlayerPullRecordRow[]>();
    // §"en qué estamos fallando" a nivel de RAID, no solo de un jugador: la
    // misma mecánica fallando en pulls consecutivos DEL BOSS, cruzando
    // pull_mechanic_events de este pull + los anteriores ya traídos arriba —
    // no es un dato nuevo que pedir aparte, es agregar lo que ya se tiene.
    let mechanicEventsAcrossPulls: { pull_id: string; ability_id: number; mechanic_name: string; outcome: string }[] = evaluatedMechEvents.map((e) => ({
      pull_id: pullId,
      ability_id: e.ability_id,
      mechanic_name: e.mechanic_name,
      outcome: e.outcome,
    }));
    if (priorPulls.length) {
      const priorPullIds = priorPulls.map((p) => p.id);
      const [priorRecordsRes, priorMechEventsRes] = await Promise.all([
        client.from('player_pull_records').select('*').in('pull_id', priorPullIds),
        withSupabaseRelationFallback(
          'applicable_pull_mechanic_events',
          () => client.from('applicable_pull_mechanic_events').select('pull_id,ability_id,mechanic_name,outcome,trigger_time_ms').in('pull_id', priorPullIds),
          () => client.from('pull_mechanic_events').select('pull_id,ability_id,mechanic_name,outcome,trigger_time_ms').in('pull_id', priorPullIds),
        ),
      ]);
      for (const r of (priorRecordsRes.data ?? []) as PlayerPullRecordRow[]) {
        if (!priorRecordsByPullId.has(r.pull_id)) priorRecordsByPullId.set(r.pull_id, []);
        priorRecordsByPullId.get(r.pull_id)!.push(r);
      }
      const priorMechanicEvents = (priorMechEventsRes.data ?? []) as { pull_id: string; ability_id: number; mechanic_name: string; outcome: string; trigger_time_ms: number }[];
      mechanicEventsAcrossPulls = mechanicEventsAcrossPulls.concat(
        priorMechanicEvents.filter((event) => {
          const eventPull = pullByIdForEvaluation.get(event.pull_id);
          return eventPull != null && !isMechanicExcludedByWipeCall(eventPull, event as PullMechanicEventRow);
        }),
      );
      if (previousPull) {
        previousRecords = priorRecordsByPullId.get(previousPull.id) ?? [];
        previousMechFailCount = mechanicEventsAcrossPulls.filter((e) => e.pull_id === previousPull.id && e.outcome !== 'clean').length;
      }
    }
    const mechanicFailurePatterns = buildMechanicFailurePatterns(mechanicEventsAcrossPulls);

    const isKill = encounter?.kill ?? pull.wipe_pct === 0;
    const header: PullHeaderData = {
      encounterName: encounter?.boss_name ?? `Boss ${pull.boss_id}`,
      difficulty: normalizeDifficulty(pull.difficulty),
      attemptNumber: pull.pull_number,
      durationLabel: formatDuration(pull.duration_ms),
      durationMs: pull.duration_ms,
      bossHpRemainingPct: pull.wipe_pct ?? 0,
      result: isKill ? 'kill' : 'wipe',
      referencePacing: buildReferencePacing(pull, referenceStats),
      phaseLabel: formatPhaseReached(pull.phase_transitions, pull.last_phase_is_intermission, await bossPhasesPromise),
    };

    // §"mecánicas falladas no concuerda con muertes": una muerte cuya
    // habilidad NO tenía un cast de boss correlado (ver nota en
    // attributeDeaths) antes se quedaba fuera del recuento de "mecánicas
    // falladas" del todo — un pull con 7 muertes reales podía enseñar "0
    // mecánicas falladas", que es justo la incoherencia que se señaló. Se
    // calcula UNA vez y se reparte a metrics (el número) y timeline (los
    // chips), para no calcular la misma atribución dos veces con posible
    // resultado distinto.
    // §"no debería... contar como muerte": las del cluster de wipe call
    // excluido no entran como candidatas de "mecánica fallada sin cast
    // correlado" — no infla mechCard, aunque siguen pudiendo aparecer con
    // su propio chip descriptivo en la timeline (buildTimeline usa
    // `records` sin filtrar para eso, ver más abajo).
    const deathAttribution = attributeDeaths(
      records.filter((r) => !isExcludedStatisticalDeath(pull, r)),
      evaluatedMechEvents,
    );
    const metrics = buildMetrics(
      pull,
      records,
      evaluatedMechEvents,
      previousPull,
      previousRecords,
      previousMechFailCount,
      priorPulls,
      priorRecordsByPullId,
      mechanicFailurePatterns,
      deathAttribution.uncoveredFailedMechanicCount,
    );
    const { chips: timeline, background: backgroundMechanics } = buildTimeline(pull, records, mechEvents, hasManifest, deathAttribution.coveredRecordIds);
    const callouts = buildCallouts(pull, records, previousPull, previousRecords, priorPulls, priorRecordsByPullId, notesByMechanicName);
    const mechanicFails = buildMechanicFails(pull, records, evaluatedMechEvents, notesByMechanicName);
    // §"pone mecánicas fallidas y luego 'a quién dirigir' no tiene nada"
    // (feedback real): mismo criterio de exclusión que buildMechanicFails,
    // pero contando lo EXCLUIDO en vez de lo incluido — para poder decir
    // "hubo N fallos, pero son de grupo/tank/interrupción" en vez de dejar
    // la pestaña vacía sin explicación cuando la tarjeta de arriba no es 0.
    const groupMechanicFailCount = evaluatedMechEvents.filter((m) => m.outcome !== 'clean' && m.category != null && !PERSONAL_RESPONSIBILITY_CATEGORIES.has(m.category)).length;
    const roleByName = await rosterByNamePromise;
    const playerStats = buildPlayerStats(pull, records, roleByName);

    // §13: score compuesto, no solo la comparación campo a campo de las 4
    // tarjetas — "¿este intento fue mejor que el anterior en conjunto?" en un
    // solo número. bestKillDurationMs sale de los propios pulls ya traídos
    // (priorPulls + el actual si es kill): el mejor kill visto hasta ahora de
    // este boss+dificultad, no un dato aparte que haya que pedir.
    let progressDeltaPct: number | null = null;
    if (previousPull) {
      const killDurations = [pull, ...priorPulls].filter((p) => p.wipe_pct === 0 && p.duration_ms != null).map((p) => p.duration_ms!);
      const bestKillDurationMs = killDurations.length ? Math.min(...killDurations) : null;
      const currentDeaths = records.filter((r) => r.died && !isExcludedStatisticalDeath(pull, r)).length;
      const currentMechFails = evaluatedMechEvents.filter((m) => m.outcome !== 'clean').length;
      const previousDeaths = previousRecords.filter((r) => r.died && !isExcludedStatisticalDeath(previousPull, r)).length;
      const currentScore = progressScore(pull, currentDeaths, currentMechFails, bestKillDurationMs);
      const previousScore = progressScore(previousPull, previousDeaths, previousMechFailCount, bestKillDurationMs);
      progressDeltaPct = Math.round((currentScore - previousScore) * 10) / 10;
    }

    return {
      pullId,
      reportCode: pull.report_code,
      fightId: pull.fight_id,
      header,
      metrics,
      timeline,
      backgroundMechanics,
      raidDamageSeries: pull.raid_damage_taken_series,
      callouts,
      mechanicFails,
      groupMechanicFailCount,
      playerStats,
      brief: briefRow ? mapBrief(briefRow) : null,
      isFirstPullOfNight: !previousPull,
      progressDeltaPct,
      mechanicCategoryBreakdown: buildMechanicCategoryBreakdown(evaluatedMechEvents),
      defensiveStatusBreakdown: buildDefensiveStatusBreakdown(records.filter((r) => !isExcludedStatisticalDeath(pull, r))),
      progressTrend: buildProgressTrend(pull, priorPulls),
      wipeCall: pull.wipe_call_signals ? { confidence: pull.wipe_call_confidence ?? 0, excluded: pull.wipe_call_excluded, signals: pull.wipe_call_signals } : null,
      ninjaPull: pull.ninja_pull_signals ? { excluded: pull.ninja_pull_excluded, signals: pull.ninja_pull_signals } : null,
    };
  }

  /** §"que autoexcluya pero que permita también editarlo... para restaurar": el toggle de wipe call — recarga el pull entero porque el cambio afecta a demasiados cálculos derivados (deaths, mechFails, racha, defensivos) como para recomputarlos todos a mano en el cliente. */
  async setWipeCallStatus(pullId: string, excluded: boolean): Promise<void> {
    await this.edgeFunctions.setWipeCallStatus(pullId, excluded);
  }

  /** §"un ninja pull... habría que clasificarlo de otra manera": mismo patrón que setWipeCallStatus — recarga el pull entero porque la exclusión afecta a fiabilidad/histórico de boss/informe de noche, no solo a este pull. */
  async setNinjaPullStatus(pullId: string, excluded: boolean): Promise<void> {
    await this.edgeFunctions.setNinjaPullStatus(pullId, excluded);
  }

  async generateBrief(pullId: string, force = false): Promise<LlmPullAnalysis> {
    const result = await this.edgeFunctions.generatePullBrief(pullId, force);
    return mapBrief(result.brief as unknown as PullBriefRow);
  }
}

// §13: score = (100 - hp%) * 0.5 + max(0, duración/duración_estimada_kill) * 30
//              - nº_muertes * 5 - nº_mecánicas_falladas * 3
// La hoja de ruta lo deja explícito: "los pesos son un punto de partida, no
// una ley — se pueden ajustar sin tocar el esquema". duración_estimada_kill
// no es un dato aparte: se usa el mejor kill ya visto de este boss+dificultad
// (null si todavía no hay ninguno — ese término del score queda en 0, no se inventa).
function progressScore(pull: PullRow, deaths: number, mechFails: number, bestKillDurationMs: number | null): number {
  const hpTerm = (100 - (pull.wipe_pct ?? 100)) * 0.5;
  const durationTerm = bestKillDurationMs && pull.duration_ms ? Math.max(0, pull.duration_ms / bestKillDurationMs) * 30 : 0;
  return hpTerm + durationTerm - deaths * 5 - mechFails * 3;
}

function buildPlayerStats(pull: PullRow, records: PlayerPullRecordRow[], roleByName: Map<string, string>): PlayerStatRow[] {
  return records
    .map((r) => ({
      playerName: r.player_name,
      died: r.died,
      class: r.class,
      spec: r.spec,
      role: (roleByName.get(r.player_name) as PlayerStatRow['role']) ?? null,
      dps: r.dps ?? 0,
      hps: r.hps ?? 0,
      absorbedDamageTaken: r.absorbed_damage_taken ?? 0,
      worldRankPercent: r.world_rank_percent,
      worldTotalParses: r.world_total_parses,
      talents: (r.talent_build ?? [])
        .filter((t): t is { id: number; rank: number; nodeID: number; spellId: number } => typeof t.spellId === 'number')
        .map((t) => ({ spellId: t.spellId, rank: t.rank })),
      talentUnresolvedCount: (r.talent_build ?? []).filter((t) => typeof t.spellId !== 'number').length,
      // §"todo el gear, no solo los trinkets": icono + tooltip de Wowhead ya
      // basta (no hace falta el nombre resuelto en analyze-report) — se
      // enseñan todos los slots con item real, en el orden que ya trae WCL.
      gear: (r.equipped_items ?? [])
        .map((item, slot) => ({ slot, itemId: item?.id ?? 0, itemLevel: item?.itemLevel ?? 0 }))
        .filter((g) => g.itemId > 0),
      // §"los defensivos ganan peso si están pegados a la muerte": cada cast
      // lleva su propio minuto y si cayó en los CLOSE_TO_DEATH_MS previos a
      // morir — si no murió, closeToDeath siempre es false (no hay muerte
      // con la que compararlo).
      defensivesUsed: (r.defensive_casts ?? [])
        .filter((d) => d.timestampsMs.length > 0)
        .map((d) => ({
          spellId: d.spellId,
          name: d.name,
          casts: d.timestampsMs.map((timeMs) => ({
            timeMs,
            closeToDeath: r.died && r.death_cause != null && !isExcludedStatisticalDeath(pull, r) && timeMs <= r.death_cause.timeMs && r.death_cause.timeMs - timeMs <= CLOSE_TO_DEATH_MS,
          })),
        })),
      defensiveStatusAtDeath: r.died && !isExcludedStatisticalDeath(pull, r) ? (r.death_cause?.defensiveOptions ?? []) : null,
      consumables: r.consumables,
    }))
    .sort((a, b) => b.dps - a.dps);
}

export function mapBrief(row: PullBriefRow | { headline: string; improved: string[]; regressed: string[]; next_pull_actions: string[]; model: string }): LlmPullAnalysis {
  return {
    headline: row.headline,
    improved: row.improved,
    regressed: row.regressed,
    nextPullActions: row.next_pull_actions,
    model: row.model,
  };
}

// El Journal de Blizzard NO documenta todas las habilidades que hacen daño
// real (verificado en real 2026-08-22: de 29 muertes en un wipe, solo 1
// coincidía con las 27 candidatas del Journal — el resto son IDs que ni
// siquiera resuelve /data/wow/spell/{id} todavía, raid con 3 días de vida).
// Mostrar el ID en bruto en vez de un "sin clasificar" mudo es lo único
// honesto: da algo buscable a mano y a lo que aspirar cuando Blizzard/el
// manifiesto se pongan al día.
function mechanicLabel(deathCause: { mechanicId: number; mechanicName: string | null }): string {
  if (deathCause.mechanicName) return mechanicDisplayName(deathCause.mechanicName);
  if (deathCause.mechanicId) return `Hechizo #${deathCause.mechanicId} (sin clasificar)`;
  return 'Causa no registrada por WCL';
}

/** Desglose completo para el drawer de procedencia — aquí sí cabe todo lo que la línea corta del callout no puede. */
// §13.4 "la secuencia real de golpes antes de morir, no solo una frase":
// death_cause.damageWindowEvents ya trae cada golpe individual (analyze-report,
// §2026-08-23) — aquí solo se da formato de presentación (tiempo legible,
// nombre resuelto o "Golpe #N" si WCL no tenía nombre para esa ability).
function buildDamageTimeline(deathCause: PlayerPullRecordRow['death_cause']): CoachingCallout['provenance']['damageTimeline'] {
  if (!deathCause?.damageWindowEvents?.length) return undefined;
  return deathCause.damageWindowEvents.map((hit, i) => ({
    timeLabel: formatTimeLabel(hit.time_ms),
    amount: hit.amount,
    abilityLabel: hit.ability_name ?? `Golpe #${i + 1}`,
    wowheadSpellId: hit.ability_id,
  }));
}

function buildDeathDetail(deathCause: PlayerPullRecordRow['death_cause'], consumables: PlayerPullRecordRow['consumables'] | null): string {
  if (!deathCause) return '';
  const lines: string[] = [`Mecánica: ${mechanicLabel(deathCause)} (spell #${deathCause.mechanicId || '—'})`];
  if (deathCause.mechanicDescription && deathCause.mechanicDescription !== deathCause.mechanicName) lines.push(deathCause.mechanicDescription);
  if (deathCause.category) {
    lines.push(`Categoría: ${deathCause.category}${deathCause.categoryIsInferred ? ' (sugerida automáticamente, sin confirmar en el manifiesto)' : ' (confirmada en el manifiesto)'}.`);
  }
  // §10: por qué murió, no solo qué le mató — ver rootCause en analyze-report.
  // 'unclassified' se explica en vez de callarse aquí (a diferencia de la
  // frase corta del callout): en el drawer sí hay sitio para decir POR QUÉ
  // no se pudo determinar, en vez de dejar un hueco mudo.
  const rootCauseLabel: Record<NonNullable<typeof deathCause.rootCause>, string> = {
    self_positioning: 'Se posicionó mal — la mecánica exigía evitar una zona o separarse, y no lo hizo.',
    unsoaked_mechanic: 'Falta de coordinación de grupo — mecánica de soak sin suficiente gente agrupada.',
    no_healing_received: 'Sin sanación real dirigida a este jugador en los 6s previos a morir, con daño sostenido (no un golpe único).',
    // §"Dispels — sin ingestión de eventos de dispel" (feedback real): solo
    // se afirma con un evento Dispels real ausente para esta habilidad
    // sobre este jugador — ver computeRootCause en analyze-report.
    undispelled_debuff: 'Debuff acumulativo sin dispel — no hay ningún evento de dispel registrado sobre este jugador para esta habilidad antes de morir.',
    unclassified: 'Causa raíz no determinada — la mecánica no está en una categoría con causa conocida, o haría falta rastrear amenaza/tank swap (no disponible todavía) para saberlo con certeza.',
  };
  if (deathCause.rootCause) lines.push(`Causa raíz: ${rootCauseLabel[deathCause.rootCause]}`);

  if (deathCause.damageProfile === 'burst') {
    const burstDamage = deathCause.terminalBurstDamage ?? deathCause.killingBlowAmount ?? 0;
    const healthPct = deathCause.burstHealthPct != null ? `, ${Math.round(deathCause.burstHealthPct)}% de su vida máxima` : '';
    lines.push(`Daño: oneshot/burst — ${burstDamage.toLocaleString('es-ES')} concentrado en ${(deathCause.burstWindowMs ?? 1000) / 1000}s${healthPct}. El daño previo no se usa para diluir este pico: no hubo una ventana razonable para curarlo.`);
  } else if (deathCause.damageProfile === 'sustained') {
    lines.push(`Daño: sostenido — ${deathCause.damageWindowHits} golpes sumando ${deathCause.damageWindowTotal.toLocaleString('es-ES')} en los últimos 5s, ninguno dominante. Hubo ventana para curarlo o reaccionar.`);
  }
  // Optional chaining: pulls procesados antes de que existiera esta columna
  // traen consumables:{} (sin .healthstone/.healthPotion todavía) — ver
  // misma nota más abajo en buildCallouts.
  if (consumables?.healthstone) {
    const stoneLine = consumables.healthstone.used
      ? `Piedra de brujo: usada (×${consumables.healthstone.count}).`
      : consumables.healthstone.available
        ? 'Piedra de brujo: disponible (había Warlock en la raid) y NO usada.'
        : 'Piedra de brujo: sin Warlock detectado en la raid de este pull.';
    lines.push(stoneLine);
  }
  if (consumables?.healthPotion) {
    lines.push(consumables.healthPotion.used ? `Poción de vida: usada (×${consumables.healthPotion.count}).` : 'Poción de vida: no se registró ningún uso.');
  }

  const options = deathCause.defensiveOptions ?? [];
  const active = options.filter((o) => o.status === 'active');
  const availableUnused = options.filter((o) => o.status === 'available_unused');
  const onCooldown = options.filter((o) => o.status === 'on_cooldown');
  const unknown = options.filter((o) => o.status === 'unknown');

  lines.push(''); // separador visual dentro del <dd> (white-space: pre-line respeta la línea vacía)
  lines.push(
    active.length
      ? `Activo al morir: ${active.map((o) => o.name).join(', ')}.`
      : deathCause.preventableWithDefensive === null
        ? 'Activo al morir: no se pudo confirmar (WCL no adjuntó un snapshot de buffs cercano a la muerte).'
        : 'Activo al morir: ninguno.',
  );
  if (availableUnused.length) {
    lines.push(`Disponible y SIN usar: ${availableUnused.map((o) => o.name).join(', ')}.`);
  }
  if (onCooldown.length) {
    lines.push(
      `En cooldown en ese momento: ${onCooldown.map((o) => `${o.name} (le faltaban ${Math.round((o.cooldownRemainingMs ?? 0) / 1000)}s)`).join(', ')}.`,
    );
  }
  if (unknown.length) {
    lines.push(`Sin dato de cooldown base todavía: ${unknown.map((o) => o.name).join(', ')}.`);
  }
  if (!options.length) {
    lines.push('Sin catálogo de defensivos para su clase todavía.');
  }
  return lines.join('\n');
}

/** Cuenta pulls consecutivos (empezando por pullsDesc[0]) en los que `playerName` murió a `mechanicId`. Se corta en el primer hueco. */
function computeDeathStreak(
  playerName: string,
  mechanicId: number,
  pullsDesc: PullRow[],
  recordsByPullId: Map<string, PlayerPullRecordRow[]>,
): number {
  let streak = 0;
  for (const p of pullsDesc) {
    const rec = (recordsByPullId.get(p.id) ?? []).find((r) => r.player_name === playerName);
    if (rec?.died && rec.death_cause?.mechanicId === mechanicId && !isExcludedStatisticalDeath(p, rec)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function paceDiffLabel(actualMs: number, referenceMs: number): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  const diffMs = actualMs - referenceMs;
  const diffSeconds = Math.round(Math.abs(diffMs) / 1000);
  const diffLabel = `${Math.floor(diffSeconds / 60)}:${(diffSeconds % 60).toString().padStart(2, '0')}`;
  return {
    label: diffMs <= 0 ? `${diffLabel} más rápido` : `+${diffLabel}`,
    tone: diffMs <= 0 ? 'success' : diffMs / referenceMs > 0.15 ? 'warning' : 'neutral',
  };
}

/**
 * Solo tiene sentido comparar el ritmo de un KILL contra referencia — un
 * wipe a mitad de pull siempre "va más lento" sin decir nada útil.
 * A propósito NO se compara contra el #1 del mundo (feedback real del
 * usuario: "los datos de la kill no son interesantes con respecto al mejor
 * kill del mundo ni del reino, eso no es interesante. Es interesante con
 * respecto a la media") — la única comparación que se enseña es contra la
 * MEDIANA de hasta 50 kills públicas, que es la que de verdad dice "cómo
 * está haciendo Avoid" sin el listón imposible de la excepción absoluta.
 */
function buildReferencePacing(pull: PullRow, referenceStats: BossReferenceStatsRow | null): ReferencePacing | null {
  if (pull.wipe_pct !== 0) return null; // solo tiene sentido comparar el ritmo de un KILL — ver buildReferencePacingFromDuration
  return buildReferencePacingFromDuration(pull.duration_ms, referenceStats);
}

/**
 * Misma comparación que buildReferencePacing pero sin exigir un PullRow
 * completo — §"todos los pulls de un boss": la pantalla de histórico quiere
 * comparar el MEJOR kill de toda la historia del boss, no el de un pull
 * concreto, así que solo hace falta la duración.
 */
export function buildReferencePacingFromDuration(durationMs: number | null, referenceStats: BossReferenceStatsRow | null): ReferencePacing | null {
  if (!referenceStats || durationMs == null || referenceStats.reference_median_duration_ms == null) return null;
  const vsMedian = paceDiffLabel(durationMs, referenceStats.reference_median_duration_ms);
  return {
    label: `${vsMedian.label} vs. la mediana de ${referenceStats.reference_sample_size} kills públicas (${formatDuration(referenceStats.reference_median_duration_ms)})`,
    tone: vsMedian.tone,
    zeroDeathContext:
      referenceStats.reference_zero_death_rate != null && referenceStats.reference_sample_size
        ? `${Math.round(referenceStats.reference_zero_death_rate * 100)}% de esas ${referenceStats.reference_sample_size} kills públicas se hicieron sin ninguna muerte.`
        : null,
    yourDurationMs: durationMs,
    medianDurationMs: referenceStats.reference_median_duration_ms,
  };
}

export interface MechanicFailurePattern {
  abilityId: number;
  name: string;
  failedPulls: number;
  totalPulls: number;
}

// Solo mecánicas con >=2 pulls vistos Y >=2 fallos — un solo fallo suelto no
// es un "patrón", es ruido; esto es deliberadamente conservador (§ misma
// idea que suggestedAvoidable en manifest.component.ts: mejor no señalar que
// señalar de más).
function buildMechanicFailurePatterns(events: { pull_id: string; ability_id: number; mechanic_name: string; outcome: string }[]): MechanicFailurePattern[] {
  const byAbility = new Map<number, { name: string; pullIds: Set<string>; failedPullIds: Set<string> }>();
  for (const ev of events) {
    if (!byAbility.has(ev.ability_id)) byAbility.set(ev.ability_id, { name: ev.mechanic_name, pullIds: new Set(), failedPullIds: new Set() });
    const entry = byAbility.get(ev.ability_id)!;
    entry.pullIds.add(ev.pull_id);
    if (ev.outcome !== 'clean') entry.failedPullIds.add(ev.pull_id);
  }
  return [...byAbility.entries()]
    .map(([abilityId, e]) => ({ abilityId, name: e.name, failedPulls: e.failedPullIds.size, totalPulls: e.pullIds.size }))
    .filter((e) => e.totalPulls >= 2 && e.failedPulls >= 2)
    .sort((a, b) => b.failedPulls / b.totalPulls - a.failedPulls / a.totalPulls);
}

/** Reparto de este pull por categoría de mecánica — donut §"resumen del pull". Clave = la propia categoría (o null), nunca la etiqueta ya traducida, para no tener que adivinar el color al revés. */
function buildMechanicCategoryBreakdown(mechEvents: PullMechanicEventRow[]): DonutSegment[] {
  const counts = new Map<PullMechanicEventRow['category'], Map<string, number>>();
  for (const ev of mechEvents) {
    if (!counts.has(ev.category)) counts.set(ev.category, new Map());
    const byName = counts.get(ev.category)!;
    byName.set(ev.mechanic_name, (byName.get(ev.mechanic_name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, byName]) => {
    const meta = mechanicCategoryMeta(category);
    const value = [...byName.values()].reduce((a, b) => a + b, 0);
    const detailLines = [...byName.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}: ${count}`);
    return { label: meta?.label ?? 'Sin categoría', value, color: meta?.color ?? 'var(--text-faint)', detailLines };
  });
}

function buildDefensiveStatusBreakdown(records: PlayerPullRecordRow[]): DonutSegment[] {
  const STATUS_META: Record<string, { label: string; color: string }> = {
    active: { label: 'Activo al morir', color: 'var(--success)' },
    available_unused: { label: 'Disponible y sin usar', color: 'var(--warning)' },
    on_cooldown: { label: 'En cooldown', color: 'var(--neutral)' },
    unknown: { label: 'Sin dato de cooldown', color: 'var(--text-faint)' },
  };
  const counts = new Map<string, string[]>();
  for (const r of records) {
    if (!r.died || !r.death_cause) continue;
    for (const opt of r.death_cause.defensiveOptions ?? []) {
      if (!counts.has(opt.status)) counts.set(opt.status, []);
      counts.get(opt.status)!.push(`${r.player_name}: ${opt.name}`);
    }
  }
  return [...counts.entries()].map(([status, lines]) => ({
    label: STATUS_META[status]?.label ?? status,
    value: lines.length,
    color: STATUS_META[status]?.color ?? 'var(--text-faint)',
    detailLines: lines,
  }));
}

/** Últimos hasta-6 intentos anteriores + este, en orden cronológico (más reciente a la derecha) — reusa priorPulls, que ya viene ordenado pull_number desc. */
function buildProgressTrend(pull: PullRow, priorPulls: PullRow[]): TrendBar[] {
  const chronological = [...priorPulls].reverse().concat(pull);
  return chronological.map((p) => {
    const isKill = p.wipe_pct === 0;
    const progress = 100 - (p.wipe_pct ?? 100);
    return {
      label: `#${p.pull_number}`,
      value: Math.round(progress),
      isKill,
      isCurrent: p.id === pull.id,
      tooltip: `Intento #${p.pull_number}: ${isKill ? 'Kill' : `Wipe al ${formatPct(p.wipe_pct)}`}`,
    };
  });
}

function buildMetrics(
  pull: PullRow,
  records: PlayerPullRecordRow[],
  mechEvents: PullMechanicEventRow[],
  previousPull: PullRow | null,
  previousRecords: PlayerPullRecordRow[],
  previousMechFailCount: number,
  priorPulls: PullRow[],
  priorRecordsByPullId: Map<string, PlayerPullRecordRow[]>,
  mechanicFailurePatterns: MechanicFailurePattern[],
  uncoveredFailedMechanicCount: number,
): MetricCardData[] {
  const deaths = records.filter((r) => r.died && !isExcludedStatisticalDeath(pull, r)).length;
  // + uncoveredFailedMechanicCount: muertes reales cuya habilidad no generó
  // un cast de boss reconocible — sin esto el número podía leer "0
  // mecánicas falladas" con 7 muertes reales en el mismo pull (ver
  // attributeDeaths).
  const mechFails = mechEvents.filter((m) => m.outcome !== 'clean').length + uncoveredFailedMechanicCount;
  // §"no estamos evaluando bien las mecánicas... no aparecen en dirección de
  // personajes" (feedback real): cuántos de esos fallos SÍ cuentan aquí pero
  // no tienen categoría — antes esto era invisible, ahora se explica en el
  // propio detalle de la tarjeta en vez de dejar que el número no cuadre
  // con "a quién dirigir" sin decir por qué.
  const unclassifiedFailCount = mechEvents.filter((m) => m.outcome !== 'clean' && m.category == null).length;

  const hpCard: MetricCardData = {
    label: 'HP del boss restante',
    value: formatPct(pull.wipe_pct ?? 0),
    delta:
      previousPull && previousPull.wipe_pct != null && pull.wipe_pct != null
        ? lowerIsBetterDelta(pull.wipe_pct, previousPull.wipe_pct, 'pp', 1)
        : null,
    provenance: { source: 'pulls.wipe_pct', method: '% de vida del boss al morir el raid (0 si fue kill), directo de WCL.' },
    icon: '🛡️',
    iconTone: 'accent',
    // El gauge lee "progreso", no "HP restante" — 0% de HP restante es el
    // MEJOR resultado posible (kill), así que se invierte para que el
    // círculo se llene de verdad cuando el intento va bien.
    gaugeValue: 100 - (pull.wipe_pct ?? 100),
  };

  const deathsCard: MetricCardData = {
    label: 'Muertes',
    value: String(deaths),
    delta: previousPull ? lowerIsBetterDelta(deaths, previousRecords.filter((r) => r.died && !isExcludedStatisticalDeath(previousPull, r)).length, deaths === 1 ? ' muerte' : ' muertes', 0) : null,
    provenance: { source: 'player_pull_records', method: `Recuento de died=true (${deaths} de ${records.length} jugadores).` },
    icon: '💀',
    iconTone: 'danger',
  };

  const mechCard: MetricCardData = {
    label: 'Mecánicas falladas',
    value: String(mechFails),
    delta: previousPull ? lowerIsBetterDelta(mechFails, previousMechFailCount, mechFails === 1 ? ' mecánica' : ' mecánicas', 0) : null,
    provenance: {
      source: 'pull_mechanic_events + muertes sin cast de boss correlado',
      method:
        "Casts del boss con outcome 'fail' o 'partial_fail' (mató a alguien, o golpeó a más raid del umbral del manifiesto) MÁS las muertes reales que no tenían un cast de boss reconocible en ±4s (agrupadas por mecánica+~2s, para no contar 7 muertes simultáneas a la misma mecánica como 7 fallos sueltos).",
      detail:
        [
          uncoveredFailedMechanicCount
            ? `${uncoveredFailedMechanicCount} de esos fallos son muertes sin un cast de boss correlado (ver "a quién dirigir" para el detalle de cada una).`
            : null,
          unclassifiedFailCount
            ? `${unclassifiedFailCount} de esos fallos no tienen categoría confirmada en el manifiesto todavía — aparecen en "a quién dirigir" marcados "sin clasificar" (Ajustes para curarlos).`
            : null,
          mechanicFailurePatterns.length
            ? `Patrones repetidos (últimos ${Math.max(...mechanicFailurePatterns.map((p) => p.totalPulls))} intentos):\n${mechanicFailurePatterns
                .map((p) => `${p.name}: falló en ${p.failedPulls} de ${p.totalPulls} intentos`)
                .join('\n')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n') || undefined,
    },
    icon: '⚠️',
    iconTone: 'warning',
  };

  let maxStreak = 0;
  let streakPlayer: string | null = null;
  let streakMechanic: string | null = null;
  for (const r of records) {
    if (!r.died || !r.death_cause || isExcludedStatisticalDeath(pull, r)) continue;
    const priorStreak = computeDeathStreak(r.player_name, r.death_cause.mechanicId, priorPulls, priorRecordsByPullId);
    const total = priorStreak + 1;
    if (total > maxStreak) {
      maxStreak = total;
      streakPlayer = r.player_name;
      streakMechanic = r.death_cause.mechanicName;
    }
  }
  const streakCard: MetricCardData = {
    label: 'Racha del problema',
    // §"debería ser más descriptivo": antes el número solo se explicaba en
    // el drawer de provenance, un clic más allá — quién y a qué mecánica
    // ahora va en el propio valor de la tarjeta, visible de un vistazo.
    value: maxStreak >= 2 ? `${maxStreak}× ${streakPlayer}` : String(maxStreak),
    delta:
      maxStreak >= 2
        ? { label: streakMechanic ?? 'misma mecánica', tone: 'danger' }
        : { label: maxStreak === 1 ? 'sin repetirse (aún)' : 'sin patrones', tone: 'neutral' },
    provenance: {
      source: 'player_pull_records (pulls anteriores del mismo boss+dificultad)',
      method: 'Mismo jugador muriendo a la misma mecánica en pulls consecutivos, contando hacia atrás desde este pull.',
      detail: maxStreak >= 2 ? `${streakPlayer} lleva ${maxStreak} intentos seguidos muriendo a ${streakMechanic ?? 'la misma mecánica'}.` : undefined,
    },
    icon: '🔥',
    iconTone: 'gold',
  };

  return [hpCard, deathsCard, mechCard, streakCard];
}

function lowerIsBetterDelta(current: number, previous: number, unitLabel: string, digits: number) {
  const diff = previous - current; // positivo = mejora (bajó)
  if (Math.abs(diff) < 10 ** -digits / 2) {
    return { label: `igual que el intento anterior`, tone: 'neutral' as const };
  }
  const magnitude = Math.abs(diff).toFixed(digits).replace(/\.0+$/, '');
  return diff > 0
    ? { label: `${magnitude}${unitLabel} mejor que el anterior`, tone: 'success' as const, direction: 'down' as const }
    : { label: `${magnitude}${unitLabel} peor que el anterior`, tone: 'danger' as const, direction: 'up' as const };
}

/**
 * Bug real señalado por el usuario: un boss con varios adds atacando cada
 * 1-2s (verificado en real: 4 habilidades distintas con 240/112/48/27
 * instancias CADA UNA en un pull de 6 min, entrelazadas en el tiempo) hacía
 * la tira horizontal un scroll larguísimo de chips minúsculos. Agrupar solo
 * "rachas consecutivas de la misma habilidad" no sirve aquí: con varias
 * habilidades repitiéndose a la vez, casi nunca hay 2 casts seguidos de la
 * MISMA — el entrelazado rompe cualquier racha. La solución real: cada
 * habilidad 'clean' se enseña como chip la PRIMERA vez que aparece (para
 * saber que existe y qué pinta tiene) y las repeticiones limpias
 * siguientes van a un resumen de fondo aparte (backgroundMechanics), fuera
 * de la tira cronológica — cualquier instancia con fail/partial_fail o
 * muerte adjunta SIEMPRE se queda como su propio chip, nunca se agrupa.
 */
export interface BackgroundMechanicSummary {
  label: string;
  count: number;
  wowheadSpellId: number;
}

/**
 * §"mecánicas falladas no concuerda con muertes": una muerte solo cuenta
 * como "mecánica fallada" si su habilidad tenía un CAST de boss correlado a
 * <=4s (pull_mechanic_events) — si la habilidad que mató a alguien nunca
 * generó un cast reconocible (verificado en real: pasa con debuffs/ticks
 * persistentes que no son un "cast" discreto en WCL), esa muerte quedaba
 * fuera del recuento por completo: un pull con 7 muertes reales podía
 * enseñar "0 mecánicas falladas". Estas muertes "sin cobertura" se agrupan
 * por (mecánica, ventana de ~2s) — 7 muertes casi simultáneas a la misma
 * habilidad son UN fallo de mecánica raid-wide, no 7 fallos sueltos.
 */
const UNCOVERED_DEATH_GROUP_WINDOW_MS = 2000;

function attributeDeaths(
  records: PlayerPullRecordRow[],
  mechEvents: PullMechanicEventRow[],
): { coveredRecordIds: Set<string>; uncoveredFailedMechanicCount: number } {
  const deathsByAbility = new Map<number, { record: PlayerPullRecordRow; ms: number }[]>();
  for (const r of records) {
    if (!r.died || !r.death_cause) continue;
    const list = deathsByAbility.get(r.death_cause.mechanicId) ?? [];
    list.push({ record: r, ms: r.death_cause.timeMs });
    deathsByAbility.set(r.death_cause.mechanicId, list);
  }

  const coveredRecordIds = new Set<string>();
  for (const ev of mechEvents) {
    const candidates = deathsByAbility.get(ev.ability_id) ?? [];
    for (const c of candidates) {
      if (Math.abs(c.ms - ev.trigger_time_ms) <= MECHANIC_ATTRIBUTION_WINDOW_MS) coveredRecordIds.add(c.record.id);
    }
  }

  // Agrupa las muertes SIN cobertura por (mecánica, ventana de 2s) — cada
  // grupo cuenta como un fallo, no cada muerte individual dentro de él.
  const uncoveredByAbility = new Map<number, number[]>();
  for (const [abilityId, deaths] of deathsByAbility.entries()) {
    const uncoveredTimes = deaths.filter((d) => !coveredRecordIds.has(d.record.id)).map((d) => d.ms).sort((a, b) => a - b);
    if (uncoveredTimes.length) uncoveredByAbility.set(abilityId, uncoveredTimes);
  }
  let uncoveredFailedMechanicCount = 0;
  for (const times of uncoveredByAbility.values()) {
    let lastGroupStart = -Infinity;
    for (const t of times) {
      if (t - lastGroupStart > UNCOVERED_DEATH_GROUP_WINDOW_MS) {
        uncoveredFailedMechanicCount++;
        lastGroupStart = t;
      }
    }
  }

  return { coveredRecordIds, uncoveredFailedMechanicCount };
}

function buildTimeline(
  pull: PullRow,
  records: PlayerPullRecordRow[],
  mechEvents: PullMechanicEventRow[],
  hasManifest: boolean,
  coveredRecordIds: Set<string>,
): { chips: TimelineChip[]; background: BackgroundMechanicSummary[] } {
  // timeMs se deriva de `ms` recién al final (ver el .map() del return) — un
  // chip a medio construir todavía no lo tiene, así que Dated lo omite en
  // vez de heredarlo de TimelineChip como obligatorio.
  type Dated = Omit<TimelineChip, 'timeMs'> & { ms: number };
  const chips: Dated[] = [{ ms: 0, timeLabel: '0:00', description: 'Inicio del pull', outcome: 'neutral', provenance: null, wowheadSpellId: null, category: null }];
  const seenCleanAbility = new Set<number>();
  const backgroundByAbility = new Map<number, BackgroundMechanicSummary>();

  const deathsByAbility = new Map<number, { record: PlayerPullRecordRow; ms: number }[]>();
  for (const r of records) {
    if (!r.died || !r.death_cause) continue;
    const list = deathsByAbility.get(r.death_cause.mechanicId) ?? [];
    list.push({ record: r, ms: r.death_cause.timeMs });
    deathsByAbility.set(r.death_cause.mechanicId, list);
  }

  for (const ev of mechEvents) {
    const candidates = deathsByAbility.get(ev.ability_id) ?? [];
    const matched = candidates.filter((c) => Math.abs(c.ms - ev.trigger_time_ms) <= MECHANIC_ATTRIBUTION_WINDOW_MS);

    if (ev.outcome === 'clean' && !matched.length) {
      if (seenCleanAbility.has(ev.ability_id)) {
        const bg = backgroundByAbility.get(ev.ability_id);
        if (bg) bg.count++;
        else backgroundByAbility.set(ev.ability_id, { label: ev.mechanic_name, count: 1, wowheadSpellId: ev.ability_id });
        continue; // no chip — va al resumen de fondo, no a la tira cronológica
      }
      seenCleanAbility.add(ev.ability_id);
    }

    // players_hit tiene otro significado para 'interrupt' (0/1 = ¿se
    // resolvió?, no cuenta jugadores golpeados — ver analyze-report).
    const outcomeLabel =
      ev.category === 'interrupt'
        ? ev.outcome === 'clean'
          ? 'interrumpida a tiempo'
          : 'sin interrumpir'
        : `${ev.players_hit} golpeado${ev.players_hit === 1 ? '' : 's'}`;
    const deathLabel = matched.length ? ` · ${matched.length} muerte${matched.length === 1 ? '' : 's'}` : '';
    chips.push({
      ms: ev.trigger_time_ms,
      timeLabel: formatTimeLabel(ev.trigger_time_ms),
      description: `${ev.mechanic_name} · ${outcomeLabel}${deathLabel}`,
      outcome: ev.outcome,
      wowheadSpellId: ev.ability_id,
      category: ev.category,
      provenance: {
        source: 'pull_mechanic_events',
        method: 'Cast del boss cruzado con DamageTaken/Deaths en una ventana de reacción de 4s (heurística §12).',
        detail: [`ability_id ${ev.ability_id}`, ev.description ?? '(sin descripción en el manifiesto todavía)'].join('\n'),
        wclReportCode: pull.report_code,
        wclFightId: pull.fight_id,
      },
    });
  }

  for (const r of records) {
    if (!r.died || !r.death_cause || coveredRecordIds.has(r.id)) continue;
    chips.push({
      ms: r.death_cause.timeMs,
      timeLabel: formatTimeLabel(r.death_cause.timeMs),
      description: `${mechanicLabel(r.death_cause)} · muerte de ${r.player_name}`,
      outcome: 'fail',
      wowheadSpellId: r.death_cause.mechanicId || null,
      category: r.death_cause.category ?? null,
      provenance: {
        source: 'player_pull_records.death_cause',
        method: 'Evento de muerte de WCL (killingAbilityGameID) sin un cast de boss correlado en la ventana de 4s.',
        detail: [r.player_name, r.death_cause.mechanicDescription ?? null].filter(Boolean).join('\n'),
        wclReportCode: pull.report_code,
        wclFightId: pull.fight_id,
      },
    });
  }

  if (!hasManifest) {
    chips.push({
      ms: Number.MAX_SAFE_INTEGER,
      timeLabel: '',
      description: 'Sin mecánicas clasificadas — cura el manifiesto en Ajustes',
      outcome: 'neutral',
      provenance: null,
      wowheadSpellId: null,
      category: null,
    });
  }

  chips.sort((a, b) => a.ms - b.ms);
  const background = [...backgroundByAbility.values()].sort((a, b) => b.count - a.count);
  return { chips: chips.map(({ ms, ...chip }) => ({ ...chip, timeMs: ms === Number.MAX_SAFE_INTEGER ? null : ms })), background };
}


// Categorías donde "estar en players_hit_names" es responsabilidad
// individual del jugador (se posicionó mal / no se agrupó / no se separó /
// le tocaba a él y no reaccionó) — NO incluye raid-damage/tankbuster/
// debuff-stack/interrupt/healing-absorb, donde que te golpee es esperado o
// no depende de tu posición. Sin esta lista, cualquier mecánica raid-wide
// llenaría "a quién dirigir" de gente que hizo exactamente lo que tenía que hacer.
// Exportado: night-player-summary.service.ts reutiliza EXACTAMENTE el mismo
// criterio para la misma pregunta ("¿esta mecánica es responsabilidad
// individual?") a nivel de una noche entera, no solo de un pull.
export const PERSONAL_RESPONSIBILITY_CATEGORIES = new Set(['avoidable-ground', 'spread', 'soak', 'personal-target']);

function toDefensiveRefs(options: DefensiveOption[], status: DefensiveOption['status'], deathTimeMs?: number, castTimestamps?: Map<number, number[]>): import('../shared/models/ui').DefensiveRef[] {
  return options
    .filter((o) => o.status === status)
    .map((o) => {
      let closeToDeath: boolean | undefined;
      if (status === 'active' && deathTimeMs != null && castTimestamps) {
        const casts = castTimestamps.get(o.spellId) ?? [];
        closeToDeath = casts.some((t) => t <= deathTimeMs && deathTimeMs - t <= CLOSE_TO_DEATH_MS);
      }
      return { spellId: o.spellId, name: o.name, cooldownRemainingMs: o.cooldownRemainingMs ?? null, closeToDeath };
    });
}

function buildCallouts(
  pull: PullRow,
  records: PlayerPullRecordRow[],
  previousPull: PullRow | null,
  previousRecords: PlayerPullRecordRow[],
  priorPulls: PullRow[],
  priorRecordsByPullId: Map<string, PlayerPullRecordRow[]>,
  notesByMechanicName: Map<string, string>,
): CoachingCallout[] {
  const callouts: CoachingCallout[] = [];

  for (const r of records) {
    if (!r.died || !r.death_cause) continue;

    const excludedFromStatistics = isExcludedStatisticalDeath(pull, r);
    const options = excludedFromStatistics ? [] : (r.death_cause.defensiveOptions ?? []);
    const castTimestamps = new Map((r.defensive_casts ?? []).map((d) => [d.spellId, d.timestampsMs]));

    callouts.push({
      raiderName: r.player_name,
      raiderClass: r.class,
      severity: 'critical',
      mechanic: { label: mechanicLabel(r.death_cause), wowheadSpellId: r.death_cause.mechanicId || null },
      notes: (r.death_cause.mechanicName && notesByMechanicName.get(r.death_cause.mechanicName)) || null,
      timeLabel: formatTimeLabel(r.death_cause.timeMs),
      timeMs: r.death_cause.timeMs,
      isWipeCall: r.wipe_call_cluster && pull.wipe_call_excluded,
      statisticalExclusionReason: r.death_cause.statisticalExclusionReason ?? null,
      // 'unknown' (sin eventos de daño en la ventana) se queda en null —
      // honesto: no es lo mismo "sabemos que no fue un golpe único" que "no lo sabemos".
      oneshot: r.death_cause.damageProfile === 'unknown' ? null : r.death_cause.damageProfile === 'burst',
      damageWindowTotal: r.death_cause.damageWindowTotal,
      healingWindowTotal: r.death_cause.healingWindowTotal,
      // §"si tenía o no defensivo activo en el momento de la muerte, eso es
      // relevante para saber si usó algo o no": columna propia, separada de
      // "disponible sin usar" — aquí SÍ reaccionó (cast + duración real vs.
      // morir, o snapshot de buffs si la duración no se conoce todavía) y
      // aun así no bastó, historia de coaching bien distinta.
      defensivesActive: toDefensiveRefs(options, 'active', r.death_cause.timeMs, castTimestamps),
      defensivesAvailable: toDefensiveRefs(options, 'available_unused'),
      defensivesOnCooldown: toDefensiveRefs(options, 'on_cooldown', r.death_cause.timeMs, castTimestamps),
      provenance: {
        source: 'player_pull_records.death_cause',
        method: 'died=true + killingAbilityGameID, cruzado con el último snapshot de buffs a ≤2s de la muerte y con los Casts del jugador en todo el pull.',
        detail: buildDeathDetail(r.death_cause, r.consumables),
        wclReportCode: pull.report_code,
        wclFightId: pull.fight_id,
        damageTimeline: buildDamageTimeline(r.death_cause),
      },
    });
  }

  if (previousPull) {
    const olderPulls = priorPulls.slice(1); // pulls anteriores a previousPull, para medir la racha que se rompió
    for (const prev of previousRecords) {
      if (!prev.died || !prev.death_cause || isExcludedStatisticalDeath(previousPull, prev)) continue;
      const current = records.find((r) => r.player_name === prev.player_name);
      const stillFailing = current?.died && current.death_cause?.mechanicId === prev.death_cause.mechanicId;
      if (stillFailing) continue;
      const priorStreak = computeDeathStreak(prev.player_name, prev.death_cause.mechanicId, olderPulls, priorRecordsByPullId);
      const totalStreak = priorStreak + 1;
      if (totalStreak >= 2) {
        callouts.push({
          raiderName: prev.player_name,
          raiderClass: prev.class,
          severity: 'positive',
          mechanic: { label: prev.death_cause.mechanicName ?? 'esa mecánica', wowheadSpellId: prev.death_cause.mechanicId || null },
          notes: (prev.death_cause.mechanicName && notesByMechanicName.get(prev.death_cause.mechanicName)) || null,
          // Racha ROTA, no un instante de ESTE pull — sin minuto real que enseñar.
          timeLabel: '',
          timeMs: null,
          isWipeCall: false,
          statisticalExclusionReason: null,
          oneshot: null,
          damageWindowTotal: null,
          healingWindowTotal: null,
          defensivesActive: [],
          defensivesAvailable: [],
          defensivesOnCooldown: [],
          provenance: {
            source: 'player_pull_records (pulls anteriores)',
            method: `Racha de ${totalStreak} muertes consecutivas a la misma mecánica que no se repitió en este pull.`,
            detail: prev.player_name,
          },
        });
      }
    }
  }

  // §"la tabla de muertes debería estar ordenada por tiempo de muerte...
  // ahora mismo está caótico" (feedback real): antes solo se ordenaba por
  // severity (todas las muertes de este pull mezcladas entre sí en el orden
  // en que player_pull_records las devolvía la consulta, no el orden en que
  // ocurrieron). Cronológico dentro de cada grupo de severidad — las de
  // racha rota (timeMs null, no son un instante de este pull) se quedan al
  // final de su grupo, después de las que sí tienen un momento real.
  const severityOrder: Record<CoachingCallout['severity'], number> = { critical: 0, positive: 1 };
  return callouts.sort((a, b) => {
    const severityDelta = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDelta !== 0) return severityDelta;
    if (a.timeMs == null && b.timeMs == null) return 0;
    if (a.timeMs == null) return 1;
    if (b.timeMs == null) return -1;
    return a.timeMs - b.timeMs;
  });
}

/**
 * §"A QUIÉN DIRIGIR" pestaña Mecánicas: quién se comió una mecánica de
 * responsabilidad individual sin morir por ella — daño de esa instancia,
 * sanación recibida mientras duraba, y si hubo un cast propio pegado a ella
 * (player_hit_details, calculado en analyze-report). Un jugador que YA tiene
 * fila de muerte por esta misma mecánica no aparece aquí también — la
 * muerte ya lo cubre, con más detalle (pestaña Muertes).
 */
function buildMechanicFails(
  pull: PullRow,
  records: PlayerPullRecordRow[],
  mechEvents: PullMechanicEventRow[],
  notesByMechanicName: Map<string, string>,
): MechanicFailRow[] {
  const evaluatedDeaths = records.filter((r) => r.died && r.death_cause && !isExcludedStatisticalDeath(pull, r));
  const classByName = new Map(records.map((r) => [r.player_name, r.class]));

  const rows: MechanicFailRow[] = [];
  for (const ev of mechEvents) {
    if (ev.outcome === 'clean') continue;
    // §"no estamos evaluando bien las mecánicas que se fallan... y no
    // aparecen en dirección de personajes, en TODOS los bosses" (feedback
    // real, verificado en real: candidatas del manifiesto con category=null
    // E inferred_category=null — sync-boss-mechanics todavía no tuvo
    // evidencia real con la que sugerir nada). Antes `!ev.category` cortaba
    // aquí sin más, así que un fallo real (contado en la tarjeta "Mecánicas
    // falladas") desaparecía sin dejar rastro en "a quién dirigir". Ahora
    // solo se excluyen las categorías donde SÍ sabemos que no es
    // responsabilidad individual (confirmadas o inferidas) — null pasa, se
    // enseña marcado "sin clasificar" y el RL decide con el dato crudo
    // (cuánta gente golpeó) en vez de que se lo ocultemos.
    if (ev.category != null && !PERSONAL_RESPONSIBILITY_CATEGORIES.has(ev.category)) continue;
    for (const detail of ev.player_hit_details) {
      // Una muerte solo cubre ESTA instancia correlacionada. El Set antiguo
      // player|ability ocultaba también un fallo anterior de la misma spell,
      // justo el caso en el que después se canta wipe.
      const coveredByDeath = evaluatedDeaths.some(
        (record) =>
          record.player_name === detail.name &&
          record.death_cause!.mechanicId === ev.ability_id &&
          Math.abs(record.death_cause!.timeMs - ev.trigger_time_ms) <= MECHANIC_ATTRIBUTION_WINDOW_MS,
      );
      if (coveredByDeath) continue;
      rows.push({
        raiderName: detail.name,
        raiderClass: classByName.get(detail.name) ?? null,
        mechanic: { label: ev.mechanic_name, wowheadSpellId: ev.ability_id || null },
        // §"la 'i' que abra... 'notas'... la misma nota que se pone ahí"
        // (feedback real): se cruza por NOMBRE, no por ability_id — mismo
        // motivo que resync-mechanic-category.ts (el ability_id del
        // manifiesto casi nunca coincide con el real que guardó WCL aquí).
        notes: notesByMechanicName.get(ev.mechanic_name) ?? null,
        timeLabel: formatTimeLabel(ev.trigger_time_ms),
        outcome: ev.outcome as 'partial_fail' | 'fail',
        category: ev.category,
        totalPlayersHit: ev.players_hit,
        damageTaken: detail.damage_taken,
        healingReceived: detail.healing_received,
        usedDefensiveSpellId: detail.used_defensive_spell_id,
        provenance: {
          source: 'pull_mechanic_events.player_hit_details',
          method: `Instancia con outcome='${ev.outcome}' (categoría ${ev.category ?? 'sin clasificar todavía'}); daño = solo el de esta ability sobre este jugador en su ventana de reacción, sanación = recibida durante esa misma ventana, defensivo = cast propio en los ±10s alrededor.`,
          detail: [
            ev.category == null ? 'Sin categoría confirmada NI sugerida en el manifiesto todavía — clasifícala en Ajustes.' : null,
            ev.description ?? '(sin descripción en el manifiesto)',
            `${ev.players_hit} jugador(es) golpeados en esta instancia.`,
          ]
            .filter(Boolean)
            .join('\n'),
          wclReportCode: pull.report_code,
          wclFightId: pull.fight_id,
        },
      });
    }
  }

  const outcomeOrder: Record<MechanicFailRow['outcome'], number> = { fail: 0, partial_fail: 1 };
  return rows.sort((a, b) => outcomeOrder[a.outcome] - outcomeOrder[b.outcome]);
}
