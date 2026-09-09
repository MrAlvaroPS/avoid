import { aggregateDefensiveEpisodeKpis } from './defensive-episode-kpis.ts';
import { chargeAvailabilityAt, type DefensiveCooldown } from './defensive-cooldowns.ts';
import type { PersistedDefensiveEpisode, PersistedEpisodeVerdictCandidate } from './defensive-episode-persistence.ts';
import type { EffectiveDefensiveAuditFact } from './defensive-audit-facts.ts';
import { DEFENSIVE_EPISODE_EVALUATOR_VERSION_V8 } from './defensive-evidence-v8.ts';
import {
  DEFENSIVE_NIGHT_AUDIT_VERSION,
  type ActionableTimingWindow,
  type AuditConfidence,
  type AuditTimingRelation,
  type AuditTriState,
  type DefensiveAuditAbilitySummary,
  type DefensiveAuditState,
  type DefensiveCastAudit,
  type DefensiveCastEpisodeAssociation,
  type DefensiveCastPrimaryClassification,
  type DefensiveCastReasonCode,
  type DefensiveEpisodeAudit,
  type DefensiveNightAudit,
  type DefensiveResourceUniverse,
} from './player-defensive-audit-contract.ts';
import {
  buildDefensiveAuditNarrative,
  chunkDefensiveNarrativeForDiscord,
  formatFightTime,
} from './player-defensive-audit-narrative.ts';

export interface DefensiveAuditGenerationInput {
  id: string;
  status: string;
  publishedAt: string | null;
  evaluatorVersion: string | null;
  episodeVersion: string | null;
  resolverVersion: string;
  semanticResolverVersion: string;
  semanticVersion: string;
  gameBuild: string;
}

export interface DefensiveAuditPullInput {
  pullId: string;
  reportCode: string;
  fightId: number;
  bossId: string;
  bossName: string | null;
  difficulty: string;
  pullNumber: number | null;
  canonical: boolean;
  evaluationEndMs: number | null;
  playerParticipated: boolean;
  buildFingerprint: string | null;
  defensiveCasts: { spellId: number; name: string; timestampsMs: number[] }[];
  mechanicNamesByAbilityId: Record<string, string>;
}

export interface DefensiveAuditEvaluationRowInput {
  pullId: string;
  playerName: string;
  episodeEvaluatorVersion: string;
  semanticVersion: string;
  semanticResolverVersion: string;
  resolverVersion: string;
  buildFingerprint: string | null;
  effectiveKit: EffectiveDefensiveAuditFact[];
  episodes: PersistedDefensiveEpisode[];
  evaluatedAt: string;
}

export interface BuildDefensiveNightAuditInput {
  reportCode: string;
  playerName: string;
  generatedAt: string;
  pointerStable: boolean;
  generation: DefensiveAuditGenerationInput | null;
  pulls: DefensiveAuditPullInput[];
  rows: DefensiveAuditEvaluationRowInput[];
}

const PRIMARY_VALUES: DefensiveCastPrimaryClassification[] = [
  'effective',
  'relevant_ineffective',
  'relevant_uncertain',
  'outside_evaluable_pressure',
  'excluded',
];

const CONFIDENCE_RANK: Record<AuditConfidence, number> = {
  verified: 0,
  inferred: 1,
  fallback: 2,
  uncertain: 3,
};

function weakest(...values: AuditConfidence[]): AuditConfidence {
  return values.reduce((result, value) => CONFIDENCE_RANK[value] > CONFIDENCE_RANK[result] ? value : result, 'verified');
}

function strong(value: AuditConfidence | undefined): boolean {
  return value === 'verified' || value === 'inferred';
}

function emptyPrimary(): Record<DefensiveCastPrimaryClassification, number> {
  return { effective: 0, relevant_ineffective: 0, relevant_uncertain: 0, outside_evaluable_pressure: 0, excluded: 0 };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function baseAudit(input: BuildDefensiveNightAuditInput, state: DefensiveAuditState, message: string): DefensiveNightAudit {
  const generation = input.generation;
  const canonical = input.pulls.filter((pull) => pull.canonical);
  return {
    state,
    statusMessage: message,
    reportCode: input.reportCode,
    playerName: input.playerName,
    metadata: {
      auditVersion: DEFENSIVE_NIGHT_AUDIT_VERSION,
      generationId: generation?.id ?? null,
      generationPublishedAt: generation?.publishedAt ?? null,
      evaluatorVersion: generation?.evaluatorVersion ?? null,
      resolverVersion: generation?.resolverVersion ?? null,
      semanticResolverVersion: generation?.semanticResolverVersion ?? null,
      semanticVersion: generation?.semanticVersion ?? null,
      gameBuild: generation?.gameBuild ?? null,
      evaluatedPulls: input.rows.length,
      expectedPulls: canonical.length,
      generatedAt: input.generatedAt,
      sourceFingerprint: generation ? `${DEFENSIVE_NIGHT_AUDIT_VERSION}:${fnv1a(stableJson({
        generation: generation.id,
        rows: input.rows.map((row) => [row.pullId, row.evaluatedAt, row.buildFingerprint]),
        casts: input.pulls.map((pull) => [pull.pullId, pull.defensiveCasts]),
      }))}` : null,
    },
    universe: {
      participatedPulls: input.pulls.filter((pull) => pull.playerParticipated).length,
      canonicalPulls: canonical.length,
      excludedPulls: input.pulls.filter((pull) => pull.playerParticipated && !pull.canonical).length,
      totalObservedCasts: input.pulls.reduce((sum, pull) => sum + pull.defensiveCasts.reduce((n, cast) => n + cast.timestampsMs.length, 0), 0),
      totalCoreCasts: 0,
      totalCreditOnlyCasts: 0,
      totalNonPersonalOrUnresolvedCasts: 0,
      coreByPrimary: emptyPrimary(),
      totalEpisodes: 0,
    },
    usage: { score: null, engaged: 0, evaluable: 0 },
    response: { score: null, covered: 0, evaluable: 0, missedReady: 0, missedMistimed: 0 },
    context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 0, excluded: 0 },
    abilities: [],
    casts: [],
    episodes: [],
    integrityIssues: [],
    narrative: null,
    discordParts: [],
  };
}

