import { describe, expect, it } from 'vitest';
import {
  defensiveV2BackfillState,
  defensiveV2Capabilities,
} from '../../../supabase/functions/_shared/defensive-v2-readiness';

describe('defensive v2 readiness', () => {
  it('does not call an empty or partial backfill ready', () => {
    expect(defensiveV2BackfillState(0, 0)).toBe('partial');
    expect(defensiveV2BackfillState(10, 9)).toBe('partial');
    expect(defensiveV2BackfillState(10, 10)).toBe('ready');
  });

  it('gates each capability by all of its upstream dependencies', () => {
    expect(
      defensiveV2Capabilities({
        resolverEndpoint: true,
        resolverSchema: 'ready',
        planSchema: 'missing',
        evaluatorSchema: 'ready',
        reliabilitySchema: 'ready',
        overrideAudit: 'ready',
        backfill: 'ready',
      }),
    ).toEqual({
      playerMode: true,
      playerOverride: true,
      planManagement: false,
      evaluator: false,
      infographic: false,
      reliability: false,
    });
  });

  it('keeps reporting disabled while backfill is partial', () => {
    expect(
      defensiveV2Capabilities({
        resolverEndpoint: true,
        resolverSchema: 'ready',
        planSchema: 'ready',
        evaluatorSchema: 'ready',
        reliabilitySchema: 'ready',
        overrideAudit: 'ready',
        backfill: 'partial',
      }),
    ).toEqual({
      playerMode: true,
      playerOverride: true,
      planManagement: true,
      evaluator: true,
      infographic: false,
      reliability: false,
    });
  });

  it('isolates a missing override migration from planning, evaluation and backfill', () => {
    expect(
      defensiveV2Capabilities({
        resolverEndpoint: true,
        resolverSchema: 'ready',
        planSchema: 'ready',
        evaluatorSchema: 'ready',
        reliabilitySchema: 'ready',
        overrideAudit: 'missing',
        backfill: 'ready',
      }),
    ).toEqual({
      playerMode: true,
      playerOverride: false,
      planManagement: true,
      evaluator: true,
      infographic: true,
      reliability: true,
    });
  });
});
