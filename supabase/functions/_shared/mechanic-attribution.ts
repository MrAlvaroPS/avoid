export type MechanicResponsibility = 'tank' | 'dps' | 'healer' | 'raid' | 'personal';

/**
 * Compatibilidad histórica únicamente. Antes de que `responsibility` se
 * materializase de forma fiable, estas categorías eran el proxy usado por
 * IRIS para decidir si un impacto podía ser responsabilidad individual.
 *
 * No añadir categorías nuevas aquí para ampliar scoring: en datos actuales
 * `responsibility` es la autoridad. Este fallback existe sólo para no vaciar
 * noches antiguas que todavía no tengan ese campo persistido.
 */
export const LEGACY_PERSONAL_MECHANIC_CATEGORIES = new Set([
  'avoidable-ground',
  'spread',
  'soak',
  'personal-target',
]);

export type MechanicAttributionKind = 'personal' | 'role_or_raid' | 'unclassified';
export type MechanicAttributionSource = 'responsibility' | 'legacy_category' | 'missing';

export interface MechanicAttributionInput {
  category: string | null | undefined;
  responsibility: string | null | undefined;
}

export interface MechanicAttributionDecision {
  kind: MechanicAttributionKind;
  source: MechanicAttributionSource;
}

/**
 * Attribution Safety v1.
 *
 * Regla deliberadamente conservadora:
 * - si el catálogo/evento conoce `responsibility`, esa semántica gana;
 * - sólo `responsibility='personal'` permite atribución individual genérica;
 * - tank/healer/dps/raid nunca se convierten en culpa del receptor del daño;
 * - si el histórico carece de responsibility, se conserva temporalmente el
 *   criterio antiguo por categoría;
 * - category=null + responsibility=null es contexto no clasificable, nunca
 *   una acusación individual.
 *
 * Esta función NO intenta descubrir al tank que falló un swap, quién faltó a
 * un soak ni el carrier de un spread. Esos casos requieren evidence/ownership
 * explícitos y pertenecen al attribution engine causal posterior.
 */
export function classifyMechanicAttribution(
  input: MechanicAttributionInput,
): MechanicAttributionDecision {
  if (input.responsibility != null) {
    return {
      kind: input.responsibility === 'personal' ? 'personal' : 'role_or_raid',
      source: 'responsibility',
    };
  }

  if (input.category == null) {
    return { kind: 'unclassified', source: 'missing' };
  }

  return {
    kind: LEGACY_PERSONAL_MECHANIC_CATEGORIES.has(input.category)
      ? 'personal'
      : 'role_or_raid',
    source: 'legacy_category',
  };
}

/**
 * Única puerta genérica v1 para convertir un mechanic event recibido por un
 * jugador en candidato a fallo personal punitivo.
 */
export function isPunitivePersonalMechanicEvent(
  input: MechanicAttributionInput,
): boolean {
  return classifyMechanicAttribution(input).kind === 'personal';
}
