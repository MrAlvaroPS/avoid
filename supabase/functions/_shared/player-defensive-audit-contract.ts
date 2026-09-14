/** Leaf contract shared by the Deno projection and Angular. No runtime imports. */

export const DEFENSIVE_NIGHT_AUDIT_VERSION = 'defensive-night-audit@1' as const;

export type DefensiveAuditState = 'available' | 'partial' | 'unavailable' | 'incompatible' | 'error';
export type DefensiveResourceUniverse = 'core' | 'credit_only' | 'non_personal_or_unresolved';
export type DefensiveCastScope = 'canonical_evaluable' | 'canonical_post_cutoff' | 'excluded_pull';
export type DefensiveCastPrimaryClassification =
  | 'effective'
  | 'relevant_ineffective'
  | 'relevant_uncertain'
  | 'outside_evaluable_pressure'
  | 'excluded';

export type DefensiveCastReasonCode =
  | 'covered_by_canonical_verdict'
  | 'late_after_peak'
  | 'effect_expired_before_peak'
  | 'relevant_but_not_covering'
  | 'reactive_window_missed'
  | 'applicability_unknown'
  | 'coverage_unknown'
  | 'observed_aura_contradiction'
  | 'continuous_state_unobserved'
  | 'timing_unknown'
  | 'no_cast_with_ready_resource'
  | 'outside_evaluable_pressure'
  | 'post_cutoff'
  | 'excluded_pull'
  | 'candidate_missing';

export type AuditConfidence = 'verified' | 'inferred' | 'fallback' | 'uncertain';
export type AuditTriState = 'yes' | 'no' | 'unknown';
export type AuditTimingRelation =
  | 'before_or_during'
  | 'after_damage'
  | 'either'
  | 'continuous_state'
  | 'unknown'
  | null;

export interface ActionableTimingWindow {
  status: 'verified' | 'inferred' | 'unavailable' | 'uncertain';
  earliestMs: number | null;
  latestMs: number | null;
  reasonCode:
    | 'proactive_window'
    | 'reactive_window'
    | 'resource_unavailable'
    | 'weak_membership'
    | 'weak_applicability'
    | 'weak_availability'
    | 'duration_unknown'
    | 'timing_unknown'
    | 'runtime_rule_unresolved'
    | 'observed_aura_contradiction'
    | 'no_verified_ready_in_window';
  confidence: AuditConfidence;
}

export interface DefensiveCastEpisodeAssociation {
  episodeId: string;
  startMs: number;
  peakMs: number;
  endMs: number;
  deltaFromPeakMs: number;
  timingRelation: AuditTimingRelation;
  engagement: boolean;
  castCoverage: AuditTriState;
  responseVerdict:
    | 'covered_verified'
    | 'missed_ready'
    | 'missed_due_to_mistime'
    | 'unavailable_legitimate'
    | 'no_applicable_resource'
    | 'uncertain'
    | 'excluded';
  isCoveredBySpell: boolean;
  gaveUsageCredit: boolean;
  gaveResponseCredit: boolean;
  reasonCode: DefensiveCastReasonCode;
  evidence: Record<string, unknown>;
}

export interface DefensiveCastAudit {
  castId: string;
  reportCode: string;
  playerName: string;
  spellId: number;
  spellName: string;
  pullId: string;
  pullNumber: number | null;
  fightId: number;
  bossId: string;
  bossName: string | null;
  difficulty: string;
  castMs: number;
  castLabel: string;
  resourceUniverse: DefensiveResourceUniverse;
  scope: DefensiveCastScope;
  associations: DefensiveCastEpisodeAssociation[];
  primaryClassification: DefensiveCastPrimaryClassification;
  confidence: AuditConfidence;
  provenance: DefensiveCastReasonCode[];
}

export interface DefensiveAlternativeAudit {
  spellId: number;
  spellName: string;
  confidence: AuditConfidence;
  actionableWindow: ActionableTimingWindow;
}

export interface DefensiveEpisodeAudit {
  episodeId: string;
  pullId: string;
  pullNumber: number;
  fightId: number;
  bossId: string;
  bossName: string | null;
  difficulty: string;
  startMs: number;
  peakMs: number;
  endMs: number;
  peakValue: number;
  dominantAbilityGameId: number | null;
  mechanicName: string | null;
  responseVerdict: DefensiveCastEpisodeAssociation['responseVerdict'];
  usageEngaged: boolean;
  usageEvaluable: boolean;
  coveredBySpellId: number | null;
  coveredBySpellName: string | null;
  castIds: string[];
  alternatives: DefensiveAlternativeAudit[];
  confidence: AuditConfidence;
}

