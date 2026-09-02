import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { DefensiveResolutionConfidence, ResolvedDefensive } from './effective-defensives.ts';
import {
  evaluateDefensiveExecution,
  type DefensiveExecutionEvaluationResult,
  type EvaluationPlanSlot,
  type ObservedDefensiveCast,
} from './defensive-execution-evaluator.ts';

interface PullRecord {
  id: string;
  player_name: string;
  died: boolean;
  wipe_call_cluster: boolean;
  death_cause: Record<string, unknown> | null;
  game_build: string | null;
  game_build_confidence: DefensiveResolutionConfidence | null;
  talent_build_fingerprint: string | null;
  defensive_resolution_version: string | null;
  defensive_resolution_shadow: { kit?: ResolvedDefensive[]; resolverVersion?: string } | null;
  defensive_casts: {
    spellId: number;
    timestampsMs?: number[];
    events?: { timestampMs?: number; targetActorId?: number | null; targetName?: string | null }[];
  }[] | null;
  defensive_pressure_windows_v2: {
    baselineValue?: number;
    windows?: {
      startMs?: number;
      endMs?: number;
      peakMs?: number;
      peakValue?: number;
      mechanicId?: number | null;
    }[];
  } | null;
}

interface PlanVersion {
  id: string;
  plan_mode: 'full' | 'partial' | 'no_plan';
  solver_version: string;
  resolver_version: string;
  planning_quality: 'optimal' | 'fallback_greedy' | 'manual';
  fallback_used: boolean;
  game_build: string | null;
  diagnostics: Record<string, unknown> | null;
}

interface PlanMember {
  player_key: string;
  player_name: string;
  game_build: string | null;
  build_fingerprint: string | null;
  build_confidence: DefensiveResolutionConfidence;
  resolver_version: string;
  effective_kit: ResolvedDefensive[];
  included: boolean;
}

const CONFIDENCE_RANK: Record<DefensiveResolutionConfidence, number> = {
  verified: 0,
  inferred: 1,
  fallback: 2,
  uncertain: 3,
};

