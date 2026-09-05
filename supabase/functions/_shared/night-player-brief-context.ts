import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { isDeathExcludedFromStatistics, isMechanicExcludedByWipeCall } from './statistical-exclusions.ts';
import { isPunitivePersonalMechanicEvent } from './mechanic-attribution.ts';

// §"meter en el dosier de un jugador... la consulta de IA... teniendo en
// cuenta el dossier y ese jugador concreto" (feedback real, 2026-08-24).
// Mismo espíritu que pull-brief-context.ts: se manda al LLM la MISMA
// información que ya ve el RL en pantalla (night-player-summary.service.ts,
// versión Angular) — aquí reconstruida en Deno con consultas propias porque
// los dos runtimes no comparten módulos. Cruce por NOMBRE de mecánica, no
// por ability_id (mismo motivo de siempre: el id del manifiesto casi nunca
// coincide con el real de WCL).

export interface NightPlayerBriefDeath {
  bossName: string;
  pullNumber: number;
  timeLabel: string;
  mechanic: string;
  category: string | null;
  rootCause: string;
  oneshot: boolean | null;
  burstHealthPct: number | null;
  hadDefensiveAvailableUnused: boolean;
  usedEmergencyConsumableInPull: boolean;
}

export interface NightPlayerBriefMechanicFail {
  bossName: string;
  mechanic: string;
  category: string | null;
  outcome: string;
}

export interface NightPlayerBriefRepeatedPattern {
  mechanic: string;
  instanceCount: number;
  distinctBossCount: number;
}

export interface NightPlayerBriefContext {
  playerName: string;
  pulls: { bossName: string; pullNumber: number; kill: boolean; wipePct: number | null }[];
  totalDeaths: number;
  totalMechanicFails: number;
  deaths: NightPlayerBriefDeath[];
  mechanicFails: NightPlayerBriefMechanicFail[];
  repeatedPatterns: NightPlayerBriefRepeatedPattern[];
  gear: { class: string | null; spec: string | null; enchantedSlotCount: number; enchantableSlotCount: number; gemmedSlotCount: number; gemmableSlotCount: number; gemCount: number } | null;
  /** Tallies crudos de player_pull_reliability_inputs para ESTA noche — no la fórmula de fiabilidad completa (eso vive en reliability.service.ts, solo en Angular), pero da al LLM una señal real sin duplicar esa lógica de puntuación en Deno. */
  reliabilitySignal: {
    pullsWithAvoidableDamage: number;
    pullsWithDefensiveUsedOnDeath: number;
    pullsWithDefensiveUsedInPull: number;
    defensiveUseOpportunities: number;
    totalPullsEvaluated: number;
  } | null;
}

function formatTimeLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// §"los que sean unknown ability pon: unknown cause - WC" (feedback real,
// 2026-08-24) — mismo texto que shared/format.util.ts (Angular) y
// pull-brief-context.ts (Deno), duplicado por runtime distinto.
function mechanicDisplayName(name: string | null): string {
  if (!name) return 'Sin identificar';
  if (name === 'Unknown Ability') return 'Causa desconocida (posible wipe call / entorno)';
  return name;
}

