import { decodeMrtExport } from './mrt-reminder-codec';
import { exportDeployedPlanToMrt, type DeployedMrtSlot } from './deployed-plan-mrt';

function slot(overrides: Partial<DeployedMrtSlot> = {}): DeployedMrtSlot {
  return {
    id: 'slot-1',
    abilityId: 500,
    occurrenceIndex: 2,
    occurrenceTimeMs: 90_000,
    coverageStatus: 'covered',
    assignedPlayerKey: 'player:a',
    defensiveSpellId: 100,
    prewarnMs: 5_000,
    triggerMode: 'bossmod',
    bossmodSpellId: 500,
    bossmodCounter: '2',
    bossmodCounterVerified: true,
    assignedGroups: null,
    ...overrides,
  };
}

describe('MRT from deployed defensive plan', () => {
  const plan = { id: 'plan-v1', name: 'Plan publicado', bossId: 3012, difficultyId: 16 };
  const members = [{ playerKey: 'player:a', playerName: 'Alda' }];
  const mechanics = new Map([[500, 'Explosión']]);
  const defensives = new Map([[100, 'Fade']]);

  it('targets the exact deployed player and derives UID from plan version plus slot', () => {
    const first = exportDeployedPlanToMrt(plan, members, [slot()], mechanics, defensives);
    const second = exportDeployedPlanToMrt({ ...plan, id: 'plan-v2' }, members, [slot()], mechanics, defensives);
    const decoded = decodeMrtExport(first.text).reminders[0];

    expect(decoded.players).toEqual(['Alda']);
    expect(decoded.uid).toContain('plan_v1_slot_1');
    expect(decodeMrtExport(second.text).reminders[0].uid).not.toBe(decoded.uid);
  });

  it('emits an occurrence bossmod trigger only with verified counter', () => {
    const exported = exportDeployedPlanToMrt(plan, members, [slot()], mechanics, defensives);
    expect(decodeMrtExport(exported.text).reminders[0].triggers).toEqual([
      { type: 'bossmod', timeLeftSeconds: 5, spellId: 500, pattern: undefined, counter: '2' },
    ]);
    expect(exported.timeFallbackSlotIds).toEqual([]);
  });

  it('preserves the deployed informational raid groups in the reminder text', () => {
    const exported = exportDeployedPlanToMrt(plan, members, [slot({ assignedGroups: [2, 5] })], mechanics, defensives);
    expect(decodeMrtExport(exported.text).reminders[0].message).toContain('[Grupos 2,5]');
  });

  it('degrades an unverified bossmod counter to the occurrence time', () => {
    const exported = exportDeployedPlanToMrt(plan, members, [slot({ bossmodCounterVerified: false })], mechanics, defensives);
    expect(decodeMrtExport(exported.text).reminders[0].triggers).toEqual([{ type: 'pull', delayTimeSeconds: 90 }]);
    expect(exported.timeFallbackSlotIds).toEqual(['slot-1']);
  });

  it('never exports uncovered slots', () => {
    expect(() => exportDeployedPlanToMrt(plan, members, [slot({ coverageStatus: 'uncovered' })], mechanics, defensives)).toThrow(
      'no contiene slots',
    );
  });
});
