import { defensiveSemanticError } from './defensive-classification-semantics.ts';
import type { EvaluationConfidence } from './combat-evaluation-contract.ts';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION,
  type ResolvedDefensive,
} from './effective-defensives.ts';

export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V6 = EFFECTIVE_DEFENSIVE_RESOLVER_VERSION;
export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V6 = EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION;
export const DEFENSIVE_EPISODE_EVALUATOR_VERSION_V6 = 'episode-evaluator@6';

export interface ObservedCastEvidenceV6 {
  spellId: number;
  samePull: boolean;
  pullTalentBuildFingerprint: string | null;
  source: 'stored_defensive_casts' | 'wcl_live_cast';
}

export function mergeObservedCastEvidenceV6(
  stored: readonly Omit<ObservedCastEvidenceV6, 'source'>[],
  liveSpellIds: readonly number[],
): ObservedCastEvidenceV6[] {
  const byKey = new Map<string, ObservedCastEvidenceV6>();
  for (const item of stored) {
    if (!Number.isInteger(item.spellId) || item.spellId <= 0) continue;
    const normalized: ObservedCastEvidenceV6 = { ...item, source: 'stored_defensive_casts' };
    byKey.set(`${item.spellId}:${item.samePull ? 'same' : item.pullTalentBuildFingerprint ?? 'null'}`, normalized);
  }
  for (const spellId of liveSpellIds) {
    if (!Number.isInteger(spellId) || spellId <= 0) continue;
    byKey.set(`${spellId}:same`, {
      spellId,
      samePull: true,
      pullTalentBuildFingerprint: null,
      source: 'wcl_live_cast',
    });
  }
  return [...byKey.values()].sort((a, b) => a.spellId - b.spellId || Number(b.samePull) - Number(a.samePull));
}

export interface DefensiveSemanticClosureViolation {
  spellId: number;
  error: string;
}

export function defensiveSemanticClosureViolationsV6(
  resolvedDefensives: readonly ResolvedDefensive[],
): DefensiveSemanticClosureViolation[] {
  const out: DefensiveSemanticClosureViolation[] = [];
  for (const r of resolvedDefensives) {
    const error = defensiveSemanticError({
      usageRole: r.usageRole,
      activationScope: r.activationScope,
      primaryBeneficiary: r.primaryBeneficiary,
      secondaryPropagation: r.secondaryPropagation,
      mechanisms: [...r.mechanisms],
      opportunityMode: r.opportunityMode,
    });
    if (error) out.push({ spellId: r.spellId, error });
    if (r.opportunityMode === 'normal' && r.usageRole !== 'personal_survival') {
      out.push({ spellId: r.spellId, error: 'normal opportunity must resolve to personal_survival' });
    }
    if (r.createsMissableOpportunity && !r.isDefensiveKitMember) {
      out.push({ spellId: r.spellId, error: 'missable opportunity cannot exist outside the resolved defensive kit' });
    }
  }
  return out;
}

function strong(confidence: EvaluationConfidence | undefined): boolean {
  return confidence === 'verified' || confidence === 'inferred';
}

export interface DefensiveScoreabilityViolation {
  spellId: number | null;
  error: string;
}

/**
 * Build-level scoreability guard. It deliberately checks only normal personal
 * resources that are actually members of this build. credit_only/passive/
 * healer/raid resources never rescue scoreability and never manufacture a
 * denominator.
 */
export function defensiveScoreabilityViolationsV6(
  resolvedDefensives: readonly ResolvedDefensive[],
): DefensiveScoreabilityViolation[] {
  const normal = resolvedDefensives.filter(
    (r) => r.isDefensiveKitMember && r.createsMissableOpportunity && r.usageRole === 'personal_survival' && r.opportunityMode === 'normal',
  );
  if (!normal.length) {
    const observedPersonal = resolvedDefensives.filter(
      (r) => r.buildPresence === 'present' && r.usageRole === 'personal_survival' && r.semanticStatus === 'verified',
    );
    if (observedPersonal.length) {
      return [{ spellId: null, error: 'personal defensive evidence exists but no normal scoreable resource resolved for this build' }];
    }
    return [];
  }

  const usable = normal.filter(
    (r) =>
      strong(r.buildPresenceConfidence as EvaluationConfidence) &&
      strong(r.semanticConfidence as EvaluationConfidence) &&
      strong((r.cooldownConfidence ?? r.confidence) as EvaluationConfidence) &&
      strong((r.chargesConfidence ?? r.confidence) as EvaluationConfidence) &&
      (r.charges <= 1 || strong((r.rechargeConfidence ?? r.confidence) as EvaluationConfidence)),
  );
  if (usable.length) return [];

  return normal.map((r) => ({
    spellId: r.spellId,
    error: `normal personal defensive is not availability-scoreable (membership=${r.buildPresenceConfidence}, cooldown=${r.cooldownConfidence ?? r.confidence}, charges=${r.chargesConfidence ?? r.confidence}, recharge=${r.rechargeConfidence ?? r.confidence})`,
  }));
}

/**
 * Invariant used by the Shadow runner: a stable active same-pull WCL self-cast
 * is positive acquisition evidence. Runtime-conditioned replacements/variants
 * are deliberately excluded here for the exact same reason they are excluded
 * by computeDemonstratedPersistentCastSpellIds(): observing the runtime spell
 * proves that runtime state occurred, not that the static build owns that
 * identity persistently.
 */
export function observedSelfCastAcquisitionViolationsV6(
  resolvedDefensives: readonly ResolvedDefensive[],
  liveSpellIds: readonly number[],
): DefensiveScoreabilityViolation[] {
  const live = new Set(liveSpellIds);
  return resolvedDefensives
    .filter((r) =>
      live.has(r.spellId) &&
      r.semanticStatus === 'verified' &&
      r.activationMode === 'active' &&
      Array.isArray(r.unresolvedRuntimeRules) &&
      r.unresolvedRuntimeRules.length === 0 &&
      r.buildPresence !== 'present'
    )
    .map((r) => ({ spellId: r.spellId, error: `same-pull WCL cast observed but buildPresence=${r.buildPresence}` }));
}
