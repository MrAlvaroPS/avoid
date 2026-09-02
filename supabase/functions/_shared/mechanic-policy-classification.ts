export type PolicyResearchConfidence = 'high' | 'medium' | 'low';

export interface CausalPolicyInput {
  targetingMode: 'tank' | 'selected_player' | 'group' | 'raid' | 'ground' | 'object' | 'none' | 'mixed';
  damageSemantics: 'mandatory' | 'avoidable' | 'partly_avoidable' | 'failure_consequence' | 'none';
  failurePropagation: 'self' | 'nearby_players' | 'group' | 'raid' | 'chained' | 'none';
  assignmentMode: 'none' | 'target_derived' | 'role_derived' | 'plan_optional' | 'plan_required';
  defensiveExpectation: 'none' | 'optional' | 'recommended' | 'required' | 'contingency_only';
  creditScope: 'resolver' | 'target' | 'group' | 'raid' | 'none';
  penaltyScope: 'owner' | 'assignee' | 'role' | 'raid_only' | 'none';
}

const CAUSAL_POLICY_VALUES = {
  targetingMode: new Set(['tank', 'selected_player', 'group', 'raid', 'ground', 'object', 'none', 'mixed']),
  damageSemantics: new Set(['mandatory', 'avoidable', 'partly_avoidable', 'failure_consequence', 'none']),
  failurePropagation: new Set(['self', 'nearby_players', 'group', 'raid', 'chained', 'none']),
  assignmentMode: new Set(['none', 'target_derived', 'role_derived', 'plan_optional', 'plan_required']),
  defensiveExpectation: new Set(['none', 'optional', 'recommended', 'required', 'contingency_only']),
  creditScope: new Set(['resolver', 'target', 'group', 'raid', 'none']),
  penaltyScope: new Set(['owner', 'assignee', 'role', 'raid_only', 'none']),
} as const;

export function validateCausalPolicy(value: unknown): value is CausalPolicyInput {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return Object.entries(CAUSAL_POLICY_VALUES).every(([key, allowed]) =>
    typeof policy[key] === 'string' && (allowed as ReadonlySet<string>).has(policy[key] as string),
  );
}

export function responsibilityModeFromClassification(responsibility: string | null | undefined): string {
  return ({
    tank: 'tank_role',
    healer: 'healer_role',
    dps: 'dps_role',
    personal: 'target',
    raid: 'raid',
  } as Record<string, string>)[responsibility ?? ''] ?? 'none';
}

export function applyPolicyConfidenceGuard(
  confidence: PolicyResearchConfidence,
  policy: CausalPolicyInput,
): {
  confidence: 'inferred' | 'uncertain';
  creditScope: CausalPolicyInput['creditScope'];
  penaltyScope: CausalPolicyInput['penaltyScope'];
} {
  return {
    confidence: confidence === 'low' ? 'uncertain' : 'inferred',
    creditScope: confidence === 'low' ? 'none' : policy.creditScope,
    penaltyScope: confidence === 'high' ? policy.penaltyScope : 'none',
  };
}
