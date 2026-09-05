// Colocar en: supabase/functions/_shared/damage-pressure-windows.ts
// §"picos de daño... juntando ventanas de daño sufrido + defensivos que usa
// y tiene disponible... no es lo mismo tener 3 defensivos y usar solo 1, que
// tener 1 solo y usarlo" (feedback real, 2026-08-29): hoy Fiabilidad/pullScore
// solo saben "¿hubo presión en el pull? sí/no" y "¿usó algo? sí/no" —
// booleanos por pull entero (ver player_pull_reliability_inputs.
// defensive_use_opportunity/used_defensive_in_pull). Este módulo detecta
// CADA ventana de presión real dentro de un pull y evalúa, para cada una,
// si había algo que pulsar y si lo pulsó — la cuenta real que pedía el
// feedback, no un booleano.
//
// §diseño validado empíricamente contra 3 pulls reales y 5 perfiles de
// clase/rol distintos antes de escribir esto (ver conversación real,
// 2026-08-29):
//  - Fuente: report.graph(dataType: DamageTaken, hostilityType: Friendlies)
//    — el MISMO endpoint que la gráfica de "daño recibido" de la propia web
//    de WCL, un bucket por jugador ya agregado server-side (analyze-report
//    ya lo pide para raid_damage_taken_series — este módulo reutiliza la
//    MISMA respuesta, sin llamada nueva a WCL).
//  - Umbral relativo a la LÍNEA BASE PROPIA de cada jugador en ese pull
//    (mediana de sus propios buckets con daño>0), no un % fijo de vida — un
//    umbral fijo confundía daño sostenido normal de un tank (línea base alta)
//    con presión real; verificado en real: Pitpally (Tank) pasó de 24
//    "picos" falsos en un pull limpio a 0 con este cambio.
//  - Ventana = TRAMO contiguo por encima del umbral (inicio→fin), no un
//    punto — verificado en real que un pico real de WCL es una joroba de
//    10-15s, no un instante, y la muerte real a veces cae en la cola de
//    bajada, no en el máximo exacto (caso real: Skilles, murió en pleno
//    tramo de bajada, 12s después del máximo detectado).
export interface DamageWindow {
  /** Ms desde el inicio del fight — mismo espacio de tiempo que trigger_time_ms/timeMs en el resto del pipeline. */
  startMs: number;
  endMs: number;
  peakMs: number;
  peakValue: number;
}

export interface DamageWindowDetection {
  /** Mediana de los buckets con daño>0 — línea base propia de este jugador en este pull, para poder auditar el umbral en el tooltip. */
  baselineValue: number;
  windows: DamageWindow[];
}

import { defensiveStatusAt, type CooldownCatalog } from './defensive-cooldowns.ts';

const DEFAULT_FACTOR = 2.5;
const MIN_NONZERO_BUCKETS = 3; // con menos de esto no hay línea base fiable — sin ventanas, no un umbral inventado

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * `points`/`pointStart`/`pointIntervalMs` = exactamente la forma de
 * WclGraphSeries (ver wcl-client.ts) para UN jugador — uno de los `series`
 * que devuelve getFightGraph(dataType: DamageTaken, hostilityType: Friendlies).
 */
export function detectDamageWindows(
  points: number[],
  pointStart: number,
  pointIntervalMs: number,
  factor = DEFAULT_FACTOR,
): DamageWindowDetection {
  const nonZero = points.filter((v) => v > 0);
  if (nonZero.length < MIN_NONZERO_BUCKETS) return { baselineValue: 0, windows: [] };
  const baselineValue = median(nonZero);
  const threshold = baselineValue * factor;

  interface RawRun { startIdx: number; endIdx: number; peakIdx: number; peakValue: number }
  const runs: RawRun[] = [];
  let cur: RawRun | null = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i] >= threshold) {
      if (!cur) cur = { startIdx: i, endIdx: i, peakIdx: i, peakValue: points[i] };
      else {
        cur.endIdx = i;
        if (points[i] > cur.peakValue) {
          cur.peakValue = points[i];
          cur.peakIdx = i;
        }
      }
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  return {
    baselineValue,
    windows: runs.map((raw) => ({
      startMs: pointStart + raw.startIdx * pointIntervalMs,
      endMs: pointStart + raw.endIdx * pointIntervalMs,
      peakMs: pointStart + raw.peakIdx * pointIntervalMs,
      peakValue: raw.peakValue,
    })),
  };
}

export interface DamageWindowOption {
  spellId: number;
  name: string;
  survivalType: string | null;
  status: 'active' | 'available_unused' | 'on_cooldown' | 'unknown' | 'used_during_window';
  cooldownRemainingMs?: number;
}

