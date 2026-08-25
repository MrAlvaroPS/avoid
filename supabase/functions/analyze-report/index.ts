import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  getFightEvents,
  getFightGraph,
  getFightPlayerRoles,
  sumGraphSeries,
  getFightPlayerRankings,
  getReportAbilities,
  getReportActors,
  getReportFights,
  isEncounterFight,
  type WclActor,
} from '../_shared/wcl-client.ts';
import { activeDefensives, defensivesForClass, type CooldownCatalog, type TalentGate } from '../_shared/defensive-cooldowns.ts';
import { getItemName, getSpecName, getCurrentBuildNamespace } from '../_shared/blizzard-client.ts';
import { buildFromBlizzardNamespace, fetchTalentSpellLookup } from '../_shared/wago-db2-client.ts';
import { resolveConsumableAbilityIds, buildConsumableUsage } from '../_shared/consumables.ts';
import { normalizeAbilityName, buildAbilityIdsByName } from '../_shared/ability-name-match.ts';
import { upsertReportEncounters } from '../_shared/report-encounters.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

// "Engancharse a los pulls": trae fights nuevos de WCL y genera `pulls` +
// `player_pull_records` reales. A PROPÓSITO no llama al LLM aquí — eso es
// generate-pull-brief, una función aparte. Motivo: un log histórico puede
// traer decenas de pulls de golpe, y traer los eventos de cada uno (Deaths +
// DamageTaken, hasta 20 páginas cada uno) ya tarda; si además hubiera que
// esperar una respuesta del LLM por cada uno en la misma llamada HTTP, el
// fetch del navegador acaba abortando ("Failed to send a request to the Edge
// Function") mucho antes de terminar. Por eso esta función procesa como
// mucho `maxFights` fights nuevos y devuelve `remaining` — el cliente la
// llama en bucle hasta ponerse al día (funciona igual para un log en vivo
// que para el de ayer con 30 pulls), y solo pide un brief para el pull más
// reciente que haya quedado procesado, no para todos.

const WCL_DIFFICULTY_NAME_BY_ID: Record<number, string> = { 1: 'LFR', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };
const DEFAULT_MAX_FIGHTS_PER_CALL = 3;

// Orden de inventario estándar de WoW: los slots de trinket son los índices
// 12 y 13 del array `gear` de combatantInfo (verificado en real el
// 2026-08-22 contra un pull real: índice 12 traía icono "raidtrinkets").
// Repetido aquí y en pull-analysis.service.ts (Deno vs. navegador, runtimes
// distintos, no comparten módulo) — si cambia, cambia en los dos sitios.
const TRINKET_SLOT_INDICES = [12, 13];

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
  absorbed?: number;
  buffs?: string;
}
interface CastEvent {
  timestamp?: number;
  abilityGameID?: number;
  sourceID?: number;
}
interface ThroughputEvent {
  sourceID?: number;
  amount?: number;
  // targetID/timestamp no se usaban antes (solo hacía falta sourceID+amount
  // para el agregado de dps/hps) — WCL ya los trae en el JSON crudo, se
  // exponen aquí para §10 (rootCause 'no_healing_received': hace falta saber
  // A QUIÉN curó cada tick, no solo cuánto curó cada sanador en total).
  targetID?: number;
  timestamp?: number;
}
interface CombatantInfoEvent {
  sourceID?: number;
  specID?: number;
  // OJO: `talents` (verificado en real el 2026-08-22) es un campo legado del
  // sistema de talentos pre-Shadowlands y siempre viene vacío ahora — el
  // build real del árbol de talentos actual está en `talentTree`
  // ([{ id, rank, nodeID }], IDs crudos de nodo/opción). `id` se enriquece
  // más abajo con un `spellId` real cruzando TraitNodeEntry+TraitDefinition
  // de Wago DB2 (ver talentSpellLookup) — así el front puede pintar cada
  // talento con tooltip de Wowhead en vez de "N nodos".
  talentTree?: unknown[];
  gear?: unknown[];
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
}

function effectiveMechanicCategory(mechanic: MechanicRow, observedInCurrentReport = false): string | null {
  const category = mechanic.category ?? mechanic.inferred_category;
  if (category === 'interrupt' && !mechanic.observed_as_interrupt && !observedInCurrentReport) return null;
  return category;
}
interface InterruptEvent {
  timestamp?: number;
  extraAbilityGameID?: number; // verificado en real el 2026-08-22 contra un log público: es la habilidad que SE interrumpió, no la que interrumpe
}

type DefensiveStatus = 'active' | 'available_unused' | 'on_cooldown' | 'unknown';
interface DefensiveOption {
  spellId: number;
  name: string;
  status: DefensiveStatus;
  cooldownRemainingMs?: number;
}

// Ventana de reacción para atribuir daño/muertes a un cast concreto del boss.
// Es la misma idea del §12 de la hoja de ruta (response_window_ms por
// mecánica), simplificada a un valor fijo: el manifiesto todavía no tiene
// esa columna por mecánica, y 4s cubre con margen la mayoría de mecánicas de
// "golpea y hace daño" sin confundir un cast con el siguiente.
const MECHANIC_REACTION_WINDOW_MS = 4000;

