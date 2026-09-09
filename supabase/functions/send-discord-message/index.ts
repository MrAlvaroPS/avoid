import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sendDiscordParts } from '../_shared/discord-multipart-send.ts';

// §"dejar preparada una capa para interactuar en discord para enviar la
// infografía directamente a discord" (feedback real, 2026-08-27). DISCORD_APP_ID/
// DISCORD_API_KEY/DISCORD_GUILD_ID vienen de .env.local -> Supabase secrets
// (mismo mecanismo que WCL_CLIENT_ID/BLIZZARD_CLIENT_ID). Deliberadamente
// una llamada REST directa a la API de Discord (POST /channels/{id}/messages
// con el bot token), NO un bot con conexión de gateway persistente
// (discord.js con login()) -- esto vive en una Edge Function sin estado,
// que arranca por request y muere al responder; un bot con gateway necesita
// un proceso siempre encendido en otro sitio, fuera del alcance de "dejar
// preparada una capa" ahora mismo.
//
// §"aunque el bot no sea público, pondría una comprobación de guildId... para
// que sea un bot privado" (recomendación real del usuario, adaptada): la
// snippet original comprobaba interaction.guildId porque asumía un bot de
// slash-commands recibiendo interactions — aquí no hay ninguna interaction,
// es la app empujando un mensaje. El equivalente real de "privado" en esta
// dirección es: antes de publicar nada, confirmar que el canal de destino
// pertenece de verdad al ÚNICO guild autorizado (DISCORD_GUILD_ID), no a
// uno cualquiera que alguien haya podido colar como channelId — así esta
// función nunca puede usarse para publicar fuera del guild de Avoid.
const DISCORD_API = 'https://discord.com/api/v10';

// §"Si Discord tuviese cupo o limites, hará alguna clase de waiting para
// terminar de enviarlo" (feedback real, 2026-08-29, para el envío masivo de
// infografías a todo el roster): mismo patrón de reintento con backoff ya
// probado en discord-roster-channels/index.ts (fetchGuildMember) contra un
// 429 real de este mismo bot — se envuelve aquí también porque un envío en
// bucle de ~24 mensajes (uno por raider) es justo el caso que puede
// toparse con el rate limit por-ruta de Discord, cosa que un envío suelto
// desde el visor de un jugador casi nunca alcanza.
async function discordFetchWithRetry(url: string, init: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 4) {
    const body = (await res.clone().json().catch(() => null)) as { retry_after?: number } | null;
    const waitMs = Math.ceil((body?.retry_after ?? 1) * 1000) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return discordFetchWithRetry(url, init, attempt + 1);
  }
  return res;
}

interface Body {
  /** Legacy callers keep passing a channel directly. New player-audit callers use rosterCharacterId instead. */
  channelId?: string;
  rosterCharacterId?: number;
  /** Raider identity shown by the dossier; bound sends must match the stored roster link. */
  playerName?: string;
  content?: string;
  /** Ordered, already-semantic chunks for the player audit. Every part must fit Discord independently. */
  parts?: string[];
  /** Resume index after a partial Discord failure; indexes the original parts array. */
  startPartIndex?: number;
  /** Imagen en base64 SIN el prefijo "data:image/...;base64,". */
  imageBase64?: string;
  imageFilename?: string;
}

function adminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  const isBoundPlayerSend = body.rosterCharacterId != null;
  if (isBoundPlayerSend && body.channelId) return jsonResponse({ ok: false, error: 'No combines rosterCharacterId con channelId.' }, 400);
  if (!isBoundPlayerSend && !body.channelId) return jsonResponse({ ok: false, error: 'channelId es obligatorio' }, 400);
  if (body.parts && (!Array.isArray(body.parts) || !body.parts.length)) return jsonResponse({ ok: false, error: 'parts debe contener al menos un mensaje.' }, 400);
  if (body.parts?.some((part) => typeof part !== 'string' || !part.trim() || part.length > 2000)) {
    return jsonResponse({ ok: false, error: 'Cada parte de Discord debe contener texto y medir como máximo 2000 caracteres.' }, 400);
  }
  if (!body.parts && !body.content?.trim() && !body.imageBase64) return jsonResponse({ ok: false, error: 'Hace falta content, parts o imageBase64' }, 400);
  if (body.parts && (body.content || body.imageBase64)) return jsonResponse({ ok: false, error: 'parts no se puede combinar con content o imagen.' }, 400);
  const startPartIndex = body.startPartIndex ?? 0;
  if (!Number.isInteger(startPartIndex) || startPartIndex < 0 || (body.parts && startPartIndex >= body.parts.length)) {
    return jsonResponse({ ok: false, error: 'startPartIndex inválido.' }, 400);
  }

  const botToken = Deno.env.get('DISCORD_BOT_TOKEN');
  const allowedGuildId = Deno.env.get('DISCORD_GUILD_ID');
  if (!botToken) return jsonResponse({ ok: false, error: 'Falta DISCORD_BOT_TOKEN en los secrets del proyecto Supabase.' }, 500);
  if (!allowedGuildId) return jsonResponse({ ok: false, error: 'Falta DISCORD_GUILD_ID en los secrets del proyecto Supabase.' }, 500);

  try {
    let channelId = body.channelId ?? null;
    if (isBoundPlayerSend) {
      if (!Number.isInteger(body.rosterCharacterId) || Number(body.rosterCharacterId) <= 0) {
        return jsonResponse({ ok: false, error: 'rosterCharacterId inválido.' }, 400);
      }
      const requestedPlayerName = body.playerName?.trim() ?? '';
      if (!requestedPlayerName || requestedPlayerName.length > 80) {
        return jsonResponse({ ok: false, error: 'playerName es obligatorio para un envío vinculado.' }, 400);
      }
      const { data: binding, error: bindingError } = await adminClient()
        .from('discord_roster_channels')
        .select('character_name,discord_channel_id')
        .eq('character_id', body.rosterCharacterId)
        .maybeSingle();
      if (bindingError) return jsonResponse({ ok: false, error: `No se pudo resolver el canal vinculado: ${errorMessage(bindingError)}` }, 500);
      if (binding?.character_name?.trim().toLocaleLowerCase('en-US') !== requestedPlayerName.toLocaleLowerCase('en-US')) {
        return jsonResponse({ ok: false, error: 'El personaje solicitado no coincide con la vinculación de Discord.' }, 409);
      }
      channelId = binding?.discord_channel_id ?? null;
      if (!channelId) return jsonResponse({ ok: false, error: 'Este raider no tiene canal privado de Discord vinculado.' }, 409);
    }

    const channelRes = await discordFetchWithRetry(`${DISCORD_API}/channels/${channelId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!channelRes.ok) {
      return jsonResponse({ ok: false, error: `No se pudo verificar el canal de Discord (HTTP ${channelRes.status}): ${await channelRes.text()}` }, 502);
    }
    const channel = (await channelRes.json()) as { guild_id?: string; name?: string };
    if (channel.guild_id !== allowedGuildId) {
      // No se revela nada del canal ajeno en el mensaje de error — "privado" también hacia fuera.
      return jsonResponse({ ok: false, error: 'Este canal no pertenece al guild autorizado para este bot — envío bloqueado.' }, 403);
    }

    if (body.parts) {
      const result = await sendDiscordParts(body.parts, startPartIndex, async (content) => {
        const response = await discordFetchWithRetry(`${DISCORD_API}/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
          });
        if (!response.ok) throw new Error(`Discord devolvió HTTP ${response.status}: ${await response.text()}`);
        return ((await response.json()) as { id: string }).id;
      });
      return jsonResponse({
        ...result,
        channelName: channel.name ?? null,
      });
    }

    let sendRes: Response;
    if (body.imageBase64) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content: body.content ?? '', allowed_mentions: { parse: [] } }));
      const bytes = Uint8Array.from(atob(body.imageBase64), (c) => c.charCodeAt(0));
      // §"Discord devolvió HTTP 413" (feedback real, 2026-08-27): esto
      // estaba hardcodeado a image/png sin mirar el nombre real, así que un
      // .jpg se habría subido con Content-Type mentiroso (Discord decide
      // bastante por el nombre, pero el Content-Type de la parte multipart
      // también cuenta para cómo lo procesa/previsualiza). El componente
      // manda PNG o JPG según cuál cupiera sin recomprimir de más (ver
      // renderDiscordImage en night-player-infographic.component.ts) — nunca
      // los dos a la vez.
      const filename = body.imageFilename ?? 'infografia.png';
      const mimeType = /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'image/png';
      form.append('files[0]', new Blob([bytes], { type: mimeType }), filename);
      sendRes = await discordFetchWithRetry(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}` },
        body: form,
      });
    } else {
      sendRes = await discordFetchWithRetry(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body.content, allowed_mentions: { parse: [] } }),
      });
    }
    if (!sendRes.ok) {
      return jsonResponse({ ok: false, error: `Discord devolvió HTTP ${sendRes.status}: ${await sendRes.text()}` }, 502);
    }
    const sent = (await sendRes.json()) as { id: string };
    return jsonResponse({ ok: true, messageId: sent.id, messageIds: [sent.id], parts: 1, sentParts: 1, failedPartIndex: null, channelName: channel.name ?? null });
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
