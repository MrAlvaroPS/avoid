import {
  compareExecutionLedgerShadow,
  computeReliabilityBreakdown,
  type ReliabilityInputRow,
} from './reliability.service';
import type { ExecutionLedgerPullSummary } from './execution-ledger.service';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function row(overrides: Partial<ReliabilityInputRow> = {}): ReliabilityInputRow {
  return {
    pull_id: 'pull-1',
    boss_id: 'boss-1',
    difficulty: 'Mythic',
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
    // null por defecto (mismo criterio que personal_mechanic_fail_count):
    // mechanicScoreFor cae al conteo plano de siempre — ver el describe
    // dedicado al ratio avoidable-ground/spread más abajo.
    avoidable_mechanic_eligible_count: null,
    avoidable_mechanic_fail_count: null,
    // null por defecto (mismo criterio): sin esto, computeReliabilityBreakdown
    // cae al booleano defensive_use_opportunity/used_defensive_in_pull de
    // siempre — así los 4 tests del describe 'defensiva' de abajo, que no
    // conocen ventanas, siguen ejercitando exactamente el mismo camino que
    // antes. Ver el describe dedicado más abajo para las ventanas en sí.
    defensive_window_coverable_count: null,
    defensive_window_covered_count: null,
    defensive_window_used_anything: null,
    // null por defecto (mismo criterio): mechanicScoreFor no suma ningún
    // bonus de mecánica sin asignar salvo que un test lo pida explícitamente.
    unassigned_mechanic_success_count: null,
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
    ...overrides,
  };
}

describe('computeReliabilityBreakdown defensiva v2 y shadow', () => {
  const v2 = (score: number): Partial<ReliabilityInputRow> => ({
    defensive_management_score_v2: score,
    defensive_management_decision_count: 2,
    defensive_required_count: 1,
    defensive_required_success_count: score > 0 ? 1 : 0,
    defensive_required_exact_adherence_count: score > 0 ? 1 : 0,
    defensive_broken_reservation_count: 0,
    defensive_death_viable_cd_count: 0,
    defensive_evaluation_confidence: 'verified',
    defensive_evaluator_version: 'defensive-execution-evaluator@2.3.0',
    defensive_resolver_version: 'effective-defensives@2.1.0',
    defensive_solver_version: 'defensive-plan-solver@2.0.0',
    defensive_game_build: '12.0.0.1',
    defensive_build_fingerprint: 'sha256:build-a',
    defensive_evaluated_at: new Date(NOW).toISOString(),
  });

  it('mantiene v1 como score visible con el feature flag apagado y calcula shadow', () => {
    const result = computeReliabilityBreakdown(
      [row({ defensive_use_opportunity: true, used_defensive_in_pull: true, ...v2(25) })],
      NOW,
    );
    expect(result?.breakdown.defensiva).toBe(100);
    expect(result?.defensiveShadowComparison).toEqual({
      legacyScore: 100,
      v2Score: 25,
      delta: -75,
      comparablePullCount: 1,
      evaluatorVersions: ['defensive-execution-evaluator@2.3.0'],
    });
  });

  it('usa exclusivamente v2 para una fila fiable cuando el flag está encendido', () => {
    const result = computeReliabilityBreakdown(
      [row({ defensive_use_opportunity: true, used_defensive_in_pull: true, ...v2(25) })],
      NOW,
      { defensiveV2Enabled: true },
    );
    expect(result?.breakdown.defensiva).toBe(25);
  });

  it('hace fallback atómico a v1 si v2 no está completo o no es fiable', () => {
    const incomplete = computeReliabilityBreakdown(
      [row({ defensive_use_opportunity: true, used_defensive_in_pull: true, ...v2(10), defensive_required_count: null })],
      NOW,
      { defensiveV2Enabled: true },
    );
    const uncertain = computeReliabilityBreakdown(
      [row({ defensive_use_opportunity: true, used_defensive_in_pull: false, ...v2(100), defensive_evaluation_confidence: 'uncertain' })],
      NOW,
      { defensiveV2Enabled: true },
    );
    const staleResolver = computeReliabilityBreakdown(
      [row({ defensive_use_opportunity: true, used_defensive_in_pull: false, ...v2(100), defensive_resolver_version: 'effective-defensives@2.0.0' })],
      NOW,
      { defensiveV2Enabled: true },
    );
    expect(incomplete?.breakdown.defensiva).toBe(100);
    expect(uncertain?.breakdown.defensiva).toBe(0);
    expect(staleResolver?.breakdown.defensiva).toBe(0);
  });

  it('no mezcla v2 y legacy cuando el backfill de una noche es parcial', () => {
    const result = computeReliabilityBreakdown(
      [
        row({ pull_id: 'pull-1', defensive_use_opportunity: true, used_defensive_in_pull: true, ...v2(20) }),
        row({ pull_id: 'pull-2', defensive_use_opportunity: true, used_defensive_in_pull: true }),
      ],
      NOW,
      { defensiveV2Enabled: true },
    );
    expect(result?.breakdown.defensiva).toBe(100);
  });

  it('bloquea v2 visible si la generacion mezcla builds', () => {
    const result = computeReliabilityBreakdown(
      [
        row({ pull_id: 'pull-1', defensive_use_opportunity: true, used_defensive_in_pull: true, ...v2(20) }),
        row({
          pull_id: 'pull-2',
          defensive_use_opportunity: true,
          used_defensive_in_pull: true,
          ...v2(80),
          defensive_build_fingerprint: 'sha256:build-b',
        }),
      ],
      NOW,
      { defensiveV2Enabled: true },
    );
    expect(result?.breakdown.defensiva).toBe(100);
  });
});