export function defensiveAuditFailure(
  reportCode: string,
  playerName: string,
  generatedAt: string,
  state: Exclude<DefensiveAuditState, 'available'>,
  message: string,
): DefensiveNightAudit {
  return baseAudit({ reportCode, playerName, generatedAt, pointerStable: true, generation: null, pulls: [], rows: [] }, state, message);
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sortedFiniteNumbers(value: unknown): number[] {
  return numberArray(value).sort((a, b) => a - b);
}

function sameNumbers(left: unknown, right: unknown): boolean {
  const a = sortedFiniteNumbers(left);
  const b = sortedFiniteNumbers(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function includesTimestamp(value: unknown, castMs: number): boolean {
  return numberArray(value).includes(castMs);
}

interface PerCastTemporalProjection {
  associated: boolean;
  coverage: AuditTriState;
  reasonCode: DefensiveCastReasonCode;
  evidence: Record<string, unknown>;
}

function beforeOrDuringProjection(
  temporal: Record<string, unknown>,
  castMs: number,
  peakMs: number,
  candidateCoverage: AuditTriState,
): PerCastTemporalProjection {
  const establishing = numberArray(temporal['establishingCasts']);
  const relevant = numberArray(temporal['relevantCasts']);
  const theoretical = numberArray(temporal['theoreticallyCoveringCasts']);
  const contradicted = numberArray(temporal['contradictedCasts']);
  const unresolved = numberArray(temporal['unresolvedCasts']);
  if (establishing.includes(castMs)) {
    return { associated: true, coverage: 'yes', reasonCode: 'covered_by_canonical_verdict', evidence: temporal };
  }
  if (!relevant.includes(castMs) && !theoretical.includes(castMs) && !contradicted.includes(castMs) && !unresolved.includes(castMs)) {
    return { associated: false, coverage: 'no', reasonCode: 'outside_evaluable_pressure', evidence: {} };
  }
  if (contradicted.includes(castMs)) {
    return { associated: true, coverage: 'no', reasonCode: 'observed_aura_contradiction', evidence: temporal };
  }
  if (unresolved.includes(castMs)) {
    return { associated: true, coverage: 'unknown', reasonCode: 'coverage_unknown', evidence: temporal };
  }
  if (castMs > peakMs) {
    return { associated: true, coverage: 'no', reasonCode: 'late_after_peak', evidence: temporal };
  }
  if (!theoretical.includes(castMs)) {
    return { associated: true, coverage: 'no', reasonCode: 'effect_expired_before_peak', evidence: temporal };
  }
  if (candidateCoverage === 'yes') {
    return { associated: true, coverage: 'yes', reasonCode: 'covered_by_canonical_verdict', evidence: temporal };
  }
  if (candidateCoverage === 'unknown') {
    return { associated: true, coverage: 'unknown', reasonCode: 'coverage_unknown', evidence: temporal };
  }
  return { associated: true, coverage: 'no', reasonCode: 'relevant_but_not_covering', evidence: temporal };
}

function afterDamageProjection(
  temporal: Record<string, unknown>,
  castMs: number,
  episode: PersistedDefensiveEpisode,
): PerCastTemporalProjection {
  const relevant = numberArray(temporal['relevantCasts']);
  if (relevant.includes(castMs)) {
    return { associated: true, coverage: 'yes', reasonCode: 'covered_by_canonical_verdict', evidence: temporal };
  }
  const windows = Array.isArray(temporal['windows'])
    ? temporal['windows'].map(record).filter((window) => typeof window['hitMs'] === 'number' && typeof window['endMs'] === 'number')
    : [];
  const insidePressureSpan = castMs >= episode.startMs && castMs <= episode.endMs;
  const aroundObservedWindows = windows.some((window) =>
    castMs >= Number(window['hitMs']) && castMs <= Math.max(episode.endMs, Number(window['endMs']))
  );
  if (insidePressureSpan || aroundObservedWindows) {
    return { associated: true, coverage: 'no', reasonCode: 'reactive_window_missed', evidence: temporal };
  }
  return { associated: false, coverage: 'no', reasonCode: 'outside_evaluable_pressure', evidence: {} };
}

function projectTemporalForCast(
  candidate: PersistedEpisodeVerdictCandidate,
  episode: PersistedDefensiveEpisode,
  castMs: number,
): PerCastTemporalProjection {
  const temporal = record(candidate.evidence?.['temporal']);
  const relation = (candidate.timing?.timingRelation ?? temporal['timingRelation'] ?? null) as AuditTimingRelation;
  if (relation === 'before_or_during') {
    return beforeOrDuringProjection(temporal, castMs, episode.peakMs, candidate.temporalCastCoverage);
  }
  if (relation === 'after_damage') return afterDamageProjection(temporal, castMs, episode);
  if (relation === 'either') {
    const proactiveOuter = record(temporal['proactive']);
    const reactiveOuter = record(temporal['reactive']);
    const proactive = beforeOrDuringProjection(record(proactiveOuter['evidence']), castMs, episode.peakMs, (proactiveOuter['castCoverage'] ?? 'unknown') as AuditTriState);
    const reactive = afterDamageProjection(record(reactiveOuter['evidence']), castMs, episode);
    const choices = [proactive, reactive].filter((item) => item.associated);
    if (!choices.length) return { associated: false, coverage: 'no', reasonCode: 'outside_evaluable_pressure', evidence: {} };
    const winner = choices.sort((a, b) => ({ yes: 0, unknown: 1, no: 2 }[a.coverage] - { yes: 0, unknown: 1, no: 2 }[b.coverage]))[0];
    return { ...winner, evidence: { proactive: proactive.evidence, reactive: reactive.evidence } };
  }
  if (relation === 'continuous_state') {
    const establishing = numberArray(temporal['establishingCasts']);
    if (establishing.includes(castMs)) return { associated: true, coverage: 'yes', reasonCode: 'covered_by_canonical_verdict', evidence: temporal };
    if (includesTimestamp(temporal['relevantCasts'], castMs)) {
      return { associated: true, coverage: 'unknown', reasonCode: 'continuous_state_unobserved', evidence: temporal };
    }
    return { associated: false, coverage: 'no', reasonCode: 'outside_evaluable_pressure', evidence: {} };
  }
  if (includesTimestamp(temporal['relevantCasts'], castMs)) {
    return { associated: true, coverage: 'unknown', reasonCode: 'timing_unknown', evidence: temporal };
  }
  return { associated: false, coverage: 'no', reasonCode: 'outside_evaluable_pressure', evidence: {} };
}

function resourceUniverse(fact: EffectiveDefensiveAuditFact | undefined): DefensiveResourceUniverse {
  if (!fact?.isDefensiveKitMember) return 'non_personal_or_unresolved';
  return fact.createsMissableOpportunity ? 'core' : 'credit_only';
}

function availabilityAdapter(fact: EffectiveDefensiveAuditFact): DefensiveCooldown {
  return {
    spellId: fact.spellId,
    name: fact.name,
    class: '',
    spec: null,
    specOverride: null,
    category: 'personal_defensive',
    baseCooldownMs: fact.effectiveCooldownMs,
    durationMs: fact.effectiveDurationMs,
    survivalType: null,
  };
}

function rechargeFinishTimes(casts: readonly number[], rechargeMs: number): number[] {
  let finish = -Infinity;
  return [...casts].sort((a, b) => a - b).map((cast) => {
    finish = Math.max(cast, finish) + rechargeMs;
    return finish;
  });
}

function readyIntervals(
  fact: EffectiveDefensiveAuditFact,
  casts: readonly number[],
  lower: number,
  upper: number,
): { startMs: number; endMs: number }[] {
  const sortedCasts = [...casts].filter(Number.isFinite).sort((a, b) => a - b);
  const transitions = new Set<number>([lower, upper]);
  for (const cast of sortedCasts) {
    if (cast >= lower && cast <= upper) {
      transitions.add(cast);
      transitions.add(Math.min(upper, cast + 1));
    }
  }
  if (fact.charges > 1 && fact.rechargeMs != null) {
    for (const finish of rechargeFinishTimes(sortedCasts, fact.rechargeMs)) {
      if (finish >= lower && finish <= upper) transitions.add(finish);
    }
  } else if (fact.effectiveCooldownMs != null) {
    for (const cast of sortedCasts) {
      const finish = cast + fact.effectiveCooldownMs;
      if (finish >= lower && finish <= upper) transitions.add(finish);
    }
  }
  const points = [...transitions].sort((a, b) => a - b);
  const intervals: { startMs: number; endMs: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const startMs = points[i];
    const endMs = points[i + 1] ?? upper;
    const at = startMs;
    const status = chargeAvailabilityAt(availabilityAdapter(fact), fact.charges, fact.rechargeMs, sortedCasts, at).status;
    if (status !== 'available_unused') continue;
    const previous = intervals.at(-1);
    if (previous && previous.endMs === startMs) previous.endMs = endMs;
    else intervals.push({ startMs, endMs });
  }
  return intervals.filter((interval) => interval.endMs >= interval.startMs);
}

function temporalEvidenceHasAuraContradiction(candidate: PersistedEpisodeVerdictCandidate): boolean {
  const temporal = record(candidate.evidence?.['temporal']);
  if (temporal['observedNegativePrecedence'] === true) return true;
  const proactive = record(record(temporal['proactive'])['evidence']);
  return proactive['observedNegativePrecedence'] === true;
}

export function actionableTimingWindow(
  fact: EffectiveDefensiveAuditFact,
  candidate: PersistedEpisodeVerdictCandidate,
  episode: PersistedDefensiveEpisode,
): ActionableTimingWindow {
  const confidence = weakest(
    candidate.membershipConfidence ?? candidate.confidence,
    candidate.applicabilityClaimConfidence ?? candidate.confidence,
    candidate.availabilityConfidence ?? candidate.confidence,
  );
  if (!strong(candidate.membershipConfidence ?? candidate.confidence) || !fact.isDefensiveKitMember || !fact.createsMissableOpportunity) {
    return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'weak_membership', confidence };
  }
  if (candidate.damageApplicability !== 'yes' || !strong(candidate.applicabilityClaimConfidence ?? candidate.confidence)) {
    return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'weak_applicability', confidence };
  }
  if (candidate.statusAtPeak !== 'available_unused') {
    return { status: 'unavailable', earliestMs: null, latestMs: null, reasonCode: 'resource_unavailable', confidence };
  }
  if (!strong(candidate.availabilityConfidence ?? candidate.confidence) || !strong(fact.cooldownConfidence) || !strong(fact.chargesConfidence) || (fact.charges > 1 && !strong(fact.rechargeConfidence))) {
    return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'weak_availability', confidence };
  }
  if (fact.resolutionStatus !== 'resolved' || fact.unresolvedRuntimeRuleCount > 0) {
    return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'runtime_rule_unresolved', confidence };
  }
  if (temporalEvidenceHasAuraContradiction(candidate)) {
    return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'observed_aura_contradiction', confidence };
  }
  const relation = candidate.timing?.timingRelation ?? fact.timingRelation;
  const cutoff = candidate.timing?.evaluationEndMs ?? Number.POSITIVE_INFINITY;
  const casts = candidate.castsForSpellMs ?? [];
  const inferredStatus = confidence === 'verified' ? 'verified' : 'inferred';

  const proactive = (): ActionableTimingWindow => {
    if (fact.effectiveDurationMs == null || !strong(fact.durationConfidence)) {
      return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'duration_unknown', confidence };
    }
    const lower = Math.max(0, episode.peakMs - fact.effectiveDurationMs);
    const upper = Math.min(episode.peakMs, cutoff);
    const interval = readyIntervals(fact, casts, lower, upper).at(-1);
    if (!interval) return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'no_verified_ready_in_window', confidence };
    return { status: inferredStatus, earliestMs: interval.startMs, latestMs: interval.endMs, reasonCode: 'proactive_window', confidence };
  };

  const reactive = (): ActionableTimingWindow => {
    const temporal = record(candidate.evidence?.['temporal']);
    const outer = relation === 'either' ? record(record(temporal['reactive'])['evidence']) : temporal;
    const windows = Array.isArray(outer['windows']) ? outer['windows'].map(record) : [];
    for (const window of windows) {
      if (typeof window['hitMs'] !== 'number' || typeof window['endMs'] !== 'number') continue;
      const lower = Number(window['hitMs']);
      const upper = Math.min(Number(window['endMs']), cutoff);
      const interval = readyIntervals(fact, casts, lower, upper).at(-1);
      if (interval) return { status: inferredStatus, earliestMs: interval.startMs, latestMs: interval.endMs, reasonCode: 'reactive_window', confidence };
    }
    return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'no_verified_ready_in_window', confidence };
  };

  if (relation === 'before_or_during') return proactive();
  if (relation === 'after_damage') return reactive();
  if (relation === 'either') {
    const proactiveResult = proactive();
    return proactiveResult.status === 'verified' || proactiveResult.status === 'inferred' ? proactiveResult : reactive();
  }
  return { status: 'uncertain', earliestMs: null, latestMs: null, reasonCode: 'timing_unknown', confidence };
}

