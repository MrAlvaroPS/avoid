import { describe, expect, it } from 'vitest';
import {
  validateDefensivePlanDraft,
  type CreateDraftRequest,
} from '../../../supabase/functions/_shared/defensive-plan-contract';

function validDraft(): CreateDraftRequest {
  return {
    action: 'create_draft',
    bossId: '3129',
    difficulty: 'Mythic',
    name: 'Plan 1',
    planMode: 'full',
    planningQuality: 'optimal',
    solverVersion: 'defensive-plan-solver@2.0.0',
    resolverVersion: 'effective-defensives@2.0.0',
    rosterSnapshotAt: '2026-09-01T00:00:00.000Z',
    members: [
      {
        playerKey: 'character:42',
        playerName: 'Alda',
        class: 'Priest',
        spec: 'Discipline',
        resolverVersion: 'effective-defensives@2.0.0',
        buildConfidence: 'verified',
        effectiveKit: [],
      },
    ],
    slots: [
      {
        abilityId: 123,
        occurrenceIndex: 1,
        occurrenceTimeMs: 30_000,
        windowStartMs: 28_000,
        windowEndMs: 32_000,
        priority: 5,
        requirementLevel: 'required',
        demandType: 'raid',
        coverageStatus: 'covered',
        assignedPlayerKey: 'character:42',
        defensiveSpellId: 62618,
        plannedCastAtMs: 28_000,
        source: 'automatic',
        confidence: 'verified',
        chargesSnapshot: 1,
      },
    ],
  };
}

describe('defensive plan draft contract', () => {
  it('accepts a self-contained roster and deployed slot snapshot', () => {
    expect(validateDefensivePlanDraft(validDraft())).toBeNull();
  });

  it('rejects assignments to a player outside the snapshotted roster', () => {
    const draft = validDraft();
    draft.slots[0].assignedPlayerKey = 'character:missing';
    expect(validateDefensivePlanDraft(draft)).toContain('no tiene jugador');
  });

  it('rejects duplicate occurrence slots', () => {
    const draft = validDraft();
    draft.slots.push({ ...draft.slots[0] });
    expect(validateDefensivePlanDraft(draft)).toContain('duplicada');
  });

  it('does not allow an uncovered slot to hide an assignment', () => {
    const draft = validDraft();
    draft.planMode = 'partial';
    draft.slots[0].coverageStatus = 'uncovered';
    expect(validateDefensivePlanDraft(draft)).toContain('no puede contener una asignación');
  });
});
