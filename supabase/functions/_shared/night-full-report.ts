import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { getJournalEncounterLocalized } from './blizzard-client.ts';
import { normalizeAbilityName } from './ability-name-match.ts';

// §"informe de la noche... qué podemos poner que sea real y sin inventar,
// o qué podemos obtener/calcular/derivar" (feedback real, 2026-08-24).
// TODO lo de aquí es agregación pura sobre columnas que YA existen — nada
// de LLM, nada inventado. Deliberadamente FUERA (documentado en
// `notAvailable` para que se vea en el propio informe, no se esconde):
// fases del encuentro, raid cooldowns (Barrier/Devotion Aura/Rallying
// Cry...), Battle Res, Bloodlust/Heroism, dispels, buffs de consumibles
// (flask/food/weapon oil/augment rune), prioridad de objetivos/adds — WCL
// tiene estos datos pero esta app no los trae hoy (harían falta llamadas
// nuevas a events(dataType: Resurrection/Buffs/Dispels) y un modelo de
// adds/targets que no existe). Enfoque agregado/anónimo a propósito
// (§"no se convierta en un ranking de culpables") — nunca se agrupa por
// nombre de jugador, solo recuentos y porcentajes de raid.

const EARLY_WIPE_MS = 90_000;
const EMERGENCY_CONSUMABLE_LOOKBACK_MS = 15_000;
const MECHANIC_CATEGORY_LABEL: Record<string, string> = {
  'raid-damage': 'Daño de raid',
  'avoidable-ground': 'Zona evitable',
  soak: 'Soak (agruparse)',
  spread: 'Separarse',
  tankbuster: 'Tankbuster',
  'debuff-stack': 'Debuff acumulativo',
  interrupt: 'Interrupción',
  'healing-absorb': 'Absorción de curación',
  'personal-target': 'Objetivo individual',
  enrage: 'Enrage',
};
const ROOT_CAUSE_LABEL: Record<string, string> = {
  self_positioning: 'Posicionamiento propio',
  unsoaked_mechanic: 'Mecánica sin resolver',
  no_healing_received: 'Daño sostenido sin sanación registrada en 6 s',
  unclassified: 'Sin causa raíz demostrable',
};
type RaidRole = 'tank' | 'healer' | 'dps';
const TANK_SPEC_KEYS = new Set([
  'DeathKnight|Blood', 'DemonHunter|Vengeance', 'Druid|Guardian', 'Monk|Brewmaster', 'Paladin|Protection', 'Warrior|Protection',
]);
const HEALER_SPEC_KEYS = new Set([
  'Druid|Restoration', 'Evoker|Preservation', 'Monk|Mistweaver', 'Paladin|Holy', 'Priest|Discipline', 'Priest|Holy', 'Shaman|Restoration',
]);
const PURE_DPS_CLASSES = new Set(['Hunter', 'Mage', 'Rogue', 'Warlock']);

function raidRole(className: string | null, spec: string | null): RaidRole | null {
  if (!className) return null;
  const key = `${className}|${spec ?? ''}`;
  if (TANK_SPEC_KEYS.has(key)) return 'tank';
  if (HEALER_SPEC_KEYS.has(key)) return 'healer';
  if (spec || PURE_DPS_CLASSES.has(className)) return 'dps';
  return null;
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}
function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const PAGE_SIZE = 1_000;
const FILTER_CHUNK_SIZE = 100;

/**
 * Supabase limita por defecto cada SELECT a 1.000 filas. Los eventos de una
 * sola noche superan ese límite con facilidad, por lo que todas las tablas
 * de volumen se recorren de forma estable y en bloques de IDs pequeños.
 */
