import { describe, expect, it } from 'vitest';
import {
  canDefensiveCover,
  type DamageApplicability,
  type DamageDescriptor,
  type WowSchool,
} from '../../../supabase/functions/_shared/defensive-applicability';

function applicability(overrides: Partial<DamageApplicability> = {}): DamageApplicability {
  return {
    schoolScope: 'all',
    schools: null,
    deliveryScopes: ['all'],
    requiresDodgeable: null,
    requiresParryable: null,
    requiresBlockable: null,
    requiresSourceAffectedBySpell: null,
    ...overrides,
  };
}

function damage(overrides: Partial<DamageDescriptor> = {}): DamageDescriptor {
  return {
    schools: null,
    schoolMask: null,
    deliveryScopes: null,
    dodgeable: null,
    parryable: null,
    blockable: null,
    sourceAffectedBySpell: null,
    rawHitType: null,
    ...overrides,
  };
}

function school(...schools: WowSchool[]): Partial<DamageDescriptor> {
  return { schools };
}

describe('canDefensiveCover', () => {
  it('degrades to unknown when applicability is missing entirely — never fabricates a verdict', () => {
    expect(canDefensiveCover(null, 'high', damage())).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
  });

  it('degrades to unknown when applicabilityConfidence is low or absent, regardless of how specific applicability looks', () => {
    const strict = applicability({ schoolScope: 'physical' });
    expect(canDefensiveCover(strict, 'low', damage(school('Fire')))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
    expect(canDefensiveCover(strict, null, damage(school('Fire')))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
  });

  it('Barkskin-style broad mitigation (schoolScope=all) covers everything with high confidence', () => {
    expect(canDefensiveCover(applicability(), 'high', damage(school('Shadow')))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
  });

  it('AMS-style magic-only absorb does not cover physical damage (Wargreymon case from the plan)', () => {
    const ams = applicability({ schoolScope: 'magic' });
    expect(canDefensiveCover(ams, 'high', damage(school('Physical')))).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
    expect(canDefensiveCover(ams, 'high', damage(school('Frost')))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
  });

  it('schoolScope=magic|physical returns unknown when the damage school itself is not determined', () => {
    expect(canDefensiveCover(applicability({ schoolScope: 'magic' }), 'high', damage())).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
  });

  it('schoolScope=specific only covers the listed schools', () => {
    const specific = applicability({ schoolScope: 'specific', schools: ['Fire', 'Shadow'] });
    expect(canDefensiveCover(specific, 'high', damage(school('Fire')))).toEqual(expect.objectContaining({ verdict: 'yes' }));
    expect(canDefensiveCover(specific, 'high', damage(school('Frost')))).toEqual(expect.objectContaining({ verdict: 'no' }));
  });

  it('schoolScope=none never covers anything (this "defensive" does not actually mitigate damage)', () => {
    expect(canDefensiveCover(applicability({ schoolScope: 'none' }), 'high', damage())).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
  });

  // §revisión 2026-09-04: masterData.abilities.type es un bitmask real — un
  // hit puede combinar varias schools (verificado: "Wake of Ashes"=Holy+Fire
  // en datos reales). La interacción con un schoolScope restringido no
  // siempre es demostrable — trichotomía yes/no/unknown, nunca se inventa.
  describe('schools[] combinadas — nunca se pierde la combinación (revisión 2026-09-04)', () => {
    it('solape total: schoolScope=magic cubre un hit Fire+Shadow (ambas mágicas) → yes', () => {
      const ams = applicability({ schoolScope: 'magic' });
      expect(canDefensiveCover(ams, 'high', damage(school('Fire', 'Shadow')))).toEqual(
        expect.objectContaining({ verdict: 'yes' }),
      );
    });

    it('sin solape: schoolScope=magic contra Physical puro → no', () => {
      const ams = applicability({ schoolScope: 'magic' });
      expect(canDefensiveCover(ams, 'high', damage(school('Physical')))).toEqual(
        expect.objectContaining({ verdict: 'no' }),
      );
    });

    it('solape PARCIAL: schoolScope=magic contra un hit híbrido Physical+Shadow → unknown, no yes ni no (la interacción real no se puede demostrar)', () => {
      const ams = applicability({ schoolScope: 'magic' });
      const result = canDefensiveCover(ams, 'high', damage(school('Physical', 'Shadow')));
      expect(result.verdict).toBe('unknown');
      expect(result.verdict).not.toBe('yes');
      expect(result.verdict).not.toBe('no');
    });

    it('schoolScope=specific con solape parcial (Fire+Shadow permitidos, hit es Fire+Frost) → unknown', () => {
      const specific = applicability({ schoolScope: 'specific', schools: ['Fire', 'Shadow'] });
      const result = canDefensiveCover(specific, 'high', damage(school('Fire', 'Frost')));
      expect(result.verdict).toBe('unknown');
    });

    it('schoolScope=specific con solape total exacto → yes', () => {
      const specific = applicability({ schoolScope: 'specific', schools: ['Fire', 'Shadow'] });
      expect(canDefensiveCover(specific, 'high', damage(school('Fire', 'Shadow')))).toEqual(
        expect.objectContaining({ verdict: 'yes' }),
      );
    });
  });

  it('Evasion-style requiresDodgeable: false when the damage is confirmed non-dodgeable, unknown when undetermined (Rivax case from the plan)', () => {
    const evasion = applicability({ schoolScope: 'physical', requiresDodgeable: true });
    expect(canDefensiveCover(evasion, 'high', damage({ ...school('Physical'), dodgeable: false }))).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
    expect(canDefensiveCover(evasion, 'high', damage({ ...school('Physical'), dodgeable: null }))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
    expect(canDefensiveCover(evasion, 'high', damage({ ...school('Physical'), dodgeable: true }))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
  });

  it('parryable y blockable son dimensiones independientes de dodgeable — nunca se fusionan (pedido explícito 2026-09-04)', () => {
    const parryOnly = applicability({ requiresParryable: true });
    // dodgeable=false (demostrado NO esquivable) no dice nada sobre parryable — sigue unknown si parryable no está determinado.
    expect(canDefensiveCover(parryOnly, 'high', damage({ dodgeable: false, parryable: null }))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
    expect(canDefensiveCover(parryOnly, 'high', damage({ dodgeable: false, parryable: true }))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );

    const blockOnly = applicability({ requiresBlockable: true });
    expect(canDefensiveCover(blockOnly, 'high', damage({ dodgeable: true, parryable: true, blockable: null }))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
  });

  it('Fiery Brand-style requiresSourceAffectedBySpell gates on the source, not just the school', () => {
    const fieryBrand = applicability({ schoolScope: 'physical', requiresSourceAffectedBySpell: true });
    expect(canDefensiveCover(fieryBrand, 'high', damage({ ...school('Physical'), sourceAffectedBySpell: false }))).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
    expect(canDefensiveCover(fieryBrand, 'high', damage({ ...school('Physical'), sourceAffectedBySpell: true }))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
  });

  // §revisión 2026-09-04: deliveryScopes es multi-tag desde SIEMPRE en los
  // datos reales (300 filas clasificadas) — tres dimensiones ortogonales
  // (target scope / delivery method / timing), OR dentro del grupo, AND
  // entre grupos PRESENTES. No es un array plano con semántica OR global.
  describe('deliveryScopes agrupado por dimensión ortogonal (pedido explícito 2026-09-04)', () => {
    it('un solo grupo restringido (delivery method=melee): coincide si el hit demuestra melee, no si demuestra ranged', () => {
      const meleeOnly = applicability({ deliveryScopes: ['melee'] });
      expect(canDefensiveCover(meleeOnly, 'high', damage({ deliveryScopes: ['ranged'] }))).toEqual(
        expect.objectContaining({ verdict: 'no' }),
      );
      expect(canDefensiveCover(meleeOnly, 'high', damage({ deliveryScopes: ['melee'] }))).toEqual(
        expect.objectContaining({ verdict: 'yes' }),
      );
      expect(canDefensiveCover(meleeOnly, 'high', damage({ deliveryScopes: null }))).toEqual(
        expect.objectContaining({ verdict: 'unknown' }),
      );
    });

    it('AND entre grupos: Adjudication-style [melee,direct] exige AMBOS — single_target+melee+periodic falla por timing aunque el método coincida', () => {
      const meleeDirect = applicability({ deliveryScopes: ['melee', 'direct'] });
      // Coincide en method (melee) pero el hit demuestra periodic, no direct → no.
      expect(canDefensiveCover(meleeDirect, 'high', damage({ deliveryScopes: ['melee', 'periodic'] }))).toEqual(
        expect.objectContaining({ verdict: 'no' }),
      );
      // Coincide en ambos grupos restringidos → yes, independientemente de target_scope (grupo no restringido, no participa).
      expect(canDefensiveCover(meleeDirect, 'high', damage({ deliveryScopes: ['single_target', 'melee', 'direct'] }))).toEqual(
        expect.objectContaining({ verdict: 'yes' }),
      );
    });

    it('Cauterize-style con los 7 tags explícitos (todo menos "all") equivale a sin restricción real', () => {
      const allSeven = applicability({ deliveryScopes: ['aoe', 'single_target', 'melee', 'ranged', 'spell', 'direct', 'periodic'] });
      expect(canDefensiveCover(allSeven, 'high', damage({ deliveryScopes: ['single_target', 'spell', 'direct'] }))).toEqual(
        expect.objectContaining({ verdict: 'yes' }),
      );
    });

    it('Feint-style (aoe) — grupo target_scope restringido, no demostrado en el hit → unknown, no "no"', () => {
      const feint = applicability({ schoolScope: 'all', deliveryScopes: ['aoe'] });
      expect(canDefensiveCover(feint, 'high', damage({ deliveryScopes: null }))).toEqual(
        expect.objectContaining({ verdict: 'unknown' }),
      );
      expect(canDefensiveCover(feint, 'high', damage({ deliveryScopes: ['aoe'] }))).toEqual(
        expect.objectContaining({ verdict: 'yes' }),
      );
      expect(canDefensiveCover(feint, 'high', damage({ deliveryScopes: ['single_target'] }))).toEqual(
        expect.objectContaining({ verdict: 'no' }),
      );
    });

    it('"all" en deliveryScopes es un escape hatch global — nunca restringe ningún grupo', () => {
      const unrestricted = applicability({ deliveryScopes: ['all'] });
      expect(canDefensiveCover(unrestricted, 'high', damage({ deliveryScopes: null }))).toEqual(
        expect.objectContaining({ verdict: 'yes' }),
      );
    });
  });

  it('medium confidence is still usable (only low/absent degrades to unknown outright)', () => {
    expect(canDefensiveCover(applicability(), 'medium', damage())).toEqual(expect.objectContaining({ verdict: 'yes' }));
  });

  it('rawHitType se ignora para la decisión (es solo evidencia/auditoría) — no cambia el veredicto por sí solo', () => {
    const evasion = applicability({ requiresDodgeable: true });
    const withRawHitType = canDefensiveCover(evasion, 'high', damage({ dodgeable: null, rawHitType: 7 }));
    const withoutRawHitType = canDefensiveCover(evasion, 'high', damage({ dodgeable: null, rawHitType: null }));
    expect(withRawHitType.verdict).toBe(withoutRawHitType.verdict);
  });
});
