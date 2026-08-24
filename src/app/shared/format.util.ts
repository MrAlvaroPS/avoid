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

import type { MechanicCategory } from './models/domain';

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

/** §"la I de información... y las categorías/causas que aparezcan en el análisis de la IA deben leerse bien, no como código" (feedback real): las 10 claves de categoría, para que app-brief-text pueda reconocer un token como "avoidable-ground" dentro de la prosa que devuelve el LLM (el propio contexto que se le manda SÍ lleva estos códigos literales — es razonable que a veces los cite tal cual). */
export const CATEGORY_KEYS = Object.keys(MECHANIC_CATEGORY_META) as MechanicCategory[];

/** Mismo dato que ya vivía duplicado en night-player-dossier.component.ts y player-detail.component.ts (ROOT_CAUSE_LABEL) — centralizado aquí porque app-brief-text también lo necesita para reconocer estos códigos dentro de la prosa del LLM. */
export const ROOT_CAUSE_META: Record<string, { label: string }> = {
  self_positioning: { label: 'Posicionamiento propio' },
  unsoaked_mechanic: { label: 'Mecánica sin resolver' },
  no_healing_received: { label: 'Sin sanación suficiente' },
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

