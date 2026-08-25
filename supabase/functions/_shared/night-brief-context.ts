import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { isDeathExcludedFromStatistics } from './statistical-exclusions.ts';

// §"los que sean unknown ability pon: unknown cause - WC" (feedback real,
// 2026-08-24) — mismo texto que shared/format.util.ts (Angular), duplicado
// por runtime distinto.
function mechanicDisplayName(name: string | null): string {
  if (!name) return 'Sin identificar';
  if (name === 'Unknown Ability') return 'Causa desconocida (posible wipe call / entorno)';
  return name;
}

// §"si es de una noche de raid lo hará a nivel de raid con algo menos de
// detalle particular de jugadores" (feedback real, 2026-08-24). Mismo
// espíritu que night-report.service.ts (Angular) pero deliberadamente MÁS
// LIGERO en detalle por jugador — topOffenders solo lleva nombre+recuento,
// nunca su historial completo (eso es el ámbito de night-player-brief).

export interface NightBriefBossSummary {
  bossName: string;
  difficulty: string;
  attempts: number;
  kills: number;
  bestWipePct: number | null;
}

export interface NightBriefTopDeathCause {
  mechanicName: string;
  deathCount: number;
  distinctPlayers: number;
}

export interface NightBriefTopOffender {
  playerName: string;
  deathCount: number;
}

export interface NightBriefContext {
  bosses: NightBriefBossSummary[];
  totalPulls: number;
  totalKills: number;
  totalWipes: number;
  totalDeaths: number;
  attendingMainCount: number;
  attendingTrialCount: number;
  absentMainNames: string[];
  wipeCallCount: number;
  topDeathCauses: NightBriefTopDeathCause[];
  topOffenders: NightBriefTopOffender[];
}

export async function buildNightBriefContext(supabase: SupabaseClient, reportCode: string): Promise<NightBriefContext | null> {
  const { data: pullsData } = await supabase.from('pulls').select('*').eq('report_code', reportCode).order('pull_number', { ascending: true });
  const pulls = (pullsData ?? []) as { id: string; fight_id: number; boss_id: string; difficulty: string; wipe_pct: number | null; wipe_call_excluded: boolean; wipe_call_signals: Record<string, unknown> | null }[];
  if (!pulls.length) return null;
  const pullIds = pulls.map((p) => p.id);

  const { data: encounters } = await supabase.from('report_encounters').select('fight_id, boss_name').eq('report_code', reportCode);
  const bossNameByFightId = new Map(((encounters ?? []) as { fight_id: number; boss_name: string }[]).map((e) => [e.fight_id, e.boss_name]));

  const [{ data: recordsData }, { data: rosterData }] = await Promise.all([
    supabase.from('player_pull_records').select('pull_id, player_name, died, death_cause, wipe_call_cluster').in('pull_id', pullIds),
    supabase.from('wowaudit_roster').select('name, rank'),
  ]);

  const pullById = new Map(pulls.map((p) => [p.id, p]));
  const bossGroups = new Map<string, { bossName: string; difficulty: string; pulls: typeof pulls }>();
  for (const p of pulls) {
    const key = `${p.boss_id}|${p.difficulty}`;
    if (!bossGroups.has(key)) bossGroups.set(key, { bossName: bossNameByFightId.get(p.fight_id) ?? `Boss ${p.boss_id}`, difficulty: p.difficulty, pulls: [] });
    bossGroups.get(key)!.pulls.push(p);
  }
  const bosses: NightBriefBossSummary[] = [...bossGroups.values()].map((g) => {
    const kills = g.pulls.filter((p) => p.wipe_pct === 0);
    const wipePcts = g.pulls.filter((p) => p.wipe_pct != null).map((p) => p.wipe_pct!);
    return { bossName: g.bossName, difficulty: g.difficulty, attempts: g.pulls.length, kills: kills.length, bestWipePct: wipePcts.length ? Math.min(...wipePcts) : null };
  });

  const totalKills = pulls.filter((p) => p.wipe_pct === 0).length;
  const wipeCallCount = pulls.filter((p) => p.wipe_call_excluded).length;

  type RecordRow = { pull_id: string; player_name: string; died: boolean; death_cause: { mechanicName: string | null; statisticalExclusionReason?: string | null } | null; wipe_call_cluster: boolean };
  const records = (recordsData ?? []) as RecordRow[];
  const realDeaths = records.filter((r) => {
    const pull = pullById.get(r.pull_id);
    return r.died && r.death_cause && pull != null && !isDeathExcludedFromStatistics(pull, r);
  });

  const deathsByMechanic = new Map<string, { count: number; players: Set<string> }>();
  const deathsByPlayer = new Map<string, number>();
  for (const r of realDeaths) {
    const name = mechanicDisplayName(r.death_cause!.mechanicName);
    if (!deathsByMechanic.has(name)) deathsByMechanic.set(name, { count: 0, players: new Set() });
    const e = deathsByMechanic.get(name)!;
    e.count++;
    e.players.add(r.player_name);
    deathsByPlayer.set(r.player_name, (deathsByPlayer.get(r.player_name) ?? 0) + 1);
  }
  const topDeathCauses: NightBriefTopDeathCause[] = [...deathsByMechanic.entries()]
    .map(([mechanicName, e]) => ({ mechanicName, deathCount: e.count, distinctPlayers: e.players.size }))
    .sort((a, b) => b.deathCount - a.deathCount)
    .slice(0, 8);
  // §"algo menos de detalle particular de jugadores": solo nombre+recuento,
  // sin mecánica/momento/defensivo por persona (eso es night-player-brief).
  const topOffenders: NightBriefTopOffender[] = [...deathsByPlayer.entries()]
    .map(([playerName, deathCount]) => ({ playerName, deathCount }))
    .filter((o) => o.deathCount >= 2)
    .sort((a, b) => b.deathCount - a.deathCount)
    .slice(0, 8);

  const attendedNames = new Set(records.map((r) => r.player_name));
  const roster = (rosterData ?? []) as { name: string; rank: string | null }[];
  const attendingMainCount = roster.filter((r) => r.rank === 'Main' && attendedNames.has(r.name)).length;
  const attendingTrialCount = roster.filter((r) => r.rank === 'Trial' && attendedNames.has(r.name)).length;
  const absentMainNames = roster.filter((r) => r.rank === 'Main' && !attendedNames.has(r.name)).map((r) => r.name);

  return {
    bosses,
    totalPulls: pulls.length,
    totalKills,
    totalWipes: pulls.length - totalKills,
    totalDeaths: realDeaths.length,
    attendingMainCount,
    attendingTrialCount,
    absentMainNames,
    wipeCallCount,
    topDeathCauses,
    topOffenders,
  };
}
