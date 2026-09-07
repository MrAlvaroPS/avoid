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

// v2 (2026-08-30): §"columnas siempre visibles: parse, ejecución de esta
// noche, defensivos, fiabilidad de la noche" (feedback real) — antes solo
// guardaba nightScore; ahora cachea las 4 métricas de "esta noche" de la
// tabla de asistencia de una vez (todas salen del mismo NightPlayerSummary,
// mismo fingerprint de siempre: acotado a los pulls de ESTE report). Bump de
// versión porque el shape cambia — una entrada v1 vieja (solo nightScore)
// no debe leerse como si ya trajera los campos nuevos.
// v3 (2026-09-07): un fallo transitorio de una de las cargas por jugador se
// convertía en cuatro null y se persistía junto al fingerprint válido del
// report. Después, aunque Supabase se recuperase, la tabla seguía enseñando
// "—" como si fuese ausencia real de dato. Se invalida cualquier snapshot
// v2 creado bajo ese comportamiento y se rechaza cualquier lote que todavía
// contenga una fila completamente vacía (la forma exacta que usa el caller
// para representar una excepción de carga).
// v4 (2026-09-07): fingerprint incompleto — "la ejecución del informe de la
// noche no coincide con la que sale al abrir el dosier del jugador" (feedback
// real, verificado): este fingerprint solo miraba `pulls.closed_at/updated_at`
// de ESTE report, pero nightScore también puede cambiar de VALOR sin tocar
// ningún pull — un backfill/replay de evaluación defensiva (mismo motivo que
// el v5 de RosterSnapshotCacheService), un cutover de generación defensiva
// publicada (mismo motivo que su v6), o una reanálisis que corrige el estado
// de ninja pull de un pull ya analizado. Con el fingerprint viejo, el
// snapshot de ESTE informe seguía "vigente" mientras
// NightPlayerSummaryService.load() (fingerprint global, ver
// RosterSnapshotCacheService) ya recalculaba fresco para el mismo jugador —
// dos cachés del mismo número, dos señales de invalidación distintas,
// divergiendo en silencio. Se añaden aquí las mismas señales extra que ya
// demostraron hacer falta en el fingerprint global, acotadas a los pulls de
// ESTE report donde es posible.
// v5 (2026-09-07): mismo shape, pero nightScore cambia de VALOR — un fallo
// transitorio en getPlayerPullReliabilityInputsForReport se absorbía en `[]`
// (ver night-player-summary.service.ts) y producía un nightScore aproximado
// distinto del real sin que hasTransientFailure lo detectara (no era una fila
// vacía, era una fila con forma válida pero mal calculada). Ya arreglado en
// origen; v5 descarta cualquier snapshot que ya se hubiera guardado con ese
// número degradado.
// v6 (2026-09-07): nightDefensiva y nightReliability cambian de semántica:
// con una generación canónica publicada, Defensivos usa exclusivamente
// Response canónico. El fingerprint ya detecta cambios de generación, pero
// no puede distinguir un snapshot v5 calculado con la fórmula anterior sobre
// la MISMA generación; el bump elimina esos valores de forma determinista.
const STORAGE_PREFIX = 'avoid:night-scores:v6:';

export interface CachedNightAttendanceStats {
  /** Ejecución de esta noche — night-player-summary.service.ts: nightScore (0-1). */
  nightScore: number | null;
  /** Fiabilidad — esta noche (ReliabilityService.getNightReliability(...).overall, 0-100). */
  nightReliability: number | null;
  /** Sub-score "defensiva" del mismo breakdown de fiabilidad de la noche (0-100) — el que ya enseña el dosier. */
  nightDefensiva: number | null;
  /** Media (0-100) del percentil de WCL (world_rank_percent) de los pulls rankeados de esta noche — null si ninguno se pudo rankear. */
  nightParse: number | null;
}

interface CachedEntry {
  fingerprint: string;
  savedAt: string;
  scores: Record<string, CachedNightAttendanceStats>;
}

