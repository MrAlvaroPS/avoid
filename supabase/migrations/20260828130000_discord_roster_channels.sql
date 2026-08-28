-- §"un bot que crea canales privados dentro de una categoría... solo para
-- rango Raider, ni trial ni oficial" (feedback real, 2026-08-28): la fuente
-- de verdad del roster ya existe (wowaudit_roster), pero WoWAudit no expone
-- ningún Discord ID (comprobado empíricamente contra la API real, con la key
-- normal Y con la de "management" — /v1/characters, /v1/attendance, /v1/team
-- y /v1/period son los únicos endpoints reales; /v1/members y variantes
-- devuelven la SPA de wowaudit, no JSON — no existen). La vinculación
-- personaje↔Discord se hace a mano en el nuevo submenú Ajustes → Discord.
--
-- Dos tablas separadas a propósito:
--   - discord_roster_channels_settings: config (categoría destino, rol de
--     Oficiales) — singleton, mismo patrón que wowaudit_season (id boolean
--     con check, siempre una sola fila).
--   - discord_roster_channels: la vinculación persona↔canal en sí. NO lleva
--     FK a wowaudit_roster(character_id) a propósito — cuando alguien deja
--     de aparecer en wowaudit_roster, la reconciliación (Edge Function
--     discord-roster-channels, action=sync) tiene que borrar el canal REAL
--     de Discord primero y la fila después; un `on delete cascade` borraría
--     la fila sola y dejaría el canal huérfano en Discord para siempre.
create table if not exists discord_roster_channels_settings (
  id boolean primary key default true check (id),
  category_id text,
  officers_role_id text,
  updated_at timestamptz not null default now()
);
insert into discord_roster_channels_settings (id) values (true) on conflict (id) do nothing;

create table if not exists discord_roster_channels (
  character_id bigint primary key, -- id de wowaudit (wowaudit_roster.character_id), sin FK — ver comentario de arriba
  character_name text not null, -- snapshot del nombre en el momento de vincular/sincronizar, para el nombre del canal
  discord_user_id text not null,
  discord_display_name text, -- snapshot informativo (nick/username), se refresca en cada sync
  discord_channel_id text, -- null = todavía no elegible (Trial/oficial) o pendiente de la próxima sync
  is_officer boolean not null default false, -- reflejo del rol de Oficiales de Discord en el último sync — misma fuente que decide la visibilidad del canal
  linked_at timestamptz not null default now(),
  channel_synced_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists discord_roster_channels_channel_idx on discord_roster_channels (discord_channel_id);

alter table discord_roster_channels_settings enable row level security;
create policy "discord_roster_channels_settings is publicly readable"
  on discord_roster_channels_settings for select
  using (true);

alter table discord_roster_channels enable row level security;
create policy "discord_roster_channels is publicly readable"
  on discord_roster_channels for select
  using (true);
