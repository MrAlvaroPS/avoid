// Colocar en: src/app/core/night-report-cache.service.ts
// §"En informe de noche no están persistiendo los datos y métricas cuando no
// hay novedades y calcula todo siempre que se entra ahí lo que es un gasto de
// recursos" (feedback real, 2026-09-03): NightReportService.load() no tenía
// ninguna caché, a diferencia del dosier de jugador (ver
// night-player-summary-cache.service.ts, mismo problema ya resuelto ahí en
// 2026-08-29). Mismo patrón exacto: snapshot en localStorage + el fingerprint
// ya existente de RosterSnapshotCacheService (último pull, último pull
// corregido vía pulls.updated_at, último report, roster de wowaudit) — si
// nada de eso cambió desde que se guardó este informe, el resultado es
// idéntico y no hace falta recalcularlo.
import { Injectable, inject } from '@angular/core';
import { RosterSnapshotCacheService } from './roster-snapshot-cache.service';
import type { NightReport } from './night-report.service';

// v1: primera versión cacheada. Cada cambio de forma de NightReport que un
// objeto viejo no pueda satisfacer en tiempo de ejecución (campo nuevo leído
// sin `?.`/`??`) necesita su propio bump — mismo criterio que
// night-player-summary-cache.service.ts, ver su historial de versiones para
// el porqué de esa regla.
const STORAGE_PREFIX = 'avoid:night-report:v1:';
// Un RL revisando varios reports seguidos en la misma sesión — no acumular
// sin límite en localStorage.
const MAX_ENTRIES = 8;

interface CachedEntry {
  fingerprint: string;
  savedAt: string;
  report: NightReport;
}

function cacheKey(reportCode: string): string {
  return `${STORAGE_PREFIX}${reportCode}`;
}

@Injectable({ providedIn: 'root' })
export class NightReportCacheService {
  private rosterCache = inject(RosterSnapshotCacheService);

  /** Delegado tal cual — mismo fingerprint global que ya usa Roster y el dosier de jugador. */
  fingerprint(): Promise<string> {
    return this.rosterCache.fingerprint();
  }

  read(reportCode: string): CachedEntry | null {
    try {
      const raw = localStorage.getItem(cacheKey(reportCode));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CachedEntry>;
      if (typeof parsed.fingerprint !== 'string' || !parsed.report) return null;
      return parsed as CachedEntry;
    } catch {
      return null;
    }
  }

  write(reportCode: string, fingerprint: string, report: NightReport): void {
    try {
      this.evictOldestBeyondLimit();
      localStorage.setItem(
        cacheKey(reportCode),
        JSON.stringify({ fingerprint, savedAt: new Date().toISOString(), report } satisfies CachedEntry),
      );
    } catch {
      // La vista sigue funcionando en memoria si el navegador bloquea o
      // agota localStorage; la persistencia es una optimización, no la fuente.
    }
  }

  private evictOldestBeyondLimit(): void {
    const entries: { key: string; savedAt: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '') as Partial<CachedEntry>;
        entries.push({ key, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '' });
      } catch {
        entries.push({ key, savedAt: '' });
      }
    }
    if (entries.length < MAX_ENTRIES) return;
    entries.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    for (const entry of entries.slice(0, entries.length - MAX_ENTRIES + 1)) {
      localStorage.removeItem(entry.key);
    }
  }
}