function weakestConfidence(...values: (DefensiveResolutionConfidence | null | undefined)[]): DefensiveResolutionConfidence {
  return values.reduce<DefensiveResolutionConfidence>(
    (weakest, candidate) => (candidate && CONFIDENCE_RANK[candidate] > CONFIDENCE_RANK[weakest] ? candidate : weakest),
    'verified',
  );
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function planSlotFromRow(row: Record<string, unknown>): EvaluationPlanSlot {
  return {
    id: String(row['id']),
    abilityId: Number(row['ability_id']),
    occurrenceIndex: Number(row['occurrence_index']),
    occurrenceTimeMs: Number(row['occurrence_time_ms']),
    windowStartMs: Number(row['window_start_ms']),
    windowEndMs: Number(row['window_end_ms']),
    priority: Number(row['priority'] ?? 1),
    requirementLevel: row['requirement_level'] as EvaluationPlanSlot['requirementLevel'],
    coverageStatus: row['coverage_status'] as EvaluationPlanSlot['coverageStatus'],
    assignedPlayerKey: typeof row['assigned_player_key'] === 'string' ? row['assigned_player_key'] : null,
    targetPlayerKey: typeof row['target_player_key'] === 'string' ? row['target_player_key'] : null,
    defensiveSpellId: finite(row['defensive_spell_id']),
    plannedCastAtMs: finite(row['planned_cast_at_ms']),
    confidence: row['confidence'] as DefensiveResolutionConfidence,
  };
}

function observedCasts(
  record: PullRecord,
  sourcePlayerKey: string,
  playerKeyByName: ReadonlyMap<string, string>,
): ObservedDefensiveCast[] {
  const casts: ObservedDefensiveCast[] = [];
  for (const defensive of record.defensive_casts ?? []) {
    const spellId = finite(defensive.spellId);
    if (spellId == null || spellId <= 0) continue;
    if (defensive.events) {
      for (const event of defensive.events) {
        const timeMs = finite(event.timestampMs);
        if (timeMs == null) continue;
        const targetName = typeof event.targetName === 'string' ? event.targetName : null;
        casts.push({
          sourcePlayerKey,
          spellId,
          timeMs,
          targetPlayerKey: targetName == null ? undefined : (playerKeyByName.get(normalizedName(targetName)) ?? null),
          targetActorId: finite(event.targetActorId),
          targetName,
        });
      }
      continue;
    }
    // Históricos aún no reanalizados conservan timestamps para personales,
    // pero target queda intencionadamente ausente: external no puede puntuar.
    for (const rawTime of defensive.timestampsMs ?? []) {
      const timeMs = finite(rawTime);
      if (timeMs != null) casts.push({ sourcePlayerKey, spellId, timeMs });
    }
  }
  return casts.sort((left, right) => left.timeMs - right.timeMs || left.spellId - right.spellId);
}

function confidenceForRecord(record: PullRecord, member: PlanMember | null, plan: PlanVersion | null): DefensiveResolutionConfidence {
  let confidence = weakestConfidence(record.game_build_confidence ?? 'uncertain', member?.build_confidence);
  if (!record.game_build || !record.talent_build_fingerprint) confidence = 'uncertain';
  if (member) {
    if (!member.game_build || !member.build_fingerprint) confidence = 'uncertain';
    if (record.game_build !== member.game_build || record.talent_build_fingerprint !== member.build_fingerprint) confidence = 'uncertain';
  }
  if (plan?.game_build && record.game_build !== plan.game_build) confidence = 'uncertain';
  return confidence;
}

export async function evaluateDefensivePull(
  supabase: SupabaseClient,
  pullId: string,
): Promise<DefensiveExecutionEvaluationResult[]> {
  const { data: pull, error: pullError } = await supabase
    .from('pulls')
    .select('id,ninja_pull_excluded,wipe_call_excluded,wipe_call_signals')
    .eq('id', pullId)
    .single();
  if (pullError) throw pullError;
  if (pull.ninja_pull_excluded) {
    const { error } = await supabase.from('player_pull_defensive_evaluations').delete().eq('pull_id', pullId);
    if (error) throw error;
    return [];
  }
  const cutoffCandidate = pull.wipe_call_excluded
    ? finite((pull.wipe_call_signals as Record<string, unknown> | null)?.['wipeCallStartMs'])
    : null;
  const evaluationCutoffMs = cutoffCandidate != null && cutoffCandidate >= 0 ? cutoffCandidate : null;

  let { data: binding, error: bindingError } = await supabase
    .from('pull_defensive_plan_binding')
    .select('pull_id,plan_version_id,mode_at_pull')
    .eq('pull_id', pullId)
    .maybeSingle();
  if (bindingError) throw bindingError;
  if (!binding) {
    const bound = await supabase.rpc('bind_pull_to_current_defensive_plan', { p_pull_id: pullId });
    if (bound.error) throw bound.error;
    binding = bound.data;
  }
  if (!binding) throw new Error(`No se pudo vincular el pull ${pullId} a un plan defensivo.`);

  const { data: recordRows, error: recordsError } = await supabase
    .from('player_pull_records')
    .select(
      'id,player_name,died,wipe_call_cluster,death_cause,game_build,game_build_confidence,talent_build_fingerprint,defensive_resolution_version,defensive_resolution_shadow,defensive_casts,defensive_pressure_windows_v2',
    )
    .eq('pull_id', pullId)
    .order('player_name');
  if (recordsError) throw recordsError;
  const records = (recordRows ?? []) as PullRecord[];

  let plan: PlanVersion | null = null;
  let members: PlanMember[] = [];
  let slots: EvaluationPlanSlot[] = [];
  if (binding.plan_version_id) {
    const [planResult, membersResult, slotsResult] = await Promise.all([
      supabase
        .from('defensive_plan_versions')
        .select('id,plan_mode,solver_version,resolver_version,planning_quality,fallback_used,game_build,diagnostics')
        .eq('id', binding.plan_version_id)
        .eq('status', 'published')
        .single(),
      supabase.from('defensive_plan_members').select('*').eq('plan_version_id', binding.plan_version_id),
      supabase.from('defensive_plan_slots').select('*').eq('plan_version_id', binding.plan_version_id),
    ]);
    if (planResult.error) throw planResult.error;
    if (membersResult.error) throw membersResult.error;
    if (slotsResult.error) throw slotsResult.error;
    plan = planResult.data as PlanVersion;
    members = (membersResult.data ?? []) as PlanMember[];
    slots = (slotsResult.data ?? []).map((row) => planSlotFromRow(row as Record<string, unknown>));
  }

  const memberByName = new Map(members.map((member) => [normalizedName(member.player_name), member]));
  const playerKeyByName = new Map(members.map((member) => [normalizedName(member.player_name), member.player_key]));
  for (const record of records) {
    if (!playerKeyByName.has(normalizedName(record.player_name))) {
      playerKeyByName.set(normalizedName(record.player_name), `name:${normalizedName(record.player_name)}`);
    }
  }

  const results = records.map((record) => {
    const member = memberByName.get(normalizedName(record.player_name)) ?? null;
    const playerKey = member?.player_key ?? playerKeyByName.get(normalizedName(record.player_name))!;
    const shadowKit = record.defensive_resolution_shadow?.kit ?? [];
    const kit = member?.effective_kit ?? shadowKit;
    const confidence = confidenceForRecord(record, member, plan);
    const pressure = record.defensive_pressure_windows_v2;
    const windows = (pressure?.windows ?? []).flatMap((window, index) => {
      const startMs = finite(window.startMs);
      const endMs = finite(window.endMs);
      const peakMs = finite(window.peakMs);
      if (startMs == null || endMs == null || peakMs == null) return [];
      return [{
        id: `${record.id}:pressure:${index + 1}`,
        startMs,
        endMs,
        peakMs,
        priority: 2,
        // detectDamageWindows ya exige >=2.5× la línea base propia.
        critical: true,
        mechanicId: finite(window.mechanicId),
      }];
    });
    const deathCause = record.death_cause;
    const deathTimeMs =
      record.died &&
      !record.wipe_call_cluster &&
      deathCause?.['statisticalExclusionReason'] !== 'boss_melee_on_non_tank'
        ? finite(deathCause?.['timeMs'])
        : null;
    const lethalWindowStartMs = Array.isArray(deathCause?.['damageWindowEvents'])
      ? (deathCause!['damageWindowEvents'] as Record<string, unknown>[])
          .map((event) => finite(event['time_ms']))
          .filter((timeMs): timeMs is number => timeMs != null && deathTimeMs != null && timeMs < deathTimeMs)
          .sort((left, right) => left - right)[0] ?? null
      : null;
    return evaluateDefensiveExecution({
      playerKey,
      playerName: record.player_name,
      mode: binding.mode_at_pull,
      planVersionId: binding.plan_version_id,
      gameBuild: record.game_build,
      buildFingerprint: record.talent_build_fingerprint,
      resolverVersion: member?.resolver_version ?? record.defensive_resolution_version ?? record.defensive_resolution_shadow?.resolverVersion ?? 'unknown',
      solverVersion: plan?.solver_version ?? 'no-plan@2',
      solverStrictScoringEligible: Boolean(
        plan && plan.planning_quality === 'optimal' && !plan.fallback_used && plan.diagnostics?.['strictScoringEligible'] !== false,
      ),
      dataConfidence: kit.length ? confidence : 'uncertain',
      kit,
      slots,
      casts: observedCasts(record, playerKey, playerKeyByName),
      windows,
      deathTimeMs,
      lethalWindowStartMs,
      evaluationCutoffMs,
    });
  });

  if (results.length) {
    const evaluatedAt = new Date().toISOString();
    const { error } = await supabase.from('player_pull_defensive_evaluations').upsert(
      results.map((result) => ({
        pull_id: pullId,
        player_name: result.playerName,
        plan_version_id: result.planVersionId,
        mode: result.mode,
        game_build: result.gameBuild,
        build_fingerprint: result.buildFingerprint,
        resolver_version: result.resolverVersion,
        solver_version: result.solverVersion,
        evaluator_version: result.evaluatorVersion,
        plan_required_count: result.planRequiredCount,
        plan_executed_count: result.planExecutedCount,
        required_exact_adherence_count: result.requiredExactAdherenceCount,
        required_coverage_success_count: result.requiredCoverageSuccessCount,
        critical_window_count: result.criticalWindowCount,
        critical_covered_count: result.criticalCoveredCount,
        correct_hold_count: result.correctHoldCount,
        broken_reservation_count: result.brokenReservationCount,
        reminder_missed_count: result.reminderMissedCount,
        viable_extra_count: result.viableExtraCount,
        extra_used_count: result.extraUsedCount,
        death_viable_cd_count: result.deathViableCdCount,
        management_score: result.managementScore,
        data_confidence: result.dataConfidence,
        events: result.events,
        evaluated_at: evaluatedAt,
      })),
      { onConflict: 'pull_id,player_name' },
    );
    if (error) throw error;
  }
  return results;
}
