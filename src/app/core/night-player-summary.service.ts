// Colocar en: src/app/core/night-player-summary.service.ts
// §"un resumen de una noche... para poder dirigir a uno o varios raiders"
// (feedback real): cruce nuevo que no existía en ningún sitio — jugador ×
// NOCHE completa (report_code), distinto de Roster (jugador × 60 días),
// "todos los pulls" (boss × toda la historia) y el detalle de jugador
// (jugador × toda la historia). Un dosier de personaje para esa noche
// concreta: qué hizo, cómo murió, patrones repetidos, y gear/talentos/
// enlaces para poder hablar con esa persona con todo el contexto delante.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { ReliabilityService, type PlayerReliability, type ReliabilityBreakdown, type ReliabilityInputRow } from './reliability.service';
import { WowauditRosterService, type WowauditRosterEntry } from './wowaudit-roster.service';
import { NightPlayerSummaryCacheService } from './night-player-summary-cache.service';
import { PULL_SCORE_FAIL_PENALTY, mapBrief, mechanicScoreFor } from './pull-analysis.service';
import {
  loadMechanicCoachingByKey,
  mechanicCoachingKey,
  type MechanicCoaching,
} from './mechanic-notes';
import { mechanicDisplayName } from '../shared/format.util';
import type { DeathCause, DefensivePressureWindow, MechanicCategory, PlayerPullRecordRow, PullMechanicEventRow, PullRow, WclGearItem } from '../shared/models/domain';
import type { LlmPullAnalysis } from '../shared/models/ui';
import { isDeathExcludedFromStatistics, isMechanicExcludedByWipeCall } from '../shared/death-statistics.util';
import { gearPreparationCounts } from '../shared/gear-preparation.util';
import { withSupabaseRelationFallback } from '../shared/supabase-query.util';
import { PERSONAL_RESPONSIBILITY_CATEGORIES } from '../shared/pull-consistency.util';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface NightPullSummary {
  pullId: string;
  pullNumber: number;
  /** §"wowanalyzer para mejorar las rotaciones... todo en nuestra app" (feedback real, 2026-08-27): id de fight de WCL, para enlazar directo a ese pull en la instancia local de WoWAnalyzer (ver supabase/wowanalyzer-app/). */
  fightId: number;
  bossId: string;
  bossName: string;
  difficulty: string;
  kill: boolean;
  wipePct: number | null;
  durationMs: number | null;
  closedAt: string;
  died: boolean;
  /** §"eso es obviamente un ninja pull... no debería contar para ninguna
   * estadística ni métrica" (feedback real, 2026-08-27): true si
   * analyze-report marcó este pull como ninja pull (ver
   * pulls.ninja_pull_excluded) — un pull ENTERO que no fue un intento real.
   * La fila se sigue mostrando en "Bosses de la noche" (mismo criterio que
   * el resto de la app: no se borra, se marca) pero pullScore es null y
   * nightScore lo ignora al promediar. NO incluye wipe call — ver
   * hadWipeCall más abajo, un wipe call nunca invalida el pull entero. */
  excludedFromStats: boolean;
  excludedReason: 'ninja_pull' | null;
  /** §CORRECCIÓN (feedback real, 2026-08-27): "el wipecall solo lo deben
   * tener los que, en efecto, murieron a consecuencia de que el RL lo
   * dijese... todo lo que suceda antes de ese momento debe ser evaluable" —
   * puramente informativo (tag en la UI), NUNCA anula pullScore ni
   * excludedFromStats. true solo si la muerte de ESTE jugador en concreto
   * fue la del cluster de wipe call (mismo criterio que isWipeCall en
   * NightDeathRow) — que el pull tuviera un wipe call de otra persona no
   * cuenta aquí. La exclusión real ya vive en evaluatedDeaths/
   * isMechanicExcludedByWipeCall (más abajo): solo descartan la muerte y
   * los eventos DESPUÉS del momento del wipe call, todo lo anterior sigue
   * evaluándose con normalidad. */
  hadWipeCall: boolean;
  /** §"puntuación compuesta... como wipefest" (feedback real, 2026-08-27): (mecánicas de responsabilidad individual + consumibles al morir) × penalización por momento de muerte. null si excludedFromStats — no hubo intento real que puntuar. Ver computePullScore más abajo para la fórmula completa. */
  pullScore: number | null;
  /** §"debería salir por qué ha obtenido esta puntuación" (feedback real, 2026-08-27): los ingredientes de pullScore, para el tooltip — no solo el número final. Se calcula igual aunque excludedFromStats (barato, y deja auditar qué había) — el componente solo lo enseña cuando pullScore no es null. */
  scoreBreakdown: PullScoreBreakdown;
}

export interface PullScoreBreakdown {
  mechanicFailCount: number;
  /** 0-1 — mismo mechanicScoreFor que usa Fiabilidad (ver pull-analysis.service.ts): ratio real para avoidable-ground/spread combinado con el conteo plano de siempre para soak/personal-target. */
  mechanicScore: number;
  /** §"consistente... contemplar muchas posibilidades distintas" (feedback real, 2026-08-28): instancias avoidable-ground/spread elegibles (seguía vivo) y cuántas de ellas fallaron, para poder explicar el ratio en el tooltip. null si esta fila no tenía el dato (fallback antiguo). */
  avoidableMechanicEligibleCount: number | null;
  avoidableMechanicFailCount: number | null;
  died: boolean;
  /** Solo tiene sentido si died=true — si no murió, el check se aprueba automático (mismo criterio que Wipefest). */
  usedConsumable: boolean;
  consumableScore: number;
  /** 1.0 si no murió; si murió, fracción del pull que estuvo vivo (0-1). */
  deathMultiplier: number;
  deathTimeMs: number | null;
  /** §"el hecho de no usar un defensivo debería ser penalización grande — siempre hay un motivo para usarlo" (feedback real, 2026-08-29): true si murió con un defensivo real de su catálogo libre y no lo lanzó (defensiveMissKind='death'), o si sobrevivió con ventanas de presión reales sin cubrir ('never_touched'/'mistimed', ver damage-pressure-windows.ts). */
  defensiveMissed: boolean;
  /** Multiplicador aplicado sobre toda la puntuación del intento cuando defensiveMissed=true — DEFENSIVE_MISS_PENALTY si murió, DEFENSIVE_NEVER_TOUCHED_PENALTY o DEFENSIVE_MISTIMED_PENALTY si sobrevivió. 1 si no aplica. */
  defensiveMissMultiplier: number;
  /** §"no es lo mismo usar 0 defensivos que usarlo a destiempo, lo primero
   * debe penalizar mucho y lo segundo debe penalizar un poco" (feedback
   * real, 2026-08-29): 'never_touched' = ninguna ventana cubierta Y cero
   * casts de su catálogo en todo el pull (penalización fuerte);
   * 'mistimed' = ninguna ventana cubierta pero SÍ hubo algún cast en el
   * pull, solo desincronizado (penalización ligera). */
  defensiveMissKind: 'death' | 'never_touched' | 'mistimed' | null;
  /** §"esa información debe ser verificable... tooltip o panel lateral"
   * (feedback real, 2026-08-29): las ventanas concretas que se fallaron —
   * momento, magnitud del pico, y qué tenía disponible — para que el
   * tooltip de puntuación pueda mostrar "dónde y por qué", no solo el
   * multiplicador. Vacío salvo que defensiveMissKind sea 'never_touched'/'mistimed'. */
  defensiveMissedWindows: NightPressureWindowMiss[];
}

export interface NightDeathRow {
  pullId: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  pullNumber: number;
  timeMs: number;
  mechanicName: string | null;
  /** §"un tooltip con la descripción de la habilidad, como en otras partes de la app" (feedback real): ability_id REAL de WCL para envolver el nombre en app-wowhead-link — null solo si WCL ni siquiera lo dio (rarísimo). */
  mechanicId: number | null;
  category: MechanicCategory | null;
  rootCause: DeathCause['rootCause'];
  /** §"que lo pueda usar efectiva y realmente porque lo tenga en sus habilidades y no esté en CD" (feedback real): exactamente status==='available_unused' — lo tiene en su catálogo real de clase/spec/talentos (defensivesForClass en analyze-report) Y no estaba en cooldown Y no lo tenía ya activo. Lista completa (no solo sí/no) para pintar los iconos reales. */
  defensivesAvailable: { spellId: number; name: string }[];
  isWipeCall: boolean;
  /** §"un ninja pull... también cuenta en la estadística de wipes": true = esta muerte ocurrió en un pull que analyze-report marcó como ninja pull (ver pulls.ninja_pull_excluded) — se sigue mostrando como contexto, pero no cuenta en totalDeaths ni en patrones repetidos. */
  isNinjaPull: boolean;
  statisticalExclusionReason: DeathCause['statisticalExclusionReason'];
  /** Uso registrado en cualquier momento del try. Es una observación factual; las muertes no evaluables siguen excluidas de estadísticas. */
  usedHealthstoneInPull: boolean;
  usedHealthPotionInPull: boolean;
  /** §"poner una 'I' de información junto a la mecánica con la nota descriptiva que haya traído la IA" (feedback real): solo la nota, cruzada por nombre — null si esta mecánica no tiene ai_classification en el manifiesto. */
  aiNote: string | null;
  /** Resolución revisada en Ajustes para este boss+dificultad exactos. */
  resolution: string | null;
  /** Perfil temporal del daño final calculado sobre eventos reales de WCL. */
  damageProfile: DeathCause['damageProfile'];
  burstHealthPct: number | null;
  killingBlowAmount: number | null;
  /** Ventana de 5 s anterior a la muerte; null si WCL no aportó eventos. */
  damageWindowTotal: number | null;
  damageWindowHits: number | null;
  /** Ventana de 6 s anterior a la muerte; null si no existe muestra temporal. */
  healingWindowTotal: number | null;
  healingWindowHits: number | null;
}

export interface NightMechanicFailRow {
  pullId: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  pullNumber: number;
  mechanicName: string;
  mechanicId: number;
  category: MechanicCategory | null;
  outcome: 'partial_fail' | 'fail';
  timeMs: number;
  damageTaken: number;
  aiNote: string | null;
  /** §"muestra el percentil + fuente" (feedback real, 2026-08-27): de dónde salió el umbral que marcó este fallo — ver resolveSeverity en _shared/mechanic-severity.ts. */
  comparisonSource: 'own_history' | 'world_reference' | 'fixed_threshold' | null;
  comparisonPercentile: number | null;
  /** Resolución revisada en Ajustes para este boss+dificultad exactos. */
  resolution: string | null;
}

// §"informe de mejora por jugador... wipefest para mejorar en el boss
// concreto" (feedback real, 2026-08-27): al contrario que mechanicFails
// (fallos), esto es una lista de ACIERTOS — qué interrumpió de verdad este
// jugador esa noche. Antes pull_mechanic_events no guardaba QUIÉN lanzó el
// interrupt (solo si se resolvió), así que esto no era posible con los
// datos que había — ver analyze-report/index.ts, InterruptEvent.sourceID.
export interface NightInterruptRow {
  pullId: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  pullNumber: number;
  mechanicName: string;
  mechanicId: number;
  timeMs: number;
  aiNote: string | null;
}

export interface NightRepeatedPattern {
  mechanicName: string;
  mechanicId: number | null;
  category: MechanicCategory | null;
  instanceCount: number;
  distinctBossCount: number;
  bossNames: string[];
  aiNote: string | null;
}

export interface NightGearSnapshot {
  fromPullNumber: number;
  bossName: string;
  class: string | null;
  spec: string | null;
  talents: { spellId: number; rank: number }[];
  talentUnresolvedCount: number;
  gear: { slot: number; itemId: number; itemLevel: number }[];
  enchantedSlotCount: number;
  enchantableSlotCount: number;
  gemmedSlotCount: number;
  gemmableSlotCount: number;
  gemCount: number;
}

