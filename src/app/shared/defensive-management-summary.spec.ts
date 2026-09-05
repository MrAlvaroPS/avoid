import { describe, expect, it } from 'vitest';
import { buildNightDefensiveManagementV2 } from '../core/night-player-summary.service';
import type { PlayerPullDefensiveEvaluationRow } from './models/domain';

function pull(id: string, excludedFromStats = false) {
  return {
    pullId: id,
    pullNumber: Number(id.slice(-1)) || 1,
    bossId: '3012',
    bossName: 'Nexus-King',
    difficulty: 'Mythic',
    excludedFromStats,
  };
}

function evaluation(pullId: string, overrides: Partial<PlayerPullDefensiveEvaluationRow> = {}): PlayerPullDefensiveEvaluationRow {
  return {
    pull_id: pullId,
    player_name: 'Alda',
    plan_version_id: 'plan-1',
    mode: 'full',
    game_build: '12.0.0.1',
    build_fingerprint: 'fp',
    resolver_version: 'effective-defensives@2.1.0',
    solver_version: 'solver@test',
    evaluator_version: 'defensive-execution-evaluator@2.4.0',
    plan_required_count: 1,
    plan_executed_count: 1,
    critical_window_count: 1,
    critical_covered_count: 1,
    correct_hold_count: 0,
    broken_reservation_count: 0,
    reminder_missed_count: 0,
    viable_extra_count: 0,
    extra_used_count: 0,
    death_viable_cd_count: 0,
    management_score: null,
    data_confidence: 'verified',
    events: [{
      state: 'plan_covered',
      reason: 'PLANNED_CAST_IN_WINDOW',
      atMs: 80_000,
      coverageOutcome: 'covered',
      adherenceOutcome: 'followed',
      managementOutcome: 'success',
      requirementLevel: 'required',
    }],
    evaluated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

describe('night defensive management v2 summary', () => {
  it('falls back atomically when any evaluable pull is not backfilled', () => {
    expect(
      buildNightDefensiveManagementV2({
        pulls: [pull('pull-1'), pull('pull-2')],
        evaluations: [evaluation('pull-1')],
        spellNameById: new Map(),
        mechanicNameById: new Map(),
      }),
    ).toBeNull();
  });

  it('does not expose uncertain or mixed evaluator versions as v2', () => {
    const base = { pulls: [pull('pull-1')], spellNameById: new Map<number, string>(), mechanicNameById: new Map<number, string>() };
    expect(buildNightDefensiveManagementV2({ ...base, evaluations: [evaluation('pull-1', { data_confidence: 'uncertain' })] })).toBeNull();
    expect(buildNightDefensiveManagementV2({ ...base, evaluations: [evaluation('pull-1', { resolver_version: 'effective-defensives@2.0.0' })] })).toBeNull();
    expect(
      buildNightDefensiveManagementV2({
        ...base,
        pulls: [pull('pull-1'), pull('pull-2')],
        evaluations: [evaluation('pull-1'), evaluation('pull-2', { evaluator_version: 'evaluator@other' })],
      }),
    ).toBeNull();
  });

  it('aggregates only valid pulls and prioritizes explainable coaching decisions', () => {
    const result = buildNightDefensiveManagementV2({
      pulls: [pull('pull-1'), pull('pull-2'), pull('pull-3', true)],
      evaluations: [
        evaluation('pull-1', {
          correct_hold_count: 1,
          events: [
            {
              state: 'plan_covered',
              reason: 'PLANNED_CAST_IN_WINDOW',
              atMs: 80_000,
              coverageOutcome: 'covered',
              adherenceOutcome: 'followed',
              managementOutcome: 'success',
              requirementLevel: 'required',
            },
            {
              state: 'correct_hold',
              reason: 'RESERVED_HIGHER_PRIORITY',
              atMs: 90_000,
              coverageOutcome: 'uncovered',
              adherenceOutcome: 'held',
              managementOutcome: 'neutral',
              candidateSpellIds: [100],
            },
          ],
        }),
        evaluation('pull-2', {
          plan_executed_count: 0,
          broken_reservation_count: 1,
          death_viable_cd_count: 1,
          events: [
            { state: 'plan_broken', reason: 'EARLY_CAST_CAUSED_MISS', atMs: 120_000, coverageOutcome: 'uncovered', adherenceOutcome: 'broken', managementOutcome: 'failure', plannedSpellId: 100, abilityId: 500 },
            { state: 'death_with_viable_cd', reason: 'DEATH_COUNTERFACTUAL_FEASIBLE', atMs: 130_000, coverageOutcome: 'uncovered', adherenceOutcome: 'not_applicable', managementOutcome: 'failure', candidateSpellIds: [100] },
          ],
        }),
        evaluation('pull-3', { plan_required_count: 99, plan_executed_count: 0 }),
      ],
      spellNameById: new Map([[100, 'Fade']]),
      mechanicNameById: new Map([[500, 'Dark Harvest']]),
    });

    expect(result).not.toBeNull();
    expect(result).toEqual(expect.objectContaining({ evaluatedPullCount: 2, planRequiredCount: 2, planExecutedCount: 1, correctHoldCount: 1, brokenReservationCount: 1 }));
    expect(result!.decisions.map((decision) => decision.state)).toEqual(['death_with_viable_cd', 'plan_broken', 'correct_hold']);
    expect(result!.decisions[1]).toEqual(expect.objectContaining({ mechanicName: 'Dark Harvest', plannedSpellName: 'Fade' }));
    expect(result!.managementScore).toBeCloseTo((4 / 14) * 100, 2);
  });

  it('labels a night with plan and no-plan pulls as mixed', () => {
    const result = buildNightDefensiveManagementV2({
      pulls: [pull('pull-1'), pull('pull-2')],
      evaluations: [evaluation('pull-1'), evaluation('pull-2', { mode: 'no_plan', plan_version_id: null })],
      spellNameById: new Map(),
      mechanicNameById: new Map(),
    });
    expect(result?.mode).toBe('mixed');
  });

  it('rejects a mixed resolver generation', () => {
    const base = {
      pulls: [pull('pull-1'), pull('pull-2')],
      spellNameById: new Map<number, string>(),
      mechanicNameById: new Map<number, string>(),
    };
    expect(buildNightDefensiveManagementV2({
      ...base,
      evaluations: [evaluation('pull-1'), evaluation('pull-2', { resolver_version: 'resolver@other' })],
    })).toBeNull();
  });

  // §"es normal que una persona cambie de talentos según el boss al que se
  // enfrenta" (feedback real, 2026-09-03): un respec entre pulls cambia
  // build_fingerprint sin que evaluator/resolver/solver/build dejen de ser
  // los mismos — ya no debe tirar la noche entera a legacy.
  it('tolerates a build fingerprint mixture from a mid-night talent respec', () => {
    const base = {
      pulls: [pull('pull-1'), pull('pull-2')],
      spellNameById: new Map<number, string>(),
      mechanicNameById: new Map<number, string>(),
    };
    const result = buildNightDefensiveManagementV2({
      ...base,
      evaluations: [evaluation('pull-1'), evaluation('pull-2', { build_fingerprint: 'fp-other' })],
    });
    expect(result).not.toBeNull();
    expect(result!.evaluatedPullCount).toBe(2);
  });
});
