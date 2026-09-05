import { describe, expect, it } from 'vitest';
import {
  MECHANIC_ATTRIBUTION_SAFETY_VERSION,
  isPersonalMechanicFailureCandidate,
  mechanicIncidentScope,
  resolvePersonalMechanicAttribution,
} from '../../../supabase/functions/_shared/mechanic-attribution-safety';

describe('mechanic attribution safety v1', () => {
  it('keeps an explicitly personal legacy-category failure', () => {
    const decision = resolvePersonalMechanicAttribution({
      category: 'avoidable-ground',
      responsibility: 'personal',
    });
    expect(decision.personalFailureCandidate).toBe(true);
    expect(decision.source).toBe('explicit_personal_responsibility');
  });

  it.each(['raid', 'tank', 'healer', 'dps'] as const)(
    'never blames a hit player when responsibility=%s',
    (responsibility) => {
      expect(
        isPersonalMechanicFailureCandidate({
          category: 'avoidable-ground',
          responsibility,
        }),
      ).toBe(false);
    },
  );

  it('does not expand v1 into new punitive categories even when responsibility is personal', () => {
    expect(
      isPersonalMechanicFailureCandidate({
        category: 'tankbuster',
        responsibility: 'personal',
      }),
    ).toBe(false);
  });

  it('preserves the legacy category fallback only when responsibility is missing', () => {
    const decision = resolvePersonalMechanicAttribution({
      category: 'spread',
      responsibility: null,
    });
    expect(decision.personalFailureCandidate).toBe(true);
    expect(decision.source).toBe('legacy_category_fallback');
  });

  it('never turns fully unclassified historical data into personal blame', () => {
    expect(
      isPersonalMechanicFailureCandidate({ category: null, responsibility: null }),
    ).toBe(false);
  });

  it('classifies explicit raid/role responsibility as group context, not personal', () => {
    expect(
      mechanicIncidentScope({ category: 'avoidable-ground', responsibility: 'raid' }),
    ).toBe('group');
    expect(
      mechanicIncidentScope({ category: 'tankbuster', responsibility: 'tank' }),
    ).toBe('group');
  });

  it('keeps genuinely unclassified legacy events separate', () => {
    expect(mechanicIncidentScope({ category: null, responsibility: null })).toBe(
      'unclassified',
    );
  });

  it('is explicitly versioned for provenance/tests', () => {
    expect(MECHANIC_ATTRIBUTION_SAFETY_VERSION).toBe(
      'mechanic-attribution-safety@1.0.0',
    );
  });
});
