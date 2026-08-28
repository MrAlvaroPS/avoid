// Colocar en: src/app/core/reliability.service.ts
// §12 de la hoja de ruta (auditoría v2): sistema de fiabilidad del raider,
// score 1-100. La parte cara (cruzar pulls+player_pull_records de TODA la
// guild en una ventana móvil) ya vive en SQL — player_pull_reliability_inputs
// (ver la migración) — este servicio solo aplica la fórmula: peso por
// recencia, blend de ejes, renormalización si falta uno. Los 4 ejes del
// documento original ya están activos: mecánica 40%/defensiva 30%/
// preparación 20% (por pull) + asistencia 10% (wowaudit_roster.
// attended_percentage). Preparación = siete slots de enchant de esta season
// + tres slots de gema (cuello/anillos). Para gemas se evalúa si el slot
// elegible lleva al menos una, no un máximo de sockets que WCL no expone.
// Nunca se rellena un eje ausente con un cero silencioso.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { WowauditRosterService } from './wowaudit-roster.service';
import { AttendanceService } from './attendance.service';
import { mechanicScoreFor } from './pull-analysis.service';
import { gearPreparationDetails } from '../shared/gear-preparation.util';
import type { DeathCause, WclGearItem } from '../shared/models/domain';

const WINDOW_DAYS = 60; // "varias noches o semanas", no los 21 días de una versión anterior
const HALF_LIFE_DAYS = 10; // un pull de hace 10 días pesa la mitad que uno de hoy
const AXIS_WEIGHTS = { mecanica: 0.4, defensiva: 0.3, preparacion: 0.2, asistencia: 0.1 } as const;

export interface PlayerReliability {
  playerName: string;
  overall: number;
  breakdown: {
    mecanica: number | null;
    defensiva: number | null;
    preparacion: number | null;
    asistencia: number | null;
  };
  consistency: PlayerConsistency | null;
  /** Snapshot de preparación al inicio de la última noche observada. */
  latestGemCount: number | null;
  latestGemmedSlotCount: number | null;
  latestGemmableSlotCount: number | null;
  latestEnchantedSlotCount: number | null;
  latestEnchantableSlotCount: number | null;
  latestMissingEnchantSlots: string[];
  latestMissingGemSlots: string[];
  latestPreparationObservedAt: string | null;
  /** Nº de pulls con al menos un dato aprovechable en la ventana — no es lo mismo un 92 sobre 40 pulls que un 92 sobre 3. */
  sampleSize: number;
  /** Noches reales distintas, deduplicadas por fecha para no contar dos uploads del mismo día dos veces. */
  sampleNightCount: number;
  /** Última vez que el jugador aparece en un pull evaluable. */
  lastObservedAt: string | null;
  /** Pulls distintos con motivo para evaluar disciplina defensiva. Nunca incluye dos veces el mismo pull. */
  defensiveOpportunityCount: number;
  defensiveUseCount: number;
  /** Muertes con catálogo de defensivos disponible; se separan porque pesan doble en la fórmula. */
  defensiveDeathOpportunityCount: number;
  defensiveDeathUseCount: number;
  defensiveSpellUsage: DefensiveSpellUsage[];
  defensiveDeathEvidence: DefensiveDeathEvidence[];
  /** Cuántos de los cuatro ejes aportaron evidencia al score compuesto. */
  observedAxisCount: number;
  attendanceNightsAttended: number | null;
  attendanceNightsTotal: number | null;
  /** §12.5: flecha de tendencia — primera mitad de la ventana vs. segunda mitad, mismo cálculo que `overall` aplicado a cada mitad. null = alguna mitad no tiene datos suficientes para comparar (no es lo mismo "sin dato" que "estable"). Solo los ejes por pull (asistencia no se trae partida en dos mitades — exigiría dos llamadas a wowaudit con rangos distintos). */
  trend: 'up' | 'down' | 'flat' | null;
  /** §"roster de verdad": identidad real de wowaudit — null si el nombre no cruza (jugador nunca sincronizado, o nombre distinto entre WCL y wowaudit). */
  role: 'Tank' | 'Heal' | 'Melee' | 'Ranged' | null;
  rank: 'Main' | 'Trial' | null;
}

export interface DefensiveSpellUsage {
  spellId: number;
  name: string;
  castCount: number;
  pullCount: number;
}

export interface DefensiveDeathEvidence {
  pullId: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  reportCode: string;
  fightId: number;
  pullNumber: number;
  closedAt: string;
  mechanicId: number | null;
  mechanicName: string;
  usedDefensive: boolean;
  availableUnused: { spellId: number; name: string }[];
  active: { spellId: number; name: string }[];
  onCooldown: { spellId: number; name: string; cooldownRemainingMs: number | null }[];
}

