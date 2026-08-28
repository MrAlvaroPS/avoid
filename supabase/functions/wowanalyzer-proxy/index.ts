// §"informe de mejora por jugador... wowanalyzer para mejorar las
// rotaciones" (feedback real, 2026-08-27): backend mínimo para autoalojar
// la SPA REAL de WoWAnalyzer (ver supabase/wowanalyzer-app/) sin depender de
// wowanalyzer.com. Su frontend NO llama a WCL directamente — llama a SU
// PROPIO backend (src/common/fetchWclApi.ts, src/common/makeApiUrl.ts del
// repo real: `${VITE_SERVER_BASE}${VITE_API_BASE}${endpoint}`) con un
// contrato REST heredado de WCL v1 (4 endpoints: report/fights/:code,
// report/events/:code, report/tables/:table/:code, y v2/report/:code/
// fight/:fightId/players — este último descubierto leyendo PlayerLoader.tsx
// del repo real: sin él, la app se queda colgada en "Fetching player
// info..." para siempre, porque getConfig() necesita el specID de cada
// jugador para elegir qué analizador cargar). Ese backend no es parte de
// su repo open source — así que en vez de depender de wowanalyzer.com
// (un enlace externo, lo que se pidió evitar) esto RE-IMPLEMENTA ese
// contrato encima de nuestro propio cliente WCL v2 (_shared/wcl-client.ts +
// graphql() crudo), con las credenciales que esta app ya usa.
//
// Verificado en real contra la API de WCL (2026-08-27, introspección +
// llamadas reales, no solo lectura de docs):
// - report.events(startTime, endTime, ...) NO exige fightIDs — con solo la
//   ventana de un fight concreto, WCL ya acota correctamente a ESE fight
//   (confirmado: cada evento devuelto trae "fight": <el que se pidió>).
// - dataType: All existe y trae el stream completo intercalado (casts +
//   daño + heals + buffs + combatantinfo...), justo lo que necesita
//   WoWAnalyzer y que el resto de esta app nunca había pedido (siempre pide
//   un dataType concreto para mecánicas de boss).
// - InterruptEvent y compañía SÍ traen sourceID en el JSON crudo de WCL —
//   nunca hacía falta convertir nada.
// - fight.startTime/endTime y los timestamps de evento comparten la MISMA
//   base (confirmado: timestamps de interrupt de ~5.000.000 ms en el fight
//   #28 de una noche larga — relativo al REPORT, no al fight ni un epoch
//   absoluto) — como ambos números salen de la MISMA respuesta y todo
//   consumidor (el nuestro y el de WoWAnalyzer) solo calcula diferencias
//   relativas, un pass-through sin tocar la base es correcto sin conversión.
//
// Login/premium NO hace falta implementarlos: WoWAnalyzer bypassea el gate
// de premium enteramente si se compila con VITE_FORCE_PREMIUM=true (ver
// src/interface/reducers/user.ts del repo real), y su intento de
// fetch(`${VITE_SERVER_BASE}user`) falla en silencio si no existe (mismo
// archivo) — no hace falta servir /user, /login/wcl ni /logout para nada.

import { graphql, getReportFights, getReportActors, getReportAbilities, type WclActor } from '../_shared/wcl-client.ts';

function corsHeadersFor(req: Request): Record<string, string> {
  // §mismo motivo que _shared/cors.ts pero con una diferencia real: el
  // fetch de WoWAnalyzer usa `credentials: 'include'` (rawFetchWcl en su
  // fuente real) — con eso, Access-Control-Allow-Origin: '*' lo RECHAZA el
  // navegador (la spec de CORS lo prohíbe combinado con credentials). Hay
  // que reflejar el origin exacto que pide, no un wildcard.
  const origin = req.headers.get('origin') ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' } });
}

function errorJson(req: Request, message: string, status = 500): Response {
  // Mismo contrato que espera fetchWclApi.ts real: { error, message }.
  return json(req, { error: 'Warcraft Logs API error', message }, status);
}

// --- report/fights/:code --------------------------------------------------
// Reconstruye WCLReport (parser/core/Report.ts del repo real de WoWAnalyzer)
// a partir de getReportFights + getReportActors.

