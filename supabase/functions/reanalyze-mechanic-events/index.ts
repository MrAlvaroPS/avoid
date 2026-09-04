import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  getFightEvents,
  getReportAbilities,
  getReportActors,
  getReportFights,
  type WclActor,
} from '../_shared/wcl-client.ts';
import { buildAbilityIdsByName, normalizeAbilityName } from '../_shared/ability-name-match.ts';
import { defensivesForClass, type CooldownCatalog } from '../_shared/defensive-cooldowns.ts';
import {
  buildMechanicEventRows,
  type MechanicHitTargets,
  type MechanicPlayerHitDetail,
} from '../_shared/mechanic-event-materialization.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

const MECHANIC_REACTION_WINDOW_MS = 4_000;
const RESPONSE_WINDOW_MS = 10_000;

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
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
}

interface HealingEvent {
  timestamp?: number;
  targetID?: number;
  amount?: number;
}

interface InterruptEvent {
  timestamp?: number;
  sourceID?: number;
  extraAbilityGameID?: number;
}

interface PlayerRecord {
  player_name: string;
  class: string | null;
  spec: string | null;
}

class ReanalysisHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: { pullId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.pullId) return jsonResponse({ ok: false, error: 'pullId es obligatorio' }, 400);
  if (!isUuid(body.pullId)) return jsonResponse({ ok: false, error: 'pullId inválido' }, 400);

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
    if (!pull) throw new ReanalysisHttpError(`Pull ${body.pullId} no encontrado`, 404);

    const reportDetail = await getReportFights(pull.report_code);
    const fight = reportDetail.fights.find((candidate) => candidate.id === pull.fight_id);
    if (!fight) {
      throw new ReanalysisHttpError(
        `Fight ${pull.fight_id} no encontrado en el report ${pull.report_code}`,
        404,
      );
    }

    const [actors, abilities, mechanicsResult, ownHistoryResult, playerRecordsResult, catalogResult] =
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
          .select('pull_id,ability_id,hit_ratio')
          .eq('boss_id', pull.boss_id)
          .eq('difficulty', pull.difficulty)
          // analyze-report calcula severidad ANTES de insertar el pull actual.
          // En un backfill, excluir el propio pull evita que sus filas antiguas
          // (precisamente las que estamos reparando) sesguen su nuevo veredicto.
          .neq('pull_id', pull.id)
          .returns<{ pull_id: string; ability_id: number; hit_ratio: number }[]>(),
        supabase
          .from('player_pull_records')
          .select('player_name,class,spec')
          .eq('pull_id', pull.id)
          .returns<PlayerRecord[]>(),
        supabase
          .from('cooldown_catalog')
          .select(
            'class,spec,spec_override,spell_id,name,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,base_cooldown_ms,base_duration_ms,survival_type,excluded',
          )
          .eq('excluded', false),
      ]);

    if (mechanicsResult.error) throw mechanicsResult.error;
    if (ownHistoryResult.error) throw ownHistoryResult.error;
    if (playerRecordsResult.error) throw playerRecordsResult.error;
    if (catalogResult.error) throw catalogResult.error;

    const actorById = new Map<number, WclActor>(actors.map((actor) => [actor.id, actor]));
    const realIdsByName = buildAbilityIdsByName(abilities);
    const mechanicById = new Map<number, MechanicRow>();
    for (const mechanic of mechanicsResult.data ?? []) {
      if (!mechanicById.has(mechanic.ability_id)) mechanicById.set(mechanic.ability_id, mechanic);
      for (const realId of realIdsByName.get(normalizeAbilityName(mechanic.name)) ?? []) {
        if (!mechanicById.has(realId)) mechanicById.set(realId, mechanic);
      }
    }

    const ownHistoryRatiosByAbilityId = new Map<number, number[]>();
    for (const row of ownHistoryResult.data ?? []) {
      const current = ownHistoryRatiosByAbilityId.get(row.ability_id);
      if (current) current.push(row.hit_ratio);
      else ownHistoryRatiosByAbilityId.set(row.ability_id, [row.hit_ratio]);
    }

    const playerRecordByName = new Map(
      (playerRecordsResult.data ?? []).map((row) => [row.player_name.toLocaleLowerCase(), row]),
    );
    const cooldownCatalog: CooldownCatalog = (catalogResult.data ?? []).map((row) => ({
      spellId: row.spell_id,
      name: row.name,
      class: row.class,
      spec: row.spec,
      specOverride: row.spec_override ?? null,
      category: row.category,
      baseCooldownMs: row.base_cooldown_ms,
      durationMs: row.base_duration_ms,
      survivalType: row.survival_type ?? null,
    }));

    const [deathEvents, damageEvents, friendlyCastEvents, enemyCastEvents, healingEvents, interruptEvents] =
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
          hostilityType: 'Friendlies',
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
          dataType: 'Healing',
          startTime: fight.startTime,
          endTime: fight.endTime,
        }),
        getFightEvents({
          code: pull.report_code,
          fightId: fight.id,
          dataType: 'Interrupts',
          startTime: fight.startTime,
          endTime: fight.endTime,
        }),
      ]);

    const healingEventsByTarget = new Map<number, { timestamp: number; amount: number }[]>();
    for (const raw of healingEvents as HealingEvent[]) {
      if (typeof raw.targetID !== 'number' || typeof raw.timestamp !== 'number') continue;
      const list = healingEventsByTarget.get(raw.targetID) ?? [];
      list.push({ timestamp: raw.timestamp, amount: raw.amount ?? 0 });
      healingEventsByTarget.set(raw.targetID, list);
    }

    const defensiveCastTimestampsByActor = new Map<number, Map<number, number[]>>();
    for (const raw of friendlyCastEvents as CastEvent[]) {
      if (
        typeof raw.sourceID !== 'number' ||
        typeof raw.abilityGameID !== 'number' ||
        typeof raw.timestamp !== 'number'
      ) {
        continue;
      }
      const perSpell = defensiveCastTimestampsByActor.get(raw.sourceID) ?? new Map<number, number[]>();
      const timestamps = perSpell.get(raw.abilityGameID) ?? [];
      timestamps.push(raw.timestamp);
      perSpell.set(raw.abilityGameID, timestamps);
      defensiveCastTimestampsByActor.set(raw.sourceID, perSpell);
    }

    function buildPlayerHitDetails(
      hitTargets: MechanicHitTargets,
      t0: number,
      windowEnd: number,
    ): MechanicPlayerHitDetail[] {
      const details: MechanicPlayerHitDetail[] = [];
      for (const [targetId, damage] of hitTargets) {
        const actor = actorById.get(targetId);
        const name = actor?.name;
        if (!name) continue;
        const healingReceived = (healingEventsByTarget.get(targetId) ?? [])
          .filter((event) => event.timestamp >= t0 && event.timestamp <= windowEnd)
          .reduce((sum, event) => sum + event.amount, 0);

        let usedDefensiveSpellId: number | null = null;
        const record = playerRecordByName.get(name.toLocaleLowerCase());
        const className = actor?.subType ?? record?.class ?? null;
        const spec = record?.spec ?? null;
        const castMap = defensiveCastTimestampsByActor.get(targetId);
        if (className && castMap) {
          // Para saber QUÉ defensivo usó no hace falta reconstruir el árbol de
          // talentos: solo aceptamos IDs que realmente aparecen como cast de
          // ese jugador. El filtro clase+spec evita confundir rotación normal.
          const catalogSpellIds = new Set(
            defensivesForClass(className, spec, cooldownCatalog, null).map((cooldown) => cooldown.spellId),
          );
          for (const [spellId, timestamps] of castMap) {
            if (!catalogSpellIds.has(spellId)) continue;
            if (timestamps.some((timestamp) => timestamp >= t0 - RESPONSE_WINDOW_MS && timestamp <= windowEnd)) {
              usedDefensiveSpellId = spellId;
              break;
            }
          }
        }

        details.push({
          name,
          damage_taken: damage.total,
          damage_hits: damage.hits,
          healing_received: healingReceived,
          used_defensive_spell_id: usedDefensiveSpellId,
          max_hit_points: damage.maxHitPoints,
        });
      }
      return details;
    }

    const phaseTransitions = fight.phaseTransitions ?? [];
    function resolvePhaseId(timestampAbsolute: number): number | null {
      if (!phaseTransitions.length) return null;
      let current: number | null = null;
      for (const transition of phaseTransitions) {
        if (transition.startTime <= timestampAbsolute) current = transition.id;
        else break;
      }
      return current;
    }

    const rows = buildMechanicEventRows({
      mechanicByAbilityId: mechanicById,
      enemyCastEvents: enemyCastEvents as CastEvent[],
      damageEvents: damageEvents as DamageEvent[],
      deathEvents: deathEvents as DeathEvent[],
      interruptEvents: interruptEvents as InterruptEvent[],
      raidSize: fight.friendlyPlayers.length || (playerRecordsResult.data ?? []).length || 1,
      ownHistoryRatiosByAbilityId,
      reactionWindowMs: MECHANIC_REACTION_WINDOW_MS,
      fightStartTime: fight.startTime,
      resolvePlayerName: (actorId) => actorById.get(actorId)?.name ?? null,
      buildPlayerHitDetails,
      resolvePhaseId,
    });

    const { count: before, error: countError } = await supabase
      .from('pull_mechanic_events')
      .select('id', { count: 'exact', head: true })
      .eq('pull_id', pull.id);
    if (countError) throw countError;

    // Una única función PL/pgSQL hace DELETE+INSERT+cache-bump dentro de la
    // misma transacción. Si cualquier fila nueva viola un contrato, PostgreSQL
    // hace rollback y las filas antiguas siguen intactas.
    const { data: replacedCount, error: replaceError } = await supabase.rpc(
      'replace_pull_mechanic_events',
      { p_pull_id: pull.id, p_rows: rows },
    );
    if (replaceError) throw replaceError;

    return jsonResponse({
      ok: true,
      pullId: pull.id,
      reportCode: pull.report_code,
      fightId: pull.fight_id,
      before: before ?? 0,
      after: Number(replacedCount ?? rows.length),
    });
  } catch (error) {
    const status = error instanceof ReanalysisHttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    console.error('reanalyze-mechanic-events:', message);
    return jsonResponse({ ok: false, error: message }, status);
  }
});