function isTransientEmptyRow(value: CachedNightAttendanceStats): boolean {
  return (
    value.nightScore == null &&
    value.nightReliability == null &&
    value.nightDefensiva == null &&
    value.nightParse == null
  );
}

function hasTransientFailure(scores: Record<string, CachedNightAttendanceStats>): boolean {
  return Object.values(scores).some(isTransientEmptyRow);
}

@Injectable({ providedIn: 'root' })
export class NightScoreCacheService {
  private supabase = inject(SupabaseService);

  /**
   * Comprobación ligera: cuántos pulls tiene este report y cuándo se tocó el más reciente (closed_at de uno
   * nuevo, o updated_at de una corrección retroactiva — wipe call reanalizado, ninja pull revertido) — MÁS las
   * mismas señales que RosterSnapshotCacheService.fingerprint() ya demostró necesitar (v5/v6 de ese archivo),
   * acotadas a los pulls de ESTE report: un backfill/replay de evaluación defensiva o un cutover de generación
   * publicada pueden cambiar nightScore sin tocar `pulls` en absoluto.
   */
  async fingerprint(reportCode: string): Promise<string> {
    const client = this.supabase.client;
    const { data: pullRows, error: pullError } = await client
      .from('pulls')
      .select('id, closed_at, updated_at')
      .eq('report_code', reportCode);
    if (pullError) throw pullError;
    const rows = (pullRows ?? []) as { id: string; closed_at: string; updated_at: string | null }[];
    const latestTouch = rows.reduce((max, r) => {
      const touch = r.updated_at && r.updated_at > r.closed_at ? r.updated_at : r.closed_at;
      return touch > max ? touch : max;
    }, '');
    const pullIds = rows.map((r) => r.id);

    const [defensiveEvaluationResponse, ledgerEvaluationResponse, defensiveGenerationPointerResponse] =
      await Promise.all([
        pullIds.length
          ? client
              .from('player_pull_defensive_evaluations')
              .select('pull_id, player_name, evaluator_version, resolver_version, evaluated_at')
              .in('pull_id', pullIds)
              .order('evaluated_at', { ascending: false })
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        pullIds.length
          ? client
              .from('player_execution_events')
              .select('pull_id, ledger_evaluator_version, evaluated_at')
              .in('pull_id', pullIds)
              .order('evaluated_at', { ascending: false })
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        client
          .from('defensive_generation_pointer')
          .select('published_generation_id, updated_at')
          .eq('id', true)
          .maybeSingle(),
      ]);
    if (defensiveEvaluationResponse.error) throw defensiveEvaluationResponse.error;
    if (ledgerEvaluationResponse.error) throw ledgerEvaluationResponse.error;
    if (defensiveGenerationPointerResponse.error) throw defensiveGenerationPointerResponse.error;

    return JSON.stringify({
      pullCount: rows.length,
      latestTouch,
      defensiveEvaluation: defensiveEvaluationResponse.data ?? null,
      ledgerEvaluation: ledgerEvaluationResponse.data ?? null,
      defensiveGenerationPointer: defensiveGenerationPointerResponse.data ?? null,
    });
  }

  read(reportCode: string): CachedEntry | null {
    try {
      const key = STORAGE_PREFIX + reportCode;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CachedEntry>;
      if (typeof parsed.fingerprint !== 'string' || !parsed.scores) return null;
      if (hasTransientFailure(parsed.scores)) {
        localStorage.removeItem(key);
        return null;
      }
      return parsed as CachedEntry;
    } catch {
      return null;
    }
  }

  write(reportCode: string, fingerprint: string, scores: Record<string, CachedNightAttendanceStats>): void {
    // `loadNightAttendanceStats` representa una excepción puntual como una
    // fila con sus cuatro campos a null. Esa fila NO es un dato; persistirla
    // hace que un 500/timeout se convierta en "—" estable hasta el próximo
    // cambio de fingerprint. Un lote parcial se usa en memoria, pero nunca
    // se convierte en snapshot durable.
    if (hasTransientFailure(scores)) return;
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
