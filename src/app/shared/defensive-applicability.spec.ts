import { describe, expect, it } from 'vitest';
import {
  canDefensiveCover,
  type DamageApplicability,
  type DamageDescriptor,
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
    school: null,
    deliveryScope: null,
    dodgeable: null,
    parryable: null,
    blockable: null,
    sourceAffectedBySpell: null,
    ...overrides,
  };
}

describe('canDefensiveCover', () => {
  it('degrades to unknown when applicability is missing entirely — never fabricates a verdict', () => {
    expect(canDefensiveCover(null, 'high', damage())).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
  });

  it('degrades to unknown when applicabilityConfidence is low or absent, regardless of how specific applicability looks', () => {
    const strict = applicability({ schoolScope: 'physical' });
    expect(canDefensiveCover(strict, 'low', damage({ school: 'Fire' }))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
    expect(canDefensiveCover(strict, null, damage({ school: 'Fire' }))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
  });

  it('Barkskin-style broad mitigation (schoolScope=all) covers everything with high confidence', () => {
    expect(canDefensiveCover(applicability(), 'high', damage({ school: 'Shadow' }))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
  });

  it('AMS-style magic-only absorb does not cover physical damage (Wargreymon case from the plan)', () => {
    const ams = applicability({ schoolScope: 'magic' });
    expect(canDefensiveCover(ams, 'high', damage({ school: 'Physical' }))).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
    expect(canDefensiveCover(ams, 'high', damage({ school: 'Frost' }))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
  });

  it('schoolScope=magic|physical returns unknown when the damage school itself is not determined', () => {
    expect(canDefensiveCover(applicability({ schoolScope: 'magic' }), 'high', damage({ school: null }))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
  });

  it('schoolScope=specific only covers the listed schools', () => {
    const specific = applicability({ schoolScope: 'specific', schools: ['Fire', 'Shadow'] });
    expect(canDefensiveCover(specific, 'high', damage({ school: 'Fire' }))).toEqual(expect.objectContaining({ verdict: 'yes' }));
    expect(canDefensiveCover(specific, 'high', damage({ school: 'Frost' }))).toEqual(expect.objectContaining({ verdict: 'no' }));
  });

  it('schoolScope=none never covers anything (this "defensive" does not actually mitigate damage)', () => {
    expect(canDefensiveCover(applicability({ schoolScope: 'none' }), 'high', damage())).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
  });

  it('Evasion-style requiresDodgeable: false when the damage is confirmed non-dodgeable, unknown when undetermined (Rivax case from the plan)', () => {
    const evasion = applicability({ schoolScope: 'physical', requiresDodgeable: true });
    expect(canDefensiveCover(evasion, 'high', damage({ school: 'Physical', dodgeable: false }))).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
    expect(canDefensiveCover(evasion, 'high', damage({ school: 'Physical', dodgeable: null }))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
    expect(canDefensiveCover(evasion, 'high', damage({ school: 'Physical', dodgeable: true }))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
  });

  it('Fiery Brand-style requiresSourceAffectedBySpell gates on the source, not just the school', () => {
    const fieryBrand = applicability({ schoolScope: 'physical', requiresSourceAffectedBySpell: true });
    expect(canDefensiveCover(fieryBrand, 'high', damage({ school: 'Physical', sourceAffectedBySpell: false }))).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
    expect(canDefensiveCover(fieryBrand, 'high', damage({ school: 'Physical', sourceAffectedBySpell: true }))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
  });

  it('deliveryScopes restrict coverage when the list does not include "all"', () => {
    const meleeOnly = applicability({ deliveryScopes: ['melee'] });
    expect(canDefensiveCover(meleeOnly, 'high', damage({ deliveryScope: 'ranged' }))).toEqual(
      expect.objectContaining({ verdict: 'no' }),
    );
    expect(canDefensiveCover(meleeOnly, 'high', damage({ deliveryScope: 'melee' }))).toEqual(
      expect.objectContaining({ verdict: 'yes' }),
    );
    expect(canDefensiveCover(meleeOnly, 'high', damage({ deliveryScope: null }))).toEqual(
      expect.objectContaining({ verdict: 'unknown' }),
    );
  });

  it('medium confidence is still usable (only low/absent degrades to unknown outright)', () => {
    expect(canDefensiveCover(applicability(), 'medium', damage())).toEqual(expect.objectContaining({ verdict: 'yes' }));
  });
});
