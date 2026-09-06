import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  getFightEvents,
  getReportAbilities,
  getReportActors,
  getReportFights,
  type WclActor,
} from '../_shared/wcl-client.ts';
import { buildAbilityIdsByName, normalizeAbilityName } from '../_shared/ability-name-match.ts';
import {
  buildMechanicEventRows,
  type MechanicHitTargets,
  type MechanicPlayerHitDetail,
} from '../_shared/mechanic-event-materialization.ts';
import {
  summarizeMechanicEventReplay,
  type ReplayMechanicEventRow,
} from '../_shared/mechanic-event-replay-diff.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

interface DeathEvent {
  timestamp?: number;
  targetID?: number;
  killingAbilityGameID?: number;
}

interface DamageEvent {
  timestamp?: number;
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
  amount?: number;
  maxHitPoints?: number;
  resources?: { maxHitPoints?: number } | null;
}

interface CastEvent {
  timestamp?: number;
  abilityGameID?: number;
  sourceID?: number;
  targetID?: number;
}

interface InterruptEvent {
  timestamp?: number;
  extraAbilityGameID?: number;
  sourceID?: number;
}

interface HealingEvent {
  timestamp?: number;
  targetID?: number;
  amount?: number;
}

interface MechanicRow {
  ability_id: number;
  name: string;
  description: string | null;
  category: string | null;
  responsibility: string | null;
  inferred_category: string | null;
  observed_as_interrupt: boolean;
  avoidable: boolean | null;
  severity_threshold: number | null;
  reference_hit_ratio_samples: number[] | null;
}

interface StoredDefensiveCast {
  spellId?: number;
  timestampsMs?: unknown[];
}

interface PlayerPullRecordLite {
  player_name: string;
  defensive_casts: StoredDefensiveCast[] | null;
}

