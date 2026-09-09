import type { EvaluationConfidence } from './combat-evaluation-contract.ts';
import type { TimingRelation } from './defensive-applicability.ts';
import type {
  DefensiveOpportunityMode,
  DefensiveUsageRole,
} from './defensive-classification-semantics.ts';
import type {
  BuildPresence,
  DefensiveEffectiveResolutionStatus,
  ResolvedDefensive,
} from './effective-defensives.ts';

/**
 * Stable, additive snapshot of the already-resolved effective kit. This is
 * presentation/audit evidence, not another resolver: every value is copied
 * from ResolvedDefensive produced by the canonical worker for this exact pull.
 */
export interface EffectiveDefensiveAuditFact {
  spellId: number;
  name: string;
  isDefensiveKitMember: boolean;
  createsMissableOpportunity: boolean;
  usageRole: DefensiveUsageRole;
  opportunityMode: DefensiveOpportunityMode;
  timingRelation: TimingRelation | null;
  effectiveCooldownMs: number | null;
  effectiveDurationMs: number | null;
  charges: number;
  rechargeMs: number | null;
  cooldownConfidence: EvaluationConfidence;
  durationConfidence: EvaluationConfidence;
  chargesConfidence: EvaluationConfidence;
  rechargeConfidence: EvaluationConfidence;
  membershipConfidence: EvaluationConfidence;
  applicabilityConfidence: 'high' | 'medium' | 'low' | null;
  buildPresence: BuildPresence;
  resolutionStatus: DefensiveEffectiveResolutionStatus;
  unresolvedRuntimeRuleCount: number;
}

function confidence(value: ResolvedDefensive['confidence'] | undefined): EvaluationConfidence {
  return value ?? 'uncertain';
}

export function buildEffectiveDefensiveAuditFacts(
  resolved: readonly ResolvedDefensive[],
): EffectiveDefensiveAuditFact[] {
  return resolved
    .map((entry) => ({
      spellId: entry.spellId,
      name: entry.name,
      isDefensiveKitMember: entry.isDefensiveKitMember,
      createsMissableOpportunity: entry.createsMissableOpportunity,
      usageRole: entry.usageRole,
      opportunityMode: entry.opportunityMode,
      timingRelation: entry.applicability?.timingRelation ?? null,
      effectiveCooldownMs: entry.effectiveCooldownMs,
      effectiveDurationMs: entry.effectiveDurationMs,
      charges: entry.charges,
      rechargeMs: entry.rechargeMs,
      cooldownConfidence: confidence(entry.cooldownConfidence ?? entry.confidence),
      durationConfidence: confidence(entry.durationConfidence ?? entry.confidence),
      chargesConfidence: confidence(entry.chargesConfidence ?? entry.confidence),
      rechargeConfidence: confidence(entry.rechargeConfidence ?? entry.confidence),
      membershipConfidence: confidence(
        entry.semanticConfidence === 'uncertain' || entry.buildPresenceConfidence === 'uncertain'
          ? 'uncertain'
          : entry.semanticConfidence === 'fallback' || entry.buildPresenceConfidence === 'fallback'
            ? 'fallback'
            : entry.semanticConfidence === 'inferred' || entry.buildPresenceConfidence === 'inferred'
              ? 'inferred'
              : 'verified',
      ),
      applicabilityConfidence: entry.applicabilityConfidence,
      buildPresence: entry.buildPresence,
      resolutionStatus: entry.resolutionStatus,
      unresolvedRuntimeRuleCount: entry.unresolvedRuntimeRules.length,
    }))
    .sort((a, b) => a.spellId - b.spellId);
}
