import { Routes } from '@angular/router';
import { officerGuard } from './core/officer.guard';
import { raidLandingRedirectGuard } from './core/raid-landing-redirect.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then((m) => m.LoginComponent),
  },
  {
    // §"página independiente con URL... sin navegación, que no se llegue a
    // ella salvo por la URL... que la gente no pueda navegar por ningún
    // lado" (feedback real, 2026-08-30): guía para raiders, sin login (van
    // a abrirla desde un enlace de Discord, no logeados como Oficial) y
    // fuera del nodo con officerGuard a propósito — mismo criterio que
    // /login, un hermano de ese nodo, no un hijo. app.ts/app.html también
    // saltan el nav/mobile-block SOLO para esta ruta (ver ISOLATED_ROUTE_PREFIXES).
    path: 'guia-infografia',
    loadComponent: () =>
      import('./features/guia-infografia/guia-infografia.component').then(
        (m) => m.GuiaInfografiaComponent,
      ),
  },
  {
    // §"proteger todos los datos y rutas salvo que esté logeado un
    // oficial" (feedback real, 2026-08-29): un único nodo padre con
    // officerGuard envuelve TODAS las rutas reales de la app como
    // children — todo lo que sigue de aquí abajo es exactamente lo que
    // había antes de esta tarea, sin tocar.
    path: '',
    canActivate: [officerGuard],
    children: [
      {
        // §PR2 del plan IRIS (Report Workspace): '/' ya no es Raid — es una
        // landing ligera ("todavía no hay ninguna noche activa"). Si ya hay
        // un report activo (?report= o persistido), el guard redirige a
        // report/:reportCode/raid ANTES de montar nada pesado (ver
        // raid-landing-redirect.guard.ts).
        path: '',
        canActivate: [raidLandingRedirectGuard],
        loadComponent: () =>
          import('./features/raid-landing/raid-landing.component').then(
            (m) => m.RaidLandingComponent,
          ),
      },
      {
        // §"Preparación": sección propia en el nav, ANTES de Ajustes —
        // pedida explícitamente aparte de las pestañas de Ajustes (a
        // diferencia de defensive-catalog/unassigned-mechanics-catalog, que
        // sí van embebidas ahí) porque esto no es "catálogo administrativo
        // de datos", es el plan de la mecánica + el generador de reminders
        // que se usa antes de cada pull — ver plan guardado, conversación
        // real 2026-08-30.
        path: 'preparacion',
        loadComponent: () =>
          import('./features/boss-prep/boss-prep.component').then((m) => m.BossPrepComponent),
      },
      {
        // §"vamos mejor a meterlo en ajustes... pestañas, una mecánicas de
        // bosses... otra defensivos... así tenemos todos los ajustes
        // centralizados" (feedback real): una sola ruta — ManifestComponent
        // aloja las dos pestañas, DefensiveCatalogComponent vive dentro como
        // hijo embebido, no como ruta propia.
        path: 'ajustes',
        loadComponent: () =>
          import('./features/manifest/manifest.component').then((m) => m.ManifestComponent),
      },
      {
        path: 'roster',
        loadComponent: () =>
          import('./features/roster/roster.component').then((m) => m.RosterComponent),
      },
      {
        path: 'historial',
        loadComponent: () =>
          import('./features/history/history.component').then((m) => m.HistoryComponent),
      },
      {
        path: 'documentacion',
        loadComponent: () =>
          import('./features/documentation/documentation.component').then(
            (m) => m.DocumentationComponent,
          ),
      },
      {
        // §"un 'todos los pulls' que reúna datos de los pulls de ese boss en esa
        // dificultad": inputs de ruta en vez de query params — es una URL con
        // identidad propia (compartible, bookmarkeable), no un modo/filtro de otra pantalla.
        path: 'boss/:bossId/:difficulty',
        loadComponent: () =>
          import('./features/boss-history/boss-history.component').then(
            (m) => m.BossHistoryComponent,
          ),
      },
      {
        // §"detalle de jugador con su tendencia en el tiempo": mismo criterio
        // que /boss/:bossId/:difficulty — identidad propia en la URL, no un
        // modo del roster.
        path: 'player/:name',
        loadComponent: () =>
          import('./features/player-detail/player-detail.component').then(
            (m) => m.PlayerDetailComponent,
          ),
      },
      {
        // §PR2 del plan IRIS (Report Workspace): las tres pantallas que
        // comparten reportCode — Raid, Informe, Dosier — pasan a vivir bajo
        // un mismo shell persistente (ReportWorkspaceComponent = sidebar +
        // router-outlet), en vez de ser tres rutas hermanas sueltas. Las
        // URLs existentes se conservan (§37): 'report/:reportCode' sigue
        // siendo el Informe, 'report/:reportCode/player/:playerName' sigue
        // siendo el Dosier — 'raid' es la única combinación nueva. Nombres
        // de parámetro sin cambios (reportCode/playerName), así que
        // withComponentInputBinding sigue emparejando igual en los tres
        // componentes hijos.
        path: 'report/:reportCode',
        loadComponent: () =>
          import('./features/report-workspace/report-workspace.component').then(
            (m) => m.ReportWorkspaceComponent,
          ),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./features/night-report/night-report.component').then(
                (m) => m.NightReportComponent,
              ),
          },
          {
            path: 'raid',
            loadComponent: () =>
              import('./features/raid-session/raid-session.component').then(
                (m) => m.RaidSessionComponent,
              ),
          },
          {
            path: 'player/:playerName',
            loadComponent: () =>
              import('./features/night-player-dossier/night-player-dossier.component').then(
                (m) => m.NightPlayerDossierComponent,
              ),
          },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
