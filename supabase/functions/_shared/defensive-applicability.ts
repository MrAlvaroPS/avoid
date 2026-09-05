// §Paso C (iris-defensive-canonicalization-v1-plan.md §2.4/§28): separar
// "pertenece al kit" de "sirve contra ESTE episodio concreto". Evasion puede
// pertenecer al kit y no servir contra un hit no esquivable; AMS puede
// pertenecer al kit y no servir contra daño físico. La pertenencia ya la
// decide el resolver (effective-defensives.ts, isDefensiveKitMember); este
// módulo decide la aplicabilidad, con los datos que el prompt v10 de
// classify-defensives ya captura en defensive_ability_semantics.applicability
// (ver iris-defensive-canonicalization-v1-plan.md §8, migración
// 20260903160000).
//
// Invariante 5 del plan: un defensivo no aplicable nunca genera
// missed_ready. Por construcción: cualquier dato ausente/no determinado
// produce 'unknown', nunca 'no' ni 'yes' por omisión — y 'unknown' nunca
// puede convertirse en missed_ready aguas abajo (eso lo impone el evaluator
// de verdicts, no este módulo, pero este módulo es lo que le da el motivo
// exacto para no hacerlo).
//
// §Paso C-1 (2026-09-04, revisión real): `DamageDescriptor` deja de ser un
// contrato de un solo valor por dimensión — la clasificación real v10 (300
// filas ya en producción) demuestra que `deliveryScopes` es multi-tag desde
// SIEMPRE (una ability puede ser simultáneamente single_target+melee+direct,
// tres dimensiones ortogonales, no alternativas) y que `masterData.abilities.type`
// es un bitmask que puede representar varias schools a la vez (Holy+Fire,
// verificado en real). Este fichero se reescribe para reflejar eso —
// ver damage-descriptor-wcl.ts para la extracción real desde WCL.

export type ApplicabilityVerdict = 'yes' | 'no' | 'unknown';

// §E1 (Effective Defensive Semantics Closure, iris-defensive-canonicalization-v1-plan.md
// §5 Paso C): timingRelation ya lo escribe classify-defensives (prompt v10
// §10/§13/§26) y ya vive en defensive_ability_semantics.applicability — solo
// faltaba en este contrato TS. Deliberadamente NO se conecta todavía a
// canDefensiveCover() (compatibilidad de school/delivery sigue siendo la
// única fuente de canDefensiveCover) — solo viaja hasta ResolvedDefensive
// para que el Episode Evaluator sea su único consumidor temporal cuando
// decida compatibilidad de TIMING (antes/durante vs. tras el daño) por
// separado de compatibilidad de DAÑO.
export const TIMING_RELATIONS = ['before_or_during', 'after_damage', 'either', 'continuous_state', 'unknown'] as const;
export type TimingRelation = (typeof TIMING_RELATIONS)[number];

/** Forma exacta de defensive_ability_semantics.applicability (jsonb) — mismo schema que el prompt v10 de classify-defensives §10/§26. */
export interface DamageApplicability {
  schoolScope: 'all' | 'physical' | 'magic' | 'specific' | 'none' | 'unknown' | null;
  schools: string[] | null;
  deliveryScopes: string[] | null;
  requiresDodgeable: boolean | null;
  requiresParryable: boolean | null;
  requiresBlockable: boolean | null;
  requiresSourceAffectedBySpell: boolean | null;
  /** null = no determinado — nunca se adivina antes/durante vs. tras el daño. */
  timingRelation: TimingRelation | null;
}

export type WowSchool = 'Physical' | 'Holy' | 'Fire' | 'Nature' | 'Frost' | 'Shadow' | 'Arcane';
/** §E1 audit fix (2026-09-04): lista canónica para validación estricta de applicability.schools[] — ver defensive-semantic-payload-validation.ts. Debe seguir coincidiendo exactamente con el union type de arriba. */
export const WOW_SCHOOLS: readonly WowSchool[] = ['Physical', 'Holy', 'Fire', 'Nature', 'Frost', 'Shadow', 'Arcane'];

