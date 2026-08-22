// Colocar en: src/app/shared/models/ui.ts
import type { MechanicCategory } from './domain';
// Contrato de presentación de la vista Live Pull (§15.1 de la hoja de ruta).
// Estos tipos son deliberadamente distintos de las tablas de domain.ts: son
// lo que YA calculado espera cada componente — MetricCardComponent,
// MechanicTimelineComponent, etc. son "tontos a propósito" (spec dicta), no
// vuelven a derivar nada, solo pintan lo que les llega.

export interface MetricDelta {
  label: string; // "4pp vs anterior", "1 menos", "pulls seguidos"
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  direction?: 'up' | 'down'; // omitido en "Racha del problema", que no tiene flecha
}

export interface MetricCardData {
  label: string;
  value: string; // string, no number — así "66%" y "3" usan el mismo componente
  delta: MetricDelta | null; // null = sin comparación (primer pull de la noche sobre ese boss)
  provenance: ProvenanceEntry;
  /** Emoji del badge — mismo lenguaje de iconos que ya usa el resto de la app (💀/🪨/🧪 en callouts y consumibles), no un sistema de iconos SVG nuevo y aparte. */
  icon: string;
  /** Color del badge del icono — identidad visual de la tarjeta, no semántica de outcome (esa la sigue llevando `delta.tone`). */
  iconTone: 'accent' | 'danger' | 'warning' | 'gold';
  /** Solo la tarjeta de HP la trae — el resto no tiene un 0-100 natural que pintar como gauge. */
  gaugeValue?: number;
}

export interface TimelineChip {
  /** ms reales desde el inicio del pull — null en el hito sintético "sin manifiesto" (no representa un instante real). Hace falta para posicionar marcadores en la gráfica de daño, no solo para leer la hora en texto. */
  timeMs: number | null;
  timeLabel: string; // "0:52", monoespaciado
  description: string; // "ola veneno · 1 muerte"
  outcome: 'clean' | 'partial_fail' | 'fail' | 'neutral'; // 'neutral' = hitos sin mecánica (inicio, cambio de fase)
  provenance: ProvenanceEntry | null; // null en los hitos sintéticos (inicio del pull) — no hay fila que verificar
  /** spell_id de la mecánica, para el tooltip de Wowhead — null en los hitos sintéticos. */
  wowheadSpellId: number | null;
  /** tankbuster/raid-damage/... — null en hitos sintéticos o mecánicas sin categoría (ni confirmada ni sugerida) todavía. Si es una sugerencia sin confirmar, el detalle de provenance lo dice. */
  category: MechanicCategory | null;
}

/**
 * Un mensaje de callout se arma como una secuencia de fragmentos en vez de un
 * string plano: cada nombre de habilidad/defensivo mencionado es su PROPIO
 * fragmento con su propio spellId, así cada uno saca su propio tooltip de
 * Wowhead al pasar el ratón — un string plano tipo "murió a X · podía usar
 * Y/Z" solo puede llevar un data-wowhead para TODA la frase.
 */
export type CoachingCalloutPart = { kind: 'text'; text: string } | { kind: 'ability'; label: string; wowheadSpellId: number | null };

export interface CoachingCallout {
  raiderName: string;
  severity: 'critical' | 'warning' | 'positive';
  parts: CoachingCalloutPart[];
  provenance: ProvenanceEntry;
}

export interface LlmPullAnalysis {
  headline: string;
  improved: string[];
  regressed: string[];
  nextPullActions: string[];
  model: string;
}

/**
 * De dónde salió un dato y cómo se calculó, en texto llano (§8 de la hoja de
 * ruta). Sin columna `provenance jsonb` dedicada en el esquema nuevo — aquí
 * se construye en el momento de renderizar, porque el front ya sabe
 * exactamente qué tabla/fila/fórmula produjo cada número que está pintando.
 */
export interface ProvenanceEntry {
  source: string; // ej. "pulls.wipe_pct", "player_pull_records (7 filas)"
  method: string; // fórmula/regla aplicada, en una frase
  detail?: string; // contexto adicional (ej. lista de nombres, ids)
  wclReportCode?: string;
  wclFightId?: number;
}

export type PullResult = 'wipe' | 'kill';
export type PullDifficulty = 'lfr' | 'normal' | 'heroic' | 'mythic';

/** Ritmo del pull (solo tiene sentido en un kill) contra la MEDIANA de hasta 50 kills públicas del mismo boss+dificultad — a propósito nunca contra el #1 del mundo (ver boss_reference_stats / buildReferencePacing). */
export interface ReferencePacing {
  label: string; // "+18s vs. la mediana de 50 kills públicas (2:45)"
  tone: 'success' | 'warning' | 'neutral';
  /** "84% de esas 50 kills públicas se hicieron sin ninguna muerte" — contexto de cuán normal es un kill perfecto incluso arriba. */
  zeroDeathContext: string | null;
}