function buildAssociation(
  cast: DefensiveCastAudit,
  episode: PersistedDefensiveEpisode,
  candidate: PersistedEpisodeVerdictCandidate,
): DefensiveCastEpisodeAssociation | null {
  const temporal = projectTemporalForCast(candidate, episode, cast.castMs);
  if (!temporal.associated) return null;
  let reasonCode = temporal.reasonCode;
  if (candidate.damageApplicability === 'unknown') reasonCode = 'applicability_unknown';
  else if (temporal.coverage === 'unknown') reasonCode = candidate.timing?.timingRelation == null ? 'timing_unknown' : 'coverage_unknown';
  const isCoveredBySpell = episode.coveredBySpellId === cast.spellId;
  const gaveResponseCredit = isCoveredBySpell && temporal.coverage === 'yes' && episode.responseVerdict === 'covered_verified';
  if (gaveResponseCredit) reasonCode = 'covered_by_canonical_verdict';
  return {
    episodeId: episode.episodeId,
    startMs: episode.startMs,
    peakMs: episode.peakMs,
    endMs: episode.endMs,
    deltaFromPeakMs: cast.castMs - episode.peakMs,
    timingRelation: candidate.timing?.timingRelation ?? null,
    engagement: candidate.engagement,
    castCoverage: temporal.coverage,
    responseVerdict: episode.responseVerdict,
    isCoveredBySpell,
    gaveUsageCredit: candidate.engagement && episode.usedSpellIds.includes(cast.spellId),
    gaveResponseCredit,
    reasonCode,
    evidence: temporal.evidence,
  };
}