// Cuánto puede tener de "viejo" el último snapshot de buffs conocido de un
// jugador para seguir usándolo como "lo que tenía activo al morir". 2s es un
// término medio: bastante para encontrar un evento con `buffs` cercano
// (verificado en real que a veces faltan 1-2 eventos seguidos), pero no
// tanto como para dar por bueno un estado ya desactualizado.
const DEATH_BUFF_STALENESS_MS = 2000;

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  let reportCode: string | undefined;
  let maxFights = DEFAULT_MAX_FIGHTS_PER_CALL;
  try {
    const body = await req.json();
    reportCode = body.reportCode;
    if (typeof body.maxFights === 'number' && body.maxFights > 0) maxFights = Math.min(body.maxFights, 10);
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!reportCode) {
    return jsonResponse({ ok: false, error: 'reportCode es obligatorio' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, // service_role: salta RLS, solo vive aquí
  );

  try {
    const { data: reportRow } = await supabase
      .from('reports')
      .select('last_processed_fight_id, possible_duplicate_of')
      .eq('code', reportCode)
      .maybeSingle();
    const lastProcessedFightId = reportRow?.last_processed_fight_id ?? 0;
    let possibleDuplicateOf: string | null = reportRow?.possible_duplicate_of ?? null;

    const reportDetail = await getReportFights(reportCode);

    // OJO (bug real encontrado en producción, corregido aquí): `report_encounters.report_code`
    // tiene FK contra `reports.code` — en un report nuevo, upsertReportEncounters tiene que
    // ejecutarse DESPUÉS de que exista la fila en `reports`, o el insert falla en silencio
    // (el helper traga el error y devuelve 0 sin avisar) y report_encounters se queda vacía.
    if (!reportRow) {
      // §"la noche duplicada... dos personas subieron el mismo log" (bug
      // real encontrado y arreglado a mano el 2026-08-23): sin esto, dos
      // reports de la MISMA sesión (dos addons subiendo el mismo log)
      // duplican cada pull/muerte/mecánica en todo el pipeline. Antes de
      // crear la fila, se busca otro report YA importado con inicio a ±6h
      // y ≥2 bosses en común — evidencia fuerte de que es la misma noche.
      // NUNCA bloquea el import (podría ser una segunda sesión real el
      // mismo día) — solo deja un aviso visible para que el RL decida.
      const encounterIdsHere = new Set(reportDetail.fights.filter(isEncounterFight).map((f) => f.encounterID));
      if (encounterIdsHere.size) {
        const DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000;
        const { data: nearbyReports } = await supabase
          .from('reports')
          .select('code')
          .gte('start_time', reportDetail.startTime - DUPLICATE_WINDOW_MS)
          .lte('start_time', reportDetail.startTime + DUPLICATE_WINDOW_MS);
        for (const nearby of nearbyReports ?? []) {
          const { data: nearbyEncounters } = await supabase.from('report_encounters').select('encounter_id').eq('report_code', nearby.code);
          const sharedCount = new Set((nearbyEncounters ?? []).map((e) => e.encounter_id).filter((id) => encounterIdsHere.has(id))).size;
          if (sharedCount >= 2) {
            possibleDuplicateOf = nearby.code;
            break;
          }
        }
      }

      await supabase.from('reports').upsert(
        {
          code: reportCode,
          title: reportDetail.title,
          zone_id: reportDetail.zone?.id ?? null,
          zone_name: reportDetail.zone?.name ?? null,
          is_raid: reportDetail.fights.some(isEncounterFight),
          start_time: reportDetail.startTime,
          end_time: null,
          possible_duplicate_of: possibleDuplicateOf,
        },
        { onConflict: 'code', ignoreDuplicates: true },
      );
    }
    // Un log en vivo pegado a mano nunca pasa por sync-reports — asegura que
    // esta tabla (de donde sale la lista de bosses del report) siempre esté al día.
    await upsertReportEncounters(supabase, reportCode, reportDetail.fights);

    const allNewFights = reportDetail.fights.filter((f) => isEncounterFight(f) && f.id > lastProcessedFightId).sort((a, b) => a.id - b.id);
    const batch = allNewFights.slice(0, maxFights);
    const remaining = allNewFights.length - batch.length;

    let newestPullId: string | null = null;

    if (batch.length) {
      const actors = await getReportActors(reportCode);
      const actorById = new Map<number, WclActor>(actors.map((a) => [a.id, a]));

      // El Journal de Blizzard NO documenta todas las habilidades que hacen
      // daño real (verificado en real 2026-08-22: solo 1 de 29 muertes de un
      // wipe coincidía con las candidatas del Journal). masterData.abilities
      // de WCL sí tiene nombre real para prácticamente cualquier ID que
      // aparezca en el log — es la misma fuente que usa la propia web de WCL
      // para mostrar nombres. Se trae una vez por report, no por fight.
      const abilities = await getReportAbilities(reportCode);
      const abilityNameById = new Map(abilities.map((a) => [a.gameID, a.name]));
      // Puente por nombre (ver _shared/ability-name-match.ts): el ability_id
      // del Journal casi nunca coincide con el abilityGameID real que WCL usa
      // en Casts/DamageTaken/Deaths (verificado en real: 0/54 candidatas de
      // un boss casaban por ID) — pero el NOMBRE mostrado sí casi siempre. Se
      // construye una vez por report (nombre real -> todos los abilityGameID
      // reales que lo comparten, puede haber varios por fases/variantes).
      const realIdsByName = buildAbilityIdsByName(abilities);
      // §consumibles: resuelto por NOMBRE contra las abilities reales de este
      // report, nunca un ID fijo (ver _shared/consumables.ts — el nombre de
      // la poción de vida cambia cada tier, "Healthstone" no).
      const consumableIds = resolveConsumableAbilityIds(abilities);

      // §12.1: catálogo real de defensivos, sincronizado desde WoWAnalyzer
      // (o la semilla manual mientras no se haya sincronizado nada aún).
      // Se carga UNA VEZ por report, no por fight ni por evento.
      const { data: catalogRows } = await supabase.from('cooldown_catalog').select('class,spec,spell_id,name,category,base_cooldown_ms,base_duration_ms');
      const cooldownCatalog: CooldownCatalog = (catalogRows ?? []).map((r) => ({
        spellId: r.spell_id,
        name: r.name,
        class: r.class,
        spec: r.spec,
        category: r.category,
        baseCooldownMs: r.base_cooldown_ms,
        durationMs: r.base_duration_ms,
      }));

      // Talentos → spell ID real, para tooltips de Wowhead (ver
      // wago-db2-client.ts para la cadena TraitNodeEntry->TraitDefinition
      // verificada con datos reales). §"han desaparecido todos los
      // talentos": esto ANTES pedía dos tablas DB2 completas a wago.tools en
      // CADA reprocesado (miles de filas de todas las clases) — lento y
      // ocasionalmente fallaba/tardaba de más, degradando en silencio a
      // "sin resolver" (a propósito, para no bloquear el análisis). Ahora se
      // cachea en talent_spell_lookup por build de juego: solo cambia cuando
      // Blizzard saca un parche, así que una vez resuelto no hace falta
      // volver a pedirlo — la caché quita la parte flaky del camino
      // caliente sin quitar el fallback (si build o caché fallan, sigue sin
      // bloquear el análisis).
      let talentSpellLookup: Map<number, number> | null = null;
      try {
        const namespace = await getCurrentBuildNamespace();
        if (namespace) {
          const build = buildFromBlizzardNamespace(namespace);
          const { data: cached } = await supabase.from('talent_spell_lookup').select('entry_to_spell').eq('build', build).maybeSingle();
          if (cached) {
            talentSpellLookup = new Map(Object.entries(cached.entry_to_spell as Record<string, number>).map(([id, spellId]) => [Number(id), spellId]));
          } else {
            const fresh = (await fetchTalentSpellLookup(build)).entryIdToSpellId;
            talentSpellLookup = fresh;
            const entry_to_spell = Object.fromEntries([...fresh.entries()].map(([id, spellId]) => [String(id), spellId]));
            // Best-effort: si el insert falla (ej. carrera con otra invocación
            // guardando el mismo build a la vez), no bloquea — se recalculará
            // en la siguiente invocación sin caché, sin más coste que hoy.
            await supabase.from('talent_spell_lookup').upsert({ build, entry_to_spell }).then(
              () => {},
              (err) => console.error('No se pudo cachear talent_spell_lookup (no bloqueante):', err),
            );
          }
        }
      } catch (err) {
        console.error('No se pudieron resolver talentos a spell ID (se guardan sin resolver):', err);
      }

      for (const fight of batch) {
        const bossId = String(fight.encounterID);
        const difficulty = fight.difficulty != null ? (WCL_DIFFICULTY_NAME_BY_ID[fight.difficulty] ?? `Dificultad ${fight.difficulty}`) : 'Desconocida';
        const normalizedFightName = normalizeAbilityName(fight.name);
        const bossActorIds = new Set(
          actors
            .filter((actor) => {
              if (actor.type !== 'NPC') return false;
              const actorName = normalizeAbilityName(actor.name);
              return actorName === normalizedFightName || actorName.includes(normalizedFightName) || normalizedFightName.includes(actorName);
            })
            .map((actor) => actor.id),
        );

        const { count: priorPulls } = await supabase
          .from('pulls')
          .select('id', { count: 'exact', head: true })
          .eq('boss_id', bossId)
          .eq('difficulty', difficulty);

        // §"el timeline es horrible, rehacerlo con algo real y útil": daño
        // recibido por TODA la raid en el tiempo, agregado server-side por
        // WCL (mismo endpoint que alimenta su propia gráfica) — best-effort,
        // si falla el pull se sigue guardando igual, solo sin gráfica.
        let raidDamageTakenSeries: { pointIntervalMs: number; points: number[] } | null = null;
        try {
          const graph = await getFightGraph({ code: reportCode, fightId: fight.id, dataType: 'DamageTaken', hostilityType: 'Friendlies', startTime: fight.startTime, endTime: fight.endTime });
          if (graph) raidDamageTakenSeries = sumGraphSeries(graph.series);
        } catch (err) {
          console.error('analyze-report: no se pudo traer graph(DamageTaken) para el pull', fight.id, err);
        }

        // §3.1/§7.1: percentil real de WCL por jugador — best-effort igual
        // que la gráfica de arriba (un log privado sin permiso de ranking,
        // o un boss recién publicado sin rankear todavía, no debe tumbar el
        // resto del análisis del pull).
        let playerRankings: Map<string, { rankPercent: number; totalParses: number }> | null = null;
        try {
          playerRankings = await getFightPlayerRankings(reportCode, fight.id);
        } catch (err) {
          console.error('analyze-report: no se pudo traer rankings() para el pull', fight.id, err);
        }

        // Rol real del mismo fight para reconocer autoataques del boss sobre
        // no-tanks. Best-effort: si Summary falla se usa la spec como fallback.
        let playerRoles: Map<string, 'tank' | 'healer' | 'dps'> | null = null;
        try {
          playerRoles = await getFightPlayerRoles({ code: reportCode, fightId: fight.id, startTime: fight.startTime, endTime: fight.endTime });
        } catch (err) {
          console.error('analyze-report: no se pudieron traer roles de Summary para el pull', fight.id, err);
        }

        const { data: insertedPull, error: pullError } = await supabase
          .from('pulls')
          .insert({
            report_code: reportCode,
            fight_id: fight.id,
            boss_id: bossId,
            difficulty,
            pull_number: (priorPulls ?? 0) + 1,
            wipe_pct: fight.kill ? 0 : (fight.bossPercentage ?? null),
            duration_ms: fight.endTime - fight.startTime,
            closed_at: new Date().toISOString(),
            raid_damage_taken_series: raidDamageTakenSeries,
          })
          .select('id')
          .single();
        if (pullError) throw pullError;
        newestPullId = insertedPull.id;

        // Mecánicas curadas de este boss+dificultad — el matching depende
        // directamente de lo que se haya sincronizado/revisado en la sección de mecánicas.
        const { data: mechanics } = await supabase
          .from('boss_mechanics_candidates')
          .select('ability_id,name,description,category,responsibility,inferred_category,observed_as_interrupt,avoidable,severity_threshold')
          .eq('boss_id', bossId)
          .eq('difficulty', difficulty)
          .returns<MechanicRow[]>();
        // Mapa DEFINITIVO "abilityGameID real de WCL -> mecánica curada":
        // combina el match directo por ID (por si alguna vez sí coincide) con
        // el match por nombre (el que de verdad funciona casi siempre, ver
        // nota de realIdsByName más arriba). No pisa un match directo por ID
        // ya existente si el nombre apuntara a otra fila distinta.
        const mechanicById = new Map<number, MechanicRow>();
        for (const m of mechanics ?? []) {
          if (!mechanicById.has(m.ability_id)) mechanicById.set(m.ability_id, m);
          for (const realId of realIdsByName.get(normalizeAbilityName(m.name)) ?? []) {
            if (!mechanicById.has(realId)) mechanicById.set(realId, m);
          }
        }
        const avoidableAbilityIds = new Set([...mechanicById.entries()].filter(([, m]) => m.avoidable === true).map(([id]) => id));

        // Casts partido en dos consultas por hostilityType (no una sola sin
        // filtrar): verificado en real que los casts de ~25 jugadores ahogan
        // los del boss dentro del mismo límite de páginas — un pull de 5-6
        // min genera miles de casts de jugadores frente a unas pocas decenas
        // del boss. friendlyCastEvents alimenta defensivos/consumibles
        // (siempre casts de jugadores); enemyCastEvents alimenta
        // pull_mechanic_events (siempre casts del boss) — cada uno con su
        // propio presupuesto de páginas en vez de competir por el mismo.
        const [deathEvents, damageEvents, friendlyCastEvents, enemyCastEvents, damageDoneEvents, healingEvents, combatantInfoEvents, interruptEvents] = await Promise.all([
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Deaths', startTime: fight.startTime, endTime: fight.endTime }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'DamageTaken', startTime: fight.startTime, endTime: fight.endTime }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Casts', startTime: fight.startTime, endTime: fight.endTime, hostilityType: 'Friendlies' }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Casts', startTime: fight.startTime, endTime: fight.endTime, hostilityType: 'Enemies' }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'DamageDone', startTime: fight.startTime, endTime: fight.endTime }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Healing', startTime: fight.startTime, endTime: fight.endTime }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'CombatantInfo', startTime: fight.startTime, endTime: fight.endTime }),
          getFightEvents({ code: reportCode, fightId: fight.id, dataType: 'Interrupts', startTime: fight.startTime, endTime: fight.endTime }),
        ]);

        // §3/§7: dps/hps (simplificación: duración total del pull, no el
        // "active time" que usa la propia web de WCL — puede quedar algo por
        // debajo de lo que enseña WCL para jugadores con huecos sin objetivo),
        // absorciones y talentos/trinkets (combatantInfo). Se calculan aquí
        // porque son la misma tanda de eventos que ya se está trayendo.
        const durationSeconds = Math.max((fight.endTime - fight.startTime) / 1000, 1);
        const damageDoneByActor = new Map<number, number>();
        for (const raw of damageDoneEvents) {
          const e = raw as ThroughputEvent;
          if (typeof e.sourceID === 'number') damageDoneByActor.set(e.sourceID, (damageDoneByActor.get(e.sourceID) ?? 0) + (e.amount ?? 0));
        }
        const healingByActor = new Map<number, number>();
        // §10 rootCause 'no_healing_received' + §"cuánto recibió en los
        // últimos segundos": no solo CUÁNDO le curaron (para el sí/no de
        // rootCause) sino CUÁNTO (para el número real que pide la tabla de
        // "a quién dirigir") — misma tanda de eventos que ya se traía para
        // hps, ningún fetch nuevo.
        const healingEventsByTarget = new Map<number, { timestamp: number; amount: number }[]>();
        for (const raw of healingEvents) {
          const e = raw as ThroughputEvent;
          if (typeof e.sourceID === 'number') healingByActor.set(e.sourceID, (healingByActor.get(e.sourceID) ?? 0) + (e.amount ?? 0));
          if (typeof e.targetID === 'number' && typeof e.timestamp === 'number') {
            if (!healingEventsByTarget.has(e.targetID)) healingEventsByTarget.set(e.targetID, []);
            healingEventsByTarget.get(e.targetID)!.push({ timestamp: e.timestamp, amount: e.amount ?? 0 });
          }
        }
        const combatantInfoByActor = new Map<number, CombatantInfoEvent>();
        for (const raw of combatantInfoEvents) {
          const e = raw as CombatantInfoEvent;
          if (typeof e.sourceID === 'number') combatantInfoByActor.set(e.sourceID, e);
        }

        // §3: nombres reales de trinkets/spec en vez de "ilvl 308"/"79 nodos"
        // sin más — se resuelven una vez por fight (con caché en memoria
        // dentro de blizzard-client.ts, así que un trinket/spec ya visto en
        // un fight anterior de este mismo lote no vuelve a pedirse).
        const trinketIds = new Set<number>();
        const specIds = new Set<number>();
        for (const info of combatantInfoByActor.values()) {
          for (const i of TRINKET_SLOT_INDICES) {
            const item = info.gear?.[i] as { id?: number } | undefined;
            if (item?.id) trinketIds.add(item.id);
          }
          if (typeof info.specID === 'number') specIds.add(info.specID);
        }
        const [trinketNameEntries, specNameEntries] = await Promise.all([
          Promise.all([...trinketIds].map(async (id) => [id, await getItemName(id)] as const)),
          Promise.all([...specIds].map(async (id) => [id, await getSpecName(id)] as const)),
        ]);
        const trinketNameById = new Map(trinketNameEntries);
        const specNameById = new Map(specNameEntries);
        // Centralizado — se necesita en varios sitios de este bloque
        // (defensivos activos por evento, defensivos del catálogo al morir,
        // el campo `spec` final del registro) y antes solo se resolvía en el
        // último de ellos, así que los anteriores no podían filtrar por spec.
        function resolveSpec(actorId: number): string | null {
          const specId = combatantInfoByActor.get(actorId)?.specID;
          return typeof specId === 'number' ? (specNameById.get(specId) ?? null) : null;
        }

        const TANK_SPECS = new Set(['Blood', 'Vengeance', 'Guardian', 'Brewmaster', 'Protection']);
        function isTankActor(actorId: number): boolean {
          const actor = actorById.get(actorId);
          if (actor && playerRoles?.get(actor.name) === 'tank') return true;
          return TANK_SPECS.has(resolveSpec(actorId) ?? '');
        }

        // §"que los defensivos disponibles sean propios de la clase o de los
        // talentos... hay cosas que no están por talentos o son pasivas":
        // allTalentSpellIds sale del MISMO talentSpellLookup ya resuelto
        // arriba (todos los spellId que existen como nodo de talento, de
        // cualquier clase) — no es una llamada nueva. playerTalentSpellIds
        // es el árbol REAL de este jugador en este pull. Sin talentSpellLookup
        // (falló la resolución ese report) se devuelve null: activeDefensives/
        // defensivesForClass no filtran de más por falta de dato.
        const allTalentSpellIds = talentSpellLookup ? new Set(talentSpellLookup.values()) : null;
        function talentGateForActor(actorId: number): TalentGate | null {
          if (!allTalentSpellIds || !talentSpellLookup) return null;
          const tree = combatantInfoByActor.get(actorId)?.talentTree;
          if (!tree) return null;
          const playerTalentSpellIds = new Set(
            (tree as { id?: number }[])
              .map((node) => (typeof node.id === 'number' ? talentSpellLookup!.get(node.id) : undefined))
              .filter((id): id is number => typeof id === 'number'),
          );
          return { allTalentSpellIds, playerTalentSpellIds };
        }

        // §3/§12: "qué defensivos tenía disponibles" de verdad — no solo "lo
        // lanzó alguna vez", sino próximo_disponible(t) = último_cast_antes_de(t)
        // + base_cooldown_ms, igual que describe la hoja de ruta. Se guardan
        // TODOS los timestamps de cast de cada spell del catálogo por
        // jugador (friendlyCastEvents llega en orden cronológico de WCL, así
        // que cada array queda ya ordenado — no hace falta un sort aparte).
        const defensiveCastTimestampsByActor = new Map<number, Map<number, number[]>>();
        for (const raw of friendlyCastEvents) {
          const e = raw as CastEvent;
          if (typeof e.sourceID !== 'number' || typeof e.abilityGameID !== 'number') continue;
          if (!defensiveCastTimestampsByActor.has(e.sourceID)) defensiveCastTimestampsByActor.set(e.sourceID, new Map());
          const perSpell = defensiveCastTimestampsByActor.get(e.sourceID)!;
          if (!perSpell.has(e.abilityGameID)) perSpell.set(e.abilityGameID, []);
          perSpell.get(e.abilityGameID)!.push(e.timestamp ?? 0);
        }

        const deathByTarget = new Map<number, { timestamp: number; killingAbilityGameID: number }>();
        for (const raw of deathEvents) {
          const e = raw as DeathEvent;
          if (typeof e.targetID === 'number') {
            deathByTarget.set(e.targetID, { timestamp: e.timestamp ?? 0, killingAbilityGameID: e.killingAbilityGameID ?? 0 });
          }
        }

        const avoidableDamageByTarget = new Map<number, number>();
        // targetID -> mechanicId -> daño acumulado. El desglose es lo que permite
        // luego responder "¿QUÉ mecánica nos está haciendo daño?", no solo cuánto en total.
        const mechanicDamageByTarget = new Map<number, Map<number, number>>();
        const defensivesSeenByTarget = new Map<number, Map<number, string>>(); // targetID -> spellId -> name
        // OJO (bug real encontrado el 2026-08-22, corregido aquí): el campo
        // `buffs` de WCL NO viene en todos los eventos — verificado en real
        // que en un golpe mortal con 4 ticks casi simultáneos, NINGUNO traía
        // `buffs`, mientras que un evento 2s antes sí lo traía. La versión
        // anterior solo miraba el evento EXACTO de la muerte: si ese evento
        // no traía `buffs` (frecuente), lo interpretaba como "confirmado sin
        // defensivo" en vez de "no lo sabemos" — por eso TODAS las muertes
        // salían con "sin ningún defensivo activo". Ahora se guarda el ÚLTIMO
        // snapshot de buffs visto para cada jugador (de cualquier evento, no
        // solo el de la muerte) y se usa si cae dentro de una ventana
        // razonable antes de morir; si no hay ninguno reciente, queda null
        // (desconocido), no "false" disfrazado de "true".
        const lastBuffsSnapshotByTarget = new Map<number, { buffs: string; timestamp: number }>();
        const absorbedByTarget = new Map<number, number>();
        // §"golpe único vs. daño sostenido": WCL no da un campo `overkill` en
        // Deaths ni en DamageTaken (verificado en real contra un log real —
        // ninguno de los dos trae ese campo), así que en vez de inventar un
        // % de HP máxima (que tampoco tenemos), se guarda TODO el historial
        // de daño por objetivo y se mira la ventana de los últimos segundos
        // antes de morir: honesto con lo que el dato realmente permite decir.
        const damageEventsByTarget = new Map<number, DamageEvent[]>();

        for (const raw of damageEvents) {
          const e = raw as DamageEvent;
          if (typeof e.targetID !== 'number') continue;
          const actor = actorById.get(e.targetID);

          if (!damageEventsByTarget.has(e.targetID)) damageEventsByTarget.set(e.targetID, []);
          damageEventsByTarget.get(e.targetID)!.push(e);

          if (e.absorbed) absorbedByTarget.set(e.targetID, (absorbedByTarget.get(e.targetID) ?? 0) + e.absorbed);

          if (typeof e.abilityGameID === 'number' && avoidableAbilityIds.has(e.abilityGameID)) {
            avoidableDamageByTarget.set(e.targetID, (avoidableDamageByTarget.get(e.targetID) ?? 0) + (e.amount ?? 0));
            if (!mechanicDamageByTarget.has(e.targetID)) mechanicDamageByTarget.set(e.targetID, new Map());
            const perMechanic = mechanicDamageByTarget.get(e.targetID)!;
            perMechanic.set(e.abilityGameID, (perMechanic.get(e.abilityGameID) ?? 0) + (e.amount ?? 0));
          }

          if (actor) {
            for (const cd of activeDefensives(e.buffs, actor.subType, resolveSpec(e.targetID), cooldownCatalog, talentGateForActor(e.targetID))) {
              if (!defensivesSeenByTarget.has(e.targetID)) defensivesSeenByTarget.set(e.targetID, new Map());
              defensivesSeenByTarget.get(e.targetID)!.set(cd.spellId, cd.name);
            }
          }

          // Snapshot más reciente de auras del jugador, de CUALQUIER golpe que
          // reciba (no solo el que lo mata) — los eventos llegan en orden
          // cronológico, así que el último que se procese es el más reciente.
          if (e.buffs !== undefined) {
            lastBuffsSnapshotByTarget.set(e.targetID, { buffs: e.buffs, timestamp: e.timestamp ?? 0 });
          }
        }

        // §consumibles: disponibilidad de piedra de brujo — hubo algún
        // Warlock en la friendly list de ESTE pull concreto (puede variar
        // pull a pull si hay bench/sustituciones).
        const warlockPresent = fight.friendlyPlayers.some((id) => actorById.get(id)?.subType === 'Warlock');

        // Ventana de "los últimos segundos antes de morir" para distinguir
        // golpe único de daño sostenido. 5s cubre con margen un burst típico
        // (2-3 golpes casi simultáneos) sin colar toda una fase de daño lento.
        const DEATH_BURST_WINDOW_MS = 5000;
        interface DamageWindowHit {
          time_ms: number; // relativo al inicio del pull, como el resto de timestamps que se guardan
          amount: number;
          ability_id: number | null;
          ability_name: string | null;
        }
        function computeDeathDamageProfile(
          targetId: number,
          deathTimestamp: number,
        ): { damageProfile: 'burst' | 'sustained' | 'unknown'; killingBlowAmount: number | null; damageWindowTotal: number; damageWindowHits: number; damageWindowEvents: DamageWindowHit[] } {
          const events = (damageEventsByTarget.get(targetId) ?? []).filter(
            (e) => (e.amount ?? 0) > 0 && (e.timestamp ?? 0) <= deathTimestamp && (e.timestamp ?? 0) >= deathTimestamp - DEATH_BURST_WINDOW_MS,
          );
          if (!events.length) return { damageProfile: 'unknown', killingBlowAmount: null, damageWindowTotal: 0, damageWindowHits: 0, damageWindowEvents: [] };
          const windowTotal = events.reduce((sum, e) => sum + (e.amount ?? 0), 0);
          const maxHit = events.reduce((max, e) => ((e.amount ?? 0) > (max.amount ?? 0) ? e : max), events[0]);
          const killingBlowAmount = maxHit.amount ?? null;
          // "Golpe único": pocos impactos en la ventana Y uno de ellos concentra
          // la mayoría del daño — un burst de 2-3 golpes casi simultáneos se
          // trata igual que un solo golpe (es lo que un jugador percibe como
          // "me ha explotado"), no exige un ÚNICO evento literal.
          const damageProfile: 'burst' | 'sustained' = events.length <= 3 && windowTotal > 0 && (killingBlowAmount ?? 0) / windowTotal >= 0.6 ? 'burst' : 'sustained';
          // §13.4 "la secuencia real de golpes antes de morir, no solo una
          // frase": hasta ahora solo se guardaba el agregado — el mini-timeline
          // del drawer de procedencia necesita cada golpe individual.
          const damageWindowEvents: DamageWindowHit[] = events
            .map((e) => ({
              time_ms: (e.timestamp ?? 0) - fight.startTime,
              amount: e.amount ?? 0,
              ability_id: e.abilityGameID ?? null,
              ability_name: typeof e.abilityGameID === 'number' ? (abilityNameById.get(e.abilityGameID) ?? null) : null,
            }))
            .sort((a, b) => a.time_ms - b.time_ms);
          return { damageProfile, killingBlowAmount, damageWindowTotal: windowTotal, damageWindowHits: events.length, damageWindowEvents };
        }

        // Un autoataque del boss sobre un no-tank significa que el boss ya no
        // tenía un tank operativo (muerto, fuera de combate o sin poder
        // mantenerlo). Se conserva como hecho en la tabla, pero no se evalúa
        // como error del objetivo ni como oportunidad de usar defensivo,
        // piedra o poción. La comprobación es deliberadamente estricta:
        // killing ability "Melee", fuente = actor del boss y sin otro daño
        // mezclado en los 2s finales.
        const BOSS_MELEE_EXCLUSIVE_WINDOW_MS = 2000;
        function isBossMeleeOnNonTank(actorId: number, death: { timestamp: number; killingAbilityGameID: number }): boolean {
          if (isTankActor(actorId) || bossActorIds.size === 0) return false;
          if (normalizeAbilityName(abilityNameById.get(death.killingAbilityGameID) ?? '') !== 'melee') return false;
          const recentDamage = (damageEventsByTarget.get(actorId) ?? []).filter(
            (event) => (event.amount ?? 0) > 0 && (event.timestamp ?? 0) <= death.timestamp && (event.timestamp ?? 0) >= death.timestamp - BOSS_MELEE_EXCLUSIVE_WINDOW_MS,
          );
          if (!recentDamage.length) return false;
          return recentDamage.every(
            (event) =>
              event.abilityGameID === death.killingAbilityGameID &&
              typeof event.sourceID === 'number' &&
              bossActorIds.has(event.sourceID),
          );
        }

        // §10 (hoja de ruta / auditoría v2): "no es lo mismo un oneshot que
        // una muerte por daño sostenido sin sanar, y dentro de cada una la
        // causa real puede ser muy distinta". Deliberadamente MÁS ACOTADO que
        // las 6 causas del documento original: undispelled_debuff y
        // tank_swap_missed harían falta events(dataType: Debuffs) y una
        // señal de stacks de amenaza que hoy no se traen — mejor devolver
        // 'unclassified' que inventar una causa sin evidencia real detrás
        // (mismo principio que ya rige todo lo demás de este pipeline). Las
        // que SÍ se pueden defender con los datos que ya se traen:
        //  - self_positioning / unsoaked_mechanic: la CATEGORÍA de la
        //    mecánica ya dice el tipo de respuesta esperada (evitar el
        //    suelo/separarse = responsabilidad individual; soak = falta de
        //    coordinación del grupo) — no hace falta reconstruir a cuánta
        //    gente golpeó ESTA instancia en concreto para eso.
        //  - no_healing_received: perfil de daño sostenido (no un burst) +
        //    ningún tick de sanación real dirigido a este jugador en los
        //    segundos previos — ahora que healingEventsByTarget existe,
        //    sin necesitar ninguna llamada nueva a WCL.
        const NO_HEAL_LOOKBACK_MS = 6000;
        function computeRootCause(
          actorId: number,
          deathTimestamp: number,
          category: string | null,
          damageProfile: 'burst' | 'sustained' | 'unknown',
        ): 'self_positioning' | 'unsoaked_mechanic' | 'no_healing_received' | 'unclassified' {
          if (category === 'avoidable-ground' || category === 'spread') return 'self_positioning';
          if (category === 'soak') return 'unsoaked_mechanic';
          if (damageProfile === 'sustained') {
            const heals = healingEventsByTarget.get(actorId) ?? [];
            const hadRecentHeal = heals.some((h) => h.timestamp <= deathTimestamp && h.timestamp >= deathTimestamp - NO_HEAL_LOOKBACK_MS);
            if (!hadRecentHeal) return 'no_healing_received';
          }
          return 'unclassified';
        }

        // §"a quién dirigir: healing sí/no y cuánto recibió en los últimos
        // 5-10s": misma ventana que se usa para juzgar rootCause
        // (NO_HEAL_LOOKBACK_MS), pero aquí se quiere el NÚMERO real, no solo
        // el sí/no — un jugador puede haber recibido sanación real y aun así
        // haber muerto (la sanación no fue suficiente), que es una historia
        // de coaching distinta a "nadie le curó".
        function computeHealingReceived(actorId: number, deathTimestamp: number): { healingWindowTotal: number; healingWindowHits: number } {
          const heals = (healingEventsByTarget.get(actorId) ?? []).filter(
            (h) => h.timestamp <= deathTimestamp && h.timestamp >= deathTimestamp - NO_HEAL_LOOKBACK_MS,
          );
          return { healingWindowTotal: heals.reduce((sum, h) => sum + h.amount, 0), healingWindowHits: heals.length };
        }

        // §"cuándo se determina un wipe global... yo como RL digo 'vamos a
        // wipear'" (feedback real, investigado contra un caso real de esta
        // guild): la señal más engañosa es "cuánta gente muere a la vez" —
        // en un pull real, 18/22 murieron en el mismo segundo a la MISMA
        // ability (Elemental Explosion): eso es una mecánica real que
        // revienta a la raid entera de golpe, NO un wipe call. Un wipe call
        // de verdad se distingue por CÓMO mueren, no solo cuántos a la vez:
        // causas de muerte HETEROGÉNEAS (cada uno muere a lo que tuviera
        // encima) y la sanación/el daño de la raid se desploman justo antes
        // (nadie sigue intentando). Solo se evalúa en wipes — un kill nunca
        // es un wipe call por definición.
        const WIPE_CALL_CLUSTER_WINDOW_MS = 8000;
        const WIPE_CALL_MIN_FRACTION = 0.6; // §"si somos 20 y mueren 16 en 6s" ≈ 0.8 de ejemplo — 0.6 de margen para no dejar escapar el caso real
        const WIPE_CALL_NEAR_END_MS = 15_000; // el cluster tiene que estar pegado al final del pull — un pico de muertes a mitad de pull que luego se recuperó no cuenta
        const EARLY_MASS_WIPE_MS = 10_000;
        const WIPE_CALL_CONFIDENCE_THRESHOLD = 55; // 0-100 — por debajo se guarda como "posible" visible en la UI, pero NO se auto-excluye
        // §"aunque sea un wipe call los primeros 2-3-4 que mueren no suelen
        // ser parte de ese wipe call... es mecánica fallida seguramente, lo
        // que deriva en el wipe call" (feedback real): el cluster detecta
        // BIEN el momento en que "la raid da la pelea por perdida", pero las
        // primeras muertes DENTRO de esa ventana suelen ser la CAUSA (un
        // fallo real que hace evidente que se ha perdido), no la
        // consecuencia — esas SÍ deben seguir contando. Se excluyen del
        // cluster solo las muertes a partir de la Nª (el "pile-on" real),
        // nunca las primeras — como mucho 3, y nunca más de la mitad del
        // cluster si es pequeño (un cluster de 4 no puede tener "las 3
        // primeras" como causa y solo 1 de pile-on real).
        const WIPE_CALL_TRIGGER_DEATHS = 3;

        interface WipeCallDetection {
          clusterActorIds: Set<number>;
          confidence: number;
          signals: {
            simultaneityFraction: number;
            abilityDiversity: number;
            nearEndMs: number;
            healingCollapseRatio: number | null;
            damageCollapseRatio: number | null;
            sustainedDeathFraction: number;
            unknownDeathFraction: number;
            triggerDeathsKept: number;
            wipeCallStartMs: number;
            earlyMassDeath: boolean;
          };
        }

        function detectWipeCall(): WipeCallDetection | null {
          if (fight.kill) return null;

          const deaths = [...deathByTarget.entries()]
            .map(([actorId, d]) => ({ actorId, ...d }))
            .sort((a, b) => a.timestamp - b.timestamp);
          if (deaths.length < 2) return null;

          // Mayor cluster TERMINAL por ventana deslizante. Antes se elegía el
          // mayor de todo el pull y solo después se comprobaba si estaba al
          // final: un pico grande a mitad podía tapar un wipe call terminal
          // algo menor y hacer que no se detectara ninguno.
          let bestCluster: typeof deaths = [];
          for (const start of deaths) {
            const cluster = deaths.filter((d) => d.timestamp >= start.timestamp && d.timestamp <= start.timestamp + WIPE_CALL_CLUSTER_WINDOW_MS);
            if (!cluster.length || fight.endTime - cluster.at(-1)!.timestamp > WIPE_CALL_NEAR_END_MS) continue;
            if (cluster.length > bestCluster.length || (cluster.length === bestCluster.length && cluster.at(-1)!.timestamp > (bestCluster.at(-1)?.timestamp ?? 0))) {
              bestCluster = cluster;
            }
          }
          if (bestCluster.length < 2) return null;

          const localRaidSize = fight.friendlyPlayers.length || 1;
          const aliveAtClusterStart = localRaidSize - deaths.filter((d) => d.timestamp < bestCluster[0].timestamp).length;
          const simultaneityFraction = aliveAtClusterStart > 0 ? bestCluster.length / aliveAtClusterStart : 0;
          const clusterStart = bestCluster[0].timestamp;
          const clusterEnd = bestCluster.at(-1)!.timestamp;
          const nearEndMs = fight.endTime - clusterEnd;
          const earlyMassDeath = clusterEnd - fight.startTime <= EARLY_MASS_WIPE_MS && bestCluster.length / localRaidSize >= WIPE_CALL_MIN_FRACTION;
          if (simultaneityFraction < WIPE_CALL_MIN_FRACTION) return null;

          // Señal 1: diversidad de killing ability — 0 = todos murieron a la
          // MISMA habilidad (mecánica real), 1 = todos a algo distinto (cada
          // uno se murió a lo que tenía encima, típico de "ya nadie reacciona").
          const knownAbilities = bestCluster.map((d) => d.killingAbilityGameID).filter((id) => id > 0);
          const distinctAbilities = new Set(knownAbilities).size;
          const abilityDiversity = knownAbilities.length > 1 ? Math.min(1, (distinctAbilities - 1) / (knownAbilities.length - 1)) : 0;
          const unknownDeathFraction = bestCluster.filter((d) => d.killingAbilityGameID === 0).length / bestCluster.length;

          // Las primeras muertes suelen ser la causa real. El límite explícito
          // permite conservar toda mecánica anterior y excluir solo el pile-on.
          // En una muerte masiva durante los primeros 10s no hay fase previa
          // evaluable: se considera reset/wipe call desde el inicio.
          const triggerDeathCount = earlyMassDeath ? 0 : Math.min(WIPE_CALL_TRIGGER_DEATHS, Math.max(1, Math.floor(bestCluster.length * 0.2)));
          const pileOnDeaths = bestCluster.slice(triggerDeathCount);
          const wipeCallStartTimestamp = earlyMassDeath ? fight.startTime : pileOnDeaths[0].timestamp;

          // Señal 2/3: sanación y daño de la RAID (no de un jugador) en los
          // actividad DESPUÉS de las muertes desencadenantes, comparada con la
          // media anterior. Medir antes del primer muerto evaluaba la ejecución
          // previa al fallo, no el momento en que la raid dio el pull por perdido.
          const fightSoFarMs = Math.max(1, wipeCallStartTimestamp - fight.startTime);
          const postWindowEnd = Math.min(fight.endTime, wipeCallStartTimestamp + 10_000);
          const postWindowMs = Math.max(1000, postWindowEnd - wipeCallStartTimestamp);
          const allHealing = [...healingEventsByTarget.values()].flat();
          const priorHealing = allHealing.filter((h) => h.timestamp < wipeCallStartTimestamp);
          const postTriggerHealing = allHealing.filter((h) => h.timestamp >= wipeCallStartTimestamp && h.timestamp <= postWindowEnd).reduce((s, h) => s + h.amount, 0);
          const avgHealingPer10s = (priorHealing.reduce((s, h) => s + h.amount, 0) / fightSoFarMs) * 10_000;
          const projectedHealingPer10s = (postTriggerHealing / postWindowMs) * 10_000;
          const healingCollapseRatio = avgHealingPer10s > 0 ? Math.min(1, projectedHealingPer10s / avgHealingPer10s) : null;

          const friendlyIds = new Set(fight.friendlyPlayers);
          const priorFriendlyDamage = (damageDoneEvents as ThroughputEvent[]).filter((e) => typeof e.sourceID === 'number' && friendlyIds.has(e.sourceID) && typeof e.timestamp === 'number' && e.timestamp < wipeCallStartTimestamp);
          const totalPriorDamage = priorFriendlyDamage.reduce((s, e) => s + (e.amount ?? 0), 0);
          const avgDamagePer10s = (totalPriorDamage / fightSoFarMs) * 10_000;
          const postTriggerDamage = (damageDoneEvents as ThroughputEvent[])
            .filter((e) => typeof e.sourceID === 'number' && friendlyIds.has(e.sourceID) && typeof e.timestamp === 'number' && e.timestamp >= wipeCallStartTimestamp && e.timestamp <= postWindowEnd)
            .reduce((s, e) => s + (e.amount ?? 0), 0);
          const projectedDamagePer10s = (postTriggerDamage / postWindowMs) * 10_000;
          const damageCollapseRatio = avgDamagePer10s > 0 ? Math.min(1, projectedDamagePer10s / avgDamagePer10s) : null;

          // Señal 4: perfil de daño de cada muerte del cluster — reutiliza
          // computeDeathDamageProfile tal cual (mismo dato que ya se calcula
          // para cada death_cause individual). 'burst' (un golpe dominante)
          // apoya mecánica real; 'sustained'/'unknown' (nada nuevo la mató,
          // se fue apagando) apoya wipe call.
          const nonBurstCount = bestCluster.filter((d) => computeDeathDamageProfile(d.actorId, d.timestamp).damageProfile !== 'burst').length;
          const sustainedDeathFraction = nonBurstCount / bestCluster.length;

          // Contraseñal fuerte: casi todos mueren a la misma habilidad y de
          // burst. Es una mecánica letal de raid, aunque el pull termine justo
          // después y la actividad caiga a cero por haberse muerto todos.
          const abilityCounts = new Map<number, number>();
          for (const abilityId of knownAbilities) abilityCounts.set(abilityId, (abilityCounts.get(abilityId) ?? 0) + 1);
          const dominantAbilityFraction = Math.max(0, ...abilityCounts.values()) / bestCluster.length;
          if (!earlyMassDeath && dominantAbilityFraction >= 0.7 && sustainedDeathFraction <= 0.4) return null;

          const evidenceCount = [
            abilityDiversity >= 0.2 || unknownDeathFraction >= 0.3,
            healingCollapseRatio != null && healingCollapseRatio <= 0.35,
            damageCollapseRatio != null && damageCollapseRatio <= 0.35,
            sustainedDeathFraction >= 0.5,
          ].filter(Boolean).length;
          if (!earlyMassDeath && evidenceCount < 2) return null;

          const healingSignal = healingCollapseRatio != null ? 1 - healingCollapseRatio : 0.5; // sin dato = neutral, no penaliza ni favorece
          const damageSignal = damageCollapseRatio != null ? 1 - damageCollapseRatio : 0.5;
          const calculatedConfidence = Math.round(
            (simultaneityFraction * 0.2 + abilityDiversity * 0.2 + unknownDeathFraction * 0.1 + healingSignal * 0.2 + damageSignal * 0.1 + sustainedDeathFraction * 0.1 + (1 - nearEndMs / WIPE_CALL_NEAR_END_MS) * 0.1) * 100,
          );
          const confidence = earlyMassDeath ? Math.max(85, calculatedConfidence) : calculatedConfidence;

          return {
            clusterActorIds: new Set(pileOnDeaths.map((d) => d.actorId)),
            confidence,
            signals: {
              simultaneityFraction: Math.round(simultaneityFraction * 100) / 100,
              abilityDiversity: Math.round(abilityDiversity * 100) / 100,
              nearEndMs,
              healingCollapseRatio: healingCollapseRatio != null ? Math.round(healingCollapseRatio * 100) / 100 : null,
              damageCollapseRatio: damageCollapseRatio != null ? Math.round(damageCollapseRatio * 100) / 100 : null,
              sustainedDeathFraction: Math.round(sustainedDeathFraction * 100) / 100,
              unknownDeathFraction: Math.round(unknownDeathFraction * 100) / 100,
              // §"los primeros 2-3-4 que mueren no suelen ser parte de ese
              // wipe call" (feedback real): cuántas de las bestCluster.length
              // muertes del cluster se dejaron FUERA de la exclusión por ser
              // las primeras (probable causa, no consecuencia) — visible en
              // "ver evidencia" del banner para que quede claro que no TODO
              // el cluster se excluyó.
              triggerDeathsKept: triggerDeathCount,
              wipeCallStartMs: Math.max(0, wipeCallStartTimestamp - fight.startTime),
              earlyMassDeath,
            },
          };
        }

        const wipeCallDetection = detectWipeCall();
        if (wipeCallDetection) {
          await supabase
            .from('pulls')
            .update({
              wipe_call_confidence: wipeCallDetection.confidence,
              wipe_call_signals: wipeCallDetection.signals,
              wipe_call_excluded: wipeCallDetection.confidence >= WIPE_CALL_CONFIDENCE_THRESHOLD,
            })
            .eq('id', insertedPull.id);
        }

        const playerRecords = fight.friendlyPlayers.map((actorId) => {
          const actor = actorById.get(actorId);
          const death = deathByTarget.get(actorId);
          const mechanic = death ? mechanicById.get(death.killingAbilityGameID) : undefined;
          // Se calculan una vez aquí (antes solo vivían inline dentro del
          // spread de death_cause) porque §10/rootCause también los necesita
          // — mismo dato, dos consumidores, sin recalcular category dos veces.
          const deathEffectiveCategory = mechanic ? effectiveMechanicCategory(mechanic) : null;
          const deathDamageProfile = death ? computeDeathDamageProfile(actorId, death.timestamp) : null;
          const deathHealingReceived = death ? computeHealingReceived(actorId, death.timestamp) : null;
          const bossMeleeOnNonTank = death ? isBossMeleeOnNonTank(actorId, death) : false;
          const buffsSnapshot = death ? lastBuffsSnapshotByTarget.get(actorId) : undefined;
          const buffsSnapshotIsFresh = death != null && buffsSnapshot != null && Math.abs(death.timestamp - buffsSnapshot.timestamp) <= DEATH_BUFF_STALENESS_MS;
          const defensivesAtDeath = buffsSnapshotIsFresh && actor ? activeDefensives(buffsSnapshot.buffs, actor.subType, resolveSpec(actorId), cooldownCatalog, talentGateForActor(actorId)) : [];
          const defensivesSeen = [...(defensivesSeenByTarget.get(actorId)?.entries() ?? [])].map(([spellId, name]) => ({ spellId, name }));

          // §12: próximo_disponible(t) = último_cast_antes_de(t) + base_cooldown_ms.
          // Para cada defensivo de su clase, en el momento exacto de morir:
          // 'active' (ya lo tenía puesto — gana sobre lo demás cuando lo sabemos),
          // 'on_cooldown' (lo lanzó hace menos de su cooldown base — no podía
          // haberlo vuelto a usar), 'available_unused' (fuera de cooldown, o
          // nunca lo lanzó — PODÍA haberlo usado y no lo hizo, la señal
          // realmente accionable), o 'unknown' (el extractor no resolvió un
          // cooldown base plano para esa spell — mejor decir "no lo sé" que
          // inventar un número).
          const activeSpellIds = new Set(defensivesAtDeath.map((d) => d.spellId));
          const defensiveOptions: DefensiveOption[] =
            death && actor
              ? defensivesForClass(actor.subType, resolveSpec(actorId), cooldownCatalog, talentGateForActor(actorId)).map((cd) => {
                  const casts = defensiveCastTimestampsByActor.get(actorId)?.get(cd.spellId) ?? [];
                  let lastCastBefore: number | undefined;
                  for (const t of casts) {
                    if (t <= death.timestamp) lastCastBefore = t;
                    else break; // casts está ordenado cronológicamente, no hace falta seguir mirando
                  }

                  // §"para calcular bien si había defensivo activo tienes
                  // que revisar lo que dura el defensivo con el momento de
                  // uso y el momento de su muerte, no solo el CD": con
                  // duración real conocida, esto se calcula SIEMPRE (cast +
                  // duración vs. muerte), sin depender de que WCL trajera un
                  // snapshot de buffs reciente — más fiable que el snapshot
                  // cuando lo sabemos, así que gana sobre él.
                  if (lastCastBefore !== undefined && cd.durationMs != null) {
                    const elapsedSinceCast = death.timestamp - lastCastBefore;
                    if (elapsedSinceCast <= cd.durationMs) {
                      return { spellId: cd.spellId, name: cd.name, status: 'active' as const };
                    }
                    // Duración conocida y ya expiró: NO caer al snapshot de
                    // buffs para este spell — sabemos que no está activo,
                    // sería contradecir un dato más fiable con uno peor.
                  } else if (buffsSnapshotIsFresh && activeSpellIds.has(cd.spellId)) {
                    // Duración sin verificar todavía: mismo fallback de
                    // siempre (snapshot de buffs de WCL a ≤2s de morir).
                    return { spellId: cd.spellId, name: cd.name, status: 'active' as const };
                  }

                  if (lastCastBefore === undefined) {
                    return { spellId: cd.spellId, name: cd.name, status: 'available_unused' as const };
                  }
                  if (cd.baseCooldownMs == null) {
                    return { spellId: cd.spellId, name: cd.name, status: 'unknown' as const };
                  }
                  const elapsed = death.timestamp - lastCastBefore;
                  if (elapsed >= cd.baseCooldownMs) {
                    return { spellId: cd.spellId, name: cd.name, status: 'available_unused' as const };
                  }
                  return { spellId: cd.spellId, name: cd.name, status: 'on_cooldown' as const, cooldownRemainingMs: cd.baseCooldownMs - elapsed };
                })
              : [];
          return {
            pull_id: insertedPull.id,
            player_name: actor?.name ?? `#${actorId}`,
            died: Boolean(death),
            // §"esa gente no debería contar como muerte ni afectar su
            // fiabilidad/defensivos... márcalo como wipe call": true SOLO
            // para quienes cayeron dentro del cluster detectado (no todo el
            // pull) — el resto de muertes del mismo pull, si las hay fuera
            // del cluster, siguen contando normal.
            wipe_call_cluster: wipeCallDetection?.clusterActorIds.has(actorId) ?? false,
            death_cause: death
              ? {
                  mechanicId: death.killingAbilityGameID,
                  // Prioridad: nombre curado a mano (manifiesto) > nombre real de WCL
                  // (masterData.abilities, aunque no esté en el Journal) > null solo si
                  // WCL tampoco lo tiene (rarísimo — la propia web de WCL no podría
                  // mostrar nombre tampoco en ese caso).
                  mechanicName: mechanic?.name ?? abilityNameById.get(death.killingAbilityGameID) ?? null,
                  // Qué hace la mecánica, no solo cómo se llama (§ "para poder
                  // explicarlo o criticarlo bien") — del Journal de Blizzard,
                  // copiado aquí para que el pull quede autocontenido.
                  mechanicDescription: mechanic?.description ?? null,
                  // category = confirmada a mano (save-mechanic-edit); si no hay
                  // ninguna todavía, cae a inferred_category (sugerencia de
                  // sync-boss-mechanics, ver _shared/mechanic-category-inference.ts)
                  // — categoryIsInferred dice cuál de las dos es, para que el
                  // front pueda pintarla distinto (confirmada vs. sugerida).
                  category: deathEffectiveCategory,
                  responsibility: mechanic?.responsibility ?? null,
                  categoryIsInferred: mechanic ? mechanic.category == null && deathEffectiveCategory != null : false,
                  avoidable: mechanic?.avoidable ?? null,
                  preventableWithDefensive: bossMeleeOnNonTank ? null : buffsSnapshotIsFresh ? defensivesAtDeath.length === 0 : null,
                  statisticalExclusionReason: bossMeleeOnNonTank ? 'boss_melee_on_non_tank' : null,
                  // §10: "no es lo mismo un oneshot que una muerte por daño
                  // sostenido sin sanar, y la causa real puede ser muy
                  // distinta" — ver computeRootCause para el alcance real
                  // (deliberadamente sin undispelled_debuff/tank_swap_missed
                  // todavía, sin datos reales para defenderlas).
                  rootCause: computeRootCause(actorId, death.timestamp, deathEffectiveCategory, deathDamageProfile?.damageProfile ?? 'unknown'),
                  // §"a quién dirigir: healing sí/no y cuánto en los últimos
                  // segundos" — misma ventana de 6s que ya usa rootCause,
                  // pero con el número real en vez de solo sí/no.
                  ...(deathHealingReceived as NonNullable<typeof deathHealingReceived>),
                  // Estado de CADA defensivo de su catálogo en el momento exacto
                  // de morir — activo, en cooldown (y cuánto le faltaba),
                  // disponible y sin usar, o sin dato de cooldown. Sustituye a
                  // los dos campos sueltos de la versión anterior
                  // (activeDefensivesAtDeath/neverCastDefensives), que solo
                  // decían "algo activo sí/no" y "lo lanzó alguna vez sí/no"
                  // sin cruzar ambas cosas con el tiempo real.
                  defensiveOptions: bossMeleeOnNonTank ? [] : defensiveOptions,
                  // Offset relativo al inicio del pull, en el mismo espacio de
                  // tiempo que trigger_time_ms de pull_mechanic_events — así
                  // el front puede alinear muertes y chips de mecánica en una
                  // única timeline sin dos unidades de tiempo distintas.
                  timeMs: death.timestamp - fight.startTime,
                  // §"golpe único vs. daño sostenido" — ver computeDeathDamageProfile.
                  ...(deathDamageProfile as NonNullable<typeof deathDamageProfile>),
                }
              : null,
            defensive_events: defensivesSeen,
            avoidable_damage_taken: avoidableDamageByTarget.get(actorId) ?? 0,
            mechanic_damage: [...(mechanicDamageByTarget.get(actorId)?.entries() ?? [])].map(([mechanicId, amount]) => ({
              mechanicId,
              mechanicName: mechanicById.get(mechanicId)?.name ?? null,
              amount,
            })),
            dps: Math.round(((damageDoneByActor.get(actorId) ?? 0) / durationSeconds) * 10) / 10,
            hps: Math.round(((healingByActor.get(actorId) ?? 0) / durationSeconds) * 10) / 10,
            absorbed_damage_taken: absorbedByTarget.get(actorId) ?? 0,
            // §compendio de defensivos: TODOS los casts de cada defensivo de
            // su clase durante el pull completo (no solo el estado en el
            // instante de morir, que vive aparte en death_cause.defensiveOptions).
            defensive_casts: actor
              ? defensivesForClass(actor.subType, resolveSpec(actorId), cooldownCatalog, talentGateForActor(actorId)).map((cd) => ({
                  spellId: cd.spellId,
                  name: cd.name,
                  timestampsMs: (defensiveCastTimestampsByActor.get(actorId)?.get(cd.spellId) ?? []).map((t) => t - fight.startTime),
                }))
              : [],
            consumables: buildConsumableUsage(defensiveCastTimestampsByActor.get(actorId), consumableIds, fight.startTime, warlockPresent),
            talent_build:
              combatantInfoByActor.get(actorId)?.talentTree?.map((node) => {
                const n = node as { id?: number; rank?: number; nodeID?: number };
                const spellId = typeof n.id === 'number' ? talentSpellLookup?.get(n.id) : undefined;
                return spellId ? { ...n, spellId } : n;
              }) ?? null,
            // Los trinkets (índices 12/13) llevan `name` inyectado — el resto
            // del gear se guarda tal cual, sin resolver (17 ítems × ~25
            // jugadores sería demasiadas llamadas para lo que aporta; los
            // trinkets son los que de verdad quiere ver un RL).
            equipped_items:
              combatantInfoByActor.get(actorId)?.gear?.map((item, i) => {
                const g = item as { id?: number };
                return TRINKET_SLOT_INDICES.includes(i) && g.id ? { ...g, name: trinketNameById.get(g.id) ?? null } : item;
              }) ?? null,
            class: actor?.subType ?? null,
            spec: resolveSpec(actorId),
            world_rank_percent: actor ? (playerRankings?.get(actor.name)?.rankPercent ?? null) : null,
            world_total_parses: actor ? (playerRankings?.get(actor.name)?.totalParses ?? null) : null,
          };
        });

        if (playerRecords.length) {
          const { error: recError } = await supabase.from('player_pull_records').insert(playerRecords);
          if (recError) throw recError;
        }

        // Timeline raid-wide (pull_mechanic_events): un cast del boss de una
        // habilidad del manifiesto = una instancia. outcome se decide con la
        // misma heurística del §12 de la hoja de ruta: si mató a alguien es
        // 'fail'; si no, y es avoidable, se compara la fracción de raid
        // golpeada contra severity_threshold (0.35 por defecto) para separar
        // "raid-wide esperado" (clean) de "demasiada gente golpeada" (partial_fail).
        const raidSize = fight.friendlyPlayers.length || 1;

        // §"la mecánica, cuánto daño ha sufrido, si ha gastado o no
        // defensivo": lo mismo que ya se calcula para una muerte
        // (damageWindowTotal/healingWindowTotal), pero SIN muerte de por
        // medio — daño real de ESTA instancia (no una ventana genérica hacia
        // atrás, aquí sí sabemos qué ability fue) + sanación recibida
        // mientras duraba + si hubo algún cast propio (cualquiera del
        // catálogo o no — defensiveCastTimestampsByActor no filtra por
        // catálogo) en la ventana [t0 − RESPONSE_WINDOW_MS, windowEnd].
        const RESPONSE_WINDOW_MS = 10_000; // mismo criterio que CLOSE_TO_DEATH_MS en el resto de la app
        interface PlayerHitDetail {
          name: string;
          damage_taken: number;
          damage_hits: number;
          healing_received: number;
          used_defensive_spell_id: number | null;
        }
        function buildPlayerHitDetails(hitTargets: Map<number, { total: number; hits: number }>, t0: number, windowEnd: number): PlayerHitDetail[] {
          const out: PlayerHitDetail[] = [];
          for (const [targetId, dmg] of hitTargets) {
            const actor = actorById.get(targetId);
            const name = actor?.name;
            if (!name) continue;
            const healingReceived = (healingEventsByTarget.get(targetId) ?? [])
              .filter((h) => h.timestamp >= t0 && h.timestamp <= windowEnd)
              .reduce((sum, h) => sum + h.amount, 0);
            // §bug real encontrado (2026-08-23, feedback real: "a Gusmï le
            // sale Wrath, que es una habilidad básica, como defensivo"):
            // defensiveCastTimestampsByActor indexa TODOS los casts del
            // jugador (rotación normal incluida), no solo su catálogo de
            // defensivos — el bucle de abajo iteraba TODAS las spells
            // castadas por el jugador y se quedaba con la primera que
            // cayera en la ventana, defensiva o no. Se acota al catálogo
            // real de su clase/spec/talentos antes de mirar timestamps.
            let usedDefensiveSpellId: number | null = null;
            const castMap = defensiveCastTimestampsByActor.get(targetId);
            const catalogSpellIds = new Set(defensivesForClass(actor.subType, resolveSpec(targetId), cooldownCatalog, talentGateForActor(targetId)).map((cd) => cd.spellId));
            if (castMap) {
              for (const [spellId, timestamps] of castMap) {
                if (!catalogSpellIds.has(spellId)) continue;
                if (timestamps.some((t) => t >= t0 - RESPONSE_WINDOW_MS && t <= windowEnd)) {
                  usedDefensiveSpellId = spellId;
                  break;
                }
              }
            }
            out.push({ name, damage_taken: dmg.total, damage_hits: dmg.hits, healing_received: healingReceived, used_defensive_spell_id: usedDefensiveSpellId });
          }
          return out;
        }

        const mechanicEventRows: {
          pull_id: string;
          ability_id: number;
          mechanic_name: string;
          description: string | null;
          category: string | null;
          responsibility: string | null;
          trigger_time_ms: number;
          outcome: 'clean' | 'partial_fail' | 'fail';
          players_hit: number;
          players_hit_names: string[];
          avoidable: boolean | null;
          player_hit_details: PlayerHitDetail[];
        }[] = [];

        for (const raw of enemyCastEvents) {
          const cast = raw as CastEvent;
          const abilityId = cast.abilityGameID;
          if (typeof abilityId !== 'number') continue;
          const mech = mechanicById.get(abilityId);
          if (!mech) continue; // solo nos interesan casts de habilidades ya curadas en el manifiesto
          const t0 = cast.timestamp ?? 0;
          const windowEnd = t0 + MECHANIC_REACTION_WINDOW_MS;

          // Mecánicas de categoría 'interrupt' respaldadas por un evento
          // Interrupt real, en un log público de referencia o en este report:
          // el outcome no se decide por daño, se decide por si hubo un
          // evento Interrupts real con extraAbilityGameID = este cast dentro
          // de la ventana de reacción. Sin partial_fail en esta v1 (saber
          // "llegó tarde" exigiría el timestamp de INICIO del cast, no solo
          // el de finalización que da el evento Casts — simplificación conocida).
          // Ni una inferencia textual ni una etiqueta editorial bastan por sí
          // solas: un cast detenido por un objeto especial del encuentro no
          // acepta necesariamente un kick estándar.
          const observedInCurrentReport = interruptEvents.some((raw) => (raw as InterruptEvent).extraAbilityGameID === abilityId);
          const effectiveCategory = effectiveMechanicCategory(mech, observedInCurrentReport);
          if (effectiveCategory === 'interrupt') {
            const wasInterrupted = interruptEvents.some((raw) => {
              const e = raw as InterruptEvent;
              const t = e.timestamp ?? 0;
              return e.extraAbilityGameID === abilityId && t >= t0 && t <= windowEnd;
            });
            mechanicEventRows.push({
              pull_id: insertedPull.id,
              ability_id: abilityId,
              mechanic_name: mech.name,
              description: mech.description,
              category: effectiveCategory,
              responsibility: mech.responsibility,
              trigger_time_ms: t0 - fight.startTime,
              outcome: wasInterrupted ? 'clean' : 'fail',
              players_hit: wasInterrupted ? 1 : 0, // reutilizado como "¿se resolvió?" para esta categoría, no cuenta jugadores golpeados
              players_hit_names: [], // players_hit no cuenta golpes aquí, así que tampoco hay nombres que dar
              avoidable: mech.avoidable,
              player_hit_details: [],
            });
            continue;
          }

          const hitTargets = new Map<number, { total: number; hits: number }>();
          for (const rawDamage of damageEvents) {
            const e = rawDamage as DamageEvent;
            if (e.abilityGameID !== abilityId) continue;
            const t = e.timestamp ?? 0;
            if (t < t0 || t > windowEnd) continue;
            if (typeof e.targetID !== 'number') continue;
            const cur = hitTargets.get(e.targetID) ?? { total: 0, hits: 0 };
            cur.total += e.amount ?? 0;
            cur.hits += 1;
            hitTargets.set(e.targetID, cur);
          }

          let causedDeath = false;
          for (const rawDeath of deathEvents) {
            const e = rawDeath as DeathEvent;
            if (e.killingAbilityGameID !== abilityId) continue;
            const t = e.timestamp ?? 0;
            if (t >= t0 && t <= windowEnd) causedDeath = true;
          }

          const ratio = hitTargets.size / raidSize;
          const threshold = mech.severity_threshold ?? 0.35;
          const outcome: 'clean' | 'partial_fail' | 'fail' = causedDeath
            ? 'fail'
            : mech.avoidable && ratio >= threshold
              ? 'partial_fail'
              : 'clean';

          const hitNames = [...hitTargets.keys()]
            .map((id) => actorById.get(id)?.name)
            .filter((n): n is string => typeof n === 'string');

          mechanicEventRows.push({
            pull_id: insertedPull.id,
            ability_id: abilityId,
            mechanic_name: mech.name,
            description: mech.description,
            category: effectiveCategory,
            responsibility: mech.responsibility,
            trigger_time_ms: t0 - fight.startTime,
            outcome,
            players_hit: hitTargets.size,
            players_hit_names: hitNames,
            avoidable: mech.avoidable,
            player_hit_details: buildPlayerHitDetails(hitTargets, t0, windowEnd),
          });
        }

        // §"en un wipe es raro que hayan salido todas las mecánicas bien"
        // (feedback real, confirmado investigando): mecánicas letales tipo
        // debuff/DoT (ej. "Elemental Explosion") pueden no generar NINGÚN
        // evento Cast en WCL — solo tics de daño — así que el bucle de
        // arriba (basado en enemyCastEvents) nunca las ve, ni para bien ni
        // para mal: quedan totalmente ausentes de pull_mechanic_events, no
        // solo "clean". Para las abilities del manifiesto que NO consiguieron
        // ni una fila arriba, se reconstruyen "instancias" agrupando sus
        // eventos de daño por proximidad temporal (un hueco > INSTANCE_GAP_MS
        // sin ningún tic = empieza una instancia nueva) — mismo criterio de
        // outcome que las basadas en cast (¿mató a alguien dentro de la
        // instancia? ¿a cuántos golpeó?), solo cambia de dónde sale t0/tEnd.
        const abilityIdsWithCastRow = new Set(mechanicEventRows.map((r) => r.ability_id));
        const INSTANCE_GAP_MS = 3000;
        for (const [abilityId, mech] of mechanicById) {
          if (abilityIdsWithCastRow.has(abilityId)) continue;
          const effectiveCategory = effectiveMechanicCategory(mech);
          if (effectiveCategory === 'interrupt') continue; // sin daño que agrupar, no aplica este mecanismo

          const events = (damageEvents as DamageEvent[])
            .filter((e) => e.abilityGameID === abilityId && typeof e.targetID === 'number')
            .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
          if (!events.length) continue; // ni cast ni daño — de verdad no ocurrió en este pull

          // Tope de duración además del hueco: un aura ambiente que tiquea
          // sin pausas de más de INSTANCE_GAP_MS durante TODO el pull (ej.
          // "Malevolent Presence", raid-wide constante) si no, se agrupa en
          // UNA sola instancia que abarca el pull entero — y si alguien
          // muere 5 minutos después, el trigger_time_ms sale del primer tic
          // (segundo 2), no del momento real. Con tope, un aura así se trocea
          // en instancias de como mucho MAX_INSTANCE_MS, cada una con su
          // propio trigger_time_ms razonable.
          const MAX_INSTANCE_MS = 20_000;
          const instances: DamageEvent[][] = [];
          for (const e of events) {
            const last = instances.at(-1);
            const withinGap = last && (e.timestamp ?? 0) - (last.at(-1)!.timestamp ?? 0) <= INSTANCE_GAP_MS;
            const withinMaxSpan = last && (e.timestamp ?? 0) - (last[0].timestamp ?? 0) <= MAX_INSTANCE_MS;
            if (last && withinGap && withinMaxSpan) last.push(e);
            else instances.push([e]);
          }

          for (const instance of instances) {
            const t0 = instance[0].timestamp ?? 0;
            const windowEnd = instance.at(-1)!.timestamp ?? 0;

            const hitTargets = new Map<number, { total: number; hits: number }>();
            for (const e of instance) {
              const cur = hitTargets.get(e.targetID!) ?? { total: 0, hits: 0 };
              cur.total += e.amount ?? 0;
              cur.hits += 1;
              hitTargets.set(e.targetID!, cur);
            }

            const causedDeath = (deathEvents as DeathEvent[]).some((e) => e.killingAbilityGameID === abilityId && (e.timestamp ?? 0) >= t0 && (e.timestamp ?? 0) <= windowEnd);
            const ratio = hitTargets.size / raidSize;
            const threshold = mech.severity_threshold ?? 0.35;
            const outcome: 'clean' | 'partial_fail' | 'fail' = causedDeath ? 'fail' : mech.avoidable && ratio >= threshold ? 'partial_fail' : 'clean';
            const hitNames = [...hitTargets.keys()].map((id) => actorById.get(id)?.name).filter((n): n is string => typeof n === 'string');

            mechanicEventRows.push({
              pull_id: insertedPull.id,
              ability_id: abilityId,
              mechanic_name: mech.name,
              description: mech.description,
              category: effectiveCategory,
              responsibility: mech.responsibility,
              trigger_time_ms: t0 - fight.startTime,
              outcome,
              players_hit: hitTargets.size,
              players_hit_names: hitNames,
              avoidable: mech.avoidable,
              player_hit_details: buildPlayerHitDetails(hitTargets, t0, windowEnd),
            });
          }
        }

        if (mechanicEventRows.length) {
          const { error: mechError } = await supabase.from('pull_mechanic_events').insert(mechanicEventRows);
          if (mechError) throw mechError;
        }
      }

      await supabase
        .from('reports')
        .update({ last_processed_fight_id: batch[batch.length - 1].id })
        .eq('code', reportCode);
    }

    return jsonResponse({ ok: true, processed: batch.length, remaining, newestPullId, possibleDuplicateOf });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
