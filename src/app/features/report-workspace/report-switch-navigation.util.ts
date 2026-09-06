// Colocar en: src/app/features/report-workspace/report-switch-navigation.util.ts
// PR5 del plan IRIS (Report Workspace) — Entrega 5 del spec: "conservación
// de contexto entre noches". Pura, sin Angular ni Supabase: decide A DÓNDE
// navegar al cambiar de report, dada la vista actual y (si aplica) quién
// participó en el report de destino — el llamador (ReportNightSelectorComponent)
// es quien resuelve esos dos datos (ruta activa, participantes del destino)
// y quien de verdad navega. Solo cubre las vistas que ya son rutas hoy —
// Raid, Informe, Dosier (§5.8 del plan); la infografía sigue sin ruta propia,
// fuera de alcance.
export type PreservedView =
  { kind: 'raid' } | { kind: 'informe' } | { kind: 'dossier'; playerName: string };

/** Forma mínima de lo que hace falta del ActivatedRouteSnapshot del hijo activo (raid | '' | player/:playerName) — así resolveCurrentPreservedView no depende de Angular Router para poder probarse sola. */
export interface RouteViewSnapshot {
  /** routeConfig?.path del hijo activo — el path ESTÁTICO de la ruta ('raid', '', 'player/:playerName'), no la URL real. */
  path: string | null;
  playerName: string | null;
}

export function resolveCurrentPreservedView(
  snapshot: RouteViewSnapshot | null,
): PreservedView | null {
  if (!snapshot) return null;
  if (snapshot.playerName) return { kind: 'dossier', playerName: snapshot.playerName };
  if (snapshot.path === 'raid') return { kind: 'raid' };
  return { kind: 'informe' }; // única opción restante: path === ''
}

export interface ReportSwitchTarget {
  /** Comandos listos para router.navigate(...). */
  commands: string[];
  /** Nombre del jugador que NO se pudo preservar — null si no aplica o si sí se preservó. Nunca se elige otro jugador en su lugar (spec §26). */
  playerMissingName: string | null;
}

/**
 * §22/§23/§25/§26 del spec: Raid/Informe se preservan siempre (el destino
 * los tiene por definición — son vistas del report, no del jugador).
 * Dosier se preserva SOLO si el jugador participó en el report de destino;
 * si no, cae a Raid (mismo destino por defecto que el resto del flujo:
 * RaidLandingComponent, HistoryComponent, importar desde el selector) con
 * un aviso — nunca selecciona otro jugador al azar.
 */
export function resolveReportSwitchTarget(
  targetReportCode: string,
  currentView: PreservedView | null,
  targetParticipantNames: ReadonlySet<string>,
): ReportSwitchTarget {
  if (currentView?.kind === 'dossier') {
    if (targetParticipantNames.has(currentView.playerName)) {
      return {
        commands: ['/report', targetReportCode, 'player', currentView.playerName],
        playerMissingName: null,
      };
    }
    return {
      commands: ['/report', targetReportCode, 'raid'],
      playerMissingName: currentView.playerName,
    };
  }
  if (currentView?.kind === 'informe') {
    return { commands: ['/report', targetReportCode], playerMissingName: null };
  }
  return { commands: ['/report', targetReportCode, 'raid'], playerMissingName: null };
}