export interface NightDefensiveCast {
  pullId: string;
  pullNumber: number;
  bossName: string;
  difficulty: string;
  spellId: number;
  spellName: string;
  /** Milisegundos desde el inicio del pull, tal como los registra WCL. */
  timeMs: number;
}

export interface NightDefensiveSpellSummary {
  spellId: number;
  spellName: string;
  castCount: number;
  pullCount: number;
  casts: NightDefensiveCast[];
}

export interface NightDefensiveSummary {
  totalCasts: number;
  pullsWithCasts: number;
  /** Pulls con presión verificable: daño evitable anómalo o muerte con catálogo defensivo. */
  pressurePulls: number;
  /** De esos pulls con presión, cuántos tuvieron al menos un cast defensivo antes del wipe call. */
  pressurePullsWithCast: number;
  deathsWithDefensiveAvailable: number;
  spells: NightDefensiveSpellSummary[];
  /** §"no es lo mismo usar 0 defensivos que usarlo a destiempo... guiar
   * indicando dónde hay que usarlo y por qué" (feedback real, 2026-08-29):
   * un elemento por pull evaluable con ventanas reales de presión (ver
   * damage-pressure-windows.ts) — excluye ninja pulls; las ventanas después
   * del wipe call ya no cuentan (mismo criterio que el resto de la app).
   */
  pressurePullBreakdown: NightPressurePullSummary[];
  /** §"agrupar por mecánica... una fila que se lea fácil... nada por el
   * camino" (feedback real, 2026-08-29): una fila por mecánica real del
   * boss (agregada de TODA la noche, no por pull) — sustituye a la tarjeta
   * por ventana. Incluye TODAS las ocurrencias (cubiertas y falladas,
   * también las de pulls con muerte — a diferencia de pressurePullBreakdown,
   * esto es informativo/patrón, no puntuación, así que no aplica la misma
   * exclusión).
   */
  mechanicPressureBreakdown: NightMechanicPressureSummary[];
}

export interface NightMechanicOccurrence {
  pullId: string;
  pullNumber: number;
  timeMs: number;
  covered: boolean;
  /** Qué defensivo concreto cubrió esta ocurrencia — null si no se cubrió, o si se cubrió pero no se pudo identificar cuál de varios activos a la vez fue. */
  coveredBySpellId: number | null;
  coveredBySpellName: string | null;
}

export interface NightMechanicDefensiveStat {
  spellId: number;
  name: string;
  /** Veces que este defensivo (no-emergencia) estaba libre cuando ocurrió esta mecánica. */
  timesAvailable: number;
  /** De esas, veces que fue el que de verdad la cubrió. */
  timesUsed: number;
}

export interface NightMechanicPressureSummary {
  mechanicId: number;
  mechanicName: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  /** Cruce contra el histórico de este boss+dificultad — ver computeMechanicTimingPattern. null si no hay patrón fiable que enseñar. */
  timingPattern: NightMechanicTimingPattern | null;
  /** TODAS las ocurrencias de esta mecánica esta noche, en orden cronológico — la base de la cuadrícula de estado. */
  occurrences: NightMechanicOccurrence[];
  coveredCount: number;
  totalCount: number;
  /** Solo defensivos no-emergencia — mismo criterio que el resto de esta sección (ver evaluateWindowCoverage). */
  defensives: NightMechanicDefensiveStat[];
}

export interface NightPressureWindowMiss {
  startMs: number;
  peakMs: number;
  peakValue: number;
  /** Solo las opciones `available_unused` que de verdad podía haber pulsado — 'emergency' sin usar queda fuera aunque estuviera disponible (no cuenta como el motivo del fallo, ver evaluateWindowCoverage). */
  availableOptions: { spellId: number; name: string; survivalType: string | null }[];
  /** §"relacionar 'pico de daño recibido' con una habilidad del boss, de forma veraz" (feedback real, 2026-08-29): la abilityGameID con más daño real dentro de la ventana — null si WCL no dio ningún evento en rango. */
  mechanicId: number | null;
  mechanicName: string | null;
  /** §"si el boss lanza la habilidad siempre en el mismo momento... o cada
   * X tiempo, podemos ponerlo también ahí para preparar el defensivo"
   * (feedback real, 2026-08-29): solo en pressurePullBreakdown (la lista de
   * la infografía) — el tooltip de puntuación no lo rellena, no hace falta
   * ahí. undefined = todavía no calculado (computePullScore no lo toca),
   * null = sí se calculó pero no hay patrón fiable que enseñar.
   */
  timingPattern?: NightMechanicTimingPattern | null;
}

export type NightMechanicTimingKind = 'fixed' | 'periodic';

export interface NightMechanicTimingPattern {
  kind: NightMechanicTimingKind;
  /** 'fixed': momento medio (ms desde el inicio del pull) en el que suele ocurrir. 'periodic': intervalo medio (ms) entre repeticiones. */
  ms: number;
  sampleSize: number;
}

export type NightPressurePullClassification = 'never_touched' | 'mistimed' | 'covered' | 'no_pressure';

export interface NightPressurePullSummary {
  pullId: string;
  pullNumber: number;
  bossId: string;
  bossName: string;
  difficulty: string;
  durationMs: number | null;
  /** Ventanas FALLADAS (coverable=true) de este pull — no el total de ventanas. Para el total, sumar con coveredCount. */
  missedCount: number;
  coveredCount: number;
  /** true = lanzó algo de su catálogo en algún momento del pull, aunque no cubriera ninguna ventana. */
  usedAnything: boolean;
  classification: NightPressurePullClassification;
  /** Solo las ventanas realmente falladas (coverable=true) — la evidencia concreta para "dónde y por qué". Vacío si classification no es 'never_touched'/'mistimed'. */
  missedWindows: NightPressureWindowMiss[];
}

export interface NightExecutionSnapshot {
  evaluatedPulls: number;
  cleanPulls: number;
  cleanPullRate: number | null;
  /** Instancias avoidable-ground/spread en las que seguía vivo y podía responder. */
  avoidableEligible: number;
  avoidableFailed: number;
  avoidableSucceeded: number;
  avoidableSuccessRate: number | null;
  /** Fallos individuales no letales + muertes de responsabilidad individual verificable. */
  actionableIncidents: number;
  actionableIncidentRatePer10: number | null;
  deathRatePer10: number | null;
  emergencyConsumableOpportunities: number;
  emergencyConsumableUses: number;
  emergencyConsumableUseRate: number | null;
}

export type NightEvolutionDirection = 'improved' | 'worsened' | 'stable';

export interface NightEvolutionMetric {
  key: 'execution' | 'clean-pulls' | 'avoidable-success' | 'personal-incidents' | 'deaths' | 'defensive-response' | 'consumables';
  label: string;
  current: number;
  previous: number;
  delta: number;
  direction: NightEvolutionDirection;
  unit: 'percent' | 'per10';
  /** Texto exacto del denominador para que el cambio pueda auditarse. */
  evidence: string;
}

export interface NightEvolutionMechanic {
  bossId: string;
  bossName: string;
  difficulty: string;
  mechanicId: number;
  mechanicName: string;
  previousCount: number;
  currentCount: number;
  previousPulls: number;
  currentPulls: number;
  direction: Exclude<NightEvolutionDirection, 'stable'>;
  resolution: string | null;
}

export interface NightEvolution {
  previousReportCode: string;
  previousReportTitle: string;
  previousReportDate: string;
  currentEvaluatedPulls: number;
  previousEvaluatedPulls: number;
  metrics: NightEvolutionMetric[];
  mechanics: NightEvolutionMechanic[];
}

export interface NightPlayerSummary {
  playerName: string;
  reportCode: string;
  reportTitle: string;
  reportDate: string;
  roster: WowauditRosterEntry | null;
  reliability: PlayerReliability | null;
  /** §"fiabilidad debería tener 2 valores: 60 días y de la noche" (feedback real): misma fórmula, acotada a los pulls de ESTE report_code. sampleSize=0 = sin ningún pull evaluable esa noche (no debería pasar si llegó hasta aquí, pero por si acaso). */
  nightReliability: (ReliabilityBreakdown & { sampleSize: number }) | null;
  pulls: NightPullSummary[];
  /** §"puntuación compuesta... como wipefest" (feedback real, 2026-08-27): media de pullScore ponderada por duración de pull, YA con nightDefensiveConsistency.multiplier aplicado — null solo si pulls está vacío (no debería pasar si llegó hasta aquí). */
  nightScore: number | null;
  /** §"debería escalar cuanto más pulls sin nada usado — no puedes tener una ejecución buenísima si no has usado NINGÚN defensivo en algún pull" (feedback real, 2026-08-29): la media ponderada por duración diluye un pull sin ningún cast si el resto de la noche fue limpia — este factor castiga la NOCHE completa, no el pull, y escala con cuántos pulls distintos tuvieron un defensivo libre sin usar (muerte o presión, cualquiera de los dos cuenta igual aquí — la severidad por tipo ya vive en el multiplicador de cada pull). */
  nightDefensiveConsistency: {
    missPullCount: number;
    multiplier: number;
    /** nightScore antes de aplicar multiplier — para poder explicar "de X% a Y%" en el tooltip. */
    rawScore: number | null;
  };
  totalDeaths: number;
  totalMechanicFails: number;
  deaths: NightDeathRow[];
  mechanicFails: NightMechanicFailRow[];
  interrupts: NightInterruptRow[];
  repeatedPatterns: NightRepeatedPattern[];
  gearSnapshot: NightGearSnapshot | null;
  /** Preparación al entrar a raid; evita penalizar un objeto equipado a mitad de noche. */
  startingPreparation: NightGearSnapshot | null;
  defensiveSummary: NightDefensiveSummary;
  execution: NightExecutionSnapshot;
  /** Comparación determinista con la noche anterior del jugador, si existe. */
  evolution: NightEvolution | null;
  battleNetUrl: string | null;
  raiderIoUrl: string | null;
  /** §"meter en el dosier de un jugador... la consulta de IA" (feedback real): cacheado desde night_player_briefs, null si nunca se ha generado. */
  brief: LlmPullAnalysis | null;
  /** §"preparar la vinculación de ese ID... con el dosier de ese raider" (feedback real, 2026-08-28): de discord_roster_channels (Ajustes → Discord), cruzado por wowaudit character_id — null = ese personaje no tiene ninguna vinculación de Discord guardada todavía. discordChannelId puede ser null aunque SÍ haya vinculación (Trial/oficial/pendiente del próximo "Sincronizar"), eso no es un error. */
  discordChannel: { discordChannelId: string | null; discordUserId: string; isOfficer: boolean } | null;
}

// §"región... viene en wowaudit" — wowaudit no da región, pero esta guild es
// EU de siempre (mismo dato ya hardcodeado en el header de la app,
// app.html: "Sanguino · EU") — no hay wowaudit_roster.region que leer.
const REGION = 'eu';

/** Re-exportado tal cual (ahora vive en pull-analysis.service.ts, ver el comentario ahí — reliability.service.ts también lo consume desde allí y no puede importarlo de aquí sin crear un ciclo) para no tocar el import existente en night-player-dossier.component.ts. */
export { PULL_SCORE_FAIL_PENALTY } from './pull-analysis.service';
const FAIL_PENALTY = PULL_SCORE_FAIL_PENALTY;

/** §"el hecho de no usar un defensivo debería ser penalización grande — siempre hay un motivo para usarlo" (feedback real, 2026-08-29): corta la puntuación del intento a la mitad, encima de mecánica/consumibles/deathMultiplier — no sustituye al resto de la fórmula, se apila sobre ella. Mismo dato verificado (status==='available_unused') que ya usa Fiabilidad para su eje defensiva; aquí se aplica directo al pull en vez de a un promedio de 60 días. */
export const DEFENSIVE_MISS_PENALTY = 0.5;
/** §"no es lo mismo usar 0 defensivos que usarlo a destiempo, lo primero
 * debe penalizar mucho" (feedback real, 2026-08-29): ventana(s) de presión
 * real (ver damage-pressure-windows.ts) sin cubrir Y cero casts de su
 * catálogo en TODO el pull — señal real pero menos concluyente que morir
 * con el botón libre en la mano, así que pesa menos que DEFENSIVE_MISS_PENALTY. */