/**
 * Lo que se sabe REALMENTE del daño/mecánica de UN hit concreto (un evento
 * DamageTaken/DamageDone de WCL, o el hit dominante de un episodio). Todo
 * campo es `| null` = "no determinado" a propósito.
 *
 * §revisión 2026-09-04 (verificación empírica real contra WCL, ver
 * damage-descriptor-wcl.ts):
 * - `schools`/`schoolMask`: `masterData.abilities[].type` es un bitmask
 *   (verificado contra 2220 abilities reales) — una ability puede tener
 *   VARIAS schools a la vez (Holy+Fire, Fire+Nature...). Nunca se reduce a
 *   una sola — perder esa combinación fabricaría certeza donde hay
 *   ambigüedad real.
 * - `deliveryScopes`: multi-tag, tres dimensiones ORTOGONALES dentro del
 *   mismo array (target scope: aoe/single_target — delivery method:
 *   melee/ranged/spell/environmental — timing: direct/periodic). Dentro de
 *   cada grupo los valores son alternativas; entre grupos la condición es
 *   AND (ver groupDeliveryTags()/matchDeliveryScopes() más abajo).
 * - `dodgeable`/`parryable`/`blockable`: verificados empíricamente contra
 *   WCL real (filterExpression `missType`, cruzado contra el `hitType`
 *   numérico de los eventos crudos en varios fights reales) — hitType
 *   0=Miss, 1=Hit, 2=Crit, 4=Block, 7=Dodge, 8=Parry, 10=Immune. Solo se
 *   afirma `true` con evidencia positiva (observada en este pull o en el
 *   cache cross-pull, ver damage-descriptor-wcl.ts); la ausencia de
 *   observación nunca se convierte en `false`.
 * - `rawHitType`: se conserva SIEMPRE que el hit lo traiga, aunque el resto
 *   de campos queden sin determinar (evidencia/auditoría — "por qué IRIS
 *   decidió esto").
 */
export interface DamageDescriptor {
  /** Schools decodificadas del bitmask — puede tener más de una (Holy+Fire, etc.). null = no determinado. */
  schools: WowSchool[] | null;
  /** Bitmask crudo de masterData.abilities[].type, para auditoría — 1=Physical,2=Holy,4=Fire,8=Nature,16=Frost,32=Shadow,64=Arcane. */
  schoolMask: number | null;
  /** Tags demostrados para ESTE hit concreto — subconjunto de aoe/single_target/melee/ranged/spell/environmental/direct/periodic. Cada dimensión no demostrada simplemente no aporta ningún tag de su grupo (no se inventa). */
  deliveryScopes: string[] | null;
  dodgeable: boolean | null;
  parryable: boolean | null;
  blockable: boolean | null;
  /** Para requiresSourceAffectedBySpell (Fiery Brand-style): ¿el origen de este daño concreto está afectado por el spell del defensivo? */
  sourceAffectedBySpell: boolean | null;
  /** hitType crudo de WCL, cuando el hit lo trae — evidencia/auditoría, independiente de si se pudo decodificar dodgeable/parryable/blockable. */
  rawHitType: number | null;
}

export interface ApplicabilityResult {
  verdict: ApplicabilityVerdict;
  reason: string;
}

const UNKNOWN_LOW_CONFIDENCE: ApplicabilityResult = {
  verdict: 'unknown',
  reason: 'applicabilityConfidence no es alta/media, o no hay applicability capturada — nunca puede generar missed_ready (invariante 5 del plan).',
};

// --- School: subconjunto/sin-solape/parcial — nunca se pierde una combinación ---

const ALL_MAGIC_SCHOOLS: readonly WowSchool[] = ['Holy', 'Fire', 'Nature', 'Frost', 'Shadow', 'Arcane'];

/**
 * Compara las schools REALES del hit contra el conjunto que cubre el
 * defensivo. Trichotomía deliberada (§revisión 2026-09-04, pedido
 * explícito): solape TOTAL → yes; solape CERO → no; solape PARCIAL (un
 * hit híbrido Physical+Shadow contra un defensivo que solo cubre magia) →
 * unknown — la interacción real (¿protege la parte mágica? ¿nada si hay
 * algo de físico?) no se puede demostrar desde aquí, no se inventa.
 */
function schoolCoverageVerdict(allowed: ReadonlySet<WowSchool>, damageSchools: WowSchool[] | null, scopeLabel: string): ApplicabilityResult | null {
  if (!damageSchools || !damageSchools.length) {
    return { verdict: 'unknown', reason: `Solo cubre ${scopeLabel}, pero la school de este daño no está determinada.` };
  }
  const covered = damageSchools.filter((s) => allowed.has(s));
  if (covered.length === 0) {
    return { verdict: 'no', reason: `Solo cubre ${scopeLabel}; este episodio es ${damageSchools.join('+')}.` };
  }
  if (covered.length === damageSchools.length) {
    return null; // cobertura total — sigue con el resto de checks, no se corta aquí
  }
  return {
    verdict: 'unknown',
    reason: `Este episodio combina schools (${damageSchools.join('+')}) — solo ${covered.join('+')} está cubierta por este defensivo (${scopeLabel}); la interacción con el resto no se puede demostrar.`,
  };
}

