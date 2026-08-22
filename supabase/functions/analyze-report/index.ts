import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getFightEvents, getFightGraph, sumGraphSeries, getReportAbilities, getReportActors, getReportFights, isEncounterFight, type WclActor } from '../_shared/wcl-client.ts';
import { activeDefensives, defensivesForClass, type CooldownCatalog } from '../_shared/defensive-cooldowns.ts';
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
  inferred_category: string | null;
  avoidable: boolean | null;
  severity_threshold: number | null;
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
      .select('last_processed_fight_id')
      .eq('code', reportCode)
      .maybeSingle();
    const lastProcessedFightId = reportRow?.last_processed_fight_id ?? 0;

    const reportDetail = await getReportFights(reportCode);

    // OJO (bug real encontrado en producción, corregido aquí): `report_encounters.report_code`
    // tiene FK contra `reports.code` — en un report nuevo, upsertReportEncounters tiene que
    // ejecutarse DESPUÉS de que exista la fila en `reports`, o el insert falla en silencio
    // (el helper traga el error y devuelve 0 sin avisar) y report_encounters se queda vacía.
    if (!reportRow) {
      await supabase.from('reports').upsert(
        {
          code: reportCode,
          title: reportDetail.title,
          zone_id: reportDetail.zone?.id ?? null,
          zone_name: reportDetail.zone?.name ?? null,
          is_raid: reportDetail.fights.some(isEncounterFight),
          start_time: reportDetail.startTime,
          end_time: null,
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
      const { data: catalogRows } = await supabase.from('cooldown_catalog').select('class,spec,spell_id,name,category,base_cooldown_ms');
      const cooldownCatalog: CooldownCatalog = (catalogRows ?? []).map((r) => ({
        spellId: r.spell_id,
        name: r.name,
        class: r.class,
        spec: r.spec,
        category: r.category,
        baseCooldownMs: r.base_cooldown_ms,
      }));

      // Talentos → spell ID real, para tooltips de Wowhead (ver
      // wago-db2-client.ts para la cadena TraitNodeEntry->TraitDefinition
      // verificada con datos reales). Best-effort y cacheado UNA VEZ por
      // report: si Blizzard o Wago no responden, el talentTree se guarda tal
      // cual venía de WCL (sin `spellId`) — no bloquea el análisis del report.
      let talentSpellLookup: Map<number, number> | null = null;
      try {
        const namespace = await getCurrentBuildNamespace();
        if (namespace) {
          const build = buildFromBlizzardNamespace(namespace);
          talentSpellLookup = (await fetchTalentSpellLookup(build)).entryIdToSpellId;
        }
      } catch (err) {
        console.error('No se pudieron resolver talentos a spell ID (se guardan sin resolver):', err);
      }

      for (const fight of batch) {
        const bossId = String(fight.encounterID);
        const difficulty = fight.difficulty != null ? (WCL_DIFFICULTY_NAME_BY_ID[fight.difficulty] ?? `Dificultad ${fight.difficulty}`) : 'Desconocida';

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
          .select('ability_id,name,description,category,inferred_category,avoidable,severity_threshold')
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
        for (const raw of healingEvents) {
          const e = raw as ThroughputEvent;
          if (typeof e.sourceID === 'number') healingByActor.set(e.sourceID, (healingByActor.get(e.sourceID) ?? 0) + (e.amount ?? 0));
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
            for (const cd of activeDefensives(e.buffs, actor.subType, cooldownCatalog)) {
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
        function computeDeathDamageProfile(targetId: number, deathTimestamp: number): { damageProfile: 'burst' | 'sustained' | 'unknown'; killingBlowAmount: number | null; damageWindowTotal: number; damageWindowHits: number } {
          const events = (damageEventsByTarget.get(targetId) ?? []).filter(
            (e) => (e.timestamp ?? 0) <= deathTimestamp && (e.timestamp ?? 0) >= deathTimestamp - DEATH_BURST_WINDOW_MS,
          );
          if (!events.length) return { damageProfile: 'unknown', killingBlowAmount: null, damageWindowTotal: 0, damageWindowHits: 0 };
          const windowTotal = events.reduce((sum, e) => sum + (e.amount ?? 0), 0);
          const maxHit = events.reduce((max, e) => ((e.amount ?? 0) > (max.amount ?? 0) ? e : max), events[0]);
          const killingBlowAmount = maxHit.amount ?? null;
          // "Golpe único": pocos impactos en la ventana Y uno de ellos concentra
          // la mayoría del daño — un burst de 2-3 golpes casi simultáneos se
          // trata igual que un solo golpe (es lo que un jugador percibe como
          // "me ha explotado"), no exige un ÚNICO evento literal.
          const damageProfile: 'burst' | 'sustained' = events.length <= 3 && windowTotal > 0 && (killingBlowAmount ?? 0) / windowTotal >= 0.6 ? 'burst' : 'sustained';
          return { damageProfile, killingBlowAmount, damageWindowTotal: windowTotal, damageWindowHits: events.length };
        }

        const playerRecords = fight.friendlyPlayers.map((actorId) => {
          const actor = actorById.get(actorId);
          const death = deathByTarget.get(actorId);
          const mechanic = death ? mechanicById.get(death.killingAbilityGameID) : undefined;
          const buffsSnapshot = death ? lastBuffsSnapshotByTarget.get(actorId) : undefined;
          const buffsSnapshotIsFresh = death != null && buffsSnapshot != null && Math.abs(death.timestamp - buffsSnapshot.timestamp) <= DEATH_BUFF_STALENESS_MS;
          const defensivesAtDeath = buffsSnapshotIsFresh && actor ? activeDefensives(buffsSnapshot.buffs, actor.subType, cooldownCatalog) : [];
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
              ? defensivesForClass(actor.subType, cooldownCatalog).map((cd) => {
                  if (buffsSnapshotIsFresh && activeSpellIds.has(cd.spellId)) {
                    return { spellId: cd.spellId, name: cd.name, status: 'active' as const };
                  }
                  const casts = defensiveCastTimestampsByActor.get(actorId)?.get(cd.spellId) ?? [];
                  let lastCastBefore: number | undefined;
                  for (const t of casts) {
                    if (t <= death.timestamp) lastCastBefore = t;
                    else break; // casts está ordenado cronológicamente, no hace falta seguir mirando
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
                  category: mechanic?.category ?? mechanic?.inferred_category ?? null,
                  categoryIsInferred: mechanic ? mechanic.category == null && mechanic.inferred_category != null : false,
                  avoidable: mechanic?.avoidable ?? null,
                  preventableWithDefensive: buffsSnapshotIsFresh ? defensivesAtDeath.length === 0 : null,
                  // Estado de CADA defensivo de su catálogo en el momento exacto
                  // de morir — activo, en cooldown (y cuánto le faltaba),
                  // disponible y sin usar, o sin dato de cooldown. Sustituye a
                  // los dos campos sueltos de la versión anterior
                  // (activeDefensivesAtDeath/neverCastDefensives), que solo
                  // decían "algo activo sí/no" y "lo lanzó alguna vez sí/no"
                  // sin cruzar ambas cosas con el tiempo real.
                  defensiveOptions,
                  // Offset relativo al inicio del pull, en el mismo espacio de
                  // tiempo que trigger_time_ms de pull_mechanic_events — así
                  // el front puede alinear muertes y chips de mecánica en una
                  // única timeline sin dos unidades de tiempo distintas.
                  timeMs: death.timestamp - fight.startTime,
                  // §"golpe único vs. daño sostenido" — ver computeDeathDamageProfile.
                  ...computeDeathDamageProfile(actorId, death.timestamp),
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
              ? defensivesForClass(actor.subType, cooldownCatalog).map((cd) => ({
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
            spec: (() => {
              const specId = combatantInfoByActor.get(actorId)?.specID;
              return typeof specId === 'number' ? (specNameById.get(specId) ?? null) : null;
            })(),
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
        const mechanicEventRows: {
          pull_id: string;
          ability_id: number;
          mechanic_name: string;
          description: string | null;
          category: string | null;
          trigger_time_ms: number;
          outcome: 'clean' | 'partial_fail' | 'fail';
          players_hit: number;
          avoidable: boolean | null;
        }[] = [];

        for (const raw of enemyCastEvents) {
          const cast = raw as CastEvent;
          const abilityId = cast.abilityGameID;
          if (typeof abilityId !== 'number') continue;
          const mech = mechanicById.get(abilityId);
          if (!mech) continue; // solo nos interesan casts de habilidades ya curadas en el manifiesto
          const t0 = cast.timestamp ?? 0;
          const windowEnd = t0 + MECHANIC_REACTION_WINDOW_MS;

          // Mecánicas de categoría 'interrupt' (curada a mano, o sugerida por
          // observed_as_interrupt de un log público — §sync-boss-mechanics):
          // el outcome no se decide por daño, se decide por si hubo un
          // evento Interrupts real con extraAbilityGameID = este cast dentro
          // de la ventana de reacción. Sin partial_fail en esta v1 (saber
          // "llegó tarde" exigiría el timestamp de INICIO del cast, no solo
          // el de finalización que da el evento Casts — simplificación conocida).
          // Categoría EFECTIVA: la confirmada a mano si existe, si no la
          // sugerida por sync-boss-mechanics — así una mecánica de interrupt
          // detectada con evidencia real (observed_as_interrupt) ya se trata
          // como interrupt desde el primer sync, sin esperar a que alguien
          // confirme category a mano en el manifiesto.
          const effectiveCategory = mech.category ?? mech.inferred_category;
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
              trigger_time_ms: t0 - fight.startTime,
              outcome: wasInterrupted ? 'clean' : 'fail',
              players_hit: wasInterrupted ? 1 : 0, // reutilizado como "¿se resolvió?" para esta categoría, no cuenta jugadores golpeados
              avoidable: mech.avoidable,
            });
            continue;
          }

          const hitTargets = new Set<number>();
          for (const rawDamage of damageEvents) {
            const e = rawDamage as DamageEvent;
            if (e.abilityGameID !== abilityId) continue;
            const t = e.timestamp ?? 0;
            if (t < t0 || t > windowEnd) continue;
            if (typeof e.targetID === 'number') hitTargets.add(e.targetID);
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

          mechanicEventRows.push({
            pull_id: insertedPull.id,
            ability_id: abilityId,
            mechanic_name: mech.name,
            description: mech.description,
            category: effectiveCategory,
            trigger_time_ms: t0 - fight.startTime,
            outcome,
            players_hit: hitTargets.size,
            avoidable: mech.avoidable,
          });
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

    return jsonResponse({ ok: true, processed: batch.length, remaining, newestPullId });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
