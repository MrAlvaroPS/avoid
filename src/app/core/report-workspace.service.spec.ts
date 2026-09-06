import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ReportWorkspaceService } from './report-workspace.service';
import { ReportsService } from './reports.service';
import { ReportParticipantsService, type ReportParticipant } from './report-participants.service';
import type { ReportRow } from '../shared/models/domain';

function report(code: string): ReportRow {
  return {
    code,
    title: `Report ${code}`,
    zone_id: null,
    zone_name: null,
    is_raid: true,
    start_time: 1,
    end_time: null,
    last_processed_fight_id: null,
  };
}

function participant(name: string): ReportParticipant {
  return {
    name,
    className: 'Warlock',
    spec: 'Destruction',
    role: 'Ranged',
    rank: 'Main',
    avatarUrl: null,
  };
}

/** Promesa controlable desde fuera — para forzar a mano el orden de
 * resolución en el test de carrera A→B sin depender de timers. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Mismo patrón que roster-snapshot-cache.service.spec.ts: `new Service()`
// dentro de runInInjectionContext, en vez de resolverlo vía el injector como
// class provider — así no hace falta el compilador JIT de Angular (@angular/
// compiler) solo para un test, que sí exigiría providerToFactory al pedirle
// al Injector que instancie la clase por sí mismo.
function buildService(
  reportsService: Partial<ReportsService>,
  participantsService: Partial<ReportParticipantsService>,
): ReportWorkspaceService {
  const injector = Injector.create({
    providers: [
      { provide: ReportsService, useValue: reportsService },
      { provide: ReportParticipantsService, useValue: participantsService },
    ],
  });
  return runInInjectionContext(injector, () => new ReportWorkspaceService());
}

describe('ReportWorkspaceService.open · PR1', () => {
  it('en éxito, rellena reportCode/report/participants y apaga loading', async () => {
    const service = buildService(
      { getReport: vi.fn().mockResolvedValue(report('A')) },
      { list: vi.fn().mockResolvedValue([participant('Dewerland')]) },
    );

    await service.open('A');

    expect(service.reportCode()).toBe('A');
    expect(service.report()).toEqual(report('A'));
    expect(service.participants()).toEqual([participant('Dewerland')]);
    expect(service.loading()).toBe(false);
    expect(service.error()).toBeNull();
  });

  it('getReport() === null se trata como fallo de carga, no como éxito vacío', async () => {
    const service = buildService(
      { getReport: vi.fn().mockResolvedValue(null) },
      { list: vi.fn().mockResolvedValue([participant('Dewerland')]) },
    );

    await service.open('DOES-NOT-EXIST');

    expect(service.error()).toBe('No se pudo cargar esta noche.');
    expect(service.report()).toBeNull();
    expect(service.participants()).toEqual([]);
    expect(service.loading()).toBe(false);
  });

  it('carrera A→B: una respuesta tardía de A nunca pisa el estado ya establecido por B', async () => {
    const reportA = deferred<ReturnType<typeof report> | null>();
    // A se queda "colgado" en getReport (se resuelve tarde, a mano, más
    // abajo); su `list` sí resuelve rápido — así Promise.all(A) sigue en
    // vuelo esperando solo a getReport, tal y como pasaría de verdad con una
    // respuesta lenta de red, en vez de quedarse pendiente para siempre.
    const getReport = vi
      .fn()
      .mockImplementationOnce(() => reportA.promise)
      .mockResolvedValueOnce(report('B'));
    const list = vi
      .fn()
      .mockResolvedValueOnce([participant('Mechavalec')])
      .mockResolvedValueOnce([participant('Sjorsak')]);
    const service = buildService({ getReport }, { list });

    const openA = service.open('A'); // no se espera todavía: sigue "en vuelo"
    await service.open('B'); // se resuelve por completo antes de que A termine

    expect(service.reportCode()).toBe('B');
    expect(service.report()).toEqual(report('B'));
    expect(service.participants()).toEqual([participant('Sjorsak')]);

    reportA.resolve(report('A')); // A llega tarde
    await openA;
    await Promise.resolve(); // deja correr el microtask de la resolución tardía

    expect(service.reportCode()).toBe('B');
    expect(service.report()).toEqual(report('B'));
    expect(service.participants()).toEqual([participant('Sjorsak')]);
  });

  it('si open(B) falla, no deja visibles report/participants del report anterior etiquetados como si fueran los de B', async () => {
    const getReport = vi
      .fn()
      .mockResolvedValueOnce(report('A'))
      .mockRejectedValueOnce(new Error('network down'));
    const list = vi
      .fn()
      .mockResolvedValueOnce([participant('Dewerland')])
      .mockResolvedValueOnce([]);
    const service = buildService({ getReport }, { list });

    await service.open('A');
    expect(service.report()).toEqual(report('A')); // precondición: A cargó bien

    await service.open('B');

    expect(service.reportCode()).toBe('B');
    expect(service.report()).toBeNull();
    expect(service.participants()).toEqual([]);
    expect(service.error()).toBe('network down');
    expect(service.loading()).toBe(false);
  });
});
