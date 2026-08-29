// §"solo puedan continuar el login los que tengan el rol de Oficial en mi
// servidor" (feedback real, 2026-08-29): se llama justo después de cada
// login de Discord (y, por prudencia, en cada arranque de sesión — ver
// auth.service.ts). Comprueba contra el bot de Discord si el usuario
// logeado tiene discord_roster_channels_settings.officers_role_id (MISMA
// fuente que el badge de oficial de Ajustes → Discord, no un rol nuevo) y
// cachea el resultado en user_profiles (ver migración
// 20260829090000_officer_auth.sql), que es lo que is_officer() usa en cada
// policy RLS y requireOfficer() en cada Edge Function.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireUser } from '../_shared/require-officer.ts';

const DISCORD_API = 'https://discord.com/api/v10';

interface DiscordGuildMember {
  user?: { id: string; username: string; global_name: string | null };
  nick: string | null;
  roles: string[];
}

// Mismo retry-con-backoff que discord-roster-channels/index.ts (fetchGuildMember) — sujeto al mismo rate limit real de Discord.
async function fetchGuildMember(botToken: string, guildId: string, discordUserId: string, attempt = 0): Promise<DiscordGuildMember | 'not-a-member' | 'unknown'> {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${discordUserId}`, { headers: { Authorization: `Bot ${botToken}` } });
  if (res.status === 404) return 'not-a-member';
  if (res.status === 429 && attempt < 3) {
    const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
    const waitMs = Math.ceil((body?.retry_after ?? 1) * 1000) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return fetchGuildMember(botToken, guildId, discordUserId, attempt + 1);
  }
  if (!res.ok) return 'unknown';
  return (await res.json()) as DiscordGuildMember;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  const guard = await requireUser(req);
  if (guard instanceof Response) return guard;

  const botToken = Deno.env.get('DISCORD_BOT_TOKEN');
  const guildId = Deno.env.get('DISCORD_GUILD_ID');
  if (!botToken) return jsonResponse({ ok: false, error: 'Falta DISCORD_BOT_TOKEN en los secrets del proyecto Supabase.' }, 500);
  if (!guildId) return jsonResponse({ ok: false, error: 'Falta DISCORD_GUILD_ID en los secrets del proyecto Supabase.' }, 500);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(guard.userId);
    if (userError || !userData.user) return jsonResponse({ ok: false, error: 'No se pudo leer el usuario autenticado.' }, 500);

    const discordIdentity = userData.user.identities?.find((i) => i.provider === 'discord');
    const discordUserId = (discordIdentity?.identity_data?.['provider_id'] ?? discordIdentity?.identity_data?.['sub']) as string | undefined;
    if (!discordUserId) return jsonResponse({ ok: false, error: 'Esta cuenta no tiene una identidad de Discord vinculada.' }, 400);

    const { data: settings, error: settingsError } = await admin.from('discord_roster_channels_settings').select('officers_role_id').eq('id', true).maybeSingle();
    if (settingsError) throw settingsError;
    const officersRoleId = settings?.officers_role_id as string | null | undefined;
    if (!officersRoleId) return jsonResponse({ ok: false, error: 'El rol de Oficiales no está configurado todavía (Ajustes → Discord).' }, 500);

    const member = await fetchGuildMember(botToken, guildId, discordUserId);
    if (member === 'unknown') return jsonResponse({ ok: false, error: 'No se pudo comprobar tu rol en Discord ahora mismo — inténtalo de nuevo.' }, 502);

    const isOfficer = member !== 'not-a-member' && member.roles.includes(officersRoleId);
    const username = member === 'not-a-member' ? (discordIdentity?.identity_data?.['full_name'] as string | undefined) ?? null : (member.nick ?? member.user?.global_name ?? member.user?.username ?? null);

    const { error: upsertError } = await admin
      .from('user_profiles')
      .upsert({ user_id: guard.userId, discord_user_id: discordUserId, discord_username: username, is_officer: isOfficer, checked_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (upsertError) throw upsertError;

    return jsonResponse({ ok: true, isOfficer, username });
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
