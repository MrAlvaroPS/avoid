import { describe, expect, it } from 'vitest';
import {
  buildNightPlayerMechanicDeathAudit,
  type CombatBackfillJobFact,
  type DeathLedgerFact,
  type MechanicOffenseFact,
} from './night-player-mechanic-death-audit.service';
import type {
  NightPlayerPullLedger,
  NightPlayerPullLedgerRow,
} from './night-player-pull-ledger.service';
import type { PullEvidenceRef } from '../shared/models/night-player-audit';

function pullRef(id: string, fightId: number, number: number): PullEvidenceRef {
  return {
    reportCode: 'report-1',
    pullId: id,
    fightId,
    bossId: 'boss-1',
    bossName: "Nek'zali",
    difficulty: 'Mythic',
    bossPullNumber: number,
  };
}

function pullRow(id: string, fightId: number, number: number): NightPlayerPullLedgerRow {
  const pull = pullRef(id, fightId, number);
  const scope = { reportCode: 'report-1', playerName: 'Raider', pullIds: [id] };
  const evidence = {
    id: `wcl:${id}`,
    kind: 'wcl_pull' as const,
    source: 'wcl' as const,
    locator: `https://www.warcraftlogs.com/reports/report1#fight=${fightId}`,
    pull,
  };
  return {
    key: `report-1:${id}`,
    pull,
    label: `${pull.bossName} · Pull #${number}`,
    wclUrl: evidence.locator,
    wipePct: 50,
    worldTotalParses: 100,
    participation: {
      id: `pull.population:${id}`,
      label: 'Participación',
      value: true,
      status: 'direct',
      scope,
      definition: 'fixture',
      evidence: [evidence],
      integrityIssues: [],
    },
    identity: {
      id: `pull.identity:${id}`,
      label: 'Identidad',
      value: `${pull.bossName} · Pull #${number}`,
      status: 'derived',
      scope,
      definition: 'fixture',
      evidence: [evidence],
      integrityIssues: [],
    },
    result: {
      id: `pull.result:${id}`,
      label: 'Resultado',
      value: 'wipe',
      status: 'derived',
      scope,
      definition: 'fixture',
      evidence: [evidence],
      integrityIssues: [],
    },
    duration: {
      id: `pull.duration:${id}`,
      label: 'Duración',
      value: 180_000,
      status: 'direct',
      scope,
      definition: 'fixture',
      evidence: [evidence],
      integrityIssues: [],
    },
    parse: {
      id: `wcl.parse:${id}`,
      label: 'Parse',
      value: 80,
      status: 'direct',
      scope,
      definition: 'fixture',
      evidence: [evidence],
      integrityIssues: [],
    },
    integrity: 'complete',
    integrityIssues: [],
  };
}

function ledger(rows = [pullRow('p1', 10, 1), pullRow('p2', 11, 2)]): NightPlayerPullLedger {
  return {
    reportCode: 'report-1',
    playerName: 'Raider',
    rows,
    excludedParticipatedPulls: [],
    integrity: 'complete',
    integrityIssues: [],
  };
}

function job(pullId: string, status: CombatBackfillJobFact['status'] = 'done'): CombatBackfillJobFact {
  return {
    pull_id: pullId,
    status,
    stage_progress: status === 'done' ? { occurrences: 4, responsibilityEdges: 7, ledgerEvents: 20 } : {},
    last_error: status === 'error' ? 'fixture failure' : null,
    updated_at: '2026-09-05T20:00:00Z',
  };
}

function offense(overrides: Partial<MechanicOffenseFact> = {}): MechanicOffenseFact {
  return {
    execution_event_id: 'event-mechanic-1',
    pull_id: 'p1',
    timestamp_ms: 25_000,
    occurrence_id: 'occ-1',
    mechanic_key: 'boss-1:mechanic:spread',
    occurrence_index: 2,
    relationship: 'primary_owner',
    reason_code: 'SPREAD_CARRIER_COLLATERAL',
    severity: 50,
    priority: 1,
    confidence: 'verified',
    evidence: { relationship: 'primary_owner' },
    policy_version: 1,
    context_resolver_version: 'pull-context@2',
    occurrence_resolver_version: 'occurrence@2',
    ledger_evaluator_version: 'execution-ledger@1.0.0',
    ...overrides,
  };
}

function death(overrides: Partial<DeathLedgerFact> = {}): DeathLedgerFact {
  return {
    id: 'death-event-1',
    pull_id: 'p2',
    timestamp_ms: 61_000,
    event_type: 'death_event',
    verdict: 'uncertain',
    reason_code: 'UNCERTAIN_CAUSE',
    penalty_eligible: false,
    primary_penalty: false,
    severity: 0,
    priority: 1,
    confidence: 'uncertain',
    evidence: { source: 'player_pull_records', root_cause: 'unclassified' },
    context_resolver_version: 'pull-context@2',
    occurrence_resolver_version: null,
    ledger_evaluator_version: 'execution-ledger@1.0.0',
    evaluated_at: '2026-09-05T20:00:00Z',
    ...overrides,
  };
}

