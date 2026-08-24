import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// §"meter en el dosier de un jugador... la consulta de IA... teniendo en
// cuenta el dossier y ese jugador concreto" (feedback real, 2026-08-24).
// Mismo espíritu que pull-brief-context.ts: se manda al LLM la MISMA
// información que ya ve el RL en pantalla (night-player-summary.service.ts,
// versión Angular) — aquí reconstruida en Deno con consultas propias porque
// los dos runtimes no comparten módulos. Cruce por NOMBRE de mecánica, no
// por ability_id (mismo motivo de siempre: el id del manifiesto casi nunca
// coincide con el real de WCL).

// Mismo criterio que PERSONAL_RESPONSIBILITY_CATEGORIES de
// pull-analysis.service.ts (Angular) — repetido aquí porque Deno no importa
// ese módulo. Si cambia uno, cambia el otro.
const PERSONAL_RESPONSIBILITY_CATEGORIES = new Set(['avoidable-ground', 'spread', 'soak', 'personal-target']);

const EMERGENCY_CONSUMABLE_LOOKBACK_MS = 15000; // mismo valor que night-player-summary.service.ts

export interface NightPlayerBriefDeath {
  bossName: string;
  pullNumber: number;
  timeLabel: string;
  mechanic: string;
  category: string | null;
  rootCause: string;
  hadDefensiveAvailableUnused: boolean;
  usedEmergencyConsumable: boolean;
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
  gear: { class: string | null; spec: string | null; enchantedSlotCount: number; enchantableSlotCount: number; gemCount: number } | null;
  /** Tallies crudos de player_pull_reliability_inputs para ESTA noche — no la fórmula de fiabilidad completa (eso vive en reliability.service.ts, solo en Angular), pero da al LLM una señal real sin duplicar esa lógica de puntuación en Deno. */
  reliabilitySignal: { pullsWithAvoidableDamage: number; pullsWithDefensiveUsedOnDeath: number; totalPullsEvaluated: number } | null;
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
  const pulls = (pullsData ?? []) as { id: string; fight_id: number; boss_id: string; pull_number: number; wipe_pct: number | null; closed_at: string; wipe_call_excluded: boolean }[];
  if (!pulls.length) return null;
  const pullIds = pulls.map((p) => p.id);

  const { data: encounters } = await supabase.from('report_encounters').select('fight_id, boss_name').eq('report_code', reportCode);
  const bossNameByFightId = new Map(((encounters ?? []) as { fight_id: number; boss_name: string }[]).map((e) => [e.fight_id, e.boss_name]));

  const [{ data: recordsData }, { data: mechEventsData }, { data: reliabilityRows }] = await Promise.all([
    supabase.from('player_pull_records').select('*').in('pull_id', pullIds).eq('player_name', playerName),
    supabase
      .from('pull_mechanic_events')
      .select('pull_id, mechanic_name, category, outcome')
      .in('pull_id', pullIds)
      .neq('outcome', 'clean')
      .contains('players_hit_names', [playerName]),
    supabase.from('player_pull_reliability_inputs').select('had_avoidable_damage, used_defensive_when_died').in('pull_id', pullIds).eq('player_name', playerName),
  ]);

  type RecordRow = {
    pull_id: string;
    died: boolean;
    death_cause: { mechanicId: number; mechanicName: string | null; category: string | null; rootCause: string; timeMs: number; defensiveOptions?: { status: string }[] } | null;
    wipe_call_cluster: boolean;
    consumables?: { healthstone?: { timestampsMs: number[] }; healthPotion?: { timestampsMs: number[] } };
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

  const ENCHANTABLE_SLOT_INDICES = new Set([4, 6, 7, 8, 10, 11, 14]);

  function usedConsumableBeforeDeath(timestampsMs: number[] | undefined, deathTimeMs: number): boolean {
    return (timestampsMs ?? []).some((t) => t <= deathTimeMs && t >= deathTimeMs - EMERGENCY_CONSUMABLE_LOOKBACK_MS);
  }

  const deaths: NightPlayerBriefDeath[] = records
    .filter((r) => r.died && r.death_cause)
    .map((r) => {
      const pull = pullById.get(r.pull_id)!;
      const dc = r.death_cause!;
      const isWipeCall = r.wipe_call_cluster && pull.wipe_call_excluded;
      if (isWipeCall) return null;
      const hadDefensiveAvailableUnused = (dc.defensiveOptions ?? []).some((o) => o.status === 'available_unused');
      const usedHealthstone = usedConsumableBeforeDeath(r.consumables?.healthstone?.timestampsMs, dc.timeMs);
      const usedPotion = usedConsumableBeforeDeath(r.consumables?.healthPotion?.timestampsMs, dc.timeMs);
      return {
        bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
        pullNumber: pull.pull_number,
        timeLabel: formatTimeLabel(dc.timeMs),
        mechanic: dc.mechanicName ? mechanicDisplayName(dc.mechanicName) : `Hechizo #${dc.mechanicId} (sin clasificar)`,
        category: dc.category ?? null,
        rootCause: dc.rootCause,
        hadDefensiveAvailableUnused,
        usedEmergencyConsumable: usedHealthstone || usedPotion,
      };
    })
    .filter((d): d is NightPlayerBriefDeath => d != null)
    .sort((a, b) => a.pullNumber - b.pullNumber);

  const deathCoverage = new Set(deaths.map((d) => `${d.bossName}|${d.pullNumber}|${d.mechanic}`));
  const mechEvents = (mechEventsData ?? []) as { pull_id: string; mechanic_name: string; category: string | null; outcome: string }[];
  const mechanicFails: NightPlayerBriefMechanicFail[] = mechEvents
    .filter((ev) => ev.category == null || PERSONAL_RESPONSIBILITY_CATEGORIES.has(ev.category))
    .map((ev) => {
      const pull = pullById.get(ev.pull_id)!;
      return { bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`, mechanic: ev.mechanic_name, category: ev.category, outcome: ev.outcome };
    })
    .filter((row) => !deathCoverage.has(`${row.bossName}|${pullById.get(row.bossName)?.pull_number}|${row.mechanic}`) || true) // ver nota abajo
    .slice(0, 20);

  // §nota: la deduplicación exacta por pull_id+mecánica (como hace el
  // servicio Angular) exige guardar pull_id junto al fail, no solo el
  // nombre del boss — se simplifica aquí porque el LLM solo necesita "qué
  // pasó" para razonar, un pequeño solape entre "murió a X" y "falló X sin
  // morir" en la misma instancia no cambia la conclusión que puede sacar.

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
    let gemCount = 0;
    items.forEach((item, index) => {
      if (!item || !item.id) return;
      gemCount += (item.gems ?? []).length;
      if (ENCHANTABLE_SLOT_INDICES.has(index)) {
        enchantableSlotCount++;
        if (item.permanentEnchant != null) enchantedSlotCount++;
      }
    });
    gear = { class: lastRecord.class, spec: lastRecord.spec, enchantedSlotCount, enchantableSlotCount, gemCount };
  }

  const reliabilityInputRows = (reliabilityRows ?? []) as { had_avoidable_damage: boolean; used_defensive_when_died: boolean | null }[];
  const reliabilitySignal = reliabilityInputRows.length
    ? {
        pullsWithAvoidableDamage: reliabilityInputRows.filter((r) => r.had_avoidable_damage).length,
        pullsWithDefensiveUsedOnDeath: reliabilityInputRows.filter((r) => r.used_defensive_when_died === true).length,
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
