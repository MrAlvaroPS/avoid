import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { PlayerReliability } from './reliability.service';
import type { RepeatOffenderRow } from './offenders.service';

// v4 (2026-08-30): mismo shape, pero PlayerReliability.overall cambia de
// VALOR — preparación al 100% ya no suma al blend de Fiabilidad (§"se da
// por supuesto que si lo tienes que hacer no cuenta para sumar", feedback
// real — ver effectiveAxisWeights en reliability.service.ts). Mismo motivo
// que los bumps de night-player-summary-cache.service.ts: sin esto, el
// roster ya cacheado sigue enseñando el overall de la fórmula vieja.
// v5 (2026-09-02): el fingerprint incluye evaluaciones defensivas y ledger.
// Un backfill/replay puede cambiar el score sin tocar pulls.updated_at.
const STORAGE_KEY = 'avoid:roster-snapshot:v5';

export interface RosterSnapshot {
  fingerprint: string;
  savedAt: string;
  players: PlayerReliability[];
  offenders: RepeatOffenderRow[];
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

@Injectable({ providedIn: 'root' })
export class RosterSnapshotCacheService {
  private supabase = inject(SupabaseService);

  read(): RosterSnapshot | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<RosterSnapshot>;
      if (
        typeof parsed.fingerprint !== 'string' ||
        !Array.isArray(parsed.players) ||
        !Array.isArray(parsed.offenders)
      ) {
        return null;
      }
      return parsed as RosterSnapshot;
    } catch {
      return null;
    }
  }

  write(snapshot: RosterSnapshot): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // La vista sigue funcionando en memoria si el navegador bloquea o
      // agota localStorage; la persistencia es una optimización, no la fuente.
    }
  }

  /**
   * Comprobación ligera al entrar en Roster. El cálculo completo se repite
   * si cambió el último pull, avanzó el último report, cambió la
   * composición oficial de wowaudit, O se corrigió algo retroactivamente en
   * un pull YA existente (wipe call reanalizado o editado a mano, ninja
   * pull revertido — ver pulls.updated_at). §"esto aplica a varias partes
   * de la app y varios raiders" (feedback real, 2026-08-28): sin esta
   * última señal, una corrección retroactiva no mueve ni el último pull ni
   * el último report ni el roster de wowaudit, así que el snapshot
   * cacheado se quedaba enseñando el veredicto viejo indefinidamente aunque
   * la base de datos ya estuviera bien (caso real: Pandokie seguía
   * apareciendo sin usar un defensivo en un pull ya reanalizado).
   */
  async fingerprint(): Promise<string> {
    const client = this.supabase.client;
    const [
      pullResponse,
      correctedPullResponse,
      reportResponse,
      rosterResponse,
      defensiveEvaluationResponse,
      ledgerEvaluationResponse,
    ] = await Promise.all([
      client
        .from('pulls')
        .select('id, closed_at')
        .order('closed_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from('pulls')
        .select('id, updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from('reports')
        .select('code, start_time, last_processed_fight_id')
        .order('start_time', { ascending: false })
        .limit(1)
        .maybeSingle(),
      client.from('wowaudit_roster').select('character_id, name, role, rank'),
      client
        .from('player_pull_defensive_evaluations')
        .select('pull_id, player_name, evaluator_version, resolver_version, evaluated_at')
        .order('evaluated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from('player_execution_events')
        .select('pull_id, ledger_evaluator_version, evaluated_at')
        .order('evaluated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (pullResponse.error) throw pullResponse.error;
    if (correctedPullResponse.error) throw correctedPullResponse.error;
    if (reportResponse.error) throw reportResponse.error;
    if (rosterResponse.error) throw rosterResponse.error;
    if (defensiveEvaluationResponse.error) throw defensiveEvaluationResponse.error;
    if (ledgerEvaluationResponse.error) throw ledgerEvaluationResponse.error;

    const roster = [...(rosterResponse.data ?? [])].sort((a, b) =>
      String(a.name).localeCompare(String(b.name), 'es'),
    );
    return stableHash(
      JSON.stringify({
        pull: pullResponse.data ?? null,
        correctedPull: correctedPullResponse.data ?? null,
        report: reportResponse.data ?? null,
        roster,
        defensiveEvaluation: defensiveEvaluationResponse.data ?? null,
        ledgerEvaluation: ledgerEvaluationResponse.data ?? null,
      }),
    );
  }
}
