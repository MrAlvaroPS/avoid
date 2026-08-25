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

export interface DefensiveRef {
  spellId: number;
  name: string;
  /** Solo relevante en defensivesOnCooldown — cuánto le faltaba en el instante exacto que representa esta fila. null = sin dato de cooldown base (extractor no lo resolvió). */
  cooldownRemainingMs: number | null;
  /** true = se lanzó dentro de los últimos ~10s antes de morir — el defensivo "gana peso" cuando está pegado a la muerte (lo usó y aun así no bastó, o lo tenía casi listo). */
  closeToDeath?: boolean;
}

/**
 * §"A QUIÉN DIRIGIR": pestaña Muertes. Columnas fijas — quién, qué mecánica,
 * minuto, oneshot sí/no, daño 5s, sanación 5-10s, defensivos disponibles,
 * defensivos en cooldown. Las mecánicas falladas SIN morir viven aparte en
 * MechanicFailRow (pestaña Mecánicas) — los datos disponibles no son los
 * mismos (aquí sí hay snapshot de defensivos activos en el momento exacto de
 * morir; en un fallo sin muerte no existe ese snapshot).
 */
export interface CoachingCallout {
  raiderName: string;
  /** §"pon icono de clase junto al nombre en 'a quién dirigir'" (feedback real): actor.subType de WCL tal cual ("DeathKnight"...) — null en la fila de racha rota, donde no se trae el registro completo del jugador. */
  raiderClass: string | null;
  /** 'critical' = murió. 'positive' = rompió una racha de muertes a la misma mecánica. */
  severity: 'critical' | 'positive';
  mechanic: { label: string; wowheadSpellId: number | null };
  /** §"poner una 'I' de información junto a la mecánica con la nota descriptiva que haya traído la IA" (feedback real): mismo texto que boss_mechanics_candidates.ai_classification.notes — null si esta mecánica no vino del flujo de clasificación por IA. */
  notes: string | null;
  /** Minuto de combate ("2:14") — vacío solo en la fila de racha rota, que no representa un instante concreto de ESTE pull. */
  timeLabel: string;
  /** §"la tabla de muertes debería estar ordenada por tiempo de muerte" (feedback real): ms crudos para poder ordenar cronológicamente — timeLabel es solo el texto ya formateado. null en la fila de racha rota (no es un instante de este pull). */
  timeMs: number | null;
  /** Solo tiene sentido si murió — null en la fila de racha rota. */
  oneshot: boolean | null;
  /** §"esa gente no debería... contar como muerte, marcado como wipe call" (feedback real): true = esta fila NO cuenta en el recuento de "Muertes" ni en fiabilidad/racha — se sigue mostrando (el RL quiere verla) pero marcada aparte en vez de mezclada con fallos reales. */
  isWipeCall: boolean;
  /** Mención contextual no atribuible al jugador (p. ej. Melee del boss sobre no-tank tras perder tanks). */
  statisticalExclusionReason: import('../death-statistics.util').DeathStatisticalExclusionReason | null;
  damageWindowTotal: number | null;
  /** 0 real = de verdad nadie le curó nada; no confundir con null (no evaluable). */
  healingWindowTotal: number | null;
  /** §"si tenía o no defensivo activo... eso es relevante para saber si usó algo o no": defensivos que YA tenía puestos (cast + duración real vs. momento de morir, o snapshot de buffs de WCL si la duración no se conoce todavía) en el instante exacto de morir — sí reaccionó, y aun así no bastó. Distinto de "disponible sin usar" (podía haberlo usado, no lo hizo). */
  defensivesActive: DefensiveRef[];
  defensivesAvailable: DefensiveRef[];
  defensivesOnCooldown: DefensiveRef[];
  provenance: ProvenanceEntry;
}

/**
 * §"A QUIÉN DIRIGIR": pestaña Mecánicas — quién se comió una mecánica de
 * responsabilidad individual sin llegar a morir por ella. Mismo espíritu que
 * CoachingCallout pero con los datos que SÍ existen para un instante que no
 * es una muerte: daño de esa instancia concreta (no una ventana genérica),
 * sanación recibida mientras duraba, y si hubo algún cast propio pegado a
 * ella (sin desglose disponible/en cooldown — eso exige el snapshot de
 * buffs que analyze-report solo toma al morir).
 */
export interface MechanicFailRow {
  raiderName: string;
  /** §"pon icono de clase junto al nombre" (feedback real): actor.subType de WCL tal cual ("DeathKnight"...). */
  raiderClass: string | null;
  mechanic: { label: string; wowheadSpellId: number | null };
  /** §"añade... una 'i' de información que abra... 'notas' de la mecánica que trajimos con el prompt en Ajustes" (feedback real): mismo texto que boss_mechanics_candidates.ai_classification.notes — null si esta mecánica no vino del flujo de clasificación por IA (clasificada a mano, o sin clasificar todavía). */
  notes: string | null;
  timeLabel: string;
  /** 'fail' = mató a la raid de otra mecánica cerca (raro verlo aquí, ya cubierto por CoachingCallout si murió). 'partial_fail' = demasiada gente golpeada para ser normal. */
  outcome: 'partial_fail' | 'fail';
  /** §"no estamos evaluando bien las mecánicas que se fallan" (feedback real): null = todavía sin categoría confirmada NI sugerida en el manifiesto — antes eso hacía que la fila desapareciera de esta pestaña por completo aunque SÍ contara en la tarjeta "Mecánicas falladas", la incoherencia señalada. Ahora se enseña igual, marcada "sin clasificar". */
  category: MechanicCategory | null;
  /** Cuánta gente golpeó esta instancia en total (no solo este jugador) — la señal que le hace falta al RL para juzgar a ojo una mecánica `category: null`: pocos golpeados = probablemente individual, casi toda la raid = probablemente raid-wide. */
  totalPlayersHit: number;
  damageTaken: number;
  healingReceived: number;
  /** spellId del cast propio más cercano (±10s) — null = no se le vio usar nada. */
  usedDefensiveSpellId: number | null;
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
  /** §13.4: secuencia real de golpes en los últimos segundos antes de morir — solo presente en el drawer de una muerte, no en el resto de provenance. */
  damageTimeline?: { timeLabel: string; amount: number; abilityLabel: string; wowheadSpellId: number | null }[];
}

export type PullResult = 'wipe' | 'kill';
export type PullDifficulty = 'lfr' | 'normal' | 'heroic' | 'mythic';

/** Ritmo del pull (solo tiene sentido en un kill) contra la MEDIANA de hasta 50 kills públicas del mismo boss+dificultad — a propósito nunca contra el #1 del mundo (ver boss_reference_stats / buildReferencePacing). */
export interface ReferencePacing {
  label: string; // "+18s vs. la mediana de 50 kills públicas (2:45)"
  tone: 'success' | 'warning' | 'neutral';
  /** "84% de esas 50 kills públicas se hicieron sin ninguna muerte" — contexto de cuán normal es un kill perfecto incluso arriba. */
  zeroDeathContext: string | null;
  /** §7.2 .compare-bar-row: los dos números crudos detrás de `label`, para dibujar la barra real en vez de repetir el cálculo. */
  yourDurationMs: number;
  medianDurationMs: number;
}
