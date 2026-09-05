import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import {
  NightPlayerPullLedgerService,
  type NightPlayerPullLedger,
  type NightPlayerPullLedgerRow,
} from './night-player-pull-ledger.service';
import type {
  AuditClaim,
  AuditClaimStatus,
  EvidenceRef,
  ExecutionLedgerEvidence,
  MechanicEventEvidence,
  PullEvidenceRef,
} from '../shared/models/night-player-audit';

export type CausalMaterializationState = 'complete' | 'partial' | 'unavailable' | 'incompatible';
export type CombatEvaluationJobType =
  | 'pull_context'
  | 'mechanic_policy'
  | 'mechanic_assignment'
  | 'consumable_policy'
  | 'full_execution_backfill';

export interface CombatBackfillJobFact {
  pull_id: string;
  job_type: CombatEvaluationJobType;
  status: 'queued' | 'running' | 'done' | 'error';
  stage_progress: Record<string, unknown>;
  last_error: string | null;
  updated_at: string;
}

export interface MechanicOffenseFact {
  execution_event_id: string;
  pull_id: string;
  timestamp_ms: number;
  occurrence_id: string;
  mechanic_key: string;
  occurrence_index: number;
  relationship: 'primary_owner' | 'co_owner' | 'assigned_resolver';
  reason_code: string;
  severity: number | null;
  priority: number | null;
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  evidence: Record<string, unknown>;
  policy_version: number | null;
  context_resolver_version: string;
  occurrence_resolver_version: string;
  ledger_evaluator_version: string;
}

export interface DeathLedgerFact {
  id: string;
  pull_id: string;
  timestamp_ms: number;
  event_type: string;
  verdict: 'success' | 'failure' | 'correct_hold' | 'missed' | 'context' | 'not_applicable' | 'uncertain';
  reason_code: string;
  penalty_eligible: boolean;
  primary_penalty: boolean;
  severity: number | null;
  priority: number | null;
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  evidence: Record<string, unknown>;
  context_resolver_version: string;
  occurrence_resolver_version: string | null;
  ledger_evaluator_version: string;
  evaluated_at: string;
}

export interface NightPlayerMechanicOffenseAudit {
  eventId: string;
  pull: PullEvidenceRef;
  pullLabel: string;
  wclUrl: string;
  timestampMs: number;
  mechanicKey: string;
  occurrenceId: string;
  occurrenceIndex: number;
  relationship: MechanicOffenseFact['relationship'];
  reasonCode: string;
  severity: number | null;
  priority: number | null;
  confidence: MechanicOffenseFact['confidence'];
  policyVersion: number | null;
  contextResolverVersion: string;
  occurrenceResolverVersion: string;
  ledgerEvaluatorVersion: string;
  evidencePayload: Record<string, unknown>;
  evidence: readonly EvidenceRef[];
}

export interface NightPlayerDeathAuditRow {
  eventId: string;
  pull: PullEvidenceRef;
  pullLabel: string;
  wclUrl: string;
  timestampMs: number;
  verdict: DeathLedgerFact['verdict'];
  reasonCode: string;
  penaltyEligible: boolean;
  primaryPenalty: boolean;
  severity: number | null;
  priority: number | null;
  confidence: DeathLedgerFact['confidence'];
  ledgerEvaluatorVersion: string;
  contextResolverVersion: string;
  evidencePayload: Record<string, unknown>;
  evidence: ExecutionLedgerEvidence;
}

export interface NightPlayerMechanicPatternAudit {
  mechanicKey: string;
  count: number;
  reasonCodes: readonly string[];
  pullIds: readonly string[];
  evidence: readonly EvidenceRef[];
}

export interface NightPlayerMechanicDeathAudit {
  reportCode: string;
  playerName: string;
  materializationState: CausalMaterializationState;
  coverage: {
    expectedPulls: number;
    completedPulls: number;
    pendingPulls: number;
    failedPulls: number;
  };
  actionableMechanicIncidents: AuditClaim<number>;
  avoidableSuccess: AuditClaim<number>;
  totalDeaths: AuditClaim<number>;
  mechanicOffenses: readonly NightPlayerMechanicOffenseAudit[];
  repeatedMechanicPatterns: readonly NightPlayerMechanicPatternAudit[];
  deaths: readonly NightPlayerDeathAuditRow[];
  integrityIssues: readonly string[];
  sourceVersions: {
    ledgerEvaluatorVersion: string | null;
    contextResolverVersion: string | null;
    occurrenceResolverVersion: string | null;
  };
}

