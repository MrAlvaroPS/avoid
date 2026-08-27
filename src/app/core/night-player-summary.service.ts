// Colocar en: src/app/core/night-player-summary.service.ts
// §"un resumen de una noche... para poder dirigir a uno o varios raiders"
// (feedback real): cruce nuevo que no existía en ningún sitio — jugador ×
// NOCHE completa (report_code), distinto de Roster (jugador × 60 días),
// "todos los pulls" (boss × toda la historia) y el detalle de jugador
// (jugador × toda la historia). Un dosier de personaje para esa noche
// concreta: qué hizo, cómo murió, patrones repetidos, y gear/talentos/
// enlaces para poder hablar con esa persona con todo el contexto delante.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { ReliabilityService, type PlayerReliability, type ReliabilityBreakdown } from './reliability.service';
import { WowauditRosterService, type WowauditRosterEntry } from './wowaudit-roster.service';
import { PERSONAL_RESPONSIBILITY_CATEGORIES, mapBrief } from './pull-analysis.service';
import { loadMechanicNotesByName } from './mechanic-notes';
import { mechanicDisplayName } from '../shared/format.util';
import type { DeathCause, MechanicCategory, PlayerPullRecordRow, PullMechanicEventRow, PullRow, WclGearItem } from '../shared/models/domain';
import type { LlmPullAnalysis } from '../shared/models/ui';
import { isDeathExcludedFromStatistics, isMechanicExcludedByWipeCall } from '../shared/death-statistics.util';
import { gearPreparationCounts } from '../shared/gear-preparation.util';
import { withSupabaseRelationFallback } from '../shared/supabase-query.util';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface NightPullSummary {
  pullId: string;
  pullNumber: number;
  bossId: string;
  bossName: string;
  difficulty: string;
  kill: boolean;
  wipePct: number | null;
  durationMs: number | null;
  closedAt: string;
  died: boolean;
}

export interface NightDeathRow {
  pullId: string;
  bossName: string;
  pullNumber: number;
  timeMs: number;
  mechanicName: string | null;
  /** §"un tooltip con la descripción de la habilidad, como en otras partes de la app" (feedback real): ability_id REAL de WCL para envolver el nombre en app-wowhead-link — null solo si WCL ni siquiera lo dio (rarísimo). */
  mechanicId: number | null;
  category: MechanicCategory | null;
  rootCause: DeathCause['rootCause'];
  /** §"que lo pueda usar efectiva y realmente porque lo tenga en sus habilidades y no esté en CD" (feedback real): exactamente status==='available_unused' — lo tiene en su catálogo real de clase/spec/talentos (defensivesForClass en analyze-report) Y no estaba en cooldown Y no lo tenía ya activo. Lista completa (no solo sí/no) para pintar los iconos reales. */
  defensivesAvailable: { spellId: number; name: string }[];
  isWipeCall: boolean;
  /** §"un ninja pull... también cuenta en la estadística de wipes": true = esta muerte ocurrió en un pull que analyze-report marcó como ninja pull (ver pulls.ninja_pull_excluded) — se sigue mostrando como contexto, pero no cuenta en totalDeaths ni en patrones repetidos. */
  isNinjaPull: boolean;
  statisticalExclusionReason: DeathCause['statisticalExclusionReason'];
  /** Uso registrado en cualquier momento del try. Es una observación factual; las muertes no evaluables siguen excluidas de estadísticas. */
  usedHealthstoneInPull: boolean;
  usedHealthPotionInPull: boolean;
  /** §"poner una 'I' de información junto a la mecánica con la nota descriptiva que haya traído la IA" (feedback real): solo la nota, cruzada por nombre — null si esta mecánica no tiene ai_classification en el manifiesto. */
  aiNote: string | null;
}

export interface NightMechanicFailRow {
  pullId: string;
  bossName: string;
  pullNumber: number;
  mechanicName: string;
  mechanicId: number;
  category: MechanicCategory | null;
  outcome: 'partial_fail' | 'fail';
  timeMs: number;
  damageTaken: number;
  aiNote: string | null;
}

export interface NightRepeatedPattern {
  mechanicName: string;
  mechanicId: number | null;
  category: MechanicCategory | null;
  instanceCount: number;
  distinctBossCount: number;
  bossNames: string[];
  aiNote: string | null;
}

