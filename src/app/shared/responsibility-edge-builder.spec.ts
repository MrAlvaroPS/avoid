import { describe, expect, it } from 'vitest';
import { buildResponsibilityEdges } from '../../../supabase/functions/_shared/responsibility-edge-builder';
import type {
  MechanicOccurrenceEvaluationContract,
  MechanicPolicyContract,
} from '../../../supabase/functions/_shared/combat-evaluation-contract';
import type { OwnershipResolution } from '../../../supabase/functions/_shared/mechanic-occurrence-evaluator';

function occurrence(overrides: Partial<MechanicOccurrenceEvaluationContract> = {}): MechanicOccurrenceEvaluationContract {
  return {
    id: 'occurrence-1',
    pullId: 'pull-1',
    bossId: 'boss-1',
    difficulty: 'Mythic',
    mechanicKey: 'mechanic-1',
    occurrenceIndex: 1,
    startMs: 10_000,
    resolveMs: 12_000,
    endMs: 12_500,
    targetActorIds: [],
    outcome: 'fail',
    failureMode: 'missed',
    evidence: {},
    confidence: 'verified',
    policyVersion: 1,
    contextResolverVersion: 'context@test',
    occurrenceResolverVersion: 'occurrence@test',
    ...overrides,
  };
}

function policy(overrides: Partial<MechanicPolicyContract> = {}): MechanicPolicyContract {
  return {
    bossId: 'boss-1',
    difficulty: 'Mythic',
    mechanicKey: 'mechanic-1',
    policyVersion: 1,
    displayCategory: 'avoidable-ground',
    targetingMode: 'ground',
    requiredResponse: null,
    responsibilityMode: 'dps_role',
    damageSemantics: 'avoidable',
    failurePropagation: 'self',
    assignmentMode: 'none',
    defensiveExpectation: 'none',
    creditScope: 'none',
    penaltyScope: 'owner',
    causalRule: {},
    confidence: 'verified',
    ...overrides,
  };
}

const ownership: OwnershipResolution = {
  primaryOwners: ['Alda', '42'],
  coOwners: [],
  assignedResolvers: [],
  targets: [],
  collateralVictims: [],
  successfulResolvers: [],
  beneficiaries: [],
};

describe('responsibility edge builder', () => {
  it('preserves roster names without serializing NaN as actor IDs', () => {
    const edges = buildResponsibilityEdges(occurrence(), policy(), ownership, [], new Map());

    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ playerName: 'Alda', actorId: null, reasonCode: 'PERSONAL_GROUND_HIT' }),
      expect.objectContaining({ playerName: '42', actorId: 42, reasonCode: 'PERSONAL_GROUND_HIT' }),
    ]));
  });

  it('emits only canonical ledger reason codes for all edge relationships', () => {
    const edges = buildResponsibilityEdges(
      occurrence(),
      policy({ responsibilityMode: 'assigned_player', failurePropagation: 'group' }),
      { ...ownership, coOwners: ['Bela'], collateralVictims: ['Cora'], targets: ['43'] },
      [{ assignedPlayer: 'Dani' }],
      new Map(),
    );

    expect(edges.map((edge) => edge.reasonCode)).toEqual([
      'ASSIGNED_SOAK_MISSED',
      'ASSIGNED_SOAK_MISSED',
      'ASSIGNED_SOAK_MISSED',
      'ASSIGNED_SOAK_MISSED',
      'TARGET_MISMATCH',
      'SPREAD_CARRIER_COLLATERAL',
    ]);
  });
});