export interface DamageWindowCoverage {
  covered: boolean;
  /** @deprecated Compatibilidad v1; el evaluator v2 decide oportunidades. */
  coverable: boolean;
  options: DamageWindowOption[];
}

export interface DominantAbility {
  abilityGameID: number;
  totalDamage: number;
}

// §"relacionar 'pico de daño recibido' con una habilidad del boss... de
// forma veraz" (feedback real, 2026-08-29): validado empíricamente contra
// datos reales (Pitpally, Nek'zali) antes de escribir esto — la ventana con
// más contribución de una sola abilityGameID en el rango es la respuesta
// real a "qué le pegó" (Hollowing Strikes/Possession Barrage/Melee salieron
// todos coherentes con la mecánica real del boss en ese momento).
export const DAMAGE_WINDOW_EVENT_PADDING_MS = 2000; // una ventana de 1 solo bucket (startMs===endMs) puede no dejar ningún evento exacto dentro del rango sin este margen

/** Geometría canónica compartida por attribution y Episode Evaluator. */
export function isDamageEventWithinPressureWindow(
  timestamp: number,
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  const from = Math.min(windowStartMs, windowEndMs) - DAMAGE_WINDOW_EVENT_PADDING_MS;
  const to = Math.max(windowStartMs, windowEndMs) + DAMAGE_WINDOW_EVENT_PADDING_MS;
  return timestamp >= from && timestamp <= to;
}

/**
 * `events` = eventos crudos DamageTaken (mismos que ya trae analyze-report
 * con includeResources para computeDamageProfile) — mismo espacio de tiempo
 * (absoluto) que windowStartMs/windowEndMs, igual que evaluateWindowCoverage.
 */
export function attributeWindowAbility(
  events: { timestamp?: number; abilityGameID?: number; amount?: number }[],
  windowStartMs: number,
  windowEndMs: number,
): DominantAbility | null {
  const byAbility = new Map<number, number>();
  for (const e of events) {
    if (!(typeof e.amount === 'number' && e.amount > 0)) continue;
    if (typeof e.abilityGameID !== 'number') continue;
    if (typeof e.timestamp !== 'number' || !isDamageEventWithinPressureWindow(e.timestamp, windowStartMs, windowEndMs)) continue;
    byAbility.set(e.abilityGameID, (byAbility.get(e.abilityGameID) ?? 0) + e.amount);
  }
  let best: DominantAbility | null = null;
  for (const [abilityGameID, totalDamage] of byAbility) {
    if (!best || totalDamage > best.totalDamage) best = { abilityGameID, totalDamage };
  }
  return best;
}

/**
 * §"confirmando que en cada ventana en efecto lo tienes disponible no sirve
 * con darlo por hecho" (feedback real, 2026-08-29): reutiliza defensiveStatusAt
 * (la MISMA fórmula que ya evalúa death_cause.defensiveOptions, cast+cooldown
 * reales, no una suposición) evaluada en windowStartMs, más una comprobación
 * directa de "¿hubo un cast REAL dentro del propio tramo de la ventana?"
 * (usedDuringWindow) — cubre el caso de un defensivo lanzado a mitad de la
 * joroba, no solo el que ya estaba activo al empezar.
 *
 * §"no todo lo superior a 90s es de emergencia... ya estamos clasificando
 * los defensivos y tenemos la categoría de emergencia" (feedback real,
 * 2026-08-29): un survivalType==='emergency' disponible NUNCA marca la
 * ventana como "cubrible" (fallo) por sí solo — guardarlo es la jugada
 * correcta la mayoría de las veces. Si SÍ se usó, ya cuenta como `covered`
 * más arriba, igual que cualquier otro.
 */
export function evaluateWindowCoverage(
  windowStartMs: number,
  windowEndMs: number,
  catalog: CooldownCatalog,
  castsBySpellId: Map<number, number[]>,
): DamageWindowCoverage {
  const options: DamageWindowOption[] = catalog.map((cd) => {
    const casts = castsBySpellId.get(cd.spellId) ?? [];
    const usedDuringWindow = casts.some((t) => t >= windowStartMs && t <= windowEndMs);
    const atStart = defensiveStatusAt(cd, casts, windowStartMs);
    const status = atStart.status === 'active' ? 'active' : usedDuringWindow ? 'used_during_window' : atStart.status;
    return { spellId: cd.spellId, name: cd.name, survivalType: cd.survivalType, status, cooldownRemainingMs: atStart.cooldownRemainingMs };
  });
  const covered = options.some((o) => o.status === 'active' || o.status === 'used_during_window');
  const coverable = !covered && options.some((o) => o.status === 'available_unused' && o.survivalType !== 'emergency');
  return { covered, coverable, options };
}
