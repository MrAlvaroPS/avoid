// Formateo de cifras — nunca en los templates de los componentes "tontos"
// (PullHeaderComponent, MetricCardComponent...), que reciben todo ya
// formateado como string, tal como pide la spec §15.1.

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Igual que formatDuration pero para offsets que pueden ser negativos (raro, pero un evento justo en el borde de la ventana puede redondear a -0). */
export function formatTimeLabel(ms: number): string {
  return formatDuration(Math.max(0, ms));
}

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null) return '—';
  return `${value.toFixed(digits).replace(/\.0+$/, '')}%`;
}

// §"muestra el percentil + fuente" (feedback real, 2026-08-27): compartido
// entre el dosier y el informe de noche — nunca mezclar las dos fuentes sin
// decir cuál es. own_history (más representativo) vs world_reference
// (sesgado a los mejores del mundo, se dice explícitamente) vs
// fixed_threshold (sin comparación real todavía, se dice también en vez de
// callarlo). Ver resolveSeverity en supabase/functions/_shared/mechanic-severity.ts.
export function comparisonLabel(source: 'own_history' | 'world_reference' | 'fixed_threshold' | null, percentile: number | null): string | null {
  if (source === 'own_history' && percentile != null) return `Peor que el ${formatPct(percentile)} de tus kills anteriores`;
  if (source === 'world_reference' && percentile != null) return `Peor que el ${formatPct(percentile)} de las mejores kills públicas del mundo`;
  if (source === 'fixed_threshold') return 'Umbral fijo — sin historial suficiente todavía';
  return null;
}

// §3.1/§7.1: banda de color del percentil de WCL (parse) — mismo lenguaje de
// estado (--danger/--warning/--success) que ya usa el resto de la app, no una
// paleta categórica nueva (esto es "qué tal va", no "qué es"). Antes vivía
// solo en player-stats-table.component.ts (percentil por pull); night-report
// lo reutiliza tal cual para el percentil medio de la noche — mismos
// umbrales, un único sitio que los define.
export function percentileTone(pct: number | null): 'danger' | 'warning' | 'success' | 'neutral' {
  if (pct == null) return 'neutral';
  if (pct < 25) return 'danger';
  if (pct < 75) return 'warning';
  return 'success';
}

// §"sigue este mismo código de colores que usan en WCL para el parse: 0–24
// gris, 25–49 verde, 50–74 azul, 75–94 morado, 95–98 naranja, 99 rosa, 100
// dorado" (feedback real, 2026-08-30): el esquema de 3 bandas de
// percentileTone (danger/warning/success) es el lenguaje de "qué tal va"
// del resto de la app — para el parse en sí, la gente ya reconoce las 7
// bandas reales de WCL (mismos colores que la rareza de objetos de WoW:
// gris/verde/azul/morado/naranja/rosa/dorado), así que aquí se sigue ESE
// esquema en vez de reducirlo a 3. Función aparte de percentileTone (que
// sigue viva para live-pull/player-stats-table.component.ts, nunca tocada
// por este cambio) — dos preguntas distintas ("¿qué tal va?" vs "¿qué
// banda de WCL es?"), nunca la misma función con dos significados.
export type WclParseTier = 'grey' | 'green' | 'blue' | 'purple' | 'orange' | 'pink' | 'gold';
export function wclParseTier(pct: number | null): WclParseTier | null {
  if (pct == null) return null;
  if (pct >= 100) return 'gold';
  if (pct >= 99) return 'pink';
  if (pct >= 95) return 'orange';
  if (pct >= 75) return 'purple';
  if (pct >= 50) return 'blue';
  if (pct >= 25) return 'green';
  return 'grey';
}

const WCL_DIFFICULTY_LABEL: Record<string, string> = {
  LFR: 'lfr',
  Normal: 'normal',
  Heroic: 'heroic',
  Mythic: 'mythic',
};

/** 'Normal'/'Heroic'/'Mythic'/'LFR' (tal como los guarda pulls.difficulty) -> el union type en minúsculas que espera PullHeaderComponent. */
export function normalizeDifficulty(raw: string): 'lfr' | 'normal' | 'heroic' | 'mythic' {
  return (WCL_DIFFICULTY_LABEL[raw] as 'lfr' | 'normal' | 'heroic' | 'mythic') ?? 'normal';
}

