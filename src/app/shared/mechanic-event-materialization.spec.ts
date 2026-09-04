import { describe, expect, it } from 'vitest';
import {
  buildMechanicEventRows,
  type MechanicHitTargets,
  type MechanicPlayerHitDetail,
} from '../../../supabase/functions/_shared/mechanic-event-materialization';

const mechanic = {
  name: 'Axegrinder',
  description: null,
  category: 'avoidable-ground',
  responsibility: 'personal',
  inferred_category: null,
  observed_as_interrupt: false,
  avoidable: true,
  severity_threshold: 0.35,
  reference_hit_ratio_samples: null,
};

function details(hitTargets: MechanicHitTargets): MechanicPlayerHitDetail[] {
  return [...hitTargets.entries()].map(([targetId, damage]) => ({
    name: `P${targetId}`,
    damage_taken: damage.total,
    damage_hits: damage.hits,
    healing_received: 0,
    used_defensive_spell_id: null,
    max_hit_points: damage.maxHitPoints,
  }));
}

describe('mechanic event materialization', () => {
  it('reproduce Dewerland: un único 52.010 no se materializa en todas las ventanas solapadas', () => {
    const casts = [
      67_588,
      68_386,
      68_576,
      68_982,
      69_253,
      70_003,
      70_454,
      71_099,
      71_241,
      71_241,
    ].map((timestamp) => ({ timestamp, abilityGameID: 1_285_017, sourceID: 9001 }));

    const rows = buildMechanicEventRows({
      mechanicByAbilityId: new Map([[1_285_017, mechanic]]),
      enemyCastEvents: casts,
      damageEvents: [
        {
          timestamp: 71_300,
          abilityGameID: 1_285_017,
          sourceID: 9001,
          targetID: 42,
          amount: 52_010,
        },
      ],
      deathEvents: [],
      interruptEvents: [],
      raidSize: 20,
      ownHistoryRatiosByAbilityId: new Map(),
      reactionWindowMs: 4_000,
      fightStartTime: 0,
      resolvePlayerName: (id) => `P${id}`,
      buildPlayerHitDetails: details,
      resolvePhaseId: () => null,
    });

    expect(rows).toHaveLength(9);
    expect(rows.flatMap((row) => row.player_hit_details)).toHaveLength(1);
    expect(
      rows.reduce(
        (sum, row) => sum + row.player_hit_details.reduce((n, hit) => n + hit.damage_taken, 0),
        0,
      ),
    ).toBe(52_010);
    expect(rows.find((row) => row.players_hit === 1)?.trigger_time_ms).toBe(71_241);
  });

  it('un DamageTaken huérfano entra por fallback aunque la ability también tenga casts', () => {
    const rows = buildMechanicEventRows({
      mechanicByAbilityId: new Map([[7, mechanic]]),
      enemyCastEvents: [{ timestamp: 10_000, abilityGameID: 7 }],
      damageEvents: [{ timestamp: 20_000, abilityGameID: 7, targetID: 1, amount: 123 }],
      deathEvents: [],
      interruptEvents: [],
      raidSize: 20,
      ownHistoryRatiosByAbilityId: new Map(),
      reactionWindowMs: 4_000,
      fightStartTime: 0,
      resolvePlayerName: (id) => `P${id}`,
      buildPlayerHitDetails: details,
      resolvePhaseId: () => null,
    });

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.trigger_time_ms === 10_000)?.players_hit).toBe(0);
    expect(rows.find((row) => row.trigger_time_ms === 20_000)?.player_hit_details[0].damage_taken).toBe(123);
  });

  it('un solo Interrupts crudo no limpia varios casts solapados', () => {
    const interruptMechanic = {
      ...mechanic,
      category: 'interrupt',
      inferred_category: null,
      observed_as_interrupt: true,
      avoidable: null,
    };
    const rows = buildMechanicEventRows({
      mechanicByAbilityId: new Map([[9, interruptMechanic]]),
      enemyCastEvents: [
        { timestamp: 10_000, abilityGameID: 9 },
        { timestamp: 11_000, abilityGameID: 9 },
        { timestamp: 12_000, abilityGameID: 9 },
      ],
      damageEvents: [],
      deathEvents: [],
      interruptEvents: [{ timestamp: 12_500, extraAbilityGameID: 9, sourceID: 55 }],
      raidSize: 20,
      ownHistoryRatiosByAbilityId: new Map(),
      reactionWindowMs: 4_000,
      fightStartTime: 0,
      resolvePlayerName: (id) => `P${id}`,
      buildPlayerHitDetails: details,
      resolvePhaseId: () => null,
    });

    expect(rows.map((row) => row.outcome)).toEqual(['fail', 'fail', 'clean']);
    expect(rows.filter((row) => row.players_hit === 1)).toHaveLength(1);
    expect(rows.at(-1)?.players_hit_names).toEqual(['P55']);
  });

  it('una muerte damage-only pertenece solo al cluster con el hit terminal más reciente', () => {
    const rows = buildMechanicEventRows({
      mechanicByAbilityId: new Map([[7, mechanic]]),
      enemyCastEvents: [],
      damageEvents: [
        { timestamp: 10_000, abilityGameID: 7, targetID: 1, amount: 100 },
        // >3s: cluster nuevo; ambos hits quedan todavía a <=4s de la muerte.
        { timestamp: 13_500, abilityGameID: 7, targetID: 1, amount: 200 },
      ],
      deathEvents: [{ timestamp: 14_000, targetID: 1, killingAbilityGameID: 7 }],
      interruptEvents: [],
      raidSize: 20,
      ownHistoryRatiosByAbilityId: new Map(),
      reactionWindowMs: 4_000,
      fightStartTime: 0,
      resolvePlayerName: (id) => `P${id}`,
      buildPlayerHitDetails: details,
      resolvePhaseId: () => null,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).not.toBe('fail');
    expect(rows[1].outcome).toBe('fail');
  });

  it('guarda trigger_time_ms relativo al inicio del fight y resuelve fase con timestamp absoluto', () => {
    let phaseTimestamp = 0;
    const rows = buildMechanicEventRows({
      mechanicByAbilityId: new Map([[7, mechanic]]),
      enemyCastEvents: [{ timestamp: 105_000, abilityGameID: 7 }],
      damageEvents: [],
      deathEvents: [],
      interruptEvents: [],
      raidSize: 20,
      ownHistoryRatiosByAbilityId: new Map(),
      reactionWindowMs: 4_000,
      fightStartTime: 100_000,
      resolvePlayerName: (id) => `P${id}`,
      buildPlayerHitDetails: details,
      resolvePhaseId: (timestamp) => {
        phaseTimestamp = timestamp;
        return 2;
      },
    });

    expect(rows[0].trigger_time_ms).toBe(5_000);
    expect(rows[0].phase_id).toBe(2);
    expect(phaseTimestamp).toBe(105_000);
  });
});