export const DEFENSIVE_NEVER_TOUCHED_PENALTY = 0.75;
/** §"...y lo segundo debe penalizar un poco pero guiar para corregirlo"
 * (feedback real, 2026-08-29): ventana(s) sin cubrir, pero SÍ hubo algún
 * cast de su catálogo en el pull — lo intentó, solo desincronizado. La
 * corrección real vive en el tooltip (defensiveMissedWindows), no en el
 * multiplicador — deliberadamente el más suave de los tres. */
export const DEFENSIVE_MISTIMED_PENALTY = 0.9;
/** §"debería escalar cuanto más pulls sin nada usado" (feedback real,
 * 2026-08-29): −8 puntos porcentuales sobre nightScore por cada pull
 * distinto (muerte o CERO defensivos tocados) con presión real sin cubrir
 * esa noche — 1 ya se nota, varios se acumulan. 'mistimed' NO escala aquí a
 * propósito: ya mostró que lo intenta, la noche entera no debe hundirse por
 * timing imperfecto igual que por desconexión total. */
export const NIGHT_DEFENSIVE_ESCALATION_STEP = 0.08;
/** Suelo del factor de consistencia defensiva: por muchos pulls sin defensivo que acumule, este factor solo no baja de aquí (los multiplicadores por pull ya hacen su parte además de este). */
export const NIGHT_DEFENSIVE_ESCALATION_FLOOR = 0.5;

const MECHANIC_EVENT_FIELDS = 'pull_id, ability_id, mechanic_name, category, outcome, trigger_time_ms, player_hit_details, comparison_source, comparison_percentile';

async function loadPlayerMechanicEvents(client: SupabaseClient, pullIds: string[], playerName: string) {
  const query = (relation: string) => client
    .from(relation)
    .select(MECHANIC_EVENT_FIELDS)
    .in('pull_id', pullIds)
    .neq('outcome', 'clean')
    .contains('players_hit_names', [playerName]);

  // Compatibilidad durante despliegues escalonados: la vista nueva aplica el
  // filtro de dificultad en servidor. Hasta que exista, conservamos el dosier
  // con los eventos base; las exclusiones por wipe call aún se aplican abajo.
  return withSupabaseRelationFallback(
    'applicable_pull_mechanic_events',
    () => query('applicable_pull_mechanic_events'),
    () => query('pull_mechanic_events'),
  );
}

const INTERRUPT_EVENT_FIELDS = 'pull_id, ability_id, mechanic_name, trigger_time_ms';

/** Mecánicas category='interrupt' que ESTE jugador cortó (outcome='clean' + su nombre en players_hit_names — ver analyze-report/index.ts). */
async function loadPlayerInterrupts(client: SupabaseClient, pullIds: string[], playerName: string) {
  const query = (relation: string) => client
    .from(relation)
    .select(INTERRUPT_EVENT_FIELDS)
    .in('pull_id', pullIds)
    .eq('category', 'interrupt')
    .eq('outcome', 'clean')
    .contains('players_hit_names', [playerName]);

  return withSupabaseRelationFallback(
    'applicable_pull_mechanic_events',
    () => query('applicable_pull_mechanic_events'),
    () => query('pull_mechanic_events'),
  );
}

function slugifyRealm(realm: string): string {
  return realm
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '') // fuera de ASCII tras NFKD = marcas diacríticas
    .toLowerCase()
    // §mismo bug real encontrado en blizzard-client.ts (verificado: solo
    // 18/30 avatares resolvían) — el slug oficial ELIMINA el apóstrofe
    // ("C'Thun" -> "cthun"), no lo convierte en guión.
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Media y coeficiente de variación (desviación típica / media) — null si la media es 0 (evita una división por cero, no una mecánica real). Ver enrichTimingPatterns más abajo. */
function meanAndCv(values: number[]): { mean: number; cv: number } | null {
  if (!values.length) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, cv: Math.sqrt(variance) / mean };
}

@Injectable({ providedIn: 'root' })
export class NightPlayerSummaryService {
  private supabase = inject(SupabaseService);
  private reliability = inject(ReliabilityService);
  private wowauditRoster = inject(WowauditRosterService);
  private summaryCache = inject(NightPlayerSummaryCacheService);

