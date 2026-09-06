import { describe, expect, it } from 'vitest';
import {
  resolveCurrentPreservedView,
  resolveReportSwitchTarget,
  type PreservedView,
} from './report-switch-navigation.util';

describe('resolveCurrentPreservedView · PR5', () => {
  it('sin ruta hija activa, no hay vista que preservar', () => {
    expect(resolveCurrentPreservedView(null)).toBeNull();
  });

  it('path "raid" resuelve a la vista Raid', () => {
    expect(resolveCurrentPreservedView({ path: 'raid', playerName: null })).toEqual({
      kind: 'raid',
    });
  });

  it('path "" (sin playerName) resuelve a Informe', () => {
    expect(resolveCurrentPreservedView({ path: '', playerName: null })).toEqual({
      kind: 'informe',
    });
  });

  it('un playerName presente siempre resuelve a Dosier, con independencia del path', () => {
    expect(
      resolveCurrentPreservedView({ path: 'player/:playerName', playerName: 'Dewerland' }),
    ).toEqual({
      kind: 'dossier',
      playerName: 'Dewerland',
    });
  });
});

describe('resolveReportSwitchTarget · PR5', () => {
  it('Dosier A → noche nueva donde A participó: preserva el dosier de A', () => {
    const currentView: PreservedView = { kind: 'dossier', playerName: 'A' };

    const target = resolveReportSwitchTarget('NEW', currentView, new Set(['A', 'B']));

    expect(target).toEqual({
      commands: ['/report', 'NEW', 'player', 'A'],
      playerMissingName: null,
    });
  });

  it('Dosier A → noche nueva donde A NO participó: cae a Raid con aviso, nunca elige otro jugador', () => {
    const currentView: PreservedView = { kind: 'dossier', playerName: 'A' };

    const target = resolveReportSwitchTarget('NEW', currentView, new Set(['B', 'C']));

    expect(target).toEqual({ commands: ['/report', 'NEW', 'raid'], playerMissingName: 'A' });
  });

  it('Raid → noche nueva: preserva Raid, sin comprobar participantes', () => {
    const target = resolveReportSwitchTarget('NEW', { kind: 'raid' }, new Set());

    expect(target).toEqual({ commands: ['/report', 'NEW', 'raid'], playerMissingName: null });
  });

  it('Informe → noche nueva: preserva Informe, sin comprobar participantes', () => {
    const target = resolveReportSwitchTarget('NEW', { kind: 'informe' }, new Set());

    expect(target).toEqual({ commands: ['/report', 'NEW'], playerMissingName: null });
  });

  it('sin vista previa (currentView null), aterriza en Raid por defecto — mismo destino que el resto del flujo', () => {
    const target = resolveReportSwitchTarget('NEW', null, new Set());

    expect(target).toEqual({ commands: ['/report', 'NEW', 'raid'], playerMissingName: null });
  });
});
