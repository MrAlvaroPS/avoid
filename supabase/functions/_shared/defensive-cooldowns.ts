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
  /** Duración real del efecto en ms (cuánto dura activo tras lanzarlo) — distinto de baseCooldownMs. Null = sin verificar todavía. */
  durationMs: number | null;
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

// Bug real reportado en real (2026-08-22): un Mistweaver enseñaba "Touch of
// Karma" (defensivo exclusivo de Windwalker) porque este módulo filtraba
// solo por CLASE — `cd.spec` existe en el tipo desde el principio pero nunca
// se comprobaba. `cd.spec` puede venir como combo "Feral/Guardian" (varias
// specs comparten la habilidad sin ser TODA la clase) — de ahí el split.
function specApplies(catalogSpec: string | null, playerSpec: string | null): boolean {
  if (catalogSpec == null) return true; // compartido entre todas las specs de la clase
  if (playerSpec == null) return true; // spec del jugador no resuelta — mejor no ocultar de más que antes de este fix, no "adivinar" que no aplica
  return catalogSpec
    .split('/')
    .map((s) => s.trim())
    .includes(playerSpec);
}

// §"es importante que los defensivos disponibles sean propios de la clase o
// de los talentos... hay cosas que no están por talentos" (feedback real,
// Pandokie): el catálogo lista TODO lo que un class+spec PUEDE llegar a
// tener, pero en el árbol de talentos moderno muchos defensivos son nodos de
// ELECCIÓN (uno de varios, no todos a la vez) — enseñar uno que el jugador
// ni siquiera talentó falsea la tabla. talentGate cruza cada entrada del
// catálogo contra el árbol de talentos REAL de esa clase (allTalentSpellIds,
// de TraitDefinition — qué spellIds son "de talento" en absoluto) y el del
// JUGADOR concreto (playerTalentSpellIds) — si el spell es un nodo de
// talento y el jugador no lo tiene, no es "disponible", es inaplicable.
// Sin talentGate (build de talentos no resuelta ese report) se mantiene el
// comportamiento anterior — mejor no ocultar de más que arriesgarse a
// esconder algo real por falta de dato.
export interface TalentGate {
  allTalentSpellIds: ReadonlySet<number>;
  playerTalentSpellIds: ReadonlySet<number>;
}

function talentAllows(spellId: number, gate: TalentGate | null): boolean {
  if (!gate) return true;
  if (!gate.allTalentSpellIds.has(spellId)) return true; // no es un nodo de talento (baseline de la clase) — siempre disponible
  return gate.playerTalentSpellIds.has(spellId); // es de talento — solo si el jugador lo tiene de verdad
}

/** Defensivos del catálogo que estaban entre los buffs activos, para la clase+spec dadas. */
export function activeDefensives(buffsField: string | undefined | null, className: string, spec: string | null, catalog: CooldownCatalog, talentGate: TalentGate | null = null): DefensiveCooldown[] {
  const active = new Set(parseActiveBuffIds(buffsField));
  return catalog.filter((cd) => cd.class === className && specApplies(cd.spec, spec) && active.has(cd.spellId) && talentAllows(cd.spellId, talentGate));
}

/** Todo el catálogo de una clase+spec — para calcular "cuáles NO llegó a lanzar en todo el pull". */
export function defensivesForClass(className: string, spec: string | null, catalog: CooldownCatalog, talentGate: TalentGate | null = null): DefensiveCooldown[] {
  return catalog.filter((cd) => cd.class === className && specApplies(cd.spec, spec) && talentAllows(cd.spellId, talentGate));
}