describe('compareExecutionLedgerShadow', () => {
  it('compara solo pulls materializados con versiones homogéneas', () => {
    const summaries: ExecutionLedgerPullSummary[] = [
      {
        pull_id: 'pull-1',
        player_name: 'Raider',
        ledger_evaluator_version: 'execution-ledger@1.0.0',
        event_count: 3,
        credit_count: 0,
        penalty_count: 2,
        primary_penalty_count: 1,
        mechanic_failure_count: 2,
        defensive_failure_count: 0,
        consumable_failure_count: 0,
        versions_homogeneous: true,
        evaluated_at: '2026-08-26T12:00:00.000Z',
      },
      {
        pull_id: 'pull-2',
        player_name: 'Raider',
        ledger_evaluator_version: 'execution-ledger@1.0.0',
        event_count: 1,
        credit_count: 0,
        penalty_count: 1,
        primary_penalty_count: 1,
        mechanic_failure_count: 9,
        defensive_failure_count: 9,
        consumable_failure_count: 9,
        versions_homogeneous: false,
        evaluated_at: '2026-08-26T12:00:00.000Z',
      },
    ];

    expect(
      compareExecutionLedgerShadow(
        [
          row({ personal_mechanic_fail_count: 1 }),
          row({ pull_id: 'pull-2', personal_mechanic_fail_count: 7 }),
        ],
        summaries,
      ),
    ).toEqual({
      legacyMechanicFailureCount: 1,
      ledgerMechanicFailureCount: 2,
      ledgerDefensiveFailureCount: 0,
      ledgerConsumableFailureCount: 0,
      primaryPenaltyCount: 1,
      mechanicFailureDelta: 1,
      comparablePullCount: 1,
      evaluatorVersions: ['execution-ledger@1.0.0'],
      versionsCompatible: true,
    });
  });
});

describe('computeReliabilityBreakdown defensiva', () => {
  it('valora un defensivo usado durante el try aunque no haya muerte', () => {
    const result = computeReliabilityBreakdown(
      [row({ used_defensive_in_pull: true, defensive_use_opportunity: true })],
      NOW,
    );
    expect(result?.breakdown.defensiva).toBe(100);
  });

  it('no castiga un pull limpio sin una oportunidad defensiva observable', () => {
    const result = computeReliabilityBreakdown([row()], NOW);
    expect(result?.breakdown.defensiva).toBeNull();
  });

  it('pondera la respuesta al morir el doble que el uso general del try', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          used_defensive_when_died: false,
          used_defensive_in_pull: true,
          defensive_use_opportunity: true,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.defensiva).toBeCloseTo(100 / 3, 5);
  });

  it('penaliza no usar defensivo cuando hubo presión verificable', () => {
    const result = computeReliabilityBreakdown([row({ defensive_use_opportunity: true })], NOW);
    expect(result?.breakdown.defensiva).toBe(0);
  });
});