// --- deliveryScopes: tres grupos ortogonales, OR dentro, AND entre grupos ---

const TARGET_SCOPE_TAGS = new Set(['aoe', 'single_target']);
const DELIVERY_METHOD_TAGS = new Set(['melee', 'ranged', 'spell', 'environmental']);
const TIMING_TAGS = new Set(['direct', 'periodic']);

/** §E1 audit fix (2026-09-04): lista canónica para validación estricta de applicability.deliveryScopes[] — 'all' (escape hatch global) + los tres grupos ortogonales de arriba. Derivada de ellos para que nunca puedan desincronizarse. */
export const DELIVERY_SCOPE_TAGS: readonly string[] = ['all', ...TARGET_SCOPE_TAGS, ...DELIVERY_METHOD_TAGS, ...TIMING_TAGS];

type DeliveryGroup = 'target_scope' | 'delivery_method' | 'timing';

function tagGroup(tag: string): DeliveryGroup | null {
  if (TARGET_SCOPE_TAGS.has(tag)) return 'target_scope';
  if (DELIVERY_METHOD_TAGS.has(tag)) return 'delivery_method';
  if (TIMING_TAGS.has(tag)) return 'timing';
  return null; // 'all' u otro valor no reconocido — no forma grupo, se ignora aquí (tratado aparte)
}

const GROUP_LABELS: Record<DeliveryGroup, string> = {
  target_scope: 'alcance (aoe/single_target)',
  delivery_method: 'método de entrega (melee/ranged/spell/environmental)',
  timing: 'timing (direct/periodic)',
};

/**
 * Agrupa los tags de applicability.deliveryScopes por dimensión ortogonal.
 * 'all' se trata aparte (escape hatch global, ver matchDeliveryScopes).
 */
function groupDeliveryTags(tags: string[]): Partial<Record<DeliveryGroup, Set<string>>> {
  const groups: Partial<Record<DeliveryGroup, Set<string>>> = {};
  for (const tag of tags) {
    const group = tagGroup(tag);
    if (!group) continue;
    (groups[group] ??= new Set()).add(tag);
  }
  return groups;
}

/**
 * AND entre grupos PRESENTES en applicability, OR dentro de cada grupo.
 * Un grupo que applicability no restringe (ausente de deliveryScopes) no
 * participa — no se inventa una restricción que la clasificación no puso.
 * Un grupo restringido cuyo hit no demuestra NINGÚN tag de esa dimensión
 * (damage.deliveryScopes no tiene ningún tag de ese grupo) → unknown para
 * ese grupo, salvo que el hit SÍ demuestre un tag de ese grupo que no esté
 * permitido (entonces es un 'no' inequívoco para ese grupo).
 */
function matchDeliveryScopes(applicabilityTags: string[], damageTags: string[] | null): ApplicabilityResult | null {
  if (applicabilityTags.includes('all')) return null; // sin restricción — sigue con el resto de checks
  const groups = groupDeliveryTags(applicabilityTags);
  const damageSet = new Set(damageTags ?? []);
  let anyUnknownGroup: DeliveryGroup | null = null;

  for (const group of Object.keys(groups) as DeliveryGroup[]) {
    const allowed = groups[group]!;
    const demonstratedInGroup = [...damageSet].filter((tag) => tagGroup(tag) === group);
    if (!demonstratedInGroup.length) {
      anyUnknownGroup = anyUnknownGroup ?? group;
      continue; // no demostrado para este grupo — no corta aquí, puede que otro grupo sí dé un 'no' definitivo
    }
    const overlaps = demonstratedInGroup.some((tag) => allowed.has(tag));
    if (!overlaps) {
      return {
        verdict: 'no',
        reason: `Solo cubre ${GROUP_LABELS[group]} = ${[...allowed].join('/')}; este episodio demuestra ${demonstratedInGroup.join('/')}.`,
      };
    }
  }

  if (anyUnknownGroup) {
    return {
      verdict: 'unknown',
      reason: `Restringe por ${GROUP_LABELS[anyUnknownGroup]}, pero ese dato no está demostrado para este episodio.`,
    };
  }
  return null; // todos los grupos restringidos tienen solape demostrado — sigue con el resto de checks
}

