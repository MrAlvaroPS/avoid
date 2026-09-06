// Colocar en: src/app/core/raid-landing-redirect.guard.ts
// PR2 del plan IRIS (Report Workspace): '/' pasa a ser una landing ligera,
// no una segunda forma de ver Raid. Si ya hay una noche activa (?report= o
// lo persistido), el guard redirige a report/:reportCode/raid ANTES de que
// se monte ningún componente — así nunca se llega a cargar RaidLandingComponent
// (ni, mucho menos, la vista pesada de Raid) solo para descartarla al
// instante. Mismo idioma que officer.guard.ts (CanActivateFn + UrlTree).
//
// "Válido" aquí es solo "hay un código" — no se confirma contra Supabase
// antes de redirigir (añadiría una ida y vuelta de red a cada visita de '/'
// para nada: si el código no existe de verdad, el destino ya lo sabe
// mostrar — ReportWorkspaceService.open() lo trata como error, y
// RaidSessionComponent.loadExisting ya se degradaba a enseñar el panel de
// importar antes de este PR).
import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { readStoredSession } from './raid-live-session.util';

export const raidLandingRedirectGuard: CanActivateFn = (route) => {
  const router = inject(Router);
  // Prioridad: ?report= (un enlace explícito, p.ej. desde Histórico) >
  // report persistido (volver a la app y encontrar lo que ya estaba activo).
  const code = route.queryParamMap.get('report') ?? readStoredSession()?.reportCode ?? null;
  if (!code) return true; // sin noche activa: '/' se queda como landing ligera
  return router.createUrlTree(['/report', code, 'raid']);
};
