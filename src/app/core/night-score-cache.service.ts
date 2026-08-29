// Colocar en: src/app/core/night-score-cache.service.ts
// §"la parte de ejecucion de esta noche tarda infinito... ese numero solo
// debería cambiar si modificamos nosotros algo para que cambie el baremo.
// Si no, una vez calculado para un informe debería cargarse al instante si
// no se modifica ningún baremo ni nada de ese informe" (feedback real,
// 2026-08-30): NightPlayerSummaryService.load() ya cachea en localStorage
// (NightPlayerSummaryCacheService), pero con el fingerprint GLOBAL de
// RosterSnapshotCacheService — último pull de TODA la guild, cualquier
// noche. Correcto para Fiabilidad (ventana de 60 días real, sí depende de
// pulls de otras noches) pero NO para nightScore: computePullScore
// (night-player-summary.service.ts) solo lee filas de ESTE report_code
// (reliabilityInputByPullId/evaluatedDeathByPullId/pressureWindowEvaluation,
// todas construidas a partir de los pulls de este mismo report) — nunca
// depende de nada fuera de él. Con la tabla de asistencia del informe
// pidiendo 20-30 jugadores a la vez, invalidar TODOS por un pull de una
// raid distinta se nota mucho. Este servicio cachea nightScore con un
// fingerprint acotado a "los pulls de ESTE report" — una vez la noche está
// cerrada (nadie sube ni corrige más pulls de ella), no vuelve a invalidarse
// jamás, sin importar cuántas raids nuevas pasen después.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';

const STORAGE_PREFIX = 'avoid:night-scores:v1:';

interface CachedEntry {
  fingerprint: string;
  savedAt: string;
  scores: Record<string, number | null>;
}

@Injectable({ providedIn: 'root' })
export class NightScoreCacheService {
  private supabase = inject(SupabaseService);

  /** Comprobación ligera: cuántos pulls tiene este report y cuándo se tocó el más reciente (closed_at de uno nuevo, o updated_at de una corrección retroactiva — wipe call reanalizado, ninja pull revertido). */
  async fingerprint(reportCode: string): Promise<string> {
    const { data, error } = await this.supabase.client
      .from('pulls')
      .select('id, closed_at, updated_at')
      .eq('report_code', reportCode);
    if (error) throw error;
    const rows = (data ?? []) as { id: string; closed_at: string; updated_at: string | null }[];
    const latestTouch = rows.reduce((max, r) => {
      const touch = r.updated_at && r.updated_at > r.closed_at ? r.updated_at : r.closed_at;
      return touch > max ? touch : max;
    }, '');
    return `${rows.length}:${latestTouch}`;
  }

  read(reportCode: string): CachedEntry | null {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + reportCode);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CachedEntry>;
      if (typeof parsed.fingerprint !== 'string' || !parsed.scores) return null;
      return parsed as CachedEntry;
    } catch {
      return null;
    }
  }

  write(reportCode: string, fingerprint: string, scores: Record<string, number | null>): void {
    try {
      localStorage.setItem(
        STORAGE_PREFIX + reportCode,
        JSON.stringify({ fingerprint, savedAt: new Date().toISOString(), scores } satisfies CachedEntry),
      );
    } catch {
      // La vista sigue funcionando en memoria si el navegador bloquea o agota localStorage; la persistencia es una optimización, no la fuente.
    }
  }
}
