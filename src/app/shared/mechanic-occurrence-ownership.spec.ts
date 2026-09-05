import { describe, expect, it } from 'vitest';
import type {
  MechanicOccurrenceEvaluationContract,
  MechanicPolicyContract,
} from '../../../supabase/functions/_shared/combat-evaluation-contract';
import { resolveOccurrenceOwnership } from '../../../supabase/functions/_shared/mechanic-occurrence-evaluator';

function occurrence(
  targetActorIds: number[] = [],
): MechanicOccurrenceEvaluationContract {
  return {
    id: 'occ-1',
    pullId: 'pull-1',
    bossId: 'boss',
    difficulty: 'Mythic',
    mechanicKey: 'm:test',
    occurrenceIndex: 1,
    startMs: 1_000,
    resolveMs: 1_000,
    endMs: 5_000,
    targetActorIds,
    outcome: 'fail',
    failureMode: 'observed_event_fail',
    evidence: {},
    confidence: 'inferred',
    policyVersion: 1,
    contextResolverVersion: 'pull-evaluation-context@1.0.0',
    occurrenceResolverVersion: 'mechanic-occurrence-resolver@2.0.0',
  };
}

function policy(
  responsibilityMode: MechanicPolicyContract['responsibilityMode'],
): MechanicPolicyContract {
  return {
    bossId: 'boss',
    difficulty: 'Mythic',
    mechanicKey: 'm:test',
    policyVersion: 1,
    displayCategory: 'tankbuster',
    targetingMode: 'tank',
    requiredResponse: null,
    responsibilityMode,
    damageSemantics: 'failure_consequence',
    failurePropagation: 'raid',
    assignmentMode: 'role_derived',
    defensiveExpectation: 'none',
    creditScope: 'none',
    penaltyScope: 'role',
    causalRule: {},
    confidence: 'verified',
  };
}

const rosterByRole = new Map<string, string[]>([
  ['tank', ['TankA', 'TankB']],
  ['healer', ['HealA', 'HealB']],
  ['dps', ['DpsA', 'DpsB']],
]);

describe('mechanic occurrence ownership safety', () => {
  it.each(['tank_role', 'healer_role', 'dps_role', 'raid'] as const)(
    'does not expand %s responsibility into primary owners',
    (mode) => {
      const result = resolveOccurrenceOwnership(
        occurrence(),
        policy(mode),
        null,
        rosterByRole,
      );

      expect(result.primaryOwners).toEqual([]);
    },
  );

  it('keeps explicit target actor ids when the policy is target-owned', () => {
    const result = resolveOccurrenceOwnership(
      occurrence([101, 202]),
      { ...policy('target'), penaltyScope: 'owner' },
      null,
      rosterByRole,
    );

    expect(result.primaryOwners).toEqual(['101', '202']);
    expect(result.targets).toEqual(['101', '202']);
  });

  it('uses an explicit assigned player without consulting role membership', () => {
    const result = resolveOccurrenceOwnership(
      occurrence(),
      {
        ...policy('assigned_player'),
        assignmentMode: 'plan_required',
        penaltyScope: 'assignee',
      },
      { assignedPlayer: 'TankB' },
      rosterByRole,
    );

    expect(result.primaryOwners).toEqual(['TankB']);
  });

  it('does not invent an assigned player when the assignment snapshot is empty', () => {
    const result = resolveOccurrenceOwnership(
      occurrence(),
      {
        ...policy('assigned_player'),
        assignmentMode: 'plan_required',
        penaltyScope: 'assignee',
      },
      {},
      rosterByRole,
    );

    expect(result.primaryOwners).toEqual([]);
  });
});
