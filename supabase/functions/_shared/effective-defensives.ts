/**
 * Resolver canónico de defensivos efectivos.
 *
 * Es deliberadamente puro: los consumidores cargan catálogo/perfiles/reglas
 * en batch y esta función aplica exactamente la misma precedencia en analyze,
 * reanalyze, Preparación, solver y evaluator. No importa Supabase ni Deno, de
 * modo que su contrato se puede probar también desde la suite de Angular.
 */

import {
  isDefensiveKitMember,
  createsMissableOpportunity,
  defensiveSemanticError,
  type DefensiveSemanticInput,
  type DefensiveUsageRole,
  type DefensiveActivationScope,
  type DefensivePrimaryBeneficiary,
  type DefensiveSecondaryPropagation,
  type DefensiveMechanism,
  type DefensiveOpportunityMode,
  type DefensiveIntent,
  type DefensiveSemanticStatus,
} from './defensive-classification-semantics.ts';
import type { DamageApplicability } from './defensive-applicability.ts';
import {
  mergeApplicability,
  parseAugmentRulePayload,
  parseDamageApplicability,
  parseReplacementRulePayload,
  parseSpecSemanticProfiles,
  AUTOMATIC_SEMANTIC_RULE_CONDITIONS,
  type InvalidSpecSemanticProfile,
  type ValidatedSpecSemanticProfile,
} from './defensive-semantic-payload-validation.ts';

export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION = 'effective-defensives@2.3.0';
// §Paso C (iris-defensive-canonicalization-v1-plan.md §5): resolución
// SEMÁNTICA (usageRole/mechanisms/membership) versionada por separado del
// resolver de TIMING de arriba, a propósito. Bump del resolver de timing ya
// dispara reanálisis en analyze-report/reanalyze-defensive-pressure/
// defensive-v2-readiness/generate-defensive-plan (gate de homogeneidad de
// gran radio de impacto, ver DV2-09/specApplies() en el registro de
// auditoría — pendiente de decisión explícita del usuario, no se toca aquí).
// La resolución semántica es puramente aditiva sobre esa salida y todavía no
// la consume ningún scoring público, así que lleva su propio version marker
// — cuando el evaluator de episodios (Paso C, siguiente pieza) empiece a
// depender de ella, su propio gate de homogeneidad se construye sobre ESTA
// versión, no sobre EFFECTIVE_DEFENSIVE_RESOLVER_VERSION.
// §E1 (Effective Defensive Semantics Closure, 2026-09-04): bump 1.0.0→1.1.0.
// Cierra buildPresence/specSemanticProfiles/applicabilidad efectiva/reglas
// runtime no aplicadas/validación final — sigue siendo un marcador
// INDEPENDIENTE de EFFECTIVE_DEFENSIVE_RESOLVER_VERSION (timing) a propósito
// (ver comentario de arriba); nada público consume todavía este string, así
// que el bump no dispara ningún gate de homogeneidad existente.
// §E1 auditoría de roster (2026-09-04): bump 1.1.0→1.1.1 implícito por los
// dos cierres de la auditoría (static replacement target presence +
// validación estricta de enums en schools/deliveryScopes) — cambio de
// comportamiento observable en buildPresence/membership, absorbido en el
// bump siguiente porque ambos ocurrieron en la misma sesión de trabajo.
// §E2.1 (2026-09-04): bump 1.1.0→1.2.0. knownTalentEntryIds cambia
// observablemente unresolvedSelectedNodes → buildPresence/membership para
// cualquier caller que empiece a pasarlo (comportamiento fail-closed sin
// cambios para los que no lo pasan todavía).
// §E2.5 "Acquisition Safety Closure" (2026-09-04): bump 1.2.0→1.3.0. La rama
// "candidato de allTalentSpellIds, no seleccionado, build resuelto" deja de
// producir 'absent' (era una inferencia negativa inválida, demostrado
// empíricamente en E2.2-E2.4: 30/31 casos auditados tenían una ruta de
// adquisición real que WCL nunca reporta) — ahora produce 'unknown'. Se
// activa demonstratedPersistentCastSpellIds como prueba positiva de
// presencia. Cambio de comportamiento observable real en buildPresence/
// membership para cualquier caller que ya pasara allTalentSpellIds.
// §E2.6 "Acquisition Safety Closure — false-negative eligible-restoration"
// (2026-09-04): bump 1.3.0→1.3.1. Corrige el bug real encontrado en el
// cierre de E2.5: un cast validado (§E2.5, demonstratedPersistentCastSpellIds)
// que sube buildPresence de 'unknown'/'absent' a 'present' NO restauraba
// `eligible` — isDefensiveKitMember/createsMissableOpportunity exigen
// `eligible && buildPresence==='present'`, así que el defensivo seguía
// desaparecido del kit real pese a la prueba positiva de presencia
// (fixture real: Wargreymon / Anti-Magic Shell, spellId 48707). Ahora
// `eligible` se restaura al valor que tenía justo antes de la puerta legacy
// de adquisición directa no probada — nunca se fuerza a true a ciegas (ver
// `eligibleBeforeUnprovenDirectAcquisitionGate` más abajo). Cambio de
// comportamiento observable real en isDefensiveKitMember/
// createsMissableOpportunity para cualquier caller que ya pasara
// demonstratedPersistentCastSpellIds junto con allTalentSpellIds.
export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION = 'effective-defensive-semantics@1.5.0';
export const LEGACY_GAME_BUILD = 'legacy-current';

// §E1 — presencia real en ESTE build, independiente de "elegible ahora mismo"
// (eligible sigue existiendo, ver comentario en ResolvedDefensive más abajo).
// 'unknown' NUNCA se convierte en 'absent' por omisión de evidencia — solo
// hay tres formas legítimas de llegar a cada valor, ver la especificación E1
// §3 y su reflejo exacto en resolveEffectiveDefensiveKit() (mismo bloque que
// ya decidía `eligible` por talent-gating, reutilizado aquí sin duplicar
// lógica).
export type BuildPresence = 'present' | 'absent' | 'unknown';

// §E2.5 (2026-09-04, "Acquisition Safety Closure" — cierre de la auditoría
// E2.2-E2.4): E2.2-E2.4 demostraron empíricamente que
// "spellId ∈ allTalentSpellIds + no aparece seleccionado en WCL" NO es
// prueba de ausencia — 30 de 31 abilities "absent" auditadas resultaron
// tener una ruta de adquisición real que WCL nunca reporta (auto-granted,
// fuera del árbol comprable, etc.), demostrado por casts reales
// consistentes. La regla canónica pasa a ser estrictamente evidencial:
// prueba positiva → present; prueba positiva de EXCLUSIÓN → absent; ninguna
// de las dos → unknown. Este código documenta EXACTAMENTE qué evidencia
// produjo cada buildPresence, para que sea auditable sin tener que releer
// buildPresenceReason en prosa.
export type BuildPresenceEvidence =
  | 'baseline_kit'
  | 'selected_talent'
  | 'static_replacement'
  | 'replacement_not_selected'
  | 'observed_cast_same_pull'
  | 'observed_cast_same_build_fingerprint'
  | 'unresolved_acquisition';

// §E1 §6/§11/§14: estado final de la resolución semántica DESPUÉS de aplicar
// spec-profile + reglas estáticas + validación final. 'conflict' es la única
// forma de blindar isDefensiveKitMember/createsMissableOpportunity contra
// datos contradictorios sin tener que forzar cada predicado a mano en cada
// punto de fallo — ver semanticsConflict más abajo.
export type DefensiveEffectiveResolutionStatus = 'resolved' | 'unresolved' | 'conflict';

/** §E1 §9: runtime_state/other (y, por ahora, passive_selected — ver defensive-semantic-payload-validation.ts) nunca se aplican sobre el build estático; se devuelven aquí para que una fuente de evidencia futura (E7+) pueda resolverlos, sin aumentar certeza mientras tanto. */
export interface UnresolvedRuntimeRule {
  ruleId: string;
  condition: string;
  reason: string;
}

export type DefensiveCategory = 'personal_defensive' | 'semi_defensive' | 'external_defensive' | 'utility';
export type DefensiveTargetingMode = 'self' | 'ally' | 'both' | 'raid' | 'unknown';
export type DefensiveActivationMode = 'active' | 'passive';
export type DefensiveResolutionConfidence = 'verified' | 'inferred' | 'fallback' | 'uncertain';
export type DefensiveEffectField = 'cooldown_ms' | 'duration_ms' | 'charges' | 'recharge_ms';
export type DefensiveModifierOperation = 'set_ms' | 'multiply' | 'add_ms' | 'subtract_ms' | 'charges_add';

export interface TalentBuildNode {
  id: number;
  nodeID: number;
  rank: number;
  spellId?: number;
}

export interface EffectiveDefensiveCatalogEntry {
  spellId: number;
  name: string;
  className: string;
  specName: string | null;
  specOverride: string[] | null;
  category: DefensiveCategory;
  survivalType: 'mitigation' | 'absorption' | 'sustain' | 'emergency' | null;
  targetingMode: DefensiveTargetingMode;
  activationMode: DefensiveActivationMode;
  passiveConversionSpellIds: number[];
  activationGameBuild: string;
  baseCooldownMs: number | null;
  baseDurationMs: number | null;
  /** Exact-current reviewed catalog rows are authoritative over legacy spec profiles for the same field. Undefined keeps unit-test/backward compatibility; DB adapter always sets it explicitly. */
  reviewed?: boolean;
  excluded?: boolean;
}

export interface EffectiveDefensiveSpecProfile {
  className: string;
  specName: string;
  spellId: number;
  gameBuild: string;
  baseCooldownMs: number | null;
  baseDurationMs: number | null;
  charges: number;
  rechargeMs: number | null;
  source?: string | null;
  sourceNote?: string | null;
  syncedFromCommit?: string | null;
}

export interface EffectiveDefensiveModifierRule {
  id: string;
  className: string;
  specNames: string[] | null;
  modifierSpellId: number;
  targetSpellId: number;
  operation: DefensiveModifierOperation;
  effectField: DefensiveEffectField;
  value: number;
  perRank: boolean;
  condition: 'always' | 'conditional';
  gameBuild: string;
  applicationOrder: number;
  description: string;
  source?: string | null;
  active: boolean;
  /** How the modifier itself is present in the build. talent_selected requires a selected node; spec_baseline is auto-granted by the resolved spec. */
  presenceMode?: 'talent_selected' | 'spec_baseline';
}

/**
 * Fila de defensive_ability_semantic_catalog (la vista, no la tabla base —
 * ya trae el join con cooldown_catalog resuelto). Una fila `pending`/sin
 * match nunca puede llegar a `eligible + isDefensiveKitMember`; ver §21 del
 * plan y defensiveSemanticError/isDefensiveKitMember.
 */
export interface EffectiveDefensiveSemanticEntry {
  spellId: number;
  className: string;
  usageRole: DefensiveUsageRole;
  activationScope: DefensiveActivationScope;
  primaryBeneficiary: DefensivePrimaryBeneficiary;
  secondaryPropagation: DefensiveSecondaryPropagation;
  mechanisms: DefensiveMechanism[];
  opportunityMode: DefensiveOpportunityMode;
  defensiveIntent: DefensiveIntent;
  semanticStatus: DefensiveSemanticStatus;
  /**
   * §Pre-E6 fix #2 (2026-09-04, "semanticVersion TYPE CONTRACT"): la
   * columna real `defensive_ability_semantics.semantic_version` es
   * `NOT NULL` en producción (340/340 filas no-nulas hoy) — ese invariante
   * de la base de datos NO cambia. Este boundary de TypeScript es
   * deliberadamente `string | null` porque `effectiveDefensiveDataFromDatabaseRows()`
   * parsea filas de entrada NO confiables/externas (`Record<string, unknown>`
   * crudo de Supabase) con `nullableString()` — el mismo patrón fail-closed
   * que ya usa cada otro campo de esta interfaz — y `ResolvedDefensive.
   * semanticVersion` YA era `string | null` desde el resolver final. Antes
   * de este fix, esta interfaz intermedia era la única que mentía
   * (`string`, no nullable) sobre un dato que su propio parser podía
   * producir en `null` — un desajuste de tipos puramente de compilación,
   * nunca observado en runtime porque la columna real nunca es null, pero
   * que dejaba el boundary deshonesto y rompía `deno check`
   * (verify:causal-runtime). No se inventa un fallback ni se hace
   * `stringify(null)` — se alinea el tipo con el dato real que el parser
   * puede producir.
   */
  semanticVersion: string | null;
  semanticConfidence: DefensiveResolutionConfidence;
  locked: boolean;
  // ---- §E1: campos v10 que ya escribe classify-defensives, cerrados aquí ----
  /** Ya parseado por parseDamageApplicability en effectiveDefensiveDataFromDatabaseRows — nunca un cast directo del jsonb. null si no hay dato O si el jsonb estaba corrupto (ver applicabilityError). */
  applicability: DamageApplicability | null;
  applicabilityConfidence: 'high' | 'medium' | 'low' | null;
  /** Motivo por el que `applicability` quedó en null pese a que la fila traía algo — null cuando no hay error (incluye "no había dato"). Nunca se ignora en silencio: el resolver lo vuelca a semanticProvenance. */
  applicabilityError: string | null;
  /** Overrides por spec ya validados elemento a elemento — ver parseSpecSemanticProfiles. Un elemento corrupto NO invalida los demás (Avatar Arms sigue resolviendo aunque Avatar Protection esté corrupto). */
  specSemanticProfiles: ValidatedSpecSemanticProfile[];
  /** Elementos de spec_semantic_profiles que fallaron el parseo estricto — el resolver los usa para decidir resolutionStatus si alguno reclama la spec del jugador. */
  invalidSpecSemanticProfiles: InvalidSpecSemanticProfile[];
}

