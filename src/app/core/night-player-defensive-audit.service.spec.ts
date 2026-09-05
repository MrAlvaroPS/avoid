import { describe, expect, it } from 'vitest';
import {
  buildNightPlayerDefensiveAudit,
  type NightPlayerDefensiveAudit,
} from './night-player-defensive-audit.service';
import type {
  CanonicalDefensiveEpisodeFact,
  CanonicalDefensiveGeneration,
  CanonicalDefensiveSummary,
} from './canonical-defensive-summary.service';
import type {
  NightPlayerPullLedger,
  NightPlayerPullLedgerRow,
} from './night-player-pull-ledger.service';
import type { PullEvidenceRef } from '../shared/models/night-player-audit';

const GENERATION: CanonicalDefensiveGeneration = {
  id: 'generation-v7',
  publishedAt: '2026-09-05T15:18:49Z',
  semanticVersion: 'defensive-semantics@1.0.0',
  resolverVersion: 'effective-defensives@2.3.0',
  semanticResolverVersion: 'effective-defensive-semantics@1.5.0',
  episodeVersion: 'episode-evaluator@7',
  evaluatorVersion: 'episode-evaluator@7',
  gameBuild: '12.1.0.68914',
};

function pullRef(id: string, fightId: number, pullNumber: number): PullEvidenceRef {
  return {
    reportCode: 'report-1',
    pullId: id,
    fightId,
    bossId: 'boss-1',
    bossName: "Nek'zali",
    difficulty: 'Mythic',
    bossPullNumber: pullNumber,
  };
}

function ledgerRow(id: string, fightId: number, pullNumber: number): NightPlayerPullLedgerRow {
  const pull = pullRef(id, fightId, pullNumber);
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
    label: `${pull.bossName} · Pull #${pullNumber}`,
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
      value: `${pull.bossName} · Pull #${pullNumber}`,
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

function ledger(rows: NightPlayerPullLedgerRow[]): NightPlayerPullLedger {
  return {
    reportCode: 'report-1',
    playerName: 'Raider',
    rows,
    excludedParticipatedPulls: [],
    integrity: 'complete',
    integrityIssues: [],
  };
}

let episodeSequence = 0;
function episode(
  pullId: string,
  overrides: Partial<CanonicalDefensiveEpisodeFact> = {},
): CanonicalDefensiveEpisodeFact {
  episodeSequence += 1;
  return {
    episodeId: `episode-${episodeSequence}`,
    causalGroupId: `causal-${episodeSequence}`,
    pullId,
    startMs: 10_000,
    peakMs: 11_000,
    endMs: 12_000,
    dominantAbilityGameId: 12345,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [],
    responseVerdict: 'missed_ready',
    responseReason: 'fixture',
    coveredBySpellId: null,
    decisiveSpellIds: [111],
    planAssignmentId: null,
    planVerdict: null,
    confidence: 'verified',
    ...overrides,
  };
}

function summary(
  episodes: CanonicalDefensiveEpisodeFact[],
  overrides: Partial<CanonicalDefensiveSummary> = {},
): CanonicalDefensiveSummary {
  return {
    state: 'available',
    coverage: { evaluatedPulls: 1, expectedPulls: 1 },
    usage: { status: 'available', score: 50, engaged: 1, evaluable: 2 },
    response: {
      status: 'available',
      score: 50,
      covered: 1,
      evaluable: 2,
      missedReady: 1,
      missedMistimed: 0,
    },
    management: { status: 'no_plan', score: null, fulfilled: 0, evaluable: 0 },
    context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 0, excluded: 0 },
    totalEpisodes: episodes.length,
    episodes,
    generation: GENERATION,
    integrityIssues: [],
    diagnostics: {
      usage: { status: 'available', engaged: 1, evaluable: 2, score: 50 },
      response: {
        status: 'available',
        covered: 1,
        evaluable: 2,
        score: 50,
        missedReady: 1,
        missedMistimed: 0,
      },
      rowsExpected: 1,
      rowsFound: 1,
    },
    ...overrides,
  };
}

function build(value: CanonicalDefensiveSummary, rows = [ledgerRow('p1', 10, 1)]): NightPlayerDefensiveAudit {
  return buildNightPlayerDefensiveAudit({
    reportCode: 'report-1',
    playerName: 'Raider',
    ledger: ledger(rows),
    summary: value,
  });
}