function primaryClassification(cast: DefensiveCastAudit): DefensiveCastPrimaryClassification {
  if (cast.scope !== 'canonical_evaluable') return 'excluded';
  if (cast.associations.some((association) => association.gaveResponseCredit)) return 'effective';
  if (cast.associations.some((association) => association.castCoverage === 'unknown' || association.reasonCode === 'applicability_unknown' || association.responseVerdict === 'uncertain')) {
    return 'relevant_uncertain';
  }
  if (cast.associations.length) return 'relevant_ineffective';
  return 'outside_evaluable_pressure';
}

function abilitySummaries(casts: readonly DefensiveCastAudit[], episodes: readonly DefensiveEpisodeAudit[]): DefensiveAuditAbilitySummary[] {
  const byAbility = new Map<string, DefensiveAuditAbilitySummary>();
  for (const cast of casts) {
    const key = `${cast.spellId}:${cast.resourceUniverse}`;
    const item = byAbility.get(key) ?? {
      spellId: cast.spellId,
      spellName: cast.spellName,
      resourceUniverse: cast.resourceUniverse,
      totalCasts: 0,
      effectiveCasts: 0,
      relevantIneffectiveCasts: 0,
      relevantUncertainCasts: 0,
      outsidePressureCasts: 0,
      excludedCasts: 0,
      usageEpisodes: 0,
      responseEpisodes: 0,
    };
    item.totalCasts++;
    if (cast.primaryClassification === 'effective') item.effectiveCasts++;
    else if (cast.primaryClassification === 'relevant_ineffective') item.relevantIneffectiveCasts++;
    else if (cast.primaryClassification === 'relevant_uncertain') item.relevantUncertainCasts++;
    else if (cast.primaryClassification === 'outside_evaluable_pressure') item.outsidePressureCasts++;
    else item.excludedCasts++;
    byAbility.set(key, item);
  }
  for (const item of byAbility.values()) {
    item.usageEpisodes = episodes.filter((episode) => episode.castIds.some((castId) =>
      casts.some((cast) => cast.castId === castId && cast.spellId === item.spellId && cast.associations.some((association) => association.episodeId === episode.episodeId && association.gaveUsageCredit))
    )).length;
    item.responseEpisodes = episodes.filter((episode) => episode.coveredBySpellId === item.spellId && episode.responseVerdict === 'covered_verified').length;
  }
  return [...byAbility.values()].sort((a, b) => {
    const rank: Record<DefensiveResourceUniverse, number> = { core: 0, credit_only: 1, non_personal_or_unresolved: 2 };
    return rank[a.resourceUniverse] - rank[b.resourceUniverse] || b.totalCasts - a.totalCasts || a.spellId - b.spellId;
  });
}

