import { describe, expect, it } from 'vitest';
import type { MechanicPolicyContract } from '../../../supabase/functions/_shared/combat-evaluation-contract';
import {
  MECHANIC_ATTRIBUTION_SHADOW_VERSION,
  evaluateMechanicAttributionShadow,
} from '../../../supabase/functions/_shared/mechanic-attribution-shadow';

function policy(
  overrides: Partial<MechanicPolicyContract> = {},
): MechanicPolicyContract {
  return {
    bossId: 'boss',
    difficulty: 'Mythic',
    mechanicKey: 'mechanic:test',
    policyVersion: 1,
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
    ...overrides,
  };
}

function evaluate(
  overrides: Partial<Parameters<typeof evaluateMechanicAttributionShadow>[0]> = {},
) {
  return evaluateMechanicAttributionShadow({
    outcome: 'fail',
    occurrenceConfidence: 'inferred',
    category: 'avoidable-ground',
    responsibility: 'personal',
    playersHitNames: ['A'],
    policy: policy(),
    ...overrides,
  });
}

describe('mechanic attribution canonical shadow v1', () => {
  it('verifies direct personal avoidable-ground without expanding Safety v1', () => {
    const result = evaluate({ playersHitNames: ['A', 'B', 'A'] });

    expect(result.status).toBe('verified');
    expect(result.reason).toBe('DIRECT_PERSONAL_AVOIDABLE_GROUND');
    expect(result.responsiblePlayers).toEqual(['A', 'B']);
    expect(result.safetyV1Players).toEqual(['A', 'B']);
    expect(result.newAccusationPlayers).toEqual([]);
  });

  it('keeps tank responsibility at role level and never blames hit players', () => {
    const result = evaluate({
      category: 'tankbuster',
      responsibility: 'tank',
      playersHitNames: ['TankA', 'MageA', 'HunterA'],
      policy: policy({
        displayCategory: 'tankbuster',
        targetingMode: 'tank',
        responsibilityMode: 'tank_role',
        penaltyScope: 'role',
      }),
    });

    expect(result.status).toBe('role_only');
    expect(result.reason).toBe('ROLE_RESPONSIBILITY_ONLY');
    expect(result.responsiblePlayers).toEqual([]);
    expect(result.safetyV1Players).toEqual([]);
  });

  it('keeps raid failures collective', () => {
    const result = evaluate({
      category: 'raid-damage',
      responsibility: 'raid',
      playersHitNames: ['A', 'B', 'C'],
      policy: policy({
        displayCategory: 'raid-damage',
        targetingMode: 'raid',
        responsibilityMode: 'raid',
        penaltyScope: 'raid_only',
      }),
    });

    expect(result.status).toBe('raid_only');
    expect(result.responsiblePlayers).toEqual([]);
  });

  it.each(['spread', 'soak'])(
    'does not canonically assign %s without carrier/participation ownership evidence',
    (category) => {
      const result = evaluate({
        category,
        playersHitNames: ['A', 'B'],
        policy: policy({ displayCategory: category }),
      });

      expect(result.status).toBe('unresolved');
      expect(result.reason).toBe('MULTI_ACTOR_PERSONAL_FAMILY_REQUIRES_OWNERSHIP');
      expect(result.responsiblePlayers).toEqual([]);
      expect(result.safetyV1Players).toEqual(['A', 'B']);
    },
  );

  it('verifies a single personal target only when the target is already a Safety-v1 candidate', () => {
    const result = evaluate({
      category: 'personal-target',
      playersHitNames: ['A'],
      policy: policy({
        displayCategory: 'personal-target',
        targetingMode: 'selected_player',
      }),
    });

    expect(result.status).toBe('verified');
    expect(result.reason).toBe('SINGLE_PERSONAL_TARGET');
    expect(result.responsiblePlayers).toEqual(['A']);
  });

  it('fails closed when event responsibility and canonical policy disagree', () => {
    const result = evaluate({
      responsibility: 'personal',
      policy: policy({
        responsibilityMode: 'tank_role',
        targetingMode: 'tank',
        penaltyScope: 'role',
      }),
    });

    expect(result.status).toBe('unresolved');
    expect(result.reason).toBe('SEMANTIC_CONTRADICTION');
    expect(result.responsiblePlayers).toEqual([]);
  });

  it('does not promote the historical responsibility=null fallback to canonical ownership', () => {
    const result = evaluate({ responsibility: null });

    expect(result.status).toBe('unresolved');
    expect(result.responsiblePlayers).toEqual([]);
    expect(result.safetyV1Players).toEqual(['A']);
  });

  it('hard-blocks an assigned actor that would be a new accusation', () => {
    const result = evaluate({
      category: 'personal-target',
      playersHitNames: ['A'],
      policy: policy({ responsibilityMode: 'assigned_player', assignmentMode: 'plan_required' }),
      assignedPlayers: ['B'],
    });

    expect(result.status).toBe('unresolved');
    expect(result.reason).toBe('SAFETY_V1_GUARD_BLOCKED_NEW_ACCUSATION');
    expect(result.responsiblePlayers).toEqual([]);
    expect(result.newAccusationPlayers).toEqual([]);
  });

  it('treats success as not applicable to blame', () => {
    const result = evaluate({ outcome: 'success' });
    expect(result.status).toBe('not_applicable');
    expect(result.reason).toBe('NO_FAILURE_TO_ATTRIBUTE');
  });

  it('never verifies fallback/uncertain evidence', () => {
    const result = evaluate({ policy: policy({ confidence: 'fallback' }) });
    expect(result.status).toBe('unresolved');
    expect(result.reason).toBe('UNTRUSTED_EVIDENCE');
  });

  it('is explicitly versioned', () => {
    expect(MECHANIC_ATTRIBUTION_SHADOW_VERSION).toBe(
      'mechanic-attribution-shadow@1.0.0',
    );
  });
});