async function handleFights(req: Request, code: string): Promise<Response> {
  const [report, actors] = await Promise.all([getReportFights(code), getReportActors(code)]);

  const fightIdsByActor = new Map<number, number[]>();
  for (const f of report.fights) {
    for (const pid of f.friendlyPlayers) {
      const arr = fightIdsByActor.get(pid);
      if (arr) arr.push(f.id);
      else fightIdsByActor.set(pid, [f.id]);
    }
  }
  const asUnit = (a: WclActor) => ({ name: a.name, id: a.id, guid: 0, type: a.type, subType: a.subType, icon: '' });

  const friendlies = actors
    .filter((a) => a.type === 'Player')
    .map((a) => ({ ...asUnit(a), fights: (fightIdsByActor.get(a.id) ?? []).map((id) => ({ id })) }));
  // Enemigos/mascotas: WCL v2 no da barato "en qué fights concretos apareció
  // cada NPC" sin pedir enemigos por fight (no se pide aquí) — se listan
  // igualmente con fights:[] porque el parser de WoWAnalyzer identifica
  // enemigos por los propios eventos (sourceID/targetID), no por esta lista;
  // solo se usa para nombres/iconos en la UI.
  const enemies = actors
    .filter((a) => a.type !== 'Player' && a.type !== 'Pet')
    .map((a) => ({ ...asUnit(a), fights: [] as { id: number; groups: number; instances: number }[] }));
  const friendlyPets = actors
    .filter((a) => a.type === 'Pet')
    .map((a) => ({ ...asUnit(a), fights: [] as { id: number }[], petOwner: 0 }));

  const fights = report.fights.map((f) => ({
    id: f.id,
    // Pass-through deliberado: ver nota de cabecera sobre la base de tiempo.
    start_time: f.startTime,
    end_time: f.endTime,
    boss: f.encounterID ?? 0,
    name: f.name,
    size: f.friendlyPlayers.length,
    difficulty: f.difficulty ?? undefined,
    kill: f.kill ?? undefined,
    bossPercentage: f.bossPercentage ?? undefined,
    fightPercentage: f.fightPercentage ?? undefined,
    phases: (f.phaseTransitions ?? []).map((t) => ({ id: t.id, startTime: t.startTime })),
  }));

  const phases = report.phases.map((p) => ({
    boss: p.encounterID,
    separatesWipes: !!p.separatesWipes,
    phases: Object.fromEntries(p.phases.map((ph) => [ph.id, ph.name])),
    intermissions: p.phases.filter((ph) => ph.isIntermission).map((ph) => ph.id),
  }));

  return json(req, {
    fights,
    lang: 'en',
    friendlies,
    enemies,
    friendlyPets,
    enemyPets: [],
    phases,
    logVersion: 2,
    // §"This report is for a previous expansion" (bug real visto en real,
    // 2026-08-27): verificado en game/VERSIONS.ts del repo real —
    // gameVersion===1 es Retail; cualquier otro valor 2-5 lo trata como una
    // expansión Classic vieja y bloquea el análisis (isUnsupportedClassicVersion).
    // WCL v2 no expone un campo "gameVersion" de esta forma en absoluto (es
    // un concepto propio del backend de WoWAnalyzer, no de WCL) — como esta
    // app y su proxy solo sirven logs de retail, 1 fijo es correcto.
    gameVersion: 1,
    title: report.title,
    owner: '',
    start: report.startTime,
    end: report.startTime,
    zone: report.zone?.id ?? 0,
    exportedCharacters: [],
  });
}

// --- report/events/:code ---------------------------------------------------
// UNA página por llamada — WoWAnalyzer pagina solo (fetchEvents en su fuente
// real ya sube pageStartTimestamp con el nextPageTimestamp de la respuesta
// anterior), así que este proxy NO debe pre-agregar como getFightEvents.

const RAW_EVENTS_QUERY = `
query Events($code: String!, $start: Float!, $end: Float!, $sourceId: Int, $filter: String, $translate: Boolean) {
  reportData {
    report(code: $code) {
      events(startTime: $start, endTime: $end, dataType: All, sourceID: $sourceId, filterExpression: $filter, translate: $translate, limit: 300) {
        data
        nextPageTimestamp
      }
    }
  }
}`;

// §"si le doy al botón de rotación salta un error en wowanalyzer" (feedback
// real, 2026-08-27, error real reproducido: "Cannot read properties of
// undefined (reading 'guid')" en CancelledCasts.normalize/handleCast del
// repo real). Investigado leyendo su fuente: Events.ts documenta que TODO
// evento con habilidad necesita un objeto anidado `ability: {name, guid,
// type, abilityIcon}` (guid = el spellId) — verificado en real que el JSON
// crudo de WCL v2 SOLO trae `abilityGameID` (número suelto, sin anidar,
// confirmado contra un evento real de esta sesión). WoWAnalyzer espera el
// formato clásico de WCL v1 (anidado); v2 lo aplanó. Sin esta traducción, su
// normalizador genérico (no un análisis de spec concreto) revienta en
// CUALQUIER cast, de cualquier jugador — por eso el error salta con
// cualquier reporte/jugador, no algo específico de Sszorak/Jënnis.
const abilitiesCache = new Map<string, Map<number, { name: string; type: string }>>();
async function getAbilitiesById(code: string): Promise<Map<number, { name: string; type: string }>> {
  const cached = abilitiesCache.get(code);
  if (cached) return cached;
  const abilities = await getReportAbilities(code);
  const byId = new Map(abilities.map((a) => [a.gameID, { name: a.name, type: a.type }]));
  abilitiesCache.set(code, byId);
  return byId;
}

