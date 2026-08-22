// Colocar en: supabase/functions/_shared/defensive-cooldowns.ts
// El catálogo YA NO vive aquí como array estático — vive en la tabla
// `cooldown_catalog` (§12.1), sincronizada desde el repo real de
// WoWAnalyzer (ver supabase/wowanalyzer-extractor/). Este módulo se queda
// solo con la lógica pura de cruce (parsear buffs, filtrar por clase),
// recibiendo el catálogo como parámetro — así una llamada por evento de
// daño (cientos/miles por pull) no dispara una query por llamada; quien
// invoca (analyze-report) carga la tabla UNA VEZ y la reutiliza en memoria.
//
// Import type es un noop en runtime, pero deja claro que loadCooldownCatalog
// (más abajo) es la única forma soportada de obtener un CooldownCatalog real.

export interface DefensiveCooldown {
  spellId: number;
  name: string;
  /** Debe coincidir con WclActor.subType (la clase, tal como la da WCL). */
  class: string;
  spec: string | null;
  category: 'personal_defensive' | 'semi_defensive' | 'external_defensive' | 'utility';
  /** Cooldown base en ms (talentos/haste en 0), o null si el extractor no pudo resolver un valor plano — ver supabase/wowanalyzer-extractor. */
  baseCooldownMs: number | null;
}

export type CooldownCatalog = DefensiveCooldown[];

/** Parsea el campo `buffs` que ya trae cada evento DamageTaken de WCL ("1236994.258920.1285644."). */
export function parseActiveBuffIds(buffsField: string | undefined | null): number[] {
  if (!buffsField) return [];
  return buffsField
    .split('.')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Defensivos del catálogo que estaban entre los buffs activos, para la clase dada. */
export function activeDefensives(buffsField: string | undefined | null, className: string, catalog: CooldownCatalog): DefensiveCooldown[] {
  const active = new Set(parseActiveBuffIds(buffsField));
  return catalog.filter((cd) => cd.class === className && active.has(cd.spellId));
}

/** Todo el catálogo de una clase — para calcular "cuáles NO llegó a lanzar en todo el pull". */
export function defensivesForClass(className: string, catalog: CooldownCatalog): DefensiveCooldown[] {
  return catalog.filter((cd) => cd.class === className);
}
