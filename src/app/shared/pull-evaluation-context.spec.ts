import { describe, expect, it } from 'vitest';
import { applyPullEvaluationAction, initialPullEvaluationContext } from '../../../supabase/functions/_shared/pull-evaluation-context';
import { isEventEvaluable } from '../../../supabase/functions/_shared/combat-evaluation-contract';

const facts = {
  pullId: 'pull-b',
  durationMs: 90_000,
  inferredWipeCandidate: { boundaryMs: 30_000, confidence: 73, evidence: { sensor: true } },
  ninjaCandidate: null,
};

describe('pull evaluation context commands', () => {
  it('creates and moves a manual wipe without requiring a heuristic', () => {
    const withoutCandidate = { ...facts, inferredWipeCandidate: null };
    const created = applyPullEvaluationAction(null, withoutCandidate, { action: 'confirm_wipe', boundaryMs: 12_000 });
    const moved = applyPullEvaluationAction(created, withoutCandidate, { action: 'move_wipe_boundary', boundaryMs: 18_000 });
    expect(created.wipeCallSource).toBe('manual_rl');
    expect(moved.evaluationEndMs).toBe(18_000);
    expect(isEventEvaluable(moved, 17_999)).toBe(true);
    expect(isEventEvaluable(moved, 18_000)).toBe(false);
  });

  it('keeps a wipe detector result as a non-authoritative candidate until accepted', () => {
    const candidate = initialPullEvaluationContext(facts);
    expect(candidate.evaluationEndMs).toBe(90_000);
    expect(candidate.wipeCallAtMs).toBeNull();
    const accepted = applyPullEvaluationAction(candidate, facts, { action: 'accept_inferred_wipe' });
    expect(accepted.evaluationEndMs).toBe(30_000);
    expect(accepted.wipeCallVerified).toBe(true);
  });

  it('auto-confirms a strict ninja candidate and removes it from statistical evaluation', () => {
    const ninjaFacts = {
      ...facts,
      inferredWipeCandidate: null,
      durationMs: 20_409,
      ninjaCandidate: {
        confidence: 53,
        evidence: {
          durationMs: 20_409,
          raidSize: 17,
          engagedPlayerCount: 12,
          engagedFraction: 0.71,
          bossHealthPct: 91.05,
          barelyDamagedBoss: true,
        },
      },
    };
    const context = initialPullEvaluationContext(ninjaFacts);
    expect(context.evaluationEligible).toBe(false);
    expect(context.cutoffReason).toBe('invalid_pull');
    expect(context.ninjaStatus).toBe('confirmed');
    expect(context.ninjaSource).toBe('heuristic');
    expect(context.ninjaConfidence).toBe(53);
    expect(isEventEvaluable(context, 1)).toBe(false);
  });

  it('allows a raid leader to restore an auto-confirmed ninja and makes the decision manual', () => {
    const ninjaFacts = {
      ...facts,
      inferredWipeCandidate: null,
      ninjaCandidate: { confidence: 80, evidence: { durationMs: 23_087, bossHealthPct: 99.99 } },
    };
    const auto = initialPullEvaluationContext(ninjaFacts);
    const valid = applyPullEvaluationAction(auto, ninjaFacts, { action: 'mark_valid' });
    expect(valid.evaluationEligible).toBe(true);
    expect(valid.cutoffReason).toBe('fight_end');
    expect(valid.ninjaStatus).toBe('valid');
    expect(valid.ninjaSource).toBe('manual');
    expect(valid.ninjaConfidence).toBe(100);
  });

  it('can deliberately downgrade an auto-confirmed ninja to probable for review', () => {
    const ninjaFacts = {
      ...facts,
      inferredWipeCandidate: null,
      ninjaCandidate: { confidence: 80, evidence: { durationMs: 23_472, bossHealthPct: 99.99 } },
    };
    const auto = initialPullEvaluationContext(ninjaFacts);
    const probable = applyPullEvaluationAction(auto, ninjaFacts, { action: 'mark_probable_ninja' });
    expect(probable.evaluationEligible).toBe(true);
    expect(probable.ninjaStatus).toBe('probable');
    expect(probable.ninjaSource).toBe('manual');
  });

  it('can deny a wipe candidate and restores the complete evaluable interval', () => {
    const accepted = applyPullEvaluationAction(null, facts, { action: 'accept_inferred_wipe' });
    const denied = applyPullEvaluationAction(accepted, facts, { action: 'clear_wipe' });
    expect(denied.cutoffReason).toBe('fight_end');
    expect(denied.evaluationEndMs).toBe(90_000);
    expect(denied.evidence['wipeCallCandidate']).toBeTruthy();
  });

  it('allows manual ninja confirmation without heuristic signals and restores it both ways', () => {
    const confirmed = applyPullEvaluationAction(null, facts, { action: 'confirm_ninja' });
    expect(confirmed.evaluationEligible).toBe(false);
    expect(confirmed.ninjaStatus).toBe('confirmed');
    const valid = applyPullEvaluationAction(confirmed, facts, { action: 'mark_valid' });
    expect(valid.evaluationEligible).toBe(true);
    expect(valid.ninjaStatus).toBe('valid');
  });

  it('rejects boundaries outside the pull', () => {
    expect(() => applyPullEvaluationAction(null, facts, { action: 'confirm_wipe', boundaryMs: 90_001 })).toThrow(/entre 0 y 90000/);
  });

  it('applies a full audited override without discarding the selected interval', () => {
    const overridden = applyPullEvaluationAction(null, facts, {
      action: 'override_context',
      evaluationEligible: true,
      evaluationStartMs: 5_000,
      evaluationEndMs: 42_000,
      wipeCallAtMs: 42_000,
      wipeCallVerified: true,
      ninjaConfirmed: false,
    });
    expect(overridden.evaluationStartMs).toBe(5_000);
    expect(overridden.evaluationEndMs).toBe(42_000);
    expect(overridden.wipeCallAtMs).toBe(42_000);
    expect(overridden.wipeCallVerified).toBe(true);
    expect(overridden.ninjaStatus).toBe('valid');
  });

  it('rejects a full override with a wipe outside its interval', () => {
    expect(() => applyPullEvaluationAction(null, facts, {
      action: 'override_context',
      evaluationEligible: true,
      evaluationStartMs: 10_000,
      evaluationEndMs: 40_000,
      wipeCallAtMs: 5_000,
      wipeCallVerified: true,
      ninjaConfirmed: false,
    })).toThrow(/dentro del intervalo/);
  });

  it('covers the three wipe-call gold intervals', () => {
    const afterThreeDeaths = applyPullEvaluationAction(null, facts, { action: 'confirm_wipe', boundaryMs: 20_000 });
    expect([5_000, 10_000, 19_999].every((time) => isEventEvaluable(afterThreeDeaths, time))).toBe(true);
    expect([20_000, 25_000, 89_000].some((time) => isEventEvaluable(afterThreeDeaths, time))).toBe(false);

    const recoveryThenCall = applyPullEvaluationAction(null, facts, { action: 'confirm_wipe', boundaryMs: 70_000 });
    expect(isEventEvaluable(recoveryThenCall, 45_000)).toBe(true);

    const beforeFirstDeath = applyPullEvaluationAction(null, facts, { action: 'confirm_wipe', boundaryMs: 0 });
    expect(isEventEvaluable(beforeFirstDeath, 1)).toBe(false);
  });
});