function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function auditStatus(state: CausalMaterializationState): AuditClaimStatus {
  switch (state) {
    case 'complete': return 'canonical';
    case 'partial': return 'partial';
    case 'incompatible': return 'incompatible';
    case 'unavailable': return 'not_evaluable';
  }
}

function timeMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewerThan(candidate: CombatBackfillJobFact, reference: CombatBackfillJobFact): boolean {
  const candidateMs = timeMs(candidate.updated_at);
  const referenceMs = timeMs(reference.updated_at);
  return candidateMs != null && referenceMs != null && candidateMs > referenceMs;
}

function executionEvidence(
  row: Pick<NightPlayerPullLedgerRow, 'pull'>,
  eventId: string,
  timestampMs: number,
  sourceVersion: string,
): ExecutionLedgerEvidence {
  return {
    id: `execution-ledger:${eventId}`,
    kind: 'execution_ledger',
    source: 'iris_canonical',
    locator: `player_execution_events:${eventId}`,
    sourceVersion,
    pull: { ...row.pull, timeMs: timestampMs },
    eventId,
  };
}

function occurrenceEvidence(
  row: Pick<NightPlayerPullLedgerRow, 'pull'>,
  offense: MechanicOffenseFact,
): MechanicEventEvidence {
  return {
    id: `mechanic-occurrence:${offense.occurrence_id}`,
    kind: 'mechanic_event',
    source: 'iris_canonical',
    locator: `mechanic_occurrence_evaluations:${offense.occurrence_id}`,
    sourceVersion: offense.occurrence_resolver_version,
    pull: { ...row.pull, timeMs: offense.timestamp_ms },
    mechanicKey: offense.mechanic_key,
    occurrenceIndex: offense.occurrence_index,
  };
}

function buildPatterns(
  offenses: readonly NightPlayerMechanicOffenseAudit[],
): NightPlayerMechanicPatternAudit[] {
  const groups = new Map<
    string,
    { count: number; reasonCodes: Set<string>; pullIds: Set<string>; evidence: EvidenceRef[] }
  >();
  for (const offense of offenses) {
    const current = groups.get(offense.mechanicKey) ?? {
      count: 0,
      reasonCodes: new Set<string>(),
      pullIds: new Set<string>(),
      evidence: [],
    };
    current.count += 1;
    current.reasonCodes.add(offense.reasonCode);
    current.pullIds.add(offense.pull.pullId);
    current.evidence.push(...offense.evidence);
    groups.set(offense.mechanicKey, current);
  }
  return [...groups.entries()]
    .map(([mechanicKey, group]) => ({
      mechanicKey,
      count: group.count,
      reasonCodes: [...group.reasonCodes].sort(),
      pullIds: [...group.pullIds],
      evidence: group.evidence,
    }))
    .sort((left, right) => right.count - left.count || left.mechanicKey.localeCompare(right.mechanicKey));
}

interface MaterializationCoverage {
  completedPullIds: Set<string>;
  pendingPullIds: Set<string>;
  failedPullIds: Set<string>;
  stalePullIds: Set<string>;
  hasAnyJob: boolean;
}

/**
 * A completed full_execution_backfill is necessary but not sufficient. Any
 * newer/pending causal invalidation job means that marker is stale and the
 * dossier must fail closed until a fresh full backfill finishes.
 */
