import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';

// §"un bot que crea canales privados dentro de una categoría... solo para
// rango Raider" (feedback real, 2026-08-28): mismo patrón que
// send-discord-message (REST directo con el bot token, sin gateway) — aquí
// además MANAGE_CHANNELS/MANAGE_ROLES, que hay que concederle al bot a mano
// una vez en Ajustes del servidor de Discord (eso no se puede hacer por API).
//
// WoWAudit no expone ningún Discord ID (comprobado empíricamente: con la key
// normal Y con una de "management", /v1/members y variantes devuelven la SPA
// de wowaudit, no JSON — no existen como endpoints reales; solo
// /v1/characters, /v1/attendance, /v1/team y /v1/period lo son). La
// vinculación personaje↔Discord se hace a mano (action=save-link).
//
// §"quiero quitar que no se creen canales para los oficiales, tambien se
// tienen que crear y tiene que permitirse enviar su infografia" (feedback
// real, 2026-08-29): la exclusión original de oficiales se ha quitado —
// elegible = rank Main de verdad en WoWAudit, punto. officers_role_id (el
// mismo rol de Discord que da visibilidad a TODOS los canales) se sigue
// resolviendo y guardando como is_officer, pero ahora es solo informativo
// (el badge "Oficial" en Ajustes → Discord) — ya no bloquea la creación del
// canal ni el envío de infografías, que solo depende de tener
// discord_channel_id (ver night-player-summary.service.ts).
const DISCORD_API = 'https://discord.com/api/v10';
const PERM_VIEW_CHANNEL = 1024n; // 0x400
const PERM_SEND_MESSAGES = 2048n; // 0x800
const PERM_READ_MESSAGE_HISTORY = 4194304n; // 0x400000
const PLAYER_ALLOW = PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_MESSAGE_HISTORY;

interface Env {
  botToken: string;
  guildId: string;
}

interface DiscordRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}
interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  parent_id: string | null;
  guild_id?: string;
  position?: number;
}
interface DiscordGuildMember {
  user?: { id: string; username: string; global_name: string | null };
  nick: string | null;
  roles: string[];
}

interface RosterRow {
  character_id: number;
  name: string;
  rank: string;
}
interface LinkRow {
  character_id: number;
  character_name: string;
  discord_user_id: string;
  discord_display_name: string | null;
  discord_channel_id: string | null;
  is_officer: boolean;
  linked_at: string;
}
interface SettingsRow {
  category_id: string | null;
  officers_role_id: string | null;
}

function discordFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${env.botToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

// Discord solo acepta minúsculas/números/guiones en nombres de canal de
// texto — los nombres de personaje llevan tildes/diéresis reales en este
// roster (Lorsirïus, Shodåw, Gusmï…), de ahí el NFD + strip de diacríticos.
function slugify(name: string): string {
  const ascii = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // marcas diacríticas combinantes (tildes, diéresis…) tras el NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (ascii || 'player').slice(0, 90);
}
// §"el canal que se haga con: 💬・(nombre de jugador)" (feedback real,
// 2026-08-28): Discord SÍ acepta emoji y Unicode (・ = punto medio
// katakana, U+30FB) en nombres de canal, no hace falta quedarse en
// ASCII+guion — solo se sigue pasando por slugify() la parte del nombre
// (minúsculas, sin tildes) porque Discord fuerza minúsculas igualmente.
function channelNameFor(characterName: string): string {
  return `💬・${slugify(characterName)}`;
}

// §"he puesto todos los id's de discord y le doy a sincronizar y ha dado
// error... los ids los he cogido del servidor de discord así que ese error
// es falso" (feedback real, 2026-08-28): confirmado — 5 comprobaciones
// (BATCH) salían bien y las 17 siguientes fallaban en bloque, patrón
// clásico de rate limit de Discord (429), no de "ya no está en el
// servidor". 'not-a-member' (404 de verdad) y 'unknown' (429/500/red — NO
// SABEMOS si sigue en el servidor) ahora son casos distintos: solo el
// primero puede borrar un canal en handleSync, el segundo se salta el grupo
// entero sin tocar nada (ver más abajo) — antes ambos se trataban igual,
// que además de este mensaje falso podía borrar canales de gente que sigue
// en el servidor si un sync futuro chocaba con el límite a media pasada.
async function fetchGuildMember(env: Env, discordUserId: string, attempt = 0): Promise<DiscordGuildMember | 'not-a-member' | 'unknown'> {
  const res = await discordFetch(env, `/guilds/${env.guildId}/members/${discordUserId}`);
  if (res.status === 404) return 'not-a-member';
  if (res.status === 429 && attempt < 3) {
    const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
    const waitMs = Math.ceil((body?.retry_after ?? 1) * 1000) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return fetchGuildMember(env, discordUserId, attempt + 1);
  }
  if (!res.ok) return 'unknown';
  return (await res.json()) as DiscordGuildMember;
}

function displayNameOf(member: DiscordGuildMember): string {
  return member.nick ?? member.user?.global_name ?? member.user?.username ?? 'desconocido';
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  const botToken = Deno.env.get('DISCORD_BOT_TOKEN');
  const guildId = Deno.env.get('DISCORD_GUILD_ID');
  if (!botToken) return jsonResponse({ ok: false, error: 'Falta DISCORD_BOT_TOKEN en los secrets del proyecto Supabase.' }, 500);
  if (!guildId) return jsonResponse({ ok: false, error: 'Falta DISCORD_GUILD_ID en los secrets del proyecto Supabase.' }, 500);
  const env: Env = { botToken, guildId };

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let body: { action?: string; [key: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }

  try {
    switch (body.action) {
      case 'get-config':
        return await handleGetConfig(env, supabase);
      case 'list-guild-categories':
        return await handleListCategories(env);
      case 'list-guild-roles':
        return await handleListRoles(env);
      case 'save-config':
        return await handleSaveConfig(env, supabase, body as { categoryId?: string; officersRoleId?: string });
      case 'save-link':
        return await handleSaveLink(env, supabase, body as { characterId?: number; characterName?: string; discordUserId?: string });
      case 'remove-link':
        return await handleRemoveLink(env, supabase, body as { characterId?: number });
      case 'sync':
        return await handleSync(env, supabase);
      default:
        return jsonResponse({ ok: false, error: `action desconocida: ${String(body.action)}` }, 400);
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
async function handleGetConfig(env: Env, supabase: any): Promise<Response> {
  const [{ data: settings, error: settingsError }, { data: links, error: linksError }, { data: roster, error: rosterError }] = await Promise.all([
    supabase.from('discord_roster_channels_settings').select('category_id, officers_role_id').eq('id', true).maybeSingle(),
    supabase.from('discord_roster_channels').select('*').order('character_name', { ascending: true }),
    supabase.from('wowaudit_roster').select('character_id, name, rank').order('name', { ascending: true }),
  ]);
  if (settingsError) throw settingsError;
  if (linksError) throw linksError;
  if (rosterError) throw rosterError;
  // guildId no es secreto (es el mismo ID visible en cualquier URL de canal
  // de este servidor) — se manda para que el frontend pueda montar enlaces
  // "abrir en Discord" (https://discord.com/channels/{guildId}/{channelId}).
  return jsonResponse({ ok: true, guildId: env.guildId, settings: settings ?? { category_id: null, officers_role_id: null }, links: links ?? [], roster: roster ?? [] });
}

// TEMPORAL: diagnóstico de un incidente real (canal creado en Discord pero
// sin fila en discord_roster_channels) — se quita en cuanto se entienda qué pasó.
async function handleDebugListChannels(env: Env): Promise<Response> {
  const res = await discordFetch(env, `/guilds/${env.guildId}/channels`);
  if (!res.ok) return jsonResponse({ ok: false, error: `HTTP ${res.status}: ${await res.text()}` }, 502);
  const channels = (await res.json()) as DiscordChannel[];
  return jsonResponse({ ok: true, channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type, parent_id: c.parent_id })) });
}

async function handleListCategories(env: Env): Promise<Response> {
  const res = await discordFetch(env, `/guilds/${env.guildId}/channels`);
  if (!res.ok) return jsonResponse({ ok: false, error: `Discord devolvió HTTP ${res.status} al listar canales: ${await res.text()}` }, 502);
  const channels = (await res.json()) as DiscordChannel[];
  const categories = channels
    .filter((c) => c.type === 4)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({ id: c.id, name: c.name }));
  return jsonResponse({ ok: true, categories });
}

async function handleListRoles(env: Env): Promise<Response> {
  const res = await discordFetch(env, `/guilds/${env.guildId}/roles`);
  if (!res.ok) return jsonResponse({ ok: false, error: `Discord devolvió HTTP ${res.status} al listar roles: ${await res.text()}` }, 502);
  const roles = (await res.json()) as DiscordRole[];
  const selectable = roles
    .filter((r) => r.id !== env.guildId && !r.managed) // @everyone (id==guildId) y roles de integraciones/bots fuera
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));
  return jsonResponse({ ok: true, roles: selectable });
}

