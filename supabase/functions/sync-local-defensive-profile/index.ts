import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import {
  calculateLocalDefensiveMetrics,
  finiteNumber,
  positiveAbilityId,
  rankLocalDefensivePriorities,
} from '../_shared/local-defensive-profile.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

interface SyncRequest {
  bossId?: string;
  difficulty?: string;
}

interface PullMeta {
  id: string;
  closed_at: string;
  wipe_call_excluded: boolean;
  wipe_call_signals: Record<string, unknown> | null;
}

interface HitDetail {
  name?: string;
  damage_taken?: number;
  used_defensive_spell_id?: number | null;
  max_hit_points?: number | null;
}

interface LocalAccumulator {
  abilityId: number;
  pullIds: Set<string>;
  damageSamples: number[];
  unmitigatedEstimateSamples: number[];
  maxHealthPctSamples: number[];
  playerHitCountSamples: number[];
  deathCount: number;
  nearDeathCount: number;
  pressureWindowCount: number;
  lastObservedAt: string | null;
  raidImpactScore: number | null;
  individualLethalityScore: number | null;
  priority: number | null;
}

const PAGE_SIZE = 1000;
const PULL_CHUNK_SIZE = 100;

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function cutoffMs(pull: PullMeta): number | null {
  if (!pull.wipe_call_excluded) return null;
  const value = pull.wipe_call_signals?.['wipeCallStartMs'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function accumulator(byAbility: Map<number, LocalAccumulator>, abilityId: number): LocalAccumulator {
  let current = byAbility.get(abilityId);
  if (!current) {
    current = {
      abilityId,
      pullIds: new Set(),
      damageSamples: [],
      unmitigatedEstimateSamples: [],
      maxHealthPctSamples: [],
      playerHitCountSamples: [],
      deathCount: 0,
      nearDeathCount: 0,
      pressureWindowCount: 0,
      lastObservedAt: null,
      raidImpactScore: null,
      individualLethalityScore: null,
      priority: null,
    };
    byAbility.set(abilityId, current);
  }
  return current;
}

function observePull(target: LocalAccumulator, pull: PullMeta): void {
  target.pullIds.add(pull.id);
  if (!target.lastObservedAt || pull.closed_at > target.lastObservedAt) target.lastObservedAt = pull.closed_at;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: SyncRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.bossId || !body.difficulty) {
    return jsonResponse({ ok: false, error: 'bossId y difficulty son obligatorios' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const pulls: PullMeta[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('pulls')
        .select('id,closed_at,wipe_call_excluded,wipe_call_signals')
        .eq('boss_id', body.bossId)
        .eq('difficulty', body.difficulty)
        .eq('ninja_pull_excluded', false)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      pulls.push(...((data ?? []) as PullMeta[]));
      if ((data?.length ?? 0) < PAGE_SIZE) break;
    }

    const pullById = new Map(pulls.map((pull) => [pull.id, pull]));
    const events: Record<string, unknown>[] = [];
    const records: Record<string, unknown>[] = [];
    for (const pullChunk of chunks(pulls.map((pull) => pull.id), PULL_CHUNK_SIZE)) {
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from('pull_mechanic_events')
          .select('id,pull_id,ability_id,trigger_time_ms,players_hit,player_hit_details')
          .in('pull_id', pullChunk)
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        events.push(...(data ?? []));
        if ((data?.length ?? 0) < PAGE_SIZE) break;
      }
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from('player_pull_records')
          .select('id,pull_id,died,wipe_call_cluster,death_cause,defensive_pressure_windows_v2')
          .in('pull_id', pullChunk)
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        records.push(...(data ?? []));
        if ((data?.length ?? 0) < PAGE_SIZE) break;
      }
    }

    const byAbility = new Map<number, LocalAccumulator>();
    for (const raw of events) {
      const pull = pullById.get(raw['pull_id'] as string);
      const abilityId = positiveAbilityId(raw['ability_id']);
      const triggerTimeMs = finiteNumber(raw['trigger_time_ms']);
      if (!pull || abilityId == null || triggerTimeMs == null || triggerTimeMs < 0) continue;
      const cutoff = cutoffMs(pull);
      if (cutoff != null && triggerTimeMs >= cutoff) continue;
      const target = accumulator(byAbility, abilityId);
      observePull(target, pull);
      const playersHit = finiteNumber(raw['players_hit']);
      if (playersHit != null && playersHit >= 0) target.playerHitCountSamples.push(playersHit);
      for (const detail of (Array.isArray(raw['player_hit_details']) ? raw['player_hit_details'] : []) as HitDetail[]) {
        const damage = finiteNumber(detail.damage_taken);
        if (damage == null || damage <= 0) continue;
        target.damageSamples.push(damage);
        if (detail.used_defensive_spell_id == null) target.unmitigatedEstimateSamples.push(damage);
        const maxHealth = finiteNumber(detail.max_hit_points);
        if (maxHealth != null && maxHealth > 0) {
          const healthPct = (damage / maxHealth) * 100;
          target.maxHealthPctSamples.push(healthPct);
          if (healthPct >= 80) target.nearDeathCount++;
        }
      }
    }

    for (const raw of records) {
      const pull = pullById.get(raw['pull_id'] as string);
      if (!pull) continue;
      const deathCause = raw['death_cause'] as Record<string, unknown> | null;
      const excludedDeath =
        (raw['wipe_call_cluster'] === true && pull.wipe_call_excluded) ||
        deathCause?.['statisticalExclusionReason'] === 'boss_melee_on_non_tank';
      const deathAbilityId = positiveAbilityId(deathCause?.['mechanicId']);
      const deathTimeMs = finiteNumber(deathCause?.['timeMs']);
      const cutoff = cutoffMs(pull);
      if (
        raw['died'] === true &&
        !excludedDeath &&
        deathAbilityId != null &&
        (cutoff == null || deathTimeMs == null || deathTimeMs < cutoff)
      ) {
        const target = accumulator(byAbility, deathAbilityId);
        target.deathCount++;
        observePull(target, pull);
      }

      const pressure = raw['defensive_pressure_windows_v2'] as { windows?: Record<string, unknown>[] } | null;
      for (const window of pressure?.windows ?? []) {
        const abilityId = positiveAbilityId(window['mechanicId']);
        const startMs = finiteNumber(window['startMs']);
        if (abilityId == null || (cutoff != null && startMs != null && startMs >= cutoff)) continue;
        const target = accumulator(byAbility, abilityId);
        target.pressureWindowCount++;
        observePull(target, pull);
      }
    }

    const profiles = [...byAbility.values()];
    for (const profile of profiles) {
      const metrics = calculateLocalDefensiveMetrics({
        ...profile,
        samplePullCount: profile.pullIds.size,
      });
      profile.raidImpactScore = metrics.raidImpactScore;
      profile.individualLethalityScore = metrics.individualLethalityScore;
    }
    const priorities = rankLocalDefensivePriorities(profiles);
    profiles.forEach((profile) => (profile.priority = priorities.get(profile.abilityId) ?? null));

    const syncRevision = crypto.randomUUID();
    const now = new Date().toISOString();
    if (profiles.length) {
      const { error: upsertError } = await supabase.from('boss_mechanic_defensive_local_profile').upsert(
        profiles.map((profile) => ({
          boss_id: body.bossId,
          difficulty: body.difficulty,
          ability_id: profile.abilityId,
          local_damage_samples: profile.damageSamples,
          local_unmitigated_estimate_samples: profile.unmitigatedEstimateSamples,
          local_max_health_pct_samples: profile.maxHealthPctSamples,
          local_player_hit_count_samples: profile.playerHitCountSamples,
          local_death_count: profile.deathCount,
          local_near_death_count: profile.nearDeathCount,
          local_pressure_window_count: profile.pressureWindowCount,
          local_sample_pull_count: profile.pullIds.size,
          local_raid_impact_score: profile.raidImpactScore,
          local_individual_lethality_score: profile.individualLethalityScore,
          local_priority: profile.priority,
          local_last_observed_at: profile.lastObservedAt,
          sync_revision: syncRevision,
          updated_at: now,
        })),
        { onConflict: 'boss_id,difficulty,ability_id' },
      );
      if (upsertError) throw upsertError;
      const { error: staleDeleteError } = await supabase
        .from('boss_mechanic_defensive_local_profile')
        .delete()
        .eq('boss_id', body.bossId)
        .eq('difficulty', body.difficulty)
        .neq('sync_revision', syncRevision);
      if (staleDeleteError) throw staleDeleteError;
    } else {
      const { error: deleteError } = await supabase
        .from('boss_mechanic_defensive_local_profile')
        .delete()
        .eq('boss_id', body.bossId)
        .eq('difficulty', body.difficulty);
      if (deleteError) throw deleteError;
    }

    return jsonResponse({
      ok: true,
      bossId: body.bossId,
      difficulty: body.difficulty,
      eligiblePulls: pulls.length,
      profilesUpdated: profiles.length,
      syncRevision,
    });
  } catch (err) {
    console.error('sync-local-defensive-profile error:', err);
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
