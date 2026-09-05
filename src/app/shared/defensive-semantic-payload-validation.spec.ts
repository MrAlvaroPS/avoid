import { describe, expect, it } from 'vitest';
import {
  mergeApplicability,
  parseAugmentRulePayload,
  parseDamageApplicability,
  parseReplacementRulePayload,
  parseSpecSemanticProfileEntry,
  parseSpecSemanticProfiles,
} from '../../../supabase/functions/_shared/defensive-semantic-payload-validation';
import type { DamageApplicability } from '../../../supabase/functions/_shared/defensive-applicability';

describe('parseDamageApplicability', () => {
  it('accepts null/undefined as "no data" — never an error', () => {
    expect(parseDamageApplicability(null)).toEqual({ value: null, error: null });
    expect(parseDamageApplicability(undefined)).toEqual({ value: null, error: null });
  });

  it('accepts a well-formed object with every field present', () => {
    const result = parseDamageApplicability({
      schoolScope: 'physical',
      schools: [],
      deliveryScopes: ['aoe'],
      requiresDodgeable: true,
      requiresParryable: null,
      requiresBlockable: false,
      requiresSourceAffectedBySpell: null,
      timingRelation: 'before_or_during',
      notes: 'informativo, no forma parte del contrato tipado',
    });
    expect(result.error).toBeNull();
    expect(result.value).toMatchObject({ schoolScope: 'physical', deliveryScopes: ['aoe'], requiresDodgeable: true, timingRelation: 'before_or_during' });
  });

  it('rejects a real-world corruption: an unexpected key masquerading as requiresDodgeable (Avatar/Protection, Supabase 2026-09-04)', () => {
    // Corrupción real encontrada: un fragmento de markdown-link truncado se
    // fusionó con el nombre de la clave `requiresDodgeable`. Sigue siendo
    // JSON válido — la clave real requiresDodgeable NUNCA aparece.
    const corruptedKey =
      'requiresDodgeable](https://www.wowhead.com/spell=107574/avatar%22,%22confidence%22:%22high%22},{%22spec%22:%22Protection%22,%22usageRole%22:%22hybrid_survival%22,%22requiresDodgeable)';
    const result = parseDamageApplicability({
      schoolScope: 'all',
      schools: [],
      deliveryScopes: ['all'],
      timingRelation: 'before_or_during',
      requiresBlockable: null,
      requiresParryable: null,
      requiresSourceAffectedBySpell: null,
      [corruptedKey]: null,
    });
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/no reconocida/);
  });

  it('rejects an invalid enum value instead of silently coercing it', () => {
    expect(parseDamageApplicability({ schoolScope: 'not-a-real-scope' }).value).toBeNull();
    expect(parseDamageApplicability({ timingRelation: 'sometimes' }).value).toBeNull();
  });

  it('rejects a non-boolean requiresX field', () => {
    expect(parseDamageApplicability({ requiresDodgeable: 'yes' }).value).toBeNull();
  });

  // §E1 audit fix (2026-09-04): schools[]/deliveryScopes[] solo se
  // validaban como string[] genérico — un typo pasaba como válido y se
  // comportaba como "sin restricción demostrada" en canDefensiveCover(),
  // fail-open de facto. Cada miembro debe pertenecer al enum real.
  it('a typo in deliveryScopes (e.g. "spel" instead of "spell") fails closed instead of silently becoming unrestricted applicability', () => {
    const result = parseDamageApplicability({ deliveryScopes: ['spel'] });
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/no reconocido/);
  });

  it('a typo in schools (e.g. "Frots" instead of "Frost") fails closed', () => {
    const result = parseDamageApplicability({ schools: ['Frots'] });
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/no reconocido/);
  });

  it('accepts every documented schools/deliveryScopes value, including the "all" escape hatch', () => {
    expect(parseDamageApplicability({ schools: ['Physical', 'Holy', 'Fire', 'Nature', 'Frost', 'Shadow', 'Arcane'] }).error).toBeNull();
    expect(
      parseDamageApplicability({
        deliveryScopes: ['all', 'aoe', 'single_target', 'melee', 'ranged', 'spell', 'environmental', 'direct', 'periodic'],
      }).error,
    ).toBeNull();
  });

  it('an empty array is still valid (distinct from a typo — [] never fails closed)', () => {
    expect(parseDamageApplicability({ schools: [], deliveryScopes: [] }).error).toBeNull();
  });

  it('a value that is not a WoW school (e.g. "Chaos", present in the prompt vocabulary but not in the canonical WowSchool contract) is rejected', () => {
    expect(parseDamageApplicability({ schools: ['Chaos'] }).value).toBeNull();
  });
});