// Mismo mapeo que WCL_DIFFICULTY_NAME_BY_ID en las Edge Functions
// (analyze-report, sync-boss-mechanics) — se repite aquí porque es un
// runtime distinto (Deno vs. navegador) y no comparten módulo. Si cambia
// uno, cambia el otro.
export const WCL_DIFFICULTY_NAME_BY_ID: Record<number, string> = { 1: 'LFR', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };

// Antes duplicada como STANDARD_DIFFICULTY_IDS solo dentro de
// manifest.component.ts (§9.1) — se sube aquí para que reports.service.ts
// (progreso de temporada por dificultad) use la misma fuente en vez de
// teclear [3,4,5] una segunda vez.
//
// §"podemos quitar la dificultad LFR de ajustes, del prompt y de la
// sincronización... no es relevante para nada y nos ahorrará unos tokens y
// molestias" (feedback real, 2026-08-27): LFR (id 1) queda fuera a
// propósito — ni un solo pull real de la guild en LFR hasta la fecha
// (contrastado en real: pulls.difficulty solo trae Normal/Heroic), y era
// además la dificultad estructuralmente más ambigua de mapear contra DB2
// (ver difficulty-mapping.ts). Menos dificultades por sync/prompt también
// reduce el volumen de llamadas a WCL, que es justo lo que hace saltar el
// rate limit de la API (§bug real reportado el mismo día). WCL_DIFFICULTY_NAME_BY_ID
// conserva la entrada 1:'LFR' por si algún pull histórico la necesita para
// mostrarse, solo deja de OFRECERSE activamente en sync/Ajustes/prompt.
export const STANDARD_DIFFICULTY_IDS = [3, 4, 5] as const;

import type { DefensiveSurvivalType, MechanicCategory } from './models/domain';

// Paleta categórica de 9 huecos — validada de verdad, no a ojo, contra la
// superficie oscura real de la app:
//   node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767,#1aa6b5" --mode dark --surface "#080810"
//   -> ALL CHECKS PASS (lightness band, chroma floor, CVD ΔE 8.4, normal-vision ΔE 19.3, contraste 3:1).
// El 9º hueco (cian, #1aa6b5) se añadió al incorporar personal-target — no
// es un tono elegido a ojo: varios candidatos (teal apagado, marrón) fallaron
// el validador (chroma floor / normal-vision floor) antes de dar con este.
// Orden FIJO — la misma categoría siempre pinta el mismo color en toda la
// app (dataviz: "color follows the entity, never its rank"), nunca se
// reasigna según qué categorías estén presentes en un pull concreto.
// 10º hueco (magenta apagado, #a3568a) añadido al incorporar 'enrage' —
// validado igual que el resto, no elegido a ojo:
//   node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767,#1aa6b5,#a3568a" --mode dark --surface "#080810"
//   -> ALL CHECKS PASS (CVD ΔE 8.4, normal-vision ΔE 19.3, contraste 3:1).
export const CATEGORY_PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#1aa6b5', '#a3568a'];