export async function buildNightPlayerBriefContext(
  supabase: SupabaseClient,
  reportCode: string,
  playerName: string,
): Promise<NightPlayerBriefContext | null> {
  const { data: pullsData } = await supabase.from('pulls').select('*').eq('report_code', reportCode).order('pull_number', { ascending: true });
  const pulls = (pullsData ?? []) as { id: string; fight_id: number; boss_id: string; pull_number: number; wipe_pct: number | null; closed_at: string; wipe_call_excluded: boolean; wipe_call_signals: Record<string, unknown> | null }[];
  if (!pulls.length) return null;
  const pullIds = pulls.map((p) => p.id);

  const { data: encounters } = await supabase.from('report_encounters').select('fight_id, boss_name').eq('report_code', reportCode);
  const bossNameByFightId = new Map(((encounters ?? []) as { fight_id: number; boss_name: string }[]).map((e) => [e.fight_id, e.boss_name]));

  const [{ data: recordsData }, { data: mechEventsData }, { data: reliabilityRows }] = await Promise.all([
    supabase.from('player_pull_records').select('*').in('pull_id', pullIds).eq('player_name', playerName),
    supabase
      .from('applicable_pull_mechanic_events')
      .select('pull_id, ability_id, mechanic_name, category, responsibility, outcome, trigger_time_ms')
      .in('pull_id', pullIds)
      .neq('outcome', 'clean')
      .contains('players_hit_names', [playerName]),
    supabase.from('player_pull_reliability_inputs').select('had_avoidable_damage, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity').in('pull_id', pullIds).eq('player_name', playerName),
  ]);

  type RecordRow = {
    pull_id: string;
    died: boolean;
    death_cause: { mechanicId: number; mechanicName: string | null; category: string | null; rootCause: string; timeMs: number; damageProfile?: 'burst' | 'sustained' | 'unknown'; burstHealthPct?: number | null; defensiveOptions?: { status: string }[]; statisticalExclusionReason?: string | null } | null;
    wipe_call_cluster: boolean;
    consumables?: { healthstone?: { used?: boolean; timestampsMs: number[] }; healthPotion?: { used?: boolean; timestampsMs: number[] } };
    class: string | null;
    spec: string | null;
    equipped_items?: ({ id: number; permanentEnchant?: number; gems?: unknown[] } | null)[];
  };
  const records = (recordsData ?? []) as RecordRow[];
  const recordByPullId = new Map(records.map((r) => [r.pull_id, r]));
  const pullById = new Map(pulls.map((p) => [p.id, p]));

  const pullsForPlayer = pulls.filter((p) => recordByPullId.has(p.id));
  if (!pullsForPlayer.length) return null;

  const pullSummaries = pullsForPlayer.map((p) => ({
    bossName: bossNameByFightId.get(p.fight_id) ?? `Boss ${p.boss_id}`,
    pullNumber: p.pull_number,
    kill: p.wipe_pct === 0,
    wipePct: p.wipe_pct,
  }));

  const ENCHANTABLE_SLOT_INDICES = new Set([0, 2, 4, 6, 7, 10, 11]);
  const GEMMABLE_SLOT_INDICES = new Set([1, 10, 11]);

  const evaluatedDeathRecords = records.filter((record) => {
    const pull = pullById.get(record.pull_id);
    return record.died && record.death_cause && pull != null && !isDeathExcludedFromStatistics(pull, record);
  });
  const deaths: NightPlayerBriefDeath[] = evaluatedDeathRecords
    .map((r) => {
      const pull = pullById.get(r.pull_id)!;
      const dc = r.death_cause!;
      const hadDefensiveAvailableUnused = (dc.defensiveOptions ?? []).some((o) => o.status === 'available_unused');
      const usedHealthstone = r.consumables?.healthstone?.used === true || (r.consumables?.healthstone?.timestampsMs?.length ?? 0) > 0;
      const usedPotion = r.consumables?.healthPotion?.used === true || (r.consumables?.healthPotion?.timestampsMs?.length ?? 0) > 0;
      return {
        bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
        pullNumber: pull.pull_number,
        timeLabel: formatTimeLabel(dc.timeMs),
        mechanic: dc.mechanicName ? mechanicDisplayName(dc.mechanicName) : `Hechizo #${dc.mechanicId} (sin clasificar)`,
        category: dc.category ?? null,
        rootCause: dc.rootCause,
        oneshot: dc.damageProfile === 'unknown' || dc.damageProfile == null ? null : dc.damageProfile === 'burst',
        burstHealthPct: dc.burstHealthPct ?? null,
        hadDefensiveAvailableUnused,
        usedEmergencyConsumableInPull: usedHealthstone || usedPotion,
      };
    })
    .sort((a, b) => a.pullNumber - b.pullNumber);

  type BriefMechanicEvent = {
    pull_id: string;
    ability_id: number;
    mechanic_name: string;
    category: string | null;
    responsibility: string | null;
    outcome: string;
    trigger_time_ms: number;
  };
  const mechEvents = ((mechEventsData ?? []) as BriefMechanicEvent[]).filter((event) => {
    const pull = pullById.get(event.pull_id);
    return pull != null && !isMechanicExcludedByWipeCall(pull, event.trigger_time_ms);
  });
  const mechanicFails: NightPlayerBriefMechanicFail[] = mechEvents
    .filter((ev) => isPunitivePersonalMechanicEvent(ev))
    .filter((event) => !evaluatedDeathRecords.some((record) => record.pull_id === event.pull_id && record.death_cause!.mechanicId === event.ability_id && Math.abs(record.death_cause!.timeMs - event.trigger_time_ms) <= 4000))
    .map((ev) => {
      const pull = pullById.get(ev.pull_id)!;
      return { bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`, mechanic: ev.mechanic_name, category: ev.category, outcome: ev.outcome };
    })
    .slice(0, 20);

  const byMechanic = new Map<string, { bosses: Set<string>; count: number }>();
  for (const d of deaths) {
    if (!byMechanic.has(d.mechanic)) byMechanic.set(d.mechanic, { bosses: new Set(), count: 0 });
    const e = byMechanic.get(d.mechanic)!;
    e.bosses.add(d.bossName);
    e.count++;
  }
  for (const f of mechanicFails) {
    if (!byMechanic.has(f.mechanic)) byMechanic.set(f.mechanic, { bosses: new Set(), count: 0 });
    const e = byMechanic.get(f.mechanic)!;
    e.bosses.add(f.bossName);
    e.count++;
  }
  const repeatedPatterns: NightPlayerBriefRepeatedPattern[] = [...byMechanic.entries()]
    .map(([mechanic, e]) => ({ mechanic, instanceCount: e.count, distinctBossCount: e.bosses.size }))
    .filter((p) => p.instanceCount >= 2)
    .sort((a, b) => b.instanceCount - a.instanceCount);

  const lastPull = [...pullsForPlayer].sort((a, b) => b.closed_at.localeCompare(a.closed_at))[0] ?? null;
  const lastRecord = lastPull ? recordByPullId.get(lastPull.id) : null;
  let gear: NightPlayerBriefContext['gear'] = null;
  if (lastRecord) {
    const items = (lastRecord.equipped_items ?? []) as ({ id: number; permanentEnchant?: number; gems?: unknown[] } | null)[];
    let enchantedSlotCount = 0;
    let enchantableSlotCount = 0;
    let gemmedSlotCount = 0;
    let gemmableSlotCount = 0;
    let gemCount = 0;
    items.forEach((item, index) => {
      if (!item || !item.id) return;
      gemCount += (item.gems ?? []).length;
      if (ENCHANTABLE_SLOT_INDICES.has(index)) {
        enchantableSlotCount++;
        if (item.permanentEnchant != null && item.permanentEnchant > 0) enchantedSlotCount++;
      }
      if (GEMMABLE_SLOT_INDICES.has(index)) {
        gemmableSlotCount++;
        if ((item.gems ?? []).length > 0) gemmedSlotCount++;
      }
    });
    gear = { class: lastRecord.class, spec: lastRecord.spec, enchantedSlotCount, enchantableSlotCount, gemmedSlotCount, gemmableSlotCount, gemCount };
  }

  const reliabilityInputRows = (reliabilityRows ?? []) as {
    had_avoidable_damage: boolean;
    used_defensive_when_died: boolean | null;
    used_defensive_in_pull: boolean;
    defensive_use_opportunity: boolean;
  }[];
  const reliabilitySignal = reliabilityInputRows.length
    ? {
        pullsWithAvoidableDamage: reliabilityInputRows.filter((r) => r.had_avoidable_damage).length,
        pullsWithDefensiveUsedOnDeath: reliabilityInputRows.filter((r) => r.used_defensive_when_died === true).length,
        pullsWithDefensiveUsedInPull: reliabilityInputRows.filter((r) => r.used_defensive_in_pull).length,
        defensiveUseOpportunities: reliabilityInputRows.filter((r) => r.defensive_use_opportunity).length,
        totalPullsEvaluated: reliabilityInputRows.length,
      }
    : null;

  return {
    playerName,
    pulls: pullSummaries,
    totalDeaths: deaths.length,
    totalMechanicFails: mechanicFails.length,
    deaths,
    mechanicFails,
    repeatedPatterns,
    gear,
    reliabilitySignal,
  };
}
