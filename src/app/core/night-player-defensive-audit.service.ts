import { Injectable, inject } from '@angular/core';
import {
  CanonicalDefensiveSummaryService,
  type CanonicalDefensiveEpisodeFact,
  type CanonicalDefensiveGeneration,
  type CanonicalDefensiveState,
  type CanonicalDefensiveSummary,
  type PlanVerdict,
} from './canonical-defensive-summary.service';
import {
  NightPlayerPullLedgerService,
  type NightPlayerPullLedger,
  type NightPlayerPullLedgerRow,
} from './night-player-pull-ledger.service';
import {
  deriveDefensiveEpisodeKpiContribution,
  type DefensiveEpisodeKpiContribution,
  type ResponseVerdict,
} from '../../../supabase/functions/_shared/defensive-episode-kpis';
import type {
  AuditClaim,
  AuditClaimStatus,
  DefensiveEpisodeEvidence,
  PullEvidenceRef,
} from '../shared/models/night-player-audit';

export type NightPlayerDefensiveResponseVerdict = ResponseVerdict;

export type NightPlayerDefensiveAuditIntegrity =
  | 'complete'
  | 'partial'
  | 'unavailable'
  | 'incompatible'
  | 'error';

export interface NightPlayerDefensiveEpisodeAudit {
  episodeId: string;
  causalGroupId: string;
  pull: PullEvidenceRef;
  pullLabel: string;
  wclUrl: string;
  startMs: number;
  peakMs: number;
  endMs: number;
  dominantAbilityGameId: number | null;
  usageEngaged: boolean;
  usageEvaluable: boolean;
  responseVerdict: NightPlayerDefensiveResponseVerdict;
  responseReason: string;
  responseEvaluable: boolean;
  covered: boolean;
  missedReady: boolean;
  missedMistimed: boolean;
  usedSpellIds: readonly number[];
  coveredBySpellId: number | null;
  decisiveSpellIds: readonly number[];
  planAssignmentId: string | null;
  planVerdict: PlanVerdict | null;
  confidence: string;
  evidence: DefensiveEpisodeEvidence;
}

export interface NightPlayerUnresolvedDefensiveEpisode {
  episodeId: string;
  pullId: string;
  responseVerdict: NightPlayerDefensiveResponseVerdict;
  reason: string;
}

export interface NightPlayerManagementAssignmentAudit {
  assignmentId: string;
  verdict: PlanVerdict;
  episodeIds: readonly string[];
  evidence: readonly DefensiveEpisodeEvidence[];
}

export interface NightPlayerDefensiveAudit {
  reportCode: string;
  playerName: string;
  state: CanonicalDefensiveState;
  integrity: NightPlayerDefensiveAuditIntegrity;
  coverage: { evaluatedPulls: number; expectedPulls: number };
  generation: CanonicalDefensiveGeneration | null;
  usage: AuditClaim<number>;
  response: AuditClaim<number>;
  management: AuditClaim<number>;
  context: CanonicalDefensiveSummary['context'];
  totalEpisodes: number;
  episodes: readonly NightPlayerDefensiveEpisodeAudit[];
  unresolvedEpisodes: readonly NightPlayerUnresolvedDefensiveEpisode[];
  managementAssignments: readonly NightPlayerManagementAssignmentAudit[];
  integrityIssues: readonly string[];
}

