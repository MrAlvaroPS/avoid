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
//
// §regla explícita (2026-09-06, revisión post-bug): raid-live-session.util.ts
// persiste UN solo objeto ({reportCode, autoRefreshOn, lastActivityAt}) bajo
// avoid.currentReportCode, pero representa DOS cosas distintas a propósito
// separadas: (1) "qué report vio esta pestaña por última vez" (navegación —
// lo que este guard usa) y (2) "¿seguía en directo, y cuándo hubo actividad
// real?" (negocio de Raid — lo que RaidSessionComponent.bootstrapReport usa
// para decidir si reanuda "En directo"). Este guard SOLO lee el campo
// reportCode; nunca lee ni razona sobre autoRefreshOn/lastActivityAt, y
// nunca decide si el seguimiento en vivo se reanuda — esa decisión sigue
// siendo exclusiva de RaidSessionComponent. No cambiar este guard para que
// tenga en cuenta el estado en vivo sin revisar antes esa separación.
//
// §gap conocido, no resuelto aquí: RaidSessionComponent.persistSession()
// solo se invoca desde runAnalyze() — o sea, solo cuando de verdad se
// importa/reanaliza un report. Si el usuario solo VE un report ya analizado
// (navegando por el sidebar sin disparar un reanálisis), reportCode no se
// actualiza — este guard seguiría redirigiendo a la última noche
// REANALIZADA, no a la última VISTA. No lo he tocado porque toca la
// persistencia de Raid, que el usuario ha pedido explícitamente no acoplar
// sin una regla acordada primero.
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
