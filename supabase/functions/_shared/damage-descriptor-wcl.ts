// §Paso C-1 (iris-defensive-canonicalization-v1-plan.md §2.4.1) —
// extracción REAL de DamageDescriptor desde hechos de WCL. Cada decode de
// este fichero está verificado empíricamente contra reports reales de la
// guild (2026-09-04, ver registro de avance del plan) — no se asume ningún
// campo sin haberlo visto en un payload real:
//
// - school: `masterData.abilities[].type` es un bitmask de 7 bits, ya
//   pedido hoy por analyze-report/reanalyze-defensive-pressure (campo
//   `type`, sin interpretar) — verificado contra 2220 abilities reales de
//   un report ("Frost Shield"/"Breath of Sindragosa"→16=Frost,
//   "Arcane Intellect"→64=Arcane, "Wake of Ashes"→6=Holy+Fire,
//   "Eye Beam"/"Metamorphosis"→124=Fire+Nature+Frost+Shadow+Arcane). Bits:
//   1=Physical 2=Holy 4=Fire 8=Nature 16=Frost 32=Shadow 64=Arcane.
// - isAoE/tick/blocked: campos crudos ya presentes en cada evento
//   DamageTaken/DamageDone de WCL (`includeResources` no hace falta para
//   estos).
// - hitType: decodificado cruzando el `filterExpression` real de WCL
//   (`missType = "dodge"/"parry"/"miss"/"immune"`, vocabulario documentado
//   por el propio motor de queries de WCL) contra el `hitType` numérico de
//   eventos reales en 5 fights distintos — 0=Miss 1=Hit 2=Crit 4=Block
//   7=Dodge 8=Parry 10=Immune. Cualquier otro valor numérico no visto se
//   deja sin interpretar (null), nunca se adivina.
// - abilityGameID===1: sentinel reservado de WCL para "Melee" (autoataque
//   básico) — verificado (`masterData.abilities` siempre lo nombra
//   "Melee", type=1=Physical). Único hecho demostrable hoy para la
//   dimensión "método de entrega" (melee/ranged/spell/environmental) —
//   WCL no expone ningún otro campo (ni en events ni en Casts) que separe
//   ranged/spell/environmental; esa parte del contrato queda
//   estructuralmente null salvo abilityGameID===1, documentado como
//   carencia real en el registro de avance, no oculto.
// - sourceAffectedBySpell (Fiery Brand-style): reconstruido desde
//   `Debuffs(hostilityType: Enemies)` — eventos reales `applydebuff`/
//   `removedebuff`/`refreshdebuff` sobre el actor boss, mismo patrón de
//   intervalos que `defensiveStatusAt`. El caller decide si pedir esos
//   eventos (volumen real ~15000/6min, comparable a DamageTaken — no se
//   pide gratis para pulls/specs que no lo necesitan).

import type { WowSchool } from './defensive-applicability.ts';

// ============================================================================
// School — bitmask verificado
// ============================================================================

const SCHOOL_BITS: ReadonlyArray<readonly [number, WowSchool]> = [
  [1, 'Physical'],
  [2, 'Holy'],
  [4, 'Fire'],
  [8, 'Nature'],
  [16, 'Frost'],
  [32, 'Shadow'],
  [64, 'Arcane'],
];

export interface DecodedSchoolMask {
  schoolMask: number | null;
  schools: WowSchool[] | null;
}

/**
 * Decodifica `masterData.abilities[].type` (string numérico crudo de WCL,
 * ej. "16", "6", "124"). mask=0/no numérico/ausente → null en ambos campos
 * (no determinado) — WCL usa type="0" para abilities sin school real
 * (consumibles, "Unknown Ability"), no para daño real sin school.
 */
export function decodeSchoolMask(rawType: string | number | null | undefined): DecodedSchoolMask {
  if (rawType == null) return { schoolMask: null, schools: null };
  const mask = typeof rawType === 'number' ? rawType : Number(rawType);
  if (!Number.isFinite(mask) || mask <= 0) return { schoolMask: null, schools: null };
  const schools = SCHOOL_BITS.filter(([bit]) => (mask & bit) === bit).map(([, school]) => school);
  return { schoolMask: mask, schools: schools.length ? schools : null };
}

// ============================================================================
// hitType — verificado empíricamente vía missType (ver cabecera)
// ============================================================================

export type WclHitTypeMeaning = 'hit' | 'crit' | 'miss' | 'block' | 'dodge' | 'parry' | 'immune';

/** SOLO estos 7 valores están verificados contra WCL real — cualquier otro numeral se deja sin interpretar. */
export const WCL_HIT_TYPE_MEANING: Readonly<Record<number, WclHitTypeMeaning>> = {
  0: 'miss',
  1: 'hit',
  2: 'crit',
  4: 'block',
  7: 'dodge',
  8: 'parry',
  10: 'immune',
};

