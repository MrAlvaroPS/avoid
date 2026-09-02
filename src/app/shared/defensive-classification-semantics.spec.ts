import { describe, expect, it } from 'vitest';
import { defensiveTargetingError } from '../../../supabase/functions/_shared/defensive-classification-semantics';

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
