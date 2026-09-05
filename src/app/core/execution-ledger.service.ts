import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';

/**
 * Servicio para leer player_execution_events del ledger v3 en modo shadow.
 * 
 * Mientras reliabilityExecutionV3 = false:
 * - Carga datos pero no los usa en scoring
 * - Compara silenciosamente con v2 legacy
 * - Reporta divergencias > threshold
 * 
 * Cuando flag se activa:
 * - scoring cambia a consumir desde v_player_ledger_summary_v3
 */
@Injectable({
  providedIn: 'root',
})
export class ExecutionLedgerService {
  private supabase = inject(SupabaseService);

  async listPullSummaries(pullIds: string[]): Promise<ExecutionLedgerPullSummary[]> {
    if (!pullIds.length) return [];
    const { data, error } = await this.supabase.client
      .from('player_pull_execution_summary_v3')
      .select(
        'pull_id, player_name, ledger_evaluator_version, event_count, credit_count, penalty_count, primary_penalty_count, mechanic_failure_count, defensive_failure_count, consumable_failure_count, versions_homogeneous, evaluated_at',
      )
      .in('pull_id', pullIds);
    if (error) throw error;
    return (data ?? []) as ExecutionLedgerPullSummary[];
  }

  async listPreparationChecks(
    pullId: string,
    playerName: string,
  ): Promise<PreparationExecutionCheck[]> {
    const { data, error } = await this.supabase.client
      .from('player_execution_events')
      .select('event_type, verdict, confidence, evidence, ledger_evaluator_version, evaluated_at')
      .eq('pull_id', pullId)
      .eq('player_name', playerName)
      .eq('domain', 'preparation');
    if (error) throw error;
    return (data ?? []) as PreparationExecutionCheck[];
  }

  async listMechanicOffenseAudits(
    pullIds: string[],
    playerName: string,
  ): Promise<MechanicOffenseAudit[]> {
    if (!pullIds.length) return [];
    const { data, error } = await this.supabase.client
      .from('player_mechanic_offenses_v3')
      .select(
        'pull_id, mechanic_key, occurrence_index, relationship, reason_code, severity, priority, confidence, evidence, policy_version, context_resolver_version, occurrence_resolver_version, ledger_evaluator_version',
      )
      .eq('player_name', playerName)
      .in('pull_id', pullIds);
    if (error) throw error;
    return (data ?? []) as MechanicOffenseAudit[];
  }
}

export interface ExecutionLedgerPullSummary {
  pull_id: string;
  player_name: string;
  ledger_evaluator_version: string;
  event_count: number;
  credit_count: number;
  penalty_count: number;
  primary_penalty_count: number;
  mechanic_failure_count: number;
  defensive_failure_count: number;
  consumable_failure_count: number;
  versions_homogeneous: boolean;
  evaluated_at: string;
}

export interface PreparationExecutionCheck {
  event_type: 'enchant_check' | 'gem_check';
  verdict: 'success' | 'missed';
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  ledger_evaluator_version: string;
  evaluated_at: string;
  evidence: {
    completed_slots?: number;
    eligible_slots?: number;
  };
}

export interface MechanicOffenseAudit {
  pull_id: string;
  mechanic_key: string;
  occurrence_index: number;
  relationship: 'primary_owner' | 'co_owner' | 'assigned_resolver';
  reason_code: string;
  severity: number | null;
  priority: number | null;
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
  evidence: Record<string, unknown>;
  policy_version: number | null;
  context_resolver_version: string;
  occurrence_resolver_version: string;
  ledger_evaluator_version: string;
}