// Exportado: player-detail.service.ts reutiliza EXACTAMENTE esta misma
// fórmula (mecánica/defensiva/preparación, renormalizada) para partirla en
// cubos semanales — un "¿cómo va este jugador semana a semana?" no es una
// fórmula nueva, es la misma aplicada a un subconjunto de filas más pequeño.
export interface ReliabilityInputRow {
  pull_id: string;
  boss_id: string;
  difficulty: string;
  player_name: string;
  closed_at: string;
  had_avoidable_damage: boolean;
  self_positioning_death: boolean;
  used_defensive_when_died: boolean | null;
  used_defensive_in_pull: boolean;
  defensive_use_opportunity: boolean;
  enchanted_slot_count: number;
  enchantable_slot_count: number;
  gem_count: number;
  gemmed_slot_count: number;
  gemmable_slot_count: number;
  /** §"actualizar el binario de 'Mecánica' para que use este mismo conteo
   * graduado... así Fiabilidad hereda la precisión sin duplicar nada"
   * (feedback real, 2026-08-27): mismo conteo que ya usa pullScore
   * (mechanicFailCount en night-player-summary.service.ts), NO un booleano —
   * un jugador con 2 fallos ya no puntúa igual que uno con 1. null solo en
   * el escalón de fallback más antiguo (LEGACY_RELIABILITY_COLUMNS, columna
   * todavía sin migrar) — ahí computeReliabilityBreakdown vuelve al binario
   * de siempre en vez de asumir 0 fallos silenciosamente. */
  personal_mechanic_fail_count: number | null;
  /** §"el baremo de preparación deberia medir los primeros pulls no los
   * ultimos, porque si en mitad de la raid te toca un objeto y te lo
   * equipas, es normal que ese item no tenga enchant o gema hasta el dia
   * siguiente" (feedback real, 2026-08-27): identifican "primer pull de
   * esta noche para este jugador" (min pull_number por report_code) — ver
   * computeReliabilityBreakdown. null en los escalones de fallback más
   * antiguos (la columna todavía no existía) — ahí se trata cualquier fila
   * como si fuera la primera, mismo comportamiento que había antes de este
   * cambio, sin regresión. */
  report_code: string | null;
  pull_number: number | null;
  /** §"consistente... contemplar muchas posibilidades distintas" (feedback
   * real, 2026-08-28): instancias avoidable-ground/spread donde este
   * jugador seguía vivo (elegible) y cuántas de ellas le golpearon — ver
   * mechanicScoreFor en pull-analysis.service.ts. null en los 3 escalones
   * de fallback más antiguos (columna todavía sin migrar). */
  avoidable_mechanic_eligible_count: number | null;
  avoidable_mechanic_fail_count: number | null;
}

function recencyWeight(closedAtIso: string, now: number): number {
  const daysAgo = (now - new Date(closedAtIso).getTime()) / 86_400_000;
  return Math.pow(0.5, Math.max(0, daysAgo) / HALF_LIFE_DAYS);
}

export interface ReliabilityBreakdown {
  overall: number;
  breakdown: {
    mecanica: number | null;
    defensiva: number | null;
    preparacion: number | null;
    asistencia: number | null;
  };
  consistency: PlayerConsistency | null;
}

export interface PlayerConsistency {
  /** Media de ejecución menos la mitad de su desviación: nivel y regularidad, no solo varianza. */
  score: number;
  averageExecution: number;
  volatility: number;
  cleanPullRate: number;
  sampleSize: number;
}

/**
 * Mismo cálculo que usaba `overall` en listPlayerReliability, factorizado
 * para poder aplicarlo a CUALQUIER subconjunto de filas — la ventana
 * completa, cada mitad (tendencia), los cubos semanales de player-detail, y
 * ahora también (§"fiabilidad de la noche" — feedback real) las filas de
 * una sola noche. `asistenciaPct` es opcional a propósito: solo tiene
 * sentido sobre una ventana de varios días (attendance.service.ts), nunca
 * sobre una noche suelta.
 */
