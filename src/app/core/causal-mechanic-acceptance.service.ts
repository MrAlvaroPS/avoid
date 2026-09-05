import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import {
  NightPlayerMechanicDeathAuditService,
  type NightPlayerMechanicDeathAudit,
} from './night-player-mechanic-death-audit.service';

export type CausalAcceptanceCheckState = 'pass' | 'fail' | 'pending' | 'warning';
export type CausalAcceptanceState = 'blocked' | 'ready_for_manual_comparison';

export interface CausalAcceptanceCheck {
  id: string;
  label: string;
  state: CausalAcceptanceCheckState;
  detail: string;
  evidenceCount?: number;
}

export interface MechanicOccurrenceAcceptanceFact {
  id: string;
  pull_id: string;
  outcome: 'success' | 'partial_fail' | 'fail' | 'not_evaluable' | 'uncertain';
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  policy_version: number;
  context_resolver_version: string;
  occurrence_resolver_version: string;
}

export interface MechanicResponsibilityAcceptanceFact {
  occurrence_id: string;
  player_name: string;
  relationship:
    | 'primary_owner'
    | 'co_owner'
    | 'assigned_resolver'
    | 'successful_resolver'
    | 'target'
    | 'collateral_victim'
    | 'beneficiary';
  penalty_eligible: boolean;
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  reason_code: string;
}

export interface MechanicLedgerAcceptanceFact {
  id: string;
  pull_id: string;
  player_name: string;
  occurrence_id: string | null;
  verdict: 'success' | 'failure' | 'correct_hold' | 'missed' | 'context' | 'not_applicable' | 'uncertain';
  penalty_eligible: boolean;
  primary_penalty: boolean;
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  reason_code: string;
  ledger_evaluator_version: string;
}

export interface CausalMechanicAcceptanceReport {
  reportCode: string;
  playerName: string;
  state: CausalAcceptanceState;
  checks: readonly CausalAcceptanceCheck[];
  automaticPasses: number;
  automaticFailures: number;
  pendingManualChecks: number;
  occurrenceCount: number;
  responsibilityEdgeCount: number;
  punitiveMechanicEventCount: number;
}