/**
 * `applicabilityConfidence` es el mismo campo que ya escribe classify-defensives
 * (high/medium/low) — 'low' o ausente degrada TODO a 'unknown' de entrada,
 * sin mirar el resto de campos: no tiene sentido confiar en un requiresX
 * concreto si la propia IA marcó la aplicabilidad como poco fiable.
 */
export function canDefensiveCover(
  applicability: DamageApplicability | null,
  applicabilityConfidence: 'high' | 'medium' | 'low' | null,
  damage: DamageDescriptor,
): ApplicabilityResult {
  if (!applicability || applicabilityConfidence === 'low' || applicabilityConfidence == null) {
    return UNKNOWN_LOW_CONFIDENCE;
  }

  if (applicability.schoolScope === 'none') {
    return { verdict: 'no', reason: 'Este defensivo no mitiga daño (schoolScope=none) — no aplica a ningún episodio de daño.' };
  }

  if (applicability.schoolScope === 'physical') {
    const result = schoolCoverageVerdict(new Set<WowSchool>(['Physical']), damage.schools, 'daño físico');
    if (result) return result;
  }
  if (applicability.schoolScope === 'magic') {
    const result = schoolCoverageVerdict(new Set(ALL_MAGIC_SCHOOLS), damage.schools, 'daño mágico');
    if (result) return result;
  }
  if (applicability.schoolScope === 'specific') {
    if (!applicability.schools?.length) {
      return { verdict: 'unknown', reason: 'schoolScope=specific sin lista de schools — dato incompleto, no se adivina.' };
    }
    const result = schoolCoverageVerdict(new Set(applicability.schools as WowSchool[]), damage.schools, applicability.schools.join('/'));
    if (result) return result;
  }

  if (applicability.deliveryScopes?.length) {
    const result = matchDeliveryScopes(applicability.deliveryScopes, damage.deliveryScopes);
    if (result) return result;
  }

  if (applicability.requiresDodgeable === true) {
    if (damage.dodgeable == null) return { verdict: 'unknown', reason: 'Exige daño esquivable, pero no se sabe si este episodio lo es.' };
    if (!damage.dodgeable) return { verdict: 'no', reason: 'Exige daño esquivable; este episodio no lo es.' };
  }
  if (applicability.requiresParryable === true) {
    if (damage.parryable == null) return { verdict: 'unknown', reason: 'Exige daño parryable, pero no se sabe si este episodio lo es.' };
    if (!damage.parryable) return { verdict: 'no', reason: 'Exige daño parryable; este episodio no lo es.' };
  }
  if (applicability.requiresBlockable === true) {
    if (damage.blockable == null) return { verdict: 'unknown', reason: 'Exige daño bloqueable, pero no se sabe si este episodio lo es.' };
    if (!damage.blockable) return { verdict: 'no', reason: 'Exige daño bloqueable; este episodio no lo es.' };
  }
  if (applicability.requiresSourceAffectedBySpell === true) {
    if (damage.sourceAffectedBySpell == null) {
      return { verdict: 'unknown', reason: 'Exige que el origen del daño esté afectado por el spell (ej. Fiery Brand) — no se puede demostrar para este episodio.' };
    }
    if (!damage.sourceAffectedBySpell) {
      return { verdict: 'no', reason: 'Exige que el origen del daño esté afectado por el spell; no lo está en este episodio.' };
    }
  }

  return { verdict: 'yes', reason: 'Aplicabilidad demostrada: ninguna restricción conocida excluye este episodio.' };
}

/**
 * §E4 (Episode Evaluator, "damage applicability must be episode-safe"):
 * combina el veredicto de canDefensiveCover() de VARIOS hits reales del
 * mismo episodio (en vez de un único "hit representativo" arbitrario) de
 * forma deliberadamente conservadora — nunca convierte evidencia
 * parcial/mixta en 'yes'. Incertidumbre falsa es aceptable en shadow; un
 * `missed_ready` falso no lo es.
 *
 *  - todos 'yes' → 'yes' (cobertura demostrada para cada hit relevante).
 *  - todos 'no' → 'no' (ninguno cubierto).
 *  - cualquier mezcla, o cero hits evaluables → 'unknown'.
 */
export function combineHitApplicability(verdicts: readonly ApplicabilityVerdict[]): ApplicabilityVerdict {
  if (!verdicts.length) return 'unknown';
  if (verdicts.every((v) => v === 'yes')) return 'yes';
  if (verdicts.every((v) => v === 'no')) return 'no';
  return 'unknown';
}
