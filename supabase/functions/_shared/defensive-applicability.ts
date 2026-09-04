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

export type ApplicabilityVerdict = 'yes' | 'no' | 'unknown';

/** Forma exacta de defensive_ability_semantics.applicability (jsonb) — mismo schema que el prompt v10 de classify-defensives §10/§26. */
export interface DamageApplicability {
  schoolScope: 'all' | 'physical' | 'magic' | 'specific' | 'none' | 'unknown' | null;
  schools: string[] | null;
  deliveryScopes: string[] | null;
  requiresDodgeable: boolean | null;
  requiresParryable: boolean | null;
  requiresBlockable: boolean | null;
  requiresSourceAffectedBySpell: boolean | null;
}

/**
 * Lo que se sabe REALMENTE del daño/mecánica de un episodio concreto. Todo
 * campo es `| null` = "no determinado" a propósito — no existe todavía una
 * fuente real que rellene esto desde WCL (la extracción de school/
 * deliveryScope por evento es trabajo aparte, ver registro de avance); con
 * todos los campos en null, canDefensiveCover() ya degrada correctamente a
 * 'unknown' en cuanto el defensivo tenga alguna restricción real.
 */
export interface DamageDescriptor {
  school: 'Physical' | 'Holy' | 'Fire' | 'Nature' | 'Frost' | 'Shadow' | 'Arcane' | 'Chaos' | null;
  deliveryScope: 'aoe' | 'single_target' | 'melee' | 'ranged' | 'spell' | 'direct' | 'periodic' | 'environmental' | null;
  dodgeable: boolean | null;
  parryable: boolean | null;
  blockable: boolean | null;
  /** Para requiresSourceAffectedBySpell (Fiery Brand-style): ¿el origen de este daño concreto está afectado por el spell del defensivo? */
  sourceAffectedBySpell: boolean | null;
}

export interface ApplicabilityResult {
  verdict: ApplicabilityVerdict;
  reason: string;
}

const UNKNOWN_LOW_CONFIDENCE: ApplicabilityResult = {
  verdict: 'unknown',
  reason: 'applicabilityConfidence no es alta/media, o no hay applicability capturada — nunca puede generar missed_ready (invariante 5 del plan).',
};

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

  if (applicability.schoolScope === 'physical' || applicability.schoolScope === 'magic') {
    if (damage.school == null) {
      return { verdict: 'unknown', reason: `Solo cubre daño ${applicability.schoolScope === 'physical' ? 'físico' : 'mágico'}, pero la school de este daño no está determinada.` };
    }
    const isPhysical = damage.school === 'Physical';
    if (applicability.schoolScope === 'physical' && !isPhysical) {
      return { verdict: 'no', reason: `Solo cubre daño físico; este episodio es ${damage.school}.` };
    }
    if (applicability.schoolScope === 'magic' && isPhysical) {
      return { verdict: 'no', reason: 'Solo cubre daño mágico; este episodio es físico.' };
    }
  }

  if (applicability.schoolScope === 'specific') {
    if (damage.school == null) {
      return { verdict: 'unknown', reason: `Solo cubre ${applicability.schools?.join('/') ?? 'schools concretas'}, pero la school de este daño no está determinada.` };
    }
    if (!applicability.schools?.length) {
      return { verdict: 'unknown', reason: 'schoolScope=specific sin lista de schools — dato incompleto, no se adivina.' };
    }
    if (!applicability.schools.includes(damage.school)) {
      return { verdict: 'no', reason: `Solo cubre ${applicability.schools.join('/')}; este episodio es ${damage.school}.` };
    }
  }

  if (applicability.deliveryScopes?.length && !applicability.deliveryScopes.includes('all')) {
    if (damage.deliveryScope == null) {
      return { verdict: 'unknown', reason: `Solo cubre ${applicability.deliveryScopes.join('/')}, pero el tipo de entrega de este daño no está determinado.` };
    }
    if (!applicability.deliveryScopes.includes(damage.deliveryScope)) {
      return { verdict: 'no', reason: `Solo cubre ${applicability.deliveryScopes.join('/')}; este episodio es ${damage.deliveryScope}.` };
    }
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
