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

const WINDOW_DAYS = 60; // "varias noches o semanas", no los 21 días de una versión anterior
const HALF_LIFE_DAYS = 10; // un pull de hace 10 días pesa la mitad que uno de hoy
const AXIS_WEIGHTS = { mecanica: 0.4, defensiva: 0.3, preparacion: 0.2, asistencia: 0.1 } as const;

export interface PlayerReliability {
  playerName: string;
  overall: number;
  breakdown: { mecanica: number | null; defensiva: number | null; preparacion: number | null; asistencia: number | null };
  consistency: PlayerConsistency | null;
  /** Gemas totales del pull más reciente; el score usa slots elegibles cubiertos, no esta cantidad bruta. */
  latestGemCount: number | null;
  latestGemmedSlotCount: number | null;
  latestGemmableSlotCount: number | null;
  /** Nº de pulls con al menos un dato aprovechable en la ventana — no es lo mismo un 92 sobre 40 pulls que un 92 sobre 3. */
  sampleSize: number;
  /** §12.5: flecha de tendencia — primera mitad de la ventana vs. segunda mitad, mismo cálculo que `overall` aplicado a cada mitad. null = alguna mitad no tiene datos suficientes para comparar (no es lo mismo "sin dato" que "estable"). Solo los ejes por pull (asistencia no se trae partida en dos mitades — exigiría dos llamadas a wowaudit con rangos distintos). */
  trend: 'up' | 'down' | 'flat' | null;
  /** §"roster de verdad": identidad real de wowaudit — null si el nombre no cruza (jugador nunca sincronizado, o nombre distinto entre WCL y wowaudit). */
  role: 'Tank' | 'Heal' | 'Melee' | 'Ranged' | null;
  rank: 'Main' | 'Trial' | null;
}

// Exportado: player-detail.service.ts reutiliza EXACTAMENTE esta misma
// fórmula (mecánica/defensiva/preparación, renormalizada) para partirla en
// cubos semanales — un "¿cómo va este jugador semana a semana?" no es una
// fórmula nueva, es la misma aplicada a un subconjunto de filas más pequeño.
export interface ReliabilityInputRow {
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
}

function recencyWeight(closedAtIso: string, now: number): number {
  const daysAgo = (now - new Date(closedAtIso).getTime()) / 86_400_000;
  return Math.pow(0.5, Math.max(0, daysAgo) / HALF_LIFE_DAYS);
}

export interface ReliabilityBreakdown {
  overall: number;
  breakdown: { mecanica: number | null; defensiva: number | null; preparacion: number | null; asistencia: number | null };
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
export function computeReliabilityBreakdown(rows: ReliabilityInputRow[], now: number, asistenciaPct: number | null = null): ReliabilityBreakdown | null {
  if (!rows.length) return null;
  let mecWeight = 0;
  let mecSum = 0;
  let defWeight = 0;
  let defSum = 0;
  let prepWeight = 0;
  let prepSum = 0;
  const pullExecution: { value: number; weight: number }[] = [];
  for (const r of rows) {
    const w = recencyWeight(r.closed_at, now);
    const mecClean = !r.had_avoidable_damage && !r.self_positioning_death ? 1 : 0;
    mecSum += mecClean * w;
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
    if (preparationSlots > 0) {
      prepSum += ((r.enchanted_slot_count + r.gemmed_slot_count) / preparationSlots) * w;
      prepWeight += w;
    }
    const mechanicExecution = mecClean * 100;
    const defensiveExecution = pullDefensiveWeight > 0 ? (pullDefensiveSum / pullDefensiveWeight) * 100 : null;
    pullExecution.push({ value: defensiveExecution == null ? mechanicExecution : mechanicExecution * 0.7 + defensiveExecution * 0.3, weight: w });
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
  const overall = weightSum > 0 ? Math.round(axes.reduce((s, a) => s + a.value * AXIS_WEIGHTS[a.key], 0) / weightSum) : 0;
  let consistency: PlayerConsistency | null = null;
  if (pullExecution.length >= 5) {
    const totalWeight = pullExecution.reduce((sum, sample) => sum + sample.weight, 0);
    const averageExecution = pullExecution.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / totalWeight;
    const variance = pullExecution.reduce((sum, sample) => sum + ((sample.value - averageExecution) ** 2) * sample.weight, 0) / totalWeight;
    const volatility = Math.sqrt(variance);
    consistency = {
      score: Math.round(Math.max(0, Math.min(100, averageExecution - volatility * 0.5))),
      averageExecution: Math.round(averageExecution),
      volatility: Math.round(volatility),
      cleanPullRate: Math.round((pullExecution.filter((sample) => sample.value >= 80).length / pullExecution.length) * 100),
      sampleSize: pullExecution.length,
    };
  }
  return { overall, breakdown: { mecanica, defensiva, preparacion, asistencia: asistenciaPct }, consistency };
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

const RELIABILITY_COLUMNS = 'player_name, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count, gemmed_slot_count, gemmable_slot_count';
const DEFENSIVE_RELIABILITY_COLUMNS = 'player_name, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count';
const LEGACY_RELIABILITY_COLUMNS = 'player_name, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, enchanted_slot_count, enchantable_slot_count, gem_count';

interface ReliabilityInputFilters {
  scope?: { bossId: string; difficulty: string };
  since?: string;
  playerName?: string;
  pullIds?: string[];
}

function isReliabilitySchemaTransitionError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  return (
    error.code === '42703'
    || error.code === 'PGRST204'
    || /used_defensive_in_pull|defensive_use_opportunity|gemmed_slot_count|gemmable_slot_count/i.test(message)
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
  private async fetchReliabilityInputs(filters: ReliabilityInputFilters): Promise<ReliabilityInputRow[]> {
    if (filters.pullIds && !filters.pullIds.length) return [];
    const run = async (columns: string) => {
      let query = this.supabase.client.from('player_pull_reliability_inputs').select(columns);
      if (filters.scope) query = query.eq('boss_id', filters.scope.bossId).eq('difficulty', filters.scope.difficulty);
      if (filters.since) query = query.gte('closed_at', filters.since);
      if (filters.playerName) query = query.eq('player_name', filters.playerName);
      if (filters.pullIds) query = query.in('pull_id', filters.pullIds);
      return await query;
    };

    let response = await run(RELIABILITY_COLUMNS);
    let schemaLevel: 'current' | 'defensive' | 'legacy' = 'current';
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
      used_defensive_in_pull: schemaLevel === 'legacy' ? false : row.used_defensive_in_pull === true,
      defensive_use_opportunity: schemaLevel === 'legacy' ? false : row.defensive_use_opportunity === true,
      gemmed_slot_count: schemaLevel === 'current' ? Number(row.gemmed_slot_count ?? 0) : 0,
      gemmable_slot_count: schemaLevel === 'current' ? Number(row.gemmable_slot_count ?? 0) : 0,
    }));
  }