export function computeReliabilityBreakdown(
  rows: ReliabilityInputRow[],
  now: number,
  asistenciaPct: number | null = null,
): ReliabilityBreakdown | null {
  if (!rows.length) return null;

  // §"el baremo de preparación deberia medir los primeros pulls no los
  // ultimos, porque si en mitad de la raid te toca un objeto y te lo
  // equipas, es normal que ese item no tenga enchant o gema hasta el dia
  // siguiente, por lo que medir que tengas tu pj preparado con enchants y
  // gemas al inicio de la raid es mas correcto" (feedback real,
  // 2026-08-27): promediar preparación sobre TODOS los pulls de la noche
  // penalizaba justo lo contrario de lo que debía — un jugador que mejora
  // de equipo a mitad de raid veía CAER su preparación esa noche. Solo
  // cuenta el primer pull (min pull_number) de cada report_code por
  // jugador; el resto de ejes sigue usando todas las filas (ahí la
  // tendencia pull a pull sí es la señal que se quiere). Sin report_code/
  // pull_number todavía (escalón de fallback más antiguo) se trata
  // cualquier fila como "primera" — mismo comportamiento que había antes.
  const minPullNumberByReport = new Map<string, number>();
  for (const r of rows) {
    if (r.report_code == null || r.pull_number == null) continue;
    const current = minPullNumberByReport.get(r.report_code);
    if (current == null || r.pull_number < current)
      minPullNumberByReport.set(r.report_code, r.pull_number);
  }
  const isFirstPullOfNight = (r: ReliabilityInputRow): boolean =>
    r.report_code == null ||
    r.pull_number == null ||
    r.pull_number === minPullNumberByReport.get(r.report_code);

  let mecWeight = 0;
  let mecSum = 0;
  let defWeight = 0;
  let defSum = 0;
  let prepWeight = 0;
  let prepSum = 0;
  const pullExecution: { value: number; weight: number }[] = [];
  for (const r of rows) {
    const w = recencyWeight(r.closed_at, now);
    // §"un 77% de puntuación de noche pero a la vez un 44 de fiabilidad en
    // la noche... esto parece bastante incongruente" (feedback real,
    // 2026-08-27) + "quiero que la puntuación... sea consistente en
    // realidad" (feedback real, 2026-08-28): MISMA función que
    // computePullScore en night-player-summary.service.ts
    // (mechanicScoreFor, en pull-analysis.service.ts para que ambos lean
    // la MISMA fila y apliquen la MISMA fórmula) — así Fiabilidad hereda la
    // precisión de pullScore sin duplicar nada.
    const mecScore = mechanicScoreFor({
      personalMechanicFailCount: r.personal_mechanic_fail_count,
      avoidableMechanicEligibleCount: r.avoidable_mechanic_eligible_count,
      avoidableMechanicFailCount: r.avoidable_mechanic_fail_count,
      hadAvoidableDamage: r.had_avoidable_damage,
      selfPositioningDeath: r.self_positioning_death,
    });
    mecSum += mecScore * w;
    mecWeight += w;
    // La respuesta en una muerte evaluable es la evidencia más directa y
    // pesa el doble. El uso general del try también cuenta, pero solo genera
    // una muestra negativa si hubo presión verificable; así no se castiga un
    // pull limpio/corto por no gastar un cooldown sin necesidad.
    let pullDefensiveSum = 0;
    let pullDefensiveWeight = 0;
    if (r.used_defensive_when_died != null) {
      defSum += (r.used_defensive_when_died ? 1 : 0) * w * 2;
      defWeight += w * 2;
      pullDefensiveSum += (r.used_defensive_when_died ? 1 : 0) * 2;
      pullDefensiveWeight += 2;
    }
    if (r.defensive_use_opportunity) {
      defSum += (r.used_defensive_in_pull ? 1 : 0) * w;
      defWeight += w;
      pullDefensiveSum += r.used_defensive_in_pull ? 1 : 0;
      pullDefensiveWeight += 1;
    }
    const preparationSlots = r.enchantable_slot_count + r.gemmable_slot_count;
    if (preparationSlots > 0 && isFirstPullOfNight(r)) {
      prepSum += ((r.enchanted_slot_count + r.gemmed_slot_count) / preparationSlots) * w;
      prepWeight += w;
    }
    const mechanicExecution = mecScore * 100;
    const defensiveExecution =
      pullDefensiveWeight > 0 ? (pullDefensiveSum / pullDefensiveWeight) * 100 : null;
    pullExecution.push({
      value:
        defensiveExecution == null
          ? mechanicExecution
          : mechanicExecution * 0.7 + defensiveExecution * 0.3,
      weight: w,
    });
  }
  const mecanica = mecWeight > 0 ? (mecSum / mecWeight) * 100 : null;
  const defensiva = defWeight > 0 ? (defSum / defWeight) * 100 : null;
  const preparacion = prepWeight > 0 ? (prepSum / prepWeight) * 100 : null;
  const axes: { key: keyof typeof AXIS_WEIGHTS; value: number }[] = [];
  if (mecanica != null) axes.push({ key: 'mecanica', value: mecanica });
  if (defensiva != null) axes.push({ key: 'defensiva', value: defensiva });
  if (preparacion != null) axes.push({ key: 'preparacion', value: preparacion });
  if (asistenciaPct != null) axes.push({ key: 'asistencia', value: asistenciaPct });
  const weightSum = axes.reduce((s, a) => s + AXIS_WEIGHTS[a.key], 0);
  const overall =
    weightSum > 0
      ? Math.round(axes.reduce((s, a) => s + a.value * AXIS_WEIGHTS[a.key], 0) / weightSum)
      : 0;
  let consistency: PlayerConsistency | null = null;
  if (pullExecution.length >= 5) {
    const totalWeight = pullExecution.reduce((sum, sample) => sum + sample.weight, 0);
    const averageExecution =
      pullExecution.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / totalWeight;
    const variance =
      pullExecution.reduce(
        (sum, sample) => sum + (sample.value - averageExecution) ** 2 * sample.weight,
        0,
      ) / totalWeight;
    const volatility = Math.sqrt(variance);
    consistency = {
      score: Math.round(Math.max(0, Math.min(100, averageExecution - volatility * 0.5))),
      averageExecution: Math.round(averageExecution),
      volatility: Math.round(volatility),
      cleanPullRate: Math.round(
        (pullExecution.filter((sample) => sample.value >= 80).length / pullExecution.length) * 100,
      ),
      sampleSize: pullExecution.length,
    };
  }
  return {
    overall,
    breakdown: { mecanica, defensiva, preparacion, asistencia: asistenciaPct },
    consistency,
  };
}

