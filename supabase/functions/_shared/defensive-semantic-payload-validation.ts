// §E1 — Effective Defensive Semantics Closure (iris-defensive-canonicalization-v1-plan.md
// §5 Paso C, especificación "Effective Defensive Semantics Closure"
// 2026-09-04): parsers puros y ESTRICTOS para el JSONB que classify-defensives
// (prompt v10) ya escribe en defensive_ability_semantics.applicability/
// spec_semantic_profiles y en defensive_semantic_rules.payload.
//
// Motivación real (no hipotética): una fila real de Avatar/Protection en
// Supabase tiene, dentro de specSemanticProfiles[1].applicability, una CLAVE
// corrupta — un fragmento de markdown-link truncado quedó fusionado con el
// nombre de la clave `requiresDodgeable`, así que el objeto trae una clave
// desconocida y NUNCA la clave real `requiresDodgeable`. Sigue siendo JSON
// válido (Postgres lo aceptó como jsonb), así que un cast TypeScript directo
// (`row.applicability as DamageApplicability`) lo aceptaría en silencio con
// requiresDodgeable ausente y una clave fantasma ignorada. Este módulo existe
// para que esa fila falle EXPLÍCITAMENTE (inválida, visible en provenance, sin
// penalizar) en vez de colarse como dato bueno. Ver el fixture
// "Avatar/Protection specSemanticProfile malformado" en effective-defensives.spec.ts.
//
// Regla general de todos los parsers de este fichero: cualquier clave no
// reconocida en el objeto de entrada invalida el objeto completo — nunca se
// aceptan claves desconocidas en silencio (pedido explícito del usuario).
// Un campo reconocido con el tipo equivocado también invalida. Un campo
// reconocido simplemente AUSENTE no es un error — jsonb real (specProfiles,
// payloads) legítimamente omite campos opcionales.

import {
  DEFENSIVE_USAGE_ROLES,
  DEFENSIVE_ACTIVATION_SCOPES,
  DEFENSIVE_PRIMARY_BENEFICIARIES,
  DEFENSIVE_SECONDARY_PROPAGATIONS,
  DEFENSIVE_MECHANISMS,
  DEFENSIVE_OPPORTUNITY_MODES,
  DEFENSIVE_INTENTS,
  type DefensiveUsageRole,
  type DefensiveActivationScope,
  type DefensivePrimaryBeneficiary,
  type DefensiveSecondaryPropagation,
  type DefensiveMechanism,
  type DefensiveOpportunityMode,
  type DefensiveIntent,
} from './defensive-classification-semantics.ts';
import { TIMING_RELATIONS, type DamageApplicability, type TimingRelation } from './defensive-applicability.ts';

const USAGE_ROLE_SET = new Set<string>(DEFENSIVE_USAGE_ROLES);
const ACTIVATION_SCOPE_SET = new Set<string>(DEFENSIVE_ACTIVATION_SCOPES);
const PRIMARY_BENEFICIARY_SET = new Set<string>(DEFENSIVE_PRIMARY_BENEFICIARIES);
const SECONDARY_PROPAGATION_SET = new Set<string>(DEFENSIVE_SECONDARY_PROPAGATIONS);
const MECHANISM_SET = new Set<string>(DEFENSIVE_MECHANISMS);
const OPPORTUNITY_MODE_SET = new Set<string>(DEFENSIVE_OPPORTUNITY_MODES);
const DEFENSIVE_INTENT_SET = new Set<string>(DEFENSIVE_INTENTS);
const TIMING_RELATION_SET = new Set<string>(TIMING_RELATIONS);
const SCHOOL_SCOPE_SET = new Set(['all', 'physical', 'magic', 'specific', 'none', 'unknown']);
const CONFIDENCE_SET = new Set(['high', 'medium', 'low']);

export interface ParseResult<T> {
  value: T | null;
  error: string | null;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): string | null {
  const unexpected = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unexpected.length) return `${label}: clave(s) no reconocida(s) ${unexpected.join(', ')}`;
  return null;
}

function optionalStringArray(raw: unknown, field: string): ParseResult<string[] | null> {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    return { value: null, error: `${field} debe ser un array de strings o null` };
  }
  return { value: raw as string[], error: null };
}