function canonicalSourceVersion(generation: CanonicalDefensiveGeneration | null): string | null {
  if (!generation) return null;
  return [
    generation.semanticVersion,
    generation.resolverVersion,
    generation.semanticResolverVersion,
    generation.evaluatorVersion,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

function claimStatus(
  summaryState: CanonicalDefensiveState,
  available: boolean,
  evidenceComplete: boolean,
): AuditClaimStatus {
  if (summaryState === 'error' || summaryState === 'incompatible') return 'incompatible';
  if (summaryState === 'unavailable' || !available) return 'not_evaluable';
  if (summaryState === 'partial' || !evidenceComplete) return 'partial';
  return 'canonical';
}

function episodeEvidence(
  episode: CanonicalDefensiveEpisodeFact,
  pull: PullEvidenceRef,
  generation: CanonicalDefensiveGeneration,
): DefensiveEpisodeEvidence {
  return {
    id: `defensive-episode:${generation.id}:${episode.pullId}:${episode.episodeId}`,
    kind: 'defensive_episode',
    source: 'iris_canonical',
    locator: `player_pull_defensive_episode_evaluations:${generation.id}:${episode.pullId}:${episode.episodeId}`,
    sourceVersion: generation.evaluatorVersion,
    pull: { ...pull, timeMs: episode.peakMs },
    episodeId: episode.episodeId,
    defensiveGenerationId: generation.id,
  };
}

function buildEpisodeAudit(
  episode: CanonicalDefensiveEpisodeFact,
  row: NightPlayerPullLedgerRow,
  generation: CanonicalDefensiveGeneration,
): NightPlayerDefensiveEpisodeAudit {
  const contribution: DefensiveEpisodeKpiContribution = deriveDefensiveEpisodeKpiContribution(episode);
  return {
    episodeId: episode.episodeId,
    causalGroupId: episode.causalGroupId,
    pull: row.pull,
    pullLabel: row.label,
    wclUrl: row.wclUrl,
    startMs: episode.startMs,
    peakMs: episode.peakMs,
    endMs: episode.endMs,
    dominantAbilityGameId: episode.dominantAbilityGameId,
    usageEngaged: contribution.usageEngaged,
    usageEvaluable: contribution.usageEvaluable,
    responseVerdict: contribution.responseVerdict,
    responseReason: episode.responseReason,
    responseEvaluable: contribution.responseEvaluable,
    covered: contribution.covered,
    missedReady: contribution.missedReady,
    missedMistimed: contribution.missedMistimed,
    usedSpellIds: episode.usedSpellIds,
    coveredBySpellId: episode.coveredBySpellId,
    decisiveSpellIds: episode.decisiveSpellIds,
    planAssignmentId: episode.planAssignmentId,
    planVerdict: episode.planVerdict,
    confidence: episode.confidence,
    evidence: episodeEvidence(episode, row.pull, generation),
  };
}

function buildManagementAssignments(
  episodes: readonly NightPlayerDefensiveEpisodeAudit[],
  integrityIssues: string[],
): NightPlayerManagementAssignmentAudit[] {
  const byId = new Map<
    string,
    { verdict: PlanVerdict; episodeIds: string[]; evidence: DefensiveEpisodeEvidence[] }
  >();

  for (const episode of episodes) {
    if (episode.planAssignmentId == null || episode.planVerdict == null) continue;
    const current = byId.get(episode.planAssignmentId);
    if (!current) {
      byId.set(episode.planAssignmentId, {
        verdict: episode.planVerdict,
        episodeIds: [episode.episodeId],
        evidence: [episode.evidence],
      });
      continue;
    }
    current.episodeIds.push(episode.episodeId);
    current.evidence.push(episode.evidence);
    if (current.verdict !== episode.planVerdict) {
      integrityIssues.push(
        `La asignación ${episode.planAssignmentId} expone veredictos distintos en la superficie de auditoría (${current.verdict} vs ${episode.planVerdict}).`,
      );
    }
  }

  return [...byId.entries()]
    .map(([assignmentId, value]) => ({ assignmentId, ...value }))
    .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId));
}

/**
 * Proyección pura de la fuente defensiva canónica hacia el contrato auditable.
 * No calcula ningún KPI: value/numerator/denominator proceden de CanonicalDefensiveSummary.
 * Solo adjunta la evidencia episodio-a-episodio necesaria para reconstruirlos.
 */
