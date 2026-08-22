import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/raid-session/raid-session.component').then((m) => m.RaidSessionComponent),
  },
  {
    path: 'ajustes',
    loadComponent: () => import('./features/manifest/manifest.component').then((m) => m.ManifestComponent),
  },
  {
    path: 'historial',
    loadComponent: () => import('./features/history/history.component').then((m) => m.HistoryComponent),
  },
  { path: '**', redirectTo: '' },
];