const MECHANIC_CATEGORY_META: Record<MechanicCategory, { short: string; label: string; cls: string; color: string }> = {
  'raid-damage': { short: 'RAID', label: 'Daño de raid', cls: 'cat-raid-damage', color: CATEGORY_PALETTE[0] },
  'avoidable-ground': { short: 'SUELO', label: 'Zona evitable', cls: 'cat-avoidable-ground', color: CATEGORY_PALETTE[1] },
  soak: { short: 'SOAK', label: 'Soak (agruparse)', cls: 'cat-soak', color: CATEGORY_PALETTE[2] },
  spread: { short: 'SPREAD', label: 'Separarse', cls: 'cat-spread', color: CATEGORY_PALETTE[3] },
  tankbuster: { short: 'TB', label: 'Tankbuster', cls: 'cat-tankbuster', color: CATEGORY_PALETTE[4] },
  'debuff-stack': { short: 'STACK', label: 'Debuff acumulativo', cls: 'cat-debuff-stack', color: CATEGORY_PALETTE[5] },
  interrupt: { short: 'INT', label: 'Interrupción', cls: 'cat-interrupt', color: CATEGORY_PALETTE[6] },
  'healing-absorb': { short: 'ABSORB', label: 'Absorción de curación', cls: 'cat-healing-absorb', color: CATEGORY_PALETTE[7] },
  // §"cuando eres target y te toca hacer algo sí o sí, sin más": objetivo
  // individual elegido por el boss, sin afinidad de rol tank (eso ya lo
  // cubre 'tankbuster') ni de posición en el suelo (eso ya lo cubre
  // 'avoidable-ground') — ver mechanic-category-inference.ts.
  'personal-target': { short: 'TARGET', label: 'Objetivo individual', cls: 'cat-personal-target', color: CATEGORY_PALETTE[8] },
  // §"nos hace falta la categoría de enrage" (feedback real): boss/add que
  // se enfurece (golpea más fuerte, castea más rápido, o entra en fase de
  // berserk) — no es daño repartido normal, no es posicional, no es un
  // jugador concreto, así que ninguna de las 9 categorías previas encajaba.
  enrage: { short: 'ENRAGE', label: 'Enrage', cls: 'cat-enrage', color: CATEGORY_PALETTE[9] },
};

export function mechanicCategoryMeta(category: MechanicCategory | null | undefined) {
  return category ? MECHANIC_CATEGORY_META[category] : null;
}

// §"pantalla nueva para clasificar defensivos... mitigation/absorption/
// sustain/emergency" (feedback real, definiciones del propio usuario): eje
// de "qué le hace un defensivo al daño entrante", distinto de category
// (a quién protege). Reutiliza dos huecos ya validados de CATEGORY_PALETTE
// en vez de inventar 4 colores nuevos sin pasar el validador de contraste.
const SURVIVAL_TYPE_META: Record<DefensiveSurvivalType, { label: string; short: string; color: string; hint: string }> = {
  mitigation: { label: 'Mitigación', short: 'MITIG', color: CATEGORY_PALETTE[0], hint: 'Reduce el daño antes de que llegue a tu vida — DR%, armadura, reducción física/mágica, avoidance, stagger.' },
  absorption: { label: 'Absorción', short: 'ABSORB', color: CATEGORY_PALETTE[7], hint: 'Añade un pool de vida aparte que el daño consume antes de tocar tu HP — escudos, barriers, Ignore Pain.' },
  sustain: { label: 'Sustain', short: 'SUSTAIN', color: CATEGORY_PALETTE[2], hint: 'Repara vida ya perdida o la mantiene estable con el tiempo — self-heals, HoTs, regen, leech.' },
  emergency: { label: 'Emergencia', short: 'EMERG', color: CATEGORY_PALETTE[1], hint: 'Herramienta para sobrevivir a daño potencialmente letal — inmunidades, cheat death, curación instantánea enorme.' },
};

export function survivalTypeMeta(type: DefensiveSurvivalType | null | undefined) {
  return type ? SURVIVAL_TYPE_META[type] : null;
}

export const SURVIVAL_TYPE_KEYS = Object.keys(SURVIVAL_TYPE_META) as DefensiveSurvivalType[];

/** §"la I de información... y las categorías/causas que aparezcan en el análisis de la IA deben leerse bien, no como código" (feedback real): las 10 claves de categoría, para que app-brief-text pueda reconocer un token como "avoidable-ground" dentro de la prosa que devuelve el LLM (el propio contexto que se le manda SÍ lleva estos códigos literales — es razonable que a veces los cite tal cual). */
export const CATEGORY_KEYS = Object.keys(MECHANIC_CATEGORY_META) as MechanicCategory[];

/** Mismo dato que ya vivía duplicado en night-player-dossier.component.ts y player-detail.component.ts (ROOT_CAUSE_LABEL) — centralizado aquí porque app-brief-text también lo necesita para reconocer estos códigos dentro de la prosa del LLM. */
export const ROOT_CAUSE_META: Record<string, { label: string }> = {
  self_positioning: { label: 'Posicionamiento propio' },
  unsoaked_mechanic: { label: 'Mecánica sin resolver' },
  no_healing_received: { label: 'Sin sanación suficiente' },
  // §"Dispels — sin ingestión de eventos de dispel" (feedback real): solo se
  // asigna con un evento Dispels real ausente para esa habilidad sobre ese
  // jugador (ver computeRootCause en analyze-report) — antes de tener esa
  // ingesta, este caso quedaba en 'unclassified'.
  undispelled_debuff: { label: 'Debuff sin dispel' },
  unclassified: { label: 'Sin clasificar' },
};

