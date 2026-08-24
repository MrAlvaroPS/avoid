// Cliente de Blizzard Game Data API — Encounter Journal. Basado en
// docs/iris-sources/BLIZZARD-GAME-DATA.md del repo original.
// Usa BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET / BLIZZARD_REGION / BLIZZARD_LOCALE.

// fetchWithTimeout usa su default de 8s — de sobra para la API oficial de
// Blizzard, que es fiable; si tarda más que eso, algo va mal de verdad.
import { fetchWithTimeout } from './http.ts';

let cachedToken: { value: string; expiresAt: number } | null = null;

function region(): string {
  return Deno.env.get('BLIZZARD_REGION') ?? 'eu';
}
function locale(): string {
  // en_US por defecto (no es_ES): la búsqueda del Journal por nombre compara
  // texto exacto, y WCL siempre da los nombres de boss en inglés — con otro
  // locale por defecto, searchJournalEncounter fallaría en casi todos los bosses.
  return Deno.env.get('BLIZZARD_LOCALE') ?? 'en_US';
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  const clientId = Deno.env.get('BLIZZARD_CLIENT_ID');
  const clientSecret = Deno.env.get('BLIZZARD_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Faltan BLIZZARD_CLIENT_ID/BLIZZARD_CLIENT_SECRET.');

  const basic = btoa(`${clientId}:${clientSecret}`);
  // Host unificado (no region-specific) — es el que usa server/knowledge/providers/
  // blizzard-game-data-v1.mjs del repo original, verificado en real con estas mismas
  // credenciales el 2026-08-21. El host region-specific (eu.battle.net/oauth/token)
  // también respondió 200 en la prueba, así que no era la causa de que fallara antes;
  // se deja este por coherencia con la fuente que sabemos que funciona en producción.
  const res = await fetchWithTimeout('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Blizzard OAuth falló: HTTP ${res.status}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function gameDataGet<T>(path: string, extraParams: Record<string, string> = {}): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`https://${region()}.api.blizzard.com${path}`);
  url.searchParams.set('namespace', `static-${region()}`);
  url.searchParams.set('locale', locale());
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);

  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Blizzard Game Data ${path} -> HTTP ${res.status}`);
  return res.json();
}

export interface JournalEncounterSection {
  id?: number;
  title?: string;
  body_text?: string;
  spell?: { id: number; name: string };
  sections?: JournalEncounterSection[]; // pueden anidarse
}

export interface JournalEncounter {
  id: number;
  name: string;
  description?: string;
  sections?: JournalEncounterSection[];
}

/** Busca encuentros del Journal por nombre. Permite no tener que conocer el journalEncounterId de antemano. */
export async function searchJournalEncounter(name: string): Promise<{ id: number; name: string }[]> {
  const token = await getAccessToken();
  const url = new URL(`https://${region()}.api.blizzard.com/data/wow/search/journal-encounter`);
  url.searchParams.set('namespace', `static-${region()}`);
  url.searchParams.set(`name.${locale()}`, name);
  url.searchParams.set('orderby', 'id');
  url.searchParams.set('_pageSize', '10');

  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Blizzard journal-encounter search -> HTTP ${res.status}`);
  const data = await res.json();
  // La búsqueda devuelve { results: [{ data: { id, name: { <locale>: '...' } } }] }
  return (data.results ?? []).map((r: { data: { id: number; name: Record<string, string> } }) => ({
    id: r.data.id,
    name: r.data.name?.[locale()] ?? r.data.name?.['en_US'] ?? '',
  }));
}

/** Trae el detalle del encuentro: secciones, texto oficial y hechizos referenciados. Esta es la fuente principal para autocompletar mecánicas. */
export async function getJournalEncounter(journalEncounterId: number): Promise<JournalEncounter> {
  return gameDataGet<JournalEncounter>(`/data/wow/journal-encounter/${journalEncounterId}`);
}

/** Namespace real devuelto por Blizzard (ej. "static-12.1.0_68914-eu"). De aquí sale el build para Wago DB2. */
async function gameDataGetWithNamespace<T>(
  path: string,
  extraParams: Record<string, string> = {},
): Promise<{ payload: T; namespace: string | null }> {
  const token = await getAccessToken();
  const url = new URL(`https://${region()}.api.blizzard.com${path}`);
  url.searchParams.set('namespace', `static-${region()}`);
  url.searchParams.set('locale', locale());
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);

  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Blizzard Game Data ${path} -> HTTP ${res.status}`);
  const payload = (await res.json()) as T;
  const selfHref = (payload as { _links?: { self?: { href?: string } } })?._links?.self?.href ?? null;
  let namespace: string | null = null;
  if (selfHref) {
    try {
      namespace = new URL(selfHref).searchParams.get('namespace');
    } catch {
      // ignorar, namespace queda null
    }
  }
  return { payload, namespace };
}

/** Igual que getJournalEncounter pero además devuelve el namespace real (ej. "static-12.1.0_68914-eu"),
 * de donde sale el build exacto que hay que pedirle a Wago DB2 para la tabla de dificultades. */
export async function getJournalEncounterWithNamespace(
  journalEncounterId: number,
): Promise<{ encounter: JournalEncounter; namespace: string | null }> {
  const { payload, namespace } = await gameDataGetWithNamespace<JournalEncounter>(
    `/data/wow/journal-encounter/${journalEncounterId}`,
  );
  return { encounter: payload, namespace };
}

/**
 * Mismo endpoint que getJournalEncounter pero forzando un locale concreto
 * (ignora BLIZZARD_LOCALE) — §"las habilidades deberían estar en inglés y de
 * subtítulo en castellano para poder localizarlas bien" (feedback real): el
 * resto del cliente pide en en_US a propósito (para que searchJournalEncounter
 * case con los nombres de boss de WCL, siempre en inglés), así que el nombre
 * en castellano de cada habilidad hace falta como una llamada aparte.
 */
export async function getJournalEncounterLocalized(journalEncounterId: number, locale: string): Promise<JournalEncounter> {
  const token = await getAccessToken();
  const url = new URL(`https://${region()}.api.blizzard.com/data/wow/journal-encounter/${journalEncounterId}`);
  url.searchParams.set('namespace', `static-${region()}`);
  url.searchParams.set('locale', locale);
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Blizzard Game Data journal-encounter (${locale}) -> HTTP ${res.status}`);
  return res.json();
}

// --- journal-instance: catálogo de raids/mazmorras (§9.1) ------------------
// No existe /data/wow/search/journal-instance (verificado en real: HTTP
// 404) — a diferencia de journal-encounter, la única vía real es el índice
// completo (/data/wow/journal-instance/index, ~213 entradas) y filtrar en
// memoria. Cacheado en memoria: la lista de instancias no cambia dentro de
// la vida de una misma invocación de función, y varias no van a repetir la
// misma llamada de 213 filas para lo mismo.
interface JournalInstanceIndexEntry {
  id: number;
  name: string;
}
let cachedInstanceIndex: JournalInstanceIndexEntry[] | null = null;

export interface JournalInstanceEncounter {
  id: number;
  name: string;
}
export interface JournalInstanceDetail {
  id: number;
  name: string;
  encounters?: JournalInstanceEncounter[];
  order_index?: number;
}

async function getJournalInstanceIndex(): Promise<JournalInstanceIndexEntry[]> {
  if (cachedInstanceIndex) return cachedInstanceIndex;
  const data = await gameDataGet<{ instances?: JournalInstanceIndexEntry[] }>('/data/wow/journal-instance/index');
  cachedInstanceIndex = data.instances ?? [];
  return cachedInstanceIndex;
}

/** Busca una instancia (raid/mazmorra) por nombre exacto (case-insensitive) — no hay endpoint de búsqueda real para journal-instance, así que se filtra el índice completo. */
export async function findJournalInstanceByName(name: string): Promise<JournalInstanceIndexEntry | null> {
  const index = await getJournalInstanceIndex();
  return index.find((i) => i.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export async function getJournalInstance(journalInstanceId: number): Promise<JournalInstanceDetail> {
  return gameDataGet<JournalInstanceDetail>(`/data/wow/journal-instance/${journalInstanceId}`);
}

let cachedNamespace: string | null | undefined;

/**
 * El namespace real del build actual (ej. "static-12.1.0_68914-eu"), sin
 * depender de conocer un journalEncounterId de antemano — cualquier endpoint
 * de Game Data lo devuelve en `_links.self.href`, así que se pide el más
 * barato posible (el índice de clases). Cacheado en memoria: el build no
 * cambia dentro de la vida de una misma instancia de la función.
 */
export async function getCurrentBuildNamespace(): Promise<string | null> {
  if (cachedNamespace !== undefined) return cachedNamespace;
  const { namespace } = await gameDataGetWithNamespace<unknown>('/data/wow/playable-class/index');
  cachedNamespace = namespace;
  return namespace;
}

export interface FlattenedJournalAbility {
  abilityId: number;
  name: string;
  description: string;
  /** IDs de todas las secciones (padre + hijas) que mencionan este hechizo — hace falta para el cruce de dificultad con DB2. */
  sectionIds: number[];
}

/** Aplana recursivamente las secciones del Journal en una lista de candidatos, agrupando por abilityId. */
// --- Resolución de nombres: items (trinkets) y specs, para no enseñar IDs crudos en pantalla ---

const itemNameCache = new Map<number, string | null>();

/** Nombre real de un ítem (usado para trinkets). Cachea en memoria — la misma instancia de función se reutiliza entre invocaciones mientras esté "caliente", así que un trinket ya resuelto no vuelve a pedirse. */
export async function getItemName(itemId: number): Promise<string | null> {
  if (itemNameCache.has(itemId)) return itemNameCache.get(itemId)!;
  try {
    const data = await gameDataGet<{ name: string }>(`/data/wow/item/${itemId}`);
    itemNameCache.set(itemId, data.name);
    return data.name;
  } catch {
    itemNameCache.set(itemId, null); // 404 u otro fallo: no reintentar en cada llamada de este mismo proceso
    return null;
  }
}

const specNameCache = new Map<number, string | null>();

/** "Destruction" (sin el nombre de clase — WCL ya da la clase por separado en actor.subType). */
export async function getSpecName(specId: number): Promise<string | null> {
  if (specNameCache.has(specId)) return specNameCache.get(specId)!;
  try {
    const data = await gameDataGet<{ name: string }>(`/data/wow/playable-specialization/${specId}`);
    specNameCache.set(specId, data.name);
    return data.name;
  } catch {
    specNameCache.set(specId, null);
    return null;
  }
}

// tildes fuera tras NFKD (wowaudit da nombres de reino con acentos, la API
// los quiere sin) — rango Unicode de marcas diacríticas combinantes (U+0300
// a U+036F) construido con String.fromCharCode a partir de puntos de código
// en vez de caracteres literales en el fuente, para no arriesgarse a que la
// codificación del archivo los corrompa.
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    // §bug real encontrado (2026-08-23, verificado contra la API real: solo
    // 18/30 avatares se resolvieron): el slug oficial de Blizzard ELIMINA
    // el apóstrofe ("C'Thun" -> "cthun", "Zul'jin" -> "zuljin"), no lo
    // convierte en guión — antes de colapsar el resto de símbolos (que sí
    // se convierten en guión, ej. espacios: "Bleeding Hollow" -> "bleeding-hollow").
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * §"un poco como un dosier de personaje... una foto suya de perfil si
 * podemos tenerla (de su personaje)": Character Media API — un namespace
 * DISTINTO al resto de este cliente (profile-{region}, no static-{region}),
 * pero mismo token de app (client_credentials) — no hace falta OAuth de
 * usuario para leer datos públicos de personaje. Best-effort: null si el
 * personaje no existe con ese nombre+reino, tiene el perfil oculto, o
 * cualquier otro fallo — nunca debe tumbar el sync del roster por esto.
 */
export async function getCharacterAvatarUrl(realmName: string, characterName: string): Promise<string | null> {
  try {
    const token = await getAccessToken();
    const url = new URL(`https://${region()}.api.blizzard.com/profile/wow/character/${slugify(realmName)}/${characterName.toLowerCase()}/character-media`);
    url.searchParams.set('namespace', `profile-${region()}`);
    url.searchParams.set('locale', locale());
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = await res.json();
    const assets = (data.assets ?? []) as { key: string; value: string }[];
    return assets.find((a) => a.key === 'avatar')?.value ?? null;
  } catch {
    return null;
  }
}

export function flattenJournalSections(
  sections: JournalEncounterSection[] | undefined,
  out: Map<number, FlattenedJournalAbility> = new Map(),
  path: number[] = [],
): FlattenedJournalAbility[] {
  for (const section of sections ?? []) {
    const sectionId = section.id ?? null;
    const currentPath = sectionId != null ? [...path, sectionId] : path;
    if (section.spell) {
      const existing = out.get(section.spell.id);
      const sectionIds = sectionId != null ? currentPath : path;
      if (existing) {
        for (const id of sectionIds) if (!existing.sectionIds.includes(id)) existing.sectionIds.push(id);
      } else {
        out.set(section.spell.id, {
          abilityId: section.spell.id,
          name: section.spell.name,
          description: section.body_text ?? section.title ?? '',
          sectionIds: [...sectionIds],
        });
      }
    }
    if (section.sections?.length) flattenJournalSections(section.sections, out, currentPath);
  }
  return [...out.values()];
}
