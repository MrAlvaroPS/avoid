import { describe, expect, it } from 'vitest';
import {
  buildCausalMechanicAcceptance,
  type MechanicLedgerAcceptanceFact,
  type MechanicOccurrenceAcceptanceFact,
  type MechanicResponsibilityAcceptanceFact,
} from './causal-mechanic-acceptance.service';
import type { NightPlayerMechanicDeathAudit } from './night-player-mechanic-death-audit.service';

function audit(overrides: Partial<NightPlayerMechanicDeathAudit> = {}): NightPlayerMechanicDeathAudit {
  return {
    reportCode: 'report-1',
    playerName: 'Raider',
    materializationState: 'complete',
    coverage: { expectedPulls: 1, completedPulls: 1, pendingPulls: 0, failedPulls: 0 },
    actionableMechanicIncidents: {
      id: 'mechanics.actionableIncidents',
      label: 'Incidentes',
      value: 1,
      status: 'canonical',
      scope: { reportCode: 'report-1', playerName: 'Raider', pullIds: ['p1'] },
      definition: 'fixture',
      evidence: [],
      integrityIssues: [],
    },
    avoidableSuccess: {
      id: 'mechanics.avoidableSuccess',
      label: 'Avoidable',
      value: null,
      status: 'not_evaluable',
      scope: { reportCode: 'report-1', playerName: 'Raider', pullIds: ['p1'] },
      definition: 'fixture',
      evidence: [],
      integrityIssues: [],
    },
    totalDeaths: {
      id: 'deaths.total',
      label: 'Deaths',
      value: 0,
      status: 'canonical',
      scope: { reportCode: 'report-1', playerName: 'Raider', pullIds: ['p1'] },
      definition: 'fixture',
      evidence: [],
      integrityIssues: [],
    },
    mechanicOffenses: [{ eventId: 'e1' } as never],
    repeatedMechanicPatterns: [],
    deaths: [],
    integrityIssues: [],
    sourceVersions: {
      ledgerEvaluatorVersion: 'execution-ledger@1.0.0',
      contextResolverVersion: 'pull-context@2',
      occurrenceResolverVersion: 'occurrence@2',
    },
    ...overrides,
  } as NightPlayerMechanicDeathAudit;
}

function occurrence(overrides: Partial<MechanicOccurrenceAcceptanceFact> = {}): MechanicOccurrenceAcceptanceFact {
  return {
    id: 'occ-1',
    pull_id: 'p1',
    outcome: 'fail',
    confidence: 'verified',
    policy_version: 1,
    context_resolver_version: 'pull-context@2',
    occurrence_resolver_version: 'occurrence@2',
    ...overrides,
  };
}

function edge(overrides: Partial<MechanicResponsibilityAcceptanceFact> = {}): MechanicResponsibilityAcceptanceFact {
  return {
    occurrence_id: 'occ-1',
    player_name: 'Raider',
    relationship: 'primary_owner',
    penalty_eligible: true,
    confidence: 'verified',
    reason_code: 'PERSONAL_GROUND_HIT',
    ...overrides,
  };
}

function ledgerEvent(overrides: Partial<MechanicLedgerAcceptanceFact> = {}): MechanicLedgerAcceptanceFact {
  return {
    id: 'e1',
    pull_id: 'p1',
    player_name: 'Raider',
    occurrence_id: 'occ-1',
    verdict: 'failure',
    penalty_eligible: true,
    primary_penalty: true,
    confidence: 'verified',
    reason_code: 'PERSONAL_GROUND_HIT',
    ledger_evaluator_version: 'execution-ledger@1.0.0',
    ...overrides,
  };
}

describe('CausalMechanicAcceptance', () => {
  it('queda listo para comparación manual cuando todos los checks automáticos pasan', () => {
    const result = buildCausalMechanicAcceptance({
      audit: audit(),
      occurrences: [occurrence()],
      edges: [edge()],
      mechanicLedgerEvents: [ledgerEvent()],
    });

    expect(result.state).toBe('ready_for_manual_comparison');
    expect(result.automaticFailures).toBe(0);
    expect(result.checks.find((check) => check.id === 'attribution_safety_v1_comparison')?.state).toBe('pending');
  });

  it('materialización incompleta bloquea aunque no haya fallos automáticos observables todavía', () => {
    const result = buildCausalMechanicAcceptance({
      audit: audit({
        materializationState: 'partial',
        coverage: { expectedPulls: 2, completedPulls: 1, pendingPulls: 1, failedPulls: 0 },
      }),
      occurrences: [occurrence()],
      edges: [edge()],
      mechanicLedgerEvents: [ledgerEvent()],
    });

    expect(result.state).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'materialization_complete')?.state).toBe('pending');
  });

  it('una penalización sin responsibility edge trusted bloquea el cutover', () => {
    const result = buildCausalMechanicAcceptance({
      audit: audit(),
      occurrences: [occurrence()],
      edges: [],
      mechanicLedgerEvents: [ledgerEvent()],
    });

    expect(result.state).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'punitive_events_have_trusted_owner_edge')?.state).toBe('fail');
  });

  it('collateral_victim penalty-eligible falla explícitamente', () => {
    const result = buildCausalMechanicAcceptance({
      audit: audit(),
      occurrences: [occurrence()],
      edges: [edge(), edge({ relationship: 'collateral_victim' })],
      mechanicLedgerEvents: [ledgerEvent()],
    });

    expect(result.state).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'no_collateral_penalties')?.state).toBe('fail');
  });

  it('confidence fallback en un evento punitivo falla aunque exista edge válido', () => {
    const result = buildCausalMechanicAcceptance({
      audit: audit(),
      occurrences: [occurrence()],
      edges: [edge()],
      mechanicLedgerEvents: [ledgerEvent({ confidence: 'fallback' })],
    });

    expect(result.state).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'punitive_events_trusted')?.state).toBe('fail');
  });

  it('mezcla de versiones de occurrence bloquea la aceptación automática', () => {
    const result = buildCausalMechanicAcceptance({
      audit: audit(),
      occurrences: [occurrence(), occurrence({ id: 'occ-2', occurrence_resolver_version: 'occurrence@3' })],
      edges: [edge()],
      mechanicLedgerEvents: [ledgerEvent()],
    });

    expect(result.state).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'versions_homogeneous')?.state).toBe('fail');
  });
});