describe('NightPlayerDefensiveAudit · canonical evidence projection', () => {
  it('Response 12/20 conserva exactamente 20 episodios de denominador, 12 covered y 8 misses', () => {
    const episodes = [
      ...Array.from({ length: 12 }, () =>
        episode('p1', { responseVerdict: 'covered_verified', usageEngaged: true }),
      ),
      ...Array.from({ length: 5 }, () => episode('p1', { responseVerdict: 'missed_ready' })),
      ...Array.from({ length: 3 }, () =>
        episode('p1', { responseVerdict: 'missed_due_to_mistime', usageEngaged: true }),
      ),
    ];
    const result = build(
      summary(episodes, {
        usage: { status: 'available', score: 75, engaged: 15, evaluable: 20 },
        response: {
          status: 'available',
          score: 60,
          covered: 12,
          evaluable: 20,
          missedReady: 5,
          missedMistimed: 3,
        },
      }),
    );

    expect(result.response.value).toBe(60);
    expect(result.response.numerator).toBe(12);
    expect(result.response.denominator).toBe(20);
    expect(result.response.evidence).toHaveLength(20);
    expect(result.episodes.filter((item) => item.covered)).toHaveLength(12);
    expect(result.episodes.filter((item) => item.missedReady || item.missedMistimed)).toHaveLength(8);
    expect(result.response.status).toBe('canonical');
  });

  it('Uso reutiliza usageEvaluable canónico y no fuerza el denominador de Response', () => {
    const episodes = [
      episode('p1', { responseVerdict: 'covered_verified', usageEngaged: true, usageEvaluable: true }),
      episode('p1', { responseVerdict: 'missed_ready', usageEngaged: false, usageEvaluable: true }),
      episode('p1', { responseVerdict: 'uncertain', usageEngaged: true, usageEvaluable: true }),
    ];
    const result = build(
      summary(episodes, {
        usage: { status: 'available', score: 66.67, engaged: 2, evaluable: 3 },
        response: {
          status: 'available',
          score: 50,
          covered: 1,
          evaluable: 2,
          missedReady: 1,
          missedMistimed: 0,
        },
        context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 1, excluded: 0 },
      }),
    );

    expect(result.usage.denominator).toBe(3);
    expect(result.usage.evidence).toHaveLength(3);
    expect(result.response.denominator).toBe(2);
    expect(result.response.evidence).toHaveLength(2);
  });

  it('sin plan publicado Gestión queda N/D, nunca 0', () => {
    const episodes = [
      episode('p1', { responseVerdict: 'covered_verified', usageEngaged: true }),
      episode('p1', { responseVerdict: 'missed_ready' }),
    ];
    const result = build(summary(episodes));

    expect(result.management.value).toBeNull();
    expect(result.management.status).toBe('not_evaluable');
    expect(result.management.numerator).toBe(0);
    expect(result.management.denominator).toBe(0);
    expect(result.managementAssignments).toEqual([]);
  });

  it('Gestión conserva una sola unidad por assignment aunque aparezca en varios episodios', () => {
    const episodes = [
      episode('p1', {
        responseVerdict: 'covered_verified',
        usageEngaged: true,
        planAssignmentId: 'assignment-a',
        planVerdict: 'covered',
      }),
      episode('p1', {
        responseVerdict: 'covered_verified',
        usageEngaged: true,
        planAssignmentId: 'assignment-a',
        planVerdict: 'covered',
      }),
      episode('p1', {
        responseVerdict: 'missed_ready',
        planAssignmentId: 'assignment-b',
        planVerdict: 'missed',
      }),
    ];
    const result = build(
      summary(episodes, {
        usage: { status: 'available', score: 66.67, engaged: 2, evaluable: 3 },
        response: {
          status: 'available',
          score: 66.67,
          covered: 2,
          evaluable: 3,
          missedReady: 1,
          missedMistimed: 0,
        },
        management: { status: 'available', score: 50, fulfilled: 1, evaluable: 2 },
      }),
    );

    expect(result.managementAssignments).toHaveLength(2);
    expect(result.management.denominator).toBe(2);
    expect(result.management.numerator).toBe(1);
    expect(result.management.evidence).toHaveLength(2);
    expect(result.management.status).toBe('canonical');
  });

  it('una generación publicada sin filas seguras permanece incompatible y no fabrica KPI', () => {
    const value = summary([], {
      state: 'incompatible',
      coverage: { evaluatedPulls: 0, expectedPulls: 1 },
      usage: { status: 'insufficient_evidence', score: null, engaged: 0, evaluable: 0 },
      response: {
        status: 'insufficient_evidence',
        score: null,
        covered: 0,
        evaluable: 0,
        missedReady: 0,
        missedMistimed: 0,
      },
      management: { status: 'insufficient_evidence', score: null, fulfilled: 0, evaluable: 0 },
      integrityIssues: ['No hay filas compatibles para este report.'],
    });
    const result = build(value);

    expect(result.integrity).toBe('incompatible');
    expect(result.usage.value).toBeNull();
    expect(result.response.value).toBeNull();
    expect(result.usage.status).toBe('incompatible');
    expect(result.response.status).toBe('incompatible');
  });

  it('si falta identidad de pull no altera el KPI canónico, pero degrada la auditabilidad a partial', () => {
    const episodes = [episode('p2', { responseVerdict: 'covered_verified', usageEngaged: true })];
    const value = summary(episodes, {
      usage: { status: 'available', score: 100, engaged: 1, evaluable: 1 },
      response: {
        status: 'available',
        score: 100,
        covered: 1,
        evaluable: 1,
        missedReady: 0,
        missedMistimed: 0,
      },
    });
    const result = build(value, [ledgerRow('p1', 10, 1)]);

    expect(result.response.value).toBe(100);
    expect(result.response.denominator).toBe(1);
    expect(result.response.evidence).toHaveLength(0);
    expect(result.response.status).toBe('partial');
    expect(result.integrity).toBe('partial');
    expect(result.unresolvedEpisodes).toHaveLength(1);
  });
});