export interface DefensiveAuditAbilitySummary {
  spellId: number;
  spellName: string;
  resourceUniverse: DefensiveResourceUniverse;
  totalCasts: number;
  effectiveCasts: number;
  relevantIneffectiveCasts: number;
  relevantUncertainCasts: number;
  outsidePressureCasts: number;
  excludedCasts: number;
  usageEpisodes: number;
  responseEpisodes: number;
}

export interface DefensiveAuditNarrative {
  version: typeof DEFENSIVE_NIGHT_AUDIT_VERSION;
  blocks: DefensiveNarrativeBlock[];
}

export type DefensiveNarrativeInline =
  | { kind: 'text'; value: string }
  | { kind: 'player'; value: string }
  | { kind: 'spell'; value: string; spellId: number }
  | { kind: 'pull_link'; value: string; reportCode: string; pullId: string; pullNumber: number; fightId: number; url: string }
  | { kind: 'time'; value: string; ms: number }
  | { kind: 'delta'; value: string; ms: number }
  | { kind: 'emphasis'; value: string };

export type DefensiveNarrativeBlock =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'paragraph'; inlines: DefensiveNarrativeInline[] }
  | { kind: 'list'; items: DefensiveNarrativeInline[][] }
  | { kind: 'spacer' };

export interface DefensiveNightAuditMetadata {
  auditVersion: typeof DEFENSIVE_NIGHT_AUDIT_VERSION;
  generationId: string | null;
  generationPublishedAt: string | null;
  evaluatorVersion: string | null;
  resolverVersion: string | null;
  semanticResolverVersion: string | null;
  semanticVersion: string | null;
  gameBuild: string | null;
  evaluatedPulls: number;
  expectedPulls: number;
  generatedAt: string;
  sourceFingerprint: string | null;
}

export interface DefensiveNightAudit {
  state: DefensiveAuditState;
  statusMessage: string;
  reportCode: string;
  playerName: string;
  metadata: DefensiveNightAuditMetadata;
  universe: {
    participatedPulls: number;
    canonicalPulls: number;
    excludedPulls: number;
    totalObservedCasts: number;
    totalCoreCasts: number;
    totalCreditOnlyCasts: number;
    totalNonPersonalOrUnresolvedCasts: number;
    coreByPrimary: Record<DefensiveCastPrimaryClassification, number>;
    totalEpisodes: number;
  };
  usage: { score: number | null; engaged: number; evaluable: number };
  response: { score: number | null; covered: number; evaluable: number; missedReady: number; missedMistimed: number };
  context: { unavailableLegitimate: number; noApplicableResource: number; uncertain: number; excluded: number };
  abilities: DefensiveAuditAbilitySummary[];
  casts: DefensiveCastAudit[];
  episodes: DefensiveEpisodeAudit[];
  integrityIssues: string[];
  narrative: DefensiveAuditNarrative | null;
  discordParts: string[];
}

export interface DefensiveAuditDiscordSendResult {
  ok: boolean;
  messageIds: string[];
  parts: number;
  sentParts: number;
  failedPartIndex: number | null;
  channelName: string | null;
  error?: string;
}

export function defensiveAuditDiscordSendDisabled(
  audit: DefensiveNightAudit,
  rosterCharacterId: number | null,
  hasDiscordChannel: boolean,
  status: 'idle' | 'sending' | 'sent' | 'partial_error' | 'error',
): boolean {
  return status === 'sending' || audit.state !== 'available' || !hasDiscordChannel || rosterCharacterId == null || audit.discordParts.length === 0;
}

/** Fail-closed transport fallback shared with Angular; never manufactures facts. */
export function emptyDefensiveNightAuditState(
  reportCode: string,
  playerName: string,
  state: Exclude<DefensiveAuditState, 'available'>,
  statusMessage: string,
  generatedAt: string,
): DefensiveNightAudit {
  return {
    state,
    statusMessage,
    reportCode,
    playerName,
    metadata: {
      auditVersion: DEFENSIVE_NIGHT_AUDIT_VERSION,
      generationId: null,
      generationPublishedAt: null,
      evaluatorVersion: null,
      resolverVersion: null,
      semanticResolverVersion: null,
      semanticVersion: null,
      gameBuild: null,
      evaluatedPulls: 0,
      expectedPulls: 0,
      generatedAt,
      sourceFingerprint: null,
    },
    universe: {
      participatedPulls: 0,
      canonicalPulls: 0,
      excludedPulls: 0,
      totalObservedCasts: 0,
      totalCoreCasts: 0,
      totalCreditOnlyCasts: 0,
      totalNonPersonalOrUnresolvedCasts: 0,
      coreByPrimary: { effective: 0, relevant_ineffective: 0, relevant_uncertain: 0, outside_evaluable_pressure: 0, excluded: 0 },
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
