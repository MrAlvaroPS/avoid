// Colocar en: src/app/core/raid-live-session.util.ts
// Extraído de raid-session.component.ts (PR2 del plan IRIS Report Workspace)
// para que raid-landing-redirect.guard.ts pueda leer "qué report estaba
// activo" ANTES de montar ningún componente pesado, sin duplicar la lógica.
// Comportamiento sin cambios respecto al original: mismo formato, misma
// compatibilidad con el string plano legacy.
//
// §"si vuelvo a la pestaña de raid se ha perdido el live pull y tengo que
// ponerlo de nuevo en marcha, eso debería guardar más consistencia hasta
// que... no haya cambios en 10 minutos... y ahí ya se pueda dar por cerrado
// el log" (feedback real): el report_code se persiste junto con si "En
// vivo" estaba encendido y cuándo hubo la última actividad real — todo lo
// que hace falta para reanudar al volver. Esto sigue siendo responsabilidad
// exclusiva de Raid/live (§7 del plan) — el workspace nunca lee ni escribe
// esta clave, solo el código de report que ya expone la propia URL.
const STORAGE_KEY = 'avoid.currentReportCode';

export interface StoredSession {
  reportCode: string;
  autoRefreshOn: boolean;
  /** epoch ms de la última vez que se vio actividad real (pull nueva, o una comprobación manual) — no cada tick del polling en sí, que no siempre trae nada nuevo. */
  lastActivityAt: number;
}

export function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // Compat con el formato viejo (un string plano con solo el código,
    // de antes de que existiera autoRefreshOn/lastActivityAt) — se sigue
    // pudiendo leer, solo que sin estado "en vivo" que reanudar.
    if (!raw.trim().startsWith('{'))
      return { reportCode: raw, autoRefreshOn: false, lastActivityAt: 0 };
    const parsed = JSON.parse(raw);
    if (!parsed?.reportCode) return null;
    return {
      reportCode: String(parsed.reportCode),
      autoRefreshOn: !!parsed.autoRefreshOn,
      lastActivityAt: Number(parsed.lastActivityAt) || 0,
    };
  } catch {
    return null; // navegación privada / storage bloqueado / JSON corrupto: se degrada a "sin persistencia", no rompe nada
  }
}

export function writeStoredSession(session: StoredSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // idem — si no se puede persistir, la sesión sigue funcionando en memoria
  }
}
