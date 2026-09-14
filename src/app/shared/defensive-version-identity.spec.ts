import { describe, expect, it } from 'vitest';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION,
} from '../../../supabase/functions/_shared/effective-defensives';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6,
  DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6,
} from '../../../supabase/functions/_shared/defensive-evidence-v6';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V7,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V7,
  DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7,
} from '../../../supabase/functions/_shared/defensive-evidence-v7';
import {
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V10,
} from '../../../supabase/functions/_shared/defensive-evidence-v10';

describe('defensive version identity', () => {
  it('keeps the unchanged pure resolver identity stable for the historical empirical contracts', () => {
    expect(EFFECTIVE_DEFENSIVE_RESOLVER_VERSION).toBe('effective-defensives@2.4.0');
    expect(EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION).toBe('effective-defensive-semantics@1.7.0');
    expect(EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6).toBe(EFFECTIVE_DEFENSIVE_RESOLVER_VERSION);
    expect(EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6).toBe(EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION);
    expect(EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V7).toBe(EFFECTIVE_DEFENSIVE_RESOLVER_VERSION);
    expect(EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V7).toBe(EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION);
  });

  it('versions the current canonical semantic-data closure independently so old 1.7 snapshots cannot be reused', () => {
    expect(EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V10).toBe('effective-defensive-semantics@1.8.0');
  });

  it('bumps only the evaluator between the v6 and v7 empirical contracts', () => {
    expect(DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6).toBe('episode-evaluator@6');
    expect(DEFENSIVE_EPISODE_EVALUATOR_VERSION_V7).toBe('episode-evaluator@7');
  });
});