// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import type { MechanicOccurrenceEvaluationContract, MechanicPolicyContract, ExecutionReasonCode } from './combat-evaluation-contract.ts';
// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import type { EdgeDecision, OwnershipResolution } from './mechanic-occurrence-evaluator.ts';
// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import { canRelationshipBePenalized, canRelationshipGetCredit } from './mechanic-occurrence-evaluator.ts';

export interface DefensivePlanSlot {
  assignedPlayer: string;
  defensiveSpellId?: number;
  plannedCastAtMs?: number;
}

function actorIdOrNull(value: string): number | null {
  const actorId = Number(value);
  return Number.isInteger(actorId) && actorId > 0 ? actorId : null;
}

/**
 * Construye los responsibility edges desde una ocurrencia evaluada
 * Implementa la lógica de determinación de quién puede ser acreditado/penalizado
 */
export function buildResponsibilityEdges(
  occurrence: MechanicOccurrenceEvaluationContract,
  policy: MechanicPolicyContract,
  ownership: OwnershipResolution,
  defensivePlanSlots: DefensivePlanSlot[],
  damageByPlayer: Map<string, number>, // player_name → damage taken/caused
): EdgeDecision[] {
  const edges: EdgeDecision[] = [];
  const { creditOutcome, failureOutcome } = mapOccurrenceOutcomeToEdgeMappings(occurrence.outcome);

  // OWNERS PRIMARIOS
  for (const owner of ownership.primaryOwners) {
    const penaltyEligible = failureOutcome && canRelationshipBePenalized('primary_owner', occurrence.confidence);
    const reasonCode = determinePrimaryOwnerReasonCode(policy, occurrence.outcome);

    edges.push({
      playerName: owner,
      actorId: actorIdOrNull(owner),
      relationship: 'primary_owner',
      creditEligible: false, // Los owners no ganan crédito por evitar (solo los resolvers)
      penaltyEligible,
      reasonCode,
      confidence: occurrence.confidence,
    });
  }

  // CO-OWNERS (si aplica por assignment_mode)
  for (const coOwner of ownership.coOwners) {
    const penaltyEligible = failureOutcome && canRelationshipBePenalized('co_owner', occurrence.confidence);

    edges.push({
      playerName: coOwner,
      actorId: null,
      relationship: 'co_owner',
      creditEligible: false,
      penaltyEligible,
      reasonCode: determinePrimaryOwnerReasonCode(policy, occurrence.outcome),
      confidence: occurrence.confidence,
    });
  }

  // ASSIGNED RESOLVERS (del plan de defensivos)
  for (const slot of defensivePlanSlots) {
    const penaltyEligible = failureOutcome && canRelationshipBePenalized('assigned_resolver', occurrence.confidence);

    edges.push({
      playerName: slot.assignedPlayer,
      actorId: null,
      relationship: 'assigned_resolver',
      creditEligible: creditOutcome,
      penaltyEligible,
      reasonCode: failureOutcome ? 'ASSIGNED_SOAK_MISSED' : 'PLAN_COVERED',
      confidence: occurrence.confidence,
    });
  }

  // TARGETS (si la mecánica es un ataque directo)
  if (policy.targetingMode !== 'none' && policy.targetingMode !== 'raid') {
    for (const target of ownership.targets) {
      const damage = damageByPlayer.get(target) || 0;

      edges.push({
        playerName: target,
        actorId: actorIdOrNull(target),
        relationship: 'target',
        creditEligible: false,
        penaltyEligible: false, // Targets no son culpables
        reasonCode: 'TARGET_MISMATCH',
        confidence: occurrence.confidence,
      });
    }
  }

  // COLLATERAL VICTIMS (si failure_propagation lo permite)
  if (policy.failurePropagation !== 'none' && policy.failurePropagation !== 'self' && failureOutcome) {
    for (const victim of ownership.collateralVictims) {
      const damage = damageByPlayer.get(victim) || 0;

      edges.push({
        playerName: victim,
        actorId: null,
        relationship: 'collateral_victim',
        creditEligible: false,
        penaltyEligible: false, // Víctimas no son culpables
        reasonCode: 'SPREAD_CARRIER_COLLATERAL',
        confidence: occurrence.confidence,
      });
    }
  }

  return edges;
}

/**
 * Mapea outcome a indicador de crédito/fallo
 */
function mapOccurrenceOutcomeToEdgeMappings(
  outcome: string,
): { creditOutcome: boolean; failureOutcome: boolean } {
  return {
    creditOutcome: outcome === 'success',
    failureOutcome: outcome === 'fail' || outcome === 'partial_fail',
  };
}

/**
 * Determina código de razón para owner primario fallido
 */
function determinePrimaryOwnerReasonCode(
  policy: MechanicPolicyContract,
  outcome: string,
): ExecutionReasonCode {
  if (outcome !== 'fail' && outcome !== 'partial_fail') {
    return 'PLAN_COVERED';
  }

  // Mapear según tipo de mecánica
  switch (policy.responsibilityMode) {
    case 'tank_role':
      if (policy.targetingMode === 'tank') {
        return 'TANK_FRONTAL_HIT_RAID';
      }
      return 'TANK_SWAP_THRESHOLD_BREACH';

    case 'assigned_player':
    case 'assigned_group':
      return 'ASSIGNED_SOAK_MISSED';

    case 'raid':
      return 'RAID_INTERRUPT_MISSED';

    case 'volunteer':
      return 'VOLUNTEER_MECHANIC_UNRESOLVED';

    default:
      return 'PERSONAL_GROUND_HIT';
  }
}

/**
 * Deduplicación de edges por player + relationship
 * Mantiene el edge con highest confidence en caso de conflicto
 */
export function deduplicateEdges(edges: EdgeDecision[]): EdgeDecision[] {
  const dedup = new Map<string, EdgeDecision>();

  for (const edge of edges) {
    const key = `${edge.playerName}:${edge.relationship}`;
    const existing = dedup.get(key);

    if (!existing) {
      dedup.set(key, edge);
      continue;
    }

    // Mantener edge con mayor confianza
    const confidenceRank = { verified: 4, inferred: 3, fallback: 2, uncertain: 1 };
    const newRank = confidenceRank[edge.confidence as keyof typeof confidenceRank] || 0;
    const existingRank = confidenceRank[existing.confidence as keyof typeof confidenceRank] || 0;

    if (newRank > existingRank) {
      dedup.set(key, edge);
    }
  }

  return Array.from(dedup.values());
}