/** Fila de defensive_semantic_rules (semanticModifiers/replacementRules del prompt v10, ver classify-defensives). */
export interface EffectiveDefensiveSemanticRule {
  id: string;
  modifierSpellId: number;
  targetSpellId: number;
  specNames: string[] | null;
  gameBuild: string;
  ruleType: 'augment' | 'replace' | 'suppress' | 'convert_to_passive';
  payload: Record<string, unknown>;
  source: string | null;
  verified: boolean;
}

/** Traza de la resolución semántica — deliberadamente más simple que ResolutionStep (before/after no encaja bien con mechanisms[], que es un set, no un escalar). Suficiente para auditar/explicar, no para reconstruir el valor anterior campo a campo. */
export interface SemanticResolutionStep {
  kind:
    | 'catalog_base'
    | 'no_match'
    | 'semantic_rule_augment'
    | 'semantic_rule_replace'
    | 'semantic_rule_suppress'
    | 'semantic_rule_convert_to_passive'
    | 'semantic_rule_unverified'
    | 'ineligible'
    // ---- §E1 additions ----
    | 'applicability_invalid'
    | 'spec_profile_applied'
    | 'spec_profile_invalid'
    | 'semantic_rule_invalid_payload'
    | 'semantic_rule_runtime_unresolved'
    | 'semantic_rule_conflict'
    | 'semantic_rule_replace_unresolved'
    | 'applicability_patch_applied'
    | 'final_validation_conflict';
  description: string;
  source?: string | null;
  ruleId?: string;
}

export interface PlayerDefensiveOverride {
  id: string;
  characterId: number | null;
  playerName: string;
  className: string;
  specName: string | null;
  spellId: number;
  buildFingerprint: string | null;
  gameBuild: string;
  effectiveCooldownMs: number | null;
  effectiveDurationMs: number | null;
  charges: number | null;
  targetingMode: DefensiveTargetingMode | null;
  reason: string;
  active: boolean;
  updatedAt?: string | null;
}

export interface ResolveDefensiveKitInput {
  className: string;
  specName: string | null;
  talentBuild: TalentBuildNode[] | null;
  buildFingerprint: string | null;
  gameBuild: string | null;
  gameBuildConfidence?: DefensiveResolutionConfidence;
  playerIdentity?: { characterId?: number; playerName: string };
  includeExternal?: boolean;
  /** Todos los spellIds que pueden ser nodos de talento en este game build. */
  allTalentSpellIds?: ReadonlySet<number> | null;
  /** false significa que el lookup falló/no existe; undefined permite usar el resolver con catálogo sin talent gating. */
  talentLookupComplete?: boolean;
  /**
   * §E2.1 (2026-09-04, corrección de build-provenance): TODOS los
   * TraitNodeEntry.ID que existen de verdad en el DB2 de este build,
   * resuelvan o no a un spellId (ver wago-db2-client.ts TalentSpellLookup.
   * knownEntryIds). Sin esto, un nodo seleccionado sin spellId SIEMPRE se
   * trata como "genuinamente sin resolver" (comportamiento previo,
   * conservador) — con esto, un nodo seleccionado sin spellId que SÍ está
   * en este set es un nodo estructural conocido (p. ej. el selector de Hero
   * Talents) y NO cuenta como sin resolver. omitido/null preserva el
   * comportamiento fail-closed anterior sin cambios (compatibilidad total
   * con callers que no lo pasan todavía).
   */
  knownTalentEntryIds?: ReadonlySet<number> | null;
  /**
   * §E1 §3 / §E2.5 activación: "un cast real puede aportar prueba positiva de
   * presencia cuando el caller tenga evidencia de que es una ability
   * persistente del build". Deliberadamente estrecho: SOLO puede subir
   * buildPresence a 'present' (absent→present, unknown→present) — nunca se
   * usa para degradar ni para demostrar ausencia (la ausencia de un cast no
   * prueba nada, ver invariante 16). El VALOR de cada entrada es el código de
   * evidencia exacto que produjo esa entrada (same-pull vs cross-pull con el
   * mismo build_fingerprint no nulo) — el resolver nunca decide esa
   * distinción por sí mismo, la recibe ya resuelta del caller (§E2.5: el
   * caller es quien aplica la regla de alcance de fingerprint y el guard de
   * habilidades persistentes; el resolver solo consume el resultado ya
   * validado). Omitirlo es un no-op total, compatible con toda llamada que
   * no lo pase.
   */
  demonstratedPersistentCastSpellIds?: ReadonlyMap<number, 'observed_cast_same_pull' | 'observed_cast_same_build_fingerprint'> | null;
}

export interface EffectiveDefensiveData {
  catalog: EffectiveDefensiveCatalogEntry[];
  specProfiles: EffectiveDefensiveSpecProfile[];
  modifierRules: EffectiveDefensiveModifierRule[];
  overrides?: PlayerDefensiveOverride[];
  /** Paso C. Ausente/undefined (no [] vacío) = "el consumer todavía no cargó semántica" — el resolver debe distinguir eso de "cargó semántica y no hay match" (ver semanticResolved en ResolvedDefensive). */
  semantics?: EffectiveDefensiveSemanticEntry[];
  semanticRules?: EffectiveDefensiveSemanticRule[];
}

export interface EffectiveDefensiveDatabaseRows {
  catalogRows: Record<string, unknown>[];
  specProfileRows?: Record<string, unknown>[];
  modifierRuleRows?: Record<string, unknown>[];
  overrideRows?: Record<string, unknown>[];
  /** Filas de la VISTA defensive_ability_semantic_catalog (no de la tabla base) — ya trae class/spell_id resueltos. */
  semanticRows?: Record<string, unknown>[];
  semanticRuleRows?: Record<string, unknown>[];
}

export interface ObservedGameBuild {
  gameBuild: string | null;
  source: string | null;
  confidence: DefensiveResolutionConfidence;
}

export interface ResolutionStep {
  kind: 'catalog_base' | 'eligibility' | 'availability_rule' | 'spec_profile' | 'modifier' | 'conditional_modifier' | 'player_override' | 'validation';
  field: DefensiveEffectField | 'eligible' | 'targeting_mode' | 'activation_mode' | 'build_presence';
  before: number | string | boolean | null;
  after: number | string | boolean | null;
  operation?: DefensiveModifierOperation;
  source?: string | null;
  description: string;
  gameBuild?: string | null;
  ruleId?: string;
}

export interface ResolvedDefensive {
  spellId: number;
  name: string;
  className: string;
  specName: string | null;
  category: DefensiveCategory;
  survivalType: 'mitigation' | 'absorption' | 'sustain' | 'emergency' | null;
  targetingMode: DefensiveTargetingMode;
  activationMode: DefensiveActivationMode;
  effectiveCooldownMs: number | null;
  effectiveDurationMs: number | null;
  charges: number;
  rechargeMs: number | null;
  /** Claim-scoped source confidence. These fields deliberately do not collapse unrelated uncertainty into one global confidence. */
  cooldownConfidence?: DefensiveResolutionConfidence;
  durationConfidence?: DefensiveResolutionConfidence;
  chargesConfidence?: DefensiveResolutionConfidence;
  rechargeConfidence?: DefensiveResolutionConfidence;
  eligible: boolean;
  buildFingerprint: string | null;
  gameBuild: string | null;
  resolverVersion: string;
  confidence: DefensiveResolutionConfidence;
  provenance: ResolutionStep[];
  conditionalModifiers: ResolutionStep[];

  // ---- Paso C: resolución semántica (independiente del timing de arriba) ----
  /** false = el consumer no pasó `data.semantics` (llamada legacy, timing-only); true = sí se intentó resolver semántica, aunque no hubiera match (usageRole queda 'unknown'/semanticStatus 'pending' en ese caso, nunca se inventa). */
  semanticResolved: boolean;
  usageRole: DefensiveUsageRole;
  activationScope: DefensiveActivationScope;
  primaryBeneficiary: DefensivePrimaryBeneficiary;
  secondaryPropagation: DefensiveSecondaryPropagation;
  mechanisms: DefensiveMechanism[];
  opportunityMode: DefensiveOpportunityMode;
  defensiveIntent: DefensiveIntent;
  semanticStatus: DefensiveSemanticStatus;
  semanticVersion: string | null;
  semanticConfidence: DefensiveResolutionConfidence;
  semanticResolverVersion: string;
  semanticProvenance: SemanticResolutionStep[];

  // ---- §E1: Effective Defensive Semantics Closure ----
  /** Presencia real en ESTE build — ortogonal a `eligible` (ver comentario ahí). 'unknown'/'absent' nunca pueden fabricar culpa; ver invariantes de la especificación E1 §16. */
  buildPresence: BuildPresence;
  buildPresenceReason: string;
  buildPresenceConfidence: DefensiveResolutionConfidence;
  /** §E2.5: código de evidencia estructurado — auditable sin parsear buildPresenceReason. Ver BuildPresenceEvidence. */
  buildPresenceEvidence: BuildPresenceEvidence;
  /** Applicability EFECTIVA final (spec-profile override + applicabilityPatch de reglas automáticas ya fusionados) — el Episode Evaluator no debe volver a leer applicability por su cuenta cuando se conecte en E4. */
  applicability: DamageApplicability | null;
  applicabilityConfidence: 'high' | 'medium' | 'low' | null;
  resolutionStatus: DefensiveEffectiveResolutionStatus;
  /** runtime_state/other (y passive_selected) que existían para este spellId pero NO se aplicaron sobre el build estático — nunca aumentan membership/missability/applicability certainty (§9). */
  unresolvedRuntimeRules: UnresolvedRuntimeRule[];
  /**
   * Predicados derivados (isDefensiveKitMember/createsMissableOpportunity de
   * defensive-classification-semantics.ts) YA cruzados con `eligible` de
   * este build concreto — invariante 1 del plan: un consumer nunca debe
   * recalcularlos ni ignorar `eligible` (un personal_survival semánticamente
   * perfecto pero no seleccionado en este build no es parte del kit real).
   * §E1: además cruzados con `buildPresence === 'present'` y con
   * `resolutionStatus !== 'conflict'` — ver especificación E1 §3/§16.
   */
  isDefensiveKitMember: boolean;
  createsMissableOpportunity: boolean;
}

const CONFIDENCE_RANK: Record<DefensiveResolutionConfidence, number> = {
  verified: 0,
  inferred: 1,
  fallback: 2,
  uncertain: 3,
};

const RESOLUTION_STATUS_RANK: Record<DefensiveEffectiveResolutionStatus, number> = {
  resolved: 0,
  unresolved: 1,
  conflict: 2,
};

function worseStatus(current: DefensiveEffectiveResolutionStatus, candidate: DefensiveEffectiveResolutionStatus): DefensiveEffectiveResolutionStatus {
  return RESOLUTION_STATUS_RANK[candidate] > RESOLUTION_STATUS_RANK[current] ? candidate : current;
}

/**
 * §E1 §6/§11: combina propuestas de VARIAS reglas automáticas para el MISMO
 * campo sin depender del orden en que Postgres las devuelva — todas de
 * acuerdo (mismo valor, comparado por JSON) → se aplica; alguna discrepa →
 * conflict, no se elige ninguna por orden arbitrario.
 */
function resolveScalarConflict<T>(proposals: { value: T; ruleId: string }[]): { value: T | undefined; conflict: boolean; ruleIds: string[] } {
  if (!proposals.length) return { value: undefined, conflict: false, ruleIds: [] };
  const distinct = new Set(proposals.map((proposal) => JSON.stringify(proposal.value)));
  if (distinct.size > 1) return { value: undefined, conflict: true, ruleIds: proposals.map((proposal) => proposal.ruleId) };
  return { value: proposals[0].value, conflict: false, ruleIds: proposals.map((proposal) => proposal.ruleId) };
}

/**
 * §E1 audit fix (2026-09-04) — "static replacement target presence": ¿está
 * SELECCIONADO un spellId concreto (un talento, o el modificador que concede
 * un reemplazo estático) en este build? Extraída de la rama que ya usaba
 * el bloque de talent-gating de entry.spellId para no duplicar la lógica al
 * aplicarla también al MODIFICADOR de una regla `replace` entrante (ver
 * inboundReplacementsBySpellId más abajo) — misma fuente de verdad para
 * "seleccionado" en ambos casos.
 */
