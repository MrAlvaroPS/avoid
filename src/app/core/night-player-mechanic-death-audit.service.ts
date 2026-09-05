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

export interface CombatBackfillJobFact {
  pull_id: string;
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
    case 'complete':
      return 'canonical';
    case 'partial':
      return 'partial';
    case 'incompatible':
      return 'incompatible';
    case 'unavailable':
      return 'not_evaluable';
  }
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

/**
 * Proyección de auditoría sobre el pipeline causal v3.
 *
 * Un `full_execution_backfill=done` por cada pull válido participado es el marker
 * de completitud: ese job encadena occurrences -> responsibility edges -> ledger.
 * Sin ese marker, cero filas NO significa cero fallos/muertes y por tanto los
 * claims permanecen N/D/partial.
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

  const relevantJobs = jobs.filter((job) => expectedPullIds.has(job.pull_id));
  const donePullIds = new Set(relevantJobs.filter((job) => job.status === 'done').map((job) => job.pull_id));
  const failedJobs = relevantJobs.filter((job) => job.status === 'error');
  const pendingJobs = relevantJobs.filter((job) => job.status === 'queued' || job.status === 'running');

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
  } else if (donePullIds.size === expectedRows.length) {
    materializationState = 'complete';
  } else if (relevantJobs.length === 0) {
    materializationState = 'unavailable';
    integrityIssues.push(
      `No existe full_execution_backfill para los ${expectedRows.length} pulls válidos participados; cero filas causales no puede interpretarse como cero incidentes.`,
    );
  } else {
    materializationState = 'partial';
    integrityIssues.push(
      `Backfill causal incompleto: ${donePullIds.size}/${expectedRows.length} pulls terminados, ${pendingJobs.length} pendientes y ${failedJobs.length} con error.`,
    );
  }

  for (const failed of failedJobs) {
    integrityIssues.push(
      `Backfill ${failed.pull_id} falló${failed.last_error ? `: ${failed.last_error}` : '.'}`,
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
  const coverage = { expected: expectedRows.length, observed: donePullIds.size };
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
    formula: 'count(player_mechanic_offenses_v3) after complete full_execution_backfill',
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
      'Eventos domain=death del execution ledger tras backfill causal completo. El conteo de muertes es factual; reasonCode/confidence se muestran aparte y el dosier no reinterpreta la causa.',
    numerator: complete ? deaths.length : undefined,
    formula: "count(player_execution_events where domain='death') after complete full_execution_backfill",
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
      completedPulls: donePullIds.size,
      pendingPulls: pendingJobs.length,
      failedPulls: failedJobs.length,
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
        .select('pull_id,status,stage_progress,last_error,updated_at')
        .eq('job_type', 'full_execution_backfill')
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