export interface NightGearSnapshot {
  fromPullNumber: number;
  bossName: string;
  class: string | null;
  spec: string | null;
  talents: { spellId: number; rank: number }[];
  talentUnresolvedCount: number;
  gear: { slot: number; itemId: number; itemLevel: number }[];
  enchantedSlotCount: number;
  enchantableSlotCount: number;
  gemmedSlotCount: number;
  gemmableSlotCount: number;
  gemCount: number;
}

export interface NightPlayerSummary {
  playerName: string;
  reportCode: string;
  reportTitle: string;
  reportDate: string;
  roster: WowauditRosterEntry | null;
  reliability: PlayerReliability | null;
  /** §"fiabilidad debería tener 2 valores: 60 días y de la noche" (feedback real): misma fórmula, acotada a los pulls de ESTE report_code. sampleSize=0 = sin ningún pull evaluable esa noche (no debería pasar si llegó hasta aquí, pero por si acaso). */
  nightReliability: (ReliabilityBreakdown & { sampleSize: number }) | null;
  pulls: NightPullSummary[];
  totalDeaths: number;
  totalMechanicFails: number;
  deaths: NightDeathRow[];
  mechanicFails: NightMechanicFailRow[];
  repeatedPatterns: NightRepeatedPattern[];
  gearSnapshot: NightGearSnapshot | null;
  battleNetUrl: string | null;
  raiderIoUrl: string | null;
  /** §"meter en el dosier de un jugador... la consulta de IA" (feedback real): cacheado desde night_player_briefs, null si nunca se ha generado. */
  brief: LlmPullAnalysis | null;
}

// §"región... viene en wowaudit" — wowaudit no da región, pero esta guild es
// EU de siempre (mismo dato ya hardcodeado en el header de la app,
// app.html: "Sanguino · EU") — no hay wowaudit_roster.region que leer.
const REGION = 'eu';

const MECHANIC_EVENT_FIELDS = 'pull_id, ability_id, mechanic_name, category, outcome, trigger_time_ms, player_hit_details';

async function loadPlayerMechanicEvents(client: SupabaseClient, pullIds: string[], playerName: string) {
  const query = (relation: string) => client
    .from(relation)
    .select(MECHANIC_EVENT_FIELDS)
    .in('pull_id', pullIds)
    .neq('outcome', 'clean')
    .contains('players_hit_names', [playerName]);

  // Compatibilidad durante despliegues escalonados: la vista nueva aplica el
  // filtro de dificultad en servidor. Hasta que exista, conservamos el dosier
  // con los eventos base; las exclusiones por wipe call aún se aplican abajo.
  return withSupabaseRelationFallback(
    'applicable_pull_mechanic_events',
    () => query('applicable_pull_mechanic_events'),
    () => query('pull_mechanic_events'),
  );
}

function slugifyRealm(realm: string): string {
  return realm
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '') // fuera de ASCII tras NFKD = marcas diacríticas
    .toLowerCase()
    // §mismo bug real encontrado en blizzard-client.ts (verificado: solo
    // 18/30 avatares resolvían) — el slug oficial ELIMINA el apóstrofe
    // ("C'Thun" -> "cthun"), no lo convierte en guión.
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

@Injectable({ providedIn: 'root' })
export class NightPlayerSummaryService {
  private supabase = inject(SupabaseService);
  private reliability = inject(ReliabilityService);
  private wowauditRoster = inject(WowauditRosterService);