describe('mergeApplicability', () => {
  const base: DamageApplicability = {
    schoolScope: 'physical',
    schools: ['Physical'],
    deliveryScopes: ['melee'],
    requiresDodgeable: true,
    requiresParryable: null,
    requiresBlockable: null,
    requiresSourceAffectedBySpell: null,
    timingRelation: 'before_or_during',
  };

  it('a null patch is a full no-op', () => {
    expect(mergeApplicability(base, null)).toBe(base);
  });

  it('scalar null/absent in the patch is a no-op — the base value survives', () => {
    const patch: DamageApplicability = { ...base, schoolScope: null, requiresDodgeable: null };
    const merged = mergeApplicability(base, patch);
    expect(merged?.schoolScope).toBe('physical');
    expect(merged?.requiresDodgeable).toBe(true);
  });

  it('scalar value (including false) overrides the base — false is a real value, not "unset"', () => {
    const patch: DamageApplicability = { ...base, requiresDodgeable: false };
    expect(mergeApplicability(base, patch)?.requiresDodgeable).toBe(false);
  });

  it('empty array [] in the patch is a no-op — v10 payloads use [] to mean "no change", not "clear the list"', () => {
    const patch: DamageApplicability = { ...base, schools: [], deliveryScopes: [] };
    const merged = mergeApplicability(base, patch);
    expect(merged?.schools).toEqual(['Physical']);
    expect(merged?.deliveryScopes).toEqual(['melee']);
  });

  it('a non-empty array overrides that whole dimension', () => {
    const patch: DamageApplicability = { ...base, deliveryScopes: ['aoe', 'ranged'] };
    expect(mergeApplicability(base, patch)?.deliveryScopes).toEqual(['aoe', 'ranged']);
  });

  it('merging onto a null base still produces a real object from the patch alone', () => {
    const patch: DamageApplicability = { ...base, schoolScope: 'magic' };
    const merged = mergeApplicability(null, patch);
    expect(merged?.schoolScope).toBe('magic');
    expect(merged?.deliveryScopes).toEqual(['melee']);
  });
});

describe('parseSpecSemanticProfiles', () => {
  const validArms = {
    spec: 'Arms',
    usageRole: 'hybrid_survival',
    defensiveIntent: 'hybrid',
    activationScope: 'self',
    primaryBeneficiary: 'self',
    secondaryPropagation: 'none',
    mechanisms: ['mitigation'],
    opportunityMode: 'credit_only',
    applicability: { schoolScope: 'all', schools: [], deliveryScopes: ['aoe'], timingRelation: 'before_or_during' },
    source: 'wowhead',
    confidence: 'high',
  };

  it('a single valid element parses cleanly', () => {
    const result = parseSpecSemanticProfileEntry(validArms);
    expect(result.error).toBeNull();
    expect(result.value?.spec).toBe('Arms');
    expect(result.value?.mechanisms).toEqual(['mitigation']);
  });

  it('rejects an unrecognized top-level key instead of accepting it silently', () => {
    const result = parseSpecSemanticProfileEntry({ ...validArms, unexpectedField: 'garbage' });
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/no reconocida/);
  });

  it('rejects an invalid enum for usageRole', () => {
    expect(parseSpecSemanticProfileEntry({ ...validArms, usageRole: 'not-a-role' }).value).toBeNull();
  });

  it('one corrupted element does not invalidate the others — element-by-element isolation (Avatar Arms vs. Protection, real data)', () => {
    const corruptedKey = 'requiresDodgeable](truncated-markdown-link';
    const protectionCorrupted = {
      ...validArms,
      spec: 'Protection',
      applicability: { schoolScope: 'all', schools: [], deliveryScopes: ['all'], timingRelation: 'before_or_during', [corruptedKey]: null },
    };
    const result = parseSpecSemanticProfiles([validArms, protectionCorrupted]);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].spec).toBe('Arms');
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].spec).toBe('Protection');
  });

  it('a typo inside a spec profile\'s nested applicability.deliveryScopes fails the whole profile closed, not just a warning', () => {
    const typoProfile = { ...validArms, applicability: { ...validArms.applicability, deliveryScopes: ['aoe', 'melle'] } };
    const result = parseSpecSemanticProfileEntry(typoProfile);
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/no reconocido/);
  });

  it('a non-array input never crashes — returns empty profiles plus an invalid entry', () => {
    const result = parseSpecSemanticProfiles({ not: 'an array' });
    expect(result.profiles).toEqual([]);
    expect(result.invalid).toHaveLength(1);
  });

  it('null/undefined means "no profiles" — not an error', () => {
    expect(parseSpecSemanticProfiles(null)).toEqual({ profiles: [], invalid: [] });
  });
});

