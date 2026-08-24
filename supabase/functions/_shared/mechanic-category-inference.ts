// Inferencia de categoría de mecánica SIN preguntar nada a mano: combina dos
// fuentes reales, nunca una suposición mía a secas.
//   1. Texto oficial del Journal de Blizzard (título+descripción) — keywords
//      en inglés (locale fijo en blizzard-client.ts), verificados contra
//      descripciones reales de mecánicas conocidas antes de confiar en ellos.
//   2. Comportamiento observado en el kill público de referencia (mismo
//      boss+dificultad, ajeno a la guild) — a quién golpea cada cast:
//      siempre al mismo objetivo -> tankbuster; muchos objetivos a la vez
//      con daño per-cápita similar -> soak/raid-damage; pocos objetivos
//      pero recurrentes con un hueco entre el cast y el daño -> avoidable-ground.
// Las dos fuentes se guardan como "reasons" legibles — la UI puede enseñar
// exactamente por qué se sugirió cada categoría (provenance), y save-mechanic-edit
// sigue siendo la única vía para que esto se confirme, no se pisa solo.

export type MechanicCategory =
  | 'tankbuster'
  | 'raid-damage'
  | 'avoidable-ground'
  | 'debuff-stack'
  | 'interrupt'
  | 'soak'
  | 'spread'
  | 'healing-absorb'
  | 'personal-target';

export interface CategoryInference {
  category: MechanicCategory;
  reasons: string[];
}

// Verificados a mano contra descripciones reales del Journal (varios bosses
// de Liberation of Undermine / Nerub-ar Palace) antes de confiar en ellos:
// texto oficial de Blizzard SIEMPRE dice explícitamente qué hacer, porque es
// el mismo texto que lee un jugador en el juego.
const TEXT_RULES: { pattern: RegExp; category: MechanicCategory; label: string }[] = [
  { pattern: /\binterrupt(ed|s|ible)?\b/i, category: 'interrupt', label: 'el texto dice "interrupt"' },
  // §"falta la clasificación de 'mecánica de boss'... cuando eres target y te
  // toca hacer algo sí o sí, sin más": frases que marcan a UN jugador
  // concreto por selección del boss, no por posición ni por ser el tank —
  // antes de spread/soak, que también pueden mencionar "target" de pasada.
  {
    pattern: /\b(targets?|marks?|selects?|afflicts?|curses?|chooses?|singles? out)\s+(a\s+|an?\s+|one\s+)?random\b|\brandom(ly)?\s+(target|player|raid member)\b|\bchosen\s+(player|target|raid member)\b/i,
    category: 'personal-target',
    label: 'el texto describe la selección de un jugador aleatorio/concreto ("random target"/"marks a player")',
  },
  { pattern: /\bspread( out)?\b|\baway from (other|each)\b|\bdistance from\b/i, category: 'spread', label: 'el texto pide separarse ("spread"/"away from")' },
  { pattern: /\bstack(s|ing)? (up|together|with)|\bgroup(ed)? (up|together)|\bshare(s|d)? (the |this )?damage\b/i, category: 'soak', label: 'el texto pide agruparse para repartir daño ("stack"/"share damage")' },
  { pattern: /\babsorb(s|ing)? healing\b|\bhealing (absorb|reduction)\b|\breduces? healing\b/i, category: 'healing-absorb', label: 'el texto menciona absorción/reducción de curación' },
  { pattern: /\bstacking debuff\b|\bstacks? of\b.*\bdebuff\b|\bcumulative\b/i, category: 'debuff-stack', label: 'el texto describe un debuff acumulativo' },
  { pattern: /\bcurrent tank\b|\btanking\b|\bmain tank\b/i, category: 'tankbuster', label: 'el texto menciona al tank actual' },
  { pattern: /\bmove(s)? out of\b|\bavoid(s|ing)? (the|this)\b|\bline of sight\b|\bground\b.*\b(effect|zone|area)\b|\bvoid zone\b/i, category: 'avoidable-ground', label: 'el texto describe una zona a evitar en el suelo' },
];