function resolveMaterializationCoverage(
  expectedPullIds: ReadonlySet<string>,
  jobs: readonly CombatBackfillJobFact[],
): MaterializationCoverage {
  const jobsByPullId = new Map<string, CombatBackfillJobFact[]>();
  for (const job of jobs) {
    if (!expectedPullIds.has(job.pull_id)) continue;
    const current = jobsByPullId.get(job.pull_id) ?? [];
    current.push(job);
    jobsByPullId.set(job.pull_id, current);
  }

  const completedPullIds = new Set<string>();
  const pendingPullIds = new Set<string>();
  const failedPullIds = new Set<string>();
  const stalePullIds = new Set<string>();

  for (const pullId of expectedPullIds) {
    const pullJobs = jobsByPullId.get(pullId) ?? [];
    const fullBackfill = pullJobs.find((job) => job.job_type === 'full_execution_backfill');
    const invalidations = pullJobs.filter((job) => job.job_type !== 'full_execution_backfill');
    const hasFailure = pullJobs.some((job) => job.status === 'error');
    const hasPending = pullJobs.some((job) => job.status === 'queued' || job.status === 'running');
    const staleInvalidation =
      fullBackfill != null && invalidations.some((job) => isNewerThan(job, fullBackfill));

    if (hasFailure) failedPullIds.add(pullId);
    if (staleInvalidation) stalePullIds.add(pullId);

    const fullBackfillFresh =
      fullBackfill?.status === 'done' && !hasPending && !hasFailure && !staleInvalidation;
    if (fullBackfillFresh) completedPullIds.add(pullId);
    else if (!hasFailure) pendingPullIds.add(pullId);
  }

  return {
    completedPullIds,
    pendingPullIds,
    failedPullIds,
    stalePullIds,
    hasAnyJob: jobsByPullId.size > 0,
  };
}

/**
 * Proyección de auditoría sobre el pipeline causal v3.
 *
 * Un full_execution_backfill fresco y `done` por cada pull válido participado
 * es el marker de completitud: encadena occurrences -> responsibility edges ->
 * execution ledger. Cualquier invalidación posterior vuelve a cerrar el gate.
 */
