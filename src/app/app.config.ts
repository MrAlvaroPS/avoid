import { ApplicationConfig, LOCALE_ID, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { registerLocaleData } from '@angular/common';
import localeEs from '@angular/common/locales/es';

import { routes } from './app.routes';

// §bug real encontrado (2026-08-23, verificado en real: "19 de August,
// 2026" en el dosier de jugador): sin locale registrado, DatePipe (usado ya
// en boss-history/player-detail/el dosier — `| date: 'd MMM'` etc.) cae al
// default en_US de Angular pase lo que pase — nombres de mes en inglés en
// una app que por lo demás está toda en español. Se registra 'es' una vez
// aquí y se fija como LOCALE_ID del árbol entero.
registerLocaleData(localeEs);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: LOCALE_ID, useValue: 'es' },
    // §boss-history usa :bossId/:difficulty como input() de ruta en vez de
    // leer ActivatedRoute a mano — necesita el binding automático de
    // Angular.
    //
    // §bug real encontrado (2026-09-06, verificado en navegador autenticado:
    // "solo aparece el top-nav, todo el contenido queda vacío" + "/roster →
    // clic en Raid no cambia ni la URL"): withRouterConfig con
    // paramsInheritanceStrategy: 'always' es OBLIGATORIO desde que
    // ReportWorkspaceComponent (report/:reportCode) tiene hijos con su
    // PROPIO segmento no vacío — raid, player/:playerName. Angular Router
    // solo hereda params del padre en rutas hijas si el estrategia es
    // 'always', el path del hijo es '' o el padre no tiene componente propio
    // (ver getInherited() en @angular/router) — el default 'emptyOnly' NO
    // cubre ninguno de esos dos hijos (solo el informe, en path ''), así que
    // RaidSessionComponent/NightPlayerDossierComponent nunca recibían
    // reportCode(): input.required<string>() lo dejaba sin valor, lanzaba
    // NG0950 al leerlo, y el Router trataba la navegación entera como
    // fallida (NavigationError) — nunca llegaba a montar ni siquiera el
    // sidebar, que es hermano del router-outlet afectado dentro del mismo
    // ReportWorkspaceComponent. Ver app.routes.integration.spec.ts para el
    // test de regresión permanente (verifica el input real recibido por
    // cada componente enrutado, no solo que la URL resuelva).
    provideRouter(
      routes,
      withComponentInputBinding(),
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
    ),
  ],
};
