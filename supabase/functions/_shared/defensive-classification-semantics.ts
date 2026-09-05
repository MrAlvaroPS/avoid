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

// §IRIS Defensive Canonicalization v1 (iris-defensive-canonicalization-v1-plan.md
// §1/§19/§22, alineado con el prompt v10 de classify-defensives — ver su
// registro de avance §8): contrato semántico nuevo, ORTOGONAL a
// category/targetingMode de arriba (esos siguen viviendo en cooldown_catalog
// como facts heredados de WoWAnalyzer). Este contrato responde "qué
// significa esto para los KPI de IRIS" y vive en defensive_ability_semantics.
// Un único fichero, usado por clasificación IA (classify-defensives), edición
// de officer, DB validation y (Paso C) el resolver — nadie más reimplementa
// estos enums o el predicado de membership.
export const DEFENSIVE_USAGE_ROLES = [
  'personal_survival',
  'survival_state',
  'hybrid_survival',
  'active_mitigation',
  'rotational_survival',
  'healer_throughput',
  'external',
  'raid_defensive',
  'passive_survival',
  'utility',
  'unknown',
] as const;

// activationScope = a quién se DIRIGE el cast, no a quién beneficia — ver
// primaryBeneficiary más abajo para eso. 'none' es para pasivos sin target.
export const DEFENSIVE_ACTIVATION_SCOPES = ['self', 'ally_selectable', 'enemy', 'ground', 'raid', 'none', 'unknown'] as const;

// primaryBeneficiary = quién recibe la protección PRINCIPAL. Es la condición
// real de membership al kit personal ('self'), NO activationScope: Fiery
// Brand puede tener activationScope='enemy' y primaryBeneficiary='self' y
// seguir siendo personal_survival (v9 exigía activationScope='self', lo cual
// era incorrecto en general — corregido en v10).
export const DEFENSIVE_PRIMARY_BENEFICIARIES = [
  'self',
  'self_or_ally_selectable',
  'ally_selectable',
  'party',
  'raid',
  'none',
  'unknown',
] as const;

export const DEFENSIVE_SECONDARY_PROPAGATIONS = ['none', 'automatic_ally', 'automatic_party', 'automatic_raid'] as const;

export const DEFENSIVE_MECHANISMS = [
  'mitigation',
  'absorption',
  'sustain',
  'immunity',
  'avoidance',
  'effective_health',
  'lethal_prevention',
] as const;

export const DEFENSIVE_OPPORTUNITY_MODES = ['normal', 'credit_only', 'none'] as const;

export const DEFENSIVE_INTENTS = ['primary', 'hybrid', 'incidental', 'none', 'unknown'] as const;

export const DEFENSIVE_SEMANTIC_STATUSES = ['verified', 'pending', 'rejected'] as const;

export type DefensiveUsageRole = (typeof DEFENSIVE_USAGE_ROLES)[number];
export type DefensiveActivationScope = (typeof DEFENSIVE_ACTIVATION_SCOPES)[number];
export type DefensivePrimaryBeneficiary = (typeof DEFENSIVE_PRIMARY_BENEFICIARIES)[number];
export type DefensiveSecondaryPropagation = (typeof DEFENSIVE_SECONDARY_PROPAGATIONS)[number];
export type DefensiveMechanism = (typeof DEFENSIVE_MECHANISMS)[number];
export type DefensiveOpportunityMode = (typeof DEFENSIVE_OPPORTUNITY_MODES)[number];
export type DefensiveIntent = (typeof DEFENSIVE_INTENTS)[number];
export type DefensiveSemanticStatus = (typeof DEFENSIVE_SEMANTIC_STATUSES)[number];

const USAGE_ROLE_SET = new Set<string>(DEFENSIVE_USAGE_ROLES);
const ACTIVATION_SCOPE_SET = new Set<string>(DEFENSIVE_ACTIVATION_SCOPES);
const PRIMARY_BENEFICIARY_SET = new Set<string>(DEFENSIVE_PRIMARY_BENEFICIARIES);
const SECONDARY_PROPAGATION_SET = new Set<string>(DEFENSIVE_SECONDARY_PROPAGATIONS);
const MECHANISM_SET = new Set<string>(DEFENSIVE_MECHANISMS);
const OPPORTUNITY_MODE_SET = new Set<string>(DEFENSIVE_OPPORTUNITY_MODES);