export function buildNightPlayerMechanicDeathAudit(args: {
  reportCode: string;
  playerName: string;
  ledger: NightPlayerPullLedger;
  jobs: readonly CombatBackfillJobFact[];
  offenseFacts: readonly MechanicOffenseFact[];
  deathFacts: readonly DeathLedgerFact[];
}): NightPlayerMechanicDeathAudit {
  const { reportCode, playerName, ledger, jobs, offenseFacts, deathFacts } = args;
  const expectedRows = ledger.rows;
  const expectedPullIds = new Set(expectedRows.map((row) => row.pull.pullId));
  const rowByPullId = new Map(expectedRows.map((row) => [row.pull.pullId, row]));
  const integrityIssues = [...ledger.integrityIssues];
  const materialization = resolveMaterializationCoverage(expectedPullIds, jobs);

  const ledgerVersions = uniqueNonEmpty([
    ...offenseFacts.map((row) => row.ledger_evaluator_version),
    ...deathFacts.map((row) => row.ledger_evaluator_version),
  ]);
  const contextVersions = uniqueNonEmpty([
    ...offenseFacts.map((row) => row.context_resolver_version),
    ...deathFacts.map((row) => row.context_resolver_version),
  ]);
  const occurrenceVersions = uniqueNonEmpty(offenseFacts.map((row) => row.occurrence_resolver_version));
  const versionsCompatible =
    ledgerVersions.length <= 1 && contextVersions.length <= 1 && occurrenceVersions.length <= 1;

  let materializationState: CausalMaterializationState;
  if (!versionsCompatible) {
    materializationState = 'incompatible';
    integrityIssues.push(
      `La evidencia causal mezcla versiones (ledger=${ledgerVersions.join(', ') || 'N/D'}; context=${contextVersions.join(', ') || 'N/D'}; occurrence=${occurrenceVersions.join(', ') || 'N/D'}).`,
    );
  } else if (expectedRows.length === 0) {
    materializationState = 'unavailable';
    integrityIssues.push('No hay pulls válidos participados sobre los que auditar mecánicas o muertes.');
  } else if (materialization.completedPullIds.size === expectedRows.length) {
    materializationState = 'complete';
  } else if (!materialization.hasAnyJob) {
    materializationState = 'unavailable';
    integrityIssues.push(
      `No existe full_execution_backfill para los ${expectedRows.length} pulls válidos participados; cero filas causales no puede interpretarse como cero incidentes.`,
    );
  } else {
    materializationState = 'partial';
    integrityIssues.push(
      `Materialización causal incompleta: ${materialization.completedPullIds.size}/${expectedRows.length} pulls completos, ${materialization.pendingPullIds.size} pendientes y ${materialization.failedPullIds.size} con error.`,
    );
  }

  if (materialization.stalePullIds.size) {
    integrityIssues.push(
      `${materialization.stalePullIds.size} pull(s) tienen una invalidación causal más reciente que su último full_execution_backfill; el marker anterior no se acepta como vigente.`,
    );
  }
  for (const job of jobs.filter((row) => expectedPullIds.has(row.pull_id) && row.status === 'error')) {
    integrityIssues.push(
      `${job.job_type} de ${job.pull_id} falló${job.last_error ? `: ${job.last_error}` : '.'}`,
    );
  }

  const mechanicOffenses: NightPlayerMechanicOffenseAudit[] = [];
  for (const offense of offenseFacts) {
    const row = rowByPullId.get(offense.pull_id);
    if (!row) {
      integrityIssues.push(
        `Ofensa mecánica ${offense.execution_event_id} referencia un pull fuera del Pull Ledger auditable (${offense.pull_id}).`,
      );
      continue;
    }
    const ledgerEvidence = executionEvidence(
      row,
      offense.execution_event_id,
      offense.timestamp_ms,
      offense.ledger_evaluator_version,
    );
    mechanicOffenses.push({
      eventId: offense.execution_event_id,
      pull: row.pull,
      pullLabel: row.label,
      wclUrl: row.wclUrl,
      timestampMs: offense.timestamp_ms,
      mechanicKey: offense.mechanic_key,
      occurrenceId: offense.occurrence_id,
      occurrenceIndex: offense.occurrence_index,
      relationship: offense.relationship,
      reasonCode: offense.reason_code,
      severity: offense.severity,
      priority: offense.priority,
      confidence: offense.confidence,
      policyVersion: offense.policy_version,
      contextResolverVersion: offense.context_resolver_version,
      occurrenceResolverVersion: offense.occurrence_resolver_version,
      ledgerEvaluatorVersion: offense.ledger_evaluator_version,
      evidencePayload: offense.evidence,
      evidence: [ledgerEvidence, occurrenceEvidence(row, offense)],
    });
  }
  mechanicOffenses.sort(
    (left, right) =>
      left.pull.fightId - right.pull.fightId ||
      left.timestampMs - right.timestampMs ||
      left.eventId.localeCompare(right.eventId),
  );

  const deaths: NightPlayerDeathAuditRow[] = [];
  for (const death of deathFacts) {
    const row = rowByPullId.get(death.pull_id);
    if (!row) {
      integrityIssues.push(
        `Evento de muerte ${death.id} referencia un pull fuera del Pull Ledger auditable (${death.pull_id}).`,
      );
      continue;
    }
    deaths.push({
      eventId: death.id,
      pull: row.pull,
      pullLabel: row.label,
      wclUrl: row.wclUrl,
      timestampMs: death.timestamp_ms,
      verdict: death.verdict,
      reasonCode: death.reason_code,
      penaltyEligible: death.penalty_eligible,
      primaryPenalty: death.primary_penalty,
      severity: death.severity,
      priority: death.priority,
      confidence: death.confidence,
      ledgerEvaluatorVersion: death.ledger_evaluator_version,
      contextResolverVersion: death.context_resolver_version,
      evidencePayload: death.evidence,
      evidence: executionEvidence(row, death.id, death.timestamp_ms, death.ledger_evaluator_version),
    });
  }
  deaths.sort(
    (left, right) =>
      left.pull.fightId - right.pull.fightId ||
      left.timestampMs - right.timestampMs ||
      left.eventId.localeCompare(right.eventId),
  );

  const scope = { reportCode, playerName, pullIds: [...expectedPullIds] } as const;
  const coverage = { expected: expectedRows.length, observed: materialization.completedPullIds.size };
  const status = auditStatus(materializationState);
  const complete = materializationState === 'complete';

  const actionableMechanicIncidents: AuditClaim<number> = {
    id: 'mechanics.actionableIncidents',
    label: 'Incidentes mecánicos atribuibles',
    value: complete ? mechanicOffenses.length : null,
    status,
    scope,
    definition:
      'Eventos mechanic failure/missed penalty-eligible materializados desde occurrence + responsibility graph. Ser alcanzado por una mecánica no basta para aparecer aquí.',
    numerator: complete ? mechanicOffenses.length : undefined,
    formula: 'count(player_mechanic_offenses_v3) after fresh complete full_execution_backfill',
    evidence: mechanicOffenses.flatMap((offense) => offense.evidence),
    sourceVersion: ledgerVersions[0] ?? null,
    coverage,
    integrityIssues,
  };

  const avoidableSuccess: AuditClaim<number> = {
    id: 'mechanics.avoidableSuccess',
    label: 'Éxito en mecánicas evitables',
    value: null,
    status: 'not_evaluable',
    scope,
    definition:
      'El pipeline causal actual materializa ownership y ofensas, pero todavía no publica un contrato player-level canónico de oportunidades evitables exitosas con numerador/denominador homogéneos.',
    evidence: [],
    coverage,
    integrityIssues: [
      ...integrityIssues,
      'No se deriva este porcentaje desde player_mechanic_offenses_v3 porque esa vista contiene solo fallos atribuibles y no define el denominador de éxitos.',
    ],
  };

  const totalDeaths: AuditClaim<number> = {
    id: 'deaths.total',
    label: 'Muertes observadas',
    value: complete ? deaths.length : null,
    status,
    scope,
    definition:
      'Eventos domain=death del execution ledger tras backfill causal fresco y completo. El conteo de muertes es factual; reasonCode/confidence se muestran aparte y el dosier no reinterpreta la causa.',
    numerator: complete ? deaths.length : undefined,
    formula: "count(player_execution_events where domain='death') after fresh complete full_execution_backfill",
    evidence: deaths.map((death) => death.evidence),
    sourceVersion: ledgerVersions[0] ?? null,
    coverage,
    integrityIssues,
  };

  return {
    reportCode,
    playerName,
    materializationState,
    coverage: {
      expectedPulls: expectedRows.length,
      completedPulls: materialization.completedPullIds.size,
      pendingPulls: materialization.pendingPullIds.size,
      failedPulls: materialization.failedPullIds.size,
    },
    actionableMechanicIncidents,
    avoidableSuccess,
    totalDeaths,
    mechanicOffenses,
    repeatedMechanicPatterns: complete ? buildPatterns(mechanicOffenses) : [],
    deaths,
    integrityIssues,
    sourceVersions: {
      ledgerEvaluatorVersion: ledgerVersions[0] ?? null,
      contextResolverVersion: contextVersions[0] ?? null,
      occurrenceResolverVersion: occurrenceVersions[0] ?? null,
    },
  };
}

