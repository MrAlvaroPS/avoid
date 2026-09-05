import { describe, expect, it } from 'vitest';
import {
  createsMissableOpportunity,
  defensiveSemanticError,
  defensiveTargetingError,
  deriveLegacyClassification,
  deriveLegacySurvivalType,
  DEFENSIVE_USAGE_ROLES,
  isDefensiveKitMember,
  type DefensiveSemanticInput,
} from '../../../supabase/functions/_shared/defensive-classification-semantics';

describe('defensive classification semantics', () => {
  it('accepts an unresolved external target without discarding the classified category', () => {
    expect(defensiveTargetingError('external_defensive', 'unknown')).toBeNull();
  });

  it('keeps strict personal and semi targeting invariants', () => {
    expect(defensiveTargetingError('personal_defensive', 'ally')).toContain('self');
    expect(defensiveTargetingError('semi_defensive', 'self')).toContain('both');
  });

  it('rejects unsupported category and target values', () => {
    expect(defensiveTargetingError('invented', 'self')).toContain('category');
    expect(defensiveTargetingError('utility', 'invented')).toContain('targetingMode');
  });
});

describe('defensive semantic contract (canonicalization v1, prompt v10)', () => {
  const barkskin: DefensiveSemanticInput = {
    usageRole: 'personal_survival',
    activationScope: 'self',
    primaryBeneficiary: 'self',
    secondaryPropagation: 'none',
    mechanisms: ['mitigation'],
    opportunityMode: 'normal',
  };

  it('accepts a real personal defensive like Barkskin', () => {
    expect(defensiveSemanticError(barkskin)).toBeNull();
  });

  it('accepts AMS-style automatic ally propagation without turning it into an ally target', () => {
    const ams: DefensiveSemanticInput = { ...barkskin, mechanisms: ['absorption'], secondaryPropagation: 'automatic_ally' };
    expect(defensiveSemanticError(ams)).toBeNull();
  });

  it('accepts Fiery Brand-style personal_survival cast at an enemy: activationScope != self is fine as long as primaryBeneficiary is self', () => {
    const fieryBrand: DefensiveSemanticInput = { ...barkskin, activationScope: 'enemy', mechanisms: ['mitigation'] };
    expect(defensiveSemanticError(fieryBrand)).toBeNull();
    expect(isDefensiveKitMember('verified', 'active', fieryBrand)).toBe(true);
    expect(createsMissableOpportunity('verified', 'active', fieryBrand)).toBe(true);
  });

  it('rejects survival_state/hybrid_survival with anything other than credit_only', () => {
    const bearForm: DefensiveSemanticInput = { ...barkskin, usageRole: 'survival_state' };
    expect(defensiveSemanticError(bearForm)).toContain('credit_only');
    const hybrid: DefensiveSemanticInput = { ...barkskin, usageRole: 'hybrid_survival', opportunityMode: 'none' };
    expect(defensiveSemanticError(hybrid)).toContain('credit_only');
  });

  it('rejects opportunityMode normal on a usageRole outside the explicit none/credit_only buckets too (the catch-all rule)', () => {
    const unknownRole: DefensiveSemanticInput = { ...barkskin, usageRole: 'unknown', opportunityMode: 'normal' };
    expect(defensiveSemanticError(unknownRole)).toContain('opportunityMode normal exige');
  });

  it('rejects opportunityMode normal on the explicit none-opportunity roles too (rule fires either way)', () => {
    const rotational: DefensiveSemanticInput = {
      ...barkskin,
      usageRole: 'rotational_survival',
      primaryBeneficiary: 'self',
      opportunityMode: 'normal',
    };
    expect(defensiveSemanticError(rotational)).toContain('opportunityMode none');
  });

  it('rejects the none-opportunity roles (active_mitigation, external, ...) with anything other than none', () => {
    const shieldOfTheRighteous: DefensiveSemanticInput = {
      ...barkskin,
      usageRole: 'active_mitigation',
      opportunityMode: 'credit_only',
    };
    expect(defensiveSemanticError(shieldOfTheRighteous)).toContain('active_mitigation exige opportunityMode none');
  });

  it('rejects personal_survival/survival_state/hybrid_survival when primaryBeneficiary is not self, regardless of activationScope', () => {
    const notSelf: DefensiveSemanticInput = { ...barkskin, primaryBeneficiary: 'self_or_ally_selectable' };
    expect(defensiveSemanticError(notSelf)).toContain('primaryBeneficiary self');
  });

  it('rejects unknown enum values, including the new ones (primaryBeneficiary, lethal_prevention)', () => {
    expect(defensiveSemanticError({ ...barkskin, usageRole: 'invented' })).toContain('usageRole');
    expect(defensiveSemanticError({ ...barkskin, mechanisms: ['invented'] })).toContain('mechanisms');
    expect(defensiveSemanticError({ ...barkskin, primaryBeneficiary: 'invented' })).toContain('primaryBeneficiary');
  });

  it('accepts lethal_prevention as a valid mechanism (Divine Shield / Ice Block style)', () => {
    expect(defensiveSemanticError({ ...barkskin, mechanisms: ['immunity', 'lethal_prevention'] })).toBeNull();
  });

  it('membership: Barkskin (verified, active) counts and can miss; Bear Form (survival_state) counts but never misses', () => {
    const bearForm: DefensiveSemanticInput = {
      ...barkskin,
      usageRole: 'survival_state',
      opportunityMode: 'credit_only',
    };
    expect(isDefensiveKitMember('verified', 'active', barkskin)).toBe(true);
    expect(createsMissableOpportunity('verified', 'active', barkskin)).toBe(true);
    expect(isDefensiveKitMember('verified', 'active', bearForm)).toBe(true);
    expect(createsMissableOpportunity('verified', 'active', bearForm)).toBe(false);
  });

  it('membership: hybrid_survival counts like survival_state but never misses', () => {
    const hybrid: DefensiveSemanticInput = { ...barkskin, usageRole: 'hybrid_survival', opportunityMode: 'credit_only' };
    expect(isDefensiveKitMember('verified', 'active', hybrid)).toBe(true);
    expect(createsMissableOpportunity('verified', 'active', hybrid)).toBe(false);
  });

  it('membership: pending never counts, regardless of the rest of the row', () => {
    expect(isDefensiveKitMember('pending', 'active', barkskin)).toBe(false);
    expect(createsMissableOpportunity('pending', 'active', barkskin)).toBe(false);
  });

  it('membership: Death Strike-style rotational_survival (self-beneficiary, but not personal_survival) never counts as personal kit', () => {
    const deathStrike: DefensiveSemanticInput = {
      usageRole: 'rotational_survival',
      activationScope: 'enemy',
      primaryBeneficiary: 'self',
      secondaryPropagation: 'none',
      mechanisms: ['sustain'],
      opportunityMode: 'none',
    };
    expect(defensiveSemanticError(deathStrike)).toBeNull();
    expect(isDefensiveKitMember('verified', 'active', deathStrike)).toBe(false);
    expect(createsMissableOpportunity('verified', 'active', deathStrike)).toBe(false);
  });

  it('membership: passive_survival never counts (activationMode passive is excluded regardless of the rest)', () => {
    const lastResort: DefensiveSemanticInput = {
      usageRole: 'passive_survival',
      activationScope: 'none',
      primaryBeneficiary: 'self',
      secondaryPropagation: 'none',
      mechanisms: ['lethal_prevention'],
      opportunityMode: 'none',
    };
    expect(defensiveSemanticError(lastResort)).toBeNull();
    expect(isDefensiveKitMember('verified', 'passive', lastResort)).toBe(false);
  });

  it('deriveLegacyClassification: always produces a (category, targetingMode) pair that defensiveTargetingError accepts, for every usageRole', () => {
    // §Hallazgo real de uso (2026-09-03): decenas de filas semi_defensive/
    // external_defensive rechazadas porque la IA confundía targetingMode con
    // activationScope/primaryBeneficiary (valores parecidos, otro enum).
    // deriveLegacyClassification reemplaza esos dos campos por completo en
    // vez de seguir validando lo que la IA escriba ahí — este test es la
    // garantía de que la sustitución nunca produce un par inválido.
    for (const usageRole of DEFENSIVE_USAGE_ROLES) {
      const input: DefensiveSemanticInput = { ...barkskin, usageRole };
      const { category, targetingMode } = deriveLegacyClassification(input);
      expect(defensiveTargetingError(category, targetingMode)).toBeNull();
    }
  });

  it('deriveLegacyClassification: maps the roles that must never look like a personal defensive to legacy consumers', () => {
    expect(deriveLegacyClassification({ ...barkskin, usageRole: 'personal_survival' })).toEqual({ category: 'personal_defensive', targetingMode: 'self' });
    expect(deriveLegacyClassification({ ...barkskin, usageRole: 'healer_throughput' })).toEqual({ category: 'semi_defensive', targetingMode: 'both' });
    expect(deriveLegacyClassification({ ...barkskin, usageRole: 'external' })).toEqual({ category: 'external_defensive', targetingMode: 'ally' });
    expect(deriveLegacyClassification({ ...barkskin, usageRole: 'raid_defensive' })).toEqual({ category: 'external_defensive', targetingMode: 'raid' });
    // active_mitigation (SotR-style) NUNCA debe volver a leerse como
    // personal_defensive/self en un consumer legacy — es exactamente la
    // contaminación que esta migración corrige.
    expect(deriveLegacyClassification({ ...barkskin, usageRole: 'active_mitigation' })).toEqual({ category: 'utility', targetingMode: 'unknown' });
    expect(deriveLegacyClassification({ ...barkskin, usageRole: 'rotational_survival' })).toEqual({ category: 'utility', targetingMode: 'unknown' });
  });

  it('deriveLegacySurvivalType: lethal_prevention (new, v10-only) still lands on a legacy value instead of failing missingDefensive validation', () => {
    // §Hallazgo real de uso (2026-09-03): "missingDefensive necesita un
    // survivalType válido" en Evoker — la IA usaba lethal_prevention (nuevo)
    // donde el campo legacy solo acepta mitigation/absorption/sustain/
    // emergency. lethal_prevention cae en el cajón histórico "emergency".
    expect(deriveLegacySurvivalType(['lethal_prevention'])).toBe('emergency');
    expect(deriveLegacySurvivalType(['mitigation', 'sustain'])).toBe('mitigation');
    expect(deriveLegacySurvivalType(['avoidance'])).toBe('mitigation');
    expect(deriveLegacySurvivalType(['absorption'])).toBe('absorption');
    expect(deriveLegacySurvivalType(['immunity'])).toBe('emergency');
    expect(deriveLegacySurvivalType(['effective_health'])).toBe('emergency');
    expect(deriveLegacySurvivalType([])).toBeNull();
  });
});
