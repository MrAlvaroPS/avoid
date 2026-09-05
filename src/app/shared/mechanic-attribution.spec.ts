import { describe, expect, it } from 'vitest';
import {
  classifyMechanicAttribution,
  isPunitivePersonalMechanicEvent,
} from '../../../supabase/functions/_shared/mechanic-attribution';

describe('mechanic attribution safety v1', () => {
  it('lets explicit personal responsibility create a personal candidate', () => {
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
});
