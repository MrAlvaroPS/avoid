// Colocar en: src/app/core/night-player-summary-cache.service.ts
// §"esos valores no se pueden almacenar de alguna manera aunque se
// actualicen... no todos los días tenemos raid... tiene sentido que
// actualice una única vez cuando termina la raid" (feedback real,
// 2026-08-29): el dosier de un jugador (night-player-summary.service.ts) es
// caro de calcular — fiabilidad de 60 días, mecánicas/muertes/interrupts de
// la noche, y la "Evolución" que además recalcula TODO lo anterior para la
// noche previa — pero determinista: mientras nadie suba un pull nuevo NI
// corrija algo retroactivamente (wipe call reanalizado, ninja pull,
// resolución en Ajustes), el resultado es exactamente el mismo. Mismo
// patrón que ya usa Roster (RosterSnapshotCacheService, §12): snapshot en
// localStorage + una comprobación barata (fingerprint) para saber si sigue
// siendo válido, en vez de recalcularlo en cada visita.
//
// Reutiliza el MISMO fingerprint que ya usa Roster en vez de inventar uno
// nuevo — es una foto del estado global (último pull, último pull corregido
// vía pulls.updated_at, último report, roster de wowaudit) que ya cubre
// exactamente las señales de invalidación que hacen falta aquí también: si
// no cambió nada de eso desde que se guardó este dosier, ningún dato que
// pudiera afectar a esta noche o a la ventana de 60 días de fiabilidad
// cambió tampoco.
import { Injectable, inject } from '@angular/core';
import { RosterSnapshotCacheService } from './roster-snapshot-cache.service';
import type { NightPlayerSummary } from './night-player-summary.service';

const STORAGE_PREFIX = 'avoid:night-player-summary:v1:';
// No acumular sin límite en localStorage — solo los dosiers consultados más
// recientemente (un RL mirando varios raiders seguidos en la misma sesión).
const MAX_ENTRIES = 12;

interface CachedEntry {
  fingerprint: string;
  savedAt: string;
  summary: NightPlayerSummary;
}

function cacheKey(reportCode: string, playerName: string): string {
  return `${STORAGE_PREFIX}${reportCode}|${playerName}`;
}

@Injectable({ providedIn: 'root' })
export class NightPlayerSummaryCacheService {
  private rosterCache = inject(RosterSnapshotCacheService);

  /** Delegado tal cual — ver comentario de arriba sobre por qué se reutiliza el de Roster. */
  fingerprint(): Promise<string> {
    return this.rosterCache.fingerprint();
  }

  read(reportCode: string, playerName: string): CachedEntry | null {
    try {
      const raw = localStorage.getItem(cacheKey(reportCode, playerName));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CachedEntry>;
      if (typeof parsed.fingerprint !== 'string' || !parsed.summary) return null;
      return parsed as CachedEntry;
    } catch {
      return null;
    }
  }

  write(reportCode: string, playerName: string, fingerprint: string, summary: NightPlayerSummary): void {
    try {
      this.evictOldestBeyondLimit();
      localStorage.setItem(
        cacheKey(reportCode, playerName),
        JSON.stringify({ fingerprint, savedAt: new Date().toISOString(), summary } satisfies CachedEntry),
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