function optionalNullableBoolean(raw: unknown, field: string): ParseResult<boolean | null> {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (typeof raw !== 'boolean') return { value: null, error: `${field} debe ser boolean o null` };
  return { value: raw, error: null };
}

function optionalEnum<T extends string>(raw: unknown, field: string, allowed: ReadonlySet<string>): ParseResult<T | null> {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (typeof raw !== 'string' || !allowed.has(raw)) return { value: null, error: `${field} inválido: ${JSON.stringify(raw)}` };
  return { value: raw as T, error: null };
}

function requiredEnum<T extends string>(raw: unknown, field: string, allowed: ReadonlySet<string>): ParseResult<T> {
  if (typeof raw !== 'string' || !allowed.has(raw)) return { value: null, error: `${field} inválido/ausente: ${JSON.stringify(raw)}` };
  return { value: raw as T, error: null };
}

const APPLICABILITY_KEYS = new Set([
  'schoolScope',
  'schools',
  'deliveryScopes',
  'requiresDodgeable',
  'requiresParryable',
  'requiresBlockable',
  'requiresSourceAffectedBySpell',
  'timingRelation',
  'notes',
]);

/**
 * Parser estricto de UN objeto DamageApplicability (base o applicabilityPatch
 * — misma forma, ver mergeApplicability). Todo campo es opcional/nullable por
 * contrato (§10/§13/§26 del prompt v10) — lo único que invalida el objeto es
 * una clave desconocida o un campo reconocido con el tipo equivocado.
 */
export function parseDamageApplicability(raw: unknown, label = 'applicability'): ParseResult<DamageApplicability> {
  if (raw === null || raw === undefined) return { value: null, error: null };
  if (!isPlainObject(raw)) return { value: null, error: `${label}: se esperaba un objeto` };
  const keyError = rejectUnknownKeys(raw, APPLICABILITY_KEYS, label);
  if (keyError) return { value: null, error: keyError };

  const schoolScope = optionalEnum<DamageApplicability['schoolScope'] & string>(raw['schoolScope'], `${label}.schoolScope`, SCHOOL_SCOPE_SET);
  if (schoolScope.error) return { value: null, error: schoolScope.error };
  const schools = optionalStringArray(raw['schools'], `${label}.schools`);
  if (schools.error) return { value: null, error: schools.error };
  const deliveryScopes = optionalStringArray(raw['deliveryScopes'], `${label}.deliveryScopes`);
  if (deliveryScopes.error) return { value: null, error: deliveryScopes.error };
  const requiresDodgeable = optionalNullableBoolean(raw['requiresDodgeable'], `${label}.requiresDodgeable`);
  if (requiresDodgeable.error) return { value: null, error: requiresDodgeable.error };
  const requiresParryable = optionalNullableBoolean(raw['requiresParryable'], `${label}.requiresParryable`);
  if (requiresParryable.error) return { value: null, error: requiresParryable.error };
  const requiresBlockable = optionalNullableBoolean(raw['requiresBlockable'], `${label}.requiresBlockable`);
  if (requiresBlockable.error) return { value: null, error: requiresBlockable.error };
  const requiresSourceAffectedBySpell = optionalNullableBoolean(raw['requiresSourceAffectedBySpell'], `${label}.requiresSourceAffectedBySpell`);
  if (requiresSourceAffectedBySpell.error) return { value: null, error: requiresSourceAffectedBySpell.error };
  const timingRelation = optionalEnum<TimingRelation>(raw['timingRelation'], `${label}.timingRelation`, TIMING_RELATION_SET);
  if (timingRelation.error) return { value: null, error: timingRelation.error };
  if (raw['notes'] !== undefined && raw['notes'] !== null && typeof raw['notes'] !== 'string') {
    return { value: null, error: `${label}.notes debe ser string` };
  }

  return {
    error: null,
    value: {
      schoolScope: schoolScope.value,
      schools: schools.value,
      deliveryScopes: deliveryScopes.value,
      requiresDodgeable: requiresDodgeable.value,
      requiresParryable: requiresParryable.value,
      requiresBlockable: requiresBlockable.value,
      requiresSourceAffectedBySpell: requiresSourceAffectedBySpell.value,
      timingRelation: timingRelation.value,
    },
  };
}

const NULL_APPLICABILITY: DamageApplicability = {
  schoolScope: null,
  schools: null,
  deliveryScopes: null,
  requiresDodgeable: null,
  requiresParryable: null,
  requiresBlockable: null,
  requiresSourceAffectedBySpell: null,
  timingRelation: null,
};

