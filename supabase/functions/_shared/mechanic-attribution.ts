export type MechanicResponsibility = 'tank' | 'dps' | 'healer' | 'raid' | 'personal';

/**
 * Compatibilidad histórica únicamente. Antes de que `responsibility` se
 * materializase de forma fiable, estas categorías eran el proxy usado por
 * IRIS para decidir si un impacto podía ser responsabilidad individual.
 *
 * No añadir categorías nuevas aquí para ampliar scoring: Attribution Safety
 * v1 es MONOTÓNICA respecto al sistema anterior. Puede retirar una acusación
 * contradicha por responsibility, pero nunca crear una clase nueva de culpa.
 */
export const LEGACY_PERSONAL_MECHANIC_CATEGORIES = new Set([
  'avoidable-ground',
  'spread',
  'soak',
  'personal-target',
]);

export const MECHANIC_ATTRIBUTION_SAFETY_VERSION =
  'mechanic-attribution-safety@1.0.0' as const;

export type MechanicAttributionKind = 'personal' | 'role_or_raid' | 'unclassified';
export type MechanicAttributionSource =
  | 'responsibility'
  | 'legacy_category'
  | 'missing'
  | 'unsupported_personal_category';

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
 * - tank/healer/dps/raid nunca se convierten en culpa del receptor del daño;
 * - responsibility='personal' NO amplía por sí sola la superficie punitiva:
 *   v1 exige además una categoría que el sistema anterior ya trataba como
 *   personal. Otras familias quedan sin acusación hasta tener ownership
 *   causal específico;
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
  const category = input.category ?? null;
  const responsibility = input.responsibility ?? null;

  if (responsibility != null) {
    if (responsibility !== 'personal') {
      return { kind: 'role_or_raid', source: 'responsibility' };
    }

    if (category != null && LEGACY_PERSONAL_MECHANIC_CATEGORIES.has(category)) {
      return { kind: 'personal', source: 'responsibility' };
    }

    // Fail closed rather than broadening scoring. The event may genuinely be
    // personal, but v1 does not have a generic proof model for this category.
    return { kind: 'unclassified', source: 'unsupported_personal_category' };
  }

  if (category == null) {
    return { kind: 'unclassified', source: 'missing' };
  }

  return {
    kind: LEGACY_PERSONAL_MECHANIC_CATEGORIES.has(category)
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