  async getPlayerReliabilityInputs(playerName: string, since: string): Promise<ReliabilityInputRow[]> {
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
  async listPlayerReliability(scope?: { bossId: string; difficulty: string }): Promise<PlayerReliability[]> {
    const [data, roster, realAttendance] = await Promise.all([
      this.fetchReliabilityInputs(scope
        ? { scope }
        : { since: new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString() }),
      // best-effort: sin sync de wowaudit todavía, se sigue con mecánica+defensiva solamente (mismo comportamiento de antes).
      this.wowauditRoster.listRoster().catch(() => []),
      // §"la asistencia sigue saliendo rara" (feedback real, investigado):
      // ya NO se usa attendedPercentage de wowaudit (calcula sobre SU
      // calendario de eventos/firmas, no sobre raids reales — ver
      // attendance.service.ts) — se deriva de los reports que Avoid ya tiene
      // importados desde el inicio de la season.
      this.attendanceService.listRealAttendance().catch(() => new Map<string, { attended: number; total: number; pct: number | null }>()),
    ]);
    const rosterByName = new Map(roster.map((r) => [r.name, r]));

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
      // Snapshot del pull MÁS RECIENTE: la cantidad bruta se enseña como
      // contexto, pero Preparación usa cobertura de cuello/anillos para que
      // varias gemas en el cuello no oculten un anillo vacío.
      let latestGemCount: number | null = null;
      let latestGemmedSlotCount: number | null = null;
      let latestGemmableSlotCount: number | null = null;
      let latestClosedAt = '';
      for (const r of rows) {
        if (r.closed_at > latestClosedAt) {
          latestClosedAt = r.closed_at;
          latestGemCount = r.gem_count;
          latestGemmedSlotCount = r.gemmed_slot_count;
          latestGemmableSlotCount = r.gemmable_slot_count;
        }
      }

      // Eje asistencia: de reports REALMENTE importados en Avoid desde el
      // inicio de season (attendance.service.ts), no del calendario propio
      // de wowaudit — ver comentario ahí. null si no hay reports importados
      // todavía desde el inicio de season, o el jugador no aparece en ninguno.
      const rosterEntry = rosterByName.get(playerName);
      const asistencia = realAttendance.get(playerName)?.pct ?? null;
      const result = computeReliabilityBreakdown(rows, now, asistencia);
      const overall = result?.overall ?? 0;
      const { mecanica, defensiva, preparacion } = result?.breakdown ?? { mecanica: null, defensiva: null, preparacion: null };

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
        sampleSize: rows.length,
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
   * §"fiabilidad en el dosier debería tener 2 valores: fiabilidad a 60 días
   * y fiabilidad de la noche" (feedback real): MISMA fórmula
   * (computeReliabilityBreakdown), acotada a los pulls de un solo
   * report_code en vez de la ventana de 60 días — sin eje asistencia (no
   * tiene sentido sobre una sola noche). null si el jugador no tiene ningún
   * pull evaluable esa noche.
   */
  async getNightReliability(reportCode: string, playerName: string): Promise<ReliabilityBreakdown & { sampleSize: number }> {
    const client = this.supabase.client;
    const { data: pulls } = await client.from('pulls').select('id').eq('report_code', reportCode);
    const pullIds = ((pulls ?? []) as { id: string }[]).map((p) => p.id);
    if (!pullIds.length) return { overall: 0, breakdown: { mecanica: null, defensiva: null, preparacion: null, asistencia: null }, consistency: null, sampleSize: 0 };

    const rows = await this.fetchReliabilityInputs({ playerName, pullIds });
    const result = computeReliabilityBreakdown(rows, Date.now());
    return result ? { ...result, sampleSize: rows.length } : { overall: 0, breakdown: { mecanica: null, defensiva: null, preparacion: null, asistencia: null }, consistency: null, sampleSize: 0 };
  }
}
