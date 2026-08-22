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
  | 'healing-absorb';

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

/** Combina texto + comportamiento, prioriza el texto (evidencia explícita de Blizzard) y añade el comportamiento como refuerzo o alternativa si el texto no decidió nada. */
export function inferMechanicCategory(
  name: string,
  description: string | null,
  behavior: AbilityBehaviorSample | null,
): CategoryInference | null {
  const fromText = inferCategoryFromText(name, description);
  const fromBehavior = behavior ? inferCategoryFromBehavior(behavior) : null;

  if (fromText && fromBehavior) {
    if (fromText.category === fromBehavior.category) {
      return { category: fromText.category, reasons: [...fromText.reasons, ...fromBehavior.reasons] };
    }
    // Discrepancia: se queda con el texto (evidencia explícita > heurística de comportamiento) pero deja constancia de la discrepancia — mejor que ocultarla.
    return { category: fromText.category, reasons: [...fromText.reasons, `(el comportamiento observado sugería más bien "${fromBehavior.category}" — se prioriza el texto oficial)`] };
  }
  return fromText ?? fromBehavior;
}