function talentSelectionPresence(
  modifierSpellId: number,
  ranks: Map<number, number>,
  normalizedBuild: TalentBuildNode[] | null,
  unresolvedSelectedNodes: boolean,
  gameBuildConfidence: DefensiveResolutionConfidence,
): { presence: BuildPresence; confidence: DefensiveResolutionConfidence; reason: string } {
  if (normalizedBuild == null) {
    return {
      presence: 'unknown',
      confidence: 'uncertain',
      reason: `No hay snapshot de build para demostrar si el modificador (spellId ${modifierSpellId}) está seleccionado.`,
    };
  }
  if (ranks.has(modifierSpellId)) {
    return {
      presence: 'present',
      confidence: gameBuildConfidence,
      reason: `El modificador (spellId ${modifierSpellId}) está seleccionado en el build observado.`,
    };
  }
  if (unresolvedSelectedNodes) {
    return {
      presence: 'unknown',
      confidence: 'uncertain',
      reason: `Hay nodos seleccionados sin spellId; no se puede demostrar si el modificador (spellId ${modifierSpellId}) falta.`,
    };
  }
  return {
    presence: 'absent',
    confidence: gameBuildConfidence,
    reason: `El modificador (spellId ${modifierSpellId}) no está seleccionado en un build completamente resuelto.`,
  };
}

/** present > unknown > absent — combina rutas de adquisición INDEPENDIENTES (OR): basta con que una demuestre presencia. */
function presenceOr(a: BuildPresence, b: BuildPresence): BuildPresence {
  if (a === 'present' || b === 'present') return 'present';
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return 'absent';
}

const OPERATION_ORDER: Record<DefensiveModifierOperation, number> = {
  set_ms: 0,
  multiply: 1,
  add_ms: 2,
  subtract_ms: 2,
  charges_add: 3,
};

const TARGETING_MODES = new Set<DefensiveTargetingMode>(['self', 'ally', 'both', 'raid', 'unknown']);