function build(args: {
  jobs?: CombatBackfillJobFact[];
  offenses?: MechanicOffenseFact[];
  deaths?: DeathLedgerFact[];
  ledgerValue?: NightPlayerPullLedger;
} = {}) {
  return buildNightPlayerMechanicDeathAudit({
    reportCode: 'report-1',
    playerName: 'Raider',
    ledger: args.ledgerValue ?? ledger(),
    jobs: args.jobs ?? [],
    offenseFacts: args.offenses ?? [],
    deathFacts: args.deaths ?? [],
  });
}

describe('NightPlayerMechanicDeathAudit · canonical materialization gate', () => {
  it('sin full_execution_backfill no convierte cero filas en cero incidentes', () => {
    const result = build();

    expect(result.materializationState).toBe('unavailable');
    expect(result.actionableMechanicIncidents.value).toBeNull();
    expect(result.totalDeaths.value).toBeNull();
    expect(result.actionableMechanicIncidents.status).toBe('not_evaluable');
    expect(result.totalDeaths.status).toBe('not_evaluable');
    expect(result.integrityIssues.some((issue) => issue.includes('cero filas causales'))).toBe(true);
  });

  it('solo tras backfill completo un cero observado puede publicarse como cero canónico', () => {
    const result = build({ jobs: [job('p1'), job('p2')] });

    expect(result.materializationState).toBe('complete');
    expect(result.coverage).toEqual({ expectedPulls: 2, completedPulls: 2, pendingPulls: 0, failedPulls: 0 });
    expect(result.actionableMechanicIncidents.value).toBe(0);
    expect(result.totalDeaths.value).toBe(0);
    expect(result.actionableMechanicIncidents.status).toBe('canonical');
    expect(result.totalDeaths.status).toBe('canonical');
  });

  it('proyecta ofensa atribuible y muerte desde el ledger con evidencia reconstruible', () => {
    const result = build({
      jobs: [job('p1'), job('p2')],
      offenses: [offense()],
      deaths: [death()],
    });

    expect(result.actionableMechanicIncidents.value).toBe(1);
    expect(result.totalDeaths.value).toBe(1);
    expect(result.mechanicOffenses).toHaveLength(1);
    expect(result.mechanicOffenses[0].pullLabel).toBe("Nek'zali · Pull #1");
    expect(result.mechanicOffenses[0].evidence.map((evidence) => evidence.kind)).toEqual([
      'execution_ledger',
      'mechanic_event',
    ]);
    expect(result.deaths).toHaveLength(1);
    expect(result.deaths[0].pullLabel).toBe("Nek'zali · Pull #2");
    expect(result.deaths[0].evidence.kind).toBe('execution_ledger');
  });

  it('una muerte uncertain sigue contando como muerte factual pero no se convierte en culpa', () => {
    const result = build({ jobs: [job('p1'), job('p2')], deaths: [death()] });

    expect(result.totalDeaths.value).toBe(1);
    expect(result.deaths[0]).toMatchObject({
      verdict: 'uncertain',
      penaltyEligible: false,
      primaryPenalty: false,
      confidence: 'uncertain',
    });
  });

  it('cobertura parcial mantiene los totales en null aunque existan filas observadas', () => {
    const result = build({ jobs: [job('p1')], offenses: [offense()] });

    expect(result.materializationState).toBe('partial');
    expect(result.coverage.completedPulls).toBe(1);
    expect(result.actionableMechanicIncidents.value).toBeNull();
    expect(result.mechanicOffenses).toHaveLength(1);
    expect(result.repeatedMechanicPatterns).toEqual([]);
  });

  it('mezcla de versiones falla cerrado aunque todos los jobs figuren done', () => {
    const result = build({
      jobs: [job('p1'), job('p2')],
      offenses: [offense()],
      deaths: [death({ ledger_evaluator_version: 'execution-ledger@2.0.0' })],
    });

    expect(result.materializationState).toBe('incompatible');
    expect(result.actionableMechanicIncidents.value).toBeNull();
    expect(result.totalDeaths.value).toBeNull();
    expect(result.actionableMechanicIncidents.status).toBe('incompatible');
  });

  it('no fabrica Avoidable Success desde una vista que solo contiene ofensas', () => {
    const result = build({ jobs: [job('p1'), job('p2')], offenses: [offense()] });

    expect(result.avoidableSuccess.value).toBeNull();
    expect(result.avoidableSuccess.status).toBe('not_evaluable');
    expect(result.avoidableSuccess.integrityIssues.some((issue) => issue.includes('solo fallos atribuibles'))).toBe(true);
  });

  it('patrones repetidos solo se construyen con cobertura completa', () => {
    const result = build({
      jobs: [job('p1'), job('p2')],
      offenses: [offense(), offense({ execution_event_id: 'event-mechanic-2', pull_id: 'p2', occurrence_id: 'occ-2' })],
    });

    expect(result.repeatedMechanicPatterns).toHaveLength(1);
    expect(result.repeatedMechanicPatterns[0]).toMatchObject({
      mechanicKey: 'boss-1:mechanic:spread',
      count: 2,
    });
    expect(result.repeatedMechanicPatterns[0].pullIds).toEqual(['p1', 'p2']);
  });
});