/** Añade `ability: {name, guid, type, abilityIcon}` a cada evento que traiga abilityGameID — deja el resto tal cual. abilityIcon vacío a propósito: no lo da WCL v2 por esta vía, y es cosmético (icono en blanco), no bloqueante como sí lo es `ability` entero faltando. */
function attachAbilityInfo(events: unknown[], abilitiesById: Map<number, { name: string; type: string }>): unknown[] {
  return events.map((raw) => {
    const event = raw as Record<string, unknown>;
    const abilityGameID = event.abilityGameID;
    if (typeof abilityGameID !== 'number') return event;
    const info = abilitiesById.get(abilityGameID);
    return {
      ...event,
      ability: { name: info?.name ?? `Unknown (${abilityGameID})`, guid: abilityGameID, type: info?.type ?? 0, abilityIcon: '' },
    };
  });
}

async function handleEvents(req: Request, code: string, url: URL): Promise<Response> {
  const start = Number(url.searchParams.get('start'));
  const end = Number(url.searchParams.get('end'));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return errorJson(req, 'start/end son obligatorios', 400);
  const actorIdParam = url.searchParams.get('actorid');
  const sourceId = actorIdParam ? Number(actorIdParam) : null;
  const filter = url.searchParams.get('filter');
  const translate = url.searchParams.get('translate') === 'true';

  const [data, abilitiesById] = await Promise.all([
    graphql<{ reportData: { report: { events: { data: unknown[]; nextPageTimestamp: number | null } } | null } }>(RAW_EVENTS_QUERY, {
      code,
      start,
      end,
      sourceId,
      filter,
      translate,
    }),
    getAbilitiesById(code),
  ]);
  const page = data.reportData.report?.events;
  if (!page) return errorJson(req, 'This report does not exist or is private.', 404);
  return json(req, { events: attachAbilityInfo(page.data, abilitiesById), nextPageTimestamp: page.nextPageTimestamp ?? undefined });
}

// --- report/tables/:table/:code --------------------------------------------

const TABLE_DATA_TYPE: Record<string, string> = {
  summary: 'Summary',
  'damage-done': 'DamageDone',
  'damage-taken': 'DamageTaken',
  healing: 'Healing',
  casts: 'Casts',
  summons: 'Summons',
  buffs: 'Buffs',
  debuffs: 'Debuffs',
  deaths: 'Deaths',
  survivability: 'Survivability',
  resources: 'Resources',
  'resources-gains': 'Resources', // §WCL v2 TableDataType no separa "gains" — sin equivalente exacto, ver introspección en la cabecera del archivo.
  threat: 'Threat',
};

const RAW_TABLE_QUERY = `
query Table($code: String!, $start: Float!, $end: Float!, $dataType: TableDataType!, $sourceId: Int) {
  reportData {
    report(code: $code) {
      table(startTime: $start, endTime: $end, dataType: $dataType, sourceID: $sourceId)
    }
  }
}`;

async function handleTable(req: Request, table: string, code: string, url: URL): Promise<Response> {
  const dataType = TABLE_DATA_TYPE[table];
  if (!dataType) return errorJson(req, `Tabla desconocida: ${table}`, 400);
  const start = Number(url.searchParams.get('start'));
  const end = Number(url.searchParams.get('end'));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return errorJson(req, 'start/end son obligatorios', 400);
  const actorIdParam = url.searchParams.get('actorid');
  const sourceId = actorIdParam ? Number(actorIdParam) : null;

  const data = await graphql<{ reportData: { report: { table: { data: unknown } } | null } }>(RAW_TABLE_QUERY, { code, start, end, dataType, sourceId });
  const body = data.reportData.report?.table?.data;
  if (body === undefined) return errorJson(req, 'This report does not exist or is private.', 404);
  return json(req, body);
}

// --- v2/report/:code/fight/:fightId/players --------------------------------
// §descubierto leyendo interface/report/PlayerLoader.tsx del repo real (NO
// está en fetchWclApi.ts, que solo cubre los otros 3 endpoints) — resuelve
// className/specID/role por jugador para que getConfig(branch, specID,...)
// pueda elegir el analizador correcto. Sin esto la app se queda colgada en
// "Fetching player info..." para siempre.

const COMBATANT_INFO_QUERY = `
query CombatantInfo($code: String!, $fightId: Int!, $start: Float!, $end: Float!) {
  reportData {
    report(code: $code) {
      events(fightIDs: [$fightId], dataType: CombatantInfo, startTime: $start, endTime: $end, limit: 100) { data }
    }
  }
}`;