// §"no es lo mismo usar 0 defensivos que usarlo a destiempo, lo primero debe
// penalizar mucho y lo segundo debe penalizar un poco" (feedback real,
// 2026-08-29): conteo real de ventanas (defensive_window_*), no el
// booleano — validado contra 5 perfiles de clase reales antes de escribir
// esto (ver conversación real). Con datos de ventana presentes, tienen
// PRIORIDAD sobre el booleano antiguo (fallback solo si coverable_count es null).
describe('computeReliabilityBreakdown defensiva — ventanas de presión', () => {
  it('puntúa el ratio real cubiertas/cubribles, no solo sí/no', () => {
    const result = computeReliabilityBreakdown(
      [row({ defensive_window_covered_count: 2, defensive_window_coverable_count: 3 })],
      NOW,
    );
    expect(result?.breakdown.defensiva).toBeCloseTo((2 / 5) * 100, 5);
  });

  it('nunca tocó nada en todo el pull: penalización completa (0)', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          defensive_window_covered_count: 0,
          defensive_window_coverable_count: 3,
          defensive_window_used_anything: false,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.defensiva).toBe(0);
  });

  it('lo usó a destiempo (algo, pero desincronizado): penalización ligera, no completa', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          defensive_window_covered_count: 0,
          defensive_window_coverable_count: 3,
          defensive_window_used_anything: true,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.defensiva).toBeGreaterThan(0);
    expect(result?.breakdown.defensiva).toBeLessThan(50);
  });

  it('sin ventanas todavía (coverable_count null), cae al booleano de siempre', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          defensive_window_coverable_count: null,
          defensive_use_opportunity: true,
          used_defensive_in_pull: true,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.defensiva).toBe(100);
  });

  // §bug real encontrado en auditoría (2026-08-29): un pull con la columna
  // de ventanas YA presente (schema 'window') pero sin ninguna ventana real
  // esa vez (0 cubribles + 0 cubiertas) caía al `else if` del booleano
  // legacy en vez de no aportar nada — dos fuentes de verdad pudiendo
  // contradecirse para la misma fila (el booleano puede seguir siendo
  // `true` por una vía que las ventanas no capturan). 0 coverable_count con
  // la columna presente es "sin presión real", no "sin dato".
  it('con columna de ventanas presente pero 0 ventanas reales, no cae al booleano legacy', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          defensive_window_coverable_count: 0,
          defensive_window_covered_count: 0,
          defensive_window_used_anything: false,
          // booleano legacy en `true` a propósito — si el bug reaparece, este test lo detecta.
          defensive_use_opportunity: true,
          used_defensive_in_pull: false,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.defensiva).toBeNull();
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
    const clean = computeReliabilityBreakdown(
      [row({ personal_mechanic_fail_count: null, had_avoidable_damage: false })],
      NOW,
    );
    const dirty = computeReliabilityBreakdown(
      [row({ personal_mechanic_fail_count: null, had_avoidable_damage: true })],
      NOW,
    );
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
    const result = computeReliabilityBreakdown(
      [
        row({
          report_code: 'REPORT1',
          pull_number: 1,
          enchanted_slot_count: 7,
          enchantable_slot_count: 7,
          gemmed_slot_count: 3,
          gemmable_slot_count: 3,
        }),
        // Pull #5: se equipó una pieza nueva a mitad de noche, todavía sin encantar/engemar — no debe contar.
        row({
          report_code: 'REPORT1',
          pull_number: 5,
          enchanted_slot_count: 6,
          enchantable_slot_count: 7,
          gemmed_slot_count: 2,
          gemmable_slot_count: 3,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.preparacion).toBe(100);
  });

  it('sí penaliza si el PRIMER pull de la noche ya iba desencantado', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          report_code: 'REPORT1',
          pull_number: 1,
          enchanted_slot_count: 5,
          enchantable_slot_count: 7,
          gemmed_slot_count: 2,
          gemmable_slot_count: 3,
        }),
        row({
          report_code: 'REPORT1',
          pull_number: 5,
          enchanted_slot_count: 7,
          enchantable_slot_count: 7,
          gemmed_slot_count: 3,
          gemmable_slot_count: 3,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.preparacion).toBeLessThan(100);
  });

  it('cada noche (report_code) cuenta su propio primer pull, no solo el de la ventana entera', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          report_code: 'NIGHT1',
          pull_number: 1,
          enchanted_slot_count: 7,
          enchantable_slot_count: 7,
          gemmed_slot_count: 3,
          gemmable_slot_count: 3,
        }),
        row({
          report_code: 'NIGHT1',
          pull_number: 2,
          enchanted_slot_count: 0,
          enchantable_slot_count: 7,
          gemmed_slot_count: 0,
          gemmable_slot_count: 3,
        }),
        row({
          report_code: 'NIGHT2',
          pull_number: 1,
          enchanted_slot_count: 7,
          enchantable_slot_count: 7,
          gemmed_slot_count: 3,
          gemmable_slot_count: 3,
        }),
        row({
          report_code: 'NIGHT2',
          pull_number: 2,
          enchanted_slot_count: 0,
          enchantable_slot_count: 7,
          gemmed_slot_count: 0,
          gemmable_slot_count: 3,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.preparacion).toBe(100);
  });

  it('sin report_code/pull_number todavía (fallback), trata cualquier fila como la primera — comportamiento previo', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          enchanted_slot_count: 7,
          enchantable_slot_count: 7,
          gemmed_slot_count: 3,
          gemmable_slot_count: 3,
        }),
        row({
          enchanted_slot_count: 0,
          enchantable_slot_count: 7,
          gemmed_slot_count: 0,
          gemmable_slot_count: 3,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.preparacion).toBeLessThan(100);
    expect(result?.breakdown.preparacion).toBeGreaterThan(0);
  });
});

