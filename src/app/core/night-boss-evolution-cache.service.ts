// Colocar en: src/app/core/night-boss-evolution-cache.service.ts
// §"estos datos tienen que estar guardados para no tener que recargarlos
// cada vez que entremos en la tabla si nada cambia. Solo lo actualizamos si
// algo cambia (con un log posterior o un cambio de formulas, etc)" (feedback
// real, 2026-08-30): ReliabilityService.getBossDifficultyEvolution agrega
// TODO el historial de un boss+dificultad — mismo coste que ya paga /roster
// para Fiabilidad-60-días. Reutiliza EXACTAMENTE el mismo fingerprint que
// RosterSnapshotCacheService (último pull tocado, en toda la guild) en vez
// de calcular uno propio: si ese fingerprint no cambió, ni Fiabilidad-60-
// días ni la evolución por boss pueden haber cambiado tampoco — las dos
// leen las mismas tablas de origen (pulls/player_pull_reliability_inputs).
// Clave por boss+dificultad, NO por report_code: "Ulgrax Heroic" es la
// misma evolución la mires desde el informe de esta noche o desde el de la
// semana que viene — cachear por boss sirve también de caché ENTRE informes.
import { Injectable, inject } from '@angular/core';
import { RosterSnapshotCacheService } from './roster-snapshot-cache.service';
import type { BossDifficultyEvolutionPoint } from './reliability.service';

const STORAGE_PREFIX = 'avoid:boss-evolution:v1:';

interface CachedEntry {
  fingerprint: string;
  savedAt: string;
  points: Record<string, BossDifficultyEvolutionPoint[]>;
}

@Injectable({ providedIn: 'root' })
export class NightBossEvolutionCacheService {
  private rosterSnapshotCache = inject(RosterSnapshotCacheService);

  /** Mismo fingerprint que ya usa /roster — nunca uno propio que pueda divergir. */
  fingerprint(): Promise<string> {
    return this.rosterSnapshotCache.fingerprint();
  }

  private key(bossId: string, difficulty: string): string {
    return `${STORAGE_PREFIX}${bossId}|${difficulty}`;
  }

  read(bossId: string, difficulty: string): CachedEntry | null {
    try {
      const raw = localStorage.getItem(this.key(bossId, difficulty));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CachedEntry>;
      if (typeof parsed.fingerprint !== 'string' || !parsed.points) return null;
      return parsed as CachedEntry;
    } catch {
      return null;
    }
  }

  write(bossId: string, difficulty: string, fingerprint: string, points: Record<string, BossDifficultyEvolutionPoint[]>): void {
    try {
      localStorage.setItem(
        this.key(bossId, difficulty),
        JSON.stringify({ fingerprint, savedAt: new Date().toISOString(), points } satisfies CachedEntry),
      );
    } catch {
      // La vista sigue funcionando en memoria si el navegador bloquea o agota localStorage; la persistencia es una optimización, no la fuente.
    }
  }
}
