// Colocar en: src/app/app.routes.integration.spec.ts
// §bug real encontrado (2026-09-06, verificado en navegador autenticado):
// "solo aparece el top-nav, todo el contenido queda vacío" al arrancar, y
// "/roster → clic en Raid no cambia ni la URL". Causa raíz: Angular Router
// solo hereda params del padre en una ruta hija si el hijo tiene path ''
// (o el padre no tiene componente propio) — ver getInherited() en
// @angular/router. report/:reportCode (ReportWorkspaceComponent, CON
// componente propio) tiene hijos con path 'raid' y 'player/:playerName' —
// ninguno de los dos es '', así que sin paramsInheritanceStrategy:'always'
// (app.config.ts) reportCode() nunca llegaba a RaidSessionComponent ni a
// NightPlayerDossierComponent: input.required<string>() se quedaba sin
// valor, NG0950 al leerlo, y el Router trataba la navegación como fallida
// — nunca llegaba ni siquiera a montar el sidebar, hermano del
// router-outlet afectado.
//
// Este spec RENDERIZA el árbol real de rutas (TestBed + RouterTestingHarness)
// y comprueba el DOM/las instancias reales — no solo que la URL resuelva
// (eso NO habría detectado este bug: el smoke de Playwright basado en forma
// de URL pasaba igual, porque nunca llegaba a montar ningún componente real
// al quedarse siempre bloqueado en officerGuard→/login antes de esto).
//
// §ESTADO (2026-09-06): este archivo NO se puede ejecutar todavía en este
// entorno, por un motivo distinto y ANTERIOR a este bug — no confundir uno
// con otro:
//   1. `npx vitest run` directo (el atajo usado en PR1-PR5 para las specs
//      puras, sin TestBed) NO pasa por el paso de build de Angular que
//      inlinea templateUrl/styleUrl en contenido real — Angular intenta
//      resolverlos en runtime vía fetch() y falla ("Failed to parse URL
//      from ./raid-landing.component.html"), porque ese inlinado es un
//      transform específico de @angular/build, no algo que haga esbuild o
//      TypeScript por sí solos.
//   2. `ng test` (el único camino que SÍ inlina templateUrl/styleUrl
//      correctamente) sigue roto para TODO el proyecto por el problema
//      pre-existente ya documentado en PR1 (confirmado con `git stash`
//      antes de tocar nada de IRIS): imports con extensión .ts estilo Deno
//      en supabase/functions/_shared/*.ts sin allowImportingTsExtensions, +
//      dos specs de mecánicas/defensivos con errores de tipos genuinos
//      (effective-defensive-state.spec.ts, pre-e6-runtime-materiality.spec.ts).
// Este spec queda listo para ejecutarse en cuanto CUALQUIERA de los dos
// bloqueos se resuelva — no es un test decorativo, es la regresión
// permanente pedida; solo falta un `ng test` que funcione para correrlo.
import '@angular/compiler'; // TestBed compila las plantillas en JIT — hace falta explícitamente fuera del test runner completo de Angular (ver report-workspace.service.spec.ts, PR1, para el mismo problema con la resolución de providers).
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import {
  provideRouter,
  withComponentInputBinding,
  withRouterConfig,
  Router,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import { signal } from '@angular/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routes } from './app.routes';
import { AuthService, type OfficerStatus } from './core/auth.service';
import { SupabaseService } from './core/supabase.service';
import { RaidLandingComponent } from './features/raid-landing/raid-landing.component';
import { RaidSessionComponent } from './features/raid-session/raid-session.component';
import { NightReportComponent } from './features/night-report/night-report.component';
import { NightPlayerDossierComponent } from './features/night-player-dossier/night-player-dossier.component';
import { ReportSidebarComponent } from './features/report-workspace/report-sidebar.component';
import { RosterComponent } from './features/roster/roster.component';

const TEST_CODE = 'TESTCODE1';
const STORAGE_KEY = 'avoid.currentReportCode';

/** Igual que roster-snapshot-cache.service.spec.ts / reports.service.spec.ts,
 * pero generalizado a cualquier tabla: por defecto responde `[]` (sirve para
 * cualquier .select() en array), y si la cadena llama a .maybeSingle()/
 * .single() se queda con el primer elemento (o null) — así una misma fila
 * fija sirve tanto para listAllReports() (array) como para getReport()
 * (single), sin tener que trackear qué tabla pidió qué exactamente. El
 * objetivo de este spec es la ACTIVACIÓN DE RUTAS/INPUTS, no la corrección
 * de cada pipeline de datos (NightReportService et al. ya tienen sus
 * propios try/catch — un dato vacío se degrada a su propio estado de error
 * interno, nunca revienta la navegación).
 */
class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private singular = false;
  constructor(private readonly result: unknown) {}
  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  in(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  maybeSingle(): this {
    this.singular = true;
    return this;
  }
  single(): this {
    this.singular = true;
    return this;
  }
  then<T1, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    const data =
      this.singular && Array.isArray(this.result) ? (this.result[0] ?? null) : this.result;
    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}

function buildFakeSupabase(): SupabaseService {
  const byTable: Record<string, unknown> = {
    reports: [
      {
        code: TEST_CODE,
        title: 'Noche de prueba',
        zone_id: null,
        zone_name: 'Zona de prueba',
        is_raid: true,
        start_time: Date.UTC(2026, 8, 2, 21),
        end_time: null,
        last_processed_fight_id: null,
      },
    ],
    pulls: [
      {
        id: 'pull-1',
        report_code: TEST_CODE,
        fight_id: 1,
        boss_id: 'boss-1',
        difficulty: 'Mythic',
        pull_number: 1,
        wipe_pct: 0,
        duration_ms: 120000,
        closed_at: '2026-09-02T21:10:00.000Z',
        created_at: '2026-09-02T21:10:00.000Z',
        raid_damage_taken_series: null,
        wipe_call_confidence: null,
        wipe_call_signals: null,
        wipe_call_excluded: false,
        is_ninja_pull: false,
        ninja_pull_excluded: false,
        ninja_pull_signals: null,
        phase_transitions: null,
        last_phase_absolute_index: null,
        last_phase_is_intermission: null,
        unassigned_mechanic_occurrences: null,
      },
    ],
    report_encounters: [
      {
        report_code: TEST_CODE,
        fight_id: 1,
        encounter_id: 1,
        boss_name: 'Jefe de prueba',
        wcl_difficulty_id: 16,
        kill: true,
        start_time: 0,
        end_time: 120000,
      },
    ],
    player_pull_records: [
      { player_name: 'Dewerland', class: 'Warlock', spec: 'Destruction', pull_id: 'pull-1' },
    ],
  };
  const client = { from: (table: string) => new FakeQuery(byTable[table] ?? []) };
  return { client } as unknown as SupabaseService;
}

function buildFakeAuth(status: OfficerStatus): AuthService {
  return { officerStatus: signal(status) } as unknown as AuthService;
}

describe('app.routes · activación real de rutas (regresión permanente)', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          routes,
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        { provide: AuthService, useValue: buildFakeAuth('officer') },
        { provide: SupabaseService, useValue: buildFakeSupabase() },
      ],
    });
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('"/" sin report persistido muestra RaidLandingComponent', async () => {
    const harness = await RouterTestingHarness.create('/');
    harness.detectChanges();

    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(RaidLandingComponent);
  });

  it('"/" con avoid.currentReportCode persistido termina en /report/:code/raid', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ reportCode: TEST_CODE, autoRefreshOn: false, lastActivityAt: 0 }),
    );

    const harness = await RouterTestingHarness.create('/');
    harness.detectChanges();

    expect(TestBed.inject(Router).url).toBe(`/report/${TEST_CODE}/raid`);
    const raid = harness.fixture.debugElement.query(By.directive(RaidSessionComponent))
      ?.componentInstance as RaidSessionComponent | undefined;
    expect(raid).toBeInstanceOf(RaidSessionComponent);
    expect(raid?.reportCode()).toBe(TEST_CODE);
  });

  it('/report/:code/raid monta el sidebar y RaidSessionComponent con el reportCode correcto', async () => {
    const harness = await RouterTestingHarness.create(`/report/${TEST_CODE}/raid`);
    harness.detectChanges();

    const sidebar = harness.fixture.debugElement.query(
      By.directive(ReportSidebarComponent),
    )?.componentInstance;
    expect(sidebar).toBeInstanceOf(ReportSidebarComponent);

    const raid = harness.fixture.debugElement.query(By.directive(RaidSessionComponent))
      ?.componentInstance as RaidSessionComponent | undefined;
    expect(raid).toBeInstanceOf(RaidSessionComponent);
    // §la regresión concreta: antes de paramsInheritanceStrategy:'always',
    // esta lectura lanzaba NG0950 (input required sin valor nunca asignado).
    expect(raid?.reportCode()).toBe(TEST_CODE);
  });

  it('/report/:code monta el sidebar y NightReportComponent (Informe) con el reportCode correcto', async () => {
    const harness = await RouterTestingHarness.create(`/report/${TEST_CODE}`);
    harness.detectChanges();

    const sidebar = harness.fixture.debugElement.query(
      By.directive(ReportSidebarComponent),
    )?.componentInstance;
    expect(sidebar).toBeInstanceOf(ReportSidebarComponent);

    const informe = harness.fixture.debugElement.query(By.directive(NightReportComponent))
      ?.componentInstance as NightReportComponent | undefined;
    expect(informe).toBeInstanceOf(NightReportComponent);
    expect(informe?.reportCode()).toBe(TEST_CODE);
  });

  it('/report/:code/player/:name monta el sidebar y NightPlayerDossierComponent con reportCode Y playerName correctos', async () => {
    const harness = await RouterTestingHarness.create(`/report/${TEST_CODE}/player/Dewerland`);
    harness.detectChanges();

    const sidebar = harness.fixture.debugElement.query(
      By.directive(ReportSidebarComponent),
    )?.componentInstance;
    expect(sidebar).toBeInstanceOf(ReportSidebarComponent);

    const dossier = harness.fixture.debugElement.query(By.directive(NightPlayerDossierComponent))
      ?.componentInstance as NightPlayerDossierComponent | undefined;
    expect(dossier).toBeInstanceOf(NightPlayerDossierComponent);
    // §la otra mitad de la misma regresión: playerName SÍ llegaba (es el
    // param del propio segmento hijo), pero reportCode (heredado del
    // padre) no — por eso hacía falta comprobar los dos, no solo uno.
    expect(dossier?.reportCode()).toBe(TEST_CODE);
    expect(dossier?.playerName()).toBe('Dewerland');
  });

  it('desde /roster, navegar a "/" (lo que hace el enlace Raid del top-nav) resuelve correctamente', async () => {
    const harness = await RouterTestingHarness.create('/roster');
    harness.detectChanges();
    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(RosterComponent);

    await harness.navigateByUrl('/');
    harness.detectChanges();

    // Sin report persistido, "/" se queda como RaidLandingComponent — la
    // URL SÍ cambia (antes del fix, la navegación entera fallaba y la URL
    // no llegaba a moverse de /roster).
    expect(harness.routeDebugElement?.componentInstance).toBeInstanceOf(RaidLandingComponent);
  });
});