function validateAudit(audit: DefensiveNightAudit): string[] {
  const issues: string[] = [];
  const castIds = new Set<string>();
  for (const cast of audit.casts) {
    if (castIds.has(cast.castId)) issues.push(`duplicate_cast_id:${cast.castId}`);
    castIds.add(cast.castId);
    if (cast.reportCode !== audit.reportCode) issues.push(`cast_report_mismatch:${cast.castId}`);
    for (const association of cast.associations) {
      if (association.deltaFromPeakMs !== cast.castMs - association.peakMs) issues.push(`cast_delta_mismatch:${cast.castId}:${association.episodeId}`);
    }
  }
  const episodeIds = new Set<string>();
  for (const episode of audit.episodes) {
    if (episodeIds.has(episode.episodeId)) issues.push(`duplicate_episode_id:${episode.episodeId}`);
    episodeIds.add(episode.episodeId);
    if (episode.coveredBySpellId != null && !episode.coveredBySpellName) issues.push(`covered_spell_missing:${episode.episodeId}:${episode.coveredBySpellId}`);
    for (const castId of episode.castIds) if (!castIds.has(castId)) issues.push(`episode_unknown_cast:${episode.episodeId}:${castId}`);
  }
  for (const cast of audit.casts) {
    for (const association of cast.associations) if (!episodeIds.has(association.episodeId)) issues.push(`association_unknown_episode:${cast.castId}:${association.episodeId}`);
  }
  if (audit.usage.engaged > audit.usage.evaluable) issues.push('usage_numerator_exceeds_denominator');
  if (audit.response.covered > audit.response.evaluable) issues.push('response_numerator_exceeds_denominator');
  const corePartition = Object.values(audit.universe.coreByPrimary).reduce((sum, count) => sum + count, 0);
  if (corePartition !== audit.universe.totalCoreCasts) issues.push(`core_cast_partition_mismatch:${corePartition}:${audit.universe.totalCoreCasts}`);
  for (const episode of audit.episodes) {
    for (const alternative of episode.alternatives) {
      if (!strong(alternative.confidence)) issues.push(`weak_alternative:${episode.episodeId}:${alternative.spellId}`);
    }
  }
  return [...new Set(issues)].sort();
}

