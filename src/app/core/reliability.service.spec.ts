import { computeReliabilityBreakdown, type ReliabilityInputRow } from './reliability.service';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function row(overrides: Partial<ReliabilityInputRow> = {}): ReliabilityInputRow {
  return {
    player_name: 'Raider',
    closed_at: new Date(NOW).toISOString(),
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
    ...overrides,
  };
}

describe('computeReliabilityBreakdown defensiva', () => {
  it('valora un defensivo usado durante el try aunque no haya muerte', () => {
    const result = computeReliabilityBreakdown([row({ used_defensive_in_pull: true, defensive_use_opportunity: true })], NOW);
    expect(result?.breakdown.defensiva).toBe(100);
  });

  it('no castiga un pull limpio sin una oportunidad defensiva observable', () => {
    const result = computeReliabilityBreakdown([row()], NOW);
    expect(result?.breakdown.defensiva).toBeNull();
  });

  it('pondera la respuesta al morir el doble que el uso general del try', () => {
    const result = computeReliabilityBreakdown([
      row({ used_defensive_when_died: false, used_defensive_in_pull: true, defensive_use_opportunity: true }),
    ], NOW);
    expect(result?.breakdown.defensiva).toBeCloseTo(100 / 3, 5);
  });

  it('penaliza no usar defensivo cuando hubo presión verificable', () => {
    const result = computeReliabilityBreakdown([row({ defensive_use_opportunity: true })], NOW);
    expect(result?.breakdown.defensiva).toBe(0);
  });
});

describe('computeReliabilityBreakdown preparación y consistencia', () => {
  it('puntúa conjuntamente enchants y slots de gema elegibles', () => {
    const result = computeReliabilityBreakdown([
      row({ enchanted_slot_count: 7, enchantable_slot_count: 7, gemmed_slot_count: 3, gemmable_slot_count: 3 }),
    ], NOW);
    expect(result?.breakdown.preparacion).toBe(100);
  });

  it('penaliza los altibajos frente a una ejecución estable con la misma muestra', () => {
    const stable = computeReliabilityBreakdown(Array.from({ length: 6 }, () => row()), NOW);
    const alternating = computeReliabilityBreakdown(Array.from({ length: 6 }, (_, index) => row({ had_avoidable_damage: index % 2 === 0 })), NOW);
    expect(stable?.consistency?.score).toBe(100);
    expect(alternating?.consistency?.score).toBeLessThan(alternating?.consistency?.averageExecution ?? 0);
  });

  it('no publica consistencia con menos de cinco pulls', () => {
    expect(computeReliabilityBreakdown(Array.from({ length: 4 }, () => row()), NOW)?.consistency).toBeNull();
  });
});