async function fetchAllByValues<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  filterColumn: string,
  values: (string | number)[],
  orderColumn = 'id',
): Promise<T[]> {
  const all: T[] = [];
  for (let chunkStart = 0; chunkStart < values.length; chunkStart += FILTER_CHUNK_SIZE) {
    const chunk = values.slice(chunkStart, chunkStart + FILTER_CHUNK_SIZE);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .in(filterColumn, chunk)
        .order(orderColumn, { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      const page = (data ?? []) as T[];
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }
  return all;
}

export interface NightTimelineMarker {
  kind: 'ability' | 'deaths';
  offsetMs: number;
  mechanicName: string;
  mechanicNameEs: string | null;
  wowheadSpellId: number | null;
  outcome: 'clean' | 'partial_fail' | 'fail' | null;
  occurrences: number;
  playersHit: number;
  deaths: number;
  isAnchor: boolean;
}

export interface NightTimeline {
  anchorMechanicName: string;
  anchorMechanicNameEs: string | null;
  anchorWowheadSpellId: number | null;
  anchorCategory: string | null;
  anchorCategoryLabel: string | null;
  medianTimeMs: number;
  occurrences: number;
  failures: number;
  lethalFinalBlows: number;
  pulls: number[];
  prepNote: string;
  markers: NightTimelineMarker[];
}

export interface NightTimelinePatterns {
  bossName: string;
  bossNameEs: string | null;
  difficulty: string;
  windowBeforeMs: number;
  windowAfterMs: number;
  timelines: NightTimeline[];
}

export interface NightFullReport {
  schemaVersion: 7;
  reportCode: string;
  reportTitle: string;
  reportDate: string;
  summary: {
    totalPulls: number;
    totalBosses: number;
    totalKills: number;
    totalWipes: number;
    bestPull: { bossName: string; bossNameEs: string | null; difficulty: string; wipePct: number | null; kill: boolean; pullNumber: number } | null;
    avgPullDurationMs: number;
    totalCombatTimeMs: number;
    earlyWipeCount: number;
    earlyWipeThresholdMs: number;
    progressBoss: {
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      pulls: number;
      firstWipePct: number | null;
      lastWipePct: number | null;
      bestWipePct: number | null;
    } | null;
    bosses: { bossName: string; bossNameEs: string | null; difficulty: string; pulls: number; kills: number; bestWipePct: number | null }[];
    progression: { bossName: string; bossNameEs: string | null; difficulty: string; firstWipePct: number; lastWipePct: number; pulls: number }[];
  };
  mechanics: {
    mechanicName: string;
    mechanicNameEs: string | null;
    wowheadSpellId: number | null;
    category: string | null;
    categoryLabel: string | null;
    note: string | null;
    bossName: string;
    bossNameEs: string | null;
    difficulty: string;
    isProgressBoss: boolean;
    totalFails: number;
    pullsAffected: number;
    totalPulls: number;
    pctPullsAffected: number;
    lethalFinalBlows: number;
    avoidableDamageTotal: number | null;
    trend: 'improving' | 'worsening' | 'flat' | 'insufficient_data';
  }[];
  timelinePatterns: NightTimelinePatterns | null;
  /** null = el manifiesto de esta noche no tiene NINGÚN "Evitable" confirmado todavía (Ajustes) — un 0 real sería engañoso ("night limpia") cuando en verdad es "sin medir". Ver notAvailable. */
  avoidableDamage: {
    total: number;
    perMinute: number;
    pctOfRaidDamage: number | null;
    measuredBossScopes: number;
    totalBossScopes: number;
    complete: boolean;
  } | null;
  deaths: {
    totalRealDeaths: number;
    totalWipeCallExcluded: number;
    rootCauseClassifiedCount: number;
    rootCauseCoveragePct: number;
    mechanicCategorizedCount: number;
    mechanicCategoryCoveragePct: number;
    unknownFinalBlowCount: number;
    unknownFinalBlowWithDamageContextCount: number;
    byRootCause: { rootCause: string; label: string; count: number; pct: number }[];
    byCategory: { category: string; label: string; count: number; pct: number }[];
    topFinalBlows: {
      mechanicName: string;
      mechanicNameEs: string | null;
      wowheadSpellId: number | null;
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      isProgressBoss: boolean;
      note: string | null;
      count: number;
    }[];
    topLastDamageBeforeUnknownFinalBlow: {
      mechanicName: string;
      mechanicNameEs: string | null;
      wowheadSpellId: number | null;
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      isProgressBoss: boolean;
      note: string | null;
      count: number;
    }[];
    pctWithDefensiveAvailableUnused: number;
    defensiveEvaluableCount: number;
  };
  survival: {
    emergencyLookbackMs: number;
    healthstone: { playersEverUsed: number; playersWithObservedAccess: number; pctUsedAtLeastOnce: number; deathsWithObservedAccessNoRecentUse: number; deathsEvaluable: number };
    healthPotion: { playersEverUsed: number; totalPlayersTracked: number; pctUsedAtLeastOnce: number };
    either: { playersEverUsed: number; totalPlayersTracked: number; pctUsedAtLeastOnce: number };
    pctDeathsWithNoRecentEmergencyConsumable: number;
  };
  defensives: {
    playersEverUsed: number;
    totalPlayersTracked: number;
    pctPlayersUsedAtLeastOnce: number;
    totalCasts: number;
    castsPerCombatMinute: number;
    globalAvailableUnusedPct: number;
    availableUnusedCount: number;
    totalEvaluated: number;
    byCategory: { category: string; label: string; availableUnusedPct: number; evaluated: number }[];
  };
  interrupts: {
    totalCasts: number;
    interrupted: number;
    pctSuccess: number;
    excludedUnverifiedCasts: number;
    topUninterrupted: { mechanicName: string; mechanicNameEs: string | null; wowheadSpellId: number | null; note: string | null; completedCount: number }[];
    progressBoss: {
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      totalCasts: number;
      interrupted: number;
      pctSuccess: number;
      topUninterrupted: { mechanicName: string; mechanicNameEs: string | null; wowheadSpellId: number | null; note: string | null; completedCount: number }[];
    } | null;
  };
  wipePatterns: { category: string; label: string; count: number; pct: number }[];
  wipeRecovery: { windowMs: number; wipesEvaluable: number; wipesWithCascade: number; pctWipesWithCascade: number };
  roleInsights: {
    scope: { bossName: string; bossNameEs: string | null; difficulty: string; pulls: number } | null;
    classifiedPlayers: number;
    totalPlayers: number;
    classificationCoveragePct: number;
    tanks: { players: number; deaths: number; deathsPerPull: number; playersUsingDefensive: number; tankbusterDeaths: number; nonTankTankbusterDeaths: number };
    healers: { players: number; deaths: number; deathsPerPull: number; playersUsingDefensive: number; raidDeathsWithSustainedNoHealingSignal: number };
    dps: { players: number; deaths: number; deathsPerPull: number; playersUsingDefensive: number; personalMechanicDeaths: number };
  };
  progressionComparison: {
    sampleSize: number;
    avoidableDamageDeltaPct: number | null;
    deathsDeltaPct: number | null;
    defensiveCoverageDeltaPct: number | null;
  } | null;
  priorities: { title: string; detail: string; note: string | null }[];
  goodPoints: string[];
  notAvailable: string[];
}

interface PullLite {
  id: string;
  fight_id: number;
  boss_id: string;
  difficulty: string;
  pull_number: number;
  wipe_pct: number | null;
  duration_ms: number | null;
  raid_damage_taken_series: { pointIntervalMs: number; points: number[] } | null;
  wipe_call_excluded: boolean;
  closed_at: string;
}
interface RecordLite {
  pull_id: string;
  player_name: string;
  class: string | null;
  spec: string | null;
  died: boolean;
  death_cause: {
    mechanicId: number;
    mechanicName: string | null;
    category: string | null;
    rootCause: string;
    timeMs: number;
    damageWindowTotal?: number;
    damageWindowEvents?: { time_ms: number; amount: number; ability_id: number | null; ability_name: string | null }[];
    defensiveOptions?: { spellId: number; status: string }[];
  } | null;
  wipe_call_cluster: boolean;
  avoidable_damage_taken: number;
  mechanic_damage: { mechanicId: number; mechanicName: string | null; amount: number }[];
  defensive_casts?: { spellId: number; name: string; timestampsMs: number[] }[];
  consumables?: {
    healthstone?: { available: boolean; used: boolean; count: number; timestampsMs: number[] };
    healthPotion?: { used: boolean; count: number; timestampsMs: number[] };
  };
}
interface MechEventLite {
  pull_id: string;
  mechanic_name: string;
  ability_id: number;
  trigger_time_ms: number;
  category: string | null;
  outcome: string;
  players_hit: number;
}

interface MechanicManifestLite {
  boss_id: string;
  difficulty: string;
  name: string;
  name_es: string | null;
  category: string | null;
  inferred_category: string | null;
  observed_as_interrupt: boolean;
  avoidable: boolean | null;
  ai_classification: { notes?: string } | null;
}

export async function buildNightFullReport(supabase: SupabaseClient, reportCode: string): Promise<NightFullReport | null> {
  const [reportResult, encountersResult] = await Promise.all([
    supabase.from('reports').select('title, start_time').eq('code', reportCode).maybeSingle(),
    supabase.from('report_encounters').select('fight_id, boss_name').eq('report_code', reportCode),
  ]);
  if (reportResult.error) throw reportResult.error;
  if (encountersResult.error) throw encountersResult.error;

  const pulls = await fetchAllByValues<PullLite>(
    supabase,
    'pulls',
    'id, fight_id, boss_id, difficulty, pull_number, wipe_pct, duration_ms, raid_damage_taken_series, wipe_call_excluded, closed_at',
    'report_code',
    [reportCode],
    'closed_at',
  );
  if (!pulls.length) return null;
  const pullIds = pulls.map((p) => p.id);
  const bossNameByFightId = new Map(((encountersResult.data ?? []) as { fight_id: number; boss_name: string }[]).map((e) => [e.fight_id, e.boss_name]));
  const pullById = new Map(pulls.map((p) => [p.id, p]));

  const bossIds = [...new Set(pulls.map((p) => p.boss_id))];
  const [records, mechEvents, manifest, knownBossResult] = await Promise.all([
    fetchAllByValues<RecordLite>(
      supabase,
      'player_pull_records',
      'id, pull_id, player_name, class, spec, died, death_cause, wipe_call_cluster, avoidable_damage_taken, mechanic_damage, defensive_casts, consumables',
      'pull_id',
      pullIds,
    ),
    fetchAllByValues<MechEventLite>(
      supabase,
      'pull_mechanic_events',
      'id, pull_id, mechanic_name, ability_id, trigger_time_ms, category, outcome, players_hit',
      'pull_id',
      pullIds,
    ),
    // §"nombre de habilidades y bosses en inglés (y en paréntesis en
    // castellano)" + "nunca mostrar 0% si en realidad no hay dato": una sola
    // consulta cubre las dos cosas — name_es para el paréntesis (null =
    // Blizzard no lo tiene traducido todavía, se omite el paréntesis) y si
    // algún mecánica de estos bosses tiene "Evitable" confirmado (si
    // NINGUNA lo tiene, avoidableAbilityIds de analyze-report está vacío y
    // avoidable_damage_taken/mechanic_damage saldrían siempre en 0 aunque
    // hubiera daño evitable real sin marcar — un 0 ahí sería engañoso).
    fetchAllByValues<MechanicManifestLite>(
      supabase,
      'boss_mechanics_candidates',
      'id, boss_id, difficulty, name, name_es, category, inferred_category, observed_as_interrupt, avoidable, ai_classification',
      'boss_id',
      bossIds,
    ),
    supabase.from('known_raid_bosses').select('encounter_id, journal_encounter_id').in('encounter_id', bossIds.map(Number)),
  ]);
  if (knownBossResult.error) throw knownBossResult.error;

  // El nombre castellano del boss sale del Journal oficial de Blizzard. Es
  // best-effort: una caída de esa API no impide generar el informe ni se
  // sustituye por una traducción inventada.
  const bossNameEsByBossId = new Map<string, string>();
  await Promise.all(
    ((knownBossResult.data ?? []) as { encounter_id: number; journal_encounter_id: number | null }[]).map(async (boss) => {
      if (!boss.journal_encounter_id) return;
      try {
        const localized = await getJournalEncounterLocalized(boss.journal_encounter_id, 'es_ES');
        const englishName = pulls
          .filter((p) => p.boss_id === String(boss.encounter_id))
          .map((p) => bossNameByFightId.get(p.fight_id))
          .find((name): name is string => Boolean(name));
        if (localized.name && localized.name.toLowerCase() !== englishName?.toLowerCase()) {
          bossNameEsByBossId.set(String(boss.encounter_id), localized.name);
        }
      } catch (err) {
        console.error(`night-full-report: no se pudo localizar el boss ${boss.encounter_id} a es_ES`, err);
      }
    }),
  );

  const activeBossScopes = new Set(pulls.map((p) => `${p.boss_id}|${p.difficulty}`));
  const relevantManifest = manifest.filter((m) => activeBossScopes.has(`${m.boss_id}|${m.difficulty}`));
  const measuredAvoidableScopes = new Set(relevantManifest.filter((m) => m.avoidable === true).map((m) => `${m.boss_id}|${m.difficulty}`));
  const hasAnyConfirmedAvoidable = measuredAvoidableScopes.size > 0;
  const hasCompleteAvoidableCoverage = [...activeBossScopes].every((scope) => measuredAvoidableScopes.has(scope));

  const nameEsByMechanicKey = new Map<string, string>();
  const nameEsByNormalizedName = new Map<string, string>();
  const noteByMechanicKey = new Map<string, string>();
  const noteByNormalizedName = new Map<string, string>();
  for (const m of manifest) {
    const normalizedName = normalizeAbilityName(m.name);
    if (m.name_es && m.name_es.toLowerCase() !== m.name.toLowerCase()) {
      nameEsByMechanicKey.set(`${m.boss_id}|${m.difficulty}|${normalizedName}`, m.name_es);
      if (!nameEsByNormalizedName.has(normalizedName)) nameEsByNormalizedName.set(normalizedName, m.name_es);
    }
    const note = m.ai_classification?.notes?.trim();
    if (note) {
      noteByMechanicKey.set(`${m.boss_id}|${m.difficulty}|${normalizedName}`, note);
      if (!noteByNormalizedName.has(normalizedName)) noteByNormalizedName.set(normalizedName, note);
    }
  }
  const mechanicNameEs = (bossId: string, difficulty: string, name: string): string | null =>
    nameEsByMechanicKey.get(`${bossId}|${difficulty}|${normalizeAbilityName(name)}`) ?? nameEsByNormalizedName.get(normalizeAbilityName(name)) ?? null;
  const mechanicNote = (bossId: string, difficulty: string, name: string): string | null =>
    noteByMechanicKey.get(`${bossId}|${difficulty}|${normalizeAbilityName(name)}`) ?? noteByNormalizedName.get(normalizeAbilityName(name)) ?? null;

  const manifestByMechanicKey = new Map(
    relevantManifest.map((m) => [`${m.boss_id}|${m.difficulty}|${normalizeAbilityName(m.name)}`, m]),
  );
  const reportObservedInterruptKeys = new Set(
    mechEvents
      .filter((event) => event.category === 'interrupt' && event.outcome === 'interrupted')
      .flatMap((event) => {
        const pull = pullById.get(event.pull_id);
        return pull ? [`${pull.boss_id}|${pull.difficulty}|${normalizeAbilityName(event.mechanic_name)}`] : [];
      }),
  );
  const isTrustedInterruptEvent = (ev: MechEventLite): boolean => {
    if (ev.category !== 'interrupt') return true;
    const pull = pullById.get(ev.pull_id);
    if (!pull) return false;
    const mechanicKey = `${pull.boss_id}|${pull.difficulty}|${normalizeAbilityName(ev.mechanic_name)}`;
    const candidate = manifestByMechanicKey.get(mechanicKey);
    if (!candidate) return false;
    const classifiedAsInterrupt = candidate.category === 'interrupt' || (candidate.category == null && candidate.inferred_category === 'interrupt');
    // Una etiqueta textual o editorial no demuestra que el cast admita un
    // kick estándar (p. ej. Final Ascension se detiene con un objeto del
    // encuentro). Se exige al menos un evento Interrupt real, ya sea en el
    // log público de referencia o en esta propia noche.
    return classifiedAsInterrupt && (candidate.observed_as_interrupt || reportObservedInterruptKeys.has(mechanicKey));
  };
  // Las filas históricas podían tratar como interrupt cualquier sugerencia
  // inferida por texto. Para el informe compartible solo valen categorías
  // confirmadas o inferencias respaldadas por un evento Interrupt real.
  const reportableMechEvents = mechEvents.filter(isTrustedInterruptEvent);
  const excludedUnverifiedInterruptCasts = mechEvents.filter((ev) => ev.category === 'interrupt' && !isTrustedInterruptEvent(ev)).length;

  const isExcludedWipeCallDeath = (r: RecordLite) => Boolean(r.wipe_call_cluster && pullById.get(r.pull_id)?.wipe_call_excluded);
  const realDeaths = records.filter((r) => r.died && r.death_cause && !isExcludedWipeCallDeath(r));
  // Versiones anteriores contaban impactos absorbidos/de importe 0 para
  // decidir que había daño sostenido. Eso podía producir una falsa señal de
  // “sin sanación” aun cuando el daño real de la ventana era exactamente 0.
  const normalizedRootCause = (record: RecordLite): string => {
    const cause = record.death_cause!;
    return cause.rootCause === 'no_healing_received' && typeof cause.damageWindowTotal === 'number' && cause.damageWindowTotal <= 0
      ? 'unclassified'
      : cause.rootCause;
  };

  // ---- 1. Resumen general ----
  const bossGroups = new Map<string, { bossId: string; bossName: string; bossNameEs: string | null; difficulty: string; pulls: PullLite[] }>();
  for (const p of pulls) {
    const key = `${p.boss_id}|${p.difficulty}`;
    if (!bossGroups.has(key)) {
      bossGroups.set(key, {
        bossId: p.boss_id,
        bossName: bossNameByFightId.get(p.fight_id) ?? `Boss ${p.boss_id}`,
        bossNameEs: bossNameEsByBossId.get(p.boss_id) ?? null,
        difficulty: p.difficulty,
        pulls: [],
      });
    }
    bossGroups.get(key)!.pulls.push(p);
  }
  const totalKills = pulls.filter((p) => p.wipe_pct === 0).length;
  const unresolvedBossGroups = [...bossGroups.values()].filter((group) => !group.pulls.some((pull) => pull.wipe_pct === 0));
  const progressBossGroup = unresolvedBossGroups.length ? unresolvedBossGroups[unresolvedBossGroups.length - 1] : null;
  const durations = pulls.filter((p) => p.duration_ms != null).map((p) => p.duration_ms!);
  const bestPullRow = [...pulls].sort((a, b) => (a.wipe_pct ?? 100) - (b.wipe_pct ?? 100))[0] ?? null;
  const progression = [...bossGroups.values()]
    .filter((g) => g.pulls.length >= 2)
    .map((g) => ({
      bossName: g.bossName,
      bossNameEs: g.bossNameEs,
      difficulty: g.difficulty,
      firstWipePct: g.pulls[0].wipe_pct ?? 100,
      lastWipePct: g.pulls[g.pulls.length - 1].wipe_pct ?? 100,
      pulls: g.pulls.length,
    }));
  const earlyWipes = pulls.filter((p) => p.wipe_pct != null && p.wipe_pct > 0 && (p.duration_ms ?? 0) > 0 && p.duration_ms! < EARLY_WIPE_MS);

  const summary: NightFullReport['summary'] = {
    totalPulls: pulls.length,
    totalBosses: bossGroups.size,
    totalKills,
    totalWipes: pulls.length - totalKills,
    bestPull: bestPullRow
      ? {
          bossName: bossNameByFightId.get(bestPullRow.fight_id) ?? `Boss ${bestPullRow.boss_id}`,
          bossNameEs: bossNameEsByBossId.get(bestPullRow.boss_id) ?? null,
          difficulty: bestPullRow.difficulty,
          wipePct: bestPullRow.wipe_pct,
          kill: bestPullRow.wipe_pct === 0,
          pullNumber: bestPullRow.pull_number,
        }
      : null,
    avgPullDurationMs: mean(durations) ?? 0,
    totalCombatTimeMs: durations.reduce((a, b) => a + b, 0),
    earlyWipeCount: earlyWipes.length,
    earlyWipeThresholdMs: EARLY_WIPE_MS,
    progressBoss: progressBossGroup
      ? {
          bossName: progressBossGroup.bossName,
          bossNameEs: progressBossGroup.bossNameEs,
          difficulty: progressBossGroup.difficulty,
          pulls: progressBossGroup.pulls.length,
          firstWipePct: progressBossGroup.pulls[0]?.wipe_pct ?? null,
          lastWipePct: progressBossGroup.pulls[progressBossGroup.pulls.length - 1]?.wipe_pct ?? null,
          bestWipePct: progressBossGroup.pulls.reduce<number | null>((best, pull) => pull.wipe_pct == null ? best : best == null ? pull.wipe_pct : Math.min(best, pull.wipe_pct), null),
        }
      : null,
    bosses: [...bossGroups.values()].map((g) => ({
      bossName: g.bossName,
      bossNameEs: g.bossNameEs,
      difficulty: g.difficulty,
      pulls: g.pulls.length,
      kills: g.pulls.filter((p) => p.wipe_pct === 0).length,
      bestWipePct: g.pulls.reduce<number | null>((best, p) => (p.wipe_pct == null ? best : best == null ? p.wipe_pct : Math.min(best, p.wipe_pct)), null),
    })),
    progression,
  };

  // ---- 2. Mecánicas falladas (con tendencia primera mitad vs segunda mitad del boss) ----
  const mechByKey = new Map<
    string,
    {
      bossId: string;
      mechanicName: string;
      wowheadSpellId: number | null;
      category: string | null;
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      totalFails: number;
      pullsAffected: Set<string>;
      firstHalfPullsAffected: Set<string>;
      secondHalfPullsAffected: Set<string>;
    }
  >();
  for (const ev of reportableMechEvents) {
    const pull = pullById.get(ev.pull_id);
    if (!pull) continue;
    const key = `${pull.boss_id}|${pull.difficulty}|${normalizeAbilityName(ev.mechanic_name)}`;
    if (!mechByKey.has(key)) {
      mechByKey.set(key, {
        bossId: pull.boss_id,
        mechanicName: ev.mechanic_name,
        wowheadSpellId: ev.ability_id || null,
        category: ev.category,
        bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
        bossNameEs: bossNameEsByBossId.get(pull.boss_id) ?? null,
        difficulty: pull.difficulty,
        totalFails: 0,
        pullsAffected: new Set(),
        firstHalfPullsAffected: new Set(),
        secondHalfPullsAffected: new Set(),
      });
    }
    const entry = mechByKey.get(key)!;
    if (ev.outcome !== 'clean') {
      entry.totalFails++;
      entry.pullsAffected.add(ev.pull_id);
      const group = bossGroups.get(`${pull.boss_id}|${pull.difficulty}`)!;
      const half = Math.ceil(group.pulls.length / 2);
      const idx = group.pulls.findIndex((p) => p.id === ev.pull_id);
      if (idx < half) entry.firstHalfPullsAffected.add(ev.pull_id);
      else entry.secondHalfPullsAffected.add(ev.pull_id);
    }
  }
  const deathsByMechanicKey = new Map<string, number>();
  for (const r of realDeaths) {
    const pull = pullById.get(r.pull_id);
    if (!pull || !r.death_cause?.mechanicName) continue;
    const key = `${pull.boss_id}|${pull.difficulty}|${normalizeAbilityName(r.death_cause.mechanicName)}`;
    deathsByMechanicKey.set(key, (deathsByMechanicKey.get(key) ?? 0) + 1);
  }
  // mechanic_damage YA viene desglosado por mecánica de verdad (analyze-report
  // solo lo rellena para abilityIds marcados avoidable:true en el manifiesto)
  // — no es una aproximación, es el dato real agregado por mecánica+boss+dificultad.
  const avoidableDamageByMechanicKey = new Map<string, number>();
  let totalAvoidableDamage = 0;
  for (const r of records) {
    const pull = pullById.get(r.pull_id);
    if (!pull) continue;
    const scope = `${pull.boss_id}|${pull.difficulty}`;
    if (!measuredAvoidableScopes.has(scope)) continue;
    totalAvoidableDamage += r.avoidable_damage_taken ?? 0;
    for (const entry of r.mechanic_damage ?? []) {
      if (!entry.mechanicName) continue;
      const key = `${pull.boss_id}|${pull.difficulty}|${normalizeAbilityName(entry.mechanicName)}`;
      avoidableDamageByMechanicKey.set(key, (avoidableDamageByMechanicKey.get(key) ?? 0) + (entry.amount ?? 0));
    }
  }

  const MIN_PULLS_PER_HALF_FOR_TREND = 3;
  const TREND_DELTA_POINTS = 15;
  const mechanics: NightFullReport['mechanics'] = [...mechByKey.entries()]
    .map(([key, e]) => {
      const group = bossGroups.get(`${e.bossId}|${e.difficulty}`)!;
      const firstHalfPullCount = Math.ceil(group.pulls.length / 2);
      const secondHalfPullCount = group.pulls.length - firstHalfPullCount;
      let trend: 'improving' | 'worsening' | 'flat' | 'insufficient_data' = 'insufficient_data';
      if (
        firstHalfPullCount >= MIN_PULLS_PER_HALF_FOR_TREND &&
        secondHalfPullCount >= MIN_PULLS_PER_HALF_FOR_TREND &&
        e.pullsAffected.size >= 2
      ) {
        const firstRate = pct(e.firstHalfPullsAffected.size, firstHalfPullCount);
        const secondRate = pct(e.secondHalfPullsAffected.size, secondHalfPullCount);
        const delta = secondRate - firstRate;
        trend = delta <= -TREND_DELTA_POINTS ? 'improving' : delta >= TREND_DELTA_POINTS ? 'worsening' : 'flat';
      }
      const scope = `${e.bossId}|${e.difficulty}`;
      return {
        mechanicName: e.mechanicName,
        mechanicNameEs: mechanicNameEs(e.bossId, e.difficulty, e.mechanicName),
        wowheadSpellId: e.wowheadSpellId,
        category: e.category,
        categoryLabel: e.category ? (MECHANIC_CATEGORY_LABEL[e.category] ?? e.category) : null,
        note: mechanicNote(e.bossId, e.difficulty, e.mechanicName),
        bossName: e.bossName,
        bossNameEs: e.bossNameEs,
        difficulty: e.difficulty,
        isProgressBoss: progressBossGroup?.bossId === e.bossId && progressBossGroup.difficulty === e.difficulty,
        totalFails: e.totalFails,
        pullsAffected: e.pullsAffected.size,
        totalPulls: group.pulls.length,
        pctPullsAffected: pct(e.pullsAffected.size, group.pulls.length),
        lethalFinalBlows: deathsByMechanicKey.get(key) ?? 0,
        avoidableDamageTotal: measuredAvoidableScopes.has(scope) ? (avoidableDamageByMechanicKey.get(key) ?? 0) : null,
        trend,
      };
    })
    .filter((m) => m.totalFails > 0)
    .sort((a, b) =>
      Number(b.isProgressBoss) * 10_000 + b.lethalFinalBlows * 3 + b.pullsAffected -
      (Number(a.isProgressBoss) * 10_000 + a.lethalFinalBlows * 3 + a.pullsAffected),
    )
    .slice(0, 12);

  // ---- 3. Muertes clasificadas ----
  const rootCauseCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const finalBlowCounts = new Map<
    string,
    {
      bossId: string;
      mechanicName: string;
      mechanicNameEs: string | null;
      wowheadSpellId: number | null;
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      isProgressBoss: boolean;
      note: string | null;
      count: number;
    }
  >();
  const lastDamageContextCounts = new Map<
    string,
    {
      bossId: string;
      mechanicName: string;
      mechanicNameEs: string | null;
      wowheadSpellId: number | null;
      bossName: string;
      bossNameEs: string | null;
      difficulty: string;
      isProgressBoss: boolean;
      note: string | null;
      count: number;
    }
  >();
  let unknownFinalBlowCount = 0;
  let unknownFinalBlowWithDamageContextCount = 0;
  let defensiveEvaluable = 0;
  let defensiveAvailableUnused = 0;
  for (const r of realDeaths) {
    const dc = r.death_cause!;
    const rootCause = normalizedRootCause(r);
    rootCauseCounts.set(rootCause, (rootCauseCounts.get(rootCause) ?? 0) + 1);
    const cat = dc.category ?? 'sin-categoria';
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    const opts = dc.defensiveOptions ?? [];
    if (opts.length) {
      defensiveEvaluable++;
      if (opts.some((o) => o.status === 'available_unused')) defensiveAvailableUnused++;
    }
    const pull = pullById.get(r.pull_id);
    if (pull) {
      const rawMechanicName = dc.mechanicName?.trim();
      const isUnknownFinalBlow = !dc.mechanicId || !rawMechanicName || /^unknown ability$/i.test(rawMechanicName);
      if (isUnknownFinalBlow) {
        unknownFinalBlowCount++;
        const lastDamage = [...(dc.damageWindowEvents ?? [])]
          .filter((event) => event.amount > 0 && event.ability_id && event.ability_name)
          .sort((a, b) => b.time_ms - a.time_ms)[0];
        if (lastDamage?.ability_id && lastDamage.ability_name) {
          unknownFinalBlowWithDamageContextCount++;
          const contextKey = `${pull.boss_id}|${pull.difficulty}|${lastDamage.ability_id}`;
          const current = lastDamageContextCounts.get(contextKey);
          if (current) current.count++;
          else {
            lastDamageContextCounts.set(contextKey, {
              bossId: pull.boss_id,
              mechanicName: lastDamage.ability_name,
              mechanicNameEs: mechanicNameEs(pull.boss_id, pull.difficulty, lastDamage.ability_name),
              wowheadSpellId: lastDamage.ability_id,
              bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
              bossNameEs: bossNameEsByBossId.get(pull.boss_id) ?? null,
              difficulty: pull.difficulty,
              isProgressBoss: progressBossGroup?.bossId === pull.boss_id && progressBossGroup.difficulty === pull.difficulty,
              note: mechanicNote(pull.boss_id, pull.difficulty, lastDamage.ability_name),
              count: 1,
            });
          }
        }
        continue;
      }
      const mechanicName = rawMechanicName;
      const key = `${pull.boss_id}|${pull.difficulty}|${dc.mechanicId || normalizeAbilityName(mechanicName)}`;
      const current = finalBlowCounts.get(key);
      if (current) current.count++;
      else {
        finalBlowCounts.set(key, {
          bossId: pull.boss_id,
          mechanicName,
          mechanicNameEs: mechanicNameEs(pull.boss_id, pull.difficulty, mechanicName),
          wowheadSpellId: dc.mechanicId || null,
          bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
          bossNameEs: bossNameEsByBossId.get(pull.boss_id) ?? null,
          difficulty: pull.difficulty,
          isProgressBoss: progressBossGroup?.bossId === pull.boss_id && progressBossGroup.difficulty === pull.difficulty,
          note: mechanicNote(pull.boss_id, pull.difficulty, mechanicName),
          count: 1,
        });
      }
    }
  }
  const rootCauseClassifiedCount = realDeaths.filter((r) => normalizedRootCause(r) !== 'unclassified').length;
  const mechanicCategorizedCount = realDeaths.filter((r) => r.death_cause!.category != null).length;
  const deaths: NightFullReport['deaths'] = {
    totalRealDeaths: realDeaths.length,
    totalWipeCallExcluded: records.filter((r) => r.died && isExcludedWipeCallDeath(r)).length,
    rootCauseClassifiedCount,
    rootCauseCoveragePct: pct(rootCauseClassifiedCount, realDeaths.length),
    mechanicCategorizedCount,
    mechanicCategoryCoveragePct: pct(mechanicCategorizedCount, realDeaths.length),
    unknownFinalBlowCount,
    unknownFinalBlowWithDamageContextCount,
    byRootCause: [...rootCauseCounts.entries()].map(([rootCause, count]) => ({ rootCause, label: ROOT_CAUSE_LABEL[rootCause] ?? rootCause, count, pct: pct(count, realDeaths.length) })).sort((a, b) => b.count - a.count),
    byCategory: [...categoryCounts.entries()]
      .map(([category, count]) => ({ category, label: category === 'sin-categoria' ? 'Sin categoría' : (MECHANIC_CATEGORY_LABEL[category] ?? category), count, pct: pct(count, realDeaths.length) }))
      .sort((a, b) => b.count - a.count),
    topFinalBlows: [...finalBlowCounts.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    topLastDamageBeforeUnknownFinalBlow: [...lastDamageContextCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    pctWithDefensiveAvailableUnused: pct(defensiveAvailableUnused, defensiveEvaluable),
    defensiveEvaluableCount: defensiveEvaluable,
  };

  // ---- 4. Ventanas temporales del boss de progress ----
  // Se alinean secuencias observadas alrededor de habilidades prioritarias.
  // Es deliberadamente descriptivo: que dos eventos estén próximos no
  // demuestra que uno haya causado el otro.
  const TIMELINE_BEFORE_MS = 12_000;
  const TIMELINE_AFTER_MS = 12_000;
  const TIMELINE_CLUSTER_GAP_MS = 18_000;
  const medianRounded = (values: number[]): number => {
    const ordered = [...values].sort((a, b) => a - b);
    if (!ordered.length) return 0;
    const middle = Math.floor(ordered.length / 2);
    return Math.round(ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2);
  };
  const canonicalOutcome = (outcome: string): 'clean' | 'partial_fail' | 'fail' =>
    outcome === 'fail' ? 'fail' : outcome === 'partial_fail' ? 'partial_fail' : 'clean';
  const outcomeRank = (outcome: 'clean' | 'partial_fail' | 'fail' | null): number =>
    outcome === 'fail' ? 3 : outcome === 'partial_fail' ? 2 : outcome === 'clean' ? 1 : 0;
  const actionForCategory = (category: string | null): string => ({
    'raid-damage': 'Raid: entrad a vida alta y usad el defensivo personal asignado; healers, reservad un CD para el impacto.',
    'avoidable-ground': 'Raid: priorizad salir por la ruta acordada aunque haya que cortar un casteo; no apuréis GCD dentro de la zona.',
    soak: 'RL: fijad los grupos antes del pull; cada jugador debe comprobar su grupo y posición antes de esta señal.',
    spread: 'Raid: preposicionad la separación y dejad una salida libre; no improviséis el movimiento al recibir el target.',
    tankbuster: 'Tanks: anunciad mitigación y relevo; el resto, fuera del frontal para no añadir daño a la ventana.',
    'debuff-stack': 'RL: fijad el umbral de relevo o limpieza; jugadores, anunciad si llegáis a la ventana por encima de él.',
    interrupt: 'RL: confirmad orden y backup; el siguiente jugador debe cortar si el asignado no está disponible.',
    'healing-absorb': 'Healers: preparad sanación para retirar el absorb; raid, evitad solapar daño y usad personal si llegáis bajos.',
    'personal-target': 'Objetivos: salid por la ruta acordada; resto de la raid, no invadáis esa ruta ni persigáis al target.',
    enrage: 'RL: tratadla como límite del intento y confirmad antes de la ventana quién resuelve la mecánica especial.',
  } as Record<string, string>)[category ?? '']
    ?? 'Raid: usad la señal previa para llegar colocados; anunciad antes del impacto si falta una asignación o un recurso clave.';

  type ObservedTimelineEvent = {
    pullId: string;
    timeMs: number;
    mechanicName: string;
    normalizedName: string;
    wowheadSpellId: number | null;
    category: string | null;
    outcome: 'clean' | 'partial_fail' | 'fail';
    playersHit: number;
  };
  type ObservedDeathGroup = {
    pullId: string;
    timeMs: number;
    mechanicName: string | null;
    normalizedName: string | null;
    wowheadSpellId: number | null;
    category: string | null;
    deaths: number;
  };

  const timelinePatterns: NightFullReport['timelinePatterns'] = (() => {
    if (!progressBossGroup) return null;
    const progressPullIds = new Set(progressBossGroup.pulls.map((pull) => pull.id));

    // Varias filas pueden describir el mismo impacto/canalización. Se
    // compactan por habilidad y por instante para que el gráfico represente
    // momentos del combate, no filas internas del pipeline.
    const eventBuckets = new Map<string, MechEventLite[]>();
    for (const event of reportableMechEvents) {
      if (!progressPullIds.has(event.pull_id) || !Number.isFinite(event.trigger_time_ms)) continue;
      const bucket = Math.round(event.trigger_time_ms / 1_500);
      const key = `${event.pull_id}|${normalizeAbilityName(event.mechanic_name)}|${bucket}`;
      const entries = eventBuckets.get(key) ?? [];
      entries.push(event);
      eventBuckets.set(key, entries);
    }
    const observedEvents: ObservedTimelineEvent[] = [...eventBuckets.values()].map((entries) => {
      const representative = entries[0];
      const outcomes = entries.map((entry) => canonicalOutcome(entry.outcome));
      return {
        pullId: representative.pull_id,
        timeMs: medianRounded(entries.map((entry) => entry.trigger_time_ms)),
        mechanicName: representative.mechanic_name,
        normalizedName: normalizeAbilityName(representative.mechanic_name),
        wowheadSpellId: entries.find((entry) => entry.ability_id)?.ability_id ?? null,
        category: entries.find((entry) => entry.category)?.category ?? null,
        outcome: outcomes.sort((a, b) => outcomeRank(b) - outcomeRank(a))[0] ?? 'clean',
        playersHit: Math.max(0, ...entries.map((entry) => entry.players_hit ?? 0)),
      };
    });

    const deathRows = realDeaths
      .filter((record) => progressPullIds.has(record.pull_id) && Number.isFinite(record.death_cause?.timeMs))
      .map((record) => ({
        pullId: record.pull_id,
        timeMs: record.death_cause!.timeMs,
        mechanicName: record.death_cause!.mechanicName?.trim() || null,
        normalizedName: record.death_cause!.mechanicName ? normalizeAbilityName(record.death_cause!.mechanicName) : null,
        wowheadSpellId: record.death_cause!.mechanicId || null,
        category: record.death_cause!.category,
      }))
      .sort((a, b) => a.pullId.localeCompare(b.pullId) || a.timeMs - b.timeMs);

    const groupDeaths = (sameAbility: boolean): ObservedDeathGroup[] => {
      const grouped: ObservedDeathGroup[] = [];
      for (const death of deathRows) {
        const previous = grouped[grouped.length - 1];
        const sameKey = previous
          && previous.pullId === death.pullId
          && (!sameAbility || previous.normalizedName === death.normalizedName)
          && death.timeMs - previous.timeMs <= 2_000;
        if (sameKey) {
          previous.timeMs = medianRounded([previous.timeMs, death.timeMs]);
          previous.deaths++;
          if (!previous.mechanicName && death.mechanicName) {
            previous.mechanicName = death.mechanicName;
            previous.normalizedName = death.normalizedName;
            previous.wowheadSpellId = death.wowheadSpellId;
            previous.category = death.category;
          }
        } else {
          grouped.push({ ...death, deaths: 1 });
        }
      }
      return grouped;
    };
    const abilityDeathGroups = groupDeaths(true);
    const deathWaves = groupDeaths(false);

    type AnchorCandidate = {
      normalizedName: string;
      mechanicName: string;
      mechanicNameEs: string | null;
      wowheadSpellId: number | null;
      category: string | null;
      score: number;
      lethalFinalBlows: number;
    };
    const candidateByName = new Map<string, AnchorCandidate>();
    const upsertCandidate = (candidate: AnchorCandidate): void => {
      const current = candidateByName.get(candidate.normalizedName);
      if (!current) {
        candidateByName.set(candidate.normalizedName, candidate);
        return;
      }
      current.score += candidate.score;
      current.lethalFinalBlows = Math.max(current.lethalFinalBlows, candidate.lethalFinalBlows);
      current.mechanicNameEs ??= candidate.mechanicNameEs;
      current.wowheadSpellId ??= candidate.wowheadSpellId;
      current.category ??= candidate.category;
    };
    for (const lethal of finalBlowCounts.values()) {
      if (!lethal.isProgressBoss) continue;
      const normalizedName = normalizeAbilityName(lethal.mechanicName);
      const relatedEvent = observedEvents.find((event) => event.normalizedName === normalizedName);
      upsertCandidate({
        normalizedName,
        mechanicName: lethal.mechanicName,
        mechanicNameEs: lethal.mechanicNameEs,
        wowheadSpellId: lethal.wowheadSpellId ?? relatedEvent?.wowheadSpellId ?? null,
        category: relatedEvent?.category ?? null,
        score: lethal.count * 12,
        lethalFinalBlows: lethal.count,
      });
    }
    for (const mechanic of mechanics.filter((entry) => entry.isProgressBoss && entry.category !== 'interrupt')) {
      const normalizedName = normalizeAbilityName(mechanic.mechanicName);
      upsertCandidate({
        normalizedName,
        mechanicName: mechanic.mechanicName,
        mechanicNameEs: mechanic.mechanicNameEs,
        wowheadSpellId: mechanic.wowheadSpellId,
        category: mechanic.category,
        score: mechanic.totalFails * 3 + mechanic.pullsAffected * 2 + mechanic.lethalFinalBlows * 10,
        lethalFinalBlows: mechanic.lethalFinalBlows,
      });
    }

    type AnchorOccurrence = {
      pullId: string;
      timeMs: number;
      event: ObservedTimelineEvent | null;
      deaths: number;
    };
    type TimelineWithScore = NightTimeline & { score: number; normalizedName: string };
    const timelineCandidates: TimelineWithScore[] = [];

    for (const candidate of [...candidateByName.values()].sort((a, b) => b.score - a.score).slice(0, 5)) {
      const matchingDeaths = abilityDeathGroups.filter((group) => group.normalizedName === candidate.normalizedName);
      let occurrences: AnchorOccurrence[] = observedEvents
        .filter((event) => event.normalizedName === candidate.normalizedName)
        .filter((event) => candidate.lethalFinalBlows > 0 || event.outcome !== 'clean')
        .map((event) => ({
          pullId: event.pullId,
          timeMs: event.timeMs,
          event,
          deaths: matchingDeaths
            .filter((group) => group.pullId === event.pullId && Math.abs(group.timeMs - event.timeMs) <= 2_500)
            .reduce((sum, group) => sum + group.deaths, 0),
        }));
      // Los canales y auras pueden emitir varios ticks con el mismo nombre.
      // Dentro de un mismo pull se convierten en un solo momento si están a
      // menos de 15 s, conservando el peor resultado observado. La ventana
      // es suficientemente corta para no unir ciclos reales separados, pero
      // absorbe los ticks de canales y auras que vimos en los logs.
      const compactedOccurrences: AnchorOccurrence[] = [];
      for (const occurrence of occurrences.sort((a, b) => a.pullId.localeCompare(b.pullId) || a.timeMs - b.timeMs)) {
        const previous = compactedOccurrences[compactedOccurrences.length - 1];
        if (previous && previous.pullId === occurrence.pullId && occurrence.timeMs - previous.timeMs <= 15_000) {
          previous.timeMs = medianRounded([previous.timeMs, occurrence.timeMs]);
          previous.deaths = Math.max(previous.deaths, occurrence.deaths);
          if (outcomeRank(occurrence.event?.outcome ?? null) > outcomeRank(previous.event?.outcome ?? null)) previous.event = occurrence.event;
        } else {
          compactedOccurrences.push({ ...occurrence });
        }
      }
      occurrences = compactedOccurrences;
      for (const deathGroup of matchingDeaths) {
        if (occurrences.some((occurrence) => occurrence.pullId === deathGroup.pullId && Math.abs(occurrence.timeMs - deathGroup.timeMs) <= 2_500)) continue;
        occurrences.push({ pullId: deathGroup.pullId, timeMs: deathGroup.timeMs, event: null, deaths: deathGroup.deaths });
      }
      occurrences.sort((a, b) => a.timeMs - b.timeMs);
      if (!occurrences.length) continue;

      const clusters: AnchorOccurrence[][] = [];
      for (const occurrence of occurrences) {
        const current = clusters[clusters.length - 1];
        if (current && Math.abs(occurrence.timeMs - medianRounded(current.map((entry) => entry.timeMs))) <= TIMELINE_CLUSTER_GAP_MS) {
          current.push(occurrence);
        } else {
          clusters.push([occurrence]);
        }
      }

      for (const cluster of clusters) {
        // Una línea representa una ventana por pull. Si dentro de esa misma
        // ventana hubo varios ticks o golpes letales de la habilidad, se
        // agregan como evidencia del mismo momento, no como "momentos" extra.
        const occurrencesByPull = new Map<string, AnchorOccurrence[]>();
        for (const occurrence of cluster) {
          const entries = occurrencesByPull.get(occurrence.pullId) ?? [];
          entries.push(occurrence);
          occurrencesByPull.set(occurrence.pullId, entries);
        }
        const windowOccurrences: AnchorOccurrence[] = [...occurrencesByPull.entries()].map(([pullId, entries]) => ({
          pullId,
          timeMs: medianRounded(entries.map((entry) => entry.timeMs)),
          event: entries
            .map((entry) => entry.event)
            .filter((event): event is ObservedTimelineEvent => event != null)
            .sort((a, b) => outcomeRank(b.outcome) - outcomeRank(a.outcome))[0] ?? null,
          deaths: entries.reduce((sum, entry) => sum + entry.deaths, 0),
        }));
        const pullNumbers = [...new Set(windowOccurrences.map((occurrence) => pullById.get(occurrence.pullId)?.pull_number).filter((value): value is number => value != null))].sort((a, b) => a - b);
        const failures = windowOccurrences.filter((occurrence) => occurrence.event?.outcome === 'fail' || occurrence.event?.outcome === 'partial_fail').length;
        const lethalFinalBlows = windowOccurrences.reduce((sum, occurrence) => sum + occurrence.deaths, 0);
        if (pullNumbers.length < 2 && failures < 2 && lethalFinalBlows < 2) continue;

        type MarkerAccumulator = {
          kind: 'ability' | 'deaths';
          offsets: number[];
          mechanicName: string;
          mechanicNameEs: string | null;
          wowheadSpellId: number | null;
          outcome: 'clean' | 'partial_fail' | 'fail' | null;
          occurrences: Set<number>;
          playersHit: number;
          deaths: number;
          isAnchor: boolean;
        };
        const markerByKey = new Map<string, MarkerAccumulator>();
        const addMarker = (key: string, marker: Omit<MarkerAccumulator, 'occurrences'>, occurrenceIndex: number): void => {
          const current = markerByKey.get(key);
          if (current) {
            current.offsets.push(...marker.offsets);
            current.occurrences.add(occurrenceIndex);
            current.playersHit = Math.max(current.playersHit, marker.playersHit);
            current.deaths += marker.deaths;
            if (outcomeRank(marker.outcome) > outcomeRank(current.outcome)) current.outcome = marker.outcome;
          } else {
            markerByKey.set(key, { ...marker, occurrences: new Set([occurrenceIndex]) });
          }
        };

        // Un evento o una oleada solo se asigna a la instancia central más
        // cercana dentro del pull. Esto evita duplicar evidencia cuando un
        // canal produce varios ticks próximos.
        for (const event of observedEvents) {
          if (event.normalizedName === candidate.normalizedName) continue;
          const nearest = windowOccurrences
            .map((anchor, index) => ({ anchor, index, distance: Math.abs(event.timeMs - anchor.timeMs) }))
            .filter((entry) => entry.anchor.pullId === event.pullId && entry.distance <= Math.max(TIMELINE_BEFORE_MS, TIMELINE_AFTER_MS))
            .sort((a, b) => a.distance - b.distance)[0];
          if (!nearest) continue;
          const offsetMs = event.timeMs - nearest.anchor.timeMs;
          if (offsetMs < -TIMELINE_BEFORE_MS || offsetMs > TIMELINE_AFTER_MS) continue;
          const offsetBucket = Math.round(offsetMs / 3_000);
          addMarker(`ability|${event.normalizedName}|${offsetBucket}`, {
            kind: 'ability',
            offsets: [offsetMs],
            mechanicName: event.mechanicName,
            mechanicNameEs: mechanicNameEs(progressBossGroup.bossId, progressBossGroup.difficulty, event.mechanicName),
            wowheadSpellId: event.wowheadSpellId,
            outcome: event.outcome,
            playersHit: event.playersHit,
            deaths: 0,
            isAnchor: false,
          }, nearest.index);
        }
        for (const wave of deathWaves) {
          const nearest = windowOccurrences
            .map((anchor, index) => ({ anchor, index, distance: Math.abs(wave.timeMs - anchor.timeMs) }))
            .filter((entry) => entry.anchor.pullId === wave.pullId && entry.distance <= Math.max(TIMELINE_BEFORE_MS, TIMELINE_AFTER_MS))
            .sort((a, b) => a.distance - b.distance)[0];
          if (!nearest) continue;
          const offsetMs = wave.timeMs - nearest.anchor.timeMs;
          if (offsetMs < -TIMELINE_BEFORE_MS || offsetMs > TIMELINE_AFTER_MS) continue;
          const offsetBucket = Math.round(offsetMs / 3_000);
          addMarker(`deaths|${offsetBucket}`, {
            kind: 'deaths',
            offsets: [offsetMs],
            mechanicName: 'Caídas registradas',
            mechanicNameEs: null,
            wowheadSpellId: null,
            outcome: null,
            playersHit: 0,
            deaths: wave.deaths,
            isAnchor: false,
          }, nearest.index);
        }

        const anchorEvents = windowOccurrences.map((occurrence) => occurrence.event).filter((event): event is ObservedTimelineEvent => event != null);
        const anchorOutcome = anchorEvents.map((event) => event.outcome).sort((a, b) => outcomeRank(b) - outcomeRank(a))[0] ?? null;
        const anchorMarker: NightTimelineMarker = {
          kind: 'ability',
          offsetMs: 0,
          mechanicName: candidate.mechanicName,
          mechanicNameEs: candidate.mechanicNameEs,
          wowheadSpellId: candidate.wowheadSpellId,
          outcome: anchorOutcome,
          occurrences: windowOccurrences.length,
          playersHit: Math.max(0, ...anchorEvents.map((event) => event.playersHit)),
          deaths: lethalFinalBlows,
          isAnchor: true,
        };
        const eligibleMarkers = [...markerByKey.values()]
          .filter((marker) => marker.kind === 'deaths'
            || marker.outcome === 'fail'
            || marker.outcome === 'partial_fail'
            || marker.occurrences.size >= Math.max(2, Math.ceil(windowOccurrences.length * 0.6)))
          .map((marker) => ({
            kind: marker.kind,
            offsetMs: medianRounded(marker.offsets),
            mechanicName: marker.mechanicName,
            mechanicNameEs: marker.mechanicNameEs,
            wowheadSpellId: marker.wowheadSpellId,
            outcome: marker.outcome,
            occurrences: marker.occurrences.size,
            playersHit: marker.playersHit,
            deaths: marker.deaths,
            isAnchor: false,
            score: (marker.kind === 'deaths' ? 100 + marker.deaths * 5 : 0)
              + (marker.outcome === 'fail' ? 50 : marker.outcome === 'partial_fail' ? 30 : 0)
              + marker.occurrences.size * 4,
          }));
        // La infografía necesita una secuencia legible de un vistazo, no
        // todos los eventos de la ventana: hasta dos fallos-señal, la mayor
        // oleada de muertes y, si queda hueco, un evento repetido.
        const selectedContext = new Set<(typeof eligibleMarkers)[number]>();
        for (const marker of eligibleMarkers
          .filter((entry) => entry.kind === 'ability' && entry.outcome !== 'clean')
          .sort((a, b) => Math.abs(a.offsetMs) - Math.abs(b.offsetMs))
          .slice(0, 2)) selectedContext.add(marker);
        const strongestDeathWave = eligibleMarkers
          .filter((entry) => entry.kind === 'deaths')
          .sort((a, b) => b.deaths - a.deaths || Math.abs(a.offsetMs) - Math.abs(b.offsetMs))[0];
        if (strongestDeathWave) selectedContext.add(strongestDeathWave);
        const repeatedEvent = eligibleMarkers
          .filter((entry) => entry.kind === 'ability' && entry.outcome === 'clean')
          .sort((a, b) => b.occurrences - a.occurrences || Math.abs(a.offsetMs) - Math.abs(b.offsetMs))[0];
        if (selectedContext.size < 3 && repeatedEvent) selectedContext.add(repeatedEvent);
        const contextualMarkers = [...selectedContext]
          .sort((a, b) => a.offsetMs - b.offsetMs)
          .slice(0, 3)
          .map(({ score: _score, ...marker }) => marker);
        const precedingFailures = contextualMarkers
          .filter((marker) => marker.kind === 'ability' && marker.offsetMs < 0 && marker.outcome !== 'clean')
          .sort((a, b) => Math.abs(a.offsetMs) - Math.abs(b.offsetMs));
        const cue = precedingFailures.length
          ? `Señal: ${precedingFailures.map((marker) => marker.mechanicName).join(' + ')} ≈${Math.max(1, Math.round(Math.max(...precedingFailures.map((marker) => Math.abs(marker.offsetMs))) / 1_000))} s antes. `
          : '';
        const action = candidate.normalizedName.includes('final ascension')
          ? 'RL: asignad quién usa el siguiente Disgusting Fish y confirmad que está disponible; no es un kick estándar.'
          : candidate.normalizedName.includes('elemental explosion')
            ? 'Raid: terminad la interacción Fire/Frost, llegad estabilizados y usad el defensivo asignado en el impacto.'
            : actionForCategory(candidate.category);

        timelineCandidates.push({
          anchorMechanicName: candidate.mechanicName,
          anchorMechanicNameEs: candidate.mechanicNameEs,
          anchorWowheadSpellId: candidate.wowheadSpellId,
          anchorCategory: candidate.category,
          anchorCategoryLabel: candidate.category ? (MECHANIC_CATEGORY_LABEL[candidate.category] ?? candidate.category) : null,
          medianTimeMs: medianRounded(windowOccurrences.map((occurrence) => occurrence.timeMs)),
          occurrences: windowOccurrences.length,
          failures,
          lethalFinalBlows,
          pulls: pullNumbers,
          prepNote: `${cue}${action}`,
          markers: [...contextualMarkers, anchorMarker].sort((a, b) => a.offsetMs - b.offsetMs),
          score: lethalFinalBlows * 20 + failures * 6 + pullNumbers.length * 4 + windowOccurrences.length,
          normalizedName: candidate.normalizedName,
        });
      }
    }

    const selected: TimelineWithScore[] = [];
    const selectedPerAbility = new Map<string, number>();
    for (const timeline of timelineCandidates.sort((a, b) => b.score - a.score)) {
      if ((selectedPerAbility.get(timeline.normalizedName) ?? 0) >= 2) continue;
      selected.push(timeline);
      selectedPerAbility.set(timeline.normalizedName, (selectedPerAbility.get(timeline.normalizedName) ?? 0) + 1);
      if (selected.length >= 3) break;
    }
    if (!selected.length) return null;
    return {
      bossName: progressBossGroup.bossName,
      bossNameEs: progressBossGroup.bossNameEs,
      difficulty: progressBossGroup.difficulty,
      windowBeforeMs: TIMELINE_BEFORE_MS,
      windowAfterMs: TIMELINE_AFTER_MS,
      timelines: selected
        .sort((a, b) => a.medianTimeMs - b.medianTimeMs)
        .map(({ score: _score, normalizedName: _normalizedName, ...timeline }) => timeline),
    };
  })();

  // ---- 5. Supervivencia (healthstone/potion) ----
  const playersWithHealthstoneEver = new Set<string>();
  const playersWithObservedHealthstoneAccess = new Set<string>();
  const playersWithPotionEver = new Set<string>();
  const playersWithEitherConsumableEver = new Set<string>();
  const allPlayersTracked = new Set<string>();
  let hsDeathsEvaluable = 0;
  let hsDeathsWithObservedAccessNoRecentUse = 0;
  let deathsNoRecentEmergencyConsumable = 0;
  const usedRecentlyBeforeDeath = (timestampsMs: number[] | undefined, deathTimeMs: number): boolean =>
    (timestampsMs ?? []).some((timestamp) => timestamp <= deathTimeMs && timestamp >= deathTimeMs - EMERGENCY_CONSUMABLE_LOOKBACK_MS);
  for (const r of records) {
    allPlayersTracked.add(r.player_name);
    if (r.consumables?.healthstone?.available) playersWithObservedHealthstoneAccess.add(r.player_name);
    if (r.consumables?.healthstone?.used) playersWithHealthstoneEver.add(r.player_name);
    if (r.consumables?.healthPotion?.used) playersWithPotionEver.add(r.player_name);
    if (r.consumables?.healthstone?.used || r.consumables?.healthPotion?.used) playersWithEitherConsumableEver.add(r.player_name);
  }
  for (const r of realDeaths) {
    const hs = r.consumables?.healthstone;
    const deathTimeMs = r.death_cause!.timeMs;
    const usedHsRecently = usedRecentlyBeforeDeath(hs?.timestampsMs, deathTimeMs);
    const usedPotionRecently = usedRecentlyBeforeDeath(r.consumables?.healthPotion?.timestampsMs, deathTimeMs);
    if (hs?.available) {
      hsDeathsEvaluable++;
      if (!usedHsRecently) hsDeathsWithObservedAccessNoRecentUse++;
    }
    if (!usedHsRecently && !usedPotionRecently) deathsNoRecentEmergencyConsumable++;
  }
  const survival: NightFullReport['survival'] = {
    emergencyLookbackMs: EMERGENCY_CONSUMABLE_LOOKBACK_MS,
    healthstone: {
      playersEverUsed: playersWithHealthstoneEver.size,
      playersWithObservedAccess: playersWithObservedHealthstoneAccess.size,
      pctUsedAtLeastOnce: pct(playersWithHealthstoneEver.size, playersWithObservedHealthstoneAccess.size),
      deathsWithObservedAccessNoRecentUse: hsDeathsWithObservedAccessNoRecentUse,
      deathsEvaluable: hsDeathsEvaluable,
    },
    healthPotion: {
      playersEverUsed: playersWithPotionEver.size,
      totalPlayersTracked: allPlayersTracked.size,
      pctUsedAtLeastOnce: pct(playersWithPotionEver.size, allPlayersTracked.size),
    },
    either: {
      playersEverUsed: playersWithEitherConsumableEver.size,
      totalPlayersTracked: allPlayersTracked.size,
      pctUsedAtLeastOnce: pct(playersWithEitherConsumableEver.size, allPlayersTracked.size),
    },
    pctDeathsWithNoRecentEmergencyConsumable: pct(deathsNoRecentEmergencyConsumable, realDeaths.length),
  };

  // ---- 5. Defensivos personales, por categoría de mecánica ----
  const defByCategory = new Map<string, { evaluated: number; availableUnused: number }>();
  for (const r of realDeaths) {
    const dc = r.death_cause!;
    const cat = dc.category ?? 'sin-categoria';
    const opts = dc.defensiveOptions ?? [];
    if (!opts.length) continue;
    if (!defByCategory.has(cat)) defByCategory.set(cat, { evaluated: 0, availableUnused: 0 });
    const e = defByCategory.get(cat)!;
    e.evaluated++;
    if (opts.some((o) => o.status === 'available_unused')) e.availableUnused++;
  }
  const playersWithDefensiveEver = new Set<string>();
  let totalDefensiveCasts = 0;
  for (const r of records) {
    const casts = (r.defensive_casts ?? []).reduce((sum, defensive) => sum + defensive.timestampsMs.length, 0);
    totalDefensiveCasts += casts;
    if (casts > 0) playersWithDefensiveEver.add(r.player_name);
  }
  const totalCombatMinutes = summary.totalCombatTimeMs / 60_000;
  const defensives: NightFullReport['defensives'] = {
    playersEverUsed: playersWithDefensiveEver.size,
    totalPlayersTracked: allPlayersTracked.size,
    pctPlayersUsedAtLeastOnce: pct(playersWithDefensiveEver.size, allPlayersTracked.size),
    totalCasts: totalDefensiveCasts,
    castsPerCombatMinute: totalCombatMinutes > 0 ? Math.round((totalDefensiveCasts / totalCombatMinutes) * 10) / 10 : 0,
    globalAvailableUnusedPct: deaths.pctWithDefensiveAvailableUnused,
    availableUnusedCount: defensiveAvailableUnused,
    totalEvaluated: defensiveEvaluable,
    byCategory: [...defByCategory.entries()]
      .map(([category, e]) => ({ category, label: category === 'sin-categoria' ? 'Sin categoría' : (MECHANIC_CATEGORY_LABEL[category] ?? category), availableUnusedPct: pct(e.availableUnused, e.evaluated), evaluated: e.evaluated }))
      .sort((a, b) => b.evaluated - a.evaluated),
  };

  // ---- 6. Interrupciones ----
  const interruptEvents = reportableMechEvents.filter((ev) => ev.category === 'interrupt');
  const summarizeInterruptEvents = (events: MechEventLite[]) => {
    const interrupted = events.filter((event) => event.outcome === 'clean').length;
    const completedByMechanic = new Map<string, { wowheadSpellId: number | null; bossId: string; difficulty: string; count: number }>();
    for (const event of events) {
      if (event.outcome === 'clean') continue;
      const pull = pullById.get(event.pull_id);
      if (!pull) continue;
      if (!completedByMechanic.has(event.mechanic_name)) {
        completedByMechanic.set(event.mechanic_name, { wowheadSpellId: event.ability_id || null, bossId: pull.boss_id, difficulty: pull.difficulty, count: 0 });
      }
      completedByMechanic.get(event.mechanic_name)!.count++;
    }
    return {
      totalCasts: events.length,
      interrupted,
      pctSuccess: pct(interrupted, events.length),
      topUninterrupted: [...completedByMechanic.entries()]
        .map(([mechanicName, entry]) => ({
          mechanicName,
          mechanicNameEs: mechanicNameEs(entry.bossId, entry.difficulty, mechanicName),
          wowheadSpellId: entry.wowheadSpellId,
          note: mechanicNote(entry.bossId, entry.difficulty, mechanicName),
          completedCount: entry.count,
        }))
        .sort((a, b) => b.completedCount - a.completedCount)
        .slice(0, 5),
    };
  };
  const allInterrupts = summarizeInterruptEvents(interruptEvents);
  const progressInterrupts = progressBossGroup
    ? summarizeInterruptEvents(interruptEvents.filter((event) => {
        const pull = pullById.get(event.pull_id);
        return pull?.boss_id === progressBossGroup.bossId && pull.difficulty === progressBossGroup.difficulty;
      }))
    : null;
  const interrupts: NightFullReport['interrupts'] = {
    ...allInterrupts,
    excludedUnverifiedCasts: excludedUnverifiedInterruptCasts,
    progressBoss: progressBossGroup && progressInterrupts
      ? {
          bossName: progressBossGroup.bossName,
          bossNameEs: progressBossGroup.bossNameEs,
          difficulty: progressBossGroup.difficulty,
          ...progressInterrupts,
        }
      : null,
  };

  // ---- 7. Señales presentes en wipes (no exclusivas, no causales) ----
  const wipePatternCounts = new Map<string, number>();
  const WIPE_CASCADE_WINDOW_MS = 10_000;
  let wipesRecoveryEvaluable = 0;
  let wipesWithCascade = 0;
  const addWipePattern = (category: string): void =>
    wipePatternCounts.set(category, (wipePatternCounts.get(category) ?? 0) + 1);
  const wipedPulls = pulls.filter((p) => p.wipe_pct != null && p.wipe_pct > 0);
  for (const p of wipedPulls) {
    const pullDeaths = realDeaths.filter((r) => r.pull_id === p.id);
    if (!pullDeaths.length) {
      addWipePattern('sin_muertes_reales');
      continue;
    }
    wipesRecoveryEvaluable++;
    const orderedDeathTimes = pullDeaths.map((record) => record.death_cause!.timeMs).sort((a, b) => a - b);
    if (orderedDeathTimes.filter((timeMs) => timeMs <= orderedDeathTimes[0] + WIPE_CASCADE_WINDOW_MS).length >= 3) wipesWithCascade++;
    if (p.duration_ms && pullDeaths.some((r) => r.death_cause!.timeMs < p.duration_ms! / 2)) addWipePattern('muerte_primera_mitad');
    if (pullDeaths.some((r) => ['self_positioning', 'unsoaked_mechanic'].includes(normalizedRootCause(r)))) addWipePattern('mecanica_personal');
    if (pullDeaths.some((r) => r.death_cause!.category === 'tankbuster')) addWipePattern('tankbuster_letal');
    if (pullDeaths.some((r) => normalizedRootCause(r) === 'no_healing_received')) addWipePattern('dano_sostenido_sin_heal_6s');
    if (pullDeaths.every((r) => normalizedRootCause(r) === 'unclassified')) addWipePattern('solo_sin_causa_raiz');
  }
  const WIPE_PATTERN_LABEL: Record<string, string> = {
    muerte_primera_mitad: 'Alguna muerte real antes de la mitad del pull',
    mecanica_personal: 'Alguna muerte asociada a posicionamiento o soak',
    tankbuster_letal: 'Alguna muerte cuyo golpe final fue un tankbuster',
    dano_sostenido_sin_heal_6s: 'Daño sostenido sin sanación registrada en los 6 s previos',
    solo_sin_causa_raiz: 'Todas las muertes quedaron sin causa raíz demostrable',
    sin_muertes_reales: 'Wipe sin muertes reales evaluables',
  };
  const wipePatterns: NightFullReport['wipePatterns'] = [...wipePatternCounts.entries()]
    .map(([category, count]) => ({ category, label: WIPE_PATTERN_LABEL[category] ?? category, count, pct: pct(count, wipedPulls.length) }))
    .sort((a, b) => b.count - a.count);
  const wipeRecovery: NightFullReport['wipeRecovery'] = {
    windowMs: WIPE_CASCADE_WINDOW_MS,
    wipesEvaluable: wipesRecoveryEvaluable,
    wipesWithCascade,
    pctWipesWithCascade: pct(wipesWithCascade, wipesRecoveryEvaluable),
  };

  // ---- 8. Señales por función, acotadas al boss de progress ----
  const roleScopePulls = progressBossGroup?.pulls ?? pulls;
  const roleScopePullIds = new Set(roleScopePulls.map((pull) => pull.id));
  const roleScopeRecords = records.filter((record) => roleScopePullIds.has(record.pull_id));
  const roleScopeDeaths = realDeaths.filter((record) => roleScopePullIds.has(record.pull_id));
  const rolePlayers = {
    tank: new Set<string>(),
    healer: new Set<string>(),
    dps: new Set<string>(),
  };
  const defensiveUsersByRole = {
    tank: new Set<string>(),
    healer: new Set<string>(),
    dps: new Set<string>(),
  };
  const allRoleScopePlayers = new Set<string>();
  const classifiedRoleScopePlayers = new Set<string>();
  for (const record of roleScopeRecords) {
    allRoleScopePlayers.add(record.player_name);
    const role = raidRole(record.class, record.spec);
    if (!role) continue;
    classifiedRoleScopePlayers.add(record.player_name);
    rolePlayers[role].add(record.player_name);
    if ((record.defensive_casts ?? []).some((defensive) => defensive.timestampsMs.length > 0)) defensiveUsersByRole[role].add(record.player_name);
  }
  const deathsByRole: Record<RaidRole, number> = { tank: 0, healer: 0, dps: 0 };
  let tankbusterDeaths = 0;
  let nonTankTankbusterDeaths = 0;
  let personalMechanicDpsDeaths = 0;
  for (const record of roleScopeDeaths) {
    const role = raidRole(record.class, record.spec);
    if (!role) continue;
    deathsByRole[role]++;
    if (record.death_cause!.category === 'tankbuster') {
      if (role === 'tank') tankbusterDeaths++;
      else nonTankTankbusterDeaths++;
    }
    if (role === 'dps' && ['self_positioning', 'unsoaked_mechanic'].includes(normalizedRootCause(record))) personalMechanicDpsDeaths++;
  }
  const deathsPerPull = (role: RaidRole): number => roleScopePulls.length
    ? Math.round((deathsByRole[role] / roleScopePulls.length) * 10) / 10
    : 0;
  const roleInsights: NightFullReport['roleInsights'] = {
    scope: progressBossGroup
      ? { bossName: progressBossGroup.bossName, bossNameEs: progressBossGroup.bossNameEs, difficulty: progressBossGroup.difficulty, pulls: progressBossGroup.pulls.length }
      : null,
    classifiedPlayers: classifiedRoleScopePlayers.size,
    totalPlayers: allRoleScopePlayers.size,
    classificationCoveragePct: pct(classifiedRoleScopePlayers.size, allRoleScopePlayers.size),
    tanks: {
      players: rolePlayers.tank.size,
      deaths: deathsByRole.tank,
      deathsPerPull: deathsPerPull('tank'),
      playersUsingDefensive: defensiveUsersByRole.tank.size,
      tankbusterDeaths,
      nonTankTankbusterDeaths,
    },
    healers: {
      players: rolePlayers.healer.size,
      deaths: deathsByRole.healer,
      deathsPerPull: deathsPerPull('healer'),
      playersUsingDefensive: defensiveUsersByRole.healer.size,
      raidDeathsWithSustainedNoHealingSignal: roleScopeDeaths.filter((record) => normalizedRootCause(record) === 'no_healing_received').length,
    },
    dps: {
      players: rolePlayers.dps.size,
      deaths: deathsByRole.dps,
      deathsPerPull: deathsPerPull('dps'),
      playersUsingDefensive: defensiveUsersByRole.dps.size,
      personalMechanicDeaths: personalMechanicDpsDeaths,
    },
  };

  // ---- 9. Progresión: primera mitad de la noche vs segunda mitad (todos los pulls, cronológico) ----
  let progressionComparison: NightFullReport['progressionComparison'] = null;
  if (pulls.length >= 6 && bossGroups.size === 1) {
    const half = Math.ceil(pulls.length / 2);
    const firstHalfIds = new Set(pulls.slice(0, half).map((p) => p.id));
    const secondHalfIds = new Set(pulls.slice(half).map((p) => p.id));
    const sumAvoidable = (ids: Set<string>) => records.filter((r) => ids.has(r.pull_id)).reduce((s, r) => s + (r.avoidable_damage_taken ?? 0), 0);
    const countDeaths = (ids: Set<string>) => realDeaths.filter((r) => ids.has(r.pull_id)).length;
    const defCoverage = (ids: Set<string>): number | null => {
      const ds = realDeaths.filter((r) => ids.has(r.pull_id) && (r.death_cause!.defensiveOptions ?? []).length);
      const used = ds.filter((r) => !r.death_cause!.defensiveOptions!.some((o) => o.status === 'available_unused'));
      return ds.length ? pct(used.length, ds.length) : null;
    };
    const firstAvoidPerPull = sumAvoidable(firstHalfIds) / firstHalfIds.size;
    const secondAvoidPerPull = sumAvoidable(secondHalfIds) / secondHalfIds.size;
    const firstDeathsPerPull = countDeaths(firstHalfIds) / firstHalfIds.size;
    const secondDeathsPerPull = countDeaths(secondHalfIds) / secondHalfIds.size;
    const firstDefCov = defCoverage(firstHalfIds);
    const secondDefCov = defCoverage(secondHalfIds);
    progressionComparison = {
      sampleSize: pulls.length,
      avoidableDamageDeltaPct: hasCompleteAvoidableCoverage && firstAvoidPerPull > 0
        ? Math.round(((secondAvoidPerPull - firstAvoidPerPull) / firstAvoidPerPull) * 1000) / 10
        : null,
      deathsDeltaPct: firstDeathsPerPull > 0 ? Math.round(((secondDeathsPerPull - firstDeathsPerPull) / firstDeathsPerPull) * 1000) / 10 : null,
      defensiveCoverageDeltaPct: firstDefCov != null && secondDefCov != null ? Math.round((secondDefCov - firstDefCov) * 10) / 10 : null,
    };
  }

  // ---- 10. Prioridades y puntos positivos (reglas simples, sin LLM) ----
  const priorities: NightFullReport['priorities'] = [];
  const prioritizedMechanics = new Set<string>();
  const progressFinalBlows = [...finalBlowCounts.values()]
    .filter((entry) => entry.isProgressBoss)
    .sort((a, b) => b.count - a.count);
  const addLethalPriority = (lethal: (typeof progressFinalBlows)[number]): void => {
    const normalizedName = normalizeAbilityName(lethal.mechanicName);
    if (prioritizedMechanics.has(normalizedName)) return;
    const mechanicLabel = lethal.mechanicNameEs ? `${lethal.mechanicName} (${lethal.mechanicNameEs})` : lethal.mechanicName;
    const bossLabel = lethal.bossNameEs ? `${lethal.bossName} (${lethal.bossNameEs})` : lethal.bossName;
    priorities.push({
      title: `${mechanicLabel} — ${bossLabel}`,
      detail: `Aparece como golpe final registrado en ${lethal.count} muerte${lethal.count === 1 ? '' : 's'} durante ${progressBossGroup?.pulls.length ?? 0} pulls de progress.`,
      note: lethal.note,
    });
    prioritizedMechanics.add(normalizedName);
  };
  // La habilidad letal más repetida del boss actual siempre abre el foco.
  // No depende de que el pipeline haya podido convertirla también en un
  // evento de fallo mecánico.
  if (progressFinalBlows[0]) addLethalPriority(progressFinalBlows[0]);
  for (const topMechanic of mechanics.filter((mechanic) => mechanic.isProgressBoss && mechanic.category !== 'interrupt')) {
    if (priorities.length >= 2) break;
    const normalizedName = normalizeAbilityName(topMechanic.mechanicName);
    if (prioritizedMechanics.has(normalizedName)) continue;
    const mechanicLabel = topMechanic.mechanicNameEs ? `${topMechanic.mechanicName} (${topMechanic.mechanicNameEs})` : topMechanic.mechanicName;
    const bossLabel = topMechanic.bossNameEs ? `${topMechanic.bossName} (${topMechanic.bossNameEs})` : topMechanic.bossName;
    priorities.push({
      title: `${mechanicLabel} — ${bossLabel}`,
      detail: `Registró fallos en el ${topMechanic.pctPullsAffected}% de los pulls de ese boss (${topMechanic.pullsAffected}/${topMechanic.totalPulls})${topMechanic.lethalFinalBlows ? ` y aparece como golpe final en ${topMechanic.lethalFinalBlows} muerte${topMechanic.lethalFinalBlows === 1 ? '' : 's'}` : ''}.`,
      note: topMechanic.note,
    });
    prioritizedMechanics.add(normalizedName);
  }
  // Un golpe final del boss de progress es evidencia útil aunque esa habilidad
  // no haya generado una fila de fallo en pull_mechanic_events. Sin este
  // fallback, una habilidad letal como Elemental Explosion podía desaparecer
  // del foco y dejar paso a datos de bosses ya derrotados.
  for (const lethal of progressFinalBlows) {
    if (priorities.length >= 2) break;
    addLethalPriority(lethal);
  }
  const progressInterruptSummary = interrupts.progressBoss;
  if (priorities.length < 3 && progressInterruptSummary && progressInterruptSummary.totalCasts >= 3 && progressInterruptSummary.pctSuccess < 80) {
    priorities.push({
      title: 'Plan de interrupciones',
      detail: `${progressInterruptSummary.totalCasts - progressInterruptSummary.interrupted}/${progressInterruptSummary.totalCasts} casts verificables se completaron sin cortar en el boss de progress.`,
      note: progressInterruptSummary.topUninterrupted[0]?.note ?? null,
    });
  }
  if (priorities.length < 3 && survival.either.totalPlayersTracked >= 10 && survival.either.pctUsedAtLeastOnce < 50) {
    priorities.push({
      title: 'Recursos personales de emergencia',
      detail: `${survival.either.playersEverUsed}/${survival.either.totalPlayersTracked} jugadores registraron al menos un uso de healthstone o health potion durante la noche.`,
      note: null,
    });
  }

  const goodPoints: string[] = [];
  if (totalKills > 0) goodPoints.push(`${totalKills} kill${totalKills === 1 ? '' : 's'} esta noche.`);
  if (interrupts.totalCasts >= 5 && interrupts.pctSuccess >= 80) goodPoints.push(`Interrupciones al ${interrupts.pctSuccess}% de éxito (${interrupts.interrupted}/${interrupts.totalCasts}).`);
  if (defensives.totalPlayersTracked >= 10 && defensives.playersEverUsed === defensives.totalPlayersTracked) {
    goodPoints.push(`Todos los jugadores registrados usaron al menos una herramienta defensiva del catálogo durante la noche (${defensives.playersEverUsed}/${defensives.totalPlayersTracked}).`);
  }
  const improvingMechanics = mechanics.filter((m) => m.trend === 'improving');
  if (improvingMechanics.length) goodPoints.push(`${improvingMechanics.length} mecánica${improvingMechanics.length === 1 ? '' : 's'} mejorando claramente durante la noche (${improvingMechanics.map((m) => m.mechanicName).join(', ')}).`);
  if (progressionComparison && progressionComparison.avoidableDamageDeltaPct != null && progressionComparison.avoidableDamageDeltaPct < -10) {
    goodPoints.push(`El daño evitable bajó un ${Math.abs(progressionComparison.avoidableDamageDeltaPct)}% entre la primera y la segunda mitad de la noche.`);
  }

  const measuredRaidDamageTotal = pulls
    .filter((p) => measuredAvoidableScopes.has(`${p.boss_id}|${p.difficulty}`))
    .reduce((sum, p) => sum + (p.raid_damage_taken_series?.points ?? []).reduce((pointSum, point) => pointSum + point, 0), 0);

  return {
    schemaVersion: 7,
    reportCode,
    reportTitle: (reportResult.data as { title: string } | null)?.title ?? reportCode,
    reportDate: (reportResult.data as { start_time: number } | null)?.start_time ? new Date((reportResult.data as { start_time: number }).start_time).toISOString() : '',
    summary,
    avoidableDamage: hasAnyConfirmedAvoidable
      ? {
          total: totalAvoidableDamage,
          perMinute: pulls
            .filter((p) => measuredAvoidableScopes.has(`${p.boss_id}|${p.difficulty}`))
            .reduce((sum, p) => sum + (p.duration_ms ?? 0), 0) > 0
            ? Math.round(
                (totalAvoidableDamage /
                  (pulls
                    .filter((p) => measuredAvoidableScopes.has(`${p.boss_id}|${p.difficulty}`))
                    .reduce((sum, p) => sum + (p.duration_ms ?? 0), 0) /
                    60_000)) *
                  10,
              ) / 10
            : 0,
          pctOfRaidDamage: measuredRaidDamageTotal > 0 ? pct(totalAvoidableDamage, measuredRaidDamageTotal) : null,
          measuredBossScopes: measuredAvoidableScopes.size,
          totalBossScopes: activeBossScopes.size,
          complete: hasCompleteAvoidableCoverage,
        }
      : null,
    mechanics,
    timelinePatterns,
    deaths,
    survival,
    defensives,
    interrupts,
    wipePatterns,
    wipeRecovery,
    roleInsights,
    progressionComparison,
    priorities,
    goodPoints,
    notAvailable: [
      ...(!hasAnyConfirmedAvoidable ? ['Daño evitable — ningún boss de esta noche tiene "Evitable" confirmado todavía en Ajustes, así que no hay nada que sumar (no es que la noche fuera limpia)'] : []),
      ...(hasAnyConfirmedAvoidable && !hasCompleteAvoidableCoverage
        ? [`Daño evitable de toda la noche — solo hay cobertura en ${measuredAvoidableScopes.size} de ${activeBossScopes.size} combinaciones boss/dificultad; el total mostrado corresponde únicamente al ámbito medido`]
        : []),
      ...(bossNameEsByBossId.size < new Set(pulls.map((p) => p.boss_id)).size
        ? ['Traducción castellana de algunos bosses — Blizzard no devolvió una localización para todos; se conserva el nombre inglés sin inventar una traducción']
        : []),
      ...(bossGroups.size > 1
        ? ['Comparativa global entre primera y segunda mitad — la noche contiene bosses o dificultades distintas y compararlos directamente produciría una tendencia engañosa; las tendencias de mecánicas sí se calculan dentro de cada boss+dificultad']
        : []),
      ...(excludedUnverifiedInterruptCasts > 0
        ? [`Interrupciones inferidas solo por texto — se excluyeron ${excludedUnverifiedInterruptCasts} casts históricos sin confirmación manual ni evidencia observada como Interrupt`]
        : []),
      'Fases del encuentro (WCL las tiene, esta app no las importa todavía)',
      'Planificación y cobertura de cooldowns de raid (Barrier, Devotion Aura, Rallying Cry...) — algunos casts pueden constar para quien los lanzó, pero falta un modelo raid-wide de destinatarios y ventanas asignadas',
      'Battle Res / Combat Res — sin ingestión de eventos de resurrección',
      'Bloodlust/Heroism — sin ingestión de ese buff',
      'Dispels — sin ingestión de eventos de dispel',
      'Consumibles de buff (flask/food/weapon oil/augment rune) — sin ingestión de esos buffs',
      'Prioridad de objetivos/adds — sin modelo de adds/targets',
    ],
  };
}
