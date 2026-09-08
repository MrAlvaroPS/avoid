import {
  computeReliabilityBreakdown,
  type ReliabilityInputRow,
} from './reliability.service';

const NOW = Date.parse('2026-09-07T10:00:00.000Z');
const CLOSED_AT = '2026-09-06T20:00:00.000Z';

function row(overrides: Partial<ReliabilityInputRow> = {}): ReliabilityInputRow {
  return {
    pull_id: 'pull-1',
    boss_id: 'boss-1',
    difficulty: 'Mythic',
    player_name: 'Raider',
    closed_at: CLOSED_AT,
    had_avoidable_damage: false,
    self_positioning_death: false,
    used_defensive_when_died: null,
    used_defensive_in_pull: false,
    defensive_use_opportunity: false,
    enchanted_slot_count: 0,
    enchantable_slot_count: 0,
    gem_count: 0,
    gemmed_slot_count: 0,
    gemmable_slot_count: 0,
    personal_mechanic_fail_count: 0,
    report_code: 'report-1',
    pull_number: 1,
    avoidable_mechanic_eligible_count: 0,
    avoidable_mechanic_fail_count: 0,
    defensive_window_coverable_count: null,
    defensive_window_covered_count: null,
    defensive_window_used_anything: null,
    unassigned_mechanic_success_count: 0,
    defensive_management_score_v2: null,
    defensive_management_decision_count: null,
    defensive_required_count: null,
    defensive_required_success_count: null,
    defensive_required_exact_adherence_count: null,
    defensive_broken_reservation_count: null,
    defensive_death_viable_cd_count: null,
    defensive_evaluation_confidence: null,
    defensive_evaluator_version: null,
    defensive_resolver_version: null,
    defensive_solver_version: null,
    defensive_game_build: null,
    defensive_build_fingerprint: null,
    defensive_evaluated_at: null,
    canonical_response_evaluable_count: null,
    canonical_response_success_count: null,
    canonical_response_failure_count: null,
    canonical_defensive_generation_id: null,
    canonical_defensive_evaluated_at: null,
    ...overrides,
  };
}

function canonical(
  evaluable: number,
  success: number,
  failure: number,
  generation = 'generation-a',
): Partial<ReliabilityInputRow> {
  return {
    canonical_response_evaluable_count: evaluable,
    canonical_response_success_count: success,
    canonical_response_failure_count: failure,
    canonical_defensive_generation_id: generation,
    canonical_defensive_evaluated_at: '2026-09-07T09:00:00.000Z',
  };
}

describe('Reliability canonical defensive Response', () => {
  it('uses covered/evaluable from the published canonical generation', () => {
    const result = computeReliabilityBreakdown(
      [row({ ...canonical(15, 8, 7) })],
      NOW,
    );

    expect(result?.breakdown.defensiva).toBeCloseTo((8 / 15) * 100, 8);
  });

  it('canonical Response overrides contradictory legacy defensive evidence', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          defensive_use_opportunity: true,
          used_defensive_in_pull: true,
          ...canonical(4, 1, 3),
        }),
      ],
      NOW,
    );

    expect(result?.breakdown.defensiva).toBe(25);
  });

  it('does not fabricate 0% when the canonical generation has zero evaluable episodes', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          defensive_use_opportunity: true,
          used_defensive_in_pull: false,
          ...canonical(0, 0, 0),
        }),
      ],
      NOW,
    );

    expect(result?.breakdown.defensiva).toBeNull();
  });

  it('never mixes legacy evidence from non-canonical rows into a valid canonical scope', () => {
    const result = computeReliabilityBreakdown(
      [
        row({ pull_id: 'pull-1', ...canonical(2, 1, 1) }),
        row({
          pull_id: 'pull-2',
          pull_number: 2,
          defensive_use_opportunity: true,
          used_defensive_in_pull: true,
        }),
      ],
      NOW,
    );

    expect(result?.breakdown.defensiva).toBe(50);
  });

  it('falls back atomically when canonical counters are internally inconsistent', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          defensive_use_opportunity: true,
          used_defensive_in_pull: true,
          ...canonical(3, 1, 1), // success + failure != evaluable
        }),
      ],
      NOW,
    );

    expect(result?.breakdown.defensiva).toBe(100);
  });

  it('falls back atomically instead of combining two canonical generations', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          pull_id: 'pull-1',
          defensive_use_opportunity: true,
          used_defensive_in_pull: true,
          ...canonical(2, 0, 2, 'generation-a'),
        }),
        row({
          pull_id: 'pull-2',
          pull_number: 2,
          defensive_use_opportunity: true,
          used_defensive_in_pull: true,
          ...canonical(2, 0, 2, 'generation-b'),
        }),
      ],
      NOW,
    );

    expect(result?.breakdown.defensiva).toBe(100);
  });

  it('canonical Response wins even when the experimental Management V2 flag is enabled', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          defensive_management_score_v2: 0,
          defensive_management_decision_count: 1,
          defensive_required_count: 1,
          defensive_required_success_count: 0,
          defensive_required_exact_adherence_count: 0,
          defensive_broken_reservation_count: 0,
          defensive_death_viable_cd_count: 0,
          defensive_evaluation_confidence: 'verified',
          defensive_evaluator_version: 'defensive-execution-evaluator@2.4.0',
          defensive_resolver_version: 'effective-defensives@2.1.0',
          defensive_solver_version: 'defensive-plan-solver@2.0.0',
          defensive_game_build: '12.1.0.68914',
          defensive_build_fingerprint: 'sha256:test',
          defensive_evaluated_at: '2026-09-07T09:00:00.000Z',
          ...canonical(4, 3, 1),
        }),
      ],
      NOW,
      { defensiveV2Enabled: true },
    );

    expect(result?.breakdown.defensiva).toBe(75);
  });
});