/** Wrapper de compatibilidad — player-detail.service.ts solo necesita el número, no el desglose. */
export function computeOverall(rows: ReliabilityInputRow[], now: number): number | null {
  return computeReliabilityBreakdown(rows, now)?.overall ?? null;
}

// §12.5 "flecha de tendencia": diferencia mínima para no marcar como
// subida/bajada ruido de un par de pulls — por debajo de esto se enseña
// "flat", no un movimiento que no es de verdad significativo.
const TREND_THRESHOLD = 4;

// §"clasifícalos tanks primero, luego healers y luego DPS": Melee/Ranged
// comparten posición (ambos son "dps" a efectos de orden) — dentro de ese
// empate de rol, decide overall (ver el sort de más abajo).
const ROLE_SORT_ORDER: Record<'Tank' | 'Heal' | 'Melee' | 'Ranged' | 'unknown', number> = {
  Tank: 0,
  Heal: 1,
  Melee: 2,
  Ranged: 2,
  unknown: 3,
};

// §"consistente... contemplar muchas posibilidades distintas" (feedback
// real, 2026-08-28): avoidable_mechanic_eligible_count/
// avoidable_mechanic_fail_count son las más nuevas de la vista — escalón
// propio por encima de RELIABILITY_COLUMNS para el mismo despliegue en dos
// tiempos de siempre (frontend puede llegar antes que la migración).
const RATIO_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count, gemmed_slot_count, gemmable_slot_count, personal_mechanic_fail_count, report_code, pull_number, avoidable_mechanic_eligible_count, avoidable_mechanic_fail_count';
const RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count, gemmed_slot_count, gemmable_slot_count, personal_mechanic_fail_count, report_code, pull_number';
const DEFENSIVE_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count';
const LEGACY_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, enchanted_slot_count, enchantable_slot_count, gem_count';

interface RawReliabilityEvidenceRecord {
  pull_id: string;
  player_name: string;
  death_cause: DeathCause | null;
  defensive_casts: { spellId: number; name: string; timestampsMs: number[] }[] | null;
  equipped_items: WclGearItem[] | null;
}

interface ReliabilityEvidencePull {
  id: string;
  report_code: string;
  fight_id: number;
  boss_id: string;
  difficulty: string;
  pull_number: number;
  closed_at: string;
  wipe_call_excluded: boolean;
  wipe_call_signals: { wipeCallStartMs?: number | null } | null;
}

interface ReliabilityInputFilters {
  scope?: { bossId: string; difficulty: string };
  since?: string;
  playerName?: string;
  pullIds?: string[];
}

function isReliabilitySchemaTransitionError(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    /used_defensive_in_pull|defensive_use_opportunity|gemmed_slot_count|gemmable_slot_count|personal_mechanic_fail_count|report_code|pull_number|avoidable_mechanic_eligible_count|avoidable_mechanic_fail_count/i.test(
      message,
    )
  );
}

@Injectable({ providedIn: 'root' })
export class ReliabilityService {
  private supabase = inject(SupabaseService);
  private wowauditRoster = inject(WowauditRosterService);
  private attendanceService = inject(AttendanceService);