  /**
   * §"no todos los días tenemos raid... tiene sentido que actualice una
   * única vez cuando termina la raid" (feedback real, 2026-08-29): antes de
   * recalcular todo (fiabilidad de 60 días, mecánicas de la noche, y la
   * recursión de Evolución que repite todo esto para la noche anterior),
   * comprueba si ya hay un snapshot guardado con el mismo fingerprint que
   * Roster (último pull, último pull corregido, último report, roster) — si
   * nada de eso cambió desde que se guardó, el resultado es idéntico y se
   * devuelve tal cual, sin tocar Supabase. `forceRefresh` (botón
   * "Actualizar" del dosier) se salta la lectura de caché pero SIGUE
   * escribiendo el resultado fresco al final, para que la próxima visita
   * normal ya lo encuentre.
   */
  async load(
    reportCode: string,
    playerName: string,
    includeEvolution = true,
    forceRefresh = false,
  ): Promise<NightPlayerSummary> {
    const fingerprint = await this.summaryCache.fingerprint().catch(() => null);
    if (!forceRefresh && fingerprint) {
      const cached = this.summaryCache.read(reportCode, playerName);
      if (cached && cached.fingerprint === fingerprint) return cached.summary;
    }

    const client = this.supabase.client;

    const [{ data: reportRow }, { data: pullsData, error: pullsErr }, { data: encounters }] = await Promise.all([
      client.from('reports').select('title, start_time').eq('code', reportCode).maybeSingle(),
      client.from('pulls').select('*').eq('report_code', reportCode).order('fight_id', { ascending: true }),
      client.from('report_encounters').select('fight_id, boss_name').eq('report_code', reportCode),
    ]);
    if (pullsErr) throw pullsErr;

    const bossNameByFightId = new Map(((encounters ?? []) as { fight_id: number; boss_name: string }[]).map((e) => [e.fight_id, e.boss_name]));
    const allPulls = (pullsData ?? []) as (PullRowLite & { fight_id: number })[];
    const pullIds = allPulls.map((p) => p.id);

    const [{ data: recordsData, error: recordsErr }, { data: mechEventsData, error: mechErr }, { data: interruptEventsData, error: interruptErr }, roster, reliabilityEntry, coachingByMechanicKey, { data: briefRow }, reliabilityInputRows, nightReliability] = await Promise.all([
      pullIds.length
        ? client.from('player_pull_records').select('*').in('pull_id', pullIds).eq('player_name', playerName)
        : Promise.resolve({ data: [] as PlayerPullRecordRow[], error: null }),
      pullIds.length
        ? loadPlayerMechanicEvents(client, pullIds, playerName)
        : Promise.resolve({ data: [] as MechEventRowLite[], error: null }),
      pullIds.length
        ? loadPlayerInterrupts(client, pullIds, playerName)
        : Promise.resolve({ data: [] as InterruptEventRowLite[], error: null }),
      this.wowauditRoster.listRoster().catch(() => []),
      // §rendimiento (2026-08-29): "el dosier tarda muchísimo" (feedback
      // real) — antes listPlayerReliability() calculaba la fiabilidad de
      // TODA la guild (60 días + su evidencia completa: player_pull_records/
      // pulls/known_raid_bosses de todos los raiders) solo para quedarse con
      // .find(playerName). getPlayerReliability sale ya filtrado por
      // jugador en el propio SQL, misma fórmula (ver reliability.service.ts).
      this.reliability.getPlayerReliability(playerName).catch(() => null),
      loadMechanicCoachingByKey(client, allPulls.map((p) => p.boss_id)).catch(
        () => new Map<string, MechanicCoaching>(),
      ),
      client.from('night_player_briefs').select('*').eq('report_code', reportCode).eq('player_name', playerName).maybeSingle(),
      // §"consistente... contemplar muchas posibilidades distintas"
      // (feedback real, 2026-08-28): MISMAS filas que ya usa Fiabilidad
      // (avoidable_mechanic_eligible_count/avoidable_mechanic_fail_count/
      // personal_mechanic_fail_count) — computePullScore las reutiliza vía
      // mechanicScoreFor en vez de re-derivar el ratio con su propia
      // lógica, así los dos sistemas nunca pueden divergir en "Mecánica".
      this.reliability.getPlayerPullReliabilityInputsForReport(reportCode, playerName).catch(() => []),
      // §rendimiento (2026-08-29): antes se esperaba SECUENCIALMENTE después
      // de este Promise.all sin motivo — no depende de nada de aquí, solo de
      // reportCode/playerName, así que corre en paralelo con todo lo demás.
      this.reliability.getNightReliability(reportCode, playerName).catch(() => null),
    ]);
    const reliabilityInputByPullId = new Map(reliabilityInputRows.map((r) => [r.pull_id, r]));
    if (recordsErr) throw recordsErr;
    if (mechErr) throw mechErr;
    if (interruptErr) throw interruptErr;

    const records = (recordsData ?? []) as PlayerPullRecordRow[];
    const recordByPullId = new Map(records.map((r) => [r.pull_id, r]));
    const pullById = new Map(allPulls.map((p) => [p.id, p]));
    const coachingFor = (
      pull: Pick<PullRowLite, 'boss_id' | 'difficulty'>,
      mechanicName: string | null | undefined,
    ): MechanicCoaching =>
      mechanicName
        ? (coachingByMechanicKey.get(
            mechanicCoachingKey(pull.boss_id, pull.difficulty, mechanicName),
          ) ?? { note: null, resolution: null })
        : { note: null, resolution: null };

    // §"no es lo mismo usar 0 defensivos que usarlo a destiempo... esa
    // información debe ser verificable" (feedback real, 2026-08-29): UN
    // único sitio evalúa las ventanas de presión reales de este jugador en
    // un pull — computePullScore lo usa para el multiplicador (con tooltip
    // verificable, ver dossier.component.ts), y defensiveSummary más abajo
    // reutiliza EXACTAMENTE el mismo resultado para el desglose de la
    // infografía. Misma fuente, mismo resultado — no pueden divergir.
    // Factorizado de pressureWindowEvaluation para que buildMechanicPressureBreakdown
    // (agregado por MECÁNICA, toda la noche) reutilice el mismo recorte de
    // wipe call que ya usa la evaluación por pull — un cast/ventana después
    // del wipe call no cuenta como evaluable en ningún sitio de esta app.
    function evaluableWindowsForPull(pullId: string): DefensivePressureWindow[] {
      const record = recordByPullId.get(pullId);
      const pull = pullById.get(pullId);
      const wipeCallStartMs =
        pull?.wipe_call_excluded && typeof pull.wipe_call_signals?.['wipeCallStartMs'] === 'number'
          ? (pull.wipe_call_signals['wipeCallStartMs'] as number)
          : null;
      return (record?.defensive_pressure_windows?.windows ?? []).filter(
        (w) => wipeCallStartMs == null || w.startMs < wipeCallStartMs,
      );
    }

    function pressureWindowEvaluation(pullId: string): {
      coverableWindows: DefensivePressureWindow[];
      coveredCount: number;
      usedAnything: boolean;
    } {
      const record = recordByPullId.get(pullId);
      const pull = pullById.get(pullId);
      const wipeCallStartMs =
        pull?.wipe_call_excluded && typeof pull.wipe_call_signals?.['wipeCallStartMs'] === 'number'
          ? (pull.wipe_call_signals['wipeCallStartMs'] as number)
          : null;
      const evaluableWindows = evaluableWindowsForPull(pullId);
      const usedAnything = (record?.defensive_casts ?? []).some((d) =>
        d.timestampsMs.some((t) => wipeCallStartMs == null || t < wipeCallStartMs),
      );
      return {
        coverableWindows: evaluableWindows.filter((w) => w.coverable),
        coveredCount: evaluableWindows.filter((w) => w.covered).length,
        usedAnything,
      };
    }
    const bossOrder = new Map<string, number>();
    for (const pull of allPulls) {
      if (!bossOrder.has(pull.boss_id)) bossOrder.set(pull.boss_id, bossOrder.size);
    }

    // Solo los pulls donde este jugador de verdad participó (tiene fila en
    // player_pull_records) — un report puede tener bosses/pulls donde
    // estuvo de bench, no tiene sentido enseñarlos en su dosier.
    // pullScore se calcula en un segundo paso (necesita mechanicFails/deaths,
    // que todavía no existen aquí) — ver pullsWithScore más abajo.
    const pulls: Omit<NightPullSummary, 'pullScore' | 'scoreBreakdown'>[] = allPulls
      .filter((p) => recordByPullId.has(p.id))
      .map((p) => {
        const r = recordByPullId.get(p.id)!;
        // §"eso es obviamente un ninja pull... no debería contar para
        // ninguna estadística ni métrica" (feedback real, 2026-08-27): antes
        // "Bosses de la noche"/pullScore/nightScore incluían TODOS los
        // pulls sin mirar ninja_pull_excluded (ese flag solo se leía para
        // deaths/mechanicFails más abajo) — un enganche de 16s al 100% de
        // vida del boss puntuaba igual que un intento real. Mismo criterio
        // que el resto de la app: la fila NO se borra (se sigue viendo qué
        // pasó), solo se excluye del cálculo.
        //
        // §CORRECCIÓN (feedback real, 2026-08-27): "el wipecall solo lo
        // deben tener los que, en efecto, murieron a consecuencia de que el
        // RL lo dijese... todo lo que suceda antes de ese momento debe ser
        // evaluable" — wipe_call_excluded es un flag de TODO EL PULL (hubo
        // un wipe call en algún momento, de ALGUIEN), no significa que este
        // pull entero ni que ESTE jugador en concreto sea el que se dejó
        // morir. Por eso NO entra aquí (a diferencia de ninja_pull, que sí
        // invalida el pull completo) — un intento real de 3 minutos con
        // daño real al boss (caso real reportado: Coiled Altar #7/#8) no
        // deja de ser evaluable solo porque alguien más muriera en un wipe
        // call al final. La exclusión fina YA existe más abajo y es la
        // correcta: evaluatedDeaths descarta la muerte-wipe-call concreta
        // (no cuenta como "murió" para deathMultiplier/consumableScore) e
        // isMechanicExcludedByWipeCall descarta solo los eventos de
        // mecánica DESPUÉS del momento del wipe call — todo lo de antes
        // (mecánicas falladas de cualquiera, incluido este jugador) se
        // sigue contando, tal como debe ser.
        const excludedReason: 'ninja_pull' | null = p.ninja_pull_excluded ? 'ninja_pull' : null;
        return {
          pullId: p.id,
          pullNumber: p.pull_number,
          fightId: p.fight_id,
          bossId: p.boss_id,
          bossName: bossNameByFightId.get(p.fight_id) ?? `Boss ${p.boss_id}`,
          difficulty: p.difficulty,
          kill: p.wipe_pct === 0,
          wipePct: p.wipe_pct,
          durationMs: p.duration_ms,
          closedAt: p.closed_at,
          died: r.died,
          excludedFromStats: excludedReason != null,
          excludedReason,
          // §informativo solamente (ver arriba) — nunca anula pullScore.
          // Mismo criterio que isWipeCall más abajo: solo cuenta como "wipe
          // call de ESTE jugador" si SU muerte fue la del cluster, no basta
          // con que el pull tuviera un wipe call de alguien más.
          hadWipeCall: !!r.wipe_call_cluster && p.wipe_call_excluded,
        };
      });

    // §"esa gente no debería... contar como muerte, marcado como wipe
    // call" — mismo criterio que ya rige el resto de la app.
    const deaths: NightDeathRow[] = records
      .filter((r) => r.died && r.death_cause)
      .map((r) => {
        const pull = pullById.get(r.pull_id)!;
        const dc = r.death_cause!;
        const coaching = coachingFor(pull, dc.mechanicName);
        const isWipeCall = r.wipe_call_cluster && pull.wipe_call_excluded;
        const isNinjaPull = pull.ninja_pull_excluded;
        const excludedFromStatistics = isDeathExcludedFromStatistics(pull as PullRow, r);
        return {
          pullId: r.pull_id,
          bossId: pull.boss_id,
          bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
          difficulty: pull.difficulty,
          pullNumber: pull.pull_number,
          timeMs: dc.timeMs,
          // §"unknown ability pon: unknown cause - WC" (feedback real):
          // transformado aquí, en el ORIGEN — así todo lo que se construye a
          // partir de esta fila (la propia tabla de Muertes, y sobre todo
          // repeatedPatterns más abajo, que agrupa por este mismo string)
          // hereda el nombre legible sin tener que acordarse de envolverlo
          // en cada sitio donde se use.
          mechanicName: mechanicDisplayName(dc.mechanicName),
          mechanicId: dc.mechanicId || null,
          category: dc.category ?? null,
          rootCause: dc.rootCause,
          defensivesAvailable: excludedFromStatistics ? [] : (dc.defensiveOptions ?? []).filter((o) => o.status === 'available_unused').map((o) => ({ spellId: o.spellId, name: o.name })),
          isWipeCall,
          isNinjaPull,
          statisticalExclusionReason: dc.statisticalExclusionReason ?? null,
          usedHealthstoneInPull: r.consumables?.healthstone?.used === true || (r.consumables?.healthstone?.timestampsMs?.length ?? 0) > 0,
          usedHealthPotionInPull: r.consumables?.healthPotion?.used === true || (r.consumables?.healthPotion?.timestampsMs?.length ?? 0) > 0,
          aiNote: coaching.note,
          resolution: coaching.resolution,
          damageProfile: dc.damageProfile,
          burstHealthPct: dc.burstHealthPct ?? null,
          killingBlowAmount: dc.killingBlowAmount,
          damageWindowTotal: dc.damageProfile === 'unknown' ? null : dc.damageWindowTotal,
          damageWindowHits: dc.damageProfile === 'unknown' ? null : dc.damageWindowHits,
          healingWindowTotal: dc.damageProfile === 'unknown' ? null : dc.healingWindowTotal,
          healingWindowHits: dc.damageProfile === 'unknown' ? null : dc.healingWindowHits,
        };
      })
      .sort((a, b) => {
        const aPull = pullById.get(a.pullId)!;
        const bPull = pullById.get(b.pullId)!;
        return (bossOrder.get(aPull.boss_id) ?? 0) - (bossOrder.get(bPull.boss_id) ?? 0) || a.pullNumber - b.pullNumber || a.timeMs - b.timeMs;
      });

    // §"mecánicas falladas... a quién dirigir" a nivel de una noche entera:
    // mismo criterio que buildMechanicFails (categorías de responsabilidad
    // individual, o sin clasificar todavía) — no se descarta una muerte ya
    // cubierta arriba, para no duplicar la misma instancia dos veces.
    const evaluatedDeaths = deaths.filter((death) => !death.isWipeCall && !death.isNinjaPull && !death.statisticalExclusionReason);
    const mechanicFails: NightMechanicFailRow[] = ((mechEventsData ?? []) as MechEventRowLite[])
      .filter((ev) => {
        const pull = pullById.get(ev.pull_id);
        return pull != null && !pull.ninja_pull_excluded && !isMechanicExcludedByWipeCall(pull as PullRow, ev as PullMechanicEventRow);
      })
      .filter((ev) => ev.category == null || PERSONAL_RESPONSIBILITY_CATEGORIES.has(ev.category))
      .map((ev) => {
        const pull = pullById.get(ev.pull_id)!;
        const detail = ev.player_hit_details.find((d) => d.name === playerName);
        const coaching = coachingFor(pull, ev.mechanic_name);
        return {
          pullId: ev.pull_id,
          bossId: pull.boss_id,
          bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
          difficulty: pull.difficulty,
          pullNumber: pull.pull_number,
          mechanicName: ev.mechanic_name,
          mechanicId: ev.ability_id,
          category: ev.category,
          outcome: ev.outcome as 'partial_fail' | 'fail',
          timeMs: ev.trigger_time_ms,
          damageTaken: detail?.damage_taken ?? 0,
          comparisonSource: ev.comparison_source,
          comparisonPercentile: ev.comparison_percentile,
          aiNote: coaching.note,
          resolution: coaching.resolution,
        };
      })
      .filter((row) => !evaluatedDeaths.some((death) => death.pullId === row.pullId && death.mechanicId === row.mechanicId && Math.abs(death.timeMs - row.timeMs) <= 4000))
      .sort((a, b) => {
        const aPull = pullById.get(a.pullId)!;
        const bPull = pullById.get(b.pullId)!;
        return (bossOrder.get(aPull.boss_id) ?? 0) - (bossOrder.get(bPull.boss_id) ?? 0) || a.pullNumber - b.pullNumber || a.timeMs - b.timeMs;
      });

    // §"puntuación compuesta... como wipefest" (feedback real, 2026-08-27):
    // "puntos ganados/posibles ponderados por importancia... si mueres, la
    // puntuación entera se multiplica por el % del fight que estuviste
    // vivo... piedra/pociones aprobado automático si no mueres" — investigado
    // y confirmado en real (ver historial de la conversación). Adaptado, no
    // copiado: IRIS registra QUIÉN golpeó cada instancia de mecánica, no un
    // roster completo de aprobado/suspendido por jugador (Wipefest sí lo
    // tiene) — sin ese denominador, mechanicScore es un PENALIZADOR por
    // fallo (no un ratio puntos-ganados/posibles literal), fiel al concepto
    // sin fingir una precisión que estos datos no dan. Mismo criterio que
    // Wipefest en consumibles: solo se evalúa piedra/poción SI murió.
    const mechanicFailCountByPullId = new Map<string, number>();
    for (const fail of mechanicFails) {
      mechanicFailCountByPullId.set(fail.pullId, (mechanicFailCountByPullId.get(fail.pullId) ?? 0) + 1);
    }
    const evaluatedDeathByPullId = new Map(evaluatedDeaths.map((death) => [death.pullId, death]));
    // §"al pasar el ratón por encima de puntuación, debería salir por qué ha
    // obtenido esta puntuación... no se tiene contexto para mejorar"
    // (feedback real, 2026-08-27): devuelve el desglose, no solo el número
    // final — un único sitio calcula la fórmula Y explica de qué está hecha,
    // para que el componente no tenga que duplicar FAIL_PENALTY/pesos para
    // pintar el tooltip.
    function computePullScore(pull: { pullId: string; durationMs: number | null }): { score: number; breakdown: PullScoreBreakdown } {
      const death = evaluatedDeathByPullId.get(pull.pullId);
      // §"consistente... contemplar muchas posibilidades distintas"
      // (feedback real, 2026-08-28): MISMA fórmula/fuente que el eje
      // Mecánica de Fiabilidad (reliability.service.ts) — ver
      // mechanicScoreFor en pull-analysis.service.ts. Sin fila para este
      // pull (no debería pasar salvo un fallo de red puntual) se cae al
      // conteo plano derivado en cliente, nunca a "0 fallos" silencioso.
      const reliabilityRow = reliabilityInputByPullId.get(pull.pullId);
      const mechanicFailCount = reliabilityRow?.personal_mechanic_fail_count ?? mechanicFailCountByPullId.get(pull.pullId) ?? 0;
      const mechanicScore = reliabilityRow
        ? mechanicScoreFor({
            personalMechanicFailCount: reliabilityRow.personal_mechanic_fail_count,
            avoidableMechanicEligibleCount: reliabilityRow.avoidable_mechanic_eligible_count,
            avoidableMechanicFailCount: reliabilityRow.avoidable_mechanic_fail_count,
            hadAvoidableDamage: reliabilityRow.had_avoidable_damage,
            selfPositioningDeath: reliabilityRow.self_positioning_death,
          })
        : Math.max(0, 1 - mechanicFailCount * FAIL_PENALTY);
      const usedConsumable = death ? death.usedHealthstoneInPull || death.usedHealthPotionInPull : false;
      const consumableScore = !death ? 1 : usedConsumable ? 1 : 0;
      const deathMultiplier = death && pull.durationMs ? Math.min(1, Math.max(0, death.timeMs / pull.durationMs)) : 1;
      // §"siempre hay un motivo para usarlo" (feedback real, 2026-08-29):
      // defensivesAvailable ya es exactamente status==='available_unused'
      // (catálogo real de la clase, sin cooldown, sin estar ya activo) — no
      // "podría haber usado algo", sino "tenía el botón libre y no lo tocó".
      const deathDefensiveMissed = !!death && death.defensivesAvailable.length > 0;
      // §CORRECCIÓN (feedback real, 2026-08-29): "si ponemos que ha
      // empeorado en defensivo bajo presión, ¿cómo tiene un 90%?" — la
      // primera versión de este penalizador solo miraba muertes, así que un
      // jugador que sobrevive TODOS sus pulls de presión sin lanzar un solo
      // defensivo salía gratis. §"no es lo mismo usar 0 defensivos que
      // usarlo a destiempo" (feedback real, 2026-08-29): ventanas de presión
      // reales (pressureWindowEvaluation, arriba) en vez del booleano
      // defensive_use_opportunity/used_defensive_in_pull — solo cuando NO
      // hubo muerte en el pull, para no evaluar dos veces la misma ventana
      // con dos criterios distintos.
      const pressureEval = death ? null : pressureWindowEvaluation(pull.pullId);
      const neverTouchedMissed = !!pressureEval && pressureEval.coverableWindows.length > 0 && !pressureEval.usedAnything;
      const mistimedMissed = !!pressureEval && pressureEval.coverableWindows.length > 0 && pressureEval.usedAnything;
      const defensiveMissed = deathDefensiveMissed || neverTouchedMissed || mistimedMissed;
      // Tres niveles de severidad, no dos: morir con uno libre en la mano es
      // el fallo verificado más grave; no tocar NADA en todo un pull con
      // presión real pesa bastante también; ir a destiempo (sí lo intentó,
      // mal sincronizado) es la señal más débil de las tres — penaliza poco
      // a propósito, la corrección real vive en defensiveMissedWindows
      // (tooltip), no en un multiplicador grande.
      const defensiveMissMultiplier = deathDefensiveMissed
        ? DEFENSIVE_MISS_PENALTY
        : neverTouchedMissed
          ? DEFENSIVE_NEVER_TOUCHED_PENALTY
          : mistimedMissed
            ? DEFENSIVE_MISTIMED_PENALTY
            : 1;
      const defensiveMissKind: PullScoreBreakdown['defensiveMissKind'] = deathDefensiveMissed
        ? 'death'
        : neverTouchedMissed
          ? 'never_touched'
          : mistimedMissed
            ? 'mistimed'
            : null;
      const defensiveMissedWindows: NightPressureWindowMiss[] = (pressureEval?.coverableWindows ?? []).map((w) => ({
        startMs: w.startMs,
        peakMs: w.peakMs,
        peakValue: w.peakValue,
        mechanicId: w.mechanicId,
        mechanicName: w.mechanicName,
        // §bug real encontrado en auditoría (2026-08-29): esta ventana solo
        // es "coverable" (un fallo real) porque había una opción NO
        // emergencia disponible — evaluateWindowCoverage excluye
        // deliberadamente 'emergency' de esa cuenta (guardarlo suele ser lo
        // correcto). Si aquí se listaban también las emergencia sin
        // distinguir, el tooltip podía mezclar "Lay on Hands disponible"
        // (no cuenta) junto a la opción real que sí causó el fallo — y
        // survivalTypeLabel(options[0]) podía coger justo la de emergencia y
        // decir "vale guardarlo" sobre una ventana que SÍ era un fallo real.
        availableOptions: w.options
          .filter((o) => o.status === 'available_unused' && o.survivalType !== 'emergency')
          .map((o) => ({ spellId: o.spellId, name: o.name, survivalType: o.survivalType })),
      }));
      const score =
        Math.round((mechanicScore * 0.7 + consumableScore * 0.3) * deathMultiplier * defensiveMissMultiplier * 1000) / 1000;
      return {
        score,
        breakdown: {
          mechanicFailCount,
          mechanicScore,
          avoidableMechanicEligibleCount: reliabilityRow?.avoidable_mechanic_eligible_count ?? null,
          avoidableMechanicFailCount: reliabilityRow?.avoidable_mechanic_fail_count ?? null,
          died: !!death,
          usedConsumable,
          consumableScore,
          deathMultiplier,
          deathTimeMs: death?.timeMs ?? null,
          defensiveMissed,
          defensiveMissMultiplier,
          defensiveMissKind,
          defensiveMissedWindows,
        },
      };
    }
    const pullsWithScore: NightPullSummary[] = pulls.map((p) => {
      const { score, breakdown } = computePullScore(p);
      return { ...p, pullScore: p.excludedFromStats ? null : score, scoreBreakdown: breakdown };
    });
    // §"no debería contar para ninguna estadística ni métrica" (feedback
    // real, 2026-08-27): ninja pulls/wipe calls tempranos quedan fuera de
    // la media — ni de la ponderada por duración ni del denominador de
    // pulls, igual que ya se excluían de deaths/mechanicFails más arriba.
    // Media ponderada por duración (un pull de 8 min pesa más que uno de 40s
    // en la impresión "de qué tal fue la noche") — 0 si algún pull evaluable
    // no tiene duración registrada, mejor que sesgar la media ignorándolo en silencio.
    const scoredPulls = pullsWithScore.filter((p): p is NightPullSummary & { pullScore: number } => p.pullScore != null);
    const totalDurationMs = scoredPulls.reduce((sum, p) => sum + (p.durationMs ?? 0), 0);
    const rawNightScore = scoredPulls.length
      ? totalDurationMs > 0
        ? Math.round((scoredPulls.reduce((sum, p) => sum + p.pullScore * (p.durationMs ?? 0), 0) / totalDurationMs) * 1000) / 1000
        : Math.round((scoredPulls.reduce((sum, p) => sum + p.pullScore, 0) / scoredPulls.length) * 1000) / 1000
      : null;
    // §"no puedes tener una ejecución buenísima si no has usado NINGÚN
    // defensivo en algún pull" (feedback real, 2026-08-29): sin esto, un
    // jugador con 8 pulls perfectos y 2 sin ningún defensivo seguía saliendo
    // "excelente" en la media ponderada — el multiplicador de cada pull
    // castiga ESE pull, esto castiga la noche entera y escala con cuántos
    // pulls distintos lo hicieron. §"lo segundo debe penalizar un poco"
    // (feedback real, 2026-08-29): 'mistimed' queda fuera a propósito — ya
    // demostró que lo intenta, no debe compuesto contra la noche entera
    // igual que morir o no tocar nada.
    const defensiveMissPullCount = scoredPulls.filter(
      (p) => p.scoreBreakdown.defensiveMissKind === 'death' || p.scoreBreakdown.defensiveMissKind === 'never_touched',
    ).length;
    const nightDefensiveConsistencyMultiplier = Math.max(
      NIGHT_DEFENSIVE_ESCALATION_FLOOR,
      1 - defensiveMissPullCount * NIGHT_DEFENSIVE_ESCALATION_STEP,
    );
    const nightScore = rawNightScore == null ? null : Math.round(rawNightScore * nightDefensiveConsistencyMultiplier * 1000) / 1000;
    const nightDefensiveConsistency = {
      missPullCount: defensiveMissPullCount,
      multiplier: nightDefensiveConsistencyMultiplier,
      rawScore: rawNightScore,
    };

    // §"informe de mejora por jugador... wipefest para mejorar en el boss
    // concreto" (feedback real, 2026-08-27): lo que SÍ cortó, no solo lo que
    // falló. Sin exclusión por wipe call a propósito — un kick conseguido
    // sigue siendo un acierto real aunque el pull terminase en wipe; sí se
    // descartan ninja pulls, igual que el resto de estadísticas de esta noche.
    const interrupts: NightInterruptRow[] = ((interruptEventsData ?? []) as InterruptEventRowLite[])
      .filter((ev) => !pullById.get(ev.pull_id)?.ninja_pull_excluded)
      .map((ev) => {
        const pull = pullById.get(ev.pull_id)!;
        const coaching = coachingFor(pull, ev.mechanic_name);
        return {
          pullId: ev.pull_id,
          bossId: pull.boss_id,
          bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
          difficulty: pull.difficulty,
          pullNumber: pull.pull_number,
          mechanicName: ev.mechanic_name,
          mechanicId: ev.ability_id,
          timeMs: ev.trigger_time_ms,
          aiNote: coaching.note,
        };
      })
      .sort((a, b) => {
        const aPull = pullById.get(a.pullId)!;
        const bPull = pullById.get(b.pullId)!;
        return (bossOrder.get(aPull.boss_id) ?? 0) - (bossOrder.get(bPull.boss_id) ?? 0) || a.pullNumber - b.pullNumber || a.timeMs - b.timeMs;
      });

    // §"patrones repetidos esa noche concreta... murió 3 veces a zona
    // evitable en 3 bosses distintos" — agrega muertes+fallos por mecánica,
    // sin distinguir cuál de las dos listas viene cada instancia (para el
    // patrón da igual si murió o solo la falló sin morir).
    // evaluatedDeaths ya aplica exactamente este mismo filtro (wipe call +
    // ninja pull + exclusión estadística) — reusarlo en vez de repetirlo
    // evita que un tercer sitio se olvide de alguna de las tres exclusiones.
    const patternSource = [
      ...evaluatedDeaths.map((d) => ({ mechanicName: d.mechanicName ?? 'Sin identificar', mechanicId: d.mechanicId, category: d.category, bossName: d.bossName })),
      ...mechanicFails.map((f) => ({ mechanicName: f.mechanicName, mechanicId: f.mechanicId as number | null, category: f.category, bossName: f.bossName })),
    ];
    const byMechanic = new Map<string, { mechanicId: number | null; category: MechanicCategory | null; bosses: Set<string>; count: number }>();
    for (const p of patternSource) {
      if (!byMechanic.has(p.mechanicName)) byMechanic.set(p.mechanicName, { mechanicId: p.mechanicId, category: p.category, bosses: new Set(), count: 0 });
      const entry = byMechanic.get(p.mechanicName)!;
      entry.bosses.add(p.bossName);
      entry.count++;
    }
    const repeatedPatterns: NightRepeatedPattern[] = [...byMechanic.entries()]
      .map(([mechanicName, e]) => ({
        mechanicName,
        mechanicId: e.mechanicId,
        category: e.category,
        instanceCount: e.count,
        distinctBossCount: e.bosses.size,
        bossNames: [...e.bosses],
        // El patrón puede cruzar bosses/dificultades. Solo reutilizamos una
        // nota si todas las instancias verificables que lo forman coinciden;
        // mezclar la resolución de otro ámbito sería peor que no mostrarla.
        aiNote: (() => {
          const notes = new Set(
            [...evaluatedDeaths, ...mechanicFails]
              .filter((row) => row.mechanicName === mechanicName && row.aiNote)
              .map((row) => row.aiNote as string),
          );
          return notes.size === 1 ? [...notes][0] : null;
        })(),
      }))
      .filter((p) => p.instanceCount >= 2) // un fallo suelto no es un "patrón" de la noche
      .sort((a, b) => b.instanceCount - a.instanceCount);

    // §"gear, talentos, si tiene puestas las gemas y enchants": snapshot del
    // ÚLTIMO pull de la noche — es "cómo estaba equipado esta noche", no un
    // acumulado histórico.
    const lastPull = [...pulls].sort((a, b) => b.closedAt.localeCompare(a.closedAt))[0] ?? null;
    const lastRecord = lastPull ? recordByPullId.get(lastPull.pullId) : null;
    const gearSnapshot: NightGearSnapshot | null = lastPull && lastRecord ? this.buildGearSnapshot(lastPull, lastRecord) : null;
    const firstPull = pulls[0] ?? null;
    const firstRecord = firstPull ? recordByPullId.get(firstPull.pullId) : null;
    const startingPreparation =
      firstPull && firstRecord ? this.buildGearSnapshot(firstPull, firstRecord) : null;

    // Casts defensivos con timing exacto. Igual que la vista SQL de
    // fiabilidad: un ninja pull no aporta evidencia y nada posterior al
    // inicio confirmado del wipe call se presenta como ejecución real.
    const defensiveCasts: NightDefensiveCast[] = [];
    for (const record of records) {
      const pull = pullById.get(record.pull_id);
      if (!pull || pull.ninja_pull_excluded) continue;
      const wipeCallStartMs =
        pull.wipe_call_excluded &&
        typeof pull.wipe_call_signals?.['wipeCallStartMs'] === 'number'
          ? (pull.wipe_call_signals['wipeCallStartMs'] as number)
          : null;
      for (const defensive of record.defensive_casts ?? []) {
        for (const timeMs of defensive.timestampsMs ?? []) {
          if (!Number.isFinite(timeMs) || timeMs < 0) continue;
          if (wipeCallStartMs != null && timeMs >= wipeCallStartMs) continue;
          defensiveCasts.push({
            pullId: record.pull_id,
            pullNumber: pull.pull_number,
            bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
            difficulty: pull.difficulty,
            spellId: defensive.spellId,
            spellName: defensive.name,
            timeMs,
          });
        }
      }
    }
    defensiveCasts.sort(
      (a, b) =>
        (bossOrder.get(pullById.get(a.pullId)!.boss_id) ?? 0) -
          (bossOrder.get(pullById.get(b.pullId)!.boss_id) ?? 0) ||
        a.pullNumber - b.pullNumber ||
        a.timeMs - b.timeMs,
    );
    const defensiveBySpell = new Map<
      string,
      { spellId: number; spellName: string; casts: NightDefensiveCast[]; pulls: Set<string> }
    >();
    for (const cast of defensiveCasts) {
      const key = `${cast.spellId}|${cast.spellName}`;
      const entry = defensiveBySpell.get(key) ?? {
        spellId: cast.spellId,
        spellName: cast.spellName,
        casts: [],
        pulls: new Set<string>(),
      };
      entry.casts.push(cast);
      entry.pulls.add(cast.pullId);
      defensiveBySpell.set(key, entry);
    }
    const pressureRows = reliabilityInputRows.filter(
      (row) => row.had_avoidable_damage || row.used_defensive_when_died != null,
    );
    // §"no es lo mismo usar 0 defensivos que usarlo a destiempo... guiar
    // indicando dónde hay que usarlo y por qué" (feedback real, 2026-08-29):
    // por cada pull evaluable (sin ninja pulls, ver `pulls` — ya filtrado más
    // arriba), las ventanas de presión REALES de ese pull concreto, con las
    // del tramo posterior al wipe call descartadas (mismo criterio que el
    // resto de la app: nada después de ese instante cuenta como evaluable).
    // §"esa información debe ser verificable... consistente" (feedback real,
    // 2026-08-29): pressureWindowEvaluation (arriba) es LA MISMA función que
    // ya usa computePullScore para el multiplicador — el desglose que ve el
    // RL aquí y el tooltip de puntuación del pull no pueden divergir en los
    // NÚMEROS, porque leen del mismo cálculo. §bug real encontrado en
    // auditoría (2026-08-29): SÍ podían divergir en qué PULLS se enseñan —
    // computePullScore nunca evalúa ventanas de un pull con muerte evaluable
    // (evita puntuar dos veces la misma ventana con dos criterios, ver
    // `death` más abajo), pero esta lista no tenía ese mismo filtro: un pull
    // con muerte podía salir aquí como "never_touched"/"mistimed" mientras
    // el tooltip de ESE MISMO pull decía 'death' con cero ventanas listadas
    // — dos superficies de la misma pantalla contradiciéndose sobre el
    // mismo pull. Mismo filtro que `death` en computePullScore.
    const pressurePullBreakdown: NightPressurePullSummary[] = pulls
      .filter((p) => !p.excludedFromStats && !evaluatedDeathByPullId.has(p.pullId))
      .map((p) => {
        const { coverableWindows, coveredCount, usedAnything } = pressureWindowEvaluation(p.pullId);
        const classification: NightPressurePullClassification = !coverableWindows.length
          ? coveredCount > 0
            ? 'covered'
            : 'no_pressure'
          : usedAnything
            ? 'mistimed'
            : 'never_touched';
        return {
          pullId: p.pullId,
          pullNumber: p.pullNumber,
          bossId: p.bossId,
          bossName: p.bossName,
          difficulty: p.difficulty,
          durationMs: p.durationMs,
          missedCount: coverableWindows.length,
          coveredCount,
          usedAnything,
          classification,
          missedWindows: coverableWindows.map((w) => ({
            startMs: w.startMs,
            peakMs: w.peakMs,
            peakValue: w.peakValue,
            mechanicId: w.mechanicId,
            mechanicName: w.mechanicName,
            // §bug real encontrado en auditoría (2026-08-29): mismo criterio
            // que computePullScore (arriba) — excluir 'emergency' aquí
            // también, si no la infografía podía mostrar una emergencia
            // como "disponible" en una ventana que solo es un fallo real
            // por OTRA opción no-emergencia.
            availableOptions: w.options
              .filter((o) => o.status === 'available_unused' && o.survivalType !== 'emergency')
              .map((o) => ({ spellId: o.spellId, name: o.name, survivalType: o.survivalType })),
          })),
        };
      })
      .sort((a, b) => a.pullNumber - b.pullNumber);
    // §"si el boss lanza la habilidad siempre en el mismo momento... o cada
    // X tiempo podemos ponerlo también ahí para preparar el defensivo"
    // (feedback real, 2026-08-29): cruce contra el histórico de
    // pull_mechanic_events de ESTE boss+dificultad (todas las noches, no
    // solo esta) — validado empíricamente contra datos reales antes de
    // escribir esto (ver conversación real): mecánicas con intervalo muy
    // regular entre repeticiones (p.ej. Mark of Acid, cv≈0.03 en 55
    // muestras) sí dan patrón fiable; mecánicas disparadas por vida/azar
    // (Hollowing Strikes, cv≈2.2) correctamente no dan ninguno — mejor
    // ausencia de dato que un patrón inventado.
    await this.enrichTimingPatterns(client, pressurePullBreakdown);
    // §"agrupar por mecánica... que sea información que no deje nada por el
    // camino... y así podemos aprender: en esta mecánica sí o sí me tengo
    // que preparar un defensivo" (feedback real, 2026-08-29): agregado de
    // TODA la noche, no por pull — a diferencia de pressurePullBreakdown NO
    // excluye pulls con muerte (esto es un patrón para aprender, no una
    // superficie de puntuación, así que no aplica esa misma exclusión).
    const mechanicPressureBreakdown = await this.buildMechanicPressureBreakdown(client, pulls, evaluableWindowsForPull);
    const defensiveSummary: NightDefensiveSummary = {
      totalCasts: defensiveCasts.length,
      pullsWithCasts: new Set(defensiveCasts.map((cast) => cast.pullId)).size,
      pressurePulls: pressureRows.length,
      pressurePullsWithCast: pressureRows.filter((row) => row.used_defensive_in_pull).length,
      deathsWithDefensiveAvailable: evaluatedDeaths.filter(
        (death) => death.defensivesAvailable.length > 0,
      ).length,
      spells: [...defensiveBySpell.values()]
        .map((entry) => ({
          spellId: entry.spellId,
          spellName: entry.spellName,
          castCount: entry.casts.length,
          pullCount: entry.pulls.size,
          casts: entry.casts,
        }))
        .sort((a, b) => b.castCount - a.castCount || a.spellName.localeCompare(b.spellName)),
      pressurePullBreakdown,
      mechanicPressureBreakdown,
    };

    const avoidableEligible = reliabilityInputRows.reduce(
      (sum, row) => sum + (row.avoidable_mechanic_eligible_count ?? 0),
      0,
    );
    const avoidableFailed = reliabilityInputRows.reduce(
      (sum, row) => sum + (row.avoidable_mechanic_fail_count ?? 0),
      0,
    );
    const avoidableSucceeded = Math.max(0, avoidableEligible - avoidableFailed);
    const cleanPulls = scoredPulls.filter(
      (pull) =>
        pull.scoreBreakdown.mechanicFailCount === 0 &&
        !evaluatedDeathByPullId.has(pull.pullId),
    ).length;
    const actionableDeaths = evaluatedDeaths.filter(
      (death) =>
        death.category != null && PERSONAL_RESPONSIBILITY_CATEGORIES.has(death.category),
    );
    const actionableIncidents = mechanicFails.length + actionableDeaths.length;
    const emergencyConsumableUses = evaluatedDeaths.filter(
      (death) => death.usedHealthstoneInPull || death.usedHealthPotionInPull,
    ).length;
    const execution: NightExecutionSnapshot = {
      evaluatedPulls: scoredPulls.length,
      cleanPulls,
      cleanPullRate: scoredPulls.length ? (cleanPulls / scoredPulls.length) * 100 : null,
      avoidableEligible,
      avoidableFailed,
      avoidableSucceeded,
      avoidableSuccessRate:
        avoidableEligible > 0 ? (avoidableSucceeded / avoidableEligible) * 100 : null,
      actionableIncidents,
      actionableIncidentRatePer10:
        scoredPulls.length > 0 ? (actionableIncidents / scoredPulls.length) * 10 : null,
      deathRatePer10:
        scoredPulls.length > 0 ? (evaluatedDeaths.length / scoredPulls.length) * 10 : null,
      emergencyConsumableOpportunities: evaluatedDeaths.length,
      emergencyConsumableUses,
      emergencyConsumableUseRate:
        evaluatedDeaths.length > 0
          ? (emergencyConsumableUses / evaluatedDeaths.length) * 100
          : null,
    };

    const rosterEntry = roster.find((r) => r.name === playerName) ?? null;

    // §"preparar la vinculación de ese ID... con el dosier de ese raider"
    // (feedback real, 2026-08-28): no puede ir en el Promise.all de arriba —
    // depende de rosterEntry.characterId, que solo se conoce una vez
    // resuelto `roster` (que SÍ vive en ese Promise.all). Best-effort: un
    // fallo aquí no debe tirar todo el dosier abajo, la vinculación de
    // Discord es un extra, no el contenido principal.
    type DiscordChannelRow = { discord_channel_id: string | null; discord_user_id: string; is_officer: boolean };
    let discordChannel: DiscordChannelRow | null = null;
    if (rosterEntry) {
      try {
        const { data } = await client
          .from('discord_roster_channels')
          .select('discord_channel_id, discord_user_id, is_officer')
          .eq('character_id', rosterEntry.characterId)
          .maybeSingle();
        discordChannel = (data ?? null) as DiscordChannelRow | null;
      } catch {
        // best-effort — un fallo aquí no debe tirar todo el dosier abajo (ver comentario de arriba)
      }
    }

    const realmSlug = rosterEntry ? slugifyRealm(rosterEntry.realm) : null;
    const nameSlug = playerName.toLowerCase();
    const battleNetUrl = realmSlug ? `https://worldofwarcraft.blizzard.com/en-us/character/${REGION}/${realmSlug}/${nameSlug}` : null;
    const raiderIoUrl = realmSlug ? `https://raider.io/characters/${REGION}/${realmSlug}/${nameSlug}` : null;

    const summary: NightPlayerSummary = {
      playerName,
      reportCode,
      reportTitle: (reportRow as { title: string } | null)?.title ?? reportCode,
      reportDate: (reportRow as { start_time: number } | null)?.start_time ? new Date((reportRow as { start_time: number }).start_time).toISOString() : '',
      roster: rosterEntry,
      reliability: reliabilityEntry,
      nightReliability,
      pulls: pullsWithScore,
      nightScore,
      nightDefensiveConsistency,
      totalDeaths: evaluatedDeaths.length,
      totalMechanicFails: mechanicFails.length,
      deaths,
      mechanicFails,
      interrupts,
      repeatedPatterns,
      gearSnapshot,
      startingPreparation,
      defensiveSummary,
      execution,
      evolution: null,
      battleNetUrl,
      raiderIoUrl,
      brief: briefRow ? mapBrief(briefRow as unknown as Parameters<typeof mapBrief>[0]) : null,
      discordChannel: discordChannel
        ? { discordChannelId: discordChannel.discord_channel_id, discordUserId: discordChannel.discord_user_id, isOfficer: discordChannel.is_officer }
        : null,
    };

    if (includeEvolution) {
      const previousReport = await this.findPreviousReport(
        reportCode,
        playerName,
        (reportRow as { start_time: number } | null)?.start_time ?? null,
      );
      if (previousReport) {
        // Recursión — ver el comentario junto a `load` arriba: esta llamada
        // también pasa por la comprobación de caché, así que una noche
        // anterior ya visitada (por este mismo jugador o por cualquier otro
        // cuya "noche anterior" sea el mismo report) se sirve de localStorage
        // en vez de recalcularse otra vez.
        const previousSummary = await this.load(previousReport.code, playerName, false);
        summary.evolution = buildNightEvolution(summary, previousSummary);
      }
    }

    if (fingerprint) this.summaryCache.write(reportCode, playerName, fingerprint, summary);
    return summary;
  }

