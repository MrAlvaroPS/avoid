// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import type {
  EvaluationConfidence,
  MechanicPolicyContract,
  OccurrenceOutcome,
} from './combat-evaluation-contract.ts';
// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import { isPunitivePersonalMechanicEvent } from './mechanic-attribution.ts';

export const MECHANIC_ATTRIBUTION_SHADOW_VERSION =
  'mechanic-attribution-shadow@1.0.0' as const;

export const MECHANIC_ATTRIBUTION_SHADOW_STATUSES = [
  'verified',
  'role_only',
  'raid_only',
  'unresolved',
  'not_applicable',
] as const;
export type MechanicAttributionShadowStatus =
  (typeof MECHANIC_ATTRIBUTION_SHADOW_STATUSES)[number];

export const MECHANIC_ATTRIBUTION_SHADOW_REASONS = [
  'NO_FAILURE_TO_ATTRIBUTE',
  'OCCURRENCE_NOT_EVALUABLE',
  'IDENTITY_OR_POLICY_MISSING',
  'UNTRUSTED_EVIDENCE',
  'SEMANTIC_CONTRADICTION',
  'RAID_RESPONSIBILITY_ONLY',
  'ROLE_RESPONSIBILITY_ONLY',
  'NO_PUNITIVE_SCOPE',
  'DIRECT_PERSONAL_AVOIDABLE_GROUND',
  'PERSONAL_TARGET_REQUIRES_RESPONSE_EVIDENCE',
  'ASSIGNED_PLAYER_VERIFIED',
  'ASSIGNMENT_NOT_MATERIALIZED',
  'MULTI_ACTOR_PERSONAL_FAMILY_REQUIRES_OWNERSHIP',
  'UNSUPPORTED_PERSONAL_FAMILY',
  'PERSONAL_RESPONSIBILITY_WITHOUT_PLAYER_EVIDENCE',
  'SAFETY_V1_GUARD_BLOCKED_NEW_ACCUSATION',
] as const;
export type MechanicAttributionShadowReason =
  (typeof MECHANIC_ATTRIBUTION_SHADOW_REASONS)[number];

export interface MechanicAttributionShadowInput {
  outcome: OccurrenceOutcome;
  occurrenceConfidence: EvaluationConfidence;
  category: string | null | undefined;
  responsibility: string | null | undefined;
  playersHitNames: string[] | null | undefined;
  policy: MechanicPolicyContract | null;
  /** Explicit assignment evidence only. Never derive this from role membership. */
  assignedPlayers?: string[] | null;
}

export interface MechanicAttributionShadowDecision {
  status: MechanicAttributionShadowStatus;
  reason: MechanicAttributionShadowReason;
  responsiblePlayers: string[];
  /** What Safety v1 would currently be allowed to accuse for this occurrence. */
  safetyV1Players: string[];
  /** Hard invariant: must always be empty in shadow@1.0.0. */
  newAccusationPlayers: string[];
  confidence: EvaluationConfidence;
  evaluatorVersion: typeof MECHANIC_ATTRIBUTION_SHADOW_VERSION;
  evidenceClaims: string[];
}