export function describeHitType(hitType: number | null | undefined): WclHitTypeMeaning | null {
  if (hitType == null) return null;
  return WCL_HIT_TYPE_MEANING[hitType] ?? null;
}

// ============================================================================
// Combat table — cross-pull, cache-friendly (ver migración
// ability_combat_table_facts). Puramente aditivo: cuenta observaciones,
// nunca infiere false por ausencia.
// ============================================================================

export interface AbilityCombatTableCounts {
  dodgeCount: number;
  parryCount: number;
  blockCount: number;
}

function emptyCounts(): AbilityCombatTableCounts {
  return { dodgeCount: 0, parryCount: 0, blockCount: 0 };
}

export interface RawCombatHit {
  abilityGameID?: number;
  hitType?: number;
  /** WCL: presente (numérico) solo en hits realmente bloqueados — más directo que decodificar hitType para block. */
  blocked?: number;
}

/**
 * Recorre eventos crudos DamageTaken/DamageDone de UN pull y tally por
 * abilityGameID cuántas veces se observó cada resultado del combat table.
 * Evidencia POSITIVA únicamente — nunca resta ni concluye "no observado
 * = no ocurre".
 */
export function tallyAbilityCombatTableObservations(
  hits: readonly RawCombatHit[],
): Map<number, AbilityCombatTableCounts> {
  const out = new Map<number, AbilityCombatTableCounts>();
  for (const hit of hits) {
    if (typeof hit.abilityGameID !== 'number') continue;
    const meaning = describeHitType(hit.hitType);
    const isBlocked = typeof hit.blocked === 'number' && hit.blocked > 0;
    if (meaning !== 'dodge' && meaning !== 'parry' && !isBlocked) continue;
    const entry = out.get(hit.abilityGameID) ?? emptyCounts();
    if (meaning === 'dodge') entry.dodgeCount += 1;
    if (meaning === 'parry') entry.parryCount += 1;
    if (isBlocked) entry.blockCount += 1;
    out.set(hit.abilityGameID, entry);
  }
  return out;
}

/** Unión aditiva de dos mapas de observaciones (pull local ∪ cache cross-pull) — nunca resta. */
export function mergeAbilityCombatTableObservations(
  ...maps: ReadonlyArray<ReadonlyMap<number, AbilityCombatTableCounts>>
): Map<number, AbilityCombatTableCounts> {
  const out = new Map<number, AbilityCombatTableCounts>();
  for (const map of maps) {
    for (const [abilityId, counts] of map) {
      const entry = out.get(abilityId) ?? emptyCounts();
      entry.dodgeCount += counts.dodgeCount;
      entry.parryCount += counts.parryCount;
      entry.blockCount += counts.blockCount;
      out.set(abilityId, entry);
    }
  }
  return out;
}

/** dodgeable/parryable/blockable derivados de las observaciones acumuladas — yes con evidencia, unknown si no hay ninguna (NUNCA false). */
export function combatTableVerdictFor(
  abilityGameID: number | undefined,
  observations: ReadonlyMap<number, AbilityCombatTableCounts>,
): { dodgeable: boolean | null; parryable: boolean | null; blockable: boolean | null } {
  const counts = abilityGameID != null ? observations.get(abilityGameID) : undefined;
  return {
    dodgeable: counts && counts.dodgeCount > 0 ? true : null,
    parryable: counts && counts.parryCount > 0 ? true : null,
    blockable: counts && counts.blockCount > 0 ? true : null,
  };
}

// ============================================================================
// deliveryScopes por hit — solo lo demostrable (ver cabecera: método de
// entrega estructuralmente limitado al sentinel Melee).
// ============================================================================

export interface RawDeliveryHit {
  abilityGameID?: number;
  isAoE?: boolean;
  tick?: boolean;
}

const WCL_MELEE_SENTINEL_ABILITY_ID = 1;

/**
 * Tags demostrados para ESTE hit — nunca inventa un tag sin evidencia
 * directa del propio evento:
 * - target scope (aoe/single_target): directo de `isAoE`.
 * - timing (direct/periodic): directo de `tick` (ausente/false = direct).
 * - delivery method (melee/ranged/spell/environmental): SOLO 'melee'
 *   cuando abilityGameID es el sentinel de WCL — para cualquier otra
 *   ability, esta dimensión no aporta ningún tag (no se demuestra
 *   ranged/spell/environmental con los datos disponibles hoy).
 */
export function deliveryTagsForHit(hit: RawDeliveryHit): string[] {
  const tags: string[] = [];
  if (typeof hit.isAoE === 'boolean') tags.push(hit.isAoE ? 'aoe' : 'single_target');
  tags.push(hit.tick === true ? 'periodic' : 'direct');
  if (hit.abilityGameID === WCL_MELEE_SENTINEL_ABILITY_ID) tags.push('melee');
  return tags;
}

