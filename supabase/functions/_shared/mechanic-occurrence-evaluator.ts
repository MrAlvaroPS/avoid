// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import type { MechanicOccurrenceEvaluationContract, MechanicPolicyContract, OccurrenceOutcome, ResponsibilityRelationship } from './combat-evaluation-contract.ts';

export interface OwnershipResolution {
  primaryOwners: string[]; // actor/player identity only when ownership is explicit
  coOwners: string[];
  assignedResolvers: string[];
  targets: string[];
  collateralVictims: string[];
  successfulResolvers: string[];
  beneficiaries: string[];
}

export interface EdgeDecision {
  playerName: string;
  actorId: number | null;
  relationship: ResponsibilityRelationship;
  creditEligible: boolean;
  penaltyEligible: boolean;
  reasonCode: string;
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
}

/**
 * Resolves actor ownership only when the occurrence itself contains explicit
 * actor/assignment evidence.
 *
 * Critical invariant: responsibility for a ROLE is not proof that every member
 * of that role caused the failure. Previous shadow code expanded tank_role,
 * healer_role, dps_role and raid into the whole roster as primary_owner; if
 * materialised, that could blame two tanks (or an entire role) for one actor's
 * error. Shadow v1 deliberately leaves those owners unresolved until a family
 * evaluator proves the actor.
 */
export function resolveOccurrenceOwnership(
  occurrence: MechanicOccurrenceEvaluationContract,
  policy: MechanicPolicyContract,
  assignmentSnapshot: Record<string, unknown> | null,
  rosterByRole: Map<string, string[]>,
): OwnershipResolution {
  const result: OwnershipResolution = {
    primaryOwners: [],
    coOwners: [],
    assignedResolvers: [],
    targets: [],
    collateralVictims: [],
    successfulResolvers: [],
    beneficiaries: [],
  };

  switch (policy.responsibilityMode) {
    case 'target':
      if (occurrence.targetActorIds.length > 0) {
        result.primaryOwners = occurrence.targetActorIds.map(String);
      }
      break;

    case 'assigned_player':
      if (assignmentSnapshot && assignmentSnapshot['assignedPlayer']) {
        result.primaryOwners = [String(assignmentSnapshot['assignedPlayer'])];
      }
      break;

    case 'assigned_group':
      if (assignmentSnapshot && Array.isArray(assignmentSnapshot['assignedGroup'])) {
        result.primaryOwners = (assignmentSnapshot['assignedGroup'] as unknown[])
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      }
      break;

    case 'tank_role':
    case 'healer_role':
    case 'dps_role':
    case 'raid':
    case 'volunteer':
    case 'none':
    default:
      // Role/raid membership is context, not actor ownership. The roster is
      // intentionally NOT expanded into primaryOwners here.
      void rosterByRole;
      result.primaryOwners = [];
      break;
  }

  result.targets = occurrence.targetActorIds.map(String);

  // assignedResolvers, successfulResolvers, collateralVictims and
  // beneficiaries require explicit WCL/plan evidence and are filled by later
  // family-specific evaluators, never by role membership alone.
  return result;
}

/** Determines if an occurrence can participate in evaluation. */
export function isOccurrenceEvaluable(
  occurrence: MechanicOccurrenceEvaluationContract,
  policy: MechanicPolicyContract,
): boolean {
  void policy;
  if (occurrence.confidence === 'uncertain' && occurrence.outcome === 'fail') {
    return false;
  }
  return true;
}

/** Maps occurrence outcome to generic credit/failure state. */
export function mapOccurrenceOutcomeToEdgeMappings(
  outcome: OccurrenceOutcome,
): { creditOutcome: boolean; failureOutcome: boolean } {
  return {
    creditOutcome: outcome === 'success',
    failureOutcome: outcome === 'fail' || outcome === 'partial_fail',
  };
}

/** Determines if a relationship is eligible for a future penalty. */
export function canRelationshipBePenalized(
  relationship: ResponsibilityRelationship,
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain',
): boolean {
  const penalizableRelationships: ResponsibilityRelationship[] = ['primary_owner', 'co_owner', 'assigned_resolver'];
  if (!penalizableRelationships.includes(relationship)) return false;
  return confidence === 'verified' || confidence === 'inferred';
}

/** Determines if a relationship can receive credit. */
export function canRelationshipGetCredit(
  relationship: ResponsibilityRelationship,
  outcome: OccurrenceOutcome,
): boolean {
  const creditableRelationships: ResponsibilityRelationship[] = ['successful_resolver', 'beneficiary'];
  return creditableRelationships.includes(relationship) && outcome === 'success';
}