function uniqueNames(names: string[] | null | undefined): string[] {
  return [
    ...new Set(
      (names ?? [])
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

function isTrusted(confidence: EvaluationConfidence): boolean {
  return confidence === 'verified' || confidence === 'inferred';
}

function weakestConfidence(
  a: EvaluationConfidence,
  b: EvaluationConfidence,
): EvaluationConfidence {
  const rank: Record<EvaluationConfidence, number> = {
    verified: 0,
    inferred: 1,
    fallback: 2,
    uncertain: 3,
  };
  return rank[a] >= rank[b] ? a : b;
}

function policyResponsibilityKind(
  policy: MechanicPolicyContract,
): 'personal' | 'tank' | 'healer' | 'dps' | 'raid' | 'none' {
  switch (policy.responsibilityMode) {
    case 'target':
    case 'assigned_player':
    case 'assigned_group':
      return 'personal';
    case 'tank_role':
      return 'tank';
    case 'healer_role':
      return 'healer';
    case 'dps_role':
      return 'dps';
    case 'raid':
    case 'volunteer':
      return 'raid';
    case 'none':
    default:
      return 'none';
  }
}

function decision(
  status: MechanicAttributionShadowStatus,
  reason: MechanicAttributionShadowReason,
  responsiblePlayers: string[],
  safetyV1Players: string[],
  confidence: EvaluationConfidence,
  evidenceClaims: string[],
): MechanicAttributionShadowDecision {
  const safetySet = new Set(safetyV1Players);
  const candidateResponsiblePlayers = uniqueNames(responsiblePlayers);
  const newAccusationPlayers = candidateResponsiblePlayers.filter((name) => !safetySet.has(name));

  // Shadow v1 may validate or reduce Safety v1, but never expand it. Enforce
  // this in code rather than relying on callers to remember the rule.
  if (newAccusationPlayers.length > 0) {
    return {
      status: 'unresolved',
      reason: 'SAFETY_V1_GUARD_BLOCKED_NEW_ACCUSATION',
      responsiblePlayers: [],
      safetyV1Players,
      newAccusationPlayers: [],
      confidence: 'uncertain',
      evaluatorVersion: MECHANIC_ATTRIBUTION_SHADOW_VERSION,
      evidenceClaims: [
        ...evidenceClaims,
        `blocked_new_accusations:${newAccusationPlayers.join(',')}`,
      ],
    };
  }

  return {
    status,
    reason,
    responsiblePlayers: candidateResponsiblePlayers,
    safetyV1Players,
    newAccusationPlayers: [],
    confidence,
    evaluatorVersion: MECHANIC_ATTRIBUTION_SHADOW_VERSION,
    evidenceClaims,
  };
}

/**
 * Canonical Attribution Shadow v1.
 *
 * It answers a deliberately narrow question: given a real failed occurrence,
 * how far can IRIS safely go in assigning ownership TODAY?
 *
 * It is non-punitive and monotonic relative to Attribution Safety v1:
 * - role/raid responsibility may be classified but never assigned to a player;
 * - spread/soak remain unresolved without carrier/participation evidence;
 * - personal-target remains unresolved until its required response can be
 *   proved (being selected/hit is not itself proof of failure);
 * - explicit personal avoidable-ground may verify only actors already allowed
 *   by Safety v1;
 * - no output can create a new player accusation.
 */
export function evaluateMechanicAttributionShadow(
  input: MechanicAttributionShadowInput,
): MechanicAttributionShadowDecision {
  const hitPlayers = uniqueNames(input.playersHitNames);
  const safetyV1Personal = isPunitivePersonalMechanicEvent({
    category: input.category,
    responsibility: input.responsibility,
  });
  const safetyV1Players = safetyV1Personal ? hitPlayers : [];
  const baseEvidence = [
    `outcome:${input.outcome}`,
    `category:${input.category ?? 'null'}`,
    `responsibility:${input.responsibility ?? 'null'}`,
    `hit_players:${hitPlayers.length}`,
  ];

  if (input.outcome === 'success') {
    return decision(
      'not_applicable',
      'NO_FAILURE_TO_ATTRIBUTE',
      [],
      safetyV1Players,
      input.occurrenceConfidence,
      baseEvidence,
    );
  }
  if (input.outcome === 'not_evaluable') {
    return decision(
      'not_applicable',
      'OCCURRENCE_NOT_EVALUABLE',
      [],
      safetyV1Players,
      'uncertain',
      baseEvidence,
    );
  }
  if (input.outcome === 'uncertain') {
    return decision(
      'unresolved',
      'UNTRUSTED_EVIDENCE',
      [],
      safetyV1Players,
      'uncertain',
      baseEvidence,
    );
  }
  if (!input.policy) {
    return decision(
      'unresolved',
      'IDENTITY_OR_POLICY_MISSING',
      [],
      safetyV1Players,
      'uncertain',
      baseEvidence,
    );
  }

  const combinedConfidence = weakestConfidence(
    input.occurrenceConfidence,
    input.policy.confidence,
  );
  if (!isTrusted(combinedConfidence)) {
    return decision(
      'unresolved',
      'UNTRUSTED_EVIDENCE',
      [],
      safetyV1Players,
      combinedConfidence,
      [...baseEvidence, `policy:${input.policy.mechanicKey}@${input.policy.policyVersion}`],
    );
  }

  const policyKind = policyResponsibilityKind(input.policy);
  const eventResponsibility = input.responsibility ?? null;
  const semanticEvidence = [
    ...baseEvidence,
    `policy:${input.policy.mechanicKey}@${input.policy.policyVersion}`,
    `policy_responsibility_mode:${input.policy.responsibilityMode}`,
    `policy_penalty_scope:${input.policy.penaltyScope}`,
  ];

  // A disagreement between classified event responsibility and canonical
  // policy is itself evidence that the attribution contract needs review.
  if (
    eventResponsibility != null &&
    policyKind !== 'none' &&
    eventResponsibility !== policyKind
  ) {
    return decision(
      'unresolved',
      'SEMANTIC_CONTRADICTION',
      [],
      safetyV1Players,
      'uncertain',
      [...semanticEvidence, `policy_kind:${policyKind}`],
    );
  }

  if (input.policy.penaltyScope === 'none') {
    return decision(
      'not_applicable',
      'NO_PUNITIVE_SCOPE',
      [],
      safetyV1Players,
      combinedConfidence,
      semanticEvidence,
    );
  }

  if (
    eventResponsibility === 'raid' ||
    policyKind === 'raid' ||
    input.policy.penaltyScope === 'raid_only'
  ) {
    return decision(
      'raid_only',
      'RAID_RESPONSIBILITY_ONLY',
      [],
      safetyV1Players,
      combinedConfidence,
      semanticEvidence,
    );
  }

  if (
    eventResponsibility === 'tank' ||
    eventResponsibility === 'healer' ||
    eventResponsibility === 'dps' ||
    policyKind === 'tank' ||
    policyKind === 'healer' ||
    policyKind === 'dps' ||
    input.policy.penaltyScope === 'role'
  ) {
    return decision(
      'role_only',
      'ROLE_RESPONSIBILITY_ONLY',
      [],
      safetyV1Players,
      combinedConfidence,
      semanticEvidence,
    );
  }

  // Personal attribution requires explicit personal semantics in the source
  // event. Historical category fallback remains visible in safetyV1Players but
  // is not promoted to canonical ownership.
  if (eventResponsibility !== 'personal') {
    return decision(
      'unresolved',
      'PERSONAL_RESPONSIBILITY_WITHOUT_PLAYER_EVIDENCE',
      [],
      safetyV1Players,
      'uncertain',
      semanticEvidence,
    );
  }

  const assignedPlayers = uniqueNames(input.assignedPlayers);
  if (
    input.policy.responsibilityMode === 'assigned_player' ||
    input.policy.responsibilityMode === 'assigned_group'
  ) {
    if (assignedPlayers.length === 0) {
      return decision(
        'unresolved',
        'ASSIGNMENT_NOT_MATERIALIZED',
        [],
        safetyV1Players,
        'uncertain',
        semanticEvidence,
      );
    }
    return decision(
      'verified',
      'ASSIGNED_PLAYER_VERIFIED',
      assignedPlayers,
      safetyV1Players,
      combinedConfidence,
      [...semanticEvidence, `assigned_players:${assignedPlayers.join(',')}`],
    );
  }

  if (safetyV1Players.length === 0) {
    return decision(
      'unresolved',
      'PERSONAL_RESPONSIBILITY_WITHOUT_PLAYER_EVIDENCE',
      [],
      safetyV1Players,
      'uncertain',
      semanticEvidence,
    );
  }

  if (input.category === 'avoidable-ground') {
    return decision(
      'verified',
      'DIRECT_PERSONAL_AVOIDABLE_GROUND',
      safetyV1Players,
      safetyV1Players,
      combinedConfidence,
      semanticEvidence,
    );
  }

  if (input.category === 'personal-target') {
    return decision(
      'unresolved',
      'PERSONAL_TARGET_REQUIRES_RESPONSE_EVIDENCE',
      [],
      safetyV1Players,
      'uncertain',
      semanticEvidence,
    );
  }

  if (input.category === 'spread' || input.category === 'soak') {
    return decision(
      'unresolved',
      'MULTI_ACTOR_PERSONAL_FAMILY_REQUIRES_OWNERSHIP',
      [],
      safetyV1Players,
      'uncertain',
      semanticEvidence,
    );
  }

  return decision(
    'unresolved',
    'UNSUPPORTED_PERSONAL_FAMILY',
    [],
    safetyV1Players,
    'uncertain',
    semanticEvidence,
  );
}
