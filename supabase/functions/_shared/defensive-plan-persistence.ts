import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { CreateDraftRequest } from './defensive-plan-contract.ts';

export async function persistDefensivePlanDraft(
  supabase: SupabaseClient,
  body: CreateDraftRequest,
  createdBy: string,
): Promise<Record<string, unknown>> {
  const { data: plan, error: planError } = await supabase
    .from('defensive_plan_versions')
    .insert({
      boss_id: body.bossId.trim(),
      difficulty: body.difficulty.trim(),
      name: body.name.trim(),
      plan_mode: body.planMode,
      planning_quality: body.planningQuality,
      game_build: body.gameBuild ?? null,
      solver_version: body.solverVersion,
      resolver_version: body.resolverVersion,
      backend_resolved: body.backendResolved ?? false,
      roster_fingerprint: body.rosterFingerprint ?? null,
      source_profile_revision: body.sourceProfileRevision ?? null,
      source_catalog_revision: body.sourceCatalogRevision ?? null,
      supersedes_id: body.supersedesId ?? null,
      uncertainty_margin_ms: body.uncertaintyMarginMs ?? 0,
      fallback_used: body.fallbackUsed ?? false,
      roster_snapshot_at: body.rosterSnapshotAt,
      diagnostics: body.diagnostics ?? {},
      notes: body.notes ?? null,
      created_by: createdBy,
    })
    .select('*')
    .single();
  if (planError) throw planError;

  try {
    if (body.members.length) {
      const { error } = await supabase.from('defensive_plan_members').insert(
        body.members.map((member) => ({
          plan_version_id: plan.id,
          player_key: member.playerKey,
          character_id: member.characterId ?? null,
          player_name: member.playerName,
          class: member.class,
          spec: member.spec ?? null,
          role: member.role ?? null,
          raid_group: member.raidGroup ?? null,
          build_fingerprint: member.buildFingerprint ?? null,
          game_build: member.gameBuild ?? null,
          build_observed_at: member.buildObservedAt ?? null,
          build_confidence: member.buildConfidence,
          included: member.included ?? true,
          resolver_version: member.resolverVersion,
          effective_kit: member.effectiveKit,
          provenance: member.provenance ?? {},
        })),
      );
      if (error) throw error;
    }
    if (body.slots.length) {
      const { error } = await supabase.from('defensive_plan_slots').insert(
        body.slots.map((slot) => ({
          plan_version_id: plan.id,
          ability_id: slot.abilityId,
          occurrence_index: slot.occurrenceIndex,
          slot_index: slot.slotIndex ?? 1,
          occurrence_time_ms: slot.occurrenceTimeMs,
          window_start_ms: slot.windowStartMs,
          window_end_ms: slot.windowEndMs,
          priority: slot.priority ?? null,
          requirement_level: slot.requirementLevel,
          demand_type: slot.demandType,
          coverage_status: slot.coverageStatus,
          assigned_player_key: slot.assignedPlayerKey ?? null,
          target_player_key: slot.targetPlayerKey ?? null,
          defensive_spell_id: slot.defensiveSpellId ?? null,
          planned_cast_at_ms: slot.plannedCastAtMs ?? null,
          prewarn_ms: slot.prewarnMs ?? 5000,
          source: slot.source,
          locked: slot.locked ?? false,
          emergency_reserved: slot.emergencyReserved ?? false,
          confidence: slot.confidence,
          trigger_mode: slot.triggerMode ?? 'time',
          bossmod_spell_id: slot.bossmodSpellId ?? null,
          bossmod_counter: slot.bossmodCounter ?? null,
          bossmod_counter_verified: slot.bossmodCounterVerified ?? false,
          assigned_groups: slot.assignedGroups?.length ? slot.assignedGroups : null,
          effective_cooldown_ms_snapshot: slot.effectiveCooldownMsSnapshot ?? null,
          effective_duration_ms_snapshot: slot.effectiveDurationMsSnapshot ?? null,
          charges_snapshot: slot.chargesSnapshot ?? null,
          build_fingerprint_snapshot: slot.buildFingerprintSnapshot ?? null,
          notes: slot.notes ?? null,
          rationale: slot.rationale ?? {},
        })),
      );
      if (error) throw error;
    }
  } catch (error) {
    const { error: cleanupError } = await supabase.from('defensive_plan_versions').delete().eq('id', plan.id).eq('status', 'draft');
    if (cleanupError) console.error('No se pudo limpiar el draft incompleto:', cleanupError);
    throw error;
  }

  return plan as Record<string, unknown>;
}