/**
 * §10 de la especificación: fusión determinista de una applicabilityPatch
 * sobre una applicability base. Semántica EXACTA para los payloads v10
 * actuales — importante porque ya usan `[]` para decir "sin cambio", no
 * "vaciar la lista":
 *  - escalar `null`/ausente en el patch → no-op (se conserva el valor base).
 *  - escalar con valor (incluido `false`) en el patch → sustituye al base.
 *  - array `[]`/ausente en el patch → no-op.
 *  - array no vacío en el patch → sustituye esa dimensión completa.
 */
export function mergeApplicability(base: DamageApplicability | null, patch: DamageApplicability | null): DamageApplicability | null {
  if (!patch) return base;
  const effectiveBase = base ?? NULL_APPLICABILITY;
  return {
    schoolScope: patch.schoolScope ?? effectiveBase.schoolScope,
    schools: patch.schools && patch.schools.length ? patch.schools : effectiveBase.schools,
    deliveryScopes: patch.deliveryScopes && patch.deliveryScopes.length ? patch.deliveryScopes : effectiveBase.deliveryScopes,
    requiresDodgeable: patch.requiresDodgeable ?? effectiveBase.requiresDodgeable,
    requiresParryable: patch.requiresParryable ?? effectiveBase.requiresParryable,
    requiresBlockable: patch.requiresBlockable ?? effectiveBase.requiresBlockable,
    requiresSourceAffectedBySpell: patch.requiresSourceAffectedBySpell ?? effectiveBase.requiresSourceAffectedBySpell,
    timingRelation: patch.timingRelation ?? effectiveBase.timingRelation,
  };
}

// ---------------------------------------------------------------------------
// specSemanticProfiles (prompt v10 §13) — overrides semánticos reales por
// spec cuando una única fila de cooldown_catalog cubre varias specs con
// semántica distinta (Avatar Arms vs. Protection es el caso real).
// ---------------------------------------------------------------------------

export interface ValidatedSpecSemanticProfile {
  spec: string;
  usageRole: DefensiveUsageRole;
  defensiveIntent: DefensiveIntent;
  activationScope: DefensiveActivationScope;
  primaryBeneficiary: DefensivePrimaryBeneficiary;
  secondaryPropagation: DefensiveSecondaryPropagation;
  mechanisms: DefensiveMechanism[];
  opportunityMode: DefensiveOpportunityMode;
  applicability: DamageApplicability | null;
  source: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
}

const SPEC_SEMANTIC_PROFILE_KEYS = new Set([
  'spec',
  'usageRole',
  'defensiveIntent',
  'activationScope',
  'primaryBeneficiary',
  'secondaryPropagation',
  'mechanisms',
  'opportunityMode',
  'applicability',
  'source',
  'confidence',
]);