function weakerConfidence(
  current: DefensiveResolutionConfidence,
  candidate: DefensiveResolutionConfidence,
): DefensiveResolutionConfidence {
  return CONFIDENCE_RANK[candidate] > CONFIDENCE_RANK[current] ? candidate : current;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Adaptador compartido de filas snake_case al contrato puro. Mantenerlo aquí
 * evita que analyze, reanalyze y el endpoint interpreten columnas de forma
 * distinta. Los defaults legacy solo existen para poder desplegar el código
 * antes de ejecutar un backfill; nunca elevan la confidence a verified.
 */
export function effectiveDefensiveDataFromDatabaseRows(rows: EffectiveDefensiveDatabaseRows): EffectiveDefensiveData {
  return {
    catalog: rows.catalogRows.map((row) => ({
      spellId: Number(row['spell_id']),
      name: String(row['name'] ?? ''),
      className: String(row['class'] ?? ''),
      specName: nullableString(row['spec']),
      specOverride: Array.isArray(row['spec_override']) ? row['spec_override'].map(String) : null,
      category: row['category'] as DefensiveCategory,
      survivalType: nullableString(row['survival_type']) as EffectiveDefensiveCatalogEntry['survivalType'],
      targetingMode: (nullableString(row['targeting_mode']) ?? 'unknown') as DefensiveTargetingMode,
      activationMode: (nullableString(row['activation_mode']) ?? 'active') as DefensiveActivationMode,
      passiveConversionSpellIds: Array.isArray(row['passive_conversion_spell_ids'])
        ? row['passive_conversion_spell_ids'].map(Number).filter(positiveInteger)
        : [],
      activationGameBuild: nullableString(row['activation_game_build']) ?? LEGACY_GAME_BUILD,
      baseCooldownMs: nullableNumber(row['base_cooldown_ms']),
      baseDurationMs: nullableNumber(row['base_duration_ms']),
      reviewed: row['reviewed'] === true,
      excluded: row['excluded'] === true,
    })),
    specProfiles: (rows.specProfileRows ?? []).map((row) => ({
      className: String(row['class'] ?? ''),
      specName: String(row['spec'] ?? ''),
      spellId: Number(row['spell_id']),
      gameBuild: nullableString(row['game_build']) ?? LEGACY_GAME_BUILD,
      baseCooldownMs: nullableNumber(row['base_cooldown_ms']),
      baseDurationMs: nullableNumber(row['base_duration_ms']),
      charges: nullableNumber(row['charges']) ?? 1,
      rechargeMs: nullableNumber(row['recharge_ms']),
      source: nullableString(row['source']),
      sourceNote: nullableString(row['source_note']),
      syncedFromCommit: nullableString(row['synced_from_commit']),
    })),
    modifierRules: (rows.modifierRuleRows ?? []).map((row) => ({
      id: String(row['id'] ?? ''),
      className: String(row['class'] ?? ''),
      specNames: Array.isArray(row['specs']) ? row['specs'].map(String) : null,
      modifierSpellId: Number(row['modifier_spell_id']),
      targetSpellId: Number(row['target_spell_id']),
      operation: row['operation'] as DefensiveModifierOperation,
      effectField: (nullableString(row['effect_field']) ?? (row['operation'] === 'charges_add' ? 'charges' : 'cooldown_ms')) as DefensiveEffectField,
      value: Number(row['value']),
      perRank: row['per_rank'] === true,
      condition: row['condition'] === 'conditional' ? 'conditional' : 'always',
      gameBuild: nullableString(row['game_build']) ?? LEGACY_GAME_BUILD,
      applicationOrder: nullableNumber(row['application_order']) ?? 100,
      description: String(row['description'] ?? ''),
      source: nullableString(row['source']),
      active: row['active'] !== false,
      presenceMode: row['presence_mode'] === 'spec_baseline' ? 'spec_baseline' : 'talent_selected',
    })),
    overrides: (rows.overrideRows ?? []).map((row) => ({
      id: String(row['id'] ?? ''),
      characterId: nullableNumber(row['character_id']),
      playerName: String(row['player_name'] ?? ''),
      className: String(row['class'] ?? ''),
      specName: nullableString(row['spec']),
      spellId: Number(row['spell_id']),
      buildFingerprint: nullableString(row['build_fingerprint']),
      gameBuild: String(row['game_build'] ?? ''),
      effectiveCooldownMs: nullableNumber(row['effective_cooldown_ms']),
      effectiveDurationMs: nullableNumber(row['effective_duration_ms']),
      charges: nullableNumber(row['charges']),
      targetingMode: nullableString(row['targeting_mode']) as DefensiveTargetingMode | null,
      reason: String(row['reason'] ?? ''),
      active: row['active'] !== false,
      updatedAt: nullableString(row['updated_at']),
    })),
    // undefined (no []) cuando el consumer no pasó la fuente — distinto de
    // "se consultó y no había filas". Ver comentario en EffectiveDefensiveData.
    semantics: rows.semanticRows
      ? rows.semanticRows.map((row) => ({
          spellId: Number(row['spell_id']),
          className: String(row['class'] ?? ''),
          usageRole: (nullableString(row['usage_role']) ?? 'unknown') as DefensiveUsageRole,
          activationScope: (nullableString(row['activation_scope']) ?? 'unknown') as DefensiveActivationScope,
          primaryBeneficiary: (nullableString(row['primary_beneficiary']) ?? 'unknown') as DefensivePrimaryBeneficiary,
          secondaryPropagation: (nullableString(row['secondary_propagation']) ?? 'none') as DefensiveSecondaryPropagation,
          mechanisms: Array.isArray(row['mechanisms']) ? (row['mechanisms'].map(String) as DefensiveMechanism[]) : [],
          opportunityMode: (nullableString(row['opportunity_mode']) ?? 'none') as DefensiveOpportunityMode,
          defensiveIntent: (nullableString(row['defensive_intent']) ?? 'unknown') as DefensiveIntent,
          semanticStatus: (nullableString(row['semantic_status']) ?? 'pending') as DefensiveSemanticStatus,
          semanticVersion: nullableString(row['semantic_version']),
          semanticConfidence: (nullableString(row['confidence']) ?? 'uncertain') as DefensiveResolutionConfidence,
          locked: row['locked'] === true,
          // §E1: frontera del cast — ningún jsonb de aquí en adelante se
          // convierte con `as`, se valida con los parsers estrictos. Un
          // applicability/spec_semantic_profiles corrupto NUNCA se cuela
          // como dato bueno; queda en null/[] + su motivo en *Error/invalid*,
          // visible en semanticProvenance por el propio resolver.
          ...(() => {
            const parsedApplicability = parseDamageApplicability(row['applicability'], 'applicability');
            const parsedProfiles = parseSpecSemanticProfiles(row['spec_semantic_profiles']);
            return {
              applicability: parsedApplicability.value,
              applicabilityError: parsedApplicability.error,
              applicabilityConfidence: (nullableString(row['applicability_confidence']) ?? null) as 'high' | 'medium' | 'low' | null,
              specSemanticProfiles: parsedProfiles.profiles,
              invalidSpecSemanticProfiles: parsedProfiles.invalid,
            };
          })(),
        }))
      : undefined,
    semanticRules: rows.semanticRuleRows
      ? rows.semanticRuleRows.map((row) => ({
          id: String(row['id'] ?? ''),
          modifierSpellId: Number(row['modifier_spell_id']),
          targetSpellId: Number(row['target_spell_id']),
          // specs es NOT NULL default '{}' en defensive_semantic_rules (a
          // diferencia de defensive_modifier_rules.specs, que sí admite
          // NULL) — [] en esta tabla significa "sin restricción de spec",
          // no "no aplica a ninguna". classify-defensives ya escribe [] con
          // ese sentido (ver collectSemanticRuleWrites).
          specNames: Array.isArray(row['specs']) && row['specs'].length ? row['specs'].map(String) : null,
          gameBuild: nullableString(row['game_build']) ?? LEGACY_GAME_BUILD,
          ruleType: row['rule_type'] as EffectiveDefensiveSemanticRule['ruleType'],
          payload: row['payload'] && typeof row['payload'] === 'object' ? (row['payload'] as Record<string, unknown>) : {},
          source: nullableString(row['source']),
          verified: row['verified'] === true,
        }))
      : undefined,
  };
}

const CURRENT_BUILD_OBSERVATION_WINDOW_MS = 48 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * WCL no expone la patch exacta en ReportMasterData. Solo asociamos el build
 * actual de Blizzard a un pull observado como máximo 48 h antes del análisis,
 * y aun así se etiqueta inferred. Un histórico queda null/uncertain.
 */
export function inferCurrentGameBuildObservation(params: {
  currentGameBuild: string | null;
  reportStartTimeMs: number;
  fightStartTimeMs: number;
  analyzedAtMs?: number;
}): ObservedGameBuild {
  const observedAtMs = params.reportStartTimeMs + params.fightStartTimeMs;
  const analyzedAtMs = params.analyzedAtMs ?? Date.now();
  const ageMs = analyzedAtMs - observedAtMs;
  if (
    !params.currentGameBuild ||
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(analyzedAtMs) ||
    ageMs < -FUTURE_CLOCK_SKEW_MS ||
    ageMs > CURRENT_BUILD_OBSERVATION_WINDOW_MS
  ) {
    return { gameBuild: null, source: null, confidence: 'uncertain' };
  }
  return {
    gameBuild: params.currentGameBuild,
    source: 'blizzard-current-namespace:report-observed-within-48h',
    confidence: 'inferred',
  };
}

export function normalizeTalentBuild(nodes: TalentBuildNode[] | null): TalentBuildNode[] | null {
  if (nodes == null) return null;
  const byIdentity = new Map<string, TalentBuildNode>();
  for (const raw of nodes) {
    if (!positiveInteger(raw?.id) || !positiveInteger(raw?.nodeID) || !nonNegativeInteger(raw?.rank)) continue;
    const spellId = positiveInteger(raw.spellId) ? raw.spellId : undefined;
    const normalized: TalentBuildNode = { id: raw.id, nodeID: raw.nodeID, rank: raw.rank, ...(spellId ? { spellId } : {}) };
    const key = `${normalized.nodeID}:${normalized.id}`;
    const previous = byIdentity.get(key);
    if (!previous || normalized.rank > previous.rank || (normalized.rank === previous.rank && previous.spellId == null && normalized.spellId != null)) {
      byIdentity.set(key, normalized);
    }
  }
  return [...byIdentity.values()].sort(
    (a, b) => a.nodeID - b.nodeID || a.id - b.id || (a.spellId ?? 0) - (b.spellId ?? 0) || a.rank - b.rank,
  );
}

export async function fingerprintTalentBuild(
  className: string,
  specName: string | null,
  gameBuild: string | null,
  talentBuild: TalentBuildNode[] | null,
): Promise<string | null> {
  const normalized = normalizeTalentBuild(talentBuild);
  if (normalized == null) return null;
  const payload = JSON.stringify({
    className: className.trim(),
    specName: specName?.trim() ?? null,
    gameBuild: gameBuild?.trim() ?? null,
    nodes: normalized.map((node) => [node.nodeID, node.id, node.rank, node.spellId ?? null]),
  });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function specApplies(
  entry: Pick<EffectiveDefensiveCatalogEntry, 'specName' | 'specOverride'>,
  playerSpec: string | null,
): boolean {
  if (playerSpec == null) return true;
  if (entry.specOverride != null) return entry.specOverride.includes(playerSpec);
  if (entry.specName == null) return true;
  return entry.specName
    .split('/')
    .map((spec) => spec.trim())
    .includes(playerSpec);
}

function ruleIdentity(rule: EffectiveDefensiveModifierRule): string {
  return [rule.className, rule.modifierSpellId, rule.targetSpellId, rule.operation, rule.effectField].join(':');
}

function rulesForBuild(
  rules: EffectiveDefensiveModifierRule[],
  gameBuild: string | null,
): { rule: EffectiveDefensiveModifierRule; buildConfidence: DefensiveResolutionConfidence }[] {
  const exactKeys = new Set(
    gameBuild == null
      ? []
      : rules.filter((rule) => rule.gameBuild === gameBuild).map(ruleIdentity),
  );
  return rules
    .filter((rule) => {
      if (gameBuild != null && rule.gameBuild === gameBuild) return true;
      return rule.gameBuild === LEGACY_GAME_BUILD && !exactKeys.has(ruleIdentity(rule));
    })
    .map((rule) => ({
      rule,
      buildConfidence: rule.gameBuild === gameBuild ? 'verified' : 'fallback',
    }));
}

function profileForBuild(
  profiles: EffectiveDefensiveSpecProfile[],
  gameBuild: string | null,
): { profile: EffectiveDefensiveSpecProfile; buildConfidence: DefensiveResolutionConfidence } | null {
  const exact = gameBuild == null ? undefined : profiles.find((profile) => profile.gameBuild === gameBuild);
  if (exact) return { profile: exact, buildConfidence: 'verified' };
  const legacy = profiles.find((profile) => profile.gameBuild === LEGACY_GAME_BUILD);
  return legacy ? { profile: legacy, buildConfidence: 'fallback' } : null;
}

function buildRanks(nodes: TalentBuildNode[] | null): Map<number, number> {
  const ranks = new Map<number, number>();
  for (const node of nodes ?? []) {
    if (!positiveInteger(node.spellId) || node.rank <= 0) continue;
    ranks.set(node.spellId, Math.max(ranks.get(node.spellId) ?? 0, node.rank));
  }
  return ranks;
}

function matchingOverride(
  overrides: PlayerDefensiveOverride[],
  input: ResolveDefensiveKitInput,
  spellId: number,
): PlayerDefensiveOverride | null {
  // La consolidación visual elimina el antiguo scope reutilizable con
  // fingerprint null. Sin identidad exacta solo puede existir una corrección
  // dentro del snapshot de un draft, nunca una regla global del resolver.
  if (!input.playerIdentity || !input.gameBuild || !input.buildFingerprint) return null;
  const name = input.playerIdentity.playerName.trim().toLowerCase();
  const matches = overrides.filter((override) => {
    if (!override.active || override.spellId !== spellId || override.className !== input.className || override.gameBuild !== input.gameBuild) return false;
    if (override.specName != null && override.specName !== input.specName) return false;
    if (override.characterId != null) {
      if (input.playerIdentity?.characterId == null || override.characterId !== input.playerIdentity.characterId) return false;
    } else if (override.playerName.trim().toLowerCase() !== name) {
      return false;
    }
    return override.buildFingerprint != null && override.buildFingerprint === input.buildFingerprint;
  });
  return matches
    .sort((a, b) => {
      const exactSpecA = a.specName == null ? 0 : 1;
      const exactSpecB = b.specName == null ? 0 : 1;
      if (exactSpecA !== exactSpecB) return exactSpecB - exactSpecA;
      const stableIdentityA = a.characterId == null ? 0 : 1;
      const stableIdentityB = b.characterId == null ? 0 : 1;
      if (stableIdentityA !== stableIdentityB) return stableIdentityB - stableIdentityA;
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id);
    })[0] ?? null;
}

/**
 * §E2.1 — un nodo SELECCIONADO sin spellId es "genuinamente sin resolver"
 * solo si no se puede dar cuenta de él con el snapshot DB2 (knownEntryIds).
 * Sin snapshot (knownEntryIds null/undefined — caller no actualizado
 * todavía): comportamiento previo sin cambios, fail-closed total. Con
 * snapshot: un entry conocido en el DB2 de este build es un nodo
 * estructural/sin spell legítimo (nunca se le inventa un spellId) y NO
 * cuenta como sin resolver; solo un entry que NI SIQUIERA está en el
 * snapshot sigue siendo genuinamente irresoluble.
 */
function isGenuinelyUnresolvedNode(node: TalentBuildNode, knownEntryIds: ReadonlySet<number> | null | undefined): boolean {
  if (node.rank <= 0 || positiveInteger(node.spellId)) return false;
  if (knownEntryIds == null) return true;
  return !knownEntryIds.has(node.id);
}

function ruleValue(rule: EffectiveDefensiveModifierRule, rank: number): number {
  return rule.value * (rule.perRank ? rank : 1);
}

export function resolveEffectiveDefensiveKit(
  input: ResolveDefensiveKitInput,
  data: EffectiveDefensiveData,
): ResolvedDefensive[] {
  const normalizedBuild = normalizeTalentBuild(input.talentBuild);
  const ranks = buildRanks(normalizedBuild);
  const unresolvedSelectedNodes = (normalizedBuild ?? []).some((node) => isGenuinelyUnresolvedNode(node, input.knownTalentEntryIds));
  const gameBuildConfidence = input.gameBuildConfidence ?? (input.gameBuild ? 'verified' : 'uncertain');

  // §E1 audit fix — "static replacement target presence": precalculado UNA
  // vez por llamada (no por fila del catálogo) para no reparsear el mismo
  // payload por cada entrada. Solo reglas 'replace' verificadas, del
  // game_build exacto (sin fallback legacy — mismo criterio que el resto de
  // reglas semánticas, §8/§16) y cuya spec aplique. `automatic` distingue
  // talent_selected/hero_talent_selected (resoluble desde el build estático)
  // de runtime_state/other/passive_selected (nunca resoluble aquí — el
  // spellId destino queda 'unknown', jamás 'present' por defecto).
  const inboundReplacementsBySpellId = new Map<number, { modifierSpellId: number; ruleId: string; automatic: boolean; condition: string }[]>();
  for (const rule of data.semanticRules ?? []) {
    if (rule.ruleType !== 'replace' || !rule.verified || rule.gameBuild !== input.gameBuild) continue;
    if (rule.specNames != null && (input.specName == null || !rule.specNames.includes(input.specName))) continue;
    const parsed = parseReplacementRulePayload(rule.payload);
    if (!parsed.value?.replacementSpellId) continue;
    const list = inboundReplacementsBySpellId.get(parsed.value.replacementSpellId) ?? [];
    list.push({
      modifierSpellId: rule.modifierSpellId,
      ruleId: rule.id,
      automatic: AUTOMATIC_SEMANTIC_RULE_CONDITIONS.has(parsed.value.condition),
      condition: parsed.value.condition,
    });
    inboundReplacementsBySpellId.set(parsed.value.replacementSpellId, list);
  }

  return data.catalog
    .filter((entry) => !entry.excluded && entry.className === input.className && specApplies(entry, input.specName))
    .filter((entry) => input.includeExternal !== false || entry.category !== 'external_defensive')
    .map((entry): ResolvedDefensive => {
      let confidence: DefensiveResolutionConfidence = gameBuildConfidence;
      let eligible = true;
      let cooldownMs = entry.baseCooldownMs;
      let durationMs = entry.baseDurationMs;
      let charges = 1;
      let rechargeMs: number | null = null;
      // §E8-v5: field-scoped authority. Exact-current + reviewed catalog facts are
      // strong for cooldown/duration. A legacy spec profile may remain provenance,
      // but it cannot downgrade or overwrite those stronger fields.
      const catalogBuildConfidence: DefensiveResolutionConfidence =
        input.gameBuild != null && entry.activationGameBuild === input.gameBuild
          ? entry.reviewed === false
            ? 'inferred'
            : gameBuildConfidence
          : 'fallback';
      let cooldownConfidence: DefensiveResolutionConfidence = cooldownMs == null ? 'uncertain' : catalogBuildConfidence;
      let durationConfidence: DefensiveResolutionConfidence = durationMs == null ? 'uncertain' : catalogBuildConfidence;
      // cooldown_catalog does not carry a charge column. One charge is therefore
      // an inferred baseline until an exact profile/modifier proves otherwise.
      let chargesConfidence: DefensiveResolutionConfidence = input.gameBuild != null ? 'inferred' : 'fallback';
      let rechargeConfidence: DefensiveResolutionConfidence = 'uncertain';
      let targetingMode = TARGETING_MODES.has(entry.targetingMode) ? entry.targetingMode : 'unknown';
      let activationMode: DefensiveActivationMode = entry.activationMode === 'passive' ? 'passive' : 'active';
      // §E1 — buildPresence por defecto: baseline de clase/spec no talent-gated
      // (regla 1 de la especificación). El bloque de talent-gating de abajo
      // reutiliza EXACTAMENTE la misma rama que ya decide `eligible` para
      // sobrescribir estos tres valores juntos cuando el defensivo SÍ es un
      // nodo de talento — nunca se vuelve a derivar por separado.
      let buildPresence: BuildPresence = 'present';
      let buildPresenceReason = 'No es un nodo de talento ni el destino de un reemplazo estático conocido — disponible en el baseline de la clase/spec.';
      let buildPresenceConfidence: DefensiveResolutionConfidence = gameBuildConfidence;
      let buildPresenceEvidence: BuildPresenceEvidence = 'baseline_kit';
      // §E2.5: declarado aquí (no en el bloque semántico, donde vivía antes)
      // para que la ruta de reemplazo entrante (más abajo, todavía dentro del
      // bloque de TIMING) pueda registrar también sus condiciones runtime no
      // estáticas en el mismo array — antes esa ruta producía 'unknown' sin
      // dejar rastro en unresolvedRuntimeRules, y el guard de
      // demonstratedPersistentCastSpellIds necesita esa señal para excluir
      // "runtime replacements" del §E2.5.
      const unresolvedRuntimeRules: UnresolvedRuntimeRule[] = [];
      // §E1 audit fix: distingue "el bloque de talent-gating de entry.spellId
      // sí corrió" de "sigue en el default de baseline sin evaluar" — sin
      // esto, combinar con la ruta de reemplazo entrante haría presenceOr()
      // contra un 'present' de baseline no demostrado y nunca lo corregiría.
      let buildPresenceHasDirectRoute = false;
      // §E2.6 (Acquisition Safety Closure — false-negative fix): valor de
      // `eligible` justo antes de que la puerta legacy de adquisición
      // directa no probada (más abajo, "sin prueba positiva de exclusión")
      // lo fuerce a false. Captura CUALQUIER bloqueo legítimo previo
      // (activationMode==='passive', conversión pasiva por talento) porque
      // se lee inmediatamente antes de esa puerta específica — no antes de
      // toda la resolución. Si un cast validado (§E2.5) sube buildPresence
      // de 'unknown' a 'present' para ESTE mismo defensivo, `eligible` se
      // restaura a este valor exacto (nunca se fuerza a true a ciegas). Si
      // la puerta nunca corre (el spellId no es un candidato de
      // talent_spell_lookup, o sí resuelve seleccionado, o el build no está
      // resuelto), queda en null y no hay nada que restaurar.
      let eligibleBeforeUnprovenDirectAcquisitionGate: boolean | null = null;
      // §E7-GAP-01: confidence immediately before the same acquisition gate.
      // A positive cast may remove uncertainty introduced by that gate, but
      // must preserve any unrelated uncertainty that already existed.
      let confidenceBeforeUnprovenDirectAcquisitionGate: DefensiveResolutionConfidence | null = null;
      const provenance: ResolutionStep[] = [
        {
          kind: 'catalog_base',
          field: 'cooldown_ms',
          before: null,
          after: cooldownMs,
          description: 'Cooldown base de cooldown_catalog.',
        },
        {
          kind: 'catalog_base',
          field: 'duration_ms',
          before: null,
          after: durationMs,
          description: 'Duración base de cooldown_catalog.',
        },
        {
          kind: 'catalog_base',
          field: 'targeting_mode',
          before: null,
          after: targetingMode,
          description: 'Semántica de target del catálogo.',
        },
      ];
      const conditionalModifiers: ResolutionStep[] = [];

      if (activationMode === 'passive') {
        eligible = false;
        provenance.push({
          kind: 'eligibility',
          field: 'activation_mode',
          before: 'active',
          after: 'passive',
          description: 'El catálogo actual define la habilidad como pasiva; no existe un botón asignable.',
          gameBuild: entry.activationGameBuild,
        });
      }

      if (entry.passiveConversionSpellIds.length) {
        const activationBuildMatches = input.gameBuild != null && entry.activationGameBuild === input.gameBuild;
        if (!activationBuildMatches || normalizedBuild == null || unresolvedSelectedNodes) {
          eligible = false;
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({
            kind: 'availability_rule',
            field: 'eligible',
            before: true,
            after: false,
            description: !activationBuildMatches
              ? 'La conversión activa/pasiva no está verificada para este build; se excluye del plan por seguridad.'
              : 'No se puede resolver con certeza si el talento convierte esta habilidad en pasiva; se excluye del plan por seguridad.',
            gameBuild: entry.activationGameBuild,
          });
        } else {
          const selectedConverter = entry.passiveConversionSpellIds.find((spellId) => ranks.has(spellId));
          if (selectedConverter != null) {
            eligible = false;
            activationMode = 'passive';
            provenance.push({
              kind: 'availability_rule',
              field: 'activation_mode',
              before: 'active',
              after: 'passive',
              source: `talent:${selectedConverter}`,
              description: 'Un talento seleccionado convierte la habilidad en pasiva o elimina el botón activo.',
              gameBuild: entry.activationGameBuild,
            });
          }
        }
      }

      if (input.talentLookupComplete === false) {
        confidence = weakerConfidence(confidence, 'fallback');
        provenance.push({
          kind: 'eligibility',
          field: 'eligible',
          before: true,
          after: true,
          description: 'No hay lookup completo de talentos; el defensivo se conserva y eligibility queda en fallback.',
        });
      }

      if (input.specName == null && (entry.specName != null || entry.specOverride != null)) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'eligibility',
          field: 'eligible',
          before: true,
          after: true,
          description: 'La spec del jugador no está resuelta; el defensivo se conserva visible pero su pertenencia queda uncertain.',
        });
      }

      if (!TARGETING_MODES.has(entry.targetingMode)) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'validation',
          field: 'targeting_mode',
          before: entry.targetingMode,
          after: 'unknown',
          description: 'targeting_mode inválido; se degrada a unknown.',
        });
      }

      if (input.allTalentSpellIds?.has(entry.spellId)) {
        buildPresenceHasDirectRoute = true;
        if (normalizedBuild == null) {
          confidence = weakerConfidence(confidence, 'uncertain');
          buildPresence = 'unknown';
          buildPresenceConfidence = 'uncertain';
          buildPresenceEvidence = 'unresolved_acquisition';
          buildPresenceReason = 'El defensivo es un candidato de talent_spell_lookup, pero no hay snapshot de build; no se puede demostrar presencia ni ausencia.';
          provenance.push({
            kind: 'eligibility',
            field: 'eligible',
            before: true,
            after: true,
            description: 'El defensivo es talent-gated, pero no hay snapshot de build; no se oculta y queda uncertain.',
          });
        } else if (ranks.has(entry.spellId)) {
          buildPresence = 'present';
          buildPresenceEvidence = 'selected_talent';
          buildPresenceReason = 'El nodo del defensivo está seleccionado en el build observado.';
          provenance.push({
            kind: 'eligibility',
            field: 'eligible',
            before: true,
            after: true,
            description: 'El nodo del defensivo está seleccionado en el build observado.',
          });
        } else if (unresolvedSelectedNodes) {
          confidence = weakerConfidence(confidence, 'uncertain');
          buildPresence = 'unknown';
          buildPresenceConfidence = 'uncertain';
          buildPresenceEvidence = 'unresolved_acquisition';
          buildPresenceReason = 'Hay nodos seleccionados sin spellId; no se puede demostrar que el defensivo falte (ni que esté presente).';
          provenance.push({
            kind: 'eligibility',
            field: 'eligible',
            before: true,
            after: true,
            description: 'Hay nodos seleccionados sin spellId; no se puede demostrar que el defensivo falte.',
          });
        } else {
          // §E2.5 (Acquisition Safety Closure) — CORRECCIÓN DEL BUG REAL
          // encontrado por la auditoría E2.2-E2.4: "spellId ∈
          // allTalentSpellIds + no aparece seleccionado en un build
          // resuelto" NO es prueba de exclusión. allTalentSpellIds es un
          // conjunto CANDIDATO (todo entry del DB2 que resuelve a un
          // spellId, resuelva o no a un nodo realmente comprable — ver
          // wago-db2-client.ts) — no una prueba de que la ability exija
          // selección explícita. 30 de 31 "absent" auditadas en E2.2-E2.4
          // (AMS, Death Pact, Halo, Numbing Poison, Healing Tide Totem,
          // Ironfur, Intervene/Interpose/Demolish, Consumption, Temporal
          // Barrier, Dream Flight, Healing Elixir, Prayer of Healing...)
          // resultaron tener una ruta de adquisición real que WCL nunca
          // reporta, demostrado por casts reales consistentes. ANTES: esta
          // rama marcaba eligible=false y buildPresence='absent'. AHORA:
          // sin prueba positiva de exclusión (§E2.5 regla canónica), esto
          // es 'unknown', nunca 'absent'. `eligible` se conserva sin tocar
          // (compatibilidad legacy explícita, ver comentario de ese campo)
          // — el gate de scoring real (isDefensiveKitMember/
          // createsMissableOpportunity) ya exige buildPresence==='present'
          // aparte de eligible, así que este cambio por sí solo cierra el
          // bug de scoring sin tocar consumidores legacy de `eligible`.
          // `eligible` en sí SÍ se conserva exactamente como antes (sigue
          // pasando a false aquí) — es un campo legacy explícitamente fuera
          // de alcance de este cierre (ver comentario en su declaración);
          // como isDefensiveKitMember/createsMissableOpportunity ya exigen
          // buildPresence==='present' ADEMÁS de eligible, el resultado de
          // scoring canónico es idéntico se toque o no eligible aquí — así
          // que se deja intacto para no migrar de golpe defensive-plan-solver
          // (ese trabajo es E9, no E2.5) ni romper tests/consumidores legacy.
          // §E2.6: se captura el valor de `eligible` INMEDIATAMENTE antes de
          // esta asignación — ver declaración de la variable más arriba.
          eligibleBeforeUnprovenDirectAcquisitionGate = eligible;
          confidenceBeforeUnprovenDirectAcquisitionGate = confidence;
          eligible = false;
          confidence = weakerConfidence(confidence, 'uncertain');
          buildPresence = 'unknown';
          buildPresenceConfidence = 'uncertain';
          buildPresenceEvidence = 'unresolved_acquisition';
          buildPresenceReason = 'El defensivo es un candidato de talent_spell_lookup y no aparece seleccionado en un build resuelto, pero eso no basta para demostrar exclusión (§E2.5) — puede ser una ability auto-granted o fuera del árbol comprable que WCL nunca reporta.';
          provenance.push({
            kind: 'eligibility',
            field: 'eligible',
            before: true,
            after: false,
            description: 'El defensivo es un candidato de talent_spell_lookup, pero no aparece seleccionado; sin prueba positiva de exclusión, buildPresence no se demuestra ausente (§E2.5) — eligible se conserva en false por compatibilidad legacy (ver comentario del campo).',
          });
        }
      }

      // §E1 audit fix — "static replacement target presence" (2026-09-04):
      // un spellId que solo se alcanza mediante un reemplazo estático
      // verificado (Ice Cold←Ice Block/414659, Demonic Healthstone←
      // Healthstone/386689 son los dos casos reales encontrados en la DB)
      // NUNCA puede quedarse en el baseline 'present' solo porque el propio
      // spellId no es, él mismo, un nodo de talento — su presencia real
      // depende de si el MODIFICADOR que concede el reemplazo está
      // seleccionado. Sin ruta directa (buildPresenceHasDirectRoute=false),
      // esta ruta SUSTITUYE el baseline por completo; con ruta directa
      // (el mismo spellId es también, independientemente, un nodo de
      // talento) se combina con OR — cualquier ruta genuinamente
      // independiente que demuestre presencia basta.
      const inboundReplacements = inboundReplacementsBySpellId.get(entry.spellId) ?? [];
      if (inboundReplacements.length) {
        const routeResults = inboundReplacements.map((route) => {
          if (!route.automatic) {
            // §E2.5: además de degradar a 'unknown', se registra como regla
            // runtime no resuelta EN EL MISMO array que usa el resto del
            // resolver (unresolvedRuntimeRules) — antes esta rama producía
            // 'unknown' sin dejar rastro ahí, y el guard de
            // demonstratedPersistentCastSpellIds (aplicado por el caller)
            // necesita poder ver "esta ability solo se alcanza por una
            // condición runtime" para excluirla de la evidencia de cast.
            unresolvedRuntimeRules.push({
              ruleId: route.ruleId,
              condition: route.condition,
              reason: `Reemplazo entrante condicionado a "${route.condition}" (modificador spellId ${route.modifierSpellId}) — no se aplica sobre el build estático (§9); requiere una fuente de evidencia runtime que todavía no existe.`,
            });
            return {
              presence: 'unknown' as BuildPresence,
              confidence: 'uncertain' as DefensiveResolutionConfidence,
              reason: `El modificador (spellId ${route.modifierSpellId}) tiene una condición no estática (runtime_state/other/passive_selected) — su selección no se puede demostrar desde el build (§9).`,
              evidence: 'unresolved_acquisition' as BuildPresenceEvidence,
              ruleId: route.ruleId,
            };
          }
          const resolved = talentSelectionPresence(route.modifierSpellId, ranks, normalizedBuild, unresolvedSelectedNodes, gameBuildConfidence);
          return {
            ...resolved,
            evidence: (resolved.presence === 'present'
              ? 'static_replacement'
              : resolved.presence === 'absent'
                ? 'replacement_not_selected'
                : 'unresolved_acquisition') as BuildPresenceEvidence,
            ruleId: route.ruleId,
          };
        });
        const inboundCombined = routeResults.reduce<BuildPresence>((acc, route) => presenceOr(acc, route.presence), 'absent');
        const inboundConfidence = routeResults.reduce(
          (worst, route) => weakerConfidence(worst, route.confidence),
          gameBuildConfidence as DefensiveResolutionConfidence,
        );
        const inboundReason = `Solo alcanzable mediante reemplazo estático (regla${inboundReplacements.length > 1 ? 's' : ''} ${routeResults.map((r) => r.ruleId).join(', ')}): ${routeResults.map((r) => r.reason).join(' ')}`;
        // §E2.5: evidencia del/de los route(s) que realmente ganaron la
        // combinación — mismo orden de prioridad que presenceOr (present >
        // unknown > absent), así buildPresenceEvidence nunca queda
        // desincronizado de buildPresence.
        const inboundEvidence: BuildPresenceEvidence =
          routeResults.find((r) => r.presence === inboundCombined)?.evidence ?? 'unresolved_acquisition';

        if (buildPresenceHasDirectRoute) {
          const combined = presenceOr(buildPresence, inboundCombined);
          if (combined !== buildPresence) {
            buildPresence = combined;
            buildPresenceReason = `${buildPresenceReason} Además, ${inboundReason}`;
            buildPresenceConfidence = weakerConfidence(buildPresenceConfidence, inboundConfidence);
            buildPresenceEvidence = inboundEvidence;
          }
        } else {
          // Sin ruta directa: el reemplazo entrante ES la única fuente de
          // verdad — reemplaza el baseline 'present' no demostrado (bug real
          // corregido por esta auditoría E1: Ice Cold/Demonic Healthstone no
          // están en talent_spell_lookup por sí mismos y por eso caían aquí
          // como "no talent-gated" cuando en realidad solo existen si se
          // seleccionó el modificador correspondiente).
          buildPresence = inboundCombined;
          buildPresenceReason = inboundReason;
          buildPresenceConfidence = inboundConfidence;
          buildPresenceEvidence = inboundEvidence;
          if (inboundCombined === 'absent') {
            // §E2.5: ÚNICA forma preservada de negativo explícito — el
            // modificador que concede el reemplazo está demostrablemente NO
            // seleccionado en un build resuelto (regla verificada, no
            // ambigüedad de allTalentSpellIds). Se mantiene sin cambios.
            eligible = false;
          } else if (inboundCombined === 'unknown') {
            confidence = weakerConfidence(confidence, 'uncertain');
          }
        }
      }

      // §E1 §3 / §E2.5 activación: un cast real demostrablemente persistente
      // del build SOLO puede subir buildPresence — nunca lo baja ni
      // demuestra ausencia (invariante 16, sin cambios). El VALOR del mapa
      // es el código de evidencia exacto (same-pull vs cross-pull con
      // fingerprint no nulo) — decidido enteramente por el caller, el
      // resolver solo lo consume.
      const castEvidence = input.demonstratedPersistentCastSpellIds?.get(entry.spellId);
      if (buildPresence !== 'present' && castEvidence != null) {
        const castEvidenceConfidence: DefensiveResolutionConfidence =
          castEvidence === 'observed_cast_same_pull' ? 'verified' : 'inferred';
        // §E2.6 (Acquisition Safety Closure — false-negative fix): la puerta
        // legacy de adquisición directa no probada (§E2.5, arriba) dejaba
        // `eligible=false` sin tocarlo nunca — pero isDefensiveKitMember /
        // createsMissableOpportunity exigen `eligible && buildPresence===
        // 'present'`, así que un cast validado que sube buildPresence a
        // 'present' no bastaba: el defensivo desaparecía igual del kit real.
        // Fixture real: Wargreymon / Anti-Magic Shell (48707) —
        // buildPresence pasa a 'present' vía observed_cast_same_build_
        // fingerprint pero eligible se quedaba en false.
        // Se restaura `eligible` al valor que tenía justo antes de esa
        // puerta (nunca se fuerza a true a ciegas): si ya era false por un
        // bloqueo legítimo previo (activationMode pasivo, conversión por
        // talento), sigue false. Si la puerta nunca corrió para este
        // spellId, no hay nada que restaurar.
        if (eligibleBeforeUnprovenDirectAcquisitionGate != null) {
          eligible = eligibleBeforeUnprovenDirectAcquisitionGate;
        }
        if (confidenceBeforeUnprovenDirectAcquisitionGate != null) {
          confidence = weakerConfidence(
            confidenceBeforeUnprovenDirectAcquisitionGate,
            castEvidenceConfidence,
          );
        }
        buildPresence = 'present';
        // The positive observation disproves the acquisition UNKNOWN itself:
        // same-pull is verified; exact same-build fingerprint is inferred.
        buildPresenceConfidence = castEvidenceConfidence;
        buildPresenceEvidence = castEvidence;
        buildPresenceReason =
          castEvidence === 'observed_cast_same_pull'
            ? 'Un cast real observado en este mismo pull demuestra que la ability pertenece al build, pese a que la evidencia de talento no lo confirmaba.'
            : 'Un cast real observado en otro pull con el mismo talent_build_fingerprint exacto (no nulo) demuestra que la ability pertenece a este build, pese a que la evidencia de talento no lo confirmaba.';
      }
      provenance.push({
        kind: 'eligibility',
        field: 'build_presence',
        before: null,
        after: buildPresence,
        description: buildPresenceReason,
      });

      const profileCandidates = data.specProfiles.filter(
        (profile) => profile.className === input.className && profile.specName === input.specName && profile.spellId === entry.spellId,
      );
      const selectedProfile = profileForBuild(profileCandidates, input.gameBuild);
      if (selectedProfile) {
        const { profile, buildConfidence } = selectedProfile;
        const profileConfidence = buildConfidence === 'verified' ? gameBuildConfidence : buildConfidence;
        const exactReviewedCatalog =
          input.gameBuild != null && entry.activationGameBuild === input.gameBuild && entry.reviewed !== false;
        const legacyBlockedByCatalog = buildConfidence === 'fallback' && exactReviewedCatalog;

        const applyProfileTimingField = (
          field: 'cooldown_ms' | 'duration_ms',
          value: number | null,
        ): void => {
          if (value == null) return;
          const before = field === 'cooldown_ms' ? cooldownMs : durationMs;
          if (legacyBlockedByCatalog && before != null) {
            provenance.push({
              kind: 'validation',
              field,
              before,
              after: before,
              source: profile.source,
              description:
                value === before
                  ? 'Perfil legacy redundante: coincide con el catálogo exact-current revisado y se conserva solo como provenance; no degrada confidence.'
                  : `Perfil legacy ignorado por menor autoridad: propone ${value}, pero el catálogo exact-current revisado demuestra ${before}.`,
              gameBuild: profile.gameBuild,
            });
            return;
          }
          provenance.push({
            kind: 'spec_profile',
            field,
            before,
            after: value,
            source: profile.source,
            description: profile.sourceNote ?? `El perfil de spec sustituye ${field}.`,
            gameBuild: profile.gameBuild,
          });
          if (field === 'cooldown_ms') {
            cooldownMs = value;
            cooldownConfidence = profileConfidence;
          } else {
            durationMs = value;
            durationConfidence = profileConfidence;
          }
          confidence = weakerConfidence(confidence, profileConfidence);
        };

        applyProfileTimingField('cooldown_ms', profile.baseCooldownMs);
        applyProfileTimingField('duration_ms', profile.baseDurationMs);

        // Charges/recharge have no catalog-base columns. A legacy profile may
        // still provide them, but the availability claim remains fallback until
        // an exact profile or exact modifier proves the value.
        if (!(legacyBlockedByCatalog && profile.charges === charges)) {
          provenance.push({
            kind: 'spec_profile',
            field: 'charges',
            before: charges,
            after: profile.charges,
            source: profile.source,
            description: profile.sourceNote ?? 'Cargas base del perfil de spec.',
            gameBuild: profile.gameBuild,
          });
          charges = profile.charges;
          chargesConfidence = profileConfidence;
          confidence = weakerConfidence(confidence, profileConfidence);
        } else {
          provenance.push({
            kind: 'validation',
            field: 'charges',
            before: charges,
            after: charges,
            source: profile.source,
            description: 'Perfil legacy redundante de una carga: no degrada la confidence de otros campos.',
            gameBuild: profile.gameBuild,
          });
        }
        if (profile.rechargeMs != null) {
          provenance.push({
            kind: 'spec_profile',
            field: 'recharge_ms',
            before: rechargeMs,
            after: profile.rechargeMs,
            source: profile.source,
            description: profile.sourceNote ?? 'Recarga base del perfil de spec.',
            gameBuild: profile.gameBuild,
          });
          rechargeMs = profile.rechargeMs;
          rechargeConfidence = profileConfidence;
          confidence = weakerConfidence(confidence, profileConfidence);
        }
      }

      const targetRules = data.modifierRules.filter(
        (rule) =>
          rule.active &&
          rule.className === input.className &&
          rule.targetSpellId === entry.spellId,
      );
      const candidateRules = targetRules.filter(
        (rule) => rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName)),
      );
      const talentSelectedCandidateRules = candidateRules.filter((rule) => (rule.presenceMode ?? 'talent_selected') === 'talent_selected');
      if (input.specName == null && targetRules.some((rule) => rule.specNames != null)) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'validation',
          field: 'cooldown_ms',
          before: cooldownMs,
          after: cooldownMs,
          description: 'Hay reglas limitadas por spec, pero la spec del jugador es desconocida; no se aplican.',
        });
      }
      if (talentSelectedCandidateRules.length && normalizedBuild == null) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'validation',
          field: 'cooldown_ms',
          before: cooldownMs,
          after: cooldownMs,
          description: 'Existen reglas de talento para este defensivo, pero falta el build; no se aplica ninguna.',
        });
      } else if (talentSelectedCandidateRules.length && unresolvedSelectedNodes) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'validation',
          field: 'cooldown_ms',
          before: cooldownMs,
          after: cooldownMs,
          description: 'El build contiene nodos sin spellId; una regla de talento podría no haberse resuelto.',
        });
      }

      // Se elige la versión antes de filtrar por spec. Si una regla exacta
      // cambió de specs, esa ausencia exacta debe ganar sobre una fila legacy
      // más permisiva; de lo contrario una patch nueva heredaría reglas viejas.
      const applicableRules = rulesForBuild(targetRules, input.gameBuild)
        .filter(({ rule }) => rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName)))
        .filter(({ rule }) => (rule.presenceMode ?? 'talent_selected') === 'spec_baseline' || ranks.has(rule.modifierSpellId))
        .sort(
          (a, b) =>
            a.rule.applicationOrder - b.rule.applicationOrder ||
            OPERATION_ORDER[a.rule.operation] - OPERATION_ORDER[b.rule.operation] ||
            a.rule.id.localeCompare(b.rule.id),
        );

      const conflictingSetRuleIds = new Set<string>();
      const setsByFieldAndOrder = new Map<string, { id: string; value: number }[]>();
      for (const { rule } of applicableRules) {
        if (rule.condition !== 'always' || rule.operation !== 'set_ms') continue;
        const key = `${rule.effectField}:${rule.applicationOrder}`;
        const rows = setsByFieldAndOrder.get(key) ?? [];
        rows.push({ id: rule.id, value: ruleValue(rule, ranks.get(rule.modifierSpellId) ?? 0) });
        setsByFieldAndOrder.set(key, rows);
      }
      for (const rows of setsByFieldAndOrder.values()) {
        if (new Set(rows.map((row) => row.value)).size <= 1) continue;
        for (const row of rows) conflictingSetRuleIds.add(row.id);
      }

      const readField = (field: DefensiveEffectField): number | null => {
        if (field === 'cooldown_ms') return cooldownMs;
        if (field === 'duration_ms') return durationMs;
        if (field === 'charges') return charges;
        return rechargeMs ?? cooldownMs;
      };
      const writeField = (field: DefensiveEffectField, value: number): void => {
        if (field === 'cooldown_ms') cooldownMs = value;
        else if (field === 'duration_ms') durationMs = value;
        else if (field === 'charges') charges = value;
        else rechargeMs = value;
      };

      for (const { rule, buildConfidence } of applicableRules) {
        const rank = (rule.presenceMode ?? 'talent_selected') === 'spec_baseline' ? 1 : (ranks.get(rule.modifierSpellId) ?? 0);
        const amount = ruleValue(rule, rank);
        const before = readField(rule.effectField);
        const stepBase: Omit<ResolutionStep, 'kind' | 'after'> = {
          field: rule.effectField,
          before,
          operation: rule.operation,
          source: rule.source,
          description: `${rule.description}${rule.perRank ? ` (rango ${rank})` : ''}`,
          gameBuild: rule.gameBuild,
          ruleId: rule.id,
        };

        if (rule.condition === 'conditional') {
          conditionalModifiers.push({ ...stepBase, kind: 'conditional_modifier', after: before });
          continue;
        }
        confidence = weakerConfidence(confidence, buildConfidence === 'verified' ? gameBuildConfidence : buildConfidence);

        if (conflictingSetRuleIds.has(rule.id)) {
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({
            ...stepBase,
            kind: 'validation',
            after: before,
            description: `Reglas set_ms incompatibles para ${rule.effectField}; no se inventa un orden.`,
          });
          continue;
        }
        if (!Number.isFinite(amount) || amount < 0 || (rule.operation === 'charges_add' && !Number.isInteger(amount))) {
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({ ...stepBase, kind: 'validation', after: before, description: 'Valor de regla inválido; no se aplica.' });
          continue;
        }

        let after: number | null = before;
        if (rule.operation === 'set_ms') after = Math.round(amount);
        else if (rule.operation === 'charges_add') after = (before ?? 0) + amount;
        else if (before != null && rule.operation === 'multiply') after = Math.round(before * amount);
        else if (before != null && rule.operation === 'add_ms') after = Math.round(before + amount);
        else if (before != null && rule.operation === 'subtract_ms') after = Math.round(before - amount);

        if (after == null || !Number.isFinite(after) || after < 0 || (rule.effectField === 'charges' && (!Number.isInteger(after) || after < 1))) {
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({ ...stepBase, kind: 'validation', after: before, description: 'La regla produciría un valor inválido; no se aplica.' });
          continue;
        }
        writeField(rule.effectField, after);
        const modifierConfidence = buildConfidence === 'verified' ? gameBuildConfidence : buildConfidence;
        const combineFieldConfidence = (current: DefensiveResolutionConfidence): DefensiveResolutionConfidence =>
          rule.operation === 'set_ms' ? modifierConfidence : weakerConfidence(current, modifierConfidence);
        if (rule.effectField === 'cooldown_ms') cooldownConfidence = combineFieldConfidence(cooldownConfidence);
        else if (rule.effectField === 'duration_ms') durationConfidence = combineFieldConfidence(durationConfidence);
        else if (rule.effectField === 'charges') chargesConfidence = combineFieldConfidence(chargesConfidence);
        else rechargeConfidence = combineFieldConfidence(rechargeConfidence);
        provenance.push({ ...stepBase, kind: 'modifier', after });
      }

      const override = matchingOverride(data.overrides ?? [], input, entry.spellId);
      if (override) {
        confidence = weakerConfidence(confidence, override.buildFingerprint == null ? 'inferred' : 'verified');
        const applyOverride = (field: DefensiveEffectField, value: number | null): void => {
          if (value == null) return;
          const before = readField(field);
          writeField(field, value);
          const overrideConfidence: DefensiveResolutionConfidence = override.buildFingerprint == null ? 'inferred' : 'verified';
          if (field === 'cooldown_ms') cooldownConfidence = overrideConfidence;
          else if (field === 'duration_ms') durationConfidence = overrideConfidence;
          else if (field === 'charges') chargesConfidence = overrideConfidence;
          else rechargeConfidence = overrideConfidence;
          provenance.push({
            kind: 'player_override',
            field,
            before,
            after: value,
            source: `override:${override.id}`,
            description: override.reason,
            gameBuild: override.gameBuild,
          });
        };
        applyOverride('cooldown_ms', override.effectiveCooldownMs);
        applyOverride('duration_ms', override.effectiveDurationMs);
        applyOverride('charges', override.charges);
        if (override.targetingMode != null) {
          const before = targetingMode;
          targetingMode = override.targetingMode;
          provenance.push({
            kind: 'player_override',
            field: 'targeting_mode',
            before,
            after: targetingMode,
            source: `override:${override.id}`,
            description: override.reason,
            gameBuild: override.gameBuild,
          });
        }
      }

      if (charges > 1 && rechargeMs == null && cooldownMs != null) {
        rechargeMs = cooldownMs;
        rechargeConfidence = weakerConfidence(cooldownConfidence, chargesConfidence);
        provenance.push({
          kind: 'validation',
          field: 'recharge_ms',
          before: null,
          after: rechargeMs,
          description: 'Sin recarga específica: se usa el cooldown efectivo como recarga por carga.',
        });
      }

      if (!nonNegativeInteger(cooldownMs) && cooldownMs != null) confidence = weakerConfidence(confidence, 'uncertain');
      if (!nonNegativeInteger(durationMs) && durationMs != null) confidence = weakerConfidence(confidence, 'uncertain');
      if (!positiveInteger(charges)) confidence = weakerConfidence(confidence, 'uncertain');
      if (!nonNegativeInteger(rechargeMs) && rechargeMs != null) confidence = weakerConfidence(confidence, 'uncertain');

      // ---- Paso C: resolución semántica ----
      // Ortogonal a la resolución de timing de arriba (§2.2 del plan): decide
      // qué SIGNIFICA este defensivo para el KPI, no cuánto dura/cuándo está
      // disponible. Solo se ejecuta si el consumer cargó `data.semantics`
      // (analyze/reanalyze antiguos, que no pasan esa fuente, siguen
      // recibiendo exactamente el mismo ResolvedDefensive de siempre más
      // estos campos en sus valores neutros — nunca rompe una llamada
      // existente).
      const semanticResolved = data.semantics != null;
      const semanticBase = data.semantics?.find(
        (row) => row.spellId === entry.spellId && row.className === input.className,
      ) ?? null;
      let usageRole: DefensiveUsageRole = semanticBase?.usageRole ?? 'unknown';
      let activationScope: DefensiveActivationScope = semanticBase?.activationScope ?? 'unknown';
      let primaryBeneficiary: DefensivePrimaryBeneficiary = semanticBase?.primaryBeneficiary ?? 'unknown';
      let secondaryPropagation: DefensiveSecondaryPropagation = semanticBase?.secondaryPropagation ?? 'none';
      let mechanisms: DefensiveMechanism[] = semanticBase?.mechanisms ?? [];
      let opportunityMode: DefensiveOpportunityMode = semanticBase?.opportunityMode ?? 'none';
      let defensiveIntent: DefensiveIntent = semanticBase?.defensiveIntent ?? 'unknown';
      const semanticStatus: DefensiveSemanticStatus = semanticBase?.semanticStatus ?? 'pending';
      const semanticConfidence: DefensiveResolutionConfidence = semanticBase?.semanticConfidence ?? 'uncertain';
      const semanticProvenance: SemanticResolutionStep[] = [];
      let applicability: DamageApplicability | null = semanticBase?.applicability ?? null;
      let applicabilityConfidence: 'high' | 'medium' | 'low' | null = semanticBase?.applicabilityConfidence ?? null;
      // §E1: 'unresolved' cuando no hay nada que evaluar todavía (llamada
      // legacy timing-only) o cuando la fila sigue pending; 'resolved' es el
      // punto de partida optimista una vez hay una fila verified/rejected —
      // cualquier problema real encontrado más abajo solo puede EMPEORARLO
      // (worseStatus), nunca mejorarlo.
      let resolutionStatus: DefensiveEffectiveResolutionStatus = !semanticResolved || semanticStatus === 'pending' ? 'unresolved' : 'resolved';
      let semanticsConflict = false;

      if (semanticBase) {
        semanticProvenance.push({
          kind: 'catalog_base',
          description: `usageRole=${usageRole} (semantic_status=${semanticStatus}) desde defensive_ability_semantics.`,
        });
        if (semanticBase.applicabilityError) {
          semanticProvenance.push({
            kind: 'applicability_invalid',
            description: `applicability corrupta en defensive_ability_semantics: ${semanticBase.applicabilityError} — se descarta, no se adivina.`,
          });
        }
      } else if (semanticResolved) {
        semanticProvenance.push({
          kind: 'no_match',
          description: 'Sin fila en defensive_ability_semantics para este spellId/clase — nunca clasificado; queda pending, no penaliza.',
        });
      }

      // §E1 §6/§7: specSemanticProfile exacto ANTES de las reglas estáticas —
      // solo profile.spec === playerSpec, validado previamente por
      // parseSpecSemanticProfiles (nunca un cast directo del jsonb). Un
      // perfil que reclama la spec del jugador pero es inválido bloquea la
      // certeza (conflict) en vez de aplicar silenciosamente la fila base
      // como si el override no existiera.
      if (semanticBase && input.specName != null) {
        const matchedProfile = semanticBase.specSemanticProfiles.find((profile) => profile.spec === input.specName);
        const matchedInvalid = semanticBase.invalidSpecSemanticProfiles.find((invalid) => invalid.spec === input.specName);
        if (matchedProfile) {
          usageRole = matchedProfile.usageRole;
          defensiveIntent = matchedProfile.defensiveIntent;
          activationScope = matchedProfile.activationScope;
          primaryBeneficiary = matchedProfile.primaryBeneficiary;
          secondaryPropagation = matchedProfile.secondaryPropagation;
          mechanisms = [...matchedProfile.mechanisms];
          opportunityMode = matchedProfile.opportunityMode;
          if (matchedProfile.applicability) {
            applicability = matchedProfile.applicability;
            applicabilityConfidence = matchedProfile.confidence;
          }
          semanticProvenance.push({
            kind: 'spec_profile_applied',
            description: `Override semántico por spec (${input.specName}) desde specSemanticProfiles: usageRole=${usageRole}.`,
            source: matchedProfile.source,
          });
        } else if (matchedInvalid) {
          semanticsConflict = true;
          semanticProvenance.push({
            kind: 'spec_profile_invalid',
            description: `specSemanticProfiles trae un override para ${input.specName} pero es inválido (${matchedInvalid.error}) — se conserva la fila base sin adivinar el override; resolutionStatus=conflict.`,
          });
        }
      }

      if (semanticResolved) {
        // §E1 §8: solo son candidatas a AUTOMÁTICAS las reglas EXACTAS de
        // este game_build — a diferencia de los modifierRules de timing (más
        // arriba), las reglas semánticas NO tienen fallback legacy-current:
        // "wrong game build → nunca modifica" (invariante 16). Orden por id
        // (§6 cierre: nunca depender del orden de filas de Postgres).
        const buildMatchedRules = (data.semanticRules ?? [])
          .filter(
            (rule) =>
              rule.targetSpellId === entry.spellId &&
              (rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName))) &&
              rule.gameBuild === input.gameBuild &&
              ranks.has(rule.modifierSpellId),
          )
          .sort((a, b) => a.id.localeCompare(b.id));

        const automaticAugments: { rule: EffectiveDefensiveSemanticRule; payload: ReturnType<typeof parseAugmentRulePayload>['value'] & object }[] = [];

        for (const rule of buildMatchedRules) {
          // §E1 §8/§16: verified=false JAMÁS cambia nada, para NINGÚN
          // rule_type — el resolver original solo comprobaba esto para
          // 'augment'; suppress/replace/convert_to_passive se aplicaban sin
          // comprobar verified. Bug real corregido aquí.
          if (!rule.verified) {
            semanticProvenance.push({
              kind: 'semantic_rule_unverified',
              description: `Regla semántica sin verificar (spellId ${rule.modifierSpellId}, rule_type=${rule.ruleType}) — no se aplica automáticamente, queda como evidencia.`,
              source: rule.source,
              ruleId: rule.id,
            });
            continue;
          }

          if (rule.ruleType === 'suppress' || rule.ruleType === 'replace' || rule.ruleType === 'convert_to_passive') {
            const parsed = parseReplacementRulePayload(rule.payload);
            if (!parsed.value) {
              resolutionStatus = worseStatus(resolutionStatus, 'unresolved');
              semanticProvenance.push({
                kind: 'semantic_rule_invalid_payload',
                description: `payload inválido para regla ${rule.ruleType} (spellId ${rule.modifierSpellId}): ${parsed.error} — no se aplica, queda como dato pendiente de saneamiento.`,
                source: rule.source,
                ruleId: rule.id,
              });
              continue;
            }
            if (!AUTOMATIC_SEMANTIC_RULE_CONDITIONS.has(parsed.value.condition)) {
              unresolvedRuntimeRules.push({
                ruleId: rule.id,
                condition: parsed.value.condition,
                reason: `Regla ${rule.ruleType} condicionada a "${parsed.value.condition}" — no se aplica sobre el build estático (§9); requiere una fuente de evidencia runtime que todavía no existe.`,
              });
              semanticProvenance.push({
                kind: 'semantic_rule_runtime_unresolved',
                description: `Regla ${rule.ruleType} (spellId ${rule.modifierSpellId}) diferida: condition="${parsed.value.condition}" no es estática.`,
                source: rule.source,
                ruleId: rule.id,
              });
              continue;
            }
            if (rule.ruleType === 'suppress') {
              eligible = false;
              semanticProvenance.push({
                kind: 'semantic_rule_suppress',
                description: `Suprimido por talento seleccionado (spellId ${rule.modifierSpellId}).`,
                source: rule.source,
                ruleId: rule.id,
              });
              continue;
            }
            if (rule.ruleType === 'convert_to_passive') {
              activationMode = 'passive';
              eligible = false;
              semanticProvenance.push({
                kind: 'semantic_rule_convert_to_passive',
                description: `Convertido en pasivo por talento seleccionado (spellId ${rule.modifierSpellId}).`,
                source: rule.source,
                ruleId: rule.id,
              });
              continue;
            }
            // replace — el efectivo real pasa a ser replacementSpellId (otra
            // fila del catálogo, si existe y se puede resolver). §E1 §12:
            // original+replacement nunca representan dos oportunidades
            // independientes — el original SIEMPRE queda eligible=false aquí,
            // exista o no el sustituto; si el sustituto no se puede resolver
            // en el catálogo de esta clase, no se inventa un recurso — queda
            // unresolved y visible como gate de calidad de dataset.
            eligible = false;
            const replacementSpellId = parsed.value.replacementSpellId;
            const replacementResolved =
              replacementSpellId != null &&
              data.catalog.some((candidate) => candidate.spellId === replacementSpellId && candidate.className === input.className && !candidate.excluded);
            if (replacementSpellId != null && !replacementResolved) {
              resolutionStatus = worseStatus(resolutionStatus, 'unresolved');
              semanticProvenance.push({
                kind: 'semantic_rule_replace_unresolved',
                description: `Reemplazado por talento seleccionado (spellId ${rule.modifierSpellId}), pero el sustituto (spellId ${replacementSpellId}) no existe en el catálogo de ${input.className} — el original queda reemplazado (no missable), el sustituto queda unresolved; no se inventa un recurso.`,
                source: rule.source,
                ruleId: rule.id,
              });
            } else {
              semanticProvenance.push({
                kind: 'semantic_rule_replace',
                description: `Reemplazado por talento seleccionado (spellId ${rule.modifierSpellId})${replacementSpellId != null ? `; sustituto spellId ${replacementSpellId}` : ''}.`,
                source: rule.source,
                ruleId: rule.id,
              });
            }
            continue;
          }

          // augment
          const parsed = parseAugmentRulePayload(rule.payload);
          if (!parsed.value) {
            resolutionStatus = worseStatus(resolutionStatus, 'unresolved');
            semanticProvenance.push({
              kind: 'semantic_rule_invalid_payload',
              description: `payload inválido para regla augment (spellId ${rule.modifierSpellId}): ${parsed.error} — no se aplica, queda como dato pendiente de saneamiento.`,
              source: rule.source,
              ruleId: rule.id,
            });
            continue;
          }
          if (!AUTOMATIC_SEMANTIC_RULE_CONDITIONS.has(parsed.value.condition)) {
            unresolvedRuntimeRules.push({
              ruleId: rule.id,
              condition: parsed.value.condition,
              reason: `Regla augment condicionada a "${parsed.value.condition}" — no se aplica sobre el build estático (§9); requiere una fuente de evidencia runtime que todavía no existe.`,
            });
            semanticProvenance.push({
              kind: 'semantic_rule_runtime_unresolved',
              description: `Regla augment (spellId ${rule.modifierSpellId}) diferida: condition="${parsed.value.condition}" no es estática.`,
              source: rule.source,
              ruleId: rule.id,
            });
            continue;
          }
          automaticAugments.push({ rule, payload: parsed.value });
        }

        // §E1 §6/§11: TODAS las reglas automáticas se combinan en un único
        // paso orden-independiente — se recogen las propuestas por campo y
        // solo se aplican cuando coinciden; un desacuerdo es conflict, nunca
        // "la última que llegó gana".
        if (automaticAugments.length) {
          const usageRoleResolved = resolveScalarConflict(
            automaticAugments.filter((entry) => entry.payload.setUsageRole != null).map((entry) => ({ value: entry.payload.setUsageRole!, ruleId: entry.rule.id })),
          );
          const defensiveIntentResolved = resolveScalarConflict(
            automaticAugments.filter((entry) => entry.payload.setDefensiveIntent != null).map((entry) => ({ value: entry.payload.setDefensiveIntent!, ruleId: entry.rule.id })),
          );
          const opportunityModeResolved = resolveScalarConflict(
            automaticAugments.filter((entry) => entry.payload.setOpportunityMode != null).map((entry) => ({ value: entry.payload.setOpportunityMode!, ruleId: entry.rule.id })),
          );
          const primaryBeneficiaryResolved = resolveScalarConflict(
            automaticAugments.filter((entry) => entry.payload.setPrimaryBeneficiary != null).map((entry) => ({ value: entry.payload.setPrimaryBeneficiary!, ruleId: entry.rule.id })),
          );
          const secondaryPropagationResolved = resolveScalarConflict(
            automaticAugments.filter((entry) => entry.payload.setSecondaryPropagation != null).map((entry) => ({ value: entry.payload.setSecondaryPropagation!, ruleId: entry.rule.id })),
          );
          for (const [label, resolved, apply] of [
            ['setUsageRole', usageRoleResolved, (v: DefensiveUsageRole) => (usageRole = v)],
            ['setDefensiveIntent', defensiveIntentResolved, (v: DefensiveIntent) => (defensiveIntent = v)],
            ['setOpportunityMode', opportunityModeResolved, (v: DefensiveOpportunityMode) => (opportunityMode = v)],
            ['setPrimaryBeneficiary', primaryBeneficiaryResolved, (v: DefensivePrimaryBeneficiary) => (primaryBeneficiary = v)],
            ['setSecondaryPropagation', secondaryPropagationResolved, (v: DefensiveSecondaryPropagation) => (secondaryPropagation = v)],
          ] as const) {
            if (resolved.conflict) {
              semanticsConflict = true;
              semanticProvenance.push({
                kind: 'semantic_rule_conflict',
                description: `Reglas automáticas incompatibles para ${label}: reglas ${resolved.ruleIds.join(', ')} proponen valores distintos — no se elige una por orden arbitrario, resolutionStatus=conflict.`,
              });
            } else if (resolved.value !== undefined) {
              (apply as (v: string) => void)(resolved.value as string);
            }
          }

          const allAdds = new Set<DefensiveMechanism>();
          const allRemoves = new Set<DefensiveMechanism>();
          for (const { payload } of automaticAugments) {
            payload.addMechanisms.forEach((m) => allAdds.add(m));
            payload.removeMechanisms.forEach((m) => allRemoves.add(m));
          }
          const contradictory = [...allAdds].filter((m) => allRemoves.has(m));
          if (contradictory.length) {
            semanticsConflict = true;
            semanticProvenance.push({
              kind: 'semantic_rule_conflict',
              description: `Reglas automáticas contradictorias sobre mechanisms sin precedencia demostrada: ${contradictory.join(', ')} — esos mechanisms se conservan sin cambio; resolutionStatus=conflict.`,
            });
          }
          const safeAdds = [...allAdds].filter((m) => !contradictory.includes(m));
          const safeRemoves = [...allRemoves].filter((m) => !contradictory.includes(m));
          if (safeAdds.length || safeRemoves.length) {
            mechanisms = [...new Set([...mechanisms.filter((m) => !safeRemoves.includes(m)), ...safeAdds])];
          }

          // applicabilityPatch: mismo tratamiento orden-independiente por
          // campo, luego un único mergeApplicability() determinista. Los
          // valores que llegan aquí ya pasaron parseAugmentRulePayload
          // (validación estricta) — esta recombinación es entre datos YA
          // VALIDADOS, no el cast directo de jsonb crudo que prohíbe §5.
          const patchProposals = automaticAugments.filter((entry) => entry.payload.applicabilityPatch != null);
          if (patchProposals.length) {
            const patchFieldNames = [
              'schoolScope',
              'schools',
              'deliveryScopes',
              'requiresDodgeable',
              'requiresParryable',
              'requiresBlockable',
              'requiresSourceAffectedBySpell',
              'timingRelation',
            ] as const;
            const mergedPatchFields: Record<string, unknown> = {};
            let patchConflict = false;
            for (const field of patchFieldNames) {
              const proposals = patchProposals
                .map((entry) => ({ value: entry.payload.applicabilityPatch![field], ruleId: entry.rule.id }))
                .filter((proposal) => (Array.isArray(proposal.value) ? proposal.value.length > 0 : proposal.value != null));
              const resolved = resolveScalarConflict(proposals);
              if (resolved.conflict) {
                patchConflict = true;
                semanticProvenance.push({
                  kind: 'semantic_rule_conflict',
                  description: `Reglas automáticas incompatibles en applicabilityPatch.${field}: reglas ${resolved.ruleIds.join(', ')} — resolutionStatus=conflict.`,
                });
                continue;
              }
              if (resolved.value !== undefined) mergedPatchFields[field] = resolved.value;
            }
            if (patchConflict) semanticsConflict = true;
            if (Object.keys(mergedPatchFields).length) {
              const patch: DamageApplicability = {
                schoolScope: null,
                schools: null,
                deliveryScopes: null,
                requiresDodgeable: null,
                requiresParryable: null,
                requiresBlockable: null,
                requiresSourceAffectedBySpell: null,
                timingRelation: null,
                ...mergedPatchFields,
              } as DamageApplicability;
              const nextApplicability = mergeApplicability(applicability, patch);
              if (nextApplicability) {
                applicability = nextApplicability;
                semanticProvenance.push({
                  kind: 'applicability_patch_applied',
                  description: 'applicabilityPatch de reglas automáticas fusionada de forma determinista sobre la applicability efectiva.',
                });
              }
            }
          }

          for (const { rule, payload } of automaticAugments) {
            semanticProvenance.push({
              kind: 'semantic_rule_augment',
              description: `Semántica modificada por talento seleccionado (spellId ${rule.modifierSpellId}): ${payload.modifierName ?? 'talento'}.`,
              source: rule.source,
              ruleId: rule.id,
            });
          }
        }
      }

      const semanticInput: DefensiveSemanticInput = {
        usageRole,
        activationScope,
        primaryBeneficiary,
        secondaryPropagation,
        mechanisms,
        opportunityMode,
      };

      // §E1 §14: validación final DESPUÉS de spec-profile + reglas — una fila
      // base válida no garantiza que la combinación final lo sea. Corre
      // incluso sin overrides (pending/no-match ya son válidos por
      // construcción con sus defaults neutros, así que esto nunca penaliza
      // esos casos — solo detecta corrupción real introducida por overrides).
      if (semanticResolved) {
        const finalError = defensiveSemanticError(semanticInput);
        if (finalError) {
          resolutionStatus = worseStatus(resolutionStatus, 'conflict');
          semanticProvenance.push({
            kind: 'final_validation_conflict',
            description: `La combinación final de campos semánticos es inválida: ${finalError} — resolutionStatus=conflict, no member, no missable.`,
          });
        }
      }
      if (semanticsConflict) resolutionStatus = worseStatus(resolutionStatus, 'conflict');

      // eligible/buildPresence/resolutionStatus cruzados explícitamente
      // (invariante 1 del plan + especificación E1 §3/§16): un
      // personal_survival semánticamente perfecto que no está seleccionado en
      // ESTE build, cuya presencia no se puede demostrar, o cuya combinación
      // final es contradictoria, no es parte del kit real de este pull.
      const semanticsTrustworthy = resolutionStatus !== 'conflict';
      const isKitMember =
        semanticResolved && eligible && buildPresence === 'present' && semanticsTrustworthy && isDefensiveKitMember(semanticStatus, activationMode, semanticInput);
      const createsMissable =
        semanticResolved &&
        eligible &&
        buildPresence === 'present' &&
        semanticsTrustworthy &&
        createsMissableOpportunity(semanticStatus, activationMode, semanticInput);

      return {
        spellId: entry.spellId,
        name: entry.name,
        className: entry.className,
        specName: input.specName,
        category: entry.category,
        survivalType: entry.survivalType,
        targetingMode,
        activationMode,
        effectiveCooldownMs: cooldownMs,
        effectiveDurationMs: durationMs,
        charges,
        rechargeMs,
        cooldownConfidence,
        durationConfidence,
        chargesConfidence,
        rechargeConfidence,
        eligible,
        buildFingerprint: input.buildFingerprint,
        gameBuild: input.gameBuild,
        resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
        confidence,
        provenance,
        conditionalModifiers,
        semanticResolved,
        usageRole,
        activationScope,
        primaryBeneficiary,
        secondaryPropagation,
        mechanisms,
        opportunityMode,
        defensiveIntent,
        semanticStatus,
        semanticVersion: semanticBase?.semanticVersion ?? null,
        semanticConfidence,
        semanticResolverVersion: EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION,
        semanticProvenance,
        buildPresence,
        buildPresenceReason,
        buildPresenceConfidence,
        buildPresenceEvidence,
        applicability,
        applicabilityConfidence,
        resolutionStatus,
        unresolvedRuntimeRules,
        isDefensiveKitMember: isKitMember,
        createsMissableOpportunity: createsMissable,
      };
    })
    .sort((a, b) => a.spellId - b.spellId);
}

