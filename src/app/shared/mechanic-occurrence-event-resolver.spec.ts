import { describe, expect, it } from 'vitest';
import type {
  MechanicPolicyContract,
  PullEvaluationContextContract,
} from '../../../supabase/functions/_shared/combat-evaluation-contract';
import {
  EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION,
  resolveEventBackedMechanicOccurrences,
  type EventBackedMechanicEvent,
} from '../../../supabase/functions/_shared/mechanic-occurrence-event-resolver';

function context(): PullEvaluationContextContract {
  return {
    pullId: 'pull-1',
    evaluationEligible: true,
    evaluationStartMs: 1_000,
    evaluationEndMs: 20_000,
    cutoffReason: 'fight_end',
    wipeCallAtMs: null,
    wipeCallBossHpPct: null,
    wipeCallSource: 'none',
    wipeCallConfidence: null,
    wipeCallVerified: false,
    ninjaStatus: 'valid',
    ninjaSource: 'heuristic',
    ninjaConfidence: 1,
    evidence: {},
    resolverVersion: 'pull-evaluation-context@1.0.0',
    updatedAt: '2026-09-05T00:00:00Z',
  };
}

function policy(key: string): MechanicPolicyContract {
  return {
    bossId: 'boss',
    difficulty: 'Mythic',
    mechanicKey: key,
    policyVersion: 3,
    displayCategory: 'avoidable-ground',
    targetingMode: 'ground',
    requiredResponse: 'avoid',
    responsibilityMode: 'target',
    damageSemantics: 'avoidable',
    failurePropagation: 'self',
    assignmentMode: 'target_derived',
    defensiveExpectation: 'none',
    creditScope: 'none',
    penaltyScope: 'owner',
    causalRule: {},
    confidence: 'verified',
  };
}

function event(
  id: string,
  abilityId: number,
  triggerTimeMs: number,
  outcome: EventBackedMechanicEvent['outcome'] = 'clean',
): EventBackedMechanicEvent {
  return {
    id,
    pullId: 'pull-1',
    abilityId,
    mechanicName: `Ability ${abilityId}`,
    mechanicKey: null,
    category: 'avoidable-ground',
    responsibility: 'personal',
    triggerTimeMs,
    outcome,
    playersHitNames: outcome === 'clean' ? [] : ['A'],
    playerHitDetails: outcome === 'clean' ? [] : [{ name: 'A', damage_taken: 123 }],
  };
}

describe('event-backed mechanic occurrence resolver v2', () => {
  it('creates one real occurrence per mapped source event with stable per-mechanic indices', () => {
    const result = resolveEventBackedMechanicOccurrences({
      pullId: 'pull-1',
      bossId: 'boss',
      difficulty: 'Mythic',
      context: context(),
      events: [
        event('e3', 101, 8_000, 'fail'),
        event('e1', 101, 2_000, 'clean'),
        event('e2', 202, 5_000, 'partial_fail'),
      ],
      aliases: [
        { abilityId: 101, mechanicKey: 'm:a', confidence: 'verified' },
        { abilityId: 202, mechanicKey: 'm:b', confidence: 'verified' },
      ],
      policies: [policy('m:a'), policy('m:b')],
    });

    expect(result.sourceEventCount).toBe(3);
    expect(result.mappedEventCount).toBe(3);
    expect(result.occurrences.map((row) => [row.mechanicKey, row.occurrenceIndex])).toEqual([
      ['m:a', 1],
      ['m:b', 1],
      ['m:a', 2],
    ]);
    expect(result.occurrences[2]).toMatchObject({
      outcome: 'fail',
      failureMode: 'observed_event_fail',
      resolveMs: 8_000,
      endMs: 12_000,
      occurrenceResolverVersion: EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION,
    });
    expect(result.occurrences[2].evidence['source_event_id']).toBe('e3');
  });

  it('reports unmapped identity instead of inventing a mechanic key', () => {
    const result = resolveEventBackedMechanicOccurrences({
      pullId: 'pull-1',
      bossId: 'boss',
      difficulty: 'Mythic',
      context: context(),
      events: [event('unknown', 999, 4_000, 'fail')],
      aliases: [],
      policies: [],
    });

    expect(result.occurrences).toEqual([]);
    expect(result.unmappedEventIds).toEqual(['unknown']);
  });

  it('reports a mapped event whose policy snapshot owner is missing', () => {
    const result = resolveEventBackedMechanicOccurrences({
      pullId: 'pull-1',
      bossId: 'boss',
      difficulty: 'Mythic',
      context: context(),
      events: [event('mapped', 101, 4_000, 'fail')],
      aliases: [{ abilityId: 101, mechanicKey: 'm:a', confidence: 'verified' }],
      policies: [],
    });

    expect(result.occurrences).toEqual([]);
    expect(result.missingPolicyEventIds).toEqual(['mapped']);
  });

  it('excludes events outside canonical PullEvaluationContext', () => {
    const result = resolveEventBackedMechanicOccurrences({
      pullId: 'pull-1',
      bossId: 'boss',
      difficulty: 'Mythic',
      context: context(),
      events: [event('before', 101, 999), event('after', 101, 20_000), event('inside', 101, 19_999)],
      aliases: [{ abilityId: 101, mechanicKey: 'm:a', confidence: 'verified' }],
      policies: [policy('m:a')],
    });

    expect(result.outOfScopeEventIds.sort()).toEqual(['after', 'before']);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0].endMs).toBe(20_000);
  });

  it('caps event-backed occurrence confidence at inferred even with verified identity/policy', () => {
    const result = resolveEventBackedMechanicOccurrences({
      pullId: 'pull-1',
      bossId: 'boss',
      difficulty: 'Mythic',
      context: context(),
      events: [event('e1', 101, 2_000, 'fail')],
      aliases: [{ abilityId: 101, mechanicKey: 'm:a', confidence: 'verified' }],
      policies: [policy('m:a')],
    });

    expect(result.occurrences[0].confidence).toBe('inferred');
  });

  it('fails closed to uncertain when identity or policy confidence is fallback', () => {
    const fallbackPolicy = { ...policy('m:a'), confidence: 'fallback' as const };
    const result = resolveEventBackedMechanicOccurrences({
      pullId: 'pull-1',
      bossId: 'boss',
      difficulty: 'Mythic',
      context: context(),
      events: [event('e1', 101, 2_000, 'fail')],
      aliases: [{ abilityId: 101, mechanicKey: 'm:a', confidence: 'verified' }],
      policies: [fallbackPolicy],
    });

    expect(result.occurrences[0].confidence).toBe('uncertain');
  });

  it('prefers an already materialized mechanicKey over alias inference', () => {
    const direct = { ...event('e1', 101, 2_000), mechanicKey: 'm:direct' };
    const result = resolveEventBackedMechanicOccurrences({
      pullId: 'pull-1',
      bossId: 'boss',
      difficulty: 'Mythic',
      context: context(),
      events: [direct],
      aliases: [{ abilityId: 101, mechanicKey: 'm:alias', confidence: 'verified' }],
      policies: [policy('m:direct'), policy('m:alias')],
    });

    expect(result.occurrences[0].mechanicKey).toBe('m:direct');
    expect(result.occurrences[0].evidence['identity_source']).toBe('event_mechanic_key');
  });
});
