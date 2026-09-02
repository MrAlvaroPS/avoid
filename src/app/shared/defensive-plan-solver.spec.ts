import { describe, expect, it } from 'vitest';
import type { ResolvedDefensive } from '../../../supabase/functions/_shared/effective-defensives';
import {
  isConservativeScheduleFeasible,
  solveDefensivePlan,
  type MechanicOccurrence,
  type SolverInput,
  type SolverPlayerKit,
} from '../../../supabase/functions/_shared/defensive-plan-solver';

function defensive(overrides: Partial<ResolvedDefensive> = {}): ResolvedDefensive {
  return {
    spellId: 100,
    name: 'Defensive',
    className: 'Priest',
    specName: 'Shadow',
    category: 'personal_defensive',
    survivalType: 'mitigation',
    targetingMode: 'self',
    activationMode: 'active',
    effectiveCooldownMs: 60_000,
    effectiveDurationMs: 5_000,
    charges: 1,
    rechargeMs: null,
    eligible: true,
    buildFingerprint: 'sha256:test',
    gameBuild: '12.1.0.68914',
    resolverVersion: 'effective-defensives@2.1.0',
    confidence: 'verified',
    provenance: [],
    conditionalModifiers: [],
    ...overrides,
  };
}

function occurrence(timeMs: number, occurrenceIndex: number, overrides: Partial<MechanicOccurrence> = {}): MechanicOccurrence {
  return {
    abilityId: 500,
    occurrenceIndex,
    timeMs,
    timeUncertaintyMs: 0,
    requirementLevel: 'required',
    priority: 5,
    raidImpactScore: 100,
    individualLethalityScore: 100,
    demandType: 'personal',
    ...overrides,
  };
}

function player(defensives: ResolvedDefensive[]): SolverPlayerKit {
  return {
    playerKey: 'player:a',
    playerName: 'A',
    className: 'Priest',
    specName: 'Shadow',
    role: 'dps',
    buildFingerprint: 'sha256:test',
    defensives,
  };
}

function input(overrides: Partial<SolverInput> = {}): SolverInput {
  return { mode: 'partial', occurrences: [], players: [player([defensive()])], ...overrides };
}

