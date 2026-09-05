import { describe, expect, it } from 'vitest';
import {
  MECHANIC_ATTRIBUTION_SAFETY_VERSION,
  classifyMechanicAttribution,
  isPunitivePersonalMechanicEvent,
} from '../../../supabase/functions/_shared/mechanic-attribution';

describe('mechanic attribution safety v1', () => {
  it('keeps an explicitly personal failure only inside the previous punitive categories', () => {
    expect(
      classifyMechanicAttribution({
        category: 'avoidable-ground',
        responsibility: 'personal',
      }),
    ).toEqual({ kind: 'personal', source: 'responsibility' });
  });

  it('never blames the damage recipient when explicit responsibility belongs to a role or raid', () => {
    for (const responsibility of ['tank', 'healer', 'dps', 'raid'] as const) {
      expect(
        isPunitivePersonalMechanicEvent({
          category: 'avoidable-ground',
          responsibility,
        }),
      ).toBe(false);
    }
  });

  it('does not let category override an explicit non-personal responsibility', () => {
    expect(
      classifyMechanicAttribution({
        category: 'spread',
        responsibility: 'raid',
      }),
    ).toEqual({ kind: 'role_or_raid', source: 'responsibility' });
  });

  it('does not expand v1 scoring to new categories just because responsibility is personal', () => {
    expect(
      classifyMechanicAttribution({
        category: 'tankbuster',
        responsibility: 'personal',
      }),
    ).toEqual({ kind: 'unclassified', source: 'unsupported_personal_category' });
    expect(
      isPunitivePersonalMechanicEvent({
        category: 'tankbuster',
        responsibility: 'personal',
      }),
    ).toBe(false);
  });

  it('fails closed for personal responsibility without a supported category', () => {
    expect(
      classifyMechanicAttribution({
        category: null,
        responsibility: 'personal',
      }),
    ).toEqual({ kind: 'unclassified', source: 'unsupported_personal_category' });
  });

  it('keeps the old category rule only for historical rows without responsibility', () => {
    expect(
      classifyMechanicAttribution({
        category: 'avoidable-ground',
        responsibility: null,
      }),
    ).toEqual({ kind: 'personal', source: 'legacy_category' });

    expect(
      classifyMechanicAttribution({
        category: 'tankbuster',
        responsibility: null,
      }),
    ).toEqual({ kind: 'role_or_raid', source: 'legacy_category' });
  });

  it('fails closed when neither responsibility nor category can attribute fault', () => {
    expect(
      classifyMechanicAttribution({
        category: null,
        responsibility: null,
      }),
    ).toEqual({ kind: 'unclassified', source: 'missing' });
    expect(
      isPunitivePersonalMechanicEvent({ category: null, responsibility: null }),
    ).toBe(false);
  });

  it('is explicitly versioned', () => {
    expect(MECHANIC_ATTRIBUTION_SAFETY_VERSION).toBe(
      'mechanic-attribution-safety@1.0.0',
    );
  });
});