// §"venir sin la preparación penaliza si no se hace, pero se da por
// supuesto que si lo tienes que hacer así que no cuenta para sumar"
// (feedback real, 2026-08-30): preparación=100 informa (breakdown) pero no
// debe poder subir el overall — solo cuenta cuando falta algo.
describe('computeReliabilityBreakdown preparación — asimétrica en el overall', () => {
  it('preparación perfecta no sube el overall por encima de mecánica+defensiva', () => {
    const rows = [
      row({
        report_code: 'REPORT1',
        pull_number: 1,
        enchanted_slot_count: 7,
        enchantable_slot_count: 7,
        gemmed_slot_count: 3,
        gemmable_slot_count: 3,
        personal_mechanic_fail_count: 3,
        avoidable_mechanic_fail_count: 3,
        avoidable_mechanic_eligible_count: 3,
      }),
    ];
    const withPerfectPrep = computeReliabilityBreakdown(rows, NOW);
    const withoutPrepData = computeReliabilityBreakdown(
      rows.map((r) => ({ ...r, enchantable_slot_count: 0, gemmable_slot_count: 0 })),
      NOW,
    );
    expect(withPerfectPrep?.breakdown.preparacion).toBe(100);
    // Mismo overall que si preparación no se hubiese observado en absoluto —
    // el 100% no aportó ningún punto extra al blend.
    expect(withPerfectPrep?.overall).toBe(withoutPrepData?.overall);
  });

  it('preparación incompleta sí penaliza el overall', () => {
    const rows = [
      row({
        report_code: 'REPORT1',
        pull_number: 1,
        enchanted_slot_count: 5,
        enchantable_slot_count: 7,
        gemmed_slot_count: 1,
        gemmable_slot_count: 3,
      }),
    ];
    const withGapPrep = computeReliabilityBreakdown(rows, NOW);
    const withPerfectPrep = computeReliabilityBreakdown(
      rows.map((r) => ({ ...r, enchanted_slot_count: 7, gemmed_slot_count: 3 })),
      NOW,
    );
    expect(withGapPrep?.breakdown.preparacion).toBeLessThan(100);
    expect(withGapPrep!.overall).toBeLessThan(withPerfectPrep!.overall);
  });
});

describe('computeReliabilityBreakdown preparación y consistencia', () => {
  it('puntúa conjuntamente enchants y slots de gema elegibles', () => {
    const result = computeReliabilityBreakdown(
      [
        row({
          enchanted_slot_count: 7,
          enchantable_slot_count: 7,
          gemmed_slot_count: 3,
          gemmable_slot_count: 3,
        }),
      ],
      NOW,
    );
    expect(result?.breakdown.preparacion).toBe(100);
  });

  it('penaliza los altibajos frente a una ejecución estable con la misma muestra', () => {
    const stable = computeReliabilityBreakdown(
      Array.from({ length: 6 }, () => row()),
      NOW,
    );
    const alternating = computeReliabilityBreakdown(
      Array.from({ length: 6 }, (_, index) => row({ had_avoidable_damage: index % 2 === 0 })),
      NOW,
    );
    expect(stable?.consistency?.score).toBe(100);
    expect(alternating?.consistency?.score).toBeLessThan(
      alternating?.consistency?.averageExecution ?? 0,
    );
  });

  it('no publica consistencia con menos de cinco pulls', () => {
    expect(
      computeReliabilityBreakdown(
        Array.from({ length: 4 }, () => row()),
        NOW,
      )?.consistency,
    ).toBeNull();
  });
});