// usageRole que el contrato exige opportunityMode:"none" (nunca participan en
// la generación de oportunidades del KPI personal).
const NONE_OPPORTUNITY_ROLES = new Set<string>([
  'active_mitigation',
  'rotational_survival',
  'healer_throughput',
  'external',
  'raid_defensive',
  'passive_survival',
  'utility',
]);
// usageRole que exigen opportunityMode:"credit_only" — su disponibilidad
// nunca fabrica una oportunidad, pero un uso correcto sí puede resolver un
// episodio ya evaluable (Bear Form es el ejemplo canónico).
const CREDIT_ONLY_ROLES = new Set<string>(['survival_state', 'hybrid_survival']);
// usageRole cuya condición de pertenencia es primaryBeneficiary='self'.
const SELF_BENEFICIARY_ROLES = new Set<string>(['personal_survival', 'survival_state', 'hybrid_survival']);

export interface DefensiveSemanticInput {
  usageRole: string;
  activationScope: string;
  primaryBeneficiary: string;
  secondaryPropagation: string;
  mechanisms: string[];
  opportunityMode: string;
}

/**
 * Valida el contrato semántico nuevo. NO decide membership (eso lo deriva
 * SQL/el resolver a partir de estos mismos campos, ver
 * defensive_ability_semantic_catalog) — solo rechaza combinaciones
 * incoherentes por construcción, igual que defensiveTargetingError hace con
 * category/targetingMode.
 */
export function defensiveSemanticError(input: DefensiveSemanticInput): string | null {
  if (!USAGE_ROLE_SET.has(input.usageRole)) return `usageRole inválido: ${input.usageRole}`;
  if (!ACTIVATION_SCOPE_SET.has(input.activationScope)) return `activationScope inválido: ${input.activationScope}`;
  if (!PRIMARY_BENEFICIARY_SET.has(input.primaryBeneficiary)) {
    return `primaryBeneficiary inválido: ${input.primaryBeneficiary}`;
  }
  if (!SECONDARY_PROPAGATION_SET.has(input.secondaryPropagation)) {
    return `secondaryPropagation inválido: ${input.secondaryPropagation}`;
  }
  if (!OPPORTUNITY_MODE_SET.has(input.opportunityMode)) return `opportunityMode inválido: ${input.opportunityMode}`;
  if (!Array.isArray(input.mechanisms) || input.mechanisms.some((mechanism) => !MECHANISM_SET.has(mechanism))) {
    return `mechanisms contiene un valor inválido: ${JSON.stringify(input.mechanisms)}`;
  }
  // survival_state/hybrid_survival (Bear Form / un híbrido con beneficio
  // defensivo sustancial): la mera disponibilidad nunca puede fabricar una
  // oportunidad perdida — exigen EXACTAMENTE credit_only, ni normal ni none.
  if (CREDIT_ONLY_ROLES.has(input.usageRole) && input.opportunityMode !== 'credit_only') {
    return `${input.usageRole} exige opportunityMode credit_only`;
  }
  // active_mitigation/rotational_survival/healer_throughput/external/
  // raid_defensive/passive_survival/utility: nunca participan en el KPI
  // personal, exigen EXACTAMENTE none.
  if (NONE_OPPORTUNITY_ROLES.has(input.usageRole) && input.opportunityMode !== 'none') {
    return `${input.usageRole} exige opportunityMode none`;
  }
  // opportunityMode:"normal" reservado en exclusiva para personal_survival —
  // es la inversa de la regla anterior, cierra el resto de combinaciones.
  if (input.opportunityMode === 'normal' && input.usageRole !== 'personal_survival') {
    return 'opportunityMode normal exige usageRole personal_survival';
  }
  // primaryBeneficiary decide "self", NO activationScope (v10: Fiery Brand
  // puede tener activationScope enemy y seguir siendo personal_survival).
  if (SELF_BENEFICIARY_ROLES.has(input.usageRole) && input.primaryBeneficiary !== 'self') {
    return `${input.usageRole} exige primaryBeneficiary self`;
  }
  if (SELF_BENEFICIARY_ROLES.has(input.usageRole) && input.mechanisms.length === 0) {
    return `${input.usageRole} exige al menos un mechanism`;
  }
  return null;
}

/**
 * Predicado de membership derivado — MISMA fórmula que la vista SQL
 * defensive_ability_semantic_catalog (is_defensive_kit_member /
 * creates_missable_opportunity). Se expone en TypeScript para que el
 * resolver (Paso C) y los tests no tengan que reimplementarlo ni
 * confundirse con una copia en SQL que se desincronice.
 */