const MECHANIC_REACTION_WINDOW_MS = 4_000;
const RESPONSE_WINDOW_MS = 10_000;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  let body: { pullId?: string; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }

  if (!body.pullId) {
    return jsonResponse({ ok: false, error: 'pullId es obligatorio' }, 400);
  }
  const dryRun = body.dryRun !== false;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { data: pull, error: pullError } = await supabase
      .from('pulls')
      .select('id,report_code,fight_id,boss_id,difficulty')
      .eq('id', body.pullId)
      .maybeSingle();
    if (pullError) throw pullError;
    if (!pull) return jsonResponse({ ok: false, error: `Pull ${body.pullId} no encontrado` }, 404);

    const reportDetail = await getReportFights(pull.report_code);
    const fight = reportDetail.fights.find((candidate) => candidate.id === pull.fight_id);
    if (!fight) {
      return jsonResponse(
        { ok: false, error: `Fight ${pull.fight_id} no encontrado en ${pull.report_code}` },
        404,
      );
    }

    const [actors, abilities, mechanicsResult, ownRatioResult, playerRecordsResult, beforeResult] =
      await Promise.all([
        getReportActors(pull.report_code),
        getReportAbilities(pull.report_code),
        supabase
          .from('applicable_boss_mechanics_candidates')
          .select(
            'ability_id,name,description,category,responsibility,inferred_category,observed_as_interrupt,avoidable,severity_threshold,reference_hit_ratio_samples',
          )
          .eq('boss_id', pull.boss_id)
          .eq('difficulty', pull.difficulty)
          .returns<MechanicRow[]>(),
        supabase
          .from('own_mechanic_hit_ratios')
          .select('ability_id,hit_ratio')
          .eq('boss_id', pull.boss_id)
          .eq('difficulty', pull.difficulty)
          .returns<{ ability_id: number; hit_ratio: number }[]>(),
        supabase
          .from('player_pull_records')
          .select('player_name,defensive_casts')
          .eq('pull_id', pull.id)
          .returns<PlayerPullRecordLite[]>(),
        supabase
          .from('pull_mechanic_events')
          .select(
            'ability_id,mechanic_name,description,category,responsibility,trigger_time_ms,outcome,players_hit,players_hit_names,avoidable,player_hit_details,phase_id,comparison_source,comparison_percentile',
          )
          .eq('pull_id', pull.id)
          .order('trigger_time_ms', { ascending: true }),
      ]);

    if (mechanicsResult.error) throw mechanicsResult.error;
    if (ownRatioResult.error) throw ownRatioResult.error;
    if (playerRecordsResult.error) throw playerRecordsResult.error;
    if (beforeResult.error) throw beforeResult.error;

    const mechanics = mechanicsResult.data ?? [];
    if (!mechanics.length) {
      return jsonResponse({
        ok: true,
        pullId: pull.id,
        dryRun,
        skipped: true,
        reason: `Sin mecánicas aplicables para boss ${pull.boss_id} (${pull.difficulty})`,
      });
    }

    const actorById = new Map<number, WclActor>(actors.map((actor) => [actor.id, actor]));
    const realIdsByName = buildAbilityIdsByName(abilities);
    const mechanicById = new Map<number, MechanicRow>();
    for (const mechanic of mechanics) {
      if (!mechanicById.has(mechanic.ability_id)) mechanicById.set(mechanic.ability_id, mechanic);
      for (const realId of realIdsByName.get(normalizeAbilityName(mechanic.name)) ?? []) {
        if (!mechanicById.has(realId)) mechanicById.set(realId, mechanic);
      }
    }

    const ownHistoryRatiosByAbilityId = new Map<number, number[]>();
    for (const row of ownRatioResult.data ?? []) {
      const current = ownHistoryRatiosByAbilityId.get(row.ability_id) ?? [];
      current.push(row.hit_ratio);
      ownHistoryRatiosByAbilityId.set(row.ability_id, current);
    }

    const [deathEvents, damageEvents, enemyCastEvents, interruptEvents, healingEvents] =
      await Promise.all([
        getFightEvents({
          code: pull.report_code,
          fightId: fight.id,
          dataType: 'Deaths',
          startTime: fight.startTime,
          endTime: fight.endTime,
        }),
        getFightEvents({
          code: pull.report_code,
          fightId: fight.id,
          dataType: 'DamageTaken',
          startTime: fight.startTime,
          endTime: fight.endTime,
          includeResources: true,
        }),
        getFightEvents({
          code: pull.report_code,
          fightId: fight.id,
          dataType: 'Casts',
          startTime: fight.startTime,
          endTime: fight.endTime,
          hostilityType: 'Enemies',
        }),
        getFightEvents({
          code: pull.report_code,
          fightId: fight.id,
          dataType: 'Interrupts',
          startTime: fight.startTime,
          endTime: fight.endTime,
        }),
        getFightEvents({
          code: pull.report_code,
          fightId: fight.id,
          dataType: 'Healing',
          startTime: fight.startTime,
          endTime: fight.endTime,
        }),
      ]);

    const healingEventsByTarget = new Map<number, { timestamp: number; amount: number }[]>();
    for (const raw of healingEvents as HealingEvent[]) {
      if (!finiteNumber(raw.targetID) || !finiteNumber(raw.timestamp)) continue;
      const current = healingEventsByTarget.get(raw.targetID) ?? [];
      current.push({ timestamp: raw.timestamp, amount: finiteNumber(raw.amount) ? raw.amount : 0 });
      healingEventsByTarget.set(raw.targetID, current);
    }

    const playerRecordByName = new Map(
      (playerRecordsResult.data ?? []).map((record) => [record.player_name, record] as const),
    );

    function buildPlayerHitDetails(
      hitTargets: MechanicHitTargets,
      t0: number,
      windowEnd: number,
    ): MechanicPlayerHitDetail[] {
      const out: MechanicPlayerHitDetail[] = [];
      for (const [targetId, damage] of hitTargets) {
        const playerName = actorById.get(targetId)?.name;
        if (!playerName) continue;

        const healingReceived = (healingEventsByTarget.get(targetId) ?? [])
          .filter((event) => event.timestamp >= t0 && event.timestamp <= windowEnd)
          .reduce((sum, event) => sum + event.amount, 0);

        // Replay deliberately reuses the defensive set already persisted for
        // this historical player-pull instead of re-resolving today's class/
        // talent catalog. That keeps replay focused on mechanic facts and
        // avoids mutating defensive semantics while still reproducing the
        // original used_defensive_spell_id contract.
        let usedDefensiveSpellId: number | null = null;
        const defensiveCasts = playerRecordByName.get(playerName)?.defensive_casts ?? [];
        for (const cast of defensiveCasts) {
          if (!finiteNumber(cast.spellId) || !Array.isArray(cast.timestampsMs)) continue;
          const usedInWindow = cast.timestampsMs.some((offset) => {
            if (!finiteNumber(offset)) return false;
            const absoluteTimestamp = fight.startTime + offset;
            return absoluteTimestamp >= t0 - RESPONSE_WINDOW_MS && absoluteTimestamp <= windowEnd;
          });
          if (usedInWindow) {
            usedDefensiveSpellId = cast.spellId;
            break;
          }
        }

        out.push({
          name: playerName,
          damage_taken: damage.total,
          damage_hits: damage.hits,
          healing_received: healingReceived,
          used_defensive_spell_id: usedDefensiveSpellId,
          max_hit_points: damage.maxHitPoints,
        });
      }
      return out;
    }

    function resolvePhaseId(timestampAbsolute: number): number | null {
      const transitions = fight.phaseTransitions;
      if (!transitions?.length) return null;
      let current: number | null = null;
      for (const transition of transitions) {
        if (transition.startTime <= timestampAbsolute) current = transition.id;
        else break;
      }
      return current;
    }

    const nextRows = buildMechanicEventRows({
      mechanicByAbilityId: mechanicById,
      enemyCastEvents: enemyCastEvents as CastEvent[],
      damageEvents: damageEvents as DamageEvent[],
      deathEvents: deathEvents as DeathEvent[],
      interruptEvents: interruptEvents as InterruptEvent[],
      raidSize: fight.friendlyPlayers.length || 1,
      ownHistoryRatiosByAbilityId,
      reactionWindowMs: MECHANIC_REACTION_WINDOW_MS,
      fightStartTime: fight.startTime,
      resolvePlayerName: (actorId) => actorById.get(actorId)?.name ?? null,
      buildPlayerHitDetails,
      resolvePhaseId,
    });

    const beforeRows = (beforeResult.data ?? []) as ReplayMechanicEventRow[];
    const summary = summarizeMechanicEventReplay(beforeRows, nextRows);

    if (dryRun) {
      return jsonResponse({
        ok: true,
        dryRun: true,
        pullId: pull.id,
        reportCode: pull.report_code,
        fightId: pull.fight_id,
        bossId: pull.boss_id,
        difficulty: pull.difficulty,
        summary,
      });
    }

    const { data: replaceResult, error: replaceError } = await supabase.rpc(
      'replace_pull_mechanic_events',
      {
        p_pull_id: pull.id,
        p_rows: nextRows,
      },
    );
    if (replaceError) throw replaceError;

    return jsonResponse({
      ok: true,
      dryRun: false,
      pullId: pull.id,
      reportCode: pull.report_code,
      fightId: pull.fight_id,
      bossId: pull.boss_id,
      difficulty: pull.difficulty,
      summary,
      replaceResult,
      next: ['evaluate-mechanic-occurrences', 'evaluate-mechanic-attribution-shadow'],
    });
  } catch (error) {
    console.error('reanalyze-mechanic-events error:', error);
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});