export function inferCategoryFromText(name: string, description: string | null): CategoryInference | null {
  const text = `${name} ${description ?? ''}`;
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) {
      return { category: rule.category, reasons: [`Journal de Blizzard: ${rule.label}.`] };
    }
  }
  return null;
}

export interface AbilityBehaviorSample {
  abilityId: number;
  /** Nº de veces que se lanzó en el log de referencia. */
  occurrences: number;
  /** Objetivos distintos golpeados por CADA cast (mismo orden que occurrences), como fracción de raidSize. */
  targetRatiosPerCast: number[];
  /** true si en >=80% de los casts el objetivo golpeado fue exactamente el mismo actor (o casi: 1 objetivo). */
  sameTargetEveryTime: boolean;
  /** Causó al menos una muerte en el log de referencia (aun siendo el mejor kill del mundo, un mecánico raid-wide grande puede matar a alguien puntual sin que deje de ser raid-damage). */
  causedDeath: boolean;
}

/**
 * Segunda fuente, basada en comportamiento real del log público de referencia
 * — no reemplaza a inferCategoryFromText, la complementa: si el texto ya dio
 * una categoría con buena confianza (interrupt/spread/soak explícitos), esta
 * función solo se usa para AÑADIR una razón de refuerzo o, si el texto no dio
 * nada, para intentar decidir con evidencia de comportamiento.
 */
export function inferCategoryFromBehavior(sample: AbilityBehaviorSample): CategoryInference | null {
  if (!sample.occurrences) return null;
  const avgRatio = sample.targetRatiosPerCast.reduce((a, b) => a + b, 0) / sample.targetRatiosPerCast.length;

  if (sample.sameTargetEveryTime) {
    return {
      category: 'tankbuster',
      reasons: [`Log de referencia: golpeó siempre al mismo objetivo en ${sample.occurrences} casts (patrón de tankbuster).`],
    };
  }
  if (avgRatio >= 0.6) {
    return {
      category: 'raid-damage',
      reasons: [`Log de referencia: golpeó de media al ${Math.round(avgRatio * 100)}% de la raid por cast (daño raid-wide).`],
    };
  }
  if (avgRatio > 0 && avgRatio < 0.35) {
    return {
      category: 'avoidable-ground',
      reasons: [`Log de referencia: golpeó de media solo al ${Math.round(avgRatio * 100)}% de la raid por cast (patrón de mecánica evitable puntual).`],
    };
  }
  return null;
}

// §"sync profundo... no se ha rellenado nada de nada": inferCategoryFromBehavior
// exige un cast realmente emparejado (cruce cast-a-cast por nombre dentro de
// una ventana de reacción) — con bosses de pocos casts reales por log de
// referencia, la mayoría de candidatas del Journal se quedaban sin ninguna
// evidencia ni con 20 referencias. Esta es una SEGUNDA fuente de
// comportamiento, más débil (agregada por-fight, no por-cast: no sirve para
// demostrar sameTargetEveryTime) pero de cobertura mucho más alta —
// table(dataType:DamageTaken) da el desglose de daño entrante de TODO el
// fight en una sola llamada, sin depender de emparejar un cast concreto.
// Solo se consulta cuando inferCategoryFromBehavior no dio nada (ver
// inferMechanicCategory) — el comportamiento por-cast, cuando existe, es
// más preciso y sigue ganando.
export interface AggregateBehaviorSample {
  /** Fracción media (0-1) de la raid golpeada por esta ability en TODO el fight, agregado sobre los fights de referencia con evidencia. */
  playersHitRatio: number;
  /** De los jugadores golpeados, qué fracción media eran tanks por rol real (composition[].specs[].role) — null si nunca se pudo saber el rol en ningún fight con evidencia. */
  tankHitRatio: number | null;
  /** En cuántos fights de referencia hubo evidencia real (>=1 jugador golpeado por esta ability). */
  referenceFightCount: number;
}