/** Un único elemento de specSemanticProfiles[] — falla completo ante cualquier clave desconocida o campo mal tipado, nunca parcialmente. */
export function parseSpecSemanticProfileEntry(raw: unknown): ParseResult<ValidatedSpecSemanticProfile> {
  if (!isPlainObject(raw)) return { value: null, error: 'specSemanticProfiles[]: se esperaba un objeto' };
  const keyError = rejectUnknownKeys(raw, SPEC_SEMANTIC_PROFILE_KEYS, 'specSemanticProfiles[]');
  if (keyError) return { value: null, error: keyError };

  if (typeof raw['spec'] !== 'string' || !raw['spec'].trim()) {
    return { value: null, error: 'specSemanticProfiles[].spec debe ser un string no vacío' };
  }
  const usageRole = requiredEnum<DefensiveUsageRole>(raw['usageRole'], 'specSemanticProfiles[].usageRole', USAGE_ROLE_SET);
  if (usageRole.error) return { value: null, error: usageRole.error };
  const defensiveIntent = requiredEnum<DefensiveIntent>(raw['defensiveIntent'], 'specSemanticProfiles[].defensiveIntent', DEFENSIVE_INTENT_SET);
  if (defensiveIntent.error) return { value: null, error: defensiveIntent.error };
  const activationScope = requiredEnum<DefensiveActivationScope>(raw['activationScope'], 'specSemanticProfiles[].activationScope', ACTIVATION_SCOPE_SET);
  if (activationScope.error) return { value: null, error: activationScope.error };
  const primaryBeneficiary = requiredEnum<DefensivePrimaryBeneficiary>(
    raw['primaryBeneficiary'],
    'specSemanticProfiles[].primaryBeneficiary',
    PRIMARY_BENEFICIARY_SET,
  );
  if (primaryBeneficiary.error) return { value: null, error: primaryBeneficiary.error };
  const secondaryPropagation = requiredEnum<DefensiveSecondaryPropagation>(
    raw['secondaryPropagation'],
    'specSemanticProfiles[].secondaryPropagation',
    SECONDARY_PROPAGATION_SET,
  );
  if (secondaryPropagation.error) return { value: null, error: secondaryPropagation.error };
  if (!Array.isArray(raw['mechanisms']) || raw['mechanisms'].some((m) => typeof m !== 'string' || !MECHANISM_SET.has(m))) {
    return { value: null, error: `specSemanticProfiles[].mechanisms inválido: ${JSON.stringify(raw['mechanisms'])}` };
  }
  const opportunityMode = requiredEnum<DefensiveOpportunityMode>(raw['opportunityMode'], 'specSemanticProfiles[].opportunityMode', OPPORTUNITY_MODE_SET);
  if (opportunityMode.error) return { value: null, error: opportunityMode.error };
  const applicability = parseDamageApplicability(raw['applicability'], 'specSemanticProfiles[].applicability');
  if (applicability.error) return { value: null, error: applicability.error };
  if (raw['source'] !== undefined && raw['source'] !== null && typeof raw['source'] !== 'string') {
    return { value: null, error: 'specSemanticProfiles[].source debe ser string o null' };
  }
  const confidence = optionalEnum<'high' | 'medium' | 'low'>(raw['confidence'], 'specSemanticProfiles[].confidence', CONFIDENCE_SET);
  if (confidence.error) return { value: null, error: confidence.error };

  return {
    error: null,
    value: {
      spec: raw['spec'],
      usageRole: usageRole.value!,
      defensiveIntent: defensiveIntent.value!,
      activationScope: activationScope.value!,
      primaryBeneficiary: primaryBeneficiary.value!,
      secondaryPropagation: secondaryPropagation.value!,
      mechanisms: [...new Set(raw['mechanisms'] as DefensiveMechanism[])],
      opportunityMode: opportunityMode.value!,
      applicability: applicability.value,
      source: (raw['source'] as string | null | undefined) ?? null,
      confidence: confidence.value,
    },
  };
}

export interface InvalidSpecSemanticProfile {
  /** Mejor esfuerzo — el `spec` reclamado por la entrada, incluso si el resto del objeto es inválido; null si ni siquiera se pudo leer. Solo para provenance/etiquetado, nunca para lógica de negocio. */
  spec: string | null;
  error: string;
}

export interface ParsedSpecSemanticProfiles {
  profiles: ValidatedSpecSemanticProfile[];
  invalid: InvalidSpecSemanticProfile[];
}

/**
 * specSemanticProfiles se valida ELEMENTO A ELEMENTO (no todo-o-nada para el
 * array completo) — un perfil corrupto de OTRA spec (caso real: Avatar
 * Protection) no debe impedir resolver la spec de un jugador cuyo perfil sí
 * es válido (caso real: Avatar Arms). El caller decide qué hacer si el perfil
 * que sí importa para este jugador cae en `invalid`.
 */
export function parseSpecSemanticProfiles(raw: unknown): ParsedSpecSemanticProfiles {
  if (raw == null) return { profiles: [], invalid: [] };
  if (!Array.isArray(raw)) return { profiles: [], invalid: [{ spec: null, error: 'specSemanticProfiles debe ser un array' }] };

  const profiles: ValidatedSpecSemanticProfile[] = [];
  const invalid: InvalidSpecSemanticProfile[] = [];
  for (const entry of raw) {
    const parsed = parseSpecSemanticProfileEntry(entry);
    if (parsed.value) {
      profiles.push(parsed.value);
    } else {
      const bestEffortSpec = isPlainObject(entry) && typeof entry['spec'] === 'string' ? entry['spec'] : null;
      invalid.push({ spec: bestEffortSpec, error: parsed.error ?? 'specSemanticProfiles[]: inválido' });
    }
  }
  return { profiles, invalid };
}