// ============================================================================
// sourceAffectedBySpell (Fiery Brand-style) — intervalos reales desde
// Debuffs(Enemies), fetch condicional decidido por el caller.
// ============================================================================

export interface RawDebuffEvent {
  type?: string; // 'applydebuff' | 'removedebuff' | 'refreshdebuff' | ...
  timestamp?: number;
  targetID?: number;
  abilityGameID?: number;
}

export interface DebuffInterval {
  targetID: number;
  spellId: number;
  startMs: number;
  /** null = seguía activo al final de la ventana de eventos pedida (no se cerró con un removedebuff observado). */
  endMs: number | null;
}

/**
 * Reconstruye intervalos apply→remove reales desde eventos Debuffs crudos
 * — mismo patrón (apply/remove → intervalo) que defensiveStatusAt ya usa
 * para cooldowns, aplicado aquí a debuffs de un actor (normalmente el
 * boss). `refreshdebuff` extiende el intervalo abierto, no lo cierra.
 */
export function buildDebuffIntervals(events: readonly RawDebuffEvent[]): DebuffInterval[] {
  const open = new Map<string, DebuffInterval>();
  const closed: DebuffInterval[] = [];
  const sorted = [...events].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  for (const event of sorted) {
    if (typeof event.targetID !== 'number' || typeof event.abilityGameID !== 'number' || typeof event.timestamp !== 'number') continue;
    const key = `${event.targetID}:${event.abilityGameID}`;
    if (event.type === 'applydebuff') {
      if (!open.has(key)) open.set(key, { targetID: event.targetID, spellId: event.abilityGameID, startMs: event.timestamp, endMs: null });
    } else if (event.type === 'removedebuff') {
      const interval = open.get(key);
      if (interval) {
        interval.endMs = event.timestamp;
        closed.push(interval);
        open.delete(key);
      }
    }
    // 'refreshdebuff' no cierra ni abre — el intervalo sigue abierto tal cual.
  }
  return [...closed, ...open.values()];
}

/**
 * ¿El debuff `spellId` estaba activo en el actor `targetID` en `atMs`?
 * Solo devuelve `true` (evidencia positiva) o `null` (no demostrable) —
 * NUNCA `false`: incluso con el stream de Debuffs completo, una ausencia
 * de intervalo podría deberse a paginación/rate-limit, no a que
 * genuinamente no estuviera activo (pedido explícito 2026-09-04: no
 * convertir ausencia de observación en negativo).
 */
export function isSourceAffectedBySpellAt(
  intervals: readonly DebuffInterval[],
  targetID: number,
  spellId: number,
  atMs: number,
): boolean | null {
  const active = intervals.some(
    (interval) =>
      interval.targetID === targetID &&
      interval.spellId === spellId &&
      atMs >= interval.startMs &&
      (interval.endMs == null || atMs <= interval.endMs),
  );
  return active ? true : null;
}

// ============================================================================
// Ensamblaje: UN hit + contexto → DamageDescriptor (sin sourceAffectedBySpell,
// que es por-candidato — ver isSourceAffectedBySpellAt arriba, el caller lo
// añade con spread cuando evalúa un candidato concreto con esa exigencia).
// ============================================================================

export interface DamageDescriptorContext {
  schoolByAbilityId: ReadonlyMap<number, DecodedSchoolMask>;
  combatTableObservations: ReadonlyMap<number, AbilityCombatTableCounts>;
}

export interface DamageHitFact {
  abilityGameID?: number;
  isAoE?: boolean;
  tick?: boolean;
  hitType?: number;
  blocked?: number;
}

export function buildDamageDescriptor(
  hit: DamageHitFact,
  ctx: DamageDescriptorContext,
): {
  schools: WowSchool[] | null;
  schoolMask: number | null;
  deliveryScopes: string[] | null;
  dodgeable: boolean | null;
  parryable: boolean | null;
  blockable: boolean | null;
  sourceAffectedBySpell: null;
  rawHitType: number | null;
} {
  const decodedSchool = hit.abilityGameID != null ? ctx.schoolByAbilityId.get(hit.abilityGameID) : undefined;
  const combatVerdict = combatTableVerdictFor(hit.abilityGameID, ctx.combatTableObservations);
  const deliveryTags = deliveryTagsForHit(hit);
  return {
    schools: decodedSchool?.schools ?? null,
    schoolMask: decodedSchool?.schoolMask ?? null,
    deliveryScopes: deliveryTags.length ? deliveryTags : null,
    dodgeable: combatVerdict.dodgeable,
    parryable: combatVerdict.parryable,
    blockable: combatVerdict.blockable,
    sourceAffectedBySpell: null, // por-candidato — ver isSourceAffectedBySpellAt
    rawHitType: hit.hitType ?? null,
  };
}