describe('parseAugmentRulePayload', () => {
  it('parses the real Translucent Image payload shape (Fade, Supabase 2026-09-04)', () => {
    const result = parseAugmentRulePayload({
      modifierName: 'Translucent Image',
      condition: 'talent_selected',
      setUsageRole: 'hybrid_survival',
      setDefensiveIntent: 'hybrid',
      setOpportunityMode: 'credit_only',
      setPrimaryBeneficiary: 'self',
      setSecondaryPropagation: null,
      addMechanisms: ['mitigation'],
      removeMechanisms: [],
      applicabilityPatch: {
        schoolScope: 'all',
        schools: [],
        deliveryScopes: ['all'],
        timingRelation: 'before_or_during',
        requiresBlockable: false,
        requiresDodgeable: false,
        requiresParryable: false,
        requiresSourceAffectedBySpell: false,
      },
      notes: 'Añade 10% DR durante 8 s',
    });
    expect(result.error).toBeNull();
    expect(result.value?.condition).toBe('talent_selected');
    expect(result.value?.applicabilityPatch?.timingRelation).toBe('before_or_during');
  });

  it('rejects an unrecognized top-level key', () => {
    expect(parseAugmentRulePayload({ condition: 'talent_selected', notARealField: 1 }).value).toBeNull();
  });

  it('requires a valid condition — missing or unrecognized condition invalidates the whole payload', () => {
    expect(parseAugmentRulePayload({}).value).toBeNull();
    expect(parseAugmentRulePayload({ condition: 'sometimes' }).value).toBeNull();
  });

  it('accepts every documented condition value, including runtime_state/other (validity is separate from automatic-application eligibility)', () => {
    for (const condition of ['talent_selected', 'hero_talent_selected', 'passive_selected', 'runtime_state', 'other']) {
      expect(parseAugmentRulePayload({ condition }).error).toBeNull();
    }
  });
});

describe('parseReplacementRulePayload', () => {
  it('parses the real Ice Cold replacement payload shape', () => {
    const result = parseReplacementRulePayload({ triggerName: 'Ice Cold', replacementSpellId: 414658, condition: 'talent_selected', notes: '' });
    expect(result.error).toBeNull();
    expect(result.value?.replacementSpellId).toBe(414658);
  });

  it('rejects a non-positive-integer replacementSpellId', () => {
    expect(parseReplacementRulePayload({ condition: 'talent_selected', replacementSpellId: -1 }).value).toBeNull();
    expect(parseReplacementRulePayload({ condition: 'talent_selected', replacementSpellId: 1.5 }).value).toBeNull();
  });

  it('rejects an unrecognized top-level key', () => {
    expect(parseReplacementRulePayload({ condition: 'talent_selected', action: 'replace' }).value).toBeNull();
  });
});