// ---------------------------------------------------------------------------
// defensive_semantic_rules.payload (prompt v10 §15/§16) — augment vs.
// replace/suppress/convert_to_passive tienen forma distinta; ambas comparten
// `condition`, que decide si la regla puede aplicarse AUTOMÁTICAMENTE sobre
// el build estático (talent_selected/hero_talent_selected) o si exige
// observar runtime (runtime_state/other) — ver unresolvedRuntimeRules en el
// resolver. `passive_selected` se trata deliberadamente como NO automática en
// esta iteración: la especificación E1 solo enumera talent_selected/
// hero_talent_selected como automáticas; ampliar esa lista sin que el usuario
// lo confirme sería inventar una regla nueva, así que se degrada al mismo
// cajón que runtime_state/other (fail-closed, nunca al revés).
// ---------------------------------------------------------------------------

export const AUTOMATIC_SEMANTIC_RULE_CONDITIONS = new Set(['talent_selected', 'hero_talent_selected']);
export const SEMANTIC_RULE_CONDITIONS = new Set(['talent_selected', 'hero_talent_selected', 'passive_selected', 'runtime_state', 'other']);

export interface ParsedAugmentRulePayload {
  condition: string;
  modifierName: string | null;
  setUsageRole: DefensiveUsageRole | null;
  setDefensiveIntent: DefensiveIntent | null;
  setOpportunityMode: DefensiveOpportunityMode | null;
  setPrimaryBeneficiary: DefensivePrimaryBeneficiary | null;
  setSecondaryPropagation: DefensiveSecondaryPropagation | null;
  addMechanisms: DefensiveMechanism[];
  removeMechanisms: DefensiveMechanism[];
  applicabilityPatch: DamageApplicability | null;
  notes: string | null;
}

const AUGMENT_PAYLOAD_KEYS = new Set([
  'modifierName',
  'condition',
  'setUsageRole',
  'setDefensiveIntent',
  'setOpportunityMode',
  'setPrimaryBeneficiary',
  'setSecondaryPropagation',
  'addMechanisms',
  'removeMechanisms',
  'applicabilityPatch',
  'notes',
]);