describe('defensive plan solver', () => {
  it('uses a 120s cooldown at 1:30 when a hard 4:00 reservation remains safe', () => {
    const result = solveDefensivePlan(
      input({
        occurrences: [occurrence(90_000, 1), occurrence(240_000, 2)],
        players: [player([defensive({ effectiveCooldownMs: 120_000 })])],
        reservations: [{ playerKey: 'player:a', spellId: 100, abilityId: 500, occurrenceIndex: 2, hard: true, source: 'manual' }],
      }),
    );
    expect(result.assignments.filter((slot) => slot.defensiveSpellId === 100)).toHaveLength(2);
  });

  it('does not use a 20s cooldown at 2:30 when it is hard-reserved at 2:42', () => {
    const result = solveDefensivePlan(
      input({
        occurrences: [occurrence(150_000, 1), occurrence(162_000, 2)],
        players: [player([defensive({ effectiveCooldownMs: 20_000 })])],
        reservations: [{ playerKey: 'player:a', spellId: 100, abilityId: 500, occurrenceIndex: 2, hard: true, source: 'manual' }],
      }),
    );
    expect(result.assignments.find((slot) => slot.occurrenceIndex === 1)?.coverageStatus).toBe('uncovered');
  });

  it('covers at most two windows at 1:00/1:30/2:00 with a 60s cooldown', () => {
    const result = solveDefensivePlan(input({ occurrences: [occurrence(60_000, 1), occurrence(90_000, 2), occurrence(120_000, 3)] }));
    expect(result.assignments.filter((slot) => slot.coverageStatus === 'covered')).toHaveLength(2);
    expect(result.assignments.map((slot) => slot.coverageStatus)).toEqual(['covered', 'uncovered', 'covered']);
  });

  it('models two consecutive charges and sequential recharge', () => {
    const twoCharges = defensive({ charges: 2, effectiveCooldownMs: 20_000, rechargeMs: 20_000 });
    expect(
      isConservativeScheduleFeasible(twoCharges, [
        { timeMs: 0, uncertaintyMs: 0, identity: 'a' },
        { timeMs: 1_000, uncertaintyMs: 0, identity: 'b' },
      ]),
    ).toBe(true);
    expect(
      isConservativeScheduleFeasible(twoCharges, [
        { timeMs: 0, uncertaintyMs: 0, identity: 'a' },
        { timeMs: 1_000, uncertaintyMs: 0, identity: 'b' },
        { timeMs: 19_000, uncertaintyMs: 0, identity: 'c' },
      ]),
    ).toBe(false);
  });

  it('never moves a locked reservation to cover a more valuable occurrence', () => {
    const result = solveDefensivePlan(
      input({
        occurrences: [
          occurrence(60_000, 1, { priority: 1, individualLethalityScore: 1 }),
          occurrence(90_000, 2, { priority: 5, individualLethalityScore: 1_000 }),
        ],
        reservations: [{ playerKey: 'player:a', spellId: 100, abilityId: 500, occurrenceIndex: 1, hard: true, locked: true, source: 'manual' }],
      }),
    );
    expect(result.assignments.find((slot) => slot.occurrenceIndex === 1)).toMatchObject({ locked: true, defensiveSpellId: 100 });
    expect(result.assignments.find((slot) => slot.occurrenceIndex === 2)?.coverageStatus).toBe('uncovered');
  });

  it('does not auto-assign an emergency defensive to an optional slot', () => {
    const result = solveDefensivePlan(
      input({
        occurrences: [occurrence(60_000, 1, { requirementLevel: 'optional' })],
        players: [player([defensive({ survivalType: 'emergency' })])],
      }),
    );
    expect(result.assignments[0].coverageStatus).toBe('uncovered');
  });

  it('can use an explicitly supplied raid external for raid demand', () => {
    const result = solveDefensivePlan(
      input({
        occurrences: [occurrence(60_000, 1, { demandType: 'raid' })],
        players: [player([defensive({ category: 'external_defensive', targetingMode: 'raid' })])],
      }),
    );
    expect(result.assignments[0]).toMatchObject({ coverageStatus: 'covered', defensiveSpellId: 100 });
  });

  it('never assigns a passive defensive even if it reaches the solver input', () => {
    const result = solveDefensivePlan(
      input({
        occurrences: [occurrence(60_000, 1)],
        players: [player([defensive({ activationMode: 'passive', eligible: false })])],
      }),
    );
    expect(result.assignments[0].coverageStatus).toBe('uncovered');
  });

  it('uses conservative timing uncertainty around recharge', () => {
    expect(
      isConservativeScheduleFeasible(defensive({ effectiveCooldownMs: 120_000 }), [
        { timeMs: 90_000, uncertaintyMs: 5_000, identity: 'a' },
        { timeMs: 210_000, uncertaintyMs: 5_000, identity: 'b' },
      ]),
    ).toBe(false);
  });

  it('produces deterministic tie-breaks regardless of player input order', () => {
    const playerA = player([defensive({ spellId: 101 })]);
    const playerB = { ...player([defensive({ spellId: 101 })]), playerKey: 'player:b', playerName: 'B' };
    const first = solveDefensivePlan(input({ occurrences: [occurrence(60_000, 1)], players: [playerB, playerA] }));
    const second = solveDefensivePlan(input({ occurrences: [occurrence(60_000, 1)], players: [playerA, playerB] }));
    expect(first.assignments).toEqual(second.assignments);
    expect(first.assignments[0].assignedPlayerKey).toBe('player:a');
  });

  it('marks deterministic greedy fallback as ineligible for strict scoring', () => {
    const result = solveDefensivePlan(input({ occurrences: [occurrence(60_000, 1)], maxSearchNodes: 1 }));
    expect(result.planningQuality).toBe('fallback_greedy');
    expect(result.strictScoringEligible).toBe(false);
    expect(result.assignments[0].source).toBe('fallback');
  });

  it('skips an exponential DFS and falls back before consuming its node budget', () => {
    const players = Array.from({ length: 20 }, (_, index) => ({
      ...player([defensive({ spellId: 1_000 + index })]),
      playerKey: `player:${index.toString().padStart(2, '0')}`,
      playerName: `Player ${index}`,
    }));
    const occurrences = Array.from({ length: 20 }, (_, index) => occurrence((index + 1) * 70_000, index + 1));

    const result = solveDefensivePlan(input({ occurrences, players, maxSearchNodes: 50_000_000 }));

    expect(result.planningQuality).toBe('fallback_greedy');
    expect(result.diagnostics).toMatchObject({
      searchNodes: 0,
      searchBudget: 5_000,
      fallbackReason: 'search_space_exceeds_budget',
    });
    expect(result.assignments).toHaveLength(20);
  });
});
