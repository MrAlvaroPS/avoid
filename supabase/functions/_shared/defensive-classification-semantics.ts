export const DEFENSIVE_CATEGORIES = [
  'personal_defensive',
  'semi_defensive',
  'external_defensive',
  'utility',
] as const;

export const DEFENSIVE_TARGETING_MODES = ['self', 'ally', 'both', 'raid', 'unknown'] as const;

export type DefensiveCategory = (typeof DEFENSIVE_CATEGORIES)[number];
export type DefensiveTargetingMode = (typeof DEFENSIVE_TARGETING_MODES)[number];

const CATEGORY_SET = new Set<string>(DEFENSIVE_CATEGORIES);
const TARGETING_MODE_SET = new Set<string>(DEFENSIVE_TARGETING_MODES);

/**
 * Contrato compartido por clasificación IA y edición humana.
 *
 * `unknown` es deliberadamente válido para un external: significa que la IA
 * confirmó la categoría pero no pudo demostrar todavía si el objetivo real es
 * ally o raid. Se conserva como dato incierto y el solver no lo asigna.
 */
export function defensiveTargetingError(category: string, targetingMode: string): string | null {
  if (!CATEGORY_SET.has(category)) return `category inválida: ${category}`;
  if (!TARGETING_MODE_SET.has(targetingMode)) return `targetingMode inválido: ${targetingMode}`;
  if (category === 'personal_defensive' && targetingMode !== 'self') return 'personal_defensive exige targetingMode self';
  if (category === 'semi_defensive' && targetingMode !== 'both') return 'semi_defensive exige targetingMode both';
  if (category === 'external_defensive' && !['ally', 'raid', 'unknown'].includes(targetingMode)) {
    return 'external_defensive exige targetingMode ally, raid o unknown';
  }
  return null;
}
