-- §9.1 de la hoja de ruta (auditoría v2): "los bosses solo se cargan si hay
-- un pull propio". report_encounters representa PULLS REALES (report_code +
-- fight_id no admiten null) — no es un catálogo, así que sembrar ahí un
-- boss nunca pulleado sería fabricar un pull que no existió. Catálogo aparte.
--
-- OJO con los IDs (verificado en real, 2026-08-22): Blizzard Journal y WCL
-- NO comparten espacio de IDs para el mismo boss (Nek'zali es
-- journal-encounter 2888 en Blizzard, encounter 3470 en WCL). Todo lo demás
-- del esquema (report_encounters.encounter_id, boss_mechanics_candidates.boss_id,
-- pulls.boss_id) ya usa el ID de WCL — encounter_id aquí es ESE, no el de
-- Blizzard, para que un boss ya sembrado y luego realmente pulleado sea la
-- MISMA fila, no dos identidades distintas sin cruzar.
create table if not exists known_raid_bosses (
  encounter_id bigint primary key, -- WCL worldData.zone(id).encounters[].id
  boss_name text not null,
  zone_id bigint not null, -- WCL zone id (= reports.zone_id)
  zone_name text not null,
  journal_encounter_id bigint, -- Blizzard, solo para cruzar con boss_mechanics_candidates.journal_encounter_id — puede quedar null si el nombre no casó
  order_index integer, -- orden real dentro de la instancia, tal como lo da Blizzard
  synced_at timestamptz not null default now()
);

alter table known_raid_bosses enable row level security;
create policy "read all - known_raid_bosses" on known_raid_bosses for select using (true);

alter publication supabase_realtime add table known_raid_bosses;