// deno-lint-ignore no-explicit-any
async function handleSaveConfig(env: Env, supabase: any, params: { categoryId?: string; officersRoleId?: string }): Promise<Response> {
  const { categoryId, officersRoleId } = params;
  if (!categoryId) return jsonResponse({ ok: false, error: 'categoryId es obligatorio' }, 400);
  if (!officersRoleId) return jsonResponse({ ok: false, error: 'officersRoleId es obligatorio' }, 400);

  // Misma defensa que send-discord-message: la categoría tiene que ser DE
  // VERDAD del guild autorizado, no un ID cualquiera colado a mano.
  const catRes = await discordFetch(env, `/channels/${categoryId}`);
  if (!catRes.ok) return jsonResponse({ ok: false, error: `No se pudo verificar la categoría en Discord (HTTP ${catRes.status})` }, 400);
  const category = (await catRes.json()) as DiscordChannel;
  if (category.guild_id !== env.guildId || category.type !== 4) {
    return jsonResponse({ ok: false, error: 'Ese ID no es una categoría de este servidor de Discord.' }, 400);
  }

  const rolesRes = await discordFetch(env, `/guilds/${env.guildId}/roles`);
  if (!rolesRes.ok) return jsonResponse({ ok: false, error: `No se pudo verificar el rol en Discord (HTTP ${rolesRes.status})` }, 400);
  const roles = (await rolesRes.json()) as DiscordRole[];
  if (!roles.some((r) => r.id === officersRoleId)) {
    return jsonResponse({ ok: false, error: 'Ese ID no es un rol de este servidor de Discord.' }, 400);
  }

  const { error } = await supabase
    .from('discord_roster_channels_settings')
    .upsert({ id: true, category_id: categoryId, officers_role_id: officersRoleId, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
  return jsonResponse({ ok: true });
}

// deno-lint-ignore no-explicit-any
async function handleSaveLink(env: Env, supabase: any, params: { characterId?: number; characterName?: string; discordUserId?: string }): Promise<Response> {
  const { characterId, characterName, discordUserId } = params;
  if (characterId == null) return jsonResponse({ ok: false, error: 'characterId es obligatorio' }, 400);
  if (!characterName?.trim()) return jsonResponse({ ok: false, error: 'characterName es obligatorio' }, 400);
  if (!discordUserId || !/^\d{15,25}$/.test(discordUserId)) return jsonResponse({ ok: false, error: 'discordUserId no parece un ID de Discord válido (el número largo, no el @usuario).' }, 400);

  const member = await fetchGuildMember(env, discordUserId);
  if (member === 'not-a-member') return jsonResponse({ ok: false, error: 'Ese usuario no está en el servidor de Discord (o el ID está mal copiado).' }, 400);
  if (member === 'error') return jsonResponse({ ok: false, error: 'No se pudo comprobar ese usuario en Discord ahora mismo — inténtalo de nuevo.' }, 502);

  const { data: settings } = await supabase.from('discord_roster_channels_settings').select('officers_role_id').eq('id', true).maybeSingle();
  const officersRoleId = settings?.officers_role_id as string | null | undefined;
  const isOfficer = !!officersRoleId && member.roles.includes(officersRoleId);
  const displayName = displayNameOf(member);

  // §"si el jugador juega con un alter, cómo podemos vincular todo al mismo
  // canal o main?" (feedback real, 2026-08-28): NO hay una tabla separada de
  // "personas" — dos character_id distintos vinculados al MISMO
  // discord_user_id ES la señal de "son la misma persona" (WoWAudit no la da
  // de ninguna otra forma, comprobado empíricamente). handleSync agrupa por
  // discord_user_id y solo uno de los personajes del grupo llega a tener
  // canal real — aquí solo se avisa de con quién va a compartirlo.
  const { data: siblings } = await supabase.from('discord_roster_channels').select('character_name').eq('discord_user_id', discordUserId).neq('character_id', characterId);
  const sharedWith = ((siblings ?? []) as { character_name: string }[]).map((s) => s.character_name);

  const { error } = await supabase.from('discord_roster_channels').upsert(
    {
      character_id: characterId,
      character_name: characterName,
      discord_user_id: discordUserId,
      discord_display_name: displayName,
      is_officer: isOfficer,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'character_id' },
  );
  if (error) throw error;
  return jsonResponse({ ok: true, displayName, isOfficer, sharedWith });
}

// deno-lint-ignore no-explicit-any
async function handleRemoveLink(env: Env, supabase: any, params: { characterId?: number }): Promise<Response> {
  const { characterId } = params;
  if (characterId == null) return jsonResponse({ ok: false, error: 'characterId es obligatorio' }, 400);

  const { data: link, error: linkError } = await supabase.from('discord_roster_channels').select('discord_channel_id').eq('character_id', characterId).maybeSingle();
  if (linkError) throw linkError;

  if (link?.discord_channel_id) {
    const delRes = await discordFetch(env, `/channels/${link.discord_channel_id}`, { method: 'DELETE' });
    if (!delRes.ok && delRes.status !== 404) {
      return jsonResponse({ ok: false, error: `No se pudo borrar el canal de Discord (HTTP ${delRes.status}): ${await delRes.text()}` }, 502);
    }
  }

  const { error } = await supabase.from('discord_roster_channels').delete().eq('character_id', characterId);
  if (error) throw error;
  return jsonResponse({ ok: true });
}

// §"junto a la creación de ese canal IRIS mande un mensaje..." (feedback
// real, 2026-08-28): validado con el usuario turno a turno antes de tocar
// código (contenido exacto + placeholders) — solo se manda al CREAR un
// canal de verdad, nunca en un PATCH de uno ya existente (needsCreate=false
// no pasa por aquí), para no reenviarlo en cada "Sincronizar".
function welcomeMessageFor(characterName: string, discordUserId: string): string {
  return [
    `👋 <@${discordUserId}> — te damos la bienvenida a tu canal de coaching, **${characterName}**.`,
    '',
    'Este espacio es para hacer seguimiento cercano de tu progresión como raider:',
    '',
    '🧩 **Mejora de personaje** — talentos, gear, consumibles',
    '🛡️ **Uso de defensivos**',
    '🎯 **Ejecución de mecánicas**',
    '',
    'Para mantener el estatus de raider y aspirar al **CE**, el estudio y análisis constante de mecánicas y rotación no es un extra — es parte del oficio.',
    '',
    '🔒 Aquí solo estáis tú y los oficiales. Es un espacio privado para la mejora constante: cualquier cosa concreta sobre tu juego la hablaremos por aquí, para que todos estemos al tanto sin mezclarlo con el canal general.',
    '',
    '¡Vamos a por ello! 💪',
  ].join('\n');
}

// Best-effort a propósito: el canal YA existe en Discord y YA se guardó en
// BD en cuanto esta función se llama — que falle el mensaje de bienvenida
// (network, rate limit puntual…) no debe tumbar el resto del sync ni dejar
// el canal a medio crear. El fallo se reporta igual (ver skippedNoDiscordMember
// en la llamada) para que no se pierda en silencio.
async function sendWelcomeMessage(env: Env, channelId: string, characterName: string, discordUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await discordFetch(env, `/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: welcomeMessageFor(characterName, discordUserId) }),
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return { ok: true };
}

function permissionOverwrites(env: Env, officersRoleId: string, discordUserId: string) {
  return [
    { id: env.guildId, type: 0, deny: PERM_VIEW_CHANNEL.toString() }, // @everyone
    { id: officersRoleId, type: 0, allow: PERM_VIEW_CHANNEL.toString() },
    { id: discordUserId, type: 1, allow: PLAYER_ALLOW.toString() },
  ];
}

// deno-lint-ignore no-explicit-any
async function handleSync(env: Env, supabase: any): Promise<Response> {
  const { data: settings, error: settingsError } = await supabase.from('discord_roster_channels_settings').select('category_id, officers_role_id').eq('id', true).maybeSingle();
  if (settingsError) throw settingsError;
  const { category_id: categoryId, officers_role_id: officersRoleId } = (settings ?? {}) as SettingsRow;
  if (!categoryId || !officersRoleId) {
    return jsonResponse({ ok: false, error: 'Configura primero la categoría y el rol de Oficiales.' }, 400);
  }

  // Misma defensa que en save-config/send-discord-message: no fiarse de un
  // ID guardado hace tiempo, comprobar que la categoría sigue siendo del guild.
  const catRes = await discordFetch(env, `/channels/${categoryId}`);
  if (!catRes.ok || (await catRes.clone().json().catch(() => null))?.guild_id !== env.guildId) {
    return jsonResponse({ ok: false, error: 'La categoría configurada ya no pertenece a este servidor de Discord — revísala en Ajustes → Discord.' }, 400);
  }

  const [{ data: roster, error: rosterError }, { data: links, error: linksError }] = await Promise.all([
    supabase.from('wowaudit_roster').select('character_id, name, rank'),
    supabase.from('discord_roster_channels').select('*'),
  ]);
  if (rosterError) throw rosterError;
  if (linksError) throw linksError;

  const rosterByCharacterId = new Map(((roster ?? []) as RosterRow[]).map((r) => [r.character_id, r]));
  const linkRows = (links ?? []) as LinkRow[];

  // §"si el jugador juega con un alter, cómo podemos vincular todo al mismo
  // canal o main?" (feedback real, 2026-08-28): dos character_id vinculados
  // al MISMO discord_user_id = la misma persona (única señal que tenemos,
  // ver comentario en handleSaveLink) — se agrupa por discord_user_id ANTES
  // de decidir nada, para que main+alt(s) compartan un solo canal real en
  // vez de crear uno por personaje.
  const groups = new Map<string, LinkRow[]>();
  for (const link of linkRows) {
    const group = groups.get(link.discord_user_id);
    if (group) group.push(link);
    else groups.set(link.discord_user_id, [link]);
  }

  // Refresca is_officer/nombre visible desde Discord ANTES de decidir nada —
  // así "ni oficial" siempre se evalúa contra el rol real de AHORA, no
  // contra lo que se guardó la última vez que se vinculó a mano. Una
  // llamada por discord_user_id ÚNICO (no por fila) — main+alt del mismo
  // usuario ya no duplican la misma consulta a Discord.
  // §"le doy a sincronizar y ha dado error... los ids los he cogido del
  // servidor así que ese error es falso" (feedback real, 2026-08-28): con
  // BATCH=5 sin pausa, la 1ª tanda pasaba y TODAS las siguientes chocaban
  // con el rate limit de Discord para esta ruta — bajado a 3 con una pausa
  // entre tandas (además del retry con backoff dentro de fetchGuildMember).
  const BATCH = 3;
  const uniqueUserIds = [...groups.keys()];
  const memberByUserId = new Map<string, DiscordGuildMember | 'not-a-member' | 'unknown'>();
  for (let i = 0; i < uniqueUserIds.length; i += BATCH) {
    const batch = uniqueUserIds.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((id) => fetchGuildMember(env, id)));
    batch.forEach((id, idx) => memberByUserId.set(id, results[idx]));
    if (i + BATCH < uniqueUserIds.length) await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const skippedNoDiscordMember: string[] = [];
  const upserts: Record<string, unknown>[] = [];
  const deletes: number[] = [];

  for (const [discordUserId, group] of groups) {
    const memberResult = memberByUserId.get(discordUserId)!;

    // §"le doy a sincronizar y ha dado error... los ids los he cogido del
    // servidor así que ese error es falso" (feedback real, 2026-08-28): un
    // 'unknown' (rate limit tras 3 reintentos, 500, red) NO es "ya no está
    // en el servidor" — es "no lo sé todavía". Actuar como si no fuera
    // elegible podría BORRAR el canal de alguien que sigue perfectamente en
    // el servidor solo porque Discord tardó en responder. Se salta el grupo
    // entero sin crear/actualizar/borrar nada — se reintenta en el próximo
    // "Sincronizar".
    if (memberResult === 'unknown') {
      for (const link of group) {
        const name = rosterByCharacterId.get(link.character_id)?.name ?? link.character_name;
        skippedNoDiscordMember.push(`${name} (no se pudo comprobar en Discord ahora mismo — reintenta sincronizar)`);
      }
      continue;
    }

    const confirmedNotMember = memberResult === 'not-a-member';
    const isOfficer = !confirmedNotMember && memberResult.roles.includes(officersRoleId);
    const displayName = confirmedNotMember ? (group.find((l) => l.discord_display_name)?.discord_display_name ?? null) : displayNameOf(memberResult);

    // §"quiero quitar que no se creen canales para los oficiales, tambien se
    // tienen que crear y tiene que permitirse enviar su infografia" (feedback
    // real, 2026-08-29): elegible si CUALQUIER personaje del grupo es Main de
    // verdad ahora mismo en WoWAudit — un main Trial temporalmente pero con
    // un alt Main sigue contando (es la misma persona raideando, solo que hoy
    // le tocó el alt). Ya NO excluye oficiales — is_officer se sigue
    // calculando y guardando (se usa como badge informativo en Ajustes →
    // Discord), pero deja de ser un motivo para no tener canal.
    const eligibleMembers = group.filter((l) => rosterByCharacterId.get(l.character_id)?.rank === 'Main');
    const groupEligible = eligibleMembers.length > 0 && !confirmedNotMember;

    // El canal es UNO por grupo — se elige un personaje "dueño": el que ya
    // tuviera canal (estabilidad — no lo mueve de sitio en cada sync), si no
    // el primer Main elegible, si no el vinculado más antiguo. Los demás del
    // grupo nunca tienen discord_channel_id propio en BD.
    const primary =
      group.find((l) => l.discord_channel_id) ??
      [...eligibleMembers].sort((a, b) => a.linked_at.localeCompare(b.linked_at))[0] ??
      [...group].sort((a, b) => a.linked_at.localeCompare(b.linked_at))[0];

    for (const link of group) {
      const rosterEntry = rosterByCharacterId.get(link.character_id);
      const inRoster = !!rosterEntry;
      const currentName = rosterEntry?.name ?? link.character_name;

      if (!inRoster && !(groupEligible && link.character_id === primary.character_id)) {
        // Dejó de estar en wowaudit_roster (salió de la guild) — nada que conservar de este personaje.
        if (link.discord_channel_id) {
          const delRes = await discordFetch(env, `/channels/${link.discord_channel_id}`, { method: 'DELETE' });
          if (delRes.ok || delRes.status === 404) deleted.push(currentName);
          else skippedNoDiscordMember.push(`${currentName} (fallo al borrar canal: HTTP ${delRes.status})`);
        }
        deletes.push(link.character_id);
        continue;
      }

      if (groupEligible && link.character_id === primary.character_id) {
        const ownerName = rosterByCharacterId.get(primary.character_id)?.name ?? primary.character_name;
        const overwrites = permissionOverwrites(env, officersRoleId, discordUserId);
        const name = channelNameFor(ownerName);
        // §"el canal de nanis lo he borrado a mano" (feedback real,
        // 2026-08-28): si el discord_channel_id guardado ya no existe de
        // verdad en Discord (lo borraron a mano, sin pasar por
        // "Desvincular"), el PATCH de abajo devuelve 404 — antes eso se
        // quedaba marcado como fallo para siempre (la fila nunca vuelve a
        // intentar CREAR, solo reintenta el mismo PATCH roto en cada sync).
        // needsCreate cubre los dos casos con el mismo código: "nunca tuvo
        // canal" y "tenía uno pero ya no existe".
        let needsCreate = !link.discord_channel_id;
        if (link.discord_channel_id) {
          // PATCH incondicional: auto-repara nombre/categoría/permisos aunque
          // alguien los haya tocado a mano en Discord desde la última vez.
          const patchRes = await discordFetch(env, `/channels/${link.discord_channel_id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name, parent_id: categoryId, permission_overwrites: overwrites }),
          });
          if (patchRes.ok) {
            updated.push(ownerName);
          } else if (patchRes.status === 404) {
            needsCreate = true; // el canal ya no existe de verdad — se recrea abajo en vez de quedar atascado
          } else {
            skippedNoDiscordMember.push(`${ownerName} (fallo al actualizar canal: HTTP ${patchRes.status})`);
            upserts.push({
              character_id: link.character_id,
              character_name: currentName,
              discord_user_id: discordUserId,
              discord_display_name: displayName,
              discord_channel_id: link.discord_channel_id,
              is_officer: isOfficer,
              channel_synced_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            continue;
          }
        }
        if (needsCreate) {
          const createRes = await discordFetch(env, `/guilds/${env.guildId}/channels`, {
            method: 'POST',
            body: JSON.stringify({ name, type: 0, parent_id: categoryId, permission_overwrites: overwrites }),
          });
          if (!createRes.ok) {
            skippedNoDiscordMember.push(`${ownerName} (fallo al crear canal: HTTP ${createRes.status})`);
            continue;
          }
          const createdChannel = (await createRes.json()) as DiscordChannel;
          created.push(ownerName);
          const welcome = await sendWelcomeMessage(env, createdChannel.id, ownerName, discordUserId);
          if (!welcome.ok) skippedNoDiscordMember.push(`${ownerName} (canal creado, pero falló el mensaje de bienvenida: ${welcome.error})`);
          upserts.push({
            character_id: link.character_id,
            character_name: currentName,
            discord_user_id: discordUserId,
            discord_display_name: displayName,
            discord_channel_id: createdChannel.id,
            is_officer: isOfficer,
            channel_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        } else {
          upserts.push({
            character_id: link.character_id,
            character_name: currentName,
            discord_user_id: discordUserId,
            discord_display_name: displayName,
            discord_channel_id: link.discord_channel_id,
            is_officer: isOfficer,
            channel_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
        continue;
      }

      // Resto de filas del grupo: nunca dueñas de un canal propio (o el
      // grupo entero no es elegible ahora mismo, o esta fila concreta no es
      // la "dueña" del canal compartido) — se conserva la vinculación, sin
      // canal propio, salvo que ella misma tuviera uno huérfano que borrar
      // (p. ej. dejó de ser la dueña porque otro personaje del grupo pasó a
      // serlo — no debería poder pasar dado el criterio de estabilidad de
      // arriba, pero se cubre por si acaso en vez de dejar un canal fantasma).
      if (link.discord_channel_id) {
        const delRes = await discordFetch(env, `/channels/${link.discord_channel_id}`, { method: 'DELETE' });
        if (delRes.ok || delRes.status === 404) deleted.push(currentName);
        else skippedNoDiscordMember.push(`${currentName} (fallo al borrar canal huérfano: HTTP ${delRes.status})`);
      }
      if (confirmedNotMember) skippedNoDiscordMember.push(`${currentName} (ya no está en el servidor de Discord)`);
      upserts.push({
        character_id: link.character_id,
        character_name: currentName,
        discord_user_id: discordUserId,
        discord_display_name: displayName,
        discord_channel_id: null,
        is_officer: isOfficer,
        channel_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (upserts.length) {
    const { error } = await supabase.from('discord_roster_channels').upsert(upserts, { onConflict: 'character_id' });
    if (error) throw error;
  }
  if (deletes.length) {
    const { error } = await supabase.from('discord_roster_channels').delete().in('character_id', deletes);
    if (error) throw error;
  }

  // Raiders (rank=Main) que todavía no tienen ninguna vinculación — no se
  // puede crear canal sin un Discord User ID, así que se informa para que se
  // vinculen a mano (ver action=save-link).
  const linkedIds = new Set(linkRows.map((l) => l.character_id));
  const unlinked = ((roster ?? []) as RosterRow[]).filter((r) => r.rank === 'Main' && !linkedIds.has(r.character_id)).map((r) => r.name);

  return jsonResponse({ ok: true, created, updated, deleted, unlinked, skippedNoDiscordMember });
}