export function parseAugmentRulePayload(raw: unknown): ParseResult<ParsedAugmentRulePayload> {
  if (!isPlainObject(raw)) return { value: null, error: 'payload de regla augment: se esperaba un objeto' };
  const keyError = rejectUnknownKeys(raw, AUGMENT_PAYLOAD_KEYS, 'payload augment');
  if (keyError) return { value: null, error: keyError };

  const condition = requiredEnum<string>(raw['condition'], 'payload augment.condition', SEMANTIC_RULE_CONDITIONS);
  if (condition.error) return { value: null, error: condition.error };
  const setUsageRole = optionalEnum<DefensiveUsageRole>(raw['setUsageRole'], 'payload augment.setUsageRole', USAGE_ROLE_SET);
  if (setUsageRole.error) return { value: null, error: setUsageRole.error };
  const setDefensiveIntent = optionalEnum<DefensiveIntent>(raw['setDefensiveIntent'], 'payload augment.setDefensiveIntent', DEFENSIVE_INTENT_SET);
  if (setDefensiveIntent.error) return { value: null, error: setDefensiveIntent.error };
  const setOpportunityMode = optionalEnum<DefensiveOpportunityMode>(raw['setOpportunityMode'], 'payload augment.setOpportunityMode', OPPORTUNITY_MODE_SET);
  if (setOpportunityMode.error) return { value: null, error: setOpportunityMode.error };
  const setPrimaryBeneficiary = optionalEnum<DefensivePrimaryBeneficiary>(
    raw['setPrimaryBeneficiary'],
    'payload augment.setPrimaryBeneficiary',
    PRIMARY_BENEFICIARY_SET,
  );
  if (setPrimaryBeneficiary.error) return { value: null, error: setPrimaryBeneficiary.error };
  const setSecondaryPropagation = optionalEnum<DefensiveSecondaryPropagation>(
    raw['setSecondaryPropagation'],
    'payload augment.setSecondaryPropagation',
    SECONDARY_PROPAGATION_SET,
  );
  if (setSecondaryPropagation.error) return { value: null, error: setSecondaryPropagation.error };
  const addMechanisms = raw['addMechanisms'];
  if (addMechanisms !== undefined && (!Array.isArray(addMechanisms) || addMechanisms.some((m) => typeof m !== 'string' || !MECHANISM_SET.has(m)))) {
    return { value: null, error: `payload augment.addMechanisms inválido: ${JSON.stringify(addMechanisms)}` };
  }
  const removeMechanisms = raw['removeMechanisms'];
  if (
    removeMechanisms !== undefined &&
    (!Array.isArray(removeMechanisms) || removeMechanisms.some((m) => typeof m !== 'string' || !MECHANISM_SET.has(m)))
  ) {
    return { value: null, error: `payload augment.removeMechanisms inválido: ${JSON.stringify(removeMechanisms)}` };
  }
  const applicabilityPatch = parseDamageApplicability(raw['applicabilityPatch'], 'payload augment.applicabilityPatch');
  if (applicabilityPatch.error) return { value: null, error: applicabilityPatch.error };
  if (raw['modifierName'] !== undefined && raw['modifierName'] !== null && typeof raw['modifierName'] !== 'string') {
    return { value: null, error: 'payload augment.modifierName debe ser string o null' };
  }
  if (raw['notes'] !== undefined && raw['notes'] !== null && typeof raw['notes'] !== 'string') {
    return { value: null, error: 'payload augment.notes debe ser string o null' };
  }

  return {
    error: null,
    value: {
      condition: condition.value!,
      modifierName: (raw['modifierName'] as string | null | undefined) ?? null,
      setUsageRole: setUsageRole.value,
      setDefensiveIntent: setDefensiveIntent.value,
      setOpportunityMode: setOpportunityMode.value,
      setPrimaryBeneficiary: setPrimaryBeneficiary.value,
      setSecondaryPropagation: setSecondaryPropagation.value,
      addMechanisms: Array.isArray(addMechanisms) ? [...new Set(addMechanisms as DefensiveMechanism[])] : [],
      removeMechanisms: Array.isArray(removeMechanisms) ? [...new Set(removeMechanisms as DefensiveMechanism[])] : [],
      applicabilityPatch: applicabilityPatch.value,
      notes: (raw['notes'] as string | null | undefined) ?? null,
    },
  };
}

export interface ParsedReplacementRulePayload {
  condition: string;
  triggerName: string | null;
  replacementSpellId: number | null;
  notes: string | null;
}

const REPLACEMENT_PAYLOAD_KEYS = new Set(['triggerName', 'replacementSpellId', 'condition', 'notes']);

export function parseReplacementRulePayload(raw: unknown): ParseResult<ParsedReplacementRulePayload> {
  if (!isPlainObject(raw)) return { value: null, error: 'payload de regla replace/suppress/convert_to_passive: se esperaba un objeto' };
  const keyError = rejectUnknownKeys(raw, REPLACEMENT_PAYLOAD_KEYS, 'payload replacement');
  if (keyError) return { value: null, error: keyError };

  const condition = requiredEnum<string>(raw['condition'], 'payload replacement.condition', SEMANTIC_RULE_CONDITIONS);
  if (condition.error) return { value: null, error: condition.error };
  const replacementSpellIdRaw = raw['replacementSpellId'];
  if (replacementSpellIdRaw !== undefined && replacementSpellIdRaw !== null) {
    if (typeof replacementSpellIdRaw !== 'number' || !Number.isInteger(replacementSpellIdRaw) || replacementSpellIdRaw <= 0) {
      return { value: null, error: `payload replacement.replacementSpellId inválido: ${JSON.stringify(replacementSpellIdRaw)}` };
    }
  }
  if (raw['triggerName'] !== undefined && raw['triggerName'] !== null && typeof raw['triggerName'] !== 'string') {
    return { value: null, error: 'payload replacement.triggerName debe ser string o null' };
  }
  if (raw['notes'] !== undefined && raw['notes'] !== null && typeof raw['notes'] !== 'string') {
    return { value: null, error: 'payload replacement.notes debe ser string o null' };
  }

  return {
    error: null,
    value: {
      condition: condition.value!,
      triggerName: (raw['triggerName'] as string | null | undefined) ?? null,
      replacementSpellId: (replacementSpellIdRaw as number | null | undefined) ?? null,
      notes: (raw['notes'] as string | null | undefined) ?? null,
    },
  };
}
