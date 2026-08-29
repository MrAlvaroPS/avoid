import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/raid-session/raid-session.component').then((m) => m.RaidSessionComponent),
  },
  {
    // §"vamos mejor a meterlo en ajustes... pestañas, una mecánicas de
    // bosses... otra defensivos... así tenemos todos los ajustes
    // centralizados" (feedback real): una sola ruta — ManifestComponent
    // aloja las dos pestañas, DefensiveCatalogComponent vive dentro como
    // hijo embebido, no como ruta propia.
    path: 'ajustes',
    loadComponent: () => import('./features/manifest/manifest.component').then((m) => m.ManifestComponent),
  },
  {
    path: 'roster',
    loadComponent: () => import('./features/roster/roster.component').then((m) => m.RosterComponent),
  },
  {
    path: 'historial',
    loadComponent: () => import('./features/history/history.component').then((m) => m.HistoryComponent),
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
    loadComponent: () => import('./features/boss-history/boss-history.component').then((m) => m.BossHistoryComponent),
  },
  {
    // §"detalle de jugador con su tendencia en el tiempo": mismo criterio
    // que /boss/:bossId/:difficulty — identidad propia en la URL, no un
    // modo del roster.
    path: 'player/:name',
    loadComponent: () => import('./features/player-detail/player-detail.component').then((m) => m.PlayerDetailComponent),
  },
  {
    // §"un dosier de personaje de una noche concreta": jugador × NOCHE
    // (report_code), la tercera combinación que le faltaba a la app junto a
    // boss+dificultad y jugador+histórico. Nombres de parámetro = nombres
    // de input() del componente (withComponentInputBinding empareja por
    // nombre) — reportCode/playerName, no code/name, para que no haya duda.
    path: 'report/:reportCode/player/:playerName',
    loadComponent: () => import('./features/night-player-dossier/night-player-dossier.component').then((m) => m.NightPlayerDossierComponent),
  },
  {
    // §"echo de menos un informe... a nivel de raid también" (feedback
    // real): la cuarta combinación — RAID × noche, no un jugador concreto.
    // Va DESPUÉS de report/:reportCode/player/:playerName en esta lista a
    // propósito, aunque con rutas estáticas de segmento fijo ('player') el
    // Router de Angular ya las distingue sin ambigüedad por posición.
    path: 'report/:reportCode',
    loadComponent: () => import('./features/night-report/night-report.component').then((m) => m.NightReportComponent),
  },
  { path: '**', redirectTo: '' },
];