// specID -> role: mismo criterio que TANK_SPEC_KEYS/HEALER_SPEC_KEYS de
// _shared/night-full-report.ts, pero indexado por specID (numeración de
// Blizzard, estable entre expansiones) para no depender de una llamada
// extra a la API de Blizzard solo para esto.
const TANK_SPEC_IDS = new Set([73, 66, 250, 104, 268, 581]); // Warrior Prot, Paladin Prot, DK Blood, Druid Guardian, Monk Brewmaster, DH Vengeance
const HEALER_SPEC_IDS = new Set([65, 256, 257, 264, 105, 270, 1468]); // Paladin Holy, Priest Disc/Holy, Shaman Resto, Druid Resto, Monk Mistweaver, Evoker Preservation
function roleForSpecId(specId: number | undefined): 'tank' | 'healer' | 'dps' {
  if (specId != null && TANK_SPEC_IDS.has(specId)) return 'tank';
  if (specId != null && HEALER_SPEC_IDS.has(specId)) return 'healer';
  return 'dps';
}

interface CombatantInfoEventLite {
  sourceID?: number;
  specID?: number;
  gear?: { itemLevel?: number }[];
}

async function handlePlayers(req: Request, code: string, fightIdParam: string): Promise<Response> {
  const fightId = Number(fightIdParam);
  if (!Number.isFinite(fightId)) return errorJson(req, 'fightId inválido', 400);
  const [report, actors] = await Promise.all([getReportFights(code), getReportActors(code)]);
  const fight = report.fights.find((f) => f.id === fightId);
  if (!fight) return errorJson(req, `Fight ${fightId} no encontrado.`, 404);
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const data = await graphql<{ reportData: { report: { events: { data: CombatantInfoEventLite[] } } | null } }>(
    COMBATANT_INFO_QUERY,
    { code, fightId, start: fight.startTime, end: fight.endTime },
  );
  const combatantInfos = data.reportData.report?.events?.data ?? [];

  const players = combatantInfos
    .filter((info): info is CombatantInfoEventLite & { sourceID: number } => typeof info.sourceID === 'number' && fight.friendlyPlayers.includes(info.sourceID))
    .map((info) => {
      const actor = actorById.get(info.sourceID);
      const gearLevels = (info.gear ?? []).map((g) => g.itemLevel).filter((n): n is number => typeof n === 'number');
      const ilvl = gearLevels.length ? Math.round(gearLevels.reduce((a, b) => a + b, 0) / gearLevels.length) : undefined;
      return {
        id: info.sourceID,
        name: actor?.name ?? 'Unknown',
        server: '',
        region: '',
        ilvl,
        className: actor?.subType ?? 'Unknown',
        specID: info.specID,
        role: roleForSpecId(info.specID),
        guid: 0,
      };
    });

  return json(req, { players });
}

// --- routing -----------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(req) });

  const url = new URL(req.url);
  // El path real que llega aquí es .../functions/v1/wowanalyzer-proxy/report/fights/CODE
  const parts = url.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('wowanalyzer-proxy');
  const afterFnName = i >= 0 ? parts.slice(i + 1) : parts;

  try {
    // §"players" (PlayerLoader.tsx del repo real) usa prefijo v2/, los
    // otros 3 endpoints (fetchWclApi.ts) usan v1/ — ambos hardcodeados en
    // fuente, no dependen de VITE_API_BASE, así que se comprueban ANTES de
    // asumir un único prefijo. Se acepta también sin ningún prefijo por
    // robustez.
    if (afterFnName[0] === 'v2' && afterFnName[1] === 'report' && afterFnName[2] && afterFnName[3] === 'fight' && afterFnName[4] && afterFnName[5] === 'players') {
      return await handlePlayers(req, afterFnName[2], afterFnName[4]);
    }

    let rest = afterFnName;
    if (rest[0] === 'v1') rest = rest.slice(1);

    if (rest[0] === 'report' && rest[1] === 'fights' && rest[2]) {
      return await handleFights(req, rest[2]);
    }
    if (rest[0] === 'report' && rest[1] === 'events' && rest[2]) {
      return await handleEvents(req, rest[2], url);
    }
    if (rest[0] === 'report' && rest[1] === 'tables' && rest[2] && rest[3]) {
      return await handleTable(req, rest[2], rest[3], url);
    }
    // user/login/logout: WoWAnalyzer los llama pero tolera que fallen (ver
    // cabecera del archivo) — devolver 404 en vez de dejar el fetch colgado.
    return errorJson(req, `No implementado: ${url.pathname}`, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('wowanalyzer-proxy falló:', message);
    return errorJson(req, message, 502);
  }
});
