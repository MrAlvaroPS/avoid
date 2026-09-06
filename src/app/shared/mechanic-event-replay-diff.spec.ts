import { describe, expect, it } from 'vitest';
import { summarizeMechanicEventReplay } from '../../../supabase/functions/_shared/mechanic-event-replay-diff';

describe('mechanic event replay diff', () => {
  it('surfaces the Dewerland 52,010 over-materialization clearly', () => {
    const before = [
      { ability_id: 1_285_017, mechanic_name: 'Axegrinder', trigger_time_ms: 67_588, player_hit_details: [{ name: 'Dewerland', damage_taken: 52_010, damage_hits: 1 }] },
      { ability_id: 1_285_017, mechanic_name: 'Axegrinder', trigger_time_ms: 68_386, player_hit_details: [{ name: 'Dewerland', damage_taken: 52_010, damage_hits: 1 }] },
      { ability_id: 1_285_017, mechanic_name: 'Axegrinder', trigger_time_ms: 71_241, player_hit_details: [{ name: 'Dewerland', damage_taken: 52_010, damage_hits: 1 }] },
      { ability_id: 1_285_017, mechanic_name: 'Axegrinder', trigger_time_ms: 71_241, player_hit_details: [{ name: 'Dewerland', damage_taken: 52_010, damage_hits: 1 }] },
    ];
    const after = [
      { ability_id: 1_285_017, mechanic_name: 'Axegrinder', trigger_time_ms: 67_588, player_hit_details: [] },
      { ability_id: 1_285_017, mechanic_name: 'Axegrinder', trigger_time_ms: 68_386, player_hit_details: [] },
      { ability_id: 1_285_017, mechanic_name: 'Axegrinder', trigger_time_ms: 71_241, player_hit_details: [{ name: 'Dewerland', damage_taken: 52_010, damage_hits: 1 }] },
    ];

    const summary = summarizeMechanicEventReplay(before, after);

    expect(summary.beforeRowCount).toBe(4);
    expect(summary.afterRowCount).toBe(3);
    expect(summary.beforeMaterializedDamage).toBe(208_040);
    expect(summary.afterMaterializedDamage).toBe(52_010);
    expect(summary.duplicateOccurrenceKeysBefore).toEqual([
      { abilityId: 1_285_017, mechanicName: 'Axegrinder', triggerTimeMs: 71_241, count: 2 },
    ]);
    expect(summary.duplicateOccurrenceKeysAfter).toEqual([]);
    expect(summary.playerDamageDeltas).toEqual([
      {
        abilityId: 1_285_017,
        mechanicName: 'Axegrinder',
        playerName: 'Dewerland',
        beforeDamage: 208_040,
        afterDamage: 52_010,
        beforeDamageHits: 4,
        afterDamageHits: 1,
        beforeOccurrencesWithClaim: 4,
        afterOccurrencesWithClaim: 1,
      },
    ]);
  });
});
