import { isDeathExcludedFromStatistics, isMechanicExcludedByWipeCall, wipeCallStartMs } from './death-statistics.util';

describe('death-statistics', () => {
  it('conserva mecánicas anteriores al wipecall y excluye las posteriores', () => {
    const pull = { wipe_call_excluded: true, wipe_call_signals: { wipeCallStartMs: 10_000 } };
    expect(isMechanicExcludedByWipeCall(pull as never, { trigger_time_ms: 9_999 } as never)).toBe(false);
    expect(isMechanicExcludedByWipeCall(pull as never, { trigger_time_ms: 10_000 } as never)).toBe(true);
  });

  it('no aplica un límite si el wipecall está desactivado', () => {
    const pull = { wipe_call_excluded: false, wipe_call_signals: { wipeCallStartMs: 10_000 } };
    expect(wipeCallStartMs(pull as never)).toBeNull();
  });

  it('excluye siempre el Melee del boss sobre un no-tank', () => {
    const record = {
      wipe_call_cluster: false,
      death_cause: { statisticalExclusionReason: 'boss_melee_on_non_tank' },
    };
    expect(isDeathExcludedFromStatistics({ wipe_call_excluded: false } as never, record as never)).toBe(true);
  });
});
