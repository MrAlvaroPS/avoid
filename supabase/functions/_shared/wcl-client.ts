// Cliente de Warcraft Logs API v2 (GraphQL). Basado en el contrato ya
// investigado en docs/iris-sources/WARCRAFT-LOGS.md del repo original.
// Usa las credenciales WCL_CLIENT_ID / WCL_CLIENT_SECRET (client credentials,
// API pública de solo lectura — nunca la de usuario).

import { fetchWithTimeout } from './http.ts';

const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const GRAPHQL_URL = 'https://www.warcraftlogs.com/api/v2/client';
const GRAPHQL_TIMEOUT_MS = 15000; // páginas de eventos grandes pueden tardar más que el default de 8s

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Reutiliza el token en memoria hasta que esté cerca de expirar (así lo exige el contrato de WCL). */
async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }

  const clientId = Deno.env.get('WCL_CLIENT_ID');
  const clientSecret = Deno.env.get('WCL_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Faltan WCL_CLIENT_ID/WCL_CLIENT_SECRET.');

  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`WCL OAuth falló: HTTP ${res.status}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

/** Exportado para módulos que necesitan hacer una query WCL propia sin duplicar el manejo de auth. */
export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(
    GRAPHQL_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    },
    GRAPHQL_TIMEOUT_MS,
  );
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`WCL GraphQL error: ${json.errors.map((e: { message: string }) => e.message).join('; ')}`);
  }
  return json.data as T;
}

// --- Listar reports de la guild ---
// OJO: el tipo Guild de WCL NO tiene campo `reports` (verificado con
// introspección en real el 2026-08-21 — la query anterior daba
// "Cannot query field reports on type Guild" en cada llamada, así que
// sync-reports nunca pudo haber funcionado). Los reports de una guild se
// piden en dos pasos: 1) resolver el guildID numérico, 2) reportData.reports(guildID: ...).
// Ver server/wcl/queries/report-catalog.mjs del repo original.

export interface WclReportSummary {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
  zone: { id: number; name: string } | null;
}

let cachedGuildId: number | null = null;

const GUILD_ID_QUERY = `
query GuildId($name: String!, $serverSlug: String!, $serverRegion: String!) {
  guildData {
    guild(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) { id }
  }
}`;

async function getGuildId(params: { guildName: string; serverSlug: string; serverRegion: string }): Promise<number> {
  if (cachedGuildId != null) return cachedGuildId;
  const data = await graphql<{ guildData: { guild: { id: number } | null } }>(GUILD_ID_QUERY, {
    name: params.guildName,
    serverSlug: params.serverSlug,
    serverRegion: params.serverRegion,
  });
  const id = data.guildData.guild?.id;
  if (!id) throw new Error(`Guild "${params.guildName}" (${params.serverSlug}-${params.serverRegion}) no encontrada en WCL.`);
  cachedGuildId = id;
  return id;
}

const GUILD_REPORTS_QUERY = `
query GuildReports($guildId: Int!, $limit: Int!, $page: Int!, $startTime: Float) {
  reportData {
    reports(guildID: $guildId, limit: $limit, page: $page, startTime: $startTime) {
      total has_more_pages
      data { code title startTime endTime zone { id name } }
    }
  }
}`;

/**
 * Trae TODOS los reports de la guild desde `startTimeMs` (paginando hasta
 * agotar `has_more_pages`), en vez de asumir un orden de páginas concreto.
 * OJO: la API de WCL no da forma de pedir orden descendente (verificado con
 * introspección: `reportData.reports` no tiene argumento `sort`), así que
 * "coger las 3 primeras páginas" (como hacía antes esta función) asume que
 * son las más recientes — y no hay garantía de eso. Filtrar por `startTime`
 * es la única forma fiable de acotar "reports recientes" sin depender del
 * orden que devuelva la API.
 */
export async function getGuildReportsSince(
  params: { guildName: string; serverSlug: string; serverRegion: string; startTimeMs: number },
  maxPages = 20,
): Promise<WclReportSummary[]> {
  const guildId = await getGuildId(params);
  const all: WclReportSummary[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await graphql<{
      reportData: { reports: { total: number; has_more_pages: boolean; data: WclReportSummary[] } };
    }>(GUILD_REPORTS_QUERY, { guildId, limit: 100, page, startTime: params.startTimeMs });
    const batch = data.reportData.reports;
    all.push(...batch.data);
    if (!batch.has_more_pages) break;
  }
  return all;
}

// --- reportData: fights de un report concreto ---

export interface WclFight {
  id: number;
  name: string;
  difficulty: number | null;
  kill: boolean | null;
  bossPercentage: number | null;
  fightPercentage: number | null;
  startTime: number;
  endTime: number;
  encounterID: number | null;
  keystoneLevel: number | null; // presente => es Mítica+, no raid
  friendlyPlayers: number[]; // actorIDs de los jugadores que participaron EN ESTE fight concreto
}

const REPORT_FIGHTS_QUERY = `
query ReportFights($code: String!) {
  reportData {
    report(code: $code) {
      title
      startTime
      zone { id name }
      fights {
        id name difficulty kill bossPercentage fightPercentage
        startTime endTime encounterID keystoneLevel friendlyPlayers
      }
    }
  }
}`;

export async function getReportFights(
  code: string,
): Promise<{ title: string; startTime: number; zone: { id: number; name: string } | null; fights: WclFight[] }> {
  const data = await graphql<{
    reportData: {
      report: {
        title: string;
        startTime: number;
        zone: { id: number; name: string } | null;
        fights: WclFight[];
      } | null;
    };
  }>(REPORT_FIGHTS_QUERY, { code });
  if (!data.reportData.report) throw new Error(`Report ${code} no encontrado o no accesible.`);
  return data.reportData.report;
}

/**
 * Un fight es un pull real de boss (no trash, no transición, no M+) si tiene
 * encounterID y no tiene keystoneLevel. OJO: verificado en real que WCL da
 * `encounterID: 0` (no `null`) en fights de trash/transición — un simple
 * `!= null` los cuela como si fueran pulls de boss. Hay que descartar el 0.
 */
export function isEncounterFight(f: WclFight): boolean {
  return Boolean(f.encounterID) && f.keystoneLevel == null;
}

/** Un report se considera de raid (no M+) si tiene al menos un pull real de boss. */
export function isRaidReport(fights: WclFight[]): boolean {
  return fights.some(isEncounterFight);
}

// --- worldData: logs públicos GLOBALES (no de la guild) para el mismo boss+dificultad ---
// No es scraping ni nada fuera de lo previsto por WCL: fightRankings es un
// endpoint público pensado exactamente para esto (leaderboards). Sirve para
// cruzar contra un kill de referencia cuando los pulls propios (2-3 días de
// progresión) todavía no han visto, por ejemplo, un solo interrupt real.

export interface TopReportRef {
  code: string;
  fightId: number;
  startTime: number;
  endTime: number;
  /** Tamaño real de la raid en ese kill de referencia — hace falta para poder comparar "a cuánta gente golpeó" en proporción, no en bruto (un log de 20 no es un log de 30). */
  raidSize: number;
}

export interface RawRanking {
  duration: number;
  deaths: number;
  size: number;
  guildName: string | null;
  reportCode: string;
  reportFightId: number;
}

const RANKINGS_QUERY = `
query FightRankings($encounterId: Int!, $difficulty: Int!) {
  worldData {
    encounter(id: $encounterId) {
      fightRankings(difficulty: $difficulty)
    }
  }
}`;

/**
 * Hasta 50 de las mejores kills públicas de este boss+dificultad, en JSON
 * crudo (fightRankings no es un tipo GraphQL fuerte) — verificado en real
 * que trae `duration`/`deaths`/`size`/`guild.name` por cada una, no solo el
 * código de report. UNA sola llamada — de aquí salen tanto el benchmark de
 * ritmo (percentil, no solo "contra el número 1 del mundo") como las
 * referencias que se usan para inferir categoría de mecánica.
 */
export async function fetchPublicRankings(encounterId: number, wclDifficultyId: number): Promise<RawRanking[]> {
  const data = await graphql<{
    worldData: {
      encounter: {
        fightRankings: {
          rankings: { duration: number; deaths: number; size: number; guild: { name: string } | null; report: { code: string; fightID: number } }[];
        };
      } | null;
    };
  }>(RANKINGS_QUERY, { encounterId, difficulty: wclDifficultyId });
  const rankings = data.worldData.encounter?.fightRankings?.rankings ?? [];
  return rankings.map((r) => ({
    duration: r.duration,
    deaths: r.deaths,
    size: r.size,
    guildName: r.guild?.name ?? null,
    reportCode: r.report.code,
    reportFightId: r.report.fightID,
  }));
}

/** Percentil ligero (mediana + top cuartil) de ritmo, y qué fracción de las kills de referencia fueron "limpias" (0 muertes) — sin pedir ni un solo evento de fight, todo sale de fetchPublicRankings. */
export function summarizePublicRankings(rankings: RawRanking[]): {
  sampleSize: number;
  medianDurationMs: number;
  p25DurationMs: number;
  zeroDeathRate: number;
} | null {
  if (!rankings.length) return null;
  const durations = [...rankings.map((r) => r.duration)].sort((a, b) => a - b);
  const at = (p: number) => durations[Math.min(durations.length - 1, Math.floor(p * durations.length))];
  return {
    sampleSize: rankings.length,
    medianDurationMs: at(0.5),
    p25DurationMs: at(0.25),
    zeroDeathRate: Math.round((rankings.filter((r) => r.deaths === 0).length / rankings.length) * 100) / 100,
  };
}

/** Resuelve la ventana real (startTime/endTime del FIGHT) de las primeras `count` rankings — necesario para poder pedir sus eventos (Casts/DamageTaken/...). Solo se llama para un puñado (2-3), no para las 50: cada una exige una consulta getReportFights aparte. */
export async function resolveTopReportRefs(rankings: RawRanking[], count: number): Promise<TopReportRef[]> {
  const refs: TopReportRef[] = [];
  for (const ranking of rankings.slice(0, count)) {
    try {
      const detail = await getReportFights(ranking.reportCode);
      const fight = detail.fights.find((f) => f.id === ranking.reportFightId);
      if (fight) refs.push({ code: ranking.reportCode, fightId: fight.id, startTime: fight.startTime, endTime: fight.endTime, raidSize: fight.friendlyPlayers.length || ranking.size || 1 });
    } catch {
      // best-effort: una entrada del leaderboard que falle no tumba el resto
    }
  }
  return refs;
}

/** Compat: el mejor kill único, como antes — implementado sobre fetchPublicRankings+resolveTopReportRefs para no duplicar la lógica de conversión de fight window. */
export async function getTopPublicReportRef(encounterId: number, wclDifficultyId: number): Promise<TopReportRef | null> {
  const rankings = await fetchPublicRankings(encounterId, wclDifficultyId);
  const refs = await resolveTopReportRefs(rankings, 1);
  return refs[0] ?? null;
}

// --- masterData: abilities/actors de un report (para nombres legibles) ---

export interface WclAbility {
  gameID: number;
  name: string;
  type: string;
}

const MASTER_DATA_QUERY = `
query MasterData($code: String!) {
  reportData {
    report(code: $code) {
      masterData {
        abilities { gameID name type }
      }
    }
  }
}`;

export async function getReportAbilities(code: string): Promise<WclAbility[]> {
  const data = await graphql<{
    reportData: { report: { masterData: { abilities: WclAbility[] } } | null };
  }>(MASTER_DATA_QUERY, { code });
  return data.reportData.report?.masterData.abilities ?? [];
}

export interface WclActor {
  id: number;
  name: string;
  /** La clase (ej. "Warrior", "DeathKnight") — la da WCL tal cual, es la clave del catálogo de defensivos. */
  subType: string;
}

const REPORT_ACTORS_QUERY = `
query ReportActors($code: String!) {
  reportData {
    report(code: $code) {
      masterData {
        actors(type: "Player") { id name subType }
      }
    }
  }
}`;

/** Jugadores del report (id -> nombre), para poder etiquetar deaths/damage por persona. */
export async function getReportActors(code: string): Promise<WclActor[]> {
  const data = await graphql<{
    reportData: { report: { masterData: { actors: WclActor[] } } | null };
  }>(REPORT_ACTORS_QUERY, { code });
  return data.reportData.report?.masterData.actors ?? [];
}

// --- reportData.events: eventos crudos de un fight (Deaths, Casts, Buffs, DamageTaken...) ---
// Ver docs/iris-sources/WARCRAFT-LOGS.md: nunca pedir "All" para el report entero.
// Aquí siempre se filtra por fightIDs concretos.

export interface WclEventsPage<T = Record<string, unknown>> {
  data: T[];
  nextPageTimestamp: number | null;
}

const EVENTS_QUERY = `
query ReportEvents($code: String!, $fightIDs: [Int]!, $dataType: EventDataType!, $startTime: Float!, $endTime: Float!, $limit: Int, $hostilityType: HostilityType) {
  reportData {
    report(code: $code) {
      events(fightIDs: $fightIDs, dataType: $dataType, startTime: $startTime, endTime: $endTime, limit: $limit, hostilityType: $hostilityType) {
        data
        nextPageTimestamp
      }
    }
  }
}`;

/**
 * Trae eventos de UN fight y UN dataType, paginando hasta maxPages. Un pull
 * largo con daño de raid intenso puede dejar varios miles de eventos de
 * DamageTaken (verificado en real: ~315 eventos en 13s de combate) — con el
 * `limit` por defecto de WCL (300/página) y pocas páginas se trunca en
 * silencio. Por eso aquí se pide `limit: 1000` y se sube maxPages a 20 por
 * defecto (hasta 20.000 eventos), en vez del 5 anterior.
 *
 * `hostilityType: 'Enemies'` es importante para Casts cuando lo que importa
 * es SOLO lo que lanza el boss (mecánicas): verificado en real que sin este
 * filtro, los casts de ~25 jugadores ahogan los del boss dentro del mismo
 * `maxPages` (un pull de 5-6 min genera miles de casts de jugadores; los del
 * boss son unas pocas decenas) — con `maxPages` bajo (3, pensado para "solo
 * necesito ver qué lanzó el boss") la página se llena de casts de jugadores
 * antes de llegar a los del boss, y el cruce sale vacío en silencio.
 */
export async function getFightEvents(params: {
  code: string;
  fightId: number;
  dataType: 'Deaths' | 'Casts' | 'Buffs' | 'Debuffs' | 'DamageTaken' | 'DamageDone' | 'Healing' | 'Interrupts' | 'CombatantInfo';
  startTime: number;
  endTime: number;
  maxPages?: number;
  limit?: number;
  hostilityType?: 'Friendlies' | 'Enemies';
}): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  let cursor = params.startTime;
  const maxPages = params.maxPages ?? 20;

  for (let page = 0; page < maxPages; page++) {
    const data = await graphql<{
      reportData: { report: { events: WclEventsPage } | null };
    }>(EVENTS_QUERY, {
      code: params.code,
      fightIDs: [params.fightId],
      dataType: params.dataType,
      startTime: cursor,
      endTime: params.endTime,
      limit: params.limit ?? 1000,
      hostilityType: params.hostilityType ?? null,
    });
    const page_ = data.reportData.report?.events;
    if (!page_) break;
    events.push(...page_.data);
    if (page_.nextPageTimestamp == null) break;
    cursor = page_.nextPageTimestamp;
  }
  return events;
}

// --- graph: la MISMA agregación por buckets de tiempo que usa la propia web
// de WCL para su gráfica de daño/curación — server-side, no hay que traer
// miles de eventos crudos y sumarlos a mano. §"el timeline es horrible, hay
// que rehacerlo con algo real y útil".

export interface WclGraphSeries {
  name: string;
  id: number;
  pointStart: number;
  pointInterval: number;
  total: number;
  data: number[];
}

const GRAPH_QUERY = `
query ReportGraph($code: String!, $fightId: Int!, $dataType: GraphDataType!, $hostilityType: HostilityType, $startTime: Float!, $endTime: Float!) {
  reportData {
    report(code: $code) {
      graph(fightIDs: [$fightId], dataType: $dataType, hostilityType: $hostilityType, startTime: $startTime, endTime: $endTime)
    }
  }
}`;

/**
 * `graph` devuelve JSON crudo (no un tipo GraphQL fuerte): `{series: [...],
 * startTime, endTime}`, una serie por actor. OJO (bug real encontrado en
 * real): `fightIDs` por sí solo NO acota la ventana de tiempo como pasa con
 * `events` — sin `startTime`/`endTime` explícitos, devolvía datos de TODO
 * el report (222 buckets ≈ 94 min para un pull de 6 min) en vez de solo
 * este fight. Hay que pasar la ventana del fight a mano, igual que ya hace
 * `getFightEvents`.
 */
export async function getFightGraph(params: {
  code: string;
  fightId: number;
  dataType: 'DamageDone' | 'DamageTaken' | 'Healing';
  startTime: number;
  endTime: number;
  hostilityType?: 'Friendlies' | 'Enemies';
}): Promise<{ series: WclGraphSeries[]; startTime: number; endTime: number } | null> {
  const data = await graphql<{
    reportData: { report: { graph: { data: { series: WclGraphSeries[]; startTime: number; endTime: number } } } | null };
  }>(GRAPH_QUERY, {
    code: params.code,
    fightId: params.fightId,
    dataType: params.dataType,
    hostilityType: params.hostilityType ?? null,
    startTime: params.startTime,
    endTime: params.endTime,
  });
  return data.reportData.report?.graph?.data ?? null;
}

/** Suma todas las series (una por jugador) en una única serie agregada — "cuánto daño está recibiendo la RAID en conjunto en cada instante", que es lo que hace falta para el timeline visual, no el desglose por persona. */
export function sumGraphSeries(series: WclGraphSeries[]): { pointIntervalMs: number; points: number[] } | null {
  if (!series.length) return null;
  const pointIntervalMs = series[0].pointInterval;
  const length = Math.max(...series.map((s) => s.data.length));
  const points = new Array<number>(length).fill(0);
  for (const s of series) {
    for (let i = 0; i < s.data.length; i++) points[i] += s.data[i] ?? 0;
  }
  return { pointIntervalMs, points };
}