export function rootCauseMeta(code: string) {
  return ROOT_CAUSE_META[code] ?? null;
}

// §"aprovechar para pintar cada jugador de su clase (ya sabemos que colores
// usan las clases)" (feedback real): colores oficiales de Blizzard
// (los mismos que WCL/wowaudit/el propio juego), no inventados.
export const CLASS_COLORS: Record<string, string> = {
  DeathKnight: '#C41E3A',
  DemonHunter: '#A330C9',
  Druid: '#FF7C0A',
  Evoker: '#33937F',
  Hunter: '#AAD372',
  Mage: '#3FC7EB',
  Monk: '#00FF98',
  Paladin: '#F48CBA',
  Priest: '#FFFFFF',
  Rogue: '#FFF468',
  Shaman: '#0070DD',
  Warlock: '#8788EE',
  Warrior: '#C69B6D',
};

export function classColor(wclClass: string | null | undefined): string | null {
  return wclClass ? (CLASS_COLORS[wclClass] ?? null) : null;
}

// §"pantalla nueva para clasificar defensivos... se clasifican por clase"
// (feedback real): nombre legible para el selector — el WCL crudo
// ("DeathKnight") vale para cruzar datos, no para un título de pantalla.
export const CLASS_DISPLAY_NAME: Record<string, string> = {
  DeathKnight: 'Death Knight',
  DemonHunter: 'Demon Hunter',
  Druid: 'Druid',
  Evoker: 'Evoker',
  Hunter: 'Hunter',
  Mage: 'Mage',
  Monk: 'Monk',
  Paladin: 'Paladin',
  Priest: 'Priest',
  Rogue: 'Rogue',
  Shaman: 'Shaman',
  Warlock: 'Warlock',
  Warrior: 'Warrior',
};

export function classDisplayName(wclClass: string): string {
  return CLASS_DISPLAY_NAME[wclClass] ?? wclClass;
}

// §"los que sean unknown ability pon: unknown cause - WC porque quizá es un
// wipe call y es saltar al vacío o algo así" (feedback real): "Unknown
// Ability" es un literal interno (mechanicId=0, el fallback de
// analyze-report cuando WCL no da spellId en el golpe de muerte — típico de
// caídas al vacío/entorno, no de una habilidad real) — mostrarlo tal cual
// en inglés no dice nada útil ni al RL ni al LLM. Mismo criterio en
// _shared/*-brief-context.ts (Deno, duplicado ahí porque no comparte
// módulo) para que el LLM tampoco reciba el literal en crudo.
export function mechanicDisplayName(name: string | null | undefined): string {
  if (!name) return 'Sin identificar';
  if (name === 'Unknown Ability') return 'Causa desconocida (posible wipe call / entorno)';
  return name;
}

// §"WCL tiene fases de encuentro, importarlas e implementarlas en todos los
// sitios donde corresponda" (feedback real): "Fase X/N" o "Fase X/N —
// Nombre" cuando se conoce, con el sufijo de intermedio — un único sitio
// para no repetir esta lógica en cada pantalla que enseña progreso.
export function formatPhaseReached(
  phaseTransitions: { id: number; startTime: number }[] | null | undefined,
  lastPhaseIsIntermission: boolean | null | undefined,
  bossPhases: { phase_id: number; name: string }[] | null | undefined,
): string | null {
  const lastId = phaseTransitions?.at(-1)?.id;
  if (lastId == null) return null;
  const total = bossPhases?.length ?? null;
  const name = bossPhases?.find((p) => p.phase_id === lastId)?.name ?? null;
  const base = total ? `Fase ${lastId}/${total}` : `Fase ${lastId}`;
  const withName = name ? `${base} — ${name}` : base;
  return lastPhaseIsIntermission ? `${withName} (intermedio)` : withName;
}

