import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';

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

interface Body {
  channelId: string;
  content?: string;
  /** PNG en base64 SIN el prefijo "data:image/png;base64,". */
  imageBase64?: string;
  imageFilename?: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.channelId) return jsonResponse({ ok: false, error: 'channelId es obligatorio' }, 400);
  if (!body.content?.trim() && !body.imageBase64) return jsonResponse({ ok: false, error: 'Hace falta content o imageBase64' }, 400);

  const botToken = Deno.env.get('DISCORD_BOT_TOKEN');
  const allowedGuildId = Deno.env.get('DISCORD_GUILD_ID');
  if (!botToken) return jsonResponse({ ok: false, error: 'Falta DISCORD_BOT_TOKEN en los secrets del proyecto Supabase.' }, 500);
  if (!allowedGuildId) return jsonResponse({ ok: false, error: 'Falta DISCORD_GUILD_ID en los secrets del proyecto Supabase.' }, 500);

  try {
    const channelRes = await fetch(`${DISCORD_API}/channels/${body.channelId}`, {
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

    let sendRes: Response;
    if (body.imageBase64) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content: body.content ?? '' }));
      const bytes = Uint8Array.from(atob(body.imageBase64), (c) => c.charCodeAt(0));
      // §"Discord devolvió HTTP 413" (feedback real, 2026-08-27): el
      // cliente ahora manda JPEG (mucho más pequeño) para la infografía —
      // esto estaba hardcodeado a image/png sin mirar el nombre real,
      // así que un .jpg se habría subido con Content-Type mentiroso (Discord
      // decide bastante por el nombre, pero el Content-Type de la parte
      // multipart también cuenta para cómo lo procesa/previsualiza).
      const filename = body.imageFilename ?? 'infografia.png';
      const mimeType = /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'image/png';
      form.append('files[0]', new Blob([bytes], { type: mimeType }), filename);
      sendRes = await fetch(`${DISCORD_API}/channels/${body.channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}` },
        body: form,
      });
    } else {
      sendRes = await fetch(`${DISCORD_API}/channels/${body.channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body.content }),
      });
    }
    if (!sendRes.ok) {
      return jsonResponse({ ok: false, error: `Discord devolvió HTTP ${sendRes.status}: ${await sendRes.text()}` }, 502);
    }
    const sent = (await sendRes.json()) as { id: string };
    return jsonResponse({ ok: true, messageId: sent.id, channelName: channel.name ?? null });
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
