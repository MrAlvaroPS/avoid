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

// Paleta categórica de 8 huecos — validada de verdad, no a ojo, contra la
// superficie oscura real de la app:
//   node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" --mode dark --surface "#080810"
//   -> ALL CHECKS PASS (lightness band, chroma floor, CVD ΔE 8.4, normal-vision ΔE 19.3, contraste 3:1).
// Orden FIJO — la misma categoría siempre pinta el mismo color en toda la
// app (dataviz: "color follows the entity, never its rank"), nunca se
// reasigna según qué categorías estén presentes en un pull concreto.
export const CATEGORY_PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const MECHANIC_CATEGORY_META: Record<MechanicCategory, { short: string; label: string; cls: string; color: string }> = {
  'raid-damage': { short: 'RAID', label: 'Daño de raid', cls: 'cat-raid-damage', color: CATEGORY_PALETTE[0] },
  'avoidable-ground': { short: 'SUELO', label: 'Zona evitable', cls: 'cat-avoidable-ground', color: CATEGORY_PALETTE[1] },
  soak: { short: 'SOAK', label: 'Soak (agruparse)', cls: 'cat-soak', color: CATEGORY_PALETTE[2] },
  spread: { short: 'SPREAD', label: 'Separarse', cls: 'cat-spread', color: CATEGORY_PALETTE[3] },
  tankbuster: { short: 'TB', label: 'Tankbuster', cls: 'cat-tankbuster', color: CATEGORY_PALETTE[4] },
  'debuff-stack': { short: 'STACK', label: 'Debuff acumulativo', cls: 'cat-debuff-stack', color: CATEGORY_PALETTE[5] },
  interrupt: { short: 'INT', label: 'Interrupción', cls: 'cat-interrupt', color: CATEGORY_PALETTE[6] },
  'healing-absorb': { short: 'ABSORB', label: 'Absorción de curación', cls: 'cat-healing-absorb', color: CATEGORY_PALETTE[7] },
};

export function mechanicCategoryMeta(category: MechanicCategory | null | undefined) {
  return category ? MECHANIC_CATEGORY_META[category] : null;
}