// ---------------------------------------------------------------------------
// §E2.5 "Acquisition Safety Closure" — activación de
// demonstratedPersistentCastSpellIds como prueba positiva de presencia.
//
// Deliberadamente puro (sin Deno/Supabase): el caller (resolve-player-
// defensive-kit) hace UNA primera resolución sin evidencia de cast (para
// obtener activationMode/unresolvedRuntimeRules por spellId — el "persistent
// ability guard"), llama a esta función con los casts crudos ya clasificados
// same-pull / cross-pull, y usa el resultado como
// input.demonstratedPersistentCastSpellIds en una SEGUNDA resolución. El
// resolver en sí nunca decide "same pull" vs "same fingerprint" — eso lo
// decide el caller aquí, con datos que el resolver puro no tiene (pull_id,
// fingerprints de otros pulls).
// ---------------------------------------------------------------------------

/** UN cast observado de un spellId candidato, ya clasificado por el caller — nunca datos crudos de WCL sin procesar. */
export interface ObservedCastForEvidence {
  spellId: number;
  /** true = el cast pertenece al MISMO pull que se está resolviendo ahora mismo. */
  samePull: boolean;
  /**
   * talent_build_fingerprint EXACTO del pull de origen de este cast —
   * null si ese pull nunca se fingerprintó. Un fingerprint null NUNCA es
   * evidencia válida (§E2.5: "Do not use null-fingerprint historical pulls
   * as build-level proof") — se compara por igualdad estricta de string
   * contra currentBuildFingerprint, nunca se asume "probablemente el mismo
   * build" por cercanía temporal ni por ausencia de dato.
   */
  pullTalentBuildFingerprint: string | null;
}