  /**
   * Compatibilidad de despliegue: el frontend puede llegar antes que la
   * migración que amplía la vista. En ese intervalo se leen las columnas
   * antiguas y se conserva la fórmula previa (solo evidencia al morir), sin
   * vaciar todo el roster. Tras aplicar la migración no entra en este fallback.
   */
  private async fetchReliabilityInputs(
    filters: ReliabilityInputFilters,
  ): Promise<ReliabilityInputRow[]> {
    if (filters.pullIds && !filters.pullIds.length) return [];
    const run = async (columns: string) => {
      let query = this.supabase.client.from('player_pull_reliability_inputs').select(columns);
      if (filters.scope)
        query = query
          .eq('boss_id', filters.scope.bossId)
          .eq('difficulty', filters.scope.difficulty);
      if (filters.since) query = query.gte('closed_at', filters.since);
      if (filters.playerName) query = query.eq('player_name', filters.playerName);
      if (filters.pullIds) query = query.in('pull_id', filters.pullIds);
      return await query;
    };

    let response = await run(RATIO_RELIABILITY_COLUMNS);
    let schemaLevel: 'ratio' | 'current' | 'defensive' | 'legacy' = 'ratio';
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(RELIABILITY_COLUMNS);
      schemaLevel = 'current';
    }
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(DEFENSIVE_RELIABILITY_COLUMNS);
      schemaLevel = 'defensive';
    }
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(LEGACY_RELIABILITY_COLUMNS);
      schemaLevel = 'legacy';
    }
    if (response.error) throw response.error;
    return ((response.data ?? []) as unknown as Partial<ReliabilityInputRow>[]).map((row) => ({
      ...(row as ReliabilityInputRow),
      used_defensive_in_pull:
        schemaLevel === 'legacy' ? false : row.used_defensive_in_pull === true,
      defensive_use_opportunity:
        schemaLevel === 'legacy' ? false : row.defensive_use_opportunity === true,
      gemmed_slot_count: schemaLevel === 'ratio' || schemaLevel === 'current' ? Number(row.gemmed_slot_count ?? 0) : 0,
      gemmable_slot_count: schemaLevel === 'ratio' || schemaLevel === 'current' ? Number(row.gemmable_slot_count ?? 0) : 0,
      // null (no 0) en los escalones de fallback a propósito —
      // computeReliabilityBreakdown/mechanicScoreFor lo leen como "sin dato
      // todavía" en vez de "0 fallos"/"0 elegibles" (ver el comentario ahí).
      personal_mechanic_fail_count:
        schemaLevel === 'ratio' || schemaLevel === 'current' ? Number(row.personal_mechanic_fail_count ?? 0) : null,
      // null en fallback (igual criterio): isFirstPullOfNight trata
      // cualquier fila como "primera" cuando no hay report_code/pull_number.
      report_code: schemaLevel === 'ratio' || schemaLevel === 'current' ? (row.report_code ?? null) : null,
      pull_number: schemaLevel === 'ratio' || schemaLevel === 'current' ? (row.pull_number ?? null) : null,
      // §"consistente... contemplar muchas posibilidades distintas"
      // (feedback real, 2026-08-28): null en los 3 escalones de fallback
      // más antiguos — mechanicScoreFor cae al conteo plano de siempre
      // (personal_mechanic_fail_count) en vez de asumir "sin oportunidades
      // ratio" silenciosamente.
      avoidable_mechanic_eligible_count:
        schemaLevel === 'ratio' ? Number(row.avoidable_mechanic_eligible_count ?? 0) : null,
      avoidable_mechanic_fail_count:
        schemaLevel === 'ratio' ? Number(row.avoidable_mechanic_fail_count ?? 0) : null,
    }));
  }

  async getPlayerReliabilityInputs(
    playerName: string,
    since: string,
  ): Promise<ReliabilityInputRow[]> {
    return this.fetchReliabilityInputs({ playerName, since });
  }

  /**
   * §"todos los pulls de un boss": fiabilidad ACOTADA a un boss+dificultad
   * concreto, TODA su historia (no la ventana móvil de 60 días — aquí la
   * pregunta es "¿quién falla más EN ESTE BOSS?", no "¿quién falla más en
   * general últimamente?"). Reutiliza exactamente la misma fórmula — nada
   * de esto es una función nueva/paralela, solo cambia qué filas entran.
   * Sin scope = comportamiento de siempre (ventana de 60 días, roster completo).
   */
  async listPlayerReliability(scope?: {
    bossId: string;
    difficulty: string;
  }): Promise<PlayerReliability[]> {
    const [data, roster, realAttendance] = await Promise.all([
      this.fetchReliabilityInputs(
        scope
          ? { scope }
          : { since: new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString() },
      ),
      // best-effort: sin sync de wowaudit todavía, se sigue con mecánica+defensiva solamente (mismo comportamiento de antes).
      this.wowauditRoster.listRoster().catch(() => []),
      // §"la asistencia sigue saliendo rara" (feedback real, investigado):
      // ya NO se usa attendedPercentage de wowaudit (calcula sobre SU
      // calendario de eventos/firmas, no sobre raids reales — ver
      // attendance.service.ts) — se deriva de los reports que Avoid ya tiene
      // importados desde el inicio de la season.
      this.attendanceService
        .listRealAttendance()
        .catch(() => new Map<string, { attended: number; total: number; pct: number | null }>()),
    ]);
    const rosterByName = new Map(roster.map((r) => [r.name, r]));

    // El roster necesita poder explicar el score, no solo calcularlo. Estas
    // lecturas son best-effort y solo se hacen en la vista global: equipo
    // exacto, casts y estado de cada defensivo al morir ya están persistidos
    // en los registros del pull, así que no se vuelve a consultar WCL.
    let evidenceRecords: RawReliabilityEvidenceRecord[] = [];
    let evidencePulls: ReliabilityEvidencePull[] = [];
    let bossNames = new Map<string, string>();
    if (!scope && data.length) {
      const pullIds = [...new Set(data.map((row) => row.pull_id))];
      const bossIds = [...new Set(data.map((row) => row.boss_id))];
      const [recordsResponse, pullsResponse, bossesResponse] = await Promise.all([
        this.supabase.client
          .from('player_pull_records')
          .select('pull_id, player_name, death_cause, defensive_casts, equipped_items')
          .in('pull_id', pullIds),
        this.supabase.client
          .from('pulls')
          .select(
            'id, report_code, fight_id, boss_id, difficulty, pull_number, closed_at, wipe_call_excluded, wipe_call_signals',
          )
          .in('id', pullIds),
        this.supabase.client
          .from('known_raid_bosses')
          .select('encounter_id, boss_name')
          .in('encounter_id', bossIds.map(Number).filter(Number.isFinite)),
      ]);
      if (!recordsResponse.error)
        evidenceRecords = (recordsResponse.data ?? []) as RawReliabilityEvidenceRecord[];
      if (!pullsResponse.error)
        evidencePulls = (pullsResponse.data ?? []) as ReliabilityEvidencePull[];
      if (!bossesResponse.error) {
        bossNames = new Map(
          (
            (bossesResponse.data ?? []) as { encounter_id: number | string; boss_name: string }[]
          ).map((boss) => [String(boss.encounter_id), boss.boss_name]),
        );
      }
    }
    const evidenceRecordByPlayerPull = new Map(
      evidenceRecords.map((record) => [`${record.player_name}|${record.pull_id}`, record]),
    );
    const evidencePullById = new Map(evidencePulls.map((pull) => [pull.id, pull]));

    const byPlayer = new Map<string, ReliabilityInputRow[]>();
    for (const row of data) {
      if (!byPlayer.has(row.player_name)) byPlayer.set(row.player_name, []);
      byPlayer.get(row.player_name)!.push(row);
    }
    // §"todo el roster de todas las pantallas... tiene que ser el oficial de
    // wowaudit": con el roster sincronizado, ES la lista — ni de menos (un
    // jugador del roster sin pulls todavía sigue apareciendo, "sin datos")
    // ni de más (un nombre con pulls que NO está en wowaudit — un pug, un
    // sub puntual, un nombre mal escrito por WCL — no se enseña como si
    // fuera roster). Sin sync todavía (roster vacío, best-effort de arriba),
    // se degrada al comportamiento anterior: quien tenga pulls, aparece.
    if (roster.length) {
      byPlayer.forEach((_, name) => {
        if (!rosterByName.has(name)) byPlayer.delete(name);
      });
      // Rellenar con roster sin datos SOLO en la vista general (§12) — en
      // una vista acotada a un boss (scope), listar a todo el mundo que
      // nunca lo ha intentado no aporta nada, solo ruido.
      if (!scope) {
        for (const entry of roster) {
          if (!byPlayer.has(entry.name)) byPlayer.set(entry.name, []);
        }
      }
    }

    const now = Date.now();
    const midpoint = now - (WINDOW_DAYS / 2) * 86_400_000;
    const results: PlayerReliability[] = [];
    for (const [playerName, rows] of byPlayer) {
      // Para la pantalla operativa importa cómo llegó a la última noche,
      // no el objeto sin encantar que pudo equipar a mitad de raid. Se toma
      // la primera aparición del jugador por fecha (dos uploads del mismo día
      // siguen siendo una noche) y, de ellas, la fecha más reciente.
      let latestGemCount: number | null = null;
      let latestGemmedSlotCount: number | null = null;
      let latestGemmableSlotCount: number | null = null;
      let latestEnchantedSlotCount: number | null = null;
      let latestEnchantableSlotCount: number | null = null;
      let latestMissingEnchantSlots: string[] = [];
      let latestMissingGemSlots: string[] = [];
      let latestPreparationObservedAt: string | null = null;
      let lastObservedAt: string | null = null;
      const firstRowByNight = new Map<string, ReliabilityInputRow>();
      for (const r of rows) {
        if (lastObservedAt == null || r.closed_at > lastObservedAt) lastObservedAt = r.closed_at;
        const nightKey = r.closed_at.slice(0, 10);
        const first = firstRowByNight.get(nightKey);
        if (!first || r.closed_at < first.closed_at) firstRowByNight.set(nightKey, r);
      }
      let latestPreparationRow: ReliabilityInputRow | null = null;
      for (const row of firstRowByNight.values()) {
        if (!latestPreparationRow || row.closed_at > latestPreparationRow.closed_at)
          latestPreparationRow = row;
      }
      if (latestPreparationRow) {
        latestGemCount = latestPreparationRow.gem_count;
        latestGemmedSlotCount = latestPreparationRow.gemmed_slot_count;
        latestGemmableSlotCount = latestPreparationRow.gemmable_slot_count;
        latestEnchantedSlotCount = latestPreparationRow.enchanted_slot_count;
        latestEnchantableSlotCount = latestPreparationRow.enchantable_slot_count;
        latestPreparationObservedAt = latestPreparationRow.closed_at;
        const preparationRecord = evidenceRecordByPlayerPull.get(
          `${playerName}|${latestPreparationRow.pull_id}`,
        );
        if (preparationRecord?.equipped_items) {
          const preparation = gearPreparationDetails(preparationRecord.equipped_items);
          latestMissingEnchantSlots = preparation.missingEnchantSlots;
          latestMissingGemSlots = preparation.missingGemSlots;
        }
      }

      // Eje asistencia: de reports REALMENTE importados en Avoid desde el
      // inicio de season (attendance.service.ts), no del calendario propio
      // de wowaudit — ver comentario ahí. null si no hay reports importados
      // todavía desde el inicio de season, o el jugador no aparece en ninguno.
      const rosterEntry = rosterByName.get(playerName);
      const attendance = realAttendance.get(playerName) ?? null;
      const asistencia = attendance?.pct ?? null;
      const result = computeReliabilityBreakdown(rows, now, asistencia);
      const overall = result?.overall ?? 0;
      const { mecanica, defensiva, preparacion } = result?.breakdown ?? {
        mecanica: null,
        defensiva: null,
        preparacion: null,
      };
      const observedAxisCount = result
        ? Object.values(result.breakdown).filter((value) => value != null).length
        : 0;
      // Antes se sumaban `defensive_use_opportunity` y la evaluación al
      // morir como si fueran oportunidades independientes. Una misma fila
      // podía aportar 2 y la UI llegaba a enseñar más oportunidades que
      // pulls. Son dos muestras distintas y así se conservan desde aquí.
      const defensiveOpportunityCount = rows.filter((row) => row.defensive_use_opportunity).length;
      const defensiveUseCount = rows.filter(
        (row) => row.defensive_use_opportunity && row.used_defensive_in_pull,
      ).length;
      const defensiveDeathOpportunityCount = rows.filter(
        (row) => row.used_defensive_when_died != null,
      ).length;
      const defensiveDeathUseCount = rows.filter(
        (row) => row.used_defensive_when_died === true,
      ).length;

      const spellUsage = new Map<
        string,
        { spellId: number; name: string; castCount: number; pullIds: Set<string> }
      >();
      const defensiveDeathEvidence: DefensiveDeathEvidence[] = [];
      for (const row of rows) {
        const record = evidenceRecordByPlayerPull.get(`${playerName}|${row.pull_id}`);
        const pull = evidencePullById.get(row.pull_id);
        if (!record || !pull) continue;
        const wipeCallStartMs =
          pull.wipe_call_excluded && typeof pull.wipe_call_signals?.wipeCallStartMs === 'number'
            ? pull.wipe_call_signals.wipeCallStartMs
            : null;
        for (const defensive of record.defensive_casts ?? []) {
          const castCount = (defensive.timestampsMs ?? []).filter(
            (timestamp) => wipeCallStartMs == null || timestamp < wipeCallStartMs,
          ).length;
          if (!castCount) continue;
          const key = `${defensive.spellId}|${defensive.name}`;
          const current = spellUsage.get(key) ?? {
            spellId: defensive.spellId,
            name: defensive.name,
            castCount: 0,
            pullIds: new Set<string>(),
          };
          current.castCount += castCount;
          current.pullIds.add(row.pull_id);
          spellUsage.set(key, current);
        }

        if (row.used_defensive_when_died == null) continue;
        const cause = record.death_cause;
        const options = cause?.defensiveOptions ?? [];
        defensiveDeathEvidence.push({
          pullId: row.pull_id,
          bossId: row.boss_id,
          bossName: bossNames.get(row.boss_id) ?? `Boss ${row.boss_id}`,
          difficulty: row.difficulty,
          reportCode: pull.report_code,
          fightId: pull.fight_id,
          pullNumber: pull.pull_number,
          closedAt: pull.closed_at,
          mechanicId: cause?.mechanicId ?? null,
          mechanicName: cause?.mechanicName ?? 'Causa sin identificar',
          usedDefensive: row.used_defensive_when_died === true,
          availableUnused: options
            .filter((option) => option.status === 'available_unused')
            .map((option) => ({ spellId: option.spellId, name: option.name })),
          active: options
            .filter((option) => option.status === 'active')
            .map((option) => ({ spellId: option.spellId, name: option.name })),
          onCooldown: options
            .filter((option) => option.status === 'on_cooldown')
            .map((option) => ({
              spellId: option.spellId,
              name: option.name,
              cooldownRemainingMs: option.cooldownRemainingMs ?? null,
            })),
        });
      }
      const defensiveSpellUsage: DefensiveSpellUsage[] = [...spellUsage.values()]
        .map((usage) => ({
          spellId: usage.spellId,
          name: usage.name,
          castCount: usage.castCount,
          pullCount: usage.pullIds.size,
        }))
        .sort((a, b) => b.castCount - a.castCount || a.name.localeCompare(b.name, 'es'));
      defensiveDeathEvidence.sort((a, b) => b.closedAt.localeCompare(a.closedAt));

      // §12.5 "flecha de tendencia": mismo cálculo aplicado a cada mitad
      // cronológica de la ventana — sin recalcular nada nuevo, solo
      // particionando las filas que ya se trajeron. Si alguna mitad se
      // queda sin pulls (jugador nuevo en la guild, o hueco real sin
      // asistir), trend queda null — no es lo mismo "sin dato" que "estable".
      const olderScore = computeOverall(
        rows.filter((r) => new Date(r.closed_at).getTime() < midpoint),
        now,
      );
      const newerScore = computeOverall(
        rows.filter((r) => new Date(r.closed_at).getTime() >= midpoint),
        now,
      );
      let trend: PlayerReliability['trend'] = null;
      if (olderScore != null && newerScore != null) {
        const delta = newerScore - olderScore;
        trend = delta >= TREND_THRESHOLD ? 'up' : delta <= -TREND_THRESHOLD ? 'down' : 'flat';
      }

      results.push({
        playerName,
        overall,
        breakdown: { mecanica, defensiva, preparacion, asistencia },
        consistency: result?.consistency ?? null,
        latestGemCount,
        latestGemmedSlotCount,
        latestGemmableSlotCount,
        latestEnchantedSlotCount,
        latestEnchantableSlotCount,
        latestMissingEnchantSlots,
        latestMissingGemSlots,
        latestPreparationObservedAt,
        sampleSize: rows.length,
        sampleNightCount: firstRowByNight.size,
        lastObservedAt,
        defensiveOpportunityCount,
        defensiveUseCount,
        defensiveDeathOpportunityCount,
        defensiveDeathUseCount,
        defensiveSpellUsage,
        defensiveDeathEvidence,
        observedAxisCount,
        attendanceNightsAttended: attendance?.attended ?? null,
        attendanceNightsTotal: attendance?.total ?? null,
        trend,
        role: rosterEntry?.role ?? null,
        rank: rosterEntry?.rank ?? null,
      });
    }

    // §"clasifícalos tanks primero, luego healers y luego DPS": orden de rol
    // fijo (el mismo que usa cualquier UI de raid — LFG, WCL, wowaudit
    // mismo), fiabilidad como criterio de desempate dentro de cada rol.
    // null (no cruza con wowaudit) se queda al final, después de DPS.
    return results.sort((a, b) => {
      const roleDelta = ROLE_SORT_ORDER[a.role ?? 'unknown'] - ROLE_SORT_ORDER[b.role ?? 'unknown'];
      return roleDelta !== 0 ? roleDelta : b.overall - a.overall;
    });
  }

  /**
   * §"consistente... contemplar muchas posibilidades distintas" (feedback
   * real, 2026-08-28): filas crudas de player_pull_reliability_inputs para
   * los pulls de UNA noche — night-player-summary.service.ts las reutiliza
   * para que pullScore comparta EXACTAMENTE el mismo ratio avoidable-ground/
   * spread (y el mismo conteo de mecánica) que ya usa el eje Mecánica de
   * fiabilidad, en vez de re-derivarlo con su propia lógica. getNightReliability
   * (debajo) es el otro consumidor — factorizado aquí para no traer los
   * pulls del report dos veces.
   */
  async getPlayerPullReliabilityInputsForReport(
    reportCode: string,
    playerName: string,
  ): Promise<ReliabilityInputRow[]> {
    const { data: pulls } = await this.supabase.client.from('pulls').select('id').eq('report_code', reportCode);
    const pullIds = ((pulls ?? []) as { id: string }[]).map((p) => p.id);
    if (!pullIds.length) return [];
    return this.fetchReliabilityInputs({ playerName, pullIds });
  }

  /**
   * §"fiabilidad en el dosier debería tener 2 valores: fiabilidad a 60 días
   * y fiabilidad de la noche" (feedback real): MISMA fórmula
   * (computeReliabilityBreakdown), acotada a los pulls de un solo
   * report_code en vez de la ventana de 60 días — sin eje asistencia (no
   * tiene sentido sobre una sola noche). null si el jugador no tiene ningún
   * pull evaluable esa noche.
   */
  async getNightReliability(
    reportCode: string,
    playerName: string,
  ): Promise<ReliabilityBreakdown & { sampleSize: number }> {
    const rows = await this.getPlayerPullReliabilityInputsForReport(reportCode, playerName);
    if (!rows.length)
      return {
        overall: 0,
        breakdown: { mecanica: null, defensiva: null, preparacion: null, asistencia: null },
        consistency: null,
        sampleSize: 0,
      };

    const result = computeReliabilityBreakdown(rows, Date.now());
    return result
      ? { ...result, sampleSize: rows.length }
      : {
          overall: 0,
          breakdown: { mecanica: null, defensiva: null, preparacion: null, asistencia: null },
          consistency: null,
          sampleSize: 0,
        };
  }
}
