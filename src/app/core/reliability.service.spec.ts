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
    // null por defecto (no 0): así los tests existentes de abajo, que no
    // conocen este campo y manipulan had_avoidable_damage/
    // self_positioning_death directamente, siguen ejercitando el binario de
    // fallback tal cual — ver el describe dedicado más abajo para el
    // conteo graduado en sí.
    personal_mechanic_fail_count: null,
    // null por defecto: isFirstPullOfNight trata cualquier fila sin
    // report_code/pull_number como "primera" — los tests que no conocen
    // este campo (todos salvo el describe dedicado de abajo) siguen
    // promediando preparación sobre todas sus filas, comportamiento previo.
    report_code: null,
    pull_number: null,
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

// §"actualizar el binario de 'Mecánica' para que use este mismo conteo
// graduado en vez del sí/no actual, así Fiabilidad hereda la precisión sin
// duplicar nada" (feedback real, 2026-08-27): antes 1 fallo puntuaba igual
// que 5 (mecClean binario); ahora mismo conteo y misma penalización que
// pullScore (PULL_SCORE_FAIL_PENALTY = 0.25, ver pull-analysis.service.ts).
describe('computeReliabilityBreakdown mecánica graduada', () => {
  it('sin fallos puntúa 100 igual que el binario de antes', () => {
    const result = computeReliabilityBreakdown([row({ personal_mechanic_fail_count: 0 })], NOW);
    expect(result?.breakdown.mecanica).toBe(100);
  });

  it('cada fallo resta PULL_SCORE_FAIL_PENALTY, no todo o nada', () => {
    const oneFail = computeReliabilityBreakdown([row({ personal_mechanic_fail_count: 1 })], NOW);
    const twoFails = computeReliabilityBreakdown([row({ personal_mechanic_fail_count: 2 })], NOW);
    expect(oneFail?.breakdown.mecanica).toBe(75);
    expect(twoFails?.breakdown.mecanica).toBe(50);
    expect(twoFails?.breakdown.mecanica).toBeLessThan(oneFail?.breakdown.mecanica ?? 0);
  });

  it('no baja de 0 aunque el conteo sea alto', () => {
    const result = computeReliabilityBreakdown([row({ personal_mechanic_fail_count: 6 })], NOW);
    expect(result?.breakdown.mecanica).toBe(0);
  });

  it('sin la columna todavía (null), cae al binario had_avoidable_damage/self_positioning_death de siempre', () => {
    const clean = computeReliabilityBreakdown([row({ personal_mechanic_fail_count: null, had_avoidable_damage: false })], NOW);
    const dirty = computeReliabilityBreakdown([row({ personal_mechanic_fail_count: null, had_avoidable_damage: true })], NOW);
    expect(clean?.breakdown.mecanica).toBe(100);
    expect(dirty?.breakdown.mecanica).toBe(0);
  });
});

// §"el baremo de preparación deberia medir los primeros pulls no los
// ultimos, porque si en mitad de la raid te toca un objeto y te lo
// equipas, es normal que ese item no tenga enchant o gema hasta el dia
// siguiente" (feedback real, 2026-08-27).
describe('computeReliabilityBreakdown preparación — primer pull de la noche', () => {
  it('un loot sin encantar a mitad de noche no penaliza si el primer pull ya iba preparado', () => {
    const result = computeReliabilityBreakdown([
      row({ report_code: 'REPORT1', pull_number: 1, enchanted_slot_count: 7, enchantable_slot_count: 7, gemmed_slot_count: 3, gemmable_slot_count: 3 }),
      // Pull #5: se equipó una pieza nueva a mitad de noche, todavía sin encantar/engemar — no debe contar.
      row({ report_code: 'REPORT1', pull_number: 5, enchanted_slot_count: 6, enchantable_slot_count: 7, gemmed_slot_count: 2, gemmable_slot_count: 3 }),
    ], NOW);
    expect(result?.breakdown.preparacion).toBe(100);
  });

  it('sí penaliza si el PRIMER pull de la noche ya iba desencantado', () => {
    const result = computeReliabilityBreakdown([
      row({ report_code: 'REPORT1', pull_number: 1, enchanted_slot_count: 5, enchantable_slot_count: 7, gemmed_slot_count: 2, gemmable_slot_count: 3 }),
      row({ report_code: 'REPORT1', pull_number: 5, enchanted_slot_count: 7, enchantable_slot_count: 7, gemmed_slot_count: 3, gemmable_slot_count: 3 }),
    ], NOW);
    expect(result?.breakdown.preparacion).toBeLessThan(100);
  });

  it('cada noche (report_code) cuenta su propio primer pull, no solo el de la ventana entera', () => {
    const result = computeReliabilityBreakdown([
      row({ report_code: 'NIGHT1', pull_number: 1, enchanted_slot_count: 7, enchantable_slot_count: 7, gemmed_slot_count: 3, gemmable_slot_count: 3 }),
      row({ report_code: 'NIGHT1', pull_number: 2, enchanted_slot_count: 0, enchantable_slot_count: 7, gemmed_slot_count: 0, gemmable_slot_count: 3 }),
      row({ report_code: 'NIGHT2', pull_number: 1, enchanted_slot_count: 7, enchantable_slot_count: 7, gemmed_slot_count: 3, gemmable_slot_count: 3 }),
      row({ report_code: 'NIGHT2', pull_number: 2, enchanted_slot_count: 0, enchantable_slot_count: 7, gemmed_slot_count: 0, gemmable_slot_count: 3 }),
    ], NOW);
    expect(result?.breakdown.preparacion).toBe(100);
  });

  it('sin report_code/pull_number todavía (fallback), trata cualquier fila como la primera — comportamiento previo', () => {
    const result = computeReliabilityBreakdown([
      row({ enchanted_slot_count: 7, enchantable_slot_count: 7, gemmed_slot_count: 3, gemmable_slot_count: 3 }),
      row({ enchanted_slot_count: 0, enchantable_slot_count: 7, gemmed_slot_count: 0, gemmable_slot_count: 3 }),
    ], NOW);
    expect(result?.breakdown.preparacion).toBeLessThan(100);
    expect(result?.breakdown.preparacion).toBeGreaterThan(0);
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