  async load(reportCode: string, playerName: string): Promise<NightPlayerSummary> {
    const client = this.supabase.client;

    const [{ data: reportRow }, { data: pullsData, error: pullsErr }, { data: encounters }] = await Promise.all([
      client.from('reports').select('title, start_time').eq('code', reportCode).maybeSingle(),
      client.from('pulls').select('*').eq('report_code', reportCode).order('fight_id', { ascending: true }),
      client.from('report_encounters').select('fight_id, boss_name').eq('report_code', reportCode),
    ]);
    if (pullsErr) throw pullsErr;

    const bossNameByFightId = new Map(((encounters ?? []) as { fight_id: number; boss_name: string }[]).map((e) => [e.fight_id, e.boss_name]));
    const allPulls = (pullsData ?? []) as (PullRowLite & { fight_id: number })[];
    const pullIds = allPulls.map((p) => p.id);

    const [{ data: recordsData, error: recordsErr }, { data: mechEventsData, error: mechErr }, roster, reliabilityList, notesByMechanicName, { data: briefRow }] = await Promise.all([
      pullIds.length
        ? client.from('player_pull_records').select('*').in('pull_id', pullIds).eq('player_name', playerName)
        : Promise.resolve({ data: [] as PlayerPullRecordRow[], error: null }),
      pullIds.length
        ? loadPlayerMechanicEvents(client, pullIds, playerName)
        : Promise.resolve({ data: [] as MechEventRowLite[], error: null }),
      this.wowauditRoster.listRoster().catch(() => []),
      this.reliability.listPlayerReliability().catch(() => []),
      loadMechanicNotesByName(client, allPulls.map((p) => p.boss_id)).catch(() => new Map<string, string>()),
      client.from('night_player_briefs').select('*').eq('report_code', reportCode).eq('player_name', playerName).maybeSingle(),
    ]);
    const nightReliability = await this.reliability.getNightReliability(reportCode, playerName).catch(() => null);
    if (recordsErr) throw recordsErr;
    if (mechErr) throw mechErr;

    const records = (recordsData ?? []) as PlayerPullRecordRow[];
    const recordByPullId = new Map(records.map((r) => [r.pull_id, r]));
    const pullById = new Map(allPulls.map((p) => [p.id, p]));
    const bossOrder = new Map<string, number>();
    for (const pull of allPulls) {
      if (!bossOrder.has(pull.boss_id)) bossOrder.set(pull.boss_id, bossOrder.size);
    }

    // Solo los pulls donde este jugador de verdad participó (tiene fila en
    // player_pull_records) — un report puede tener bosses/pulls donde
    // estuvo de bench, no tiene sentido enseñarlos en su dosier.
    const pulls: NightPullSummary[] = allPulls
      .filter((p) => recordByPullId.has(p.id))
      .map((p) => {
        const r = recordByPullId.get(p.id)!;
        return {
          pullId: p.id,
          pullNumber: p.pull_number,
          bossId: p.boss_id,
          bossName: bossNameByFightId.get(p.fight_id) ?? `Boss ${p.boss_id}`,
          difficulty: p.difficulty,
          kill: p.wipe_pct === 0,
          wipePct: p.wipe_pct,
          durationMs: p.duration_ms,
          closedAt: p.closed_at,
          died: r.died,
        };
      });

    // §"esa gente no debería... contar como muerte, marcado como wipe
    // call" — mismo criterio que ya rige el resto de la app.
    const deaths: NightDeathRow[] = records
      .filter((r) => r.died && r.death_cause)
      .map((r) => {
        const pull = pullById.get(r.pull_id)!;
        const dc = r.death_cause!;
        const isWipeCall = r.wipe_call_cluster && pull.wipe_call_excluded;
        const isNinjaPull = pull.ninja_pull_excluded;
        const excludedFromStatistics = isDeathExcludedFromStatistics(pull as PullRow, r);
        return {
          pullId: r.pull_id,
          bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
          pullNumber: pull.pull_number,
          timeMs: dc.timeMs,
          // §"unknown ability pon: unknown cause - WC" (feedback real):
          // transformado aquí, en el ORIGEN — así todo lo que se construye a
          // partir de esta fila (la propia tabla de Muertes, y sobre todo
          // repeatedPatterns más abajo, que agrupa por este mismo string)
          // hereda el nombre legible sin tener que acordarse de envolverlo
          // en cada sitio donde se use.
          mechanicName: mechanicDisplayName(dc.mechanicName),
          mechanicId: dc.mechanicId || null,
          category: dc.category ?? null,
          rootCause: dc.rootCause,
          defensivesAvailable: excludedFromStatistics ? [] : (dc.defensiveOptions ?? []).filter((o) => o.status === 'available_unused').map((o) => ({ spellId: o.spellId, name: o.name })),
          isWipeCall,
          isNinjaPull,
          statisticalExclusionReason: dc.statisticalExclusionReason ?? null,
          usedHealthstoneInPull: r.consumables?.healthstone?.used === true || (r.consumables?.healthstone?.timestampsMs?.length ?? 0) > 0,
          usedHealthPotionInPull: r.consumables?.healthPotion?.used === true || (r.consumables?.healthPotion?.timestampsMs?.length ?? 0) > 0,
          aiNote: (dc.mechanicName && notesByMechanicName.get(dc.mechanicName)) || null,
        };
      })
      .sort((a, b) => {
        const aPull = pullById.get(a.pullId)!;
        const bPull = pullById.get(b.pullId)!;
        return (bossOrder.get(aPull.boss_id) ?? 0) - (bossOrder.get(bPull.boss_id) ?? 0) || a.pullNumber - b.pullNumber || a.timeMs - b.timeMs;
      });

    // §"mecánicas falladas... a quién dirigir" a nivel de una noche entera:
    // mismo criterio que buildMechanicFails (categorías de responsabilidad
    // individual, o sin clasificar todavía) — no se descarta una muerte ya
    // cubierta arriba, para no duplicar la misma instancia dos veces.
    const evaluatedDeaths = deaths.filter((death) => !death.isWipeCall && !death.isNinjaPull && !death.statisticalExclusionReason);
    const mechanicFails: NightMechanicFailRow[] = ((mechEventsData ?? []) as MechEventRowLite[])
      .filter((ev) => {
        const pull = pullById.get(ev.pull_id);
        return pull != null && !pull.ninja_pull_excluded && !isMechanicExcludedByWipeCall(pull as PullRow, ev as PullMechanicEventRow);
      })
      .filter((ev) => ev.category == null || PERSONAL_RESPONSIBILITY_CATEGORIES.has(ev.category))
      .map((ev) => {
        const pull = pullById.get(ev.pull_id)!;
        const detail = ev.player_hit_details.find((d) => d.name === playerName);
        return {
          pullId: ev.pull_id,
          bossName: bossNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`,
          pullNumber: pull.pull_number,
          mechanicName: ev.mechanic_name,
          mechanicId: ev.ability_id,
          category: ev.category,
          outcome: ev.outcome as 'partial_fail' | 'fail',
          timeMs: ev.trigger_time_ms,
          damageTaken: detail?.damage_taken ?? 0,
          aiNote: notesByMechanicName.get(ev.mechanic_name) ?? null,
        };
      })
      .filter((row) => !evaluatedDeaths.some((death) => death.pullId === row.pullId && death.mechanicId === row.mechanicId && Math.abs(death.timeMs - row.timeMs) <= 4000))
      .sort((a, b) => {
        const aPull = pullById.get(a.pullId)!;
        const bPull = pullById.get(b.pullId)!;
        return (bossOrder.get(aPull.boss_id) ?? 0) - (bossOrder.get(bPull.boss_id) ?? 0) || a.pullNumber - b.pullNumber || a.timeMs - b.timeMs;
      });

    // §"patrones repetidos esa noche concreta... murió 3 veces a zona
    // evitable en 3 bosses distintos" — agrega muertes+fallos por mecánica,
    // sin distinguir cuál de las dos listas viene cada instancia (para el
    // patrón da igual si murió o solo la falló sin morir).
    // evaluatedDeaths ya aplica exactamente este mismo filtro (wipe call +
    // ninja pull + exclusión estadística) — reusarlo en vez de repetirlo
    // evita que un tercer sitio se olvide de alguna de las tres exclusiones.
    const patternSource = [
      ...evaluatedDeaths.map((d) => ({ mechanicName: d.mechanicName ?? 'Sin identificar', mechanicId: d.mechanicId, category: d.category, bossName: d.bossName })),
      ...mechanicFails.map((f) => ({ mechanicName: f.mechanicName, mechanicId: f.mechanicId as number | null, category: f.category, bossName: f.bossName })),
    ];
    const byMechanic = new Map<string, { mechanicId: number | null; category: MechanicCategory | null; bosses: Set<string>; count: number }>();
    for (const p of patternSource) {
      if (!byMechanic.has(p.mechanicName)) byMechanic.set(p.mechanicName, { mechanicId: p.mechanicId, category: p.category, bosses: new Set(), count: 0 });
      const entry = byMechanic.get(p.mechanicName)!;
      entry.bosses.add(p.bossName);
      entry.count++;
    }
    const repeatedPatterns: NightRepeatedPattern[] = [...byMechanic.entries()]
      .map(([mechanicName, e]) => ({
        mechanicName,
        mechanicId: e.mechanicId,
        category: e.category,
        instanceCount: e.count,
        distinctBossCount: e.bosses.size,
        bossNames: [...e.bosses],
        aiNote: notesByMechanicName.get(mechanicName) ?? null,
      }))
      .filter((p) => p.instanceCount >= 2) // un fallo suelto no es un "patrón" de la noche
      .sort((a, b) => b.instanceCount - a.instanceCount);

    // §"gear, talentos, si tiene puestas las gemas y enchants": snapshot del
    // ÚLTIMO pull de la noche — es "cómo estaba equipado esta noche", no un
    // acumulado histórico.
    const lastPull = [...pulls].sort((a, b) => b.closedAt.localeCompare(a.closedAt))[0] ?? null;
    const lastRecord = lastPull ? recordByPullId.get(lastPull.pullId) : null;
    const gearSnapshot: NightGearSnapshot | null = lastPull && lastRecord ? this.buildGearSnapshot(lastPull, lastRecord) : null;

    const rosterEntry = roster.find((r) => r.name === playerName) ?? null;
    const reliabilityEntry = reliabilityList.find((r) => r.playerName === playerName) ?? null;

    const realmSlug = rosterEntry ? slugifyRealm(rosterEntry.realm) : null;
    const nameSlug = playerName.toLowerCase();
    const battleNetUrl = realmSlug ? `https://worldofwarcraft.blizzard.com/en-us/character/${REGION}/${realmSlug}/${nameSlug}` : null;
    const raiderIoUrl = realmSlug ? `https://raider.io/characters/${REGION}/${realmSlug}/${nameSlug}` : null;

    return {
      playerName,
      reportCode,
      reportTitle: (reportRow as { title: string } | null)?.title ?? reportCode,
      reportDate: (reportRow as { start_time: number } | null)?.start_time ? new Date((reportRow as { start_time: number }).start_time).toISOString() : '',
      roster: rosterEntry,
      reliability: reliabilityEntry,
      nightReliability,
      pulls,
      totalDeaths: evaluatedDeaths.length,
      totalMechanicFails: mechanicFails.length,
      deaths,
      mechanicFails,
      repeatedPatterns,
      gearSnapshot,
      battleNetUrl,
      raiderIoUrl,
      brief: briefRow ? mapBrief(briefRow as unknown as Parameters<typeof mapBrief>[0]) : null,
    };
  }

  private buildGearSnapshot(pull: NightPullSummary, record: PlayerPullRecordRow): NightGearSnapshot {
    const items = (record.equipped_items ?? []) as (WclGearItem | null)[];
    const preparation = gearPreparationCounts(items);
    return {
      fromPullNumber: pull.pullNumber,
      bossName: pull.bossName,
      class: record.class,
      spec: record.spec,
      talents: (record.talent_build ?? []).filter((t): t is { id: number; rank: number; nodeID: number; spellId: number } => typeof t.spellId === 'number').map((t) => ({ spellId: t.spellId, rank: t.rank })),
      talentUnresolvedCount: (record.talent_build ?? []).filter((t) => typeof t.spellId !== 'number').length,
      gear: items.map((item, slot) => ({ slot, itemId: item?.id ?? 0, itemLevel: item?.itemLevel ?? 0 })).filter((g) => g.itemId > 0),
      ...preparation,
    };
  }
}

interface PullRowLite {
  id: string;
  fight_id: number;
  boss_id: string;
  difficulty: string;
  pull_number: number;
  wipe_pct: number | null;
  duration_ms: number | null;
  closed_at: string;
  wipe_call_excluded: boolean;
  wipe_call_signals: Record<string, number | boolean | null> | null;
  ninja_pull_excluded: boolean;
}

interface MechEventRowLite {
  pull_id: string;
  ability_id: number;
  mechanic_name: string;
  category: MechanicCategory | null;
  outcome: string;
  trigger_time_ms: number;
  player_hit_details: { name: string; damage_taken: number; damage_hits: number; healing_received: number; used_defensive_spell_id: number | null }[];
}
