// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import type { MechanicOccurrenceEvaluationContract, MechanicPolicyContract, OccurrenceOutcome, ResponsibilityRelationship } from './combat-evaluation-contract.ts';

export interface OwnershipResolution {
  primaryOwners: string[]; // actor_id, puede ser > 1 si responsibility_mode='group'
  coOwners: string[];
  assignedResolvers: string[]; // del plan de defensivos
  targets: string[]; // destinatarios de la mecánica
  collateralVictims: string[]; // dañados por propagación
  successfulResolvers: string[]; // quiénes evitaron activamente
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
 * Determina quién es owner/assignee/resolver de una ocurrencia
 * según boss_mechanic_policy.responsibility_mode
 */
export function resolveOccurrenceOwnership(
  occurrence: MechanicOccurrenceEvaluationContract,
  policy: MechanicPolicyContract,
  assignmentSnapshot: Record<string, unknown> | null,
  rosterByRole: Map<string, string[]>, // 'tank'|'healer'|'dps' → [player_names]
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

  // Determinar owners primarios según responsibility_mode
  switch (policy.responsibilityMode) {
    case 'target':
      // Targets directos de la mecánica
      if (occurrence.targetActorIds.length > 0) {
        result.primaryOwners = occurrence.targetActorIds.map(String);
      }
      break;

    case 'tank_role':
      // Todos los tanques del roster
      result.primaryOwners = rosterByRole.get('tank') || [];
      break;

    case 'healer_role':
      // Todos los sanadores
      result.primaryOwners = rosterByRole.get('healer') || [];
      break;

    case 'dps_role':
      // Todos los DPS
      result.primaryOwners = rosterByRole.get('dps') || [];
      break;

    case 'assigned_player':
      // Asignado específicamente
      if (assignmentSnapshot && assignmentSnapshot['assignedPlayer']) {
        result.primaryOwners = [String(assignmentSnapshot['assignedPlayer'])];
      }
      break;

    case 'assigned_group':
      // Grupo asignado (tank + healer + dps específicos)
      if (assignmentSnapshot && assignmentSnapshot['assignedGroup']) {
        const group = assignmentSnapshot['assignedGroup'] as string[];
        result.primaryOwners = group;
      }
      break;

    case 'volunteer':
      // Sin propietario específico; cualquiera puede resolver
      result.primaryOwners = [];
      break;

    case 'raid':
      // Toda la raid es responsable
      result.primaryOwners = Array.from(rosterByRole.values()).flat();
      break;

    case 'none':
    default:
      result.primaryOwners = [];
      break;
  }

  // Targets del mechanic
  result.targets = occurrence.targetActorIds.map(String);

  // Nota: assignedResolvers, successfulResolvers, collateralVictims y beneficiaries
  // se determinan en responsibility-edge-builder.ts tras análisis WCL
  return result;
}

/**
 * Determina si una ocurrencia debe ser evaluable según el outcome y la confianza
 */
export function isOccurrenceEvaluable(
  occurrence: MechanicOccurrenceEvaluationContract,
  policy: MechanicPolicyContract,
): boolean {
  // 'uncertain' nunca es punitivo, pero sí evaluable para logging
  if (occurrence.confidence === 'uncertain' && occurrence.outcome === 'fail') {
    return false; // No punir incertidumbre
  }
  return true;
}

/**
 * Mapea outcome de occurrence a responsibility edges
 */
export function mapOccurrenceOutcomeToEdgeMappings(
  outcome: OccurrenceOutcome,
): { creditOutcome: boolean; failureOutcome: boolean } {
  return {
    creditOutcome: outcome === 'success',
    failureOutcome: outcome === 'fail' || outcome === 'partial_fail',
  };
}

/**
 * Determina si una relación puede resultar en penalización
 */
export function canRelationshipBePenalized(
  relationship: ResponsibilityRelationship,
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain',
): boolean {
  // Solo owners y assigned_resolvers pueden ser penalizados
  const penalizableRelationships: ResponsibilityRelationship[] = ['primary_owner', 'co_owner', 'assigned_resolver'];
  if (!penalizableRelationships.includes(relationship)) {
    return false;
  }
  // Nunca penalizar si confidence='uncertain'
  return confidence === 'verified' || confidence === 'inferred';
}

/**
 * Determina si una relación puede resultar en crédito
 */
export function canRelationshipGetCredit(
  relationship: ResponsibilityRelationship,
  outcome: OccurrenceOutcome,
): boolean {
  const creditableRelationships: ResponsibilityRelationship[] = ['successful_resolver', 'beneficiary'];
  return creditableRelationships.includes(relationship) && outcome === 'success';
}