/**
 * "Persistent ability guard" (§E2.5): un spellId solo puede entrar al mapa
 * de evidencia si, en la resolución SIN evidencia de cast (`firstPassKit`),
 * su fila es una activación manual real y estática — nunca:
 *  - activationMode !== 'active' (pasivas/autocast — nunca se pulsan),
 *  - unresolvedRuntimeRules no vacío (variantes runtime_state/other/
 *    passive_selected, o un reemplazo entrante condicionado a runtime — ver
 *    ambos puntos de push en resolveEffectiveDefensiveKit).
 * No hay lista de spellIds hardcodeada en ningún punto de esta función — el
 * guard se deriva enteramente de campos que el resolver YA calculó.
 */
function passesPersistentAbilityGuard(entry: Pick<ResolvedDefensive, 'activationMode' | 'unresolvedRuntimeRules'>): boolean {
  return entry.activationMode === 'active' && entry.unresolvedRuntimeRules.length === 0;
}

/**
 * Produce el mapa validado de evidencia de cast persistente para pasar como
 * `ResolveDefensiveKitInput.demonstratedPersistentCastSpellIds` en una
 * segunda resolución. Reglas de alcance (§E2.5), aplicadas aquí y solo aquí:
 *  - same-pull siempre es válido (evidencia más fuerte, gana si coexiste con
 *    cross-pull para el mismo spellId);
 *  - cross-pull solo es válido si AMBOS fingerprints (el del pull actual y
 *    el del pull de origen del cast) son no nulos y coinciden exactamente —
 *    nunca se propaga evidencia entre fingerprints distintos, nunca se usa
 *    un pull sin fingerprintar como prueba de build;
 *  - el guard de arriba se aplica ANTES de aceptar cualquier evidencia,
 *    same-pull o cross-pull por igual.
 */
export function computeDemonstratedPersistentCastSpellIds(
  observedCasts: readonly ObservedCastForEvidence[],
  currentBuildFingerprint: string | null,
  firstPassKit: readonly ResolvedDefensive[],
): Map<number, 'observed_cast_same_pull' | 'observed_cast_same_build_fingerprint'> {
  const result = new Map<number, 'observed_cast_same_pull' | 'observed_cast_same_build_fingerprint'>();
  const kitBySpellId = new Map(firstPassKit.map((entry) => [entry.spellId, entry]));

  for (const cast of observedCasts) {
    if (result.get(cast.spellId) === 'observed_cast_same_pull') continue; // ya tiene la evidencia más fuerte posible para este spellId

    const entry = kitBySpellId.get(cast.spellId);
    if (!entry || !passesPersistentAbilityGuard(entry)) continue;

    if (cast.samePull) {
      result.set(cast.spellId, 'observed_cast_same_pull');
      continue;
    }
    if (currentBuildFingerprint != null && cast.pullTalentBuildFingerprint != null && cast.pullTalentBuildFingerprint === currentBuildFingerprint) {
      result.set(cast.spellId, 'observed_cast_same_build_fingerprint');
    }
  }

  return result;
}
