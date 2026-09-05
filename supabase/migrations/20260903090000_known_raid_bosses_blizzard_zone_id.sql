-- §"además del boss ID quiero mandar también el zoneID al que pertenece ese
-- boss... porque me suena que en alguna prueba que hice en el pasado si no se
-- ponía eso no salía" (feedback real, 2026-09-03): known_raid_bosses.zone_id
-- ya existe, pero es el ID de zona de Warcraft Logs (53 para The Venomous
-- Abyss) — un ID interno del API de WCL sin relación con lo que el cliente
-- de WoW/MRT/BigWigs conocen en juego. Blizzard usa un ID de instancia
-- completamente distinto (3004 para The Venomous Abyss, confirmado en juego
-- por el usuario) para lo que MRT llama zoneID en su reminder. Aditivo: no
-- toca zone_id ni ninguna columna existente.
alter table public.known_raid_bosses
  add column if not exists blizzard_zone_id bigint;

comment on column public.known_raid_bosses.blizzard_zone_id is
  'ID de instancia/zona de Blizzard (el que usan el cliente de WoW y addons como MRT/BigWigs), distinto de zone_id (ID de zona de la API de Warcraft Logs). Ver mrt-reminder-codec.ts.';

-- Primer valor conocido, confirmado en juego por el usuario (2026-09-03).
update public.known_raid_bosses
set blizzard_zone_id = 3004
where zone_name = 'The Venomous Abyss' and blizzard_zone_id is null;