export function buildDefensiveNightAudit(input: BuildDefensiveNightAuditInput): DefensiveNightAudit {
  const generation = input.generation;
  if (!generation) return baseAudit(input, 'unavailable', 'No hay una generación defensiva publicada disponible.');
  if (!input.pointerStable) return baseAudit(input, 'incompatible', 'La generación publicada cambió durante la lectura; vuelve a cargar para obtener una auditoría atómica.');
  if (generation.status !== 'published') return baseAudit(input, 'incompatible', 'La generación defensiva seleccionada no está publicada.');
  if (generation.evaluatorVersion !== DEFENSIVE_EPISODE_EVALUATOR_VERSION_V8 || generation.episodeVersion !== DEFENSIVE_EPISODE_EVALUATOR_VERSION_V8) {
    return baseAudit(input, 'incompatible', `La generación publicada usa ${generation.evaluatorVersion ?? 'una versión desconocida'} y todavía no contiene el contrato de auditoría v8.`);
  }

  const canonicalPulls = input.pulls.filter((pull) => pull.canonical).sort((a, b) => a.fightId - b.fightId);
  const expectedIds = new Set(canonicalPulls.map((pull) => pull.pullId));
  const pullIds = input.pulls.map((pull) => pull.pullId);
  const rowIds = input.rows.map((row) => row.pullId);
  if (
    new Set(pullIds).size !== pullIds.length ||
    new Set(rowIds).size !== rowIds.length ||
    input.pulls.some((pull) => pull.reportCode !== input.reportCode) ||
    input.rows.some((row) => !expectedIds.has(row.pullId))
  ) {
    return baseAudit(input, 'incompatible', 'La identidad de pulls o filas no coincide con el report y la población canónica publicados.');
  }
  const rowsByPull = new Map(input.rows.filter((row) => expectedIds.has(row.pullId)).map((row) => [row.pullId, row]));
  const unsafeRows = input.rows.filter((row) =>
    row.playerName !== input.playerName ||
    row.episodeEvaluatorVersion !== generation.evaluatorVersion ||
    row.semanticVersion !== generation.semanticVersion ||
    row.semanticResolverVersion !== generation.semanticResolverVersion ||
    row.resolverVersion !== generation.resolverVersion ||
    !Array.isArray(row.effectiveKit)
  );
  if (unsafeRows.length) return baseAudit(input, 'incompatible', 'Hay filas defensivas cuya identidad de versión no coincide con la generación publicada.');
  if (rowsByPull.size < expectedIds.size) {
    return baseAudit(input, 'partial', `Auditoría defensiva actualizándose: ${rowsByPull.size}/${expectedIds.size} pulls disponibles.`);
  }

  const audit = baseAudit(input, 'available', 'Auditoría defensiva disponible.');
  const rawEpisodeById = new Map<string, PersistedDefensiveEpisode>();
  const kitByPull = new Map<string, Map<number, EffectiveDefensiveAuditFact>>();
  const allKitByBuildAndSpell = new Map<string, EffectiveDefensiveAuditFact>();
  const projectionIssues: string[] = [];

  for (const pull of canonicalPulls) {
    const row = rowsByPull.get(pull.pullId)!;
    if (row.buildFingerprint !== pull.buildFingerprint) {
      projectionIssues.push(`build_fingerprint_mismatch:${pull.pullId}`);
    }
    const kit = new Map<number, EffectiveDefensiveAuditFact>();
    for (const fact of row.effectiveKit) {
      if (kit.has(fact.spellId)) projectionIssues.push(`duplicate_kit_spell:${pull.pullId}:${fact.spellId}`);
      kit.set(fact.spellId, fact);
      allKitByBuildAndSpell.set(`${row.buildFingerprint ?? 'null'}:${fact.spellId}`, fact);
    }
    kitByPull.set(pull.pullId, kit);
    for (const episode of row.episodes) {
      if (rawEpisodeById.has(episode.episodeId)) projectionIssues.push(`duplicate_episode_id:${episode.episodeId}`);
      if (!Number.isFinite(episode.peakValue)) projectionIssues.push(`missing_peak_value:${episode.episodeId}`);
      if (episode.coveredBySpellId != null && !episode.applicableCandidates.some((candidate) => candidate.spellId === episode.coveredBySpellId)) {
        projectionIssues.push(`covered_spell_not_candidate:${episode.episodeId}:${episode.coveredBySpellId}`);
      }
      for (const candidate of episode.applicableCandidates) {
        const fact = kit.get(candidate.spellId);
        if (!fact) projectionIssues.push(`candidate_missing_from_kit:${episode.episodeId}:${candidate.spellId}`);
        if (
          !Array.isArray(candidate.castsForSpellMs) ||
          candidate.timing == null ||
          candidate.availabilityAtPeak == null
        ) {
          projectionIssues.push(`candidate_missing_v8_evidence:${episode.episodeId}:${candidate.spellId}`);
          continue;
        }
        const rawCasts = pull.defensiveCasts
          .filter((cast) => cast.spellId === candidate.spellId)
          .flatMap((cast) => cast.timestampsMs);
        if (!sameNumbers(candidate.castsForSpellMs, rawCasts)) {
          projectionIssues.push(`candidate_casts_mismatch:${episode.episodeId}:${candidate.spellId}`);
        }
        if (candidate.availabilityAtPeak.status !== candidate.statusAtPeak) {
          projectionIssues.push(`candidate_availability_mismatch:${episode.episodeId}:${candidate.spellId}`);
        }
        if ((candidate.timing.evaluationEndMs ?? null) !== (pull.evaluationEndMs ?? null)) {
          projectionIssues.push(`candidate_cutoff_mismatch:${episode.episodeId}:${candidate.spellId}`);
        }
        if (
          fact &&
          (candidate.isDefensiveKitMember !== fact.isDefensiveKitMember ||
            candidate.createsMissableOpportunity !== fact.createsMissableOpportunity)
        ) {
          projectionIssues.push(`candidate_kit_semantics_mismatch:${episode.episodeId}:${candidate.spellId}`);
        }
      }
      rawEpisodeById.set(episode.episodeId, episode);
    }
  }

  const casts: DefensiveCastAudit[] = [];
  const castIds = new Set<string>();
  for (const pull of input.pulls.filter((item) => item.playerParticipated).sort((a, b) => a.fightId - b.fightId)) {
    const row = rowsByPull.get(pull.pullId);
    const exactKit = kitByPull.get(pull.pullId);
    const fallbackKit = (spellId: number) => pull.buildFingerprint == null
      ? undefined
      : allKitByBuildAndSpell.get(`${pull.buildFingerprint}:${spellId}`);
    const excludedEpisode = row?.episodes.find((episode) => episode.responseVerdict === 'excluded');
    for (const defensive of [...pull.defensiveCasts].sort((a, b) => a.spellId - b.spellId)) {
      const fact = exactKit?.get(defensive.spellId) ?? fallbackKit(defensive.spellId);
      for (const castMs of [...defensive.timestampsMs].filter(Number.isFinite).sort((a, b) => a - b)) {
        const castId = `${input.reportCode}:${pull.pullId}:${input.playerName}:${defensive.spellId}:${castMs}`;
        if (castIds.has(castId)) projectionIssues.push(`duplicate_cast_id:${castId}`);
        castIds.add(castId);
        const excludedByEpisode = excludedEpisode != null && castMs >= excludedEpisode.startMs && castMs <= excludedEpisode.endMs;
        const scope = !pull.canonical
          ? 'excluded_pull'
          : (pull.evaluationEndMs != null && castMs >= pull.evaluationEndMs) || excludedByEpisode
            ? 'canonical_post_cutoff'
            : 'canonical_evaluable';
        const cast: DefensiveCastAudit = {
          castId,
          reportCode: input.reportCode,
          playerName: input.playerName,
          spellId: defensive.spellId,
          spellName: fact?.name ?? defensive.name ?? `habilidad ${defensive.spellId}`,
          pullId: pull.pullId,
          pullNumber: pull.pullNumber,
          fightId: pull.fightId,
          bossId: pull.bossId,
          bossName: pull.bossName,
          difficulty: pull.difficulty,
          castMs,
          castLabel: formatFightTime(castMs),
          resourceUniverse: resourceUniverse(fact),
          scope,
          associations: [],
          primaryClassification: 'outside_evaluable_pressure',
          confidence: fact?.membershipConfidence ?? 'uncertain',
          provenance: [],
        };
        if (scope === 'excluded_pull') cast.provenance.push('excluded_pull');
        else if (scope === 'canonical_post_cutoff') cast.provenance.push('post_cutoff');
        else if (!fact) cast.provenance.push('candidate_missing');
        if (scope === 'canonical_evaluable' && row) {
          for (const episode of row.episodes) {
            if (episode.responseVerdict === 'excluded') continue;
            const candidate = episode.applicableCandidates.find((item) => item.spellId === defensive.spellId);
            if (!candidate) continue;
            const association = buildAssociation(cast, episode, candidate);
            if (association) {
              cast.associations.push(association);
              cast.confidence = weakest(cast.confidence, candidate.confidence);
              cast.provenance.push(association.reasonCode);
            }
          }
        }
        cast.associations.sort((a, b) => a.peakMs - b.peakMs || a.episodeId.localeCompare(b.episodeId));
        cast.primaryClassification = primaryClassification(cast);
        if (!cast.provenance.length) cast.provenance.push('outside_evaluable_pressure');
        casts.push(cast);
      }
    }
  }
  audit.casts = casts.sort((a, b) => a.fightId - b.fightId || a.castMs - b.castMs || a.spellId - b.spellId);

  const episodes: DefensiveEpisodeAudit[] = [];
  for (const pull of canonicalPulls) {
    const row = rowsByPull.get(pull.pullId)!;
    const kit = kitByPull.get(pull.pullId)!;
    if (pull.pullNumber == null) projectionIssues.push(`canonical_pull_missing_ordinal:${pull.pullId}`);
    for (const episode of row.episodes) {
      const coveredFact = episode.coveredBySpellId != null ? kit.get(episode.coveredBySpellId) : undefined;
      const castIdsForEpisode = audit.casts
        .filter((cast) => cast.pullId === pull.pullId && cast.associations.some((association) => association.episodeId === episode.episodeId))
        .map((cast) => cast.castId);
      const alternatives = (episode.responseVerdict === 'missed_ready' || episode.responseVerdict === 'missed_due_to_mistime')
        ? episode.applicableCandidates.flatMap((candidate) => {
            const fact = kit.get(candidate.spellId);
            if (
              !fact || !candidate.isDefensiveKitMember || !candidate.createsMissableOpportunity || candidate.materiallyUnresolved ||
              candidate.damageApplicability !== 'yes' || candidate.temporalOpportunity !== 'yes' || candidate.statusAtPeak !== 'available_unused' ||
              !strong(candidate.membershipConfidence ?? candidate.confidence) ||
              !strong(candidate.applicabilityClaimConfidence ?? candidate.confidence) ||
              !strong(candidate.availabilityConfidence ?? candidate.confidence)
            ) return [];
            const confidence = weakest(
              candidate.membershipConfidence ?? candidate.confidence,
              candidate.applicabilityClaimConfidence ?? candidate.confidence,
              candidate.availabilityConfidence ?? candidate.confidence,
            );
            return [{ spellId: fact.spellId, spellName: fact.name, confidence, actionableWindow: actionableTimingWindow(fact, candidate, episode) }];
          })
        : [];
      episodes.push({
        episodeId: episode.episodeId,
        pullId: pull.pullId,
        pullNumber: pull.pullNumber ?? 0,
        fightId: pull.fightId,
        bossId: pull.bossId,
        bossName: pull.bossName,
        difficulty: pull.difficulty,
        startMs: episode.startMs,
        peakMs: episode.peakMs,
        endMs: episode.endMs,
        peakValue: episode.peakValue ?? Number.NaN,
        dominantAbilityGameId: typeof episode.evidence?.['dominantAbilityGameId'] === 'number' ? episode.evidence['dominantAbilityGameId'] as number : null,
        mechanicName: typeof episode.evidence?.['dominantAbilityGameId'] === 'number'
          ? pull.mechanicNamesByAbilityId[String(episode.evidence['dominantAbilityGameId'])] ?? null
          : null,
        responseVerdict: episode.responseVerdict,
        usageEngaged: episode.usageEngaged,
        usageEvaluable: episode.usageEvaluable,
        coveredBySpellId: episode.coveredBySpellId,
        coveredBySpellName: coveredFact?.name ?? null,
        castIds: castIdsForEpisode,
        alternatives,
        confidence: episode.confidence,
      });
    }
  }
  audit.episodes = episodes.sort((a, b) => a.fightId - b.fightId || a.peakMs - b.peakMs || a.episodeId.localeCompare(b.episodeId));

  const aggregate = aggregateDefensiveEpisodeKpis([...rawEpisodeById.values()]);
  audit.usage = { score: aggregate.usage.score, engaged: aggregate.usage.engaged, evaluable: aggregate.usage.evaluable };
  audit.response = {
    score: aggregate.response.score,
    covered: aggregate.response.covered,
    evaluable: aggregate.response.evaluable,
    missedReady: aggregate.response.missedReady,
    missedMistimed: aggregate.response.missedMistimed,
  };
  audit.context = {
    unavailableLegitimate: aggregate.unavailableLegitimate,
    noApplicableResource: aggregate.noApplicableResource,
    uncertain: aggregate.uncertain,
    excluded: aggregate.excluded,
  };
  audit.universe.totalEpisodes = aggregate.totalEpisodes;
  audit.universe.totalCoreCasts = audit.casts.filter((cast) => cast.resourceUniverse === 'core').length;
  audit.universe.totalCreditOnlyCasts = audit.casts.filter((cast) => cast.resourceUniverse === 'credit_only').length;
  audit.universe.totalNonPersonalOrUnresolvedCasts = audit.casts.filter((cast) => cast.resourceUniverse === 'non_personal_or_unresolved').length;
  for (const classification of PRIMARY_VALUES) {
    audit.universe.coreByPrimary[classification] = audit.casts.filter((cast) => cast.resourceUniverse === 'core' && cast.primaryClassification === classification).length;
  }
  audit.abilities = abilitySummaries(audit.casts, audit.episodes);
  audit.integrityIssues = [...projectionIssues, ...validateAudit(audit)].filter((value, index, all) => all.indexOf(value) === index).sort();
  if (audit.integrityIssues.length) {
    audit.state = 'incompatible';
    audit.statusMessage = 'La evidencia no supera las invariantes de integridad; no se genera una conclusión defensiva.';
    return audit;
  }

  audit.narrative = buildDefensiveAuditNarrative(audit);
  audit.discordParts = chunkDefensiveNarrativeForDiscord(audit.narrative);
  return audit;
}