export function isDefensiveKitMember(
  semanticStatus: string,
  activationMode: string,
  input: DefensiveSemanticInput,
): boolean {
  return (
    semanticStatus === 'verified' &&
    activationMode === 'active' &&
    input.primaryBeneficiary === 'self' &&
    (input.usageRole === 'personal_survival' || input.usageRole === 'survival_state' || input.usageRole === 'hybrid_survival') &&
    input.mechanisms.length > 0
  );
}

/**
 * §Hallazgo real de uso (2026-09-03, prompt v10 en producción): la IA
 * confunde con frecuencia el vocabulario legacy targetingMode
 * (self/ally/both/raid/unknown, "a quién BENEFICIA") con el nuevo
 * activationScope (self/ally_selectable/enemy/ground/raid/none/unknown, "a
 * quién se DIRIGE el cast") o con primaryBeneficiary
 * (self/self_or_ally_selectable/ally_selectable/party/raid/none/unknown) —
 * ambos con valores parecidos pero de otro enum. Resultado real observado:
 * decenas de filas semi_defensive/external_defensive rechazadas por
 * `defensiveTargetingError` porque targetingMode traía un valor como
 * "ally_selectable" o "self_or_ally_selectable", que no existen en el enum
 * legacy.
 *
 * category/targetingMode ya no son la fuente de verdad (ver §19-20 del plan)
 * — así que en vez de seguir exigiéndole a la IA que rellene bien DOS
 * vocabularios redundantes para el mismo hecho, derivamos category/
 * targetingMode DETERMINÍSTICAMENTE a partir del contrato nuevo cuando este
 * está presente y es válido. Siempre produce un par que
 * defensiveTargetingError acepta (cubierto por tests) — elimina esta clase
 * de error de raíz en vez de parchearla caso a caso.
 */
export function deriveLegacyClassification(
  input: DefensiveSemanticInput,
): { category: DefensiveCategory; targetingMode: DefensiveTargetingMode } {
  switch (input.usageRole) {
    case 'personal_survival':
    case 'survival_state':
    case 'hybrid_survival':
      return { category: 'personal_defensive', targetingMode: 'self' };
    case 'healer_throughput':
      return { category: 'semi_defensive', targetingMode: 'both' };
    case 'external':
      return { category: 'external_defensive', targetingMode: 'ally' };
    case 'raid_defensive':
      return { category: 'external_defensive', targetingMode: 'raid' };
    default:
      // active_mitigation, rotational_survival, passive_survival, utility,
      // unknown: ninguno de los tres cubos legacy los describe bien, y
      // forzarlos a personal_defensive resucitaría exactamente la
      // contaminación (SotR/Death Strike contando como "defensivo personal")
      // que esta migración existe para eliminar. utility es el cubo seguro:
      // ningún lector legacy lo cuenta como cobertura personal.
      return { category: 'utility', targetingMode: 'unknown' };
  }
}

/**
 * Igual que deriveLegacyClassification pero para survivalType (legacy,
 * single-select: mitigation/absorption/sustain/emergency/null) a partir de
 * mechanisms[] (nuevo, puede tener varios). Prioridad: un mecanismo que
 * evita el daño antes de que llegue (mitigation/avoidance) pesa más que uno
 * que lo repara después (sustain); immunity/lethal_prevention/
 * effective_health caen en el cajón histórico "emergency" (§18 del prompt
 * v10 ya documenta esa correspondencia). Vacío/sin match → null, nunca se
 * inventa un valor.
 */
export function deriveLegacySurvivalType(mechanisms: string[]): 'mitigation' | 'absorption' | 'sustain' | 'emergency' | null {
  if (mechanisms.includes('mitigation') || mechanisms.includes('avoidance')) return 'mitigation';
  if (mechanisms.includes('absorption')) return 'absorption';
  if (mechanisms.includes('sustain')) return 'sustain';
  if (mechanisms.includes('immunity') || mechanisms.includes('lethal_prevention') || mechanisms.includes('effective_health')) return 'emergency';
  return null;
}

export function createsMissableOpportunity(
  semanticStatus: string,
  activationMode: string,
  input: DefensiveSemanticInput,
): boolean {
  return (
    semanticStatus === 'verified' &&
    activationMode === 'active' &&
    input.primaryBeneficiary === 'self' &&
    input.usageRole === 'personal_survival' &&
    input.mechanisms.length > 0 &&
    input.opportunityMode === 'normal'
  );
}