/** Umbral empírico (verificado en real contra Nek'zali the Soulcoiler): con 2 tanks en ~23 jugadores, una mecánica que golpea a los dos tanks da tankHitRatio=1.0 y una que golpea a dos DPS aleatorios da 0.0 — no hubo casos intermedios ambiguos en la muestra real. */
const TANK_DOMINANCE_THRESHOLD = 0.5;

export function inferCategoryFromAggregateBehavior(sample: AggregateBehaviorSample): CategoryInference | null {
  if (!sample.referenceFightCount) return null;
  const pct = Math.round(sample.playersHitRatio * 100);
  const fightsLabel = `${sample.referenceFightCount} fight${sample.referenceFightCount === 1 ? '' : 's'} de referencia`;

  if (sample.playersHitRatio >= 0.6) {
    return {
      category: 'raid-damage',
      reasons: [`Agregado de ${fightsLabel}: golpeó de media al ${pct}% de la raid en algún momento del fight (daño raid-wide).`],
    };
  }
  if (sample.playersHitRatio > 0 && sample.playersHitRatio < 0.35) {
    if (sample.tankHitRatio != null && sample.tankHitRatio >= TANK_DOMINANCE_THRESHOLD) {
      return {
        category: 'tankbuster',
        reasons: [`Agregado de ${fightsLabel}: golpeó a poca gente (${pct}% de la raid) y el ${Math.round(sample.tankHitRatio * 100)}% de esos golpes fueron al rol tank.`],
      };
    }
    if (sample.tankHitRatio != null) {
      return {
        category: 'personal-target',
        reasons: [`Agregado de ${fightsLabel}: golpeó a poca gente (${pct}% de la raid) sin afinidad de rol tank — patrón de objetivo individual ("te toca a ti, sin más").`],
      };
    }
    // Sin dato de rol en ningún fight con evidencia: no hay forma de preferir
    // tankbuster/personal-target sobre el catch-all ya existente de "poca
    // gente, sin más pistas" — mismo fallback prudente que el camino per-cast.
    return {
      category: 'avoidable-ground',
      reasons: [`Agregado de ${fightsLabel}: golpeó a poca gente (${pct}% de la raid), sin dato de rol para distinguir tankbuster de objetivo individual.`],
    };
  }
  return null;
}

/** Combina texto + comportamiento por-cast + comportamiento agregado (en ese orden de prioridad) y añade el comportamiento como refuerzo o alternativa si el texto no decidió nada. */
export function inferMechanicCategory(
  name: string,
  description: string | null,
  behavior: AbilityBehaviorSample | null,
  aggregateBehavior: AggregateBehaviorSample | null = null,
): CategoryInference | null {
  const fromText = inferCategoryFromText(name, description);
  const fromBehavior = behavior ? inferCategoryFromBehavior(behavior) : null;
  // El agregado solo entra en juego si el cruce por-cast (más preciso) no dio nada.
  const fromAggregate = !fromBehavior && aggregateBehavior ? inferCategoryFromAggregateBehavior(aggregateBehavior) : null;
  const fromAnyBehavior = fromBehavior ?? fromAggregate;

  if (fromText && fromAnyBehavior) {
    if (fromText.category === fromAnyBehavior.category) {
      return { category: fromText.category, reasons: [...fromText.reasons, ...fromAnyBehavior.reasons] };
    }
    // Discrepancia: se queda con el texto (evidencia explícita > heurística de comportamiento) pero deja constancia de la discrepancia — mejor que ocultarla.
    return { category: fromText.category, reasons: [...fromText.reasons, `(el comportamiento observado sugería más bien "${fromAnyBehavior.category}" — se prioriza el texto oficial)`] };
  }
  return fromText ?? fromAnyBehavior;
}