@Injectable({ providedIn: 'root' })
export class NightPlayerMechanicDeathAuditService {
  private readonly supabase = inject(SupabaseService);
  private readonly pullLedger = inject(NightPlayerPullLedgerService);

  async load(reportCode: string, playerName: string): Promise<NightPlayerMechanicDeathAudit> {
    const ledger = await this.pullLedger.load(reportCode, playerName);
    const pullIds = ledger.rows.map((row) => row.pull.pullId);
    if (!pullIds.length) {
      return buildNightPlayerMechanicDeathAudit({
        reportCode,
        playerName,
        ledger,
        jobs: [],
        offenseFacts: [],
        deathFacts: [],
      });
    }

    const client = this.supabase.client;
    const [jobsResult, offensesResult, deathsResult] = await Promise.all([
      client
        .from('combat_evaluation_jobs')
        .select('pull_id,job_type,status,stage_progress,last_error,updated_at')
        .in('pull_id', pullIds),
      client
        .from('player_mechanic_offenses_v3')
        .select(
          'execution_event_id,pull_id,timestamp_ms,occurrence_id,mechanic_key,occurrence_index,relationship,reason_code,severity,priority,confidence,evidence,policy_version,context_resolver_version,occurrence_resolver_version,ledger_evaluator_version',
        )
        .eq('player_name', playerName)
        .in('pull_id', pullIds),
      client
        .from('player_execution_events')
        .select(
          'id,pull_id,timestamp_ms,event_type,verdict,reason_code,penalty_eligible,primary_penalty,severity,priority,confidence,evidence,context_resolver_version,occurrence_resolver_version,ledger_evaluator_version,evaluated_at',
        )
        .eq('domain', 'death')
        .eq('player_name', playerName)
        .in('pull_id', pullIds),
    ]);

    if (jobsResult.error) throw jobsResult.error;
    if (offensesResult.error) throw offensesResult.error;
    if (deathsResult.error) throw deathsResult.error;

    return buildNightPlayerMechanicDeathAudit({
      reportCode,
      playerName,
      ledger,
      jobs: (jobsResult.data ?? []) as CombatBackfillJobFact[],
      offenseFacts: (offensesResult.data ?? []) as MechanicOffenseFact[],
      deathFacts: (deathsResult.data ?? []) as DeathLedgerFact[],
    });
  }
}