export function buildNightPlayerDefensiveAudit(args: {
  reportCode: string;
  playerName: string;
  ledger: NightPlayerPullLedger;
  summary: CanonicalDefensiveSummary;
}): NightPlayerDefensiveAudit {
  const { reportCode, playerName, ledger, summary } = args;
  const integrityIssues = [...ledger.integrityIssues, ...summary.integrityIssues];
  const rowByPullId = new Map(ledger.rows.map((row) => [row.pull.pullId, row]));
  const episodes: NightPlayerDefensiveEpisodeAudit[] = [];
  const unresolvedEpisodes: NightPlayerUnresolvedDefensiveEpisode[] = [];

  if (summary.generation) {
    for (const episode of summary.episodes) {
      const row = rowByPullId.get(episode.pullId);
      if (!row) {
        unresolvedEpisodes.push({
          episodeId: episode.episodeId,
          pullId: episode.pullId,
          responseVerdict: episode.responseVerdict,
          reason: 'El episodio canónico no pudo vincularse a una identidad boss-local del Pull Ledger.',
        });
        continue;
      }
      episodes.push(buildEpisodeAudit(episode, row, summary.generation));
    }
  }

  episodes.sort(
    (left, right) =>
      left.pull.fightId - right.pull.fightId ||
      left.peakMs - right.peakMs ||
      left.episodeId.localeCompare(right.episodeId),
  );

  if (unresolvedEpisodes.length) {
    integrityIssues.push(
      `${unresolvedEpisodes.length} episodio(s) defensivo(s) canónicos no tienen una referencia de pull auditable; los KPI no se recalculan, pero su evidencia no puede deep-linkearse desde esta superficie.`,
    );
  }

  const sourceVersion = canonicalSourceVersion(summary.generation);
  const scopePullIds = [
    ...ledger.rows.map((row) => row.pull.pullId),
    ...ledger.excludedParticipatedPulls.map((row) => row.pullId),
  ];
  const scope = { reportCode, playerName, pullIds: scopePullIds } as const;
  const coverage = { expected: summary.coverage.expectedPulls, observed: summary.coverage.evaluatedPulls };

  const usageDenominatorEvidence = episodes.filter((episode) => episode.usageEvaluable);
  const responseDenominatorEvidence = episodes.filter((episode) => episode.responseEvaluable);
  const managementAssignments = buildManagementAssignments(episodes, integrityIssues);

  const usageEvidenceComplete = usageDenominatorEvidence.length === summary.usage.evaluable;
  const responseEvidenceComplete = responseDenominatorEvidence.length === summary.response.evaluable;
  const managementEvidenceComplete = managementAssignments.length === summary.management.evaluable;

  if (!usageEvidenceComplete && summary.usage.status === 'available') {
    integrityIssues.push(
      `Uso declara denominador ${summary.usage.evaluable}, pero la superficie solo puede enlazar ${usageDenominatorEvidence.length} episodios evaluables.`,
    );
  }
  if (!responseEvidenceComplete && summary.response.status === 'available') {
    integrityIssues.push(
      `Response declara denominador ${summary.response.evaluable}, pero la superficie solo puede enlazar ${responseDenominatorEvidence.length} episodios evaluables.`,
    );
  }
  if (!managementEvidenceComplete && summary.management.status === 'available') {
    integrityIssues.push(
      `Gestión declara ${summary.management.evaluable} asignaciones evaluables, pero la superficie solo puede reconstruir ${managementAssignments.length}.`,
    );
  }

  const usage: AuditClaim<number> = {
    id: 'defensive.usage',
    label: 'Uso defensivo',
    value: summary.usage.score,
    status: claimStatus(summary.state, summary.usage.status === 'available', usageEvidenceComplete),
    scope,
    definition:
      'Episodios defensivos evaluables en los que el jugador se implicó defensivamente. Un episodio cuenta como máximo una vez.',
    numerator: summary.usage.engaged,
    denominator: summary.usage.evaluable,
    formula: 'engaged episodes / usage-evaluable episodes',
    evidence: usageDenominatorEvidence.map((episode) => episode.evidence),
    sourceVersion,
    computedAt: summary.generation?.publishedAt ?? null,
    coverage,
    integrityIssues,
  };

  const response: AuditClaim<number> = {
    id: 'defensive.response',
    label: 'Respuesta defensiva',
    value: summary.response.score,
    status: claimStatus(
      summary.state,
      summary.response.status === 'available',
      responseEvidenceComplete,
    ),
    scope,
    definition:
      'Episodios de decisión defensiva realmente cubiertos frente al total de covered_verified + missed_ready + missed_due_to_mistime.',
    numerator: summary.response.covered,
    denominator: summary.response.evaluable,
    formula: 'covered_verified / (covered_verified + missed_ready + missed_due_to_mistime)',
    evidence: responseDenominatorEvidence.map((episode) => episode.evidence),
    sourceVersion,
    computedAt: summary.generation?.publishedAt ?? null,
    coverage,
    integrityIssues,
  };

  const management: AuditClaim<number> = {
    id: 'defensive.management',
    label: 'Gestión defensiva',
    value: summary.management.score,
    status: claimStatus(
      summary.state,
      summary.management.status === 'available',
      managementEvidenceComplete,
    ),
    scope,
    definition:
      'Cumplimiento de asignaciones defensivas publicadas. Sin plan publicado el valor correcto es N/D, nunca 0.',
    numerator: summary.management.fulfilled,
    denominator: summary.management.evaluable,
    formula: 'fulfilled published assignments / evaluable published assignments',
    evidence: managementAssignments.flatMap((assignment) => assignment.evidence.slice(0, 1)),
    sourceVersion,
    computedAt: summary.generation?.publishedAt ?? null,
    coverage,
    integrityIssues,
  };

  const integrity: NightPlayerDefensiveAuditIntegrity =
    summary.state === 'error'
      ? 'error'
      : summary.state === 'incompatible'
        ? 'incompatible'
        : summary.state === 'unavailable'
          ? 'unavailable'
          : summary.state === 'partial' || integrityIssues.length || ledger.integrity === 'partial'
            ? 'partial'
            : 'complete';

  return {
    reportCode,
    playerName,
    state: summary.state,
    integrity,
    coverage: summary.coverage,
    generation: summary.generation,
    usage,
    response,
    management,
    context: summary.context,
    totalEpisodes: summary.totalEpisodes,
    episodes,
    unresolvedEpisodes,
    managementAssignments,
    integrityIssues,
  };
}

@Injectable({ providedIn: 'root' })
export class NightPlayerDefensiveAuditService {
  private readonly pullLedger = inject(NightPlayerPullLedgerService);
  private readonly canonicalSummary = inject(CanonicalDefensiveSummaryService);

  async load(reportCode: string, playerName: string): Promise<NightPlayerDefensiveAudit> {
    const ledger = await this.pullLedger.load(reportCode, playerName);
    const participatedPullIds = [
      ...ledger.rows.map((row) => row.pull.pullId),
      ...ledger.excludedParticipatedPulls.map((row) => row.pullId),
    ];
    const summary = await this.canonicalSummary.getSummary(reportCode, playerName, participatedPullIds);
    return buildNightPlayerDefensiveAudit({ reportCode, playerName, ledger, summary });
  }
}