const PUNITIVE_RELATIONSHIPS = new Set(['primary_owner', 'co_owner', 'assigned_resolver']);
const TRUSTED_CONFIDENCE = new Set(['verified', 'inferred']);

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function buildCausalMechanicAcceptance(args: {
  audit: NightPlayerMechanicDeathAudit;
  occurrences: readonly MechanicOccurrenceAcceptanceFact[];
  edges: readonly MechanicResponsibilityAcceptanceFact[];
  mechanicLedgerEvents: readonly MechanicLedgerAcceptanceFact[];
}): CausalMechanicAcceptanceReport {
  const { audit, occurrences, edges, mechanicLedgerEvents } = args;
  const checks: CausalAcceptanceCheck[] = [];
  const targetPullIds = audit.actionableMechanicIncidents.scope.pullIds ?? [];
  const targetPullSet = new Set(targetPullIds);
  const relevantOccurrences = occurrences.filter((row) => targetPullSet.has(row.pull_id));
  const occurrenceIds = new Set(relevantOccurrences.map((row) => row.id));
  const relevantEdges = edges.filter((row) => occurrenceIds.has(row.occurrence_id));
  const relevantLedger = mechanicLedgerEvents.filter((row) => targetPullSet.has(row.pull_id));
  const punitiveLedger = relevantLedger.filter((row) => row.penalty_eligible);
  const punitiveEdges = relevantEdges.filter((row) => row.penalty_eligible);

  checks.push({
    id: 'materialization_complete',
    label: 'Materialización fresh-complete',
    state:
      audit.materializationState === 'complete'
        ? 'pass'
        : audit.materializationState === 'incompatible'
          ? 'fail'
          : 'pending',
    detail: `${audit.coverage.completedPulls}/${audit.coverage.expectedPulls} pulls completos; ${audit.coverage.pendingPulls} pending; ${audit.coverage.failedPulls} error.`,
    evidenceCount: audit.coverage.completedPulls,
  });

  checks.push({
    id: 'integrity_clean',
    label: 'Integridad del read-model',
    state: audit.integrityIssues.length === 0 ? 'pass' : audit.materializationState === 'complete' ? 'fail' : 'pending',
    detail: audit.integrityIssues.length
      ? `${audit.integrityIssues.length} issue(s) de integridad siguen abiertos.`
      : 'Sin issues de integridad en la proyección causal.',
    evidenceCount: audit.integrityIssues.length,
  });

  const contextVersions = unique(relevantOccurrences.map((row) => row.context_resolver_version));
  const occurrenceVersions = unique(relevantOccurrences.map((row) => row.occurrence_resolver_version));
  const ledgerVersions = unique(relevantLedger.map((row) => row.ledger_evaluator_version));
  const versionMix = contextVersions.length > 1 || occurrenceVersions.length > 1 || ledgerVersions.length > 1;
  checks.push({
    id: 'versions_homogeneous',
    label: 'Versiones homogéneas',
    state: versionMix ? 'fail' : relevantOccurrences.length || relevantLedger.length ? 'pass' : 'pending',
    detail: `context=${contextVersions.join(', ') || 'N/D'} · occurrence=${occurrenceVersions.join(', ') || 'N/D'} · ledger=${ledgerVersions.join(', ') || 'N/D'}`,
  });

  checks.push({
    id: 'occurrence_evidence_present',
    label: 'Occurrences observables',
    state:
      audit.materializationState !== 'complete'
        ? 'pending'
        : relevantOccurrences.length > 0
          ? 'pass'
          : 'warning',
    detail:
      relevantOccurrences.length > 0
        ? `${relevantOccurrences.length} occurrence(s) materializadas en el scope.`
        : 'Backfill completo sin occurrences observadas: puede ser legítimo, pero requiere contraste de corpus antes del cutover.',
    evidenceCount: relevantOccurrences.length,
  });

  const untrustedPunitiveEvents = punitiveLedger.filter((row) => !TRUSTED_CONFIDENCE.has(row.confidence));
  checks.push({
    id: 'punitive_events_trusted',
    label: 'Penalizaciones con confidence trusted',
    state: untrustedPunitiveEvents.length ? 'fail' : 'pass',
    detail: untrustedPunitiveEvents.length
      ? `${untrustedPunitiveEvents.length} evento(s) punitivos usan fallback/uncertain.`
      : 'Ningún evento mecánico punitivo usa fallback/uncertain.',
    evidenceCount: punitiveLedger.length,
  });

  const unlinkedPunitiveEvents = punitiveLedger.filter((row) => row.occurrence_id == null);
  checks.push({
    id: 'punitive_events_have_occurrence',
    label: 'Toda penalización enlaza una occurrence',
    state: unlinkedPunitiveEvents.length ? 'fail' : 'pass',
    detail: unlinkedPunitiveEvents.length
      ? `${unlinkedPunitiveEvents.length} evento(s) punitivos carecen de occurrence_id.`
      : 'Todas las penalizaciones mecánicas enlazan una occurrence.',
    evidenceCount: punitiveLedger.length,
  });

  const edgeKey = (occurrenceId: string, playerName: string) => `${occurrenceId}\u0000${playerName}`;
  const punitiveEdgeKeys = new Set(
    punitiveEdges
      .filter((edge) => PUNITIVE_RELATIONSHIPS.has(edge.relationship) && TRUSTED_CONFIDENCE.has(edge.confidence))
      .map((edge) => edgeKey(edge.occurrence_id, edge.player_name)),
  );
  const ledgerWithoutTrustedEdge = punitiveLedger.filter(
    (event) => event.occurrence_id == null || !punitiveEdgeKeys.has(edgeKey(event.occurrence_id, event.player_name)),
  );
  checks.push({
    id: 'punitive_events_have_trusted_owner_edge',
    label: 'Toda penalización tiene ownership explícito/trusted',
    state: ledgerWithoutTrustedEdge.length ? 'fail' : 'pass',
    detail: ledgerWithoutTrustedEdge.length
      ? `${ledgerWithoutTrustedEdge.length} penalización(es) no tienen edge punitivo trusted de owner/co-owner/assigned.`
      : 'Cada penalización mecánica tiene responsibility edge explícito y trusted.',
    evidenceCount: punitiveLedger.length,
  });

  const collateralPenalties = punitiveEdges.filter((edge) => edge.relationship === 'collateral_victim');
  checks.push({
    id: 'no_collateral_penalties',
    label: 'Víctimas colaterales nunca son culpables',
    state: collateralPenalties.length ? 'fail' : 'pass',
    detail: collateralPenalties.length
      ? `${collateralPenalties.length} edge(s) collateral_victim aparecen como penalty_eligible.`
      : 'No existe ninguna penalización sobre collateral_victim.',
    evidenceCount: relevantEdges.length,
  });

  const untrustedPunitiveEdges = punitiveEdges.filter((edge) => !TRUSTED_CONFIDENCE.has(edge.confidence));
  checks.push({
    id: 'punitive_edges_trusted',
    label: 'Responsibility edges punitivos trusted',
    state: untrustedPunitiveEdges.length ? 'fail' : 'pass',
    detail: untrustedPunitiveEdges.length
      ? `${untrustedPunitiveEdges.length} edge(s) punitivos usan fallback/uncertain.`
      : 'Todos los responsibility edges punitivos son verified/inferred.',
    evidenceCount: punitiveEdges.length,
  });

  const primaryWithoutPrimaryOwner = punitiveLedger.filter((event) => {
    if (!event.primary_penalty || event.occurrence_id == null) return false;
    return !relevantEdges.some(
      (edge) =>
        edge.occurrence_id === event.occurrence_id &&
        edge.player_name === event.player_name &&
        edge.penalty_eligible &&
        edge.relationship === 'primary_owner',
    );
  });
  checks.push({
    id: 'primary_penalty_requires_primary_owner',
    label: 'Primary penalty exige primary_owner',
    state: primaryWithoutPrimaryOwner.length ? 'fail' : 'pass',
    detail: primaryWithoutPrimaryOwner.length
      ? `${primaryWithoutPrimaryOwner.length} primary penalty(s) no tienen edge primary_owner.`
      : 'Todas las primary penalties observadas tienen primary_owner explícito.',
    evidenceCount: punitiveLedger.filter((row) => row.primary_penalty).length,
  });

  const viewMismatch = audit.materializationState === 'complete' && audit.mechanicOffenses.length !== punitiveLedger.length;
  checks.push({
    id: 'offense_view_consistent',
    label: 'View de ofensas consistente con ledger punitivo',
    state: audit.materializationState !== 'complete' ? 'pending' : viewMismatch ? 'fail' : 'pass',
    detail:
      audit.materializationState !== 'complete'
        ? 'Se comprobará cuando el scope esté materializado por completo.'
        : `player_mechanic_offenses_v3=${audit.mechanicOffenses.length} · ledger punitivo=${punitiveLedger.length}.`,
    evidenceCount: audit.mechanicOffenses.length,
  });

  checks.push({
    id: 'attribution_safety_v1_comparison',
    label: 'Comparación Attribution Safety v1 (#17)',
    state: 'pending',
    detail:
      'Gate manual obligatorio: comparar legacy original → Attribution Safety v1 → causal v3 y justificar con responsibility edge trusted toda nueva atribución punitiva.',
  });

  const automaticChecks = checks.filter((check) => check.id !== 'attribution_safety_v1_comparison');
  const automaticFailures = automaticChecks.filter((check) => check.state === 'fail').length;
  const automaticPending = automaticChecks.filter((check) => check.state === 'pending').length;
  const automaticPasses = automaticChecks.filter((check) => check.state === 'pass').length;
  const state: CausalAcceptanceState =
    automaticFailures === 0 && automaticPending === 0
      ? 'ready_for_manual_comparison'
      : 'blocked';

  return {
    reportCode: audit.reportCode,
    playerName: audit.playerName,
    state,
    checks,
    automaticPasses,
    automaticFailures,
    pendingManualChecks: 1,
    occurrenceCount: relevantOccurrences.length,
    responsibilityEdgeCount: relevantEdges.length,
    punitiveMechanicEventCount: punitiveLedger.length,
  };
}