  /**
   * §mismo motivo que el comentario junto a `load`: generar/editar el brief
   * de IA (night-player-dossier.component.ts, onGenerateBrief/
   * onManualBriefSaved) muta `brief` en el signal del componente sin volver
   * a pasar por `load` — sin esto, el snapshot cacheado se quedaría sirviendo
   * el brief viejo (o "sin generar todavía") hasta que cambiara el
   * fingerprint global (un pull nuevo), que puede tardar semanas en llegar.
   * No-op si todavía no hay nada cacheado para este dosier (nunca se llegó a
   * escribir, o el fingerprint ya había cambiado entre medias) — el
   * siguiente `load()` normal recalculará y cacheará todo de cero.
   */
  updateCachedBrief(reportCode: string, playerName: string, brief: LlmPullAnalysis): void {
    const cached = this.summaryCache.read(reportCode, playerName);
    if (!cached) return;
    this.summaryCache.write(reportCode, playerName, cached.fingerprint, { ...cached.summary, brief });
  }

  // §"si el boss lanza la habilidad siempre en el mismo momento... o cada X
  // tiempo podemos ponerlo también ahí para preparar el defensivo" (feedback
  // real, 2026-08-29): calcula UNA vez por mecánica única (no por ventana)
  // y muta directamente los objetos ya construidos en pressurePullBreakdown
  // — evita N consultas repetidas cuando la misma mecánica falla en varias
  // ventanas/pulls de la misma noche.
  private async enrichTimingPatterns(
    client: SupabaseClient,
    pressurePullBreakdown: NightPressurePullSummary[],
  ): Promise<void> {
    const uniqueKeys = new Map<string, { bossId: string; difficulty: string; mechanicId: number }>();
    for (const pull of pressurePullBreakdown) {
      for (const win of pull.missedWindows) {
        if (win.mechanicId == null) continue;
        const key = `${pull.bossId}|${pull.difficulty}|${win.mechanicId}`;
        if (!uniqueKeys.has(key)) uniqueKeys.set(key, { bossId: pull.bossId, difficulty: pull.difficulty, mechanicId: win.mechanicId });
      }
    }
    if (!uniqueKeys.size) return;
    const entries = await Promise.all(
      [...uniqueKeys.entries()].map(async ([key, { bossId, difficulty, mechanicId }]) => {
        const pattern = await this.computeMechanicTimingPattern(client, bossId, difficulty, mechanicId).catch(() => null);
        return [key, pattern] as const;
      }),
    );
    const patternByKey = new Map(entries);
    for (const pull of pressurePullBreakdown) {
      for (const win of pull.missedWindows) {
        win.timingPattern = win.mechanicId == null ? null : (patternByKey.get(`${pull.bossId}|${pull.difficulty}|${win.mechanicId}`) ?? null);
      }
    }
  }

