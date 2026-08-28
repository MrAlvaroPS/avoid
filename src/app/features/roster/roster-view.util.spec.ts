import { isActionableRepeatOffense, type RepeatOffenderRow } from '../../core/offenders.service';
import type { PlayerReliability } from '../../core/reliability.service';
import { buildRosterPlayerView, filterRosterViews, groupRosterViews } from './roster-view.util';

function player(overrides: Partial<PlayerReliability> = {}): PlayerReliability {
  return {
    playerName: 'Raider',
    overall: 82,
    breakdown: { mecanica: 90, defensiva: 80, preparacion: 100, asistencia: 100 },
    consistency: null,
    latestGemCount: 3,
    latestGemmedSlotCount: 3,
    latestGemmableSlotCount: 3,
    latestEnchantedSlotCount: 7,
    latestEnchantableSlotCount: 7,
    sampleSize: 24,
    sampleNightCount: 3,
    lastObservedAt: '2026-08-26T22:00:00.000Z',
    defensiveOpportunityCount: 5,
    observedAxisCount: 4,
    attendanceNightsAttended: 3,
    attendanceNightsTotal: 3,
    trend: 'flat',
    role: 'Melee',
    rank: 'Main',
    ...overrides,
  };
}

function pattern(overrides: Partial<RepeatOffenderRow> = {}): RepeatOffenderRow {
  return {
    playerName: 'Raider',
    category: 'avoidable-ground',
    instanceCount: 3,
    distinctBossCount: 2,
    lastOccurredAt: '2026-08-26T22:00:00.000Z',
    ...overrides,
  };
}

describe('roster operativo', () => {
  it('representa la ausencia de muestra como sin datos, no como un 0 negativo', () => {
    const view = buildRosterPlayerView(
      player({ overall: 0, sampleSize: 0, sampleNightCount: 0 }),
      [],
    );
    expect(view.status).toBe('no-data');
    expect(view.summaryTitle).toBe('Sin evidencia reciente');
    expect(view.evidenceLevel).toBe('none');
  });

  it('convierte slots pendientes al inicio de la noche en una acción concreta', () => {
    const view = buildRosterPlayerView(
      player({ latestGemmedSlotCount: 2, latestGemmableSlotCount: 3 }),
      [],
    );
    expect(view.status).toBe('action');
    expect(view.summaryTitle).toBe('Preparación incompleta');
    expect(view.summaryDetail).toContain('1 slot de gema');
  });

  it('solo alerta por defensivos cuando hay una muestra evaluable mínima', () => {
    const tooLittleEvidence = buildRosterPlayerView(
      player({
        breakdown: { mecanica: 90, defensiva: 20, preparacion: 100, asistencia: 100 },
        defensiveOpportunityCount: 2,
      }),
      [],
    );
    const enoughEvidence = buildRosterPlayerView(
      player({
        breakdown: { mecanica: 90, defensiva: 20, preparacion: 100, asistencia: 100 },
        defensiveOpportunityCount: 3,
      }),
      [],
    );
    expect(tooLittleEvidence.status).toBe('healthy');
    expect(enoughEvidence.status).toBe('review');
    expect(enoughEvidence.summaryTitle).toBe('Uso defensivo por revisar');
  });

  it('presenta una repetición confirmada como revisión, con su evidencia', () => {
    const view = buildRosterPlayerView(player(), [pattern()]);
    expect(view.status).toBe('review');
    expect(view.summaryTitle).toContain('Zona evitable');
    expect(view.summaryDetail).toContain('3 impactos');
  });

  it('agrupa por rol y permite filtrar atención sin rankings', () => {
    const tank = buildRosterPlayerView(player({ playerName: 'Tank', role: 'Tank' }), []);
    const healer = buildRosterPlayerView(
      player({ playerName: 'Healer', role: 'Heal', latestEnchantedSlotCount: 6 }),
      [],
    );
    const groups = groupRosterViews(filterRosterViews([tank, healer], 'attention', ''));
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('healers');
    expect(groups[0].players[0].player.playerName).toBe('Healer');
  });
});

describe('atribución de patrones repetidos', () => {
  it('solo considera accionable la categoría que identifica directamente al jugador', () => {
    expect(isActionableRepeatOffense('avoidable-ground')).toBe(true);
    expect(isActionableRepeatOffense('raid-damage')).toBe(false);
    expect(isActionableRepeatOffense('tankbuster')).toBe(false);
    expect(isActionableRepeatOffense('spread')).toBe(false);
  });
});