async function readInChunks<T>(
  ids: readonly string[],
  loader: (chunk: string[]) => Promise<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const result: T[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const { data, error } = await loader(ids.slice(index, index + 100));
    if (error) throw error;
    result.push(...(data ?? []));
  }
  return result;
}

@Injectable({ providedIn: 'root' })
export class CausalMechanicAcceptanceService {
  private readonly supabase = inject(SupabaseService);
  private readonly auditService = inject(NightPlayerMechanicDeathAuditService);

  async load(reportCode: string, playerName: string): Promise<CausalMechanicAcceptanceReport> {
    const audit = await this.auditService.load(reportCode, playerName);
    const pullIds = audit.actionableMechanicIncidents.scope.pullIds ?? [];
    if (!pullIds.length) {
      return buildCausalMechanicAcceptance({ audit, occurrences: [], edges: [], mechanicLedgerEvents: [] });
    }

    const client = this.supabase.client;
    const { data: occurrenceData, error: occurrenceError } = await client
      .from('mechanic_occurrence_evaluations')
      .select('id,pull_id,outcome,confidence,policy_version,context_resolver_version,occurrence_resolver_version')
      .in('pull_id', pullIds);
    if (occurrenceError) throw occurrenceError;
    const occurrences = (occurrenceData ?? []) as MechanicOccurrenceAcceptanceFact[];
    const occurrenceIds = occurrences.map((row) => row.id);

    const edges = occurrenceIds.length
      ? await readInChunks<MechanicResponsibilityAcceptanceFact>(occurrenceIds, async (chunk) => {
          const { data, error } = await client
            .from('mechanic_responsibility_edges')
            .select('occurrence_id,player_name,relationship,penalty_eligible,confidence,reason_code')
            .eq('player_name', playerName)
            .in('occurrence_id', chunk);
          return { data: data as MechanicResponsibilityAcceptanceFact[] | null, error };
        })
      : [];

    const { data: ledgerData, error: ledgerError } = await client
      .from('player_execution_events')
      .select('id,pull_id,player_name,occurrence_id,verdict,penalty_eligible,primary_penalty,confidence,reason_code,ledger_evaluator_version')
      .eq('player_name', playerName)
      .eq('domain', 'mechanic')
      .in('pull_id', pullIds);
    if (ledgerError) throw ledgerError;

    return buildCausalMechanicAcceptance({
      audit,
      occurrences,
      edges,
      mechanicLedgerEvents: (ledgerData ?? []) as MechanicLedgerAcceptanceFact[],
    });
  }
}