  // §"agrupar por mecánica... que no deje nada por el camino... una mecánica
  // se puede fallar más de una vez en el mismo pull" (feedback real,
  // 2026-08-29): una fila por mecánica real (boss+dificultad+abilityGameID),
  // agregada de TODA la noche — cada ocurrencia (cubierta o no) queda como
  // un elemento propio en `occurrences`, así que dos fallos del mismo pull
  // salen como dos entradas distintas, no se funden en una.
  private async buildMechanicPressureBreakdown(
    client: SupabaseClient,
    pulls: Pick<NightPullSummary, 'pullId' | 'pullNumber' | 'bossId' | 'bossName' | 'difficulty' | 'excludedFromStats'>[],
    evaluableWindowsForPull: (pullId: string) => DefensivePressureWindow[],
  ): Promise<NightMechanicPressureSummary[]> {
    interface Group {
      mechanicId: number;
      mechanicName: string;
      bossId: string;
      bossName: string;
      difficulty: string;
      occurrences: NightMechanicOccurrence[];
      defensiveStats: Map<number, { name: string; timesAvailable: number; timesUsed: number }>;
    }
    const groups = new Map<string, Group>();
    for (const p of pulls) {
      if (p.excludedFromStats) continue;
      for (const w of evaluableWindowsForPull(p.pullId)) {
        if (w.mechanicId == null || !w.mechanicName) continue;
        const key = `${p.bossId}|${p.difficulty}|${w.mechanicId}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            mechanicId: w.mechanicId,
            mechanicName: w.mechanicName,
            bossId: p.bossId,
            bossName: p.bossName,
            difficulty: p.difficulty,
            occurrences: [],
            defensiveStats: new Map(),
          };
          groups.set(key, group);
        }
        const coveringOption = w.options.find((o) => o.status === 'active' || o.status === 'used_during_window') ?? null;
        group.occurrences.push({
          pullId: p.pullId,
          pullNumber: p.pullNumber,
          timeMs: w.peakMs,
          covered: w.covered,
          coveredBySpellId: coveringOption?.spellId ?? null,
          coveredBySpellName: coveringOption?.name ?? null,
        });
        // Mismo criterio que el resto de la sección: 'emergency' nunca entra
        // en el desglose por defensivo (guardarlo suele ser lo correcto, no
        // es "disponible sin usar" en el mismo sentido que el resto).
        for (const o of w.options) {
          if (o.survivalType === 'emergency') continue;
          const isActive = o.status === 'active' || o.status === 'used_during_window';
          if (o.status !== 'available_unused' && !isActive) continue;
          const stat = group.defensiveStats.get(o.spellId) ?? { name: o.name, timesAvailable: 0, timesUsed: 0 };
          stat.timesAvailable++;
          if (isActive) stat.timesUsed++;
          group.defensiveStats.set(o.spellId, stat);
        }
      }
    }
    if (!groups.size) return [];

    const entries = await Promise.all(
      [...groups.values()].map(async (group) => {
        const timingPattern = await this.computeMechanicTimingPattern(client, group.bossId, group.difficulty, group.mechanicId).catch(
          () => null,
        );
        const occurrences = group.occurrences.sort((a, b) => a.pullNumber - b.pullNumber || a.timeMs - b.timeMs);
        return {
          mechanicId: group.mechanicId,
          mechanicName: group.mechanicName,
          bossId: group.bossId,
          bossName: group.bossName,
          difficulty: group.difficulty,
          timingPattern,
          occurrences,
          coveredCount: occurrences.filter((o) => o.covered).length,
          totalCount: occurrences.length,
          defensives: [...group.defensiveStats.entries()]
            .map(([spellId, stat]) => ({ spellId, name: stat.name, timesAvailable: stat.timesAvailable, timesUsed: stat.timesUsed }))
            .sort((a, b) => b.timesUsed - a.timesUsed || b.timesAvailable - a.timesAvailable),
        };
      }),
    );
    // Más fallos primero — es lo que más le urge revisar al raider.
    return entries.sort((a, b) => (b.totalCount - b.coveredCount) - (a.totalCount - a.coveredCount));
  }

  // §umbrales validados empíricamente contra datos reales (2026-08-29): un
  // barrido de todas las mecánicas del histórico mostró un salto claro entre
  // "patrón real" (cv de 0.01-0.05, p.ej. Mark of Acid cada ~20,4s en 55
  // muestras) y "sin patrón" (cv por encima de 2, p.ej. Hollowing Strikes,
  // disparada por vida/azar) — 0.15 deja margen de sobra sin colar ruido.
  private static readonly TIMING_CV_THRESHOLD = 0.15;
  private static readonly TIMING_MIN_SAMPLES = 5;

  private async computeMechanicTimingPattern(
    client: SupabaseClient,
    bossId: string,
    difficulty: string,
    mechanicId: number,
  ): Promise<NightMechanicTimingPattern | null> {
    const query = (relation: string) =>
      client
        .from(relation)
        .select('pull_id, trigger_time_ms, pulls!inner(boss_id, difficulty, ninja_pull_excluded)')
        .eq('ability_id', mechanicId)
        .eq('pulls.boss_id', bossId)
        .eq('pulls.difficulty', difficulty)
        .eq('pulls.ninja_pull_excluded', false);
    const { data, error } = await withSupabaseRelationFallback(
      'applicable_pull_mechanic_events',
      () => query('applicable_pull_mechanic_events'),
      () => query('pull_mechanic_events'),
    );
    if (error) return null;
    const rows = (data ?? []) as { pull_id: string; trigger_time_ms: number }[];
    if (rows.length < NightPlayerSummaryService.TIMING_MIN_SAMPLES) return null;

    const timesByPull = new Map<string, number[]>();
    for (const row of rows) {
      if (!timesByPull.has(row.pull_id)) timesByPull.set(row.pull_id, []);
      timesByPull.get(row.pull_id)!.push(row.trigger_time_ms);
    }

    // Periódico primero: intervalo entre repeticiones DENTRO del mismo
    // pull — más informativo que el momento absoluto cuando la mecánica se
    // repite varias veces por intento.
    const deltas: number[] = [];
    for (const times of timesByPull.values()) {
      times.sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
    }
    if (deltas.length >= NightPlayerSummaryService.TIMING_MIN_SAMPLES) {
      const stats = meanAndCv(deltas);
      if (stats && stats.cv <= NightPlayerSummaryService.TIMING_CV_THRESHOLD) {
        return { kind: 'periodic', ms: Math.round(stats.mean), sampleSize: deltas.length };
      }
    }

    // Fijo: mismo instante entre pulls DISTINTOS — solo tiene sentido si la
    // mecánica ocurre ~1 vez por pull (si se repite varias veces, "el
    // momento absoluto" ya no es una pregunta con una sola respuesta).
    const avgOccurrencesPerPull = rows.length / timesByPull.size;
    if (timesByPull.size >= NightPlayerSummaryService.TIMING_MIN_SAMPLES && avgOccurrencesPerPull <= 1.3) {
      const stats = meanAndCv(rows.map((r) => r.trigger_time_ms));
      if (stats && stats.cv <= NightPlayerSummaryService.TIMING_CV_THRESHOLD) {
        return { kind: 'fixed', ms: Math.round(stats.mean), sampleSize: rows.length };
      }
    }
    return null;
  }

  private async findPreviousReport(
    reportCode: string,
    playerName: string,
    currentStartTime: number | null,
  ): Promise<{ code: string; title: string; start_time: number } | null> {
    if (currentStartTime == null) return null;
    const client = this.supabase.client;
    const { data: recordRows, error: recordsError } = await client
      .from('player_pull_records')
      .select('pulls!inner(report_code)')
      .eq('player_name', playerName);
    if (recordsError) throw recordsError;
    const reportCodes = [
      ...new Set(
        ((recordRows ?? []) as unknown as { pulls: { report_code: string } }[])
          .map((row) => row.pulls.report_code)
          .filter((code) => code !== reportCode),
      ),
    ];
    if (!reportCodes.length) return null;
    const { data, error } = await client
      .from('reports')
      .select('code, title, start_time')
      .in('code', reportCodes)
      .lt('start_time', currentStartTime)
      .order('start_time', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as { code: string; title: string; start_time: number } | null;
  }

  private buildGearSnapshot(pull: Pick<NightPullSummary, 'pullNumber' | 'bossName'>, record: PlayerPullRecordRow): NightGearSnapshot {
    const items = (record.equipped_items ?? []) as (WclGearItem | null)[];
    const preparation = gearPreparationCounts(items);
    return {
      fromPullNumber: pull.pullNumber,
      bossName: pull.bossName,
      class: record.class,
      spec: record.spec,
      talents: (record.talent_build ?? []).filter((t): t is { id: number; rank: number; nodeID: number; spellId: number } => typeof t.spellId === 'number').map((t) => ({ spellId: t.spellId, rank: t.rank })),
      talentUnresolvedCount: (record.talent_build ?? []).filter((t) => typeof t.spellId !== 'number').length,
      gear: items.map((item, slot) => ({ slot, itemId: item?.id ?? 0, itemLevel: item?.itemLevel ?? 0 })).filter((g) => g.itemId > 0),
      ...preparation,
    };
  }
}

function evolutionDirection(
  current: number,
  previous: number,
  higherIsBetter: boolean,
  threshold: number,
): NightEvolutionDirection {
  const delta = current - previous;
  if (Math.abs(delta) < threshold) return 'stable';
  const movedUp = delta > 0;
  return movedUp === higherIsBetter ? 'improved' : 'worsened';
}

function isVerifiableMechanicName(name: string | null | undefined): name is string {
  if (!name) return false;
  const normalized = name.toLocaleLowerCase('es-ES');
  return !(
    normalized.includes('unknown') ||
    normalized.includes('sin identificar') ||
    normalized.includes('causa desconocida')
  );
}

/**
 * Comparación pura y auditable entre dos noches. Las métricas globales se
 * normalizan por pull. Una mecánica concreta solo se compara si el jugador
 * participó en el mismo boss+dificultad en ambas noches, evitando convertir
 * en "mejora" un encuentro que sencillamente no se jugó.
 */
export function buildNightEvolution(
  current: NightPlayerSummary,
  previous: NightPlayerSummary,
): NightEvolution {
  const metrics: NightEvolutionMetric[] = [];
  const addMetric = (params: {
    key: NightEvolutionMetric['key'];
    label: string;
    current: number | null;
    previous: number | null;
    higherIsBetter: boolean;
    unit: NightEvolutionMetric['unit'];
    evidence: string;
  }): void => {
    if (params.current == null || params.previous == null) return;
    const threshold = params.unit === 'percent' ? 3 : 0.5;
    metrics.push({
      key: params.key,
      label: params.label,
      current: params.current,
      previous: params.previous,
      delta: params.current - params.previous,
      direction: evolutionDirection(
        params.current,
        params.previous,
        params.higherIsBetter,
        threshold,
      ),
      unit: params.unit,
      evidence: params.evidence,
    });
  };

  addMetric({
    key: 'execution',
    label: 'Ejecución de la noche',
    current: current.nightScore == null ? null : current.nightScore * 100,
    previous: previous.nightScore == null ? null : previous.nightScore * 100,
    higherIsBetter: true,
    unit: 'percent',
    evidence: `${previous.execution.evaluatedPulls} pulls anteriores → ${current.execution.evaluatedPulls} actuales`,
  });
  addMetric({
    key: 'clean-pulls',
    label: 'Pulls sin fallo personal ni muerte',
    current: current.execution.cleanPullRate,
    previous: previous.execution.cleanPullRate,
    higherIsBetter: true,
    unit: 'percent',
    evidence: `${previous.execution.cleanPulls}/${previous.execution.evaluatedPulls} → ${current.execution.cleanPulls}/${current.execution.evaluatedPulls}`,
  });
  addMetric({
    key: 'avoidable-success',
    label: 'Zonas/spread evitados',
    current: current.execution.avoidableSuccessRate,
    previous: previous.execution.avoidableSuccessRate,
    higherIsBetter: true,
    unit: 'percent',
    evidence: `${previous.execution.avoidableSucceeded}/${previous.execution.avoidableEligible} → ${current.execution.avoidableSucceeded}/${current.execution.avoidableEligible} oportunidades`,
  });
  addMetric({
    key: 'personal-incidents',
    label: 'Incidencias personales / 10 pulls',
    current: current.execution.actionableIncidentRatePer10,
    previous: previous.execution.actionableIncidentRatePer10,
    higherIsBetter: false,
    unit: 'per10',
    evidence: `${previous.execution.actionableIncidents} en ${previous.execution.evaluatedPulls} → ${current.execution.actionableIncidents} en ${current.execution.evaluatedPulls}`,
  });
  addMetric({
    key: 'deaths',
    label: 'Muertes evaluables / 10 pulls',
    current: current.execution.deathRatePer10,
    previous: previous.execution.deathRatePer10,
    higherIsBetter: false,
    unit: 'per10',
    evidence: `${previous.totalDeaths} en ${previous.execution.evaluatedPulls} → ${current.totalDeaths} en ${current.execution.evaluatedPulls}`,
  });
  addMetric({
    key: 'defensive-response',
    label: 'Defensivo en pulls con presión',
    current:
      current.defensiveSummary.pressurePulls > 0
        ? (current.defensiveSummary.pressurePullsWithCast /
            current.defensiveSummary.pressurePulls) *
          100
        : null,
    previous:
      previous.defensiveSummary.pressurePulls > 0
        ? (previous.defensiveSummary.pressurePullsWithCast /
            previous.defensiveSummary.pressurePulls) *
          100
        : null,
    higherIsBetter: true,
    unit: 'percent',
    evidence: `${previous.defensiveSummary.pressurePullsWithCast}/${previous.defensiveSummary.pressurePulls} → ${current.defensiveSummary.pressurePullsWithCast}/${current.defensiveSummary.pressurePulls} pulls`,
  });
  addMetric({
    key: 'consumables',
    label: 'Piedra/poción en muerte evaluable',
    current: current.execution.emergencyConsumableUseRate,
    previous: previous.execution.emergencyConsumableUseRate,
    higherIsBetter: true,
    unit: 'percent',
    evidence: `${previous.execution.emergencyConsumableUses}/${previous.execution.emergencyConsumableOpportunities} → ${current.execution.emergencyConsumableUses}/${current.execution.emergencyConsumableOpportunities} muertes`,
  });

  type Incident = {
    bossId: string;
    bossName: string;
    difficulty: string;
    mechanicId: number;
    mechanicName: string;
    resolution: string | null;
  };
  const incidents = (summary: NightPlayerSummary): Incident[] => [
    ...summary.mechanicFails
      .filter((row) => row.mechanicId > 0 && isVerifiableMechanicName(row.mechanicName))
      .map((row) => ({
        bossId: row.bossId,
        bossName: row.bossName,
        difficulty: row.difficulty,
        mechanicId: row.mechanicId,
        mechanicName: row.mechanicName,
        resolution: row.resolution,
      })),
    ...summary.deaths
      .filter(
        (row) =>
          !row.isWipeCall &&
          !row.isNinjaPull &&
          !row.statisticalExclusionReason &&
          row.mechanicId != null &&
          row.mechanicId > 0 &&
          row.category != null &&
          PERSONAL_RESPONSIBILITY_CATEGORIES.has(row.category) &&
          isVerifiableMechanicName(row.mechanicName),
      )
      .map((row) => ({
        bossId: row.bossId,
        bossName: row.bossName,
        difficulty: row.difficulty,
        mechanicId: row.mechanicId!,
        mechanicName: row.mechanicName!,
        resolution: row.resolution,
      })),
  ];
  const scopePullCounts = (summary: NightPlayerSummary): Map<string, number> => {
    const map = new Map<string, number>();
    for (const pull of summary.pulls.filter((row) => row.pullScore != null)) {
      const key = `${pull.bossId}|${pull.difficulty}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  };
  const groupIncidents = (rows: Incident[]): Map<string, Incident & { count: number }> => {
    const map = new Map<string, Incident & { count: number }>();
    for (const row of rows) {
      const key = `${row.bossId}|${row.difficulty}|${row.mechanicId}`;
      const existing = map.get(key);
      if (existing) existing.count++;
      else map.set(key, { ...row, count: 1 });
    }
    return map;
  };
  const currentScopes = scopePullCounts(current);
  const previousScopes = scopePullCounts(previous);
  const currentIncidents = groupIncidents(incidents(current));
  const previousIncidents = groupIncidents(incidents(previous));
  const mechanicKeys = new Set([...currentIncidents.keys(), ...previousIncidents.keys()]);
  const mechanics: NightEvolutionMechanic[] = [];
  for (const key of mechanicKeys) {
    const currentIncident = currentIncidents.get(key);
    const previousIncident = previousIncidents.get(key);
    const source = currentIncident ?? previousIncident!;
    const scopeKey = `${source.bossId}|${source.difficulty}`;
    const currentPulls = currentScopes.get(scopeKey) ?? 0;
    const previousPulls = previousScopes.get(scopeKey) ?? 0;
    if (!currentPulls || !previousPulls) continue;
    const currentCount = currentIncident?.count ?? 0;
    const previousCount = previousIncident?.count ?? 0;
    const rateDelta = currentCount / currentPulls - previousCount / previousPulls;
    if (Math.abs(rateDelta) < 0.05) continue;
    mechanics.push({
      bossId: source.bossId,
      bossName: source.bossName,
      difficulty: source.difficulty,
      mechanicId: source.mechanicId,
      mechanicName: source.mechanicName,
      previousCount,
      currentCount,
      previousPulls,
      currentPulls,
      direction: rateDelta < 0 ? 'improved' : 'worsened',
      resolution: currentIncident?.resolution ?? previousIncident?.resolution ?? null,
    });
  }
  mechanics.sort((a, b) => {
    const aChange = Math.abs(a.currentCount / a.currentPulls - a.previousCount / a.previousPulls);
    const bChange = Math.abs(b.currentCount / b.currentPulls - b.previousCount / b.previousPulls);
    return bChange - aChange;
  });

  return {
    previousReportCode: previous.reportCode,
    previousReportTitle: previous.reportTitle,
    previousReportDate: previous.reportDate,
    currentEvaluatedPulls: current.execution.evaluatedPulls,
    previousEvaluatedPulls: previous.execution.evaluatedPulls,
    metrics,
    mechanics,
  };
}

interface PullRowLite {
  id: string;
  fight_id: number;
  boss_id: string;
  difficulty: string;
  pull_number: number;
  wipe_pct: number | null;
  duration_ms: number | null;
  closed_at: string;
  wipe_call_excluded: boolean;
  wipe_call_signals: Record<string, number | boolean | null> | null;
  ninja_pull_excluded: boolean;
}

interface MechEventRowLite {
  pull_id: string;
  ability_id: number;
  mechanic_name: string;
  category: MechanicCategory | null;
  outcome: string;
  trigger_time_ms: number;
  player_hit_details: { name: string; damage_taken: number; damage_hits: number; healing_received: number; used_defensive_spell_id: number | null }[];
  comparison_source: 'own_history' | 'world_reference' | 'fixed_threshold' | null;
  comparison_percentile: number | null;
}

interface InterruptEventRowLite {
  pull_id: string;
  ability_id: number;
  mechanic_name: string;
  trigger_time_ms: number;
}
