SET session_replication_role = replica;

--
-- PostgreSQL database dump
--

-- \restrict OABiey7lVWY4RpB4rZ4SCWY8C1FQir8pUNgyJo8xQMjM5VJcX6Mkgd187ecfESI

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: supabase_migrations; Owner: postgres
--

INSERT INTO "supabase_migrations"."schema_migrations" ("version", "statements", "name", "created_by", "idempotency_key", "rollback") VALUES
	('20260821120000', '{"-- Colocar en: supabase/migrations/20260821120000_initial_schema.sql
-- Esquema completo de la sección 7 de la hoja de ruta, con RLS.
-- Fase 1 solo usa raid_teams / encounters / raid_nights / pulls, pero se crea
-- todo de una vez para no tener que ir migrando por fases.

-- ============ NÚCLEO ============

create table raid_teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users not null,
  name text not null,
  created_at timestamptz default now()
)","create table raiders (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references raid_teams(id) not null,
  main_character_name text not null,
  realm text not null,
  class text not null,
  active_spec text,
  role text check (role in (''tank'',''healer'',''dps'')),
  created_at timestamptz default now()
)","create table encounters (
  id uuid primary key default gen_random_uuid(),
  wcl_encounter_id int unique,
  name text not null,
  raid_zone text not null,
  order_index int,
  is_final_boss boolean default false,
  created_at timestamptz default now()
)","-- ============ MANIFIESTO DE MECÁNICAS (tarea manual #1, fase 2) ============

create table encounter_mechanics (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid references encounters(id) not null,
  spell_id int not null,
  name text not null,
  mechanic_type text check (mechanic_type in
    (''avoidable_raid_damage'',''soak'',''tank_swap'',''interrupt'',''dispel'',
     ''stack_spread'',''add_priority'',''positioning'',''bloodlust_timing'',''other'')),
  expected_role text check (expected_role in (''tank'',''healer'',''dps'',''all'')),
  response_window_ms int,
  raid_wide_threshold numeric default 0.35,
  notes text,
  source text,
  manifest_version int default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)","create table cooldown_catalog (       -- auto-sincronizado desde el Docker de WoWAnalyzer, §12.1
  id uuid primary key default gen_random_uuid(),
  class text not null,
  spec text not null,
  spell_id int not null,
  name text not null,
  base_cooldown_ms int not null,
  category text check (category in (''personal_defensive'',''external_defensive'',''utility'',''offensive_cd'')),
  synced_from_commit text,
  synced_at timestamptz,
  unique (spec, spell_id)
)","-- ============ RAID NIGHTS Y PULLS (fase 1) ============

create table raid_nights (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references raid_teams(id) not null,
  date date not null,
  wcl_report_code text,
  status text check (status in (''live'',''closed'')) default ''live''
)","create table pulls (
  id uuid primary key default gen_random_uuid(),
  raid_night_id uuid references raid_nights(id) not null,
  encounter_id uuid references encounters(id) not null,
  pull_number int not null,
  difficulty text check (difficulty in (''normal'',''heroic'',''mythic'')),
  wcl_fight_id int,
  is_live boolean default false,
  is_kill boolean default false,
  pull_duration_ms int,
  boss_hp_pct_final numeric,
  started_at timestamptz,
  ended_at timestamptz,
  raw_source text check (raw_source in (''wcl_live_poll'',''wcl_historical_import'')),
  analysis_state text check (analysis_state in (''pending'',''computing'',''ready'',''stale'')) default ''pending'',
  analysis_manifest_version int,
  created_at timestamptz default now(),
  unique (raid_night_id, wcl_fight_id)   -- evita duplicados si se reimporta el mismo report
)","-- ============ RESULTADOS DEL ANÁLISIS (fases 2-4, se crean ya para no migrar de nuevo) ============

create table pull_mechanic_instances (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid references pulls(id) not null,
  mechanic_id uuid references encounter_mechanics(id) not null,
  trigger_time_ms int,
  boss_hp_pct_at_trigger numeric,
  outcome text check (outcome in (''clean'',''partial_fail'',''fail'')),
  players_hit uuid[],
  deaths_caused uuid[],
  detail jsonb,
  provenance jsonb
)","create table pull_deaths (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid references pulls(id) not null,
  raider_id uuid references raiders(id) not null,
  time_ms int,
  boss_hp_pct numeric,
  killing_ability_spell_id int,
  preceding_debuffs jsonb,
  defensive_available_unused int,
  avoidable boolean,
  provenance jsonb
)","create table pull_player_stats (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid references pulls(id) not null,
  raider_id uuid references raiders(id) not null,
  spec text,
  role text,
  dps numeric,
  hps numeric,
  damage_taken_avoidable numeric,
  interrupts_used int,
  interrupts_missed int,
  defensives_used jsonb,
  talent_build jsonb,
  equipped_items jsonb,
  provenance jsonb
)","create table pull_diffs (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid references pulls(id) not null,
  compared_against_pull_id uuid references pulls(id) not null,
  mechanic_regressions jsonb,
  mechanic_improvements jsonb,
  recurring_death_patterns jsonb,
  progress_delta_pct numeric,
  created_at timestamptz default now(),
  unique (pull_id, compared_against_pull_id)
)","create table baseline_pulls (
  encounter_id uuid references encounters(id),
  difficulty text,
  best_pull_id uuid references pulls(id),
  updated_at timestamptz default now(),
  primary key (encounter_id, difficulty)
)","create table pull_llm_analysis (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid unique references pulls(id) not null,
  summary_well text not null,
  summary_wrong text not null,
  top_priority_fix text not null,
  model_used text not null,
  tokens_used int,
  input_hash text not null,
  created_at timestamptz default now()
)","-- ============ RLS ============
-- Patrón: todo cuelga de raid_teams.owner_id = auth.uid(), vía el join que
-- corresponda en cada tabla. Las tablas de referencia global (encounters,
-- encounter_mechanics, cooldown_catalog) son de lectura abierta a cualquier
-- usuario autenticado; solo se escriben desde las Edge Functions con la
-- service role key, que ignora RLS por diseño.

alter table raid_teams enable row level security","create policy \"owner manages own teams\" on raid_teams
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())","alter table raiders enable row level security","create policy \"owner manages own raiders\" on raiders
  for all using (team_id in (select id from raid_teams where owner_id = auth.uid()))
  with check (team_id in (select id from raid_teams where owner_id = auth.uid()))","alter table encounters enable row level security","create policy \"authenticated can read encounters\" on encounters
  for select using (auth.role() = ''authenticated'')","alter table encounter_mechanics enable row level security","create policy \"authenticated can read mechanics\" on encounter_mechanics
  for select using (auth.role() = ''authenticated'')","alter table cooldown_catalog enable row level security","create policy \"authenticated can read cooldowns\" on cooldown_catalog
  for select using (auth.role() = ''authenticated'')","alter table raid_nights enable row level security","create policy \"owner manages own raid nights\" on raid_nights
  for all using (team_id in (select id from raid_teams where owner_id = auth.uid()))
  with check (team_id in (select id from raid_teams where owner_id = auth.uid()))","alter table pulls enable row level security","create policy \"owner manages own pulls\" on pulls
  for all using (raid_night_id in (
    select rn.id from raid_nights rn
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  )) with check (raid_night_id in (
    select rn.id from raid_nights rn
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ))","alter table pull_mechanic_instances enable row level security","create policy \"owner manages own mechanic instances\" on pull_mechanic_instances
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ))","alter table pull_deaths enable row level security","create policy \"owner manages own deaths\" on pull_deaths
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ))","alter table pull_player_stats enable row level security","create policy \"owner manages own player stats\" on pull_player_stats
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ))","alter table pull_diffs enable row level security","create policy \"owner manages own diffs\" on pull_diffs
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ))","alter table baseline_pulls enable row level security","create policy \"authenticated can read baselines\" on baseline_pulls
  for select using (auth.role() = ''authenticated'')","alter table pull_llm_analysis enable row level security","create policy \"owner manages own llm analysis\" on pull_llm_analysis
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ))"}', 'initial_schema', NULL, NULL, NULL),
	('20260822000000', '{"-- Fase A: sustituye el esquema multi-tenant con login (20260821120000) por el
-- esquema sin login / auto-discovery que fija supabase/schema.sql. Las tablas
-- de la migración anterior están confirmadas vacías (proyecto recién creado,
-- nunca se llegó a usar), así que se dropean sin migración de datos.
--
-- A partir de aquí, supabase/schema.sql es el espejo legible de este archivo:
-- si el esquema vuelve a cambiar, se edita aquí (migración nueva) y se
-- regenera schema.sql para que seguir describiendo el estado actual.

-- ============ DROP LIMPIO ============
-- Se dropea TODO lo que toca este archivo, tanto el esquema viejo (multi-
-- tenant con login) como cualquier resto de un `schema.sql` ya ejecutado a
-- mano contra este mismo proyecto (confirmado: las 20 tablas existentes
-- están vacías). Así la recreación de abajo no choca con policies/índices
-- que ya existieran de una pasada manual anterior.

drop table if exists pull_llm_analysis cascade","drop table if exists baseline_pulls cascade","drop table if exists pull_diffs cascade","drop table if exists pull_player_stats cascade","drop table if exists pull_deaths cascade","drop table if exists pull_mechanic_instances cascade","drop table if exists raid_nights cascade","drop table if exists cooldown_catalog cascade","drop table if exists encounter_mechanics cascade","drop table if exists encounters cascade","drop table if exists raiders cascade","drop table if exists raid_teams cascade","drop table if exists player_pull_records cascade","drop table if exists pull_briefs cascade","drop table if exists llm_calls cascade","drop table if exists session_state cascade","drop table if exists pulls cascade","drop table if exists report_encounters cascade","drop table if exists reports cascade","drop table if exists boss_mechanics_candidates cascade","drop table if exists boss_mechanics cascade","-- ============ ESQUEMA NUEVO (sin login, mecánicas auto-descubiertas) ============

create extension if not exists \"pgcrypto\"","create table if not exists boss_mechanics (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  contract jsonb not null, -- el BossMechanic[] curado a mano (ver conversación de diseño)
  updated_at timestamptz not null default now(),
  unique (boss_id, difficulty)
)","-- Candidatos auto-descubiertos (Blizzard Journal, cruzado con Wago DB2 para
-- saber qué mecánicas son de una dificultad concreta) para curar mecánicas con
-- CERO texto tecleado: boss_id es el encounterID de WCL, tal como sale del
-- desplegable alimentado por report_encounters (ver abajo).
-- sync-boss-mechanics SOLO escribe name/description/icon_url/sources/
-- observed_in_logs/journal_encounter_id/db2_difficulty_id/
-- difficulty_mapping_status/updated_at. category/avoidable/expected_response/
-- severity_threshold/reviewed los escribe ÚNICAMENTE save-mechanic-edit
-- (edición humana) y nunca se pisan en un resync.
create table if not exists boss_mechanics_candidates (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null, -- encounterID de WCL, como texto
  difficulty text not null, -- nombre WCL: LFR/Normal/Heroic/Mythic
  ability_id bigint not null,
  name text not null,
  description text,
  icon_url text,
  sources jsonb not null default ''[]''::jsonb, -- ej. [\"blizzard-journal\"]
  observed_in_logs boolean not null default false,
  journal_encounter_id bigint, -- id del encounter en el Journal de Blizzard, para trazabilidad
  db2_difficulty_id integer, -- id de la tabla Difficulty de Blizzard DB2 (¡no coincide con el id de WCL!) resuelto para esta fila
  difficulty_mapping_status text, -- ver difficulty-mapping.ts: ''mapped-by-*'' | ''difficulty-mapping-unresolved'' | ''difficulty-mapping-ambiguous'' | ''difficulty-metadata-unavailable''
  -- Campos editables a mano, persistentes entre resyncs:
  category text check (category in (''tankbuster'',''raid-damage'',''avoidable-ground'',''debuff-stack'',''interrupt'',''soak'',''spread'')),
  avoidable boolean,
  expected_response jsonb, -- { type, scope }
  severity_threshold numeric,
  reviewed boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (boss_id, difficulty, ability_id)
)","create index if not exists boss_mechanics_candidates_boss_idx on boss_mechanics_candidates (boss_id, difficulty)","-- Histórico persistente de reports de WCL de la guild, para no tener que
-- pegar la URL cada vez. Se rellena con sync-reports (botón manual).
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  zone_id integer,
  zone_name text,
  is_raid boolean not null default true,
  start_time bigint not null,
  end_time bigint,
  last_processed_fight_id integer,
  created_at timestamptz not null default now()
)","create index if not exists reports_start_time_idx on reports (start_time desc)","-- De dónde sale la lista de bosses sin teclear nada: cada fight de raid visto
-- en un report sincronizado (sync-reports) deja aquí su encounterID, nombre y
-- dificultad reales de WCL. El desplegable de \"Mecánicas del boss\" lee de esta
-- tabla; sync-boss-mechanics también la usa para el cruce de observed_in_logs.
-- Va DESPUÉS de `reports` en este archivo porque la referencia (report_code)
-- necesita que esa tabla ya exista.
create table if not exists report_encounters (
  id uuid primary key default gen_random_uuid(),
  report_code text not null references reports (code) on delete cascade,
  fight_id integer not null,
  encounter_id bigint not null,
  boss_name text not null,
  wcl_difficulty_id integer,
  kill boolean,
  start_time bigint not null,
  end_time bigint not null,
  unique (report_code, fight_id)
)","create index if not exists report_encounters_encounter_idx on report_encounters (encounter_id, wcl_difficulty_id, start_time desc)","create table if not exists pulls (
  id uuid primary key default gen_random_uuid(),
  report_code text not null,
  fight_id integer not null,
  boss_id text not null,
  difficulty text not null,
  pull_number integer not null,
  wipe_pct numeric,
  duration_ms integer,
  closed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (report_code, fight_id)
)","create index if not exists pulls_report_code_idx on pulls (report_code, pull_number desc)","-- Generada por analyze-report (Fase 1): un row por jugador que participó en
-- el pull (fight.friendlyPlayers de WCL), cruzando Deaths/DamageTaken contra
-- boss_mechanics_candidates de ese boss+dificultad.
create table if not exists player_pull_records (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null references pulls (id) on delete cascade,
  player_name text not null,
  died boolean not null default false,
  death_cause jsonb, -- { mechanicId, mechanicName, avoidable, preventableWithDefensive }. avoidable/preventableWithDefensive quedan null si no se pudo clasificar (mecánica sin revisar, o no se encontró el evento exacto del golpe).
  -- [{ spellId, name }] de cooldowns defensivos vistos activos durante el pull
  -- (catálogo verificado contra Blizzard Game Data en supabase/functions/_shared/defensive-cooldowns.ts,
  -- cruzado contra el campo `buffs` que ya da WCL en cada evento de DamageTaken).
  defensive_events jsonb not null default ''[]''::jsonb,
  avoidable_damage_taken bigint not null default 0,
  -- [{ mechanicId, mechanicName, amount }] — el desglose de avoidable_damage_taken
  -- por mecánica. Sin esto no se puede responder \"¿qué mecánica nos está haciendo
  -- daño de verdad?\", solo un totalón sin decir de qué viene. Es lo que alimenta
  -- el \"marcador\" de la sección de mecánicas (ver boss-mechanics.service.ts).
  mechanic_damage jsonb not null default ''[]''::jsonb,
  created_at timestamptz not null default now()
)","create index if not exists player_pull_records_pull_idx on player_pull_records (pull_id)","create table if not exists pull_briefs (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null unique references pulls (id) on delete cascade,
  headline text not null,
  improved jsonb not null default ''[]''::jsonb,
  regressed jsonb not null default ''[]''::jsonb,
  next_pull_actions jsonb not null default ''[]''::jsonb,
  model text not null,
  created_at timestamptz not null default now()
)","-- Guard/contador de llamadas al LLM. Cada llamada (permitida, bloqueada o fallida) se registra aquí.
create table if not exists llm_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  purpose text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  status text not null check (status in (''ok'', ''blocked'', ''error'')),
  block_reason text
)","create index if not exists llm_calls_created_at_idx on llm_calls (created_at desc)","create index if not exists llm_calls_status_idx on llm_calls (status, created_at desc)","create table if not exists session_state (
  id boolean primary key default true check (id), -- fila única (singleton)
  report_code text,
  active boolean not null default false,
  last_processed_fight_id integer,
  updated_at timestamptz not null default now()
)","-- RLS: lectura pública (anon key) para el dashboard, escritura solo desde
-- las Edge Functions (service_role, que no pasa por RLS). Uso personal,
-- sin login: si te preocupa la exposición, añade Supabase Auth más adelante.
alter table boss_mechanics enable row level security","alter table boss_mechanics_candidates enable row level security","alter table report_encounters enable row level security","alter table reports enable row level security","alter table pulls enable row level security","alter table player_pull_records enable row level security","alter table pull_briefs enable row level security","alter table llm_calls enable row level security","alter table session_state enable row level security","create policy \"read all - boss_mechanics\" on boss_mechanics for select using (true)","create policy \"read all - boss_mechanics_candidates\" on boss_mechanics_candidates for select using (true)","create policy \"read all - report_encounters\" on report_encounters for select using (true)","create policy \"read all - reports\" on reports for select using (true)","create policy \"read all - pulls\" on pulls for select using (true)","create policy \"read all - player_pull_records\" on player_pull_records for select using (true)","create policy \"read all - pull_briefs\" on pull_briefs for select using (true)","create policy \"read all - llm_calls\" on llm_calls for select using (true)","create policy \"read all - session_state\" on session_state for select using (true)","-- Imprescindible para que la suscripción Realtime del front reciba los INSERT.
-- Sin esto, RaidSessionService.subscribeRealtime() se queda callado.
alter publication supabase_realtime add table pulls","alter publication supabase_realtime add table pull_briefs","alter publication supabase_realtime add table llm_calls","alter publication supabase_realtime add table reports","alter publication supabase_realtime add table boss_mechanics_candidates","alter publication supabase_realtime add table report_encounters","-- Fila singleton obligatoria para session_state (id boolean primary key default true).
insert into session_state (id, active) values (true, false)
on conflict (id) do nothing"}', 'schema_v2_no_auth', NULL, NULL, NULL),
	('20260822010000', '{"-- Cierra un hueco real frente a la hoja de ruta (§12): el motor determinista
-- necesita una línea temporal de instancias de mecánica (para
-- MechanicTimelineComponent, el \"elemento de firma\" de la vista Live Pull),
-- pero el esquema de schema.sql solo persistía agregados por jugador
-- (player_pull_records) — nada raid-wide con timestamp + outcome.
--
-- Una fila por CADA cast de una mecánica del manifiesto durante un pull
-- (no por jugador golpeado). analyze-report la rellena cruzando el cast del
-- boss con los eventos de DamageTaken/Deaths que caen en la ventana de
-- reacción siguiente — es la heurística de daño evitable de §12, ahora
-- usando de verdad boss_mechanics_candidates.severity_threshold, que existía
-- en el esquema pero no la leía nadie todavía.

create table if not exists pull_mechanic_events (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null references pulls (id) on delete cascade,
  ability_id bigint not null,
  mechanic_name text not null,
  trigger_time_ms integer not null,
  outcome text not null check (outcome in (''clean'', ''partial_fail'', ''fail'')),
  players_hit integer not null default 0,
  avoidable boolean,
  created_at timestamptz not null default now()
)","create index if not exists pull_mechanic_events_pull_idx on pull_mechanic_events (pull_id, trigger_time_ms)","alter table pull_mechanic_events enable row level security","create policy \"read all - pull_mechanic_events\" on pull_mechanic_events for select using (true)","alter publication supabase_realtime add table pull_mechanic_events"}', 'pull_mechanic_events', NULL, NULL, NULL),
	('20260822020000', '{"-- Cierra el hueco de §3/§7: dps/hps, absorciones y talentos/trinkets
-- (combatantInfo de WCL) que la hoja de ruta pide explícitamente y que el
-- esquema nuevo (schema.sql) se había dejado fuera al simplificar
-- player_pull_records a solo muertes + daño evitable.

alter table player_pull_records
  add column if not exists dps numeric,
  add column if not exists hps numeric,
  add column if not exists absorbed_damage_taken bigint not null default 0,
  add column if not exists talent_build jsonb,
  add column if not exists equipped_items jsonb","comment on column player_pull_records.dps is ''DamageDone total del jugador / duración del pull en segundos. Simplificación conocida: usa duración total del pull, no \"active time\" (WCL descuenta huecos sin objetivo válido) — por eso puede quedar algo por debajo del DPS que enseña la propia web de WCL.''","comment on column player_pull_records.hps is ''Healing total (incluye overheal) del jugador / duración del pull en segundos. Mismo matiz de active time que dps.''","comment on column player_pull_records.absorbed_damage_taken is ''Suma del campo `absorbed` de los eventos DamageTaken de este jugador — daño que un escudo evitó, no daño recibido.''","comment on column player_pull_records.talent_build is ''Array de talentos tal cual viene de events(dataType: CombatantInfo) de WCL para este jugador en este fight.''","comment on column player_pull_records.equipped_items is ''Array de gear (incluye trinkets) tal cual viene de events(dataType: CombatantInfo) de WCL para este jugador en este fight.''"}', 'player_stats_columns', NULL, NULL, NULL),
	('20260822030000', '{"-- §12.1 de la hoja de ruta: catálogo de cooldowns defensivos sincronizado
-- desde el repo real de WoWAnalyzer (Docker + extractor), no mantenido a
-- mano. El esquema nuevo (schema.sql) nunca tuvo esta tabla — se reintroduce
-- ahora, con el catálogo verificado a mano (35 entradas, ver
-- _shared/defensive-cooldowns.ts) como semilla inicial, para no perder
-- cobertura mientras se sincroniza la extracción real.
--
-- analyze-report la carga UNA VEZ por invocación (no por evento) y la pasa
-- en memoria a activeDefensives()/defensivesForClass() — con cientos/miles
-- de eventos de daño por pull, una query por evento sería inviable.

create table if not exists cooldown_catalog (
  id uuid primary key default gen_random_uuid(),
  class text not null, -- tal cual lo da WCL en actor.subType (ej. \"DeathKnight\", no \"Death Knight\")
  spec text, -- null = aplica a toda la clase, no a una spec concreta
  spell_id int not null,
  name text not null,
  category text not null default ''personal_defensive''
    check (category in (''personal_defensive'', ''semi_defensive'', ''external_defensive'', ''utility'')),
  synced_from_commit text, -- SHA del commit de WoWAnalyzer/WoWAnalyzer usado, null = semilla manual
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (class, spell_id)
)","create index if not exists cooldown_catalog_class_idx on cooldown_catalog (class)","alter table cooldown_catalog enable row level security","create policy \"read all - cooldown_catalog\" on cooldown_catalog for select using (true)","-- Semilla: el catálogo verificado a mano contra Blizzard Game Data el
-- 2026-08-21 (ver cabecera de _shared/defensive-cooldowns.ts para el
-- proceso de verificación). synced_from_commit queda null a propósito —
-- así se distingue de un dato ya sincronizado desde el repo real.
insert into cooldown_catalog (class, spec, spell_id, name, category) values
  (''Warrior'', ''Protection'', 871, ''Shield Wall'', ''personal_defensive''),
  (''Warrior'', ''Arms'', 118038, ''Die by the Sword'', ''personal_defensive''),
  (''Warrior'', ''Fury'', 184364, ''Enraged Regeneration'', ''personal_defensive''),
  (''Paladin'', null, 642, ''Divine Shield'', ''personal_defensive''),
  (''Paladin'', null, 498, ''Divine Protection'', ''personal_defensive''),
  (''Paladin'', ''Protection'', 31850, ''Ardent Defender'', ''personal_defensive''),
  (''Paladin'', ''Protection'', 86659, ''Guardian of Ancient Kings'', ''personal_defensive''),
  (''DeathKnight'', null, 48792, ''Icebound Fortitude'', ''personal_defensive''),
  (''DeathKnight'', null, 48707, ''Anti-Magic Shell'', ''personal_defensive''),
  (''DeathKnight'', ''Blood'', 55233, ''Vampiric Blood'', ''personal_defensive''),
  (''Hunter'', null, 186265, ''Aspect of the Turtle'', ''personal_defensive''),
  (''Hunter'', null, 109304, ''Exhilaration'', ''personal_defensive''),
  (''Rogue'', null, 31224, ''Cloak of Shadows'', ''personal_defensive''),
  (''Rogue'', null, 1966, ''Feint'', ''semi_defensive''),
  (''Rogue'', null, 185311, ''Crimson Vial'', ''personal_defensive''),
  (''Priest'', ''Discipline'', 33206, ''Pain Suppression'', ''external_defensive''),
  (''Priest'', ''Holy'', 19236, ''Desperate Prayer'', ''personal_defensive''),
  (''Priest'', null, 586, ''Fade'', ''semi_defensive''),
  (''Shaman'', null, 108271, ''Astral Shift'', ''personal_defensive''),
  (''Mage'', null, 45438, ''Ice Block'', ''personal_defensive''),
  (''Mage'', null, 110959, ''Greater Invisibility'', ''personal_defensive''),
  (''Warlock'', null, 104773, ''Unending Resolve'', ''personal_defensive''),
  (''Warlock'', ''Affliction'', 108416, ''Dark Pact'', ''personal_defensive''),
  (''Monk'', null, 115203, ''Fortifying Brew'', ''personal_defensive''),
  (''Monk'', null, 122783, ''Diffuse Magic'', ''personal_defensive''),
  (''Monk'', null, 122278, ''Dampen Harm'', ''personal_defensive''),
  (''Druid'', null, 22812, ''Barkskin'', ''personal_defensive''),
  (''Druid'', ''Feral/Guardian'', 61336, ''Survival Instincts'', ''personal_defensive''),
  (''DemonHunter'', ''Havoc'', 198589, ''Blur'', ''personal_defensive''),
  (''DemonHunter'', ''Havoc'', 196555, ''Netherwalk'', ''personal_defensive''),
  (''DemonHunter'', ''Vengeance'', 187827, ''Metamorphosis'', ''personal_defensive''),
  (''Evoker'', null, 363916, ''Obsidian Scales'', ''personal_defensive''),
  (''Evoker'', null, 374348, ''Renewing Blaze'', ''personal_defensive''),
  (''Evoker'', ''Preservation'', 374227, ''Zephyr'', ''personal_defensive'')
on conflict (class, spell_id) do nothing"}', 'cooldown_catalog', NULL, NULL, NULL),
	('20260822040000', '{"-- §12/§12.1: disponibilidad real de cooldown (\"próximo_disponible(t) =
-- último_cast_antes_de(t) + base_cooldown_ms\"), no solo \"lo lanzó alguna vez
-- en el pull\". Necesita el cooldown base por spell, que hasta ahora no se
-- extraía porque analyze-report no lo usaba para nada — a partir de esta
-- fase sí.
alter table cooldown_catalog
  add column if not exists base_cooldown_ms integer","-- null = expresión dinámica no resoluble por texto (talentos/haste), disponibilidad queda ''unknown'' para esa spell

comment on column cooldown_catalog.base_cooldown_ms is
  ''Cooldown base en ms, talentos/haste en 0 (el \"peor caso\" antes de reducciones). Null cuando el extractor no pudo resolver un número plano del código fuente — ver supabase/wowanalyzer-extractor/extract.mjs.''","-- Descripción de la mecánica (de dónde sale: Blizzard Journal body_text/title)
-- para poder explicar/criticar qué hace, no solo cómo se llama.
alter table pull_mechanic_events
  add column if not exists description text","comment on column pull_mechanic_events.description is ''Copiado de boss_mechanics_candidates.description en el momento de clasificar — así el pull queda autocontenido aunque el manifiesto cambie después.''"}', 'cooldown_availability_and_mechanic_desc', NULL, NULL, NULL),
	('20260822050000', '{"-- Cierra dos huecos reales de UX/datos que dejaban \"79 nodos\" / \"ilvl 308\"
-- sin nombre en pantalla, algo que un RL no puede usar para nada:
--   1. class/spec por jugador y pull (antes solo vivía en memoria durante
--      analyze-report, nunca se persistía — ni siquiera para mostrar \"quién
--      es qué spec\" en la tabla de jugadores).
--   2. nombre resuelto de los trinkets (Blizzard Item API), guardado dentro
--      de equipped_items en el momento de clasificar el pull.
alter table player_pull_records
  add column if not exists class text, -- tal cual lo da WCL (actor.subType): \"Mage\", \"DeathKnight\"...
  add column if not exists spec text","-- resuelto vía Blizzard Game Data desde combatantInfo.specID: \"Frost\", \"Destruction\"...

comment on column player_pull_records.class is ''actor.subType de WCL para este jugador en este fight.''","comment on column player_pull_records.spec is ''Nombre de spec resuelto contra Blizzard Game Data (/data/wow/playable-specialization/{specID}) a partir de combatantInfo.specID. Null si WCL no dio combatantInfo para este jugador.''"}', 'player_class_spec_item_names', NULL, NULL, NULL),
	('20260822060000', '{"-- Cruce con logs públicos globales (no solo los de la guild), tal como
-- sugeriste: WCL tiene fightRankings/characterRankings por encuentro+
-- dificultad, con acceso público (client_credentials de sobra, son reports
-- ajenos pero públicos). sync-boss-mechanics ahora trae el mejor kill público
-- de este boss+dificultad y comprueba sus eventos Interrupts reales — así
-- \"esto es una mecánica de interrupt\" deja de ser una suposición y pasa a
-- ser un hecho observado en logs de verdad, aunque en los vuestros propios
-- (con solo 2-3 días de progresión) nunca haya sucedido un interrupt todavía.
alter table boss_mechanics_candidates
  add column if not exists observed_as_interrupt boolean not null default false","comment on column boss_mechanics_candidates.observed_as_interrupt is
  ''true si esta ability_id aparece como extraAbilityGameID en un evento Interrupts de un log público de referencia (fightRankings) para este boss+dificultad — evidencia real, no heurística. Sync-boss-mechanics lo recalcula cada vez; no es un campo editorial (no lo toca save-mechanic-edit).''"}', 'global_log_interrupt_detection', NULL, NULL, NULL),
	('20260822070000', '{"-- Sin esto, el front no puede distinguir \"0 golpeados\" (raid-damage/soak,
-- dato real) de \"0\" como código de \"nadie lo interrumpió\" (interrupt,
-- players_hit reutilizado como 0/1) — mismo campo, semántica distinta según
-- la categoría de la mecánica.
alter table pull_mechanic_events
  add column if not exists category text","comment on column pull_mechanic_events.category is ''Copiado de boss_mechanics_candidates.category en el momento de clasificar (igual que description) — para que el front sepa cómo leer players_hit/outcome sin tener que volver a consultar el manifiesto.''"}', 'mechanic_event_category', NULL, NULL, NULL),
	('20260822080000', '{"-- Cierra el hueco señalado en real (captura de pantalla): el manifiesto
-- enseñaba \"Sin categoría\" en TODAS las filas porque sync-boss-mechanics
-- nunca escribe `category` (solo save-mechanic-edit, a propósito, para no
-- pisar una edición humana en un resync — ver comentario en
-- 20260822000000_schema_v2_no_auth.sql). La solución no es que sync empiece
-- a escribir `category`: es darle una columna PROPIA para su sugerencia
-- (inferred_category + el porqué, inferred_category_reasons), que el front
-- usa como valor por defecto del desplegable mientras `category` siga sin
-- confirmar. Así nunca hay una fila en blanco de verdad, y la sugerencia
-- queda separada del dato editorial confirmado.

alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_category_check","alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_category_check
  check (category in (''tankbuster'',''raid-damage'',''avoidable-ground'',''debuff-stack'',''interrupt'',''soak'',''spread'',''healing-absorb''))","alter table boss_mechanics_candidates
  add column if not exists inferred_category text
    check (inferred_category in (''tankbuster'',''raid-damage'',''avoidable-ground'',''debuff-stack'',''interrupt'',''soak'',''spread'',''healing-absorb'')),
  add column if not exists inferred_category_reasons jsonb not null default ''[]''::jsonb","comment on column boss_mechanics_candidates.inferred_category is
  ''Sugerencia automática de sync-boss-mechanics (texto del Journal + comportamiento en un log público de referencia — ver _shared/mechanic-category-inference.ts). Se recalcula en cada resync. NUNCA sustituye a `category`: el front la usa solo como valor por defecto del desplegable mientras `category` esté sin confirmar.''","comment on column boss_mechanics_candidates.inferred_category_reasons is
  ''Array de frases legibles explicando de dónde salió inferred_category — la evidencia real, para el botón/tooltip de provenance (\"¿por qué esta categoría?\").''","-- Benchmark contra el mismo log público de referencia: cuánta gente golpea
-- de media esta mecánica ahí, para poder comparar contra vuestro propio
-- pull_mechanic_events.players_hit (\"¿estamos golpeando más gente de lo que
-- golpea incluso el mejor kill del mundo con esta misma mecánica?\").
alter table boss_mechanics_candidates
  add column if not exists reference_avg_players_hit numeric,
  add column if not exists reference_occurrences integer,
  add column if not exists reference_source_report text","comment on column boss_mechanics_candidates.reference_avg_players_hit is ''Media de objetivos golpeados por cast de esta mecánica en el log público de referencia (fightRankings), como cuenta absoluta de jugadores — no ratio.''","comment on column boss_mechanics_candidates.reference_source_report is ''Código del report público usado para el benchmark — trazabilidad/provenance, no es dato de la guild.''","-- §\"compendio de uso de defensivos\": todos los casts de cada defensivo por
-- jugador durante el pull (no solo el estado en el instante de morir, que ya
-- vive en death_cause.defensiveOptions). El cálculo ya existía en memoria
-- dentro de analyze-report (defensiveCastTimestampsByActor) — antes solo se
-- usaba para resolver el momento de la muerte y se descartaba.
alter table player_pull_records
  add column if not exists defensive_casts jsonb not null default ''[]''::jsonb","comment on column player_pull_records.defensive_casts is
  ''[{ spellId, name, timestampsMs: number[] }] — CADA cast de cada defensivo del catálogo de su clase durante el pull completo, no solo el que estaba activo al morir. timestampsMs relativo al inicio del pull (mismo espacio que trigger_time_ms).''","-- Consumibles: piedra de brujo y poción de vida (WCL los ve como casts
-- normales — ver _shared/consumables.ts para cómo se resuelven sus
-- abilityId reales desde masterData.abilities de CADA report, nunca IDs fijos
-- a mano, porque el nombre de la poción de vida cambia cada tier).
alter table player_pull_records
  add column if not exists consumables jsonb not null default ''{}''::jsonb","comment on column player_pull_records.consumables is
  ''{ healthstone: { available, used, count, timestampsMs }, healthPotion: { used, count, timestampsMs } }. `available` de healthstone = había algún Warlock en la raid de este pull (Blizzard permite que cualquiera lleve la suya si la crafteó, pero la señal fiable sin adivinar es esta: si NO hay warlock y el jugador no la usó, no se puede asegurar que la tuviera disponible, así que available queda false en ese caso en vez de asumir que sí la tenía).''"}', 'derived_metrics_and_category_inference', NULL, NULL, NULL),
	('20260822090000', '{"-- §\"a qué estamos llegando tarde\": ritmo del pull propio comparado contra el
-- mejor kill público del mismo boss+dificultad (mismo log de referencia que
-- ya usa sync-boss-mechanics para inferir categorías — se guarda aquí una
-- vez por boss+dificultad en vez de recalcularlo en cada pull).
create table if not exists boss_reference_stats (
  boss_id text not null,
  difficulty text not null,
  reference_kill_duration_ms integer not null,
  reference_report_code text not null,
  reference_fight_id integer not null,
  updated_at timestamptz not null default now(),
  primary key (boss_id, difficulty)
)","alter table boss_reference_stats enable row level security","create policy \"read all - boss_reference_stats\" on boss_reference_stats for select using (true)","comment on table boss_reference_stats is ''Duración del mejor kill público (worldData.fightRankings) por boss+dificultad — benchmark de ritmo, no dato editorial. Lo recalcula sync-boss-mechanics en cada sync.''"}', 'boss_reference_stats', NULL, NULL, NULL),
	('20260822100000', '{"-- §\"cómo está haciendo Avoid comparativamente\": comparar contra el kill #1
-- del mundo es un listón injusto/desmotivador — con fightRankings ya
-- vienen hasta 50 kills públicas reales por boss+dificultad (duration +
-- deaths de cada una), así que se guarda un percentil de verdad (mediana,
-- top cuartil) y qué fracción de esas kills fueron \"limpias\" (0 muertes),
-- no solo la comparación contra el mejor kill absoluto (que se mantiene,
-- son datos complementarios).
alter table boss_reference_stats
  add column if not exists reference_sample_size integer,
  add column if not exists reference_median_duration_ms integer,
  add column if not exists reference_p25_duration_ms integer,
  add column if not exists reference_zero_death_rate numeric","comment on column boss_reference_stats.reference_sample_size is ''Cuántas kills públicas se usaron para la mediana/percentil (hasta 50, las que devuelva fightRankings).''","comment on column boss_reference_stats.reference_median_duration_ms is ''Mediana de duración de esas kills — comparación más justa que \"el mejor del mundo\".''","comment on column boss_reference_stats.reference_p25_duration_ms is ''Percentil 25 de duración (el cuartil más rápido) — \"el ritmo de las guilds realmente rápidas\", sin ser el máximo absoluto.''","comment on column boss_reference_stats.reference_zero_death_rate is ''Fracción (0-1) de esas kills públicas que tuvieron 0 muertes registradas — para contextualizar si \"0 muertes\" es lo normal en un kill limpio o una rareza incluso para las mejores guilds.''"}', 'reference_percentile_stats', NULL, NULL, NULL),
	('20260822110000', '{"-- §\"el timeline es horrible, hay que rehacerlo de cero con algo real y
-- útil\": WCL tiene un endpoint `graph` pensado exactamente para esto (la
-- misma gráfica de daño-en-el-tiempo que se ve en la propia web de WCL/
-- Archon) — series por jugador, bucketizadas en intervalos regulares. Se
-- suman las series de daño recibido de toda la raid en UNA serie agregada y
-- se guarda en el pull (no se recalcula en cada visita, igual que el resto
-- de analyze-report).
alter table pulls
  add column if not exists raid_damage_taken_series jsonb","comment on column pulls.raid_damage_taken_series is
  ''{ pointIntervalMs: number, points: number[] } — daño recibido por TODA la raid, sumado por bucket de tiempo (WCL graph(dataType:DamageTaken, hostilityType:Friendlies)). Null si WCL no respondió (best-effort, no bloquea el resto del análisis).''"}', 'raid_damage_series', NULL, NULL, NULL),
	('20260822120000', '{"-- §\"falta la clasificación de ''mecánica de boss''... cuando eres target y te
-- toca hacer algo sí o sí, sin más\": categoría nueva, distinta de tankbuster
-- (que golpea siempre al ROL tank) — un jugador cualquiera es seleccionado
-- individualmente por el boss, sin que sea por posición (avoidable-ground)
-- ni por rol (tankbuster). Mismo patrón drop+add que
-- 20260822080000_derived_metrics_and_category_inference.sql para ampliar el
-- enum sin perder filas ya escritas.

alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_category_check","alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_category_check
  check (category in (''tankbuster'',''raid-damage'',''avoidable-ground'',''debuff-stack'',''interrupt'',''soak'',''spread'',''healing-absorb'',''personal-target''))","alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_inferred_category_check","alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_inferred_category_check
  check (inferred_category in (''tankbuster'',''raid-damage'',''avoidable-ground'',''debuff-stack'',''interrupt'',''soak'',''spread'',''healing-absorb'',''personal-target''))"}', 'personal_target_category', NULL, NULL, NULL),
	('20260822130000', '{"-- §10 de la hoja de ruta (auditoría v2): clasificación fina de muertes —
-- distinguir \"murió de un oneshot porque nadie entró a soakear\" de \"murió
-- por sanación insuficiente durante 20s\". player_pull_records.death_cause
-- (jsonb) ya existe y gana un campo nuevo `rootCause` dentro del jsonb, así
-- que no hace falta columna nueva para eso — solo documentado aquí.
--
-- players_hit_names SÍ es columna nueva: hasta ahora pull_mechanic_events
-- solo guardaba CUÁNTOS jugadores golpeó cada mecánica (players_hit int),
-- nunca QUIÉN — un raid lead no puede dirigirse a nadie con solo un número.
-- Se rellena en analyze-report a partir de los mismos eventos WCL que ya
-- calculan el conteo, sin llamada nueva a la API.
alter table pull_mechanic_events
  add column if not exists players_hit_names text[] not null default ''{}''","comment on column pull_mechanic_events.players_hit_names is
  ''Nombres de los jugadores golpeados por esta instancia de mecánica (mismo criterio que players_hit, pero con quién, no solo cuántos). Vacío en la categoría interrupt, donde players_hit se reutiliza como \"¿se resolvió?\" y no representa golpes reales.''"}', 'death_root_cause_and_hit_names', NULL, NULL, NULL),
	('20260822140000', '{"-- §9.1 de la hoja de ruta (auditoría v2): \"los bosses solo se cargan si hay
-- un pull propio\". report_encounters representa PULLS REALES (report_code +
-- fight_id no admiten null) — no es un catálogo, así que sembrar ahí un
-- boss nunca pulleado sería fabricar un pull que no existió. Catálogo aparte.
--
-- OJO con los IDs (verificado en real, 2026-08-22): Blizzard Journal y WCL
-- NO comparten espacio de IDs para el mismo boss (Nek''zali es
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
)","alter table known_raid_bosses enable row level security","create policy \"read all - known_raid_bosses\" on known_raid_bosses for select using (true)","alter publication supabase_realtime add table known_raid_bosses"}', 'known_raid_bosses', NULL, NULL, NULL),
	('20260822150000', '{"-- §3.1/§7.1 de la hoja de ruta (auditoría v2): percentil de parse real por
-- jugador — \"cómo de bien lo está haciendo Fulanito comparado con el resto
-- del mundo jugando su misma spec en este mismo boss+dificultad\". Sale de
-- Report.rankings(fightIDs), que YA da el percentil resuelto por WCL
-- (rankPercent) sin tener que traer ni comparar contra un leaderboard entero
-- a mano — verificado en real contra un pull real: un valor por jugador,
-- coherente con clase/spec/tamaño de raid reales de ese pull.
alter table player_pull_records
  add column if not exists world_rank_percent numeric,
  add column if not exists world_total_parses integer","comment on column player_pull_records.world_rank_percent is
  ''Percentil real (0-100) de WCL para este jugador en este pull concreto (Report.rankings) — comparado contra el resto del mundo con su misma clase/spec en este boss+dificultad. Null si WCL no pudo rankear el pull (ej. log privado sin permiso de ranking, o boss no rankeable todavía) — best-effort, nunca bloquea el resto del análisis.''","comment on column player_pull_records.world_total_parses is
  ''Tamaño de la muestra sobre la que se calculó world_rank_percent — un percentil sobre 40 parses no pesa igual que uno sobre 15000.''"}', 'world_percentile', NULL, NULL, NULL),
	('20260822160000', '{"-- §12 de la hoja de ruta (auditoría v2): sistema de fiabilidad del raider,
-- score 1-100. Primera pieza real: la vista que agrega, POR JUGADOR, las
-- señales crudas de cada pull dentro de una ventana móvil — la parte cara
-- (cruzar pulls + player_pull_records de TODA la guild en una ventana de 60
-- días, potencialmente miles de filas) vive en SQL, no en JS del cliente
-- (pull-analysis.service.ts ya deja dicho el principio: \"calculado al vuelo
-- en el cliente... si se nota lento, el sitio natural es una tabla/vista
-- nueva\" — esto ES ese sitio). La fórmula final (pesos, renormalización si
-- falta un eje, banda de color) SÍ vive en TypeScript (reliability.service.ts,
-- todavía por escribir) porque tiene lógica condicional que en SQL sería
-- ilegible — esta vista solo entrega los números YA agregados por pull.
--
-- Peso por recencia (§12.3 de la hoja de ruta): exponencial con
-- half-life configurable en la query (no fijo aquí), aplicado por FILA
-- (por pull), para que quien consuma la vista pueda sumar
-- weight*valor / sum(weight) con cualquier half-life sin tener que tocar SQL.
--
-- Decisión de normalización PROPIA (la hoja de ruta deja
-- \"normalizedAvoidableDamage\" sin especificar cómo se normaliza, y una
-- cantidad de daño evitable en bruto no es comparable entre un boss y otro
-- ni entre specs con distinta vida máxima): en vez de daño evitable en
-- bruto, se cuenta si el jugador tuvo ALGÚN daño evitable > 0 ese pull
-- (binario, comparable entre cualquier boss/clase) — \"¿este pull estuvo
-- limpio de mecánica evitable, sí o no?\", no \"¿cuánto dolió cuando falló?\".
create or replace view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  r.died,
  -- Eje \"ejecución mecánica\" (§12.1, 40%): 1 = pull limpio de daño evitable, 0 = tuvo alguno.
  (r.avoidable_damage_taken > 0) as had_avoidable_damage,
  -- Eje \"disciplina defensiva\" (§12.1, 30%): solo tiene sentido evaluarlo
  -- cuando hay una muerte real que lo ponga a prueba — un pull sin muerte no
  -- prueba nada sobre si el jugador usa sus defensivos bien o mal (podría no
  -- haberlos necesitado). null = \"no evaluable este pull\", no un cero
  -- silencioso — el consumidor filtra los null antes de promediar.
  -- Solo se afirma true/false cuando de verdad hay opciones que evaluar —
  -- un array vacío (clase/spec sin catálogo cargado todavía) NO cuenta como
  -- \"iba limpio\", cuenta como \"no evaluable\" (null), mismo principio que el
  -- resto de esta vista.
  case
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  -- Eje \"preparación\" (§12.1, 20%): encantamientos ya se pueden calcular hoy
  -- (equipped_items[].permanentEnchant, todos los slots, no solo trinkets);
  -- gemas/flask/comida NO — verificado en real que equipped_items no trae
  -- gems y no hay detección de flask/comida todavía (ver diseño completo en
  -- la respuesta, no solo este comentario). Se deja el cálculo parcial aquí
  -- mismo para no bloquear todo el eje en lo que falta.
  (
    select count(*) filter (where (item->>''permanentEnchant'') is not null and (item->>''id'')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as enchanted_slot_count,
  (
    select count(*) filter (where (item->>''id'')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as equipped_slot_count
from player_pull_records r
join pulls p on p.id = r.pull_id","comment on view player_pull_reliability_inputs is
  ''§12: entrada cruda (una fila por jugador+pull) para el score de fiabilidad — pesos/renormalización/half-life de recencia se aplican en reliability.service.ts, no aquí. enchanted_slot_count/equipped_slot_count son la mitad ya calculable del eje \"preparación\"; gemas/flask/comida quedan fuera hasta verificar disponibilidad real en combatantInfo.''"}', 'reliability_inputs_view', NULL, NULL, NULL),
	('20260823070000', '{"-- §\"la mecánica, cuánto daño ha sufrido, si ha gastado o no defensivo\": el
-- detalle por jugador de una instancia de mecánica fallada SIN muerte de por
-- medio (analyze-report ya calculaba esto para muertes vía death_cause, pero
-- pull_mechanic_events solo guardaba nombres, sin números). jsonb porque el
-- número de jugadores golpeados por instancia varía libremente.
alter table pull_mechanic_events
  add column if not exists player_hit_details jsonb not null default ''[]''","comment on column pull_mechanic_events.player_hit_details is
  ''Array de {name, damage_taken, damage_hits, healing_received, used_defensive_spell_id} — uno por jugador en players_hit_names. Vacío para categoría interrupt (players_hit no cuenta golpes ahí).''"}', 'mechanic_event_player_hit_details', NULL, NULL, NULL),
	('20260823080000', '{"-- §\"han desaparecido todos los talentos\": fetchTalentSpellLookup descargaba
-- dos tablas DB2 completas (TraitNodeEntry + TraitDefinition, miles de filas
-- de TODAS las clases) de wago.tools en CADA invocación de analyze-report —
-- lento y ocasionalmente falla/tarda demasiado, y al fallar el código
-- degrada en silencio a \"talentos sin resolver\" (a propósito, para no
-- bloquear el análisis — pero eso hace que la tabla de talentos parpadee
-- entre \"con iconos\" y \"vacía\" dependiendo de si esa descarga concreta tuvo
-- suerte). Esta tabla cachea el resultado por build de juego — solo cambia
-- cuando Blizzard saca un parche, así que una vez resuelto no hay que volver
-- a pedirlo nunca para ese build.
create table if not exists talent_spell_lookup (
  build text primary key,
  entry_to_spell jsonb not null,
  synced_at timestamptz not null default now()
)","alter table talent_spell_lookup enable row level security","create policy \"talent_spell_lookup is publicly readable\"
  on talent_spell_lookup for select
  using (true)"}', 'talent_spell_lookup_cache', NULL, NULL, NULL),
	('20260823090000', '{"-- §\"para calcular bien si había defensivo activo... tienes que revisar lo
-- que dura el defensivo con el momento de uso y el momento de su muerte, no
-- solo el CD\" (feedback real): hasta ahora \"activo al morir\" solo se sabía
-- si WCL traía un snapshot de buffs reciente (evento de daño a ≤2s de la
-- muerte con ese buff en la lista) — si el jugador murió sin recibir daño
-- justo antes (ej. muerte por otra vía, o hueco en los eventos), no había
-- forma de saberlo aunque el cast SÍ estuviera dentro de su ventana de
-- duración. Con la duración real del catálogo, analyze-report puede
-- calcularlo siempre: cast + duración vs. momento de morir, sin depender de
-- que existiera ese snapshot. Nullable: sin dato, se sigue con el
-- comportamiento anterior (snapshot de buffs) — más honesto que inventar
-- una duración.
alter table cooldown_catalog
  add column if not exists base_duration_ms integer","comment on column cooldown_catalog.base_duration_ms is
  ''Duración real del buff/efecto en ms (cuánto dura activo tras lanzarlo) — distinto de base_cooldown_ms (cuánto tarda en volver a estar disponible). Null = sin verificar; el cálculo de \"activo al morir\" cae de vuelta al snapshot de buffs de WCL.''"}', 'cooldown_catalog_duration', NULL, NULL, NULL),
	('20260823100000', '{"-- Duración real (base_duration_ms) de los 34 defensivos sembrados a mano en
-- 20260822030000_cooldown_catalog.sql, verificada contra el tooltip real de
-- Wowhead spell=<id> uno a uno (no de memoria — ver conversación). Donde
-- Wowhead mostraba \"Duration: n/a\" (Fortifying Brew, Greater Invisibility,
-- Blur, Renewing Blaze — efectos con fases/mecánica no reducible a una
-- duración simple) se deja NULL a propósito: mejor \"no lo sé\" que un número
-- inventado que marque \"activo\"/\"no activo\" mal en una muerte real.
-- Exhilaration y Crimson Vial/Desperate Prayer son sanaciones (con o sin
-- componente de buff con duración real, según el tooltip) — sus valores
-- también vienen del tooltip, no de la categoría de la habilidad.
update cooldown_catalog set base_duration_ms = 8000  where class = ''Warrior''     and spell_id = 871","-- Shield Wall
update cooldown_catalog set base_duration_ms = 8000  where class = ''Warrior''     and spell_id = 118038","-- Die by the Sword
update cooldown_catalog set base_duration_ms = 8000  where class = ''Warrior''     and spell_id = 184364","-- Enraged Regeneration
update cooldown_catalog set base_duration_ms = 8000  where class = ''Paladin''     and spell_id = 642","-- Divine Shield
update cooldown_catalog set base_duration_ms = 8000  where class = ''Paladin''     and spell_id = 498","-- Divine Protection
update cooldown_catalog set base_duration_ms = 12000 where class = ''Paladin''     and spell_id = 31850","-- Ardent Defender
update cooldown_catalog set base_duration_ms = 8000  where class = ''Paladin''     and spell_id = 86659","-- Guardian of Ancient Kings
update cooldown_catalog set base_duration_ms = 8000  where class = ''DeathKnight'' and spell_id = 48792","-- Icebound Fortitude
update cooldown_catalog set base_duration_ms = 5000  where class = ''DeathKnight'' and spell_id = 48707","-- Anti-Magic Shell
update cooldown_catalog set base_duration_ms = 10000 where class = ''DeathKnight'' and spell_id = 55233","-- Vampiric Blood
update cooldown_catalog set base_duration_ms = 8000  where class = ''Hunter''      and spell_id = 186265","-- Aspect of the Turtle
-- Exhilaration (109304): sanación instantánea, sin buff con duración — se queda NULL a propósito.
update cooldown_catalog set base_duration_ms = 5000  where class = ''Rogue''       and spell_id = 31224","-- Cloak of Shadows
update cooldown_catalog set base_duration_ms = 6000  where class = ''Rogue''       and spell_id = 1966","-- Feint
update cooldown_catalog set base_duration_ms = 4000  where class = ''Rogue''       and spell_id = 185311","-- Crimson Vial (aura de regen, 4s)
update cooldown_catalog set base_duration_ms = 8000  where class = ''Priest''      and spell_id = 33206","-- Pain Suppression
update cooldown_catalog set base_duration_ms = 10000 where class = ''Priest''      and spell_id = 19236","-- Desperate Prayer (buff de salud máx., 10s)
update cooldown_catalog set base_duration_ms = 10000 where class = ''Priest''      and spell_id = 586","-- Fade
update cooldown_catalog set base_duration_ms = 12000 where class = ''Shaman''      and spell_id = 108271","-- Astral Shift
update cooldown_catalog set base_duration_ms = 10000 where class = ''Mage''        and spell_id = 45438","-- Ice Block
-- Greater Invisibility (110959): Wowhead da \"Duration: n/a\" (tiene fases: DR breve + invis más larga) — se queda NULL.
update cooldown_catalog set base_duration_ms = 8000  where class = ''Warlock''     and spell_id = 104773","-- Unending Resolve
update cooldown_catalog set base_duration_ms = 20000 where class = ''Warlock''     and spell_id = 108416","-- Dark Pact
-- Fortifying Brew (115203): Wowhead da \"Duration: n/a\" — se queda NULL.
update cooldown_catalog set base_duration_ms = 6000  where class = ''Monk''        and spell_id = 122783","-- Diffuse Magic
update cooldown_catalog set base_duration_ms = 10000 where class = ''Monk''        and spell_id = 122278","-- Dampen Harm
update cooldown_catalog set base_duration_ms = 8000  where class = ''Druid''       and spell_id = 22812","-- Barkskin
update cooldown_catalog set base_duration_ms = 6000  where class = ''Druid''       and spell_id = 61336","-- Survival Instincts
-- Blur (198589, DemonHunter Havoc): Wowhead da \"Duration: n/a\" — se queda NULL.
update cooldown_catalog set base_duration_ms = 2500  where class = ''DemonHunter'' and spell_id = 196555","-- Netherwalk
update cooldown_catalog set base_duration_ms = 15000 where class = ''DemonHunter'' and spell_id = 187827","-- Metamorphosis (Vengeance)
update cooldown_catalog set base_duration_ms = 12000 where class = ''Evoker''      and spell_id = 363916","-- Obsidian Scales
-- Renewing Blaze (374348): Wowhead da \"Duration: n/a\" — se queda NULL.
update cooldown_catalog set base_duration_ms = 8000  where class = ''Evoker''      and spell_id = 374227","-- Zephyr"}', 'cooldown_catalog_duration_seed', NULL, NULL, NULL),
	('20260823110000', '{"-- §\"a los paladines les aparecen muchísimos defensivos, hay que verificarlos\"
-- (feedback real): auditoría completa del catálogo (group by class,name
-- having count>1) encontró UN solo duplicado real en TODA la tabla —
-- Paladin \"Divine Protection\" con dos spell_id distintos (498 y 403876).
-- Verificado en Wowhead: mismo efecto exacto (-20% daño, 8s, 1min CD) — es
-- la misma habilidad para el jugador aunque Blizzard use dos IDs internos
-- (probablemente uno por rama del árbol de talentos). Se queda 498, que ya
-- tiene base_duration_ms verificado (20260823100000); 403876 no.
delete from cooldown_catalog where class = ''Paladin'' and spell_id = 403876"}', 'fix_duplicate_divine_protection', NULL, NULL, NULL),
	('20260823120000', '{"-- §\"la API de wowaudit... roster de verdad en lugar de deducirlo\": hasta
-- ahora el roster se deducía de \"quién ha aparecido en algún pull\" — esta
-- tabla es el roster CANÓNICO real (quién está de verdad en la guild, su rol
-- de raid, si es Main/Trial) más la asistencia agregada que wowaudit ya
-- calcula — exactamente el dato que le faltaba al eje \"asistencia\" de
-- fiabilidad (§12, documentado como bloqueado en reliability.service.ts por
-- \"roster canónico sin construir\").
create table if not exists wowaudit_roster (
  character_id bigint primary key, -- id de wowaudit, no de Blizzard/WCL
  name text not null,
  realm text not null,
  class text not null,
  -- Tank / Heal / Melee / Ranged (Melee+Ranged = dps a efectos de icono de rol)
  role text not null,
  rank text not null, -- Main / Trial
  status text not null,
  attended_amount_of_raids integer not null default 0,
  total_amount_of_raids integer not null default 0,
  attended_percentage numeric,
  synced_at timestamptz not null default now()
)","create index if not exists wowaudit_roster_name_idx on wowaudit_roster (name)","alter table wowaudit_roster enable row level security","create policy \"wowaudit_roster is publicly readable\"
  on wowaudit_roster for select
  using (true)"}', 'wowaudit_roster', NULL, NULL, NULL),
	('20260823130000', '{"-- §\"de dónde puedes obtener los enchants y gemas que decíamos para la
-- fiabilidad\" (feedback real): las gemas SÍ están en equipped_items[].gems[]
-- (verificado en real contra datos ya guardados — el comentario anterior de
-- esta vista decía que no, era incorrecto/quedó desactualizado). Esta
-- revisión corrige dos cosas del intento anterior:
--   1. enchanted_slot_count/equipped_slot_count contaban TODOS los slots
--      equipados, penalizando injustamente casco/hombreras/manos/cintura/
--      anillos (encantamientos ahí dependen de facción/profesión, no todo
--      el mundo tiene acceso) — se acota a los 7 slots universalmente
--      encantables en cualquier expansión: espalda, pecho, piernas,
--      muñecas, pies, anillo1, anillo2.
--   2. gem_count nuevo — informativo, NO se convierte en ratio (no tenemos
--      de dónde sacar \"cuántos engarces DEBERÍA tener\" sin datos de sockets
--      por ítem de Blizzard, así que no se puntúa para no inventar un
--      umbral — se expone crudo para quien quiera mirarlo).
drop view if exists player_pull_reliability_inputs","create view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  r.died,
  (r.avoidable_damage_taken > 0) as had_avoidable_damage,
  (r.died and r.death_cause->>''rootCause'' = ''self_positioning'') as self_positioning_death,
  case
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  -- Eje \"preparación\" (§12.1, 20%): espalda(14) pecho(4) piernas(6)
  -- muñecas(8) pies(7) anillo1(10) anillo2(11) — el orden de slot que ya usa
  -- el resto del código (ver TRINKET_SLOT_INDICES=[12,13] en analyze-report,
  -- mismo espacio de índices que da WCL).
  (
    select count(*) filter (where (item->>''permanentEnchant'') is not null and (item->>''id'')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where (item->>''id'')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count
from player_pull_records r
join pulls p on p.id = r.pull_id","comment on view player_pull_reliability_inputs is
  ''§12: entrada cruda (una fila por jugador+pull) para el score de fiabilidad. enchanted_slot_count/enchantable_slot_count (7 slots siempre encantables) alimentan el eje preparación en reliability.service.ts; gem_count es informativo (sin dato de sockets máximos por ítem, no se puntúa).''"}', 'reliability_preparation_axis', NULL, NULL, NULL),
	('20260823140000', '{"-- §\"atascos constantes... a través de todos los bosses\" (feedback real):
-- reliability.service.ts da un número por jugador (sin desglosar por
-- categoría) y boss-history.service.ts da tendencia por categoría PERO
-- acotada a un solo boss. Ninguno responde \"¿este jugador falla SIEMPRE
-- zona evitable, en varios bosses distintos, no solo en uno?\" — que es
-- justo la definición de un atasco constante (un mal pull puntual en un
-- boss no cuenta, repetirse across bosses sí). players_hit_names ya
-- identifica QUIÉN falló cada instancia de mecánica (20260822130000); esta
-- vista solo hace unnest + join con pulls para tener boss_id/closed_at por
-- fila jugador+mecánica-fallada. El umbral de \"cuántos bosses distintos
-- hacen falta para llamarlo patrón\" vive en offenders.service.ts, no aquí.
drop view if exists player_mechanic_offenses","create view player_mechanic_offenses as
select
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  e.category,
  e.ability_id,
  e.mechanic_name,
  e.outcome,
  unnest(e.players_hit_names) as player_name
from pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category is not null
  and e.outcome <> ''clean''
  and array_length(e.players_hit_names, 1) > 0","comment on view player_mechanic_offenses is
  ''§\"ofensor repetido cross-boss\": una fila por jugador golpeado por una instancia de mecánica FALLADA (outcome<>clean), con boss_id/category/closed_at para que offenders.service.ts pueda agrupar \"misma categoría, en cuántos bosses distintos, en qué ventana\" sin tener que traerse pull_mechanic_events entero al cliente.''"}', 'player_mechanic_offenses_view', NULL, NULL, NULL),
	('20260823150000', '{"-- §\"la asistencia en el roster sigue saliendo rara... la raid abrió el
-- miércoles 19 de agosto y solo hemos raideado una vez, así que la
-- asistencia debería ser 100%\" (feedback real, investigado): wowaudit
-- calcula attended_percentage sobre SU PROPIO calendario de eventos
-- programados/firmas (verificado en real contra la API: total_amount_of_raids
-- varía por personaje — 1, 4, 5... — no es \"noches de raid reales\", es
-- \"eventos programados en wowaudit a los que ese personaje pertenecía\"), no
-- sobre raids que de verdad ocurrieron. Fila única con la fecha de inicio de
-- la season vigente (current_season.start_date de /v1/period, que
-- sync-wowaudit-roster ya trae) — attendance.service.ts la usa para contar
-- asistencia real: noches = reports YA IMPORTADOS en Avoid desde esa fecha,
-- asistido = el jugador aparece en player_pull_records de ese report. Dato
-- propio, no una copia de wowaudit.
create table if not exists wowaudit_season (
  id boolean primary key default true,
  start_date date not null,
  synced_at timestamptz not null default now(),
  constraint wowaudit_season_single_row check (id)
)","alter table wowaudit_season enable row level security","create policy \"read all - wowaudit_season\" on wowaudit_season for select using (true)","comment on table wowaudit_season is
  ''Fila única (id=true) con el inicio de la season vigente según wowaudit (/v1/period) — usada para acotar \"asistencia real\" (attendance.service.ts) y cualquier otra métrica que deba mirar solo la season actual.''"}', 'wowaudit_season', NULL, NULL, NULL),
	('20260823160000', '{"-- §\"cuándo se determina un wipe global... esa gente no debería afectar su
-- fiabilidad ni sus defensivos ni contar como muerte, marcado como wipe
-- call\" (feedback real). Detección en analyze-report (ver
-- supabase/functions/analyze-report/index.ts, detectWipeCall) — un cluster
-- de muertes casi simultáneas cerca del final de un wipe, con señales de
-- sanación/daño de la raid desplomándose justo antes y causas de muerte
-- heterogéneas (no todos a la misma habilidad, que sería una mecánica real
-- y no un wipe call). Auto-excluido de las estadísticas por defecto cuando
-- la confianza es alta (§decisión del usuario: \"que autoexcluya pero que
-- permita también editarlo... para restaurar los valores\"), pero SIEMPRE
-- editable a mano — wipe_call_excluded es la decisión final, wipe_call_signals
-- queda como evidencia para que el RL pueda revisar/corregir el auto-guess.

alter table pulls add column if not exists wipe_call_confidence numeric","-- null = no se detectó ningún cluster (nunca se evaluó, o el pull fue kill)
alter table pulls add column if not exists wipe_call_signals jsonb","-- desglose de señales (simultaneityFraction, abilityDiversity, healingCollapseRatio, damageCollapseRatio, sustainedDeathFraction, nearEndMs) — mismo espíritu que inferred_category_reasons: transparencia del porqué, no una caja negra
alter table pulls add column if not exists wipe_call_excluded boolean not null default false","-- la decisión que de verdad consumen los cálculos — true = excluir estas muertes de fiabilidad/métricas/tendencias. Se inicializa a (confidence >= umbral) en analyze-report, editable después vía set-wipe-call-status

comment on column pulls.wipe_call_excluded is
  ''Decisión real que consumen reliability (player_pull_reliability_inputs), las tarjetas de métricas y \"a quién dirigir\": excluir las muertes del cluster detectado (player_pull_records.wipe_call_cluster=true de este pull) de fiabilidad/racha/mecánicas falladas. Editable por el RL vía la función set-wipe-call-status — nunca se sobreescribe en un re-análisis del mismo pull salvo que cambie el propio wipe_call_confidence.''","alter table player_pull_records add column if not exists wipe_call_cluster boolean not null default false","-- true = esta muerte concreta forma parte del cluster detectado en ESTE pull (independiente de si wipe_call_excluded está activo o no — es el hecho, no la decisión)

comment on column player_pull_records.wipe_call_cluster is
  ''true = esta muerte formó parte del cluster de \"posible wipe call\" detectado para el pull. No implica que esté excluida de las estadísticas — eso lo decide pulls.wipe_call_excluded, editable aparte.''"}', 'wipe_call_detection', NULL, NULL, NULL),
	('20260823230000', '{"-- §\"un dosier de personaje de una noche concreta... una foto suya de
-- perfil si podemos tenerla\" (feedback real): retrato del personaje vía
-- Character Media API de Blizzard, resuelto UNA VEZ en sync-wowaudit-roster
-- (no en cada vista del dosier — evita una llamada externa por carga de
-- pantalla, mismo criterio que ya usa el resto del proyecto para nombres de
-- trinkets/specs). null = personaje no encontrado con ese nombre+reino,
-- perfil oculto, o Blizzard no respondió — best-effort, nunca bloquea el sync.
alter table wowaudit_roster add column if not exists avatar_url text"}', 'wowaudit_roster_avatar', NULL, NULL, NULL),
	('20260823170000', '{"-- §\"esa gente no debería afectar su fiabilidad ni sus defensivos ni contar
-- como muerte\" (feedback real): player_pull_reliability_inputs es la ÚNICA
-- entrada cruda del score de fiabilidad (reliability.service.ts) — excluir
-- la fila entera (mecánica+defensiva+preparación de ESE pull para ESE
-- jugador) cuando su muerte formó parte de un cluster de wipe call
-- confirmado/auto-excluido. No afecta a otros pulls suyos ni a otros
-- jugadores del mismo pull que murieron fuera del cluster.
drop view if exists player_pull_reliability_inputs","create view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  r.died,
  (r.avoidable_damage_taken > 0) as had_avoidable_damage,
  (r.died and r.death_cause->>''rootCause'' = ''self_positioning'') as self_positioning_death,
  case
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  (
    select count(*) filter (where (item->>''permanentEnchant'') is not null and (item->>''id'')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where (item->>''id'')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not (r.wipe_call_cluster and p.wipe_call_excluded)","comment on view player_pull_reliability_inputs is
  ''§12: entrada cruda (una fila por jugador+pull) para el score de fiabilidad. Excluye filas de jugadores cuya muerte formó parte de un wipe call detectado Y marcado como excluido (pulls.wipe_call_excluded) — ver 20260823160000_wipe_call_detection.sql. enchanted_slot_count/enchantable_slot_count (7 slots siempre encantables) alimentan el eje preparación; gem_count es informativo.''"}', 'wipe_call_reliability_exclusion', NULL, NULL, NULL),
	('20260823180000', '{"-- §bug real encontrado y arreglado a mano el 2026-08-23: la noche del 19 de
-- agosto quedó guardada como DOS reports distintos (dos personas subieron el
-- mismo log con addons distintos) — sin ninguna detección, esto duplicaba
-- CADA pull/muerte/mecánica en todo el pipeline (boss-history, fiabilidad,
-- ofensor repetido, tendencia de jugador). Se limpiaron los datos existentes
-- a mano; esta columna es la detección para que no vuelva a colar en
-- silencio — analyze-report la rellena al crear un report nuevo si encuentra
-- otro YA importado con inicio cercano (±6h) y ≥2 bosses en común. NUNCA
-- bloquea el import (podría ser una segunda sesión real el mismo día) — es
-- un aviso visible para que el RL decida, mismo principio que el resto de
-- la app (nunca decidir en silencio).
alter table reports add column if not exists possible_duplicate_of text","comment on column reports.possible_duplicate_of is
  ''report_code de OTRO report ya importado que parece ser la misma sesión (inicio a ±6h, ≥2 bosses en común) — null = sin sospecha de duplicado. Puramente informativo, no impide nada.''"}', 'report_duplicate_detection', NULL, NULL, NULL),
	('20260823190000', '{"-- §\"si marco el primer boss que solo tiene 2 pulls, debajo me sale #3 y #4\"
-- (feedback real): efecto secundario de la limpieza del report duplicado
-- (20260823 antes) — pull_number se asigna como COUNT(pulls de ese
-- boss+dificultad)+1 EN EL MOMENTO de insertar (analyze-report), nunca se
-- renumera después. Al borrar los pulls del report duplicado, los que
-- sobrevivieron se quedaron con los números que les tocó cuando el
-- duplicado todavía existía (huecos: #3/#4 en vez de #1/#2). Reparación de
-- datos única: renumera 1..N por boss+dificultad en orden cronológico real.
--
-- OJO — el propio esquema de numeración (COUNT en insert, nunca revisado)
-- sigue siendo frágil ante cualquier borrado futuro de un pull, no solo
-- ante duplicados de report. Queda documentado aquí; una migración real a
-- \"pull_number calculado, no guardado\" (ROW_NUMBER() OVER en una vista) es
-- el arreglo de fondo si esto se repite.
with ranked as (
  select id, row_number() over (partition by boss_id, difficulty order by closed_at asc, fight_id asc) as rn
  from pulls
)
update pulls p
set pull_number = r.rn
from ranked r
where p.id = r.id and p.pull_number <> r.rn"}', 'renumber_pulls', NULL, NULL, NULL),
	('20260823200000', '{"-- §\"en la tabla de roster... Mechavalec sale de dps cuando el log pone
-- ''guerrero protección'' que es tank\" (feedback real, investigado): wowaudit
-- SÍ dice role=''Melee'' para Mechavalec (confirmado contra la API real) —
-- no es un bug de sync, es la configuración de wowaudit desactualizada
-- frente a lo que de verdad está jugando. wowaudit-roster.service.ts cruza
-- esto con la spec REAL más reciente que ya tenemos de WCL (más fiable que
-- una config manual) — esta vista da esa spec más reciente por jugador,
-- barata (una fila por jugador, no todo el historial).
drop view if exists player_latest_spec","create view player_latest_spec as
select distinct on (player_name)
  player_name,
  class,
  spec
from player_pull_records
where spec is not null and class is not null
order by player_name, created_at desc","comment on view player_latest_spec is
  ''§\"cómo se clasifica la gente\": una fila por jugador con su class/spec del pull MÁS RECIENTE que tenemos — wowaudit-roster.service.ts la usa para corregir el role de wowaudit cuando está desactualizado (ej. alguien que cambió a tank de main-spec y wowaudit no se actualizó).''"}', 'player_latest_spec', NULL, NULL, NULL),
	('20260823210000', '{"-- §\"nos hace falta la categoría de enrage, he visto que varias habilidades
-- son de enrage y no la podemos clasificar bien\" (feedback real): boss/add
-- se enfurece (golpea más fuerte, castea más rápido, o aparece tras un
-- tiempo límite) — no encaja en ninguna de las 9 categorías existentes
-- (no es daño repartido normal, no es posicional, no es responsabilidad de
-- un jugador concreto). Mismo patrón drop+add que las ampliaciones
-- anteriores del enum (20260822080000, 20260822130000) para no perder
-- filas ya escritas.
alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_category_check","alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_category_check
  check (category in (''tankbuster'',''raid-damage'',''avoidable-ground'',''debuff-stack'',''interrupt'',''soak'',''spread'',''healing-absorb'',''personal-target'',''enrage''))","alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_inferred_category_check","alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_inferred_category_check
  check (inferred_category in (''tankbuster'',''raid-damage'',''avoidable-ground'',''debuff-stack'',''interrupt'',''soak'',''spread'',''healing-absorb'',''personal-target'',''enrage''))"}', 'enrage_category', NULL, NULL, NULL),
	('20260823220000', '{"-- §\"estaría bien meter un botón o icono de información que te venga lo que
-- dice en ''notas'' al preguntarle a una IA, ya que parece bastante útil\"
-- (feedback real): classify-mechanics ya generaba confidence/sources/notes
-- por mecánica pero los descartaba tras aplicar la categoría — se guardan
-- para poder mostrarlos en Ajustes junto a cada mecánica clasificada así.
alter table boss_mechanics_candidates add column if not exists ai_classification jsonb","comment on column boss_mechanics_candidates.ai_classification is
  ''{confidence, sources, notes, classifiedAt} — solo presente en mecánicas clasificadas vía el flujo de prompt de IA (classify-mechanics, action=submit). null = clasificada a mano o nunca clasificada.''"}', 'ai_classification_notes', NULL, NULL, NULL),
	('20260823240000', '{"-- §bug real encontrado y arreglado el 2026-08-23 (feedback real: \"sale
-- gusmi con lluvia de estrellas como defensivo, es erróneo\"): buildPlayerHitDetails
-- en analyze-report indexaba TODOS los casts del jugador (rotación normal
-- incluida), no solo su catálogo de defensivos — la primera spell que
-- cayera en la ventana de reacción se guardaba como \"defensivo usado\",
-- fuera o no un defensivo de verdad. El código ya se corrigió (acota al
-- catálogo real de clase/spec/talentos antes de mirar timestamps) y afecta
-- a análisis NUEVOS — esto repara lo YA guardado.
--
-- Verificado antes de aplicar: de 6.670 entradas con used_defensive_spell_id
-- puesto, 6.656 (99,8%) no correspondían a ningún defensivo real del
-- catálogo de ese jugador (player_pull_records.defensive_casts, que SÍ
-- estuvo siempre bien acotado al catálogo — es la fuente de verdad contra
-- la que se valida aquí). Solo se pone a null el campo erróneo dentro de
-- cada elemento de player_hit_details — el resto (daño, sanación, nombre)
-- no se toca.
update pull_mechanic_events e
set player_hit_details = (
  select jsonb_agg(
    case
      when (elem->>''used_defensive_spell_id'') is not null
        and not exists (
          select 1
          from player_pull_records r, jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) dc
          where r.pull_id = e.pull_id
            and r.player_name = elem->>''name''
            and (dc->>''spellId'')::bigint = (elem->>''used_defensive_spell_id'')::bigint
        )
      then jsonb_set(elem, ''{used_defensive_spell_id}'', ''null''::jsonb)
      else elem
    end
  )
  from jsonb_array_elements(e.player_hit_details) elem
)
where jsonb_array_length(e.player_hit_details) > 0"}', 'fix_bogus_defensive_attribution', NULL, NULL, NULL),
	('20260824100000', '{"-- §\"las habilidades deberían estar en inglés y de subtítulo en castellano
-- para poder localizarlas bien\" (feedback real, 2026-08-24): nombre de la
-- habilidad en castellano, sacado del Journal de Blizzard con locale=es_ES
-- (ver getJournalEncounterLocalized en _shared/blizzard-client.ts). Null si
-- Blizzard no tiene traducción todavía o la llamada falló esa vez — nunca
-- bloquea el sync por esto.
alter table boss_mechanics_candidates
  add column if not exists name_es text"}', 'mechanic_name_es', NULL, NULL, NULL),
	('20260824110000', '{"-- §\"meter en el dosier de un jugador y en el resumen de toda la noche
-- completa también la consulta de IA... a nivel más detalle, y poder
-- copiar ese informe\" (feedback real, 2026-08-24): mismo mecanismo que
-- pull_briefs (generate-pull-brief/manual-pull-brief), dos tablas nuevas
-- para las otras dos combinaciones que ya existen en el resto de la app —
-- jugador × noche y raid × noche — en vez de forzar todo en pull_briefs
-- (que está atado a un pull_id concreto, no a estos dos ámbitos).
--
-- Columna `next_pull_actions` (no `next_actions`): a propósito el mismo
-- nombre que pull_briefs, aunque aquí no sea literalmente \"el próximo
-- pull\" — así el frontend reutiliza tal cual mapBrief()/LlmPullAnalysis sin
-- una función de mapeo aparte por tabla. El prompt de cada ámbito ya deja
-- claro al LLM qué significa el campo en cada caso.

create table if not exists night_player_briefs (
  id uuid primary key default gen_random_uuid(),
  report_code text not null references reports(code) on delete cascade,
  player_name text not null,
  headline text not null,
  improved jsonb not null default ''[]''::jsonb,
  regressed jsonb not null default ''[]''::jsonb,
  next_pull_actions jsonb not null default ''[]''::jsonb,
  model text not null,
  created_at timestamptz not null default now(),
  unique (report_code, player_name)
)","alter table night_player_briefs enable row level security","create policy \"read all - night_player_briefs\" on night_player_briefs for select using (true)","create table if not exists night_briefs (
  id uuid primary key default gen_random_uuid(),
  report_code text not null unique references reports(code) on delete cascade,
  headline text not null,
  improved jsonb not null default ''[]''::jsonb,
  regressed jsonb not null default ''[]''::jsonb,
  next_pull_actions jsonb not null default ''[]''::jsonb,
  model text not null,
  created_at timestamptz not null default now()
)","alter table night_briefs enable row level security","create policy \"read all - night_briefs\" on night_briefs for select using (true)"}', 'night_briefs', NULL, NULL, NULL),
	('20260824120000', '{"-- §\"tienes que repasar defensivos REALMENTE que pueden usar y tienen
-- disponible, por ejemplo linkedara es un sacerdote disciplina y le pones
-- disponible dispersión, que es exclusivo de sacerdote sombras... supongo
-- que esto mismo afecta a varias clases distintas\" (feedback real,
-- 2026-08-24, con captura real: Linkedara/Disciplina viendo Dispersion
-- disponible).
--
-- Causa raíz: el extractor (supabase/wowanalyzer-extractor/extract.mjs)
-- deriva `spec` del PATH del fichero fuente de WoWAnalyzer
-- (analysis/retail/{clase}/{spec}/Abilities.tsx -> spec; carpeta \"shared\"
-- o el fichero directamente en la carpeta de clase -> spec=null,
-- \"compartido entre todas las specs\"). Esa heurística asume que WoWAnalyzer
-- organiza sus ficheros por disponibilidad real, pero varias defensivas
-- viven en su carpeta \"shared\" solo por conveniencia de organización del
-- código de esa librería, no porque las tenga toda la clase — de ahí que
-- salieran con spec=null en cooldown_catalog aunque el hechizo sea de UNA
-- sola spec en el juego real.
--
-- Auditada TODA la tabla fila a fila contra el diseño real de cada clase
-- (confirmado además con la descripción real de Blizzard Game Data API para
-- cada spell_id de aquí abajo — ej. Shield Block \"Raise your shield...\"
-- solo tiene sentido con escudo, exclusivo de Protection). Sin checkout de
-- WoWAnalyzer disponible en esta sesión para re-ejecutar el extractor
-- (requiere Docker) — esto es una corrección de datos puntual sobre las
-- filas hoy erróneas, no un cambio al extractor en sí. Si se vuelve a
-- ejecutar el extractor sin arreglar la heurística de \"shared\" primero,
-- estas mismas filas pueden volver a quedar en null.

-- Demon Hunter: Demon Spikes y Fiery Brand son herramientas de mitigación
-- de Vengeance (armadura/reducción de daño de tanque) — Havoc no las tiene.
update cooldown_catalog set spec = ''Vengeance'' where class = ''DemonHunter'' and spell_id in (203720, 204021)","-- Mage: las tres \"barrera\" son variantes paralelas, una por spec — un mago
-- solo tiene UNA de las tres en su hechizario según su especialización.
update cooldown_catalog set spec = ''Fire'' where class = ''Mage'' and spell_id = 235313","-- Blazing Barrier
update cooldown_catalog set spec = ''Frost'' where class = ''Mage'' and spell_id = 11426","-- Ice Barrier
update cooldown_catalog set spec = ''Arcane'' where class = ''Mage'' and spell_id = 235450","-- Prismatic Barrier

-- Priest: Dispersion es exclusivo de Shadow — el caso reportado en real.
update cooldown_catalog set spec = ''Shadow'' where class = ''Priest'' and spell_id = 47585","-- Warrior: Defensive Stance (la propia stance es de Protection), Ignore
-- Pain y Shield Block (exige escudo equipado) son herramientas de
-- mitigación exclusivas de Protection — Arms/Fury no las tienen.
update cooldown_catalog set spec = ''Protection'' where class = ''Warrior'' and spell_id in (386208, 190456, 2565)"}', 'fix_cooldown_catalog_spec_gaps', NULL, NULL, NULL),
	('20260824130000', '{"-- Complemento de 20260824120000_fix_cooldown_catalog_spec_gaps.sql: esa
-- migración corrige el CATÁLOGO (cooldown_catalog), lo que arregla todo
-- análisis FUTURO — pero player_pull_records.death_cause.defensiveOptions ya
-- guardado en el momento de analyze-report queda con las entradas viejas
-- (verificado en real: 44 entradas en 32 registros, ej. Dewerland (Arms)
-- con Shield Block/Defensive Stance, Linkedara (Holy) con Dispersion,
-- Ayriane (Havoc) con Demon Spikes — exactamente el bug reportado). Se
-- eliminan del array esas entradas concretas cuando el spec real del
-- jugador no coincide con el spec exigido — mismo principio que la
-- migración de \"99.8% de defensivos atribuidos mal\" de antes en esta sesión
-- (corregir el dato ya guardado, no solo el código de aquí en adelante).

with req(spell_id, required_spec) as (
  values (203720,''Vengeance''),(204021,''Vengeance''),(235313,''Fire''),(11426,''Frost''),
         (235450,''Arcane''),(386208,''Protection''),(190456,''Protection''),(2565,''Protection''),
         (47585,''Shadow'')
),
to_fix as (
  select r.id,
    (
      select jsonb_agg(opt) from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
      where not exists (
        select 1 from req where req.spell_id = (opt->>''spellId'')::int and r.spec is distinct from req.required_spec
      )
    ) as filtered
  from player_pull_records r
  where r.death_cause is not null
    and exists (
      select 1 from jsonb_array_elements(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) opt
      join req on req.spell_id = (opt->>''spellId'')::int
      where r.spec is distinct from req.required_spec
    )
)
update player_pull_records r
set death_cause = jsonb_set(r.death_cause, ''{defensiveOptions}'', coalesce(to_fix.filtered, ''[]''::jsonb))
from to_fix
where r.id = to_fix.id"}', 'backfill_cooldown_catalog_spec_gaps', NULL, NULL, NULL),
	('20260824140000', '{"-- §\"informe de la noche... darle una vuelta... qué podemos poner que sea
-- real y sin inventar\" (feedback real, 2026-08-24): un informe DETERMINISTA
-- (sin LLM, cero riesgo de invención) generado bajo demanda y cacheado por
-- noche — \"Generar informe\" lo calcula y guarda, \"Ver informe\" abre el
-- último guardado, \"Actualizar\" lo recalcula. Distinto del informe de IA
-- (night_briefs) que ya existe — ese sigue narrando con matices; este es
-- puramente números/porcentajes reales agregados, sin interpretación.
create table if not exists night_full_reports (
  report_code text primary key references reports(code) on delete cascade,
  report jsonb not null,
  generated_at timestamptz not null default now()
)","alter table night_full_reports enable row level security","create policy \"read all - night_full_reports\" on night_full_reports for select using (true)"}', 'night_full_reports', NULL, NULL, NULL),
	('20260825160000', '{"-- Resolución práctica y contrastada de cada mecánica. Se mantiene separada
-- tanto de la descripción del Journal (qué hace) como de expected_response
-- ({type, scope}, contrato interno): este texto explica a los raiders cómo
-- ejecutar la mecánica en este boss+dificultad concreta.
alter table boss_mechanics_candidates
  add column if not exists resolution text,
  add column if not exists resolution_sources jsonb not null default ''[]''::jsonb,
  add column if not exists resolution_verified_at timestamptz","comment on column boss_mechanics_candidates.resolution is
  ''Cómo resolver la mecánica en este boss+dificultad, investigado mediante el flujo manual de IA. Solo classify-mechanics lo guarda tras validar dos fuentes independientes.''","comment on column boss_mechanics_candidates.resolution_sources is
  ''URLs públicas que respaldan resolution. classify-mechanics exige al menos dos URLs válidas de dominios distintos antes de persistirla.''","comment on column boss_mechanics_candidates.resolution_verified_at is
  ''Momento en que classify-mechanics validó y guardó la resolución con sus fuentes.''"}', 'mechanic_resolution', NULL, NULL, NULL),
	('20260825180000', '{"-- Quién tiene la acción principal para resolver una mecánica. El dato vive
-- tanto en el manifiesto editorial como en los eventos ya analizados para
-- que los informes puedan agregar señales sin reinterpretar la categoría.
alter table boss_mechanics_candidates
  add column if not exists responsibility text
    check (responsibility in (''tank'', ''dps'', ''healer'', ''raid'', ''personal''))","alter table pull_mechanic_events
  add column if not exists responsibility text
    check (responsibility in (''tank'', ''dps'', ''healer'', ''raid'', ''personal''))","comment on column boss_mechanics_candidates.responsibility is
  ''Responsable principal de resolver la mecánica: tank, dps, healer, raid o personal.''","comment on column pull_mechanic_events.responsibility is
  ''Snapshot de la responsabilidad editorial vigente al analizar o reclasificar la mecánica.''","comment on column boss_mechanics_candidates.resolution_sources is
  ''Obsoleto desde prompt v4. Se conserva para compatibilidad histórica; las fuentes generales de ai_classification respaldan también resolution.''"}', 'mechanic_responsibility', NULL, NULL, NULL),
	('20260825200000', '{"-- Un wipe call tiene un instante de inicio, no invalida el pull completo.
-- Los datos ya analizados guardaban wipe_call_cluster solo en el pile-on, por
-- lo que su primera muerte marcada permite reconstruir el límite histórico.
update pulls p
set wipe_call_signals = jsonb_set(
  p.wipe_call_signals,
  ''{wipeCallStartMs}'',
  to_jsonb(boundary.start_ms),
  true
)
from (
  select pull_id, min((death_cause->>''timeMs'')::numeric) as start_ms
  from player_pull_records
  where wipe_call_cluster
    and death_cause is not null
    and jsonb_typeof(death_cause->''timeMs'') = ''number''
  group by pull_id
) boundary
where p.id = boundary.pull_id
  and p.wipe_call_signals is not null
  and not (p.wipe_call_signals ? ''wipeCallStartMs'')","-- En datos históricos el detector solo marcaba el grupo compacto que había
-- permitido reconocer el wipe. El límite reconstruido es la fuente de verdad:
-- todas las muertes desde ese instante son cierre del try, aunque llegasen
-- varios segundos después del grupo inicial.
update player_pull_records r
set wipe_call_cluster = true
from pulls p
where p.id = r.pull_id
  and p.wipe_call_excluded
  and p.wipe_call_signals is not null
  and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
  and r.died
  and r.death_cause is not null
  and jsonb_typeof(r.death_cause->''timeMs'') = ''number''
  and (r.death_cause->>''timeMs'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
  and not r.wipe_call_cluster","-- Backfill conservador: Melee sobre un no-tank después de que al menos un
-- tank haya muerto en ese wipe. Los análisis nuevos además verifican que la
-- fuente del daño sea el actor del boss y que no haya otro daño mezclado.
with first_tank_death as (
  select r.pull_id, min((r.death_cause->>''timeMs'')::numeric) as time_ms
  from player_pull_records r
  where r.died
    and r.death_cause is not null
    and r.spec in (''Blood'', ''Vengeance'', ''Guardian'', ''Brewmaster'', ''Protection'')
    and jsonb_typeof(r.death_cause->''timeMs'') = ''number''
  group by r.pull_id
)
update player_pull_records r
set death_cause = jsonb_set(r.death_cause, ''{statisticalExclusionReason}'', ''\"boss_melee_on_non_tank\"''::jsonb, true)
from first_tank_death tank_death, pulls p
where r.pull_id = tank_death.pull_id
  and p.id = r.pull_id
  and coalesce(p.wipe_pct, 100) > 0
  and r.died
  and r.death_cause is not null
  and lower(coalesce(r.death_cause->>''mechanicName'', '''')) = ''melee''
  and coalesce(r.spec, '''') not in (''Blood'', ''Vengeance'', ''Guardian'', ''Brewmaster'', ''Protection'')
  and jsonb_typeof(r.death_cause->''timeMs'') = ''number''
  and (r.death_cause->>''timeMs'')::numeric >= tank_death.time_ms
  and coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''''","-- No se elimina la fila jugador+pull: hacerlo borraba también cualquier daño
-- evitable anterior al wipe call. Solo se neutralizan las señales que dependen
-- de la muerte; preparación y ejecución previa siguen siendo evaluables.
drop view if exists player_pull_reliability_inputs","create view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  case
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    then exists (
      select 1
      from pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and e.trigger_time_ms < (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
    )
    else r.avoidable_damage_taken > 0
  end as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    -- Un uso observado crea una muestra positiva aunque el pull fuese limpio.
    -- La ausencia solo se puntúa si hubo una oportunidad verificable: muerte
    -- con catálogo defensivo o daño evitable antes del límite del wipe call.
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (where (item->>''permanentEnchant'') is not null and (item->>''id'')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where (item->>''id'')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count
from player_pull_records r
join pulls p on p.id = r.pull_id","comment on view player_pull_reliability_inputs is
  ''Una fila por jugador+pull. La disciplina defensiva combina uso durante el try con respuesta al morir; un wipe call o Melee del boss sobre no-tank neutraliza solo señales posteriores/no accionables.''","-- Los patrones cross-boss tampoco deben incorporar eventos posteriores al
-- límite. Un evento anterior del mismo pull permanece y sigue contando.
drop view if exists player_mechanic_offenses","create view player_mechanic_offenses as
select
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  e.category,
  e.ability_id,
  e.mechanic_name,
  e.outcome,
  unnest(e.players_hit_names) as player_name
from pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category is not null
  and e.outcome <> ''clean''
  and array_length(e.players_hit_names, 1) > 0
  and not (
    p.wipe_call_excluded
    and p.wipe_call_signals is not null
    and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
  )","comment on view player_mechanic_offenses is
  ''Una fila por jugador golpeado por una mecánica fallada; excluye solo eventos desde wipeCallStartMs cuando el wipe call está activo.''"}', 'wipe_call_boundaries_and_non_actionable_deaths', NULL, NULL, NULL),
	('20260826100000', '{"-- Preparación de la season: enchants en cabeza/hombros/pecho/piernas/botas/
-- anillos; gemas en cuello/anillos. Los índices son los de CombatantInfo de
-- WCL (trinkets 12/13), no IDs de inventario de Blizzard.
--
-- También se separa la evidencia observada en logs públicos de la evidencia
-- de la guild para poder contrastar la aplicabilidad por dificultad.

alter table boss_mechanics_candidates
  add column if not exists observed_in_reference_logs boolean not null default false,
  add column if not exists official_difficulty_applicable boolean","comment on column boss_mechanics_candidates.observed_in_reference_logs is
  ''True cuando la habilidad se observó en uno o más logs públicos de referencia de esta dificultad exacta (cast, daño o interrupt). Evidencia para evitar mezclar dificultades.''","comment on column boss_mechanics_candidates.official_difficulty_applicable is
  ''True/false cuando las restricciones oficiales DB2 permiten/excluyen la habilidad en esta dificultad; null cuando DB2 no pudo resolverlo. No se borran filas ni ediciones manuales al excluir.''","update boss_mechanics_candidates
set observed_in_reference_logs = true
where coalesce(reference_occurrences, 0) > 0
   or observed_as_interrupt is true","-- Recupera también evidencia propia de pulls anteriores. El cruce es por
-- nombre porque el ability_id del Journal y el abilityGameID de WCL suelen
-- ser distintos; es el mismo contrato que usa analyze-report.
update boss_mechanics_candidates candidate
set observed_in_logs = true
where exists (
  select 1
  from pull_mechanic_events event
  join pulls pull on pull.id = event.pull_id
  where pull.boss_id = candidate.boss_id
    and pull.difficulty = candidate.difficulty
    and lower(trim(event.mechanic_name)) = lower(trim(candidate.name))
)","-- Una candidata es aplicable a la dificultad exacta cuando existe evidencia
-- positiva en ella, o cuando todavía no se ha podido contrastar. Solo se
-- excluye si el muestreo de esta dificultad sí se ejecutó, no encontró la
-- habilidad y otra dificultad del mismo boss sí aporta evidencia positiva.
-- La tabla base conserva todas las filas y su procedencia para poder auditar
-- la decisión; todas las lecturas que afectan a estadísticas usan esta vista.
create or replace view applicable_boss_mechanics_candidates
with (security_invoker = true) as
select candidate.*
from boss_mechanics_candidates candidate
where candidate.observed_in_logs is true
   or candidate.observed_in_reference_logs is true
   or candidate.observed_as_interrupt is true
   or coalesce(candidate.reference_occurrences, 0) > 0
   or exists (
     select 1
     from pull_mechanic_events event
     join pulls pull on pull.id = event.pull_id
     where pull.boss_id = candidate.boss_id
       and pull.difficulty = candidate.difficulty
       and lower(trim(event.mechanic_name)) = lower(trim(candidate.name))
   )
   or (
     candidate.official_difficulty_applicable is distinct from false
     and (
       candidate.reference_source_report is null
       or not exists (
         select 1
         from boss_mechanics_candidates other
         where other.boss_id = candidate.boss_id
           and other.ability_id = candidate.ability_id
           and other.difficulty <> candidate.difficulty
           and (
             other.observed_in_logs is true
             or other.observed_in_reference_logs is true
             or other.observed_as_interrupt is true
             or coalesce(other.reference_occurrences, 0) > 0
           )
       )
     )
   )","comment on view applicable_boss_mechanics_candidates is
  ''Mecánicas aplicables por boss+dificultad tras contrastar evidencia oficial, de la guild y de logs públicos. Evita que filas conservadas para auditoría contaminen análisis y estadísticas.''","create or replace view applicable_pull_mechanic_events
with (security_invoker = true) as
select event.*
from pull_mechanic_events event
join pulls pull on pull.id = event.pull_id
where not exists (
    select 1
    from boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  )
  or exists (
    select 1
    from applicable_boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  )","comment on view applicable_pull_mechanic_events is
  ''Eventos históricos cuya mecánica sigue siendo aplicable al boss+dificultad. Las filas sin candidata asociada se conservan de forma conservadora.''","drop view if exists player_pull_reliability_inputs","create view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count
from player_pull_records r
join pulls p on p.id = r.pull_id","comment on view player_pull_reliability_inputs is
  ''Una fila por jugador+pull. Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11); disciplina defensiva y exclusiones respetan wipeCallStartMs.''","drop view if exists player_mechanic_offenses","create view player_mechanic_offenses as
select
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  e.category,
  e.ability_id,
  e.mechanic_name,
  e.outcome,
  unnest(e.players_hit_names) as player_name
from applicable_pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category is not null
  and e.outcome <> ''clean''
  and array_length(e.players_hit_names, 1) > 0
  and not (
    p.wipe_call_excluded
    and p.wipe_call_signals is not null
    and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
  )","comment on view player_mechanic_offenses is
  ''Una fila por jugador golpeado por una mecánica fallada y aplicable a la dificultad; excluye eventos posteriores a wipeCallStartMs.''"}', 'preparation_slots_and_difficulty_evidence', NULL, NULL, NULL),
	('20260826110000', '{"-- Recalcula de forma no destructiva los perfiles históricos que ya guardan
-- la secuencia de daño. No existe maxHitPoints en esos JSON antiguos, así
-- que solo se eleva a burst cuando >=80% de todo el daño de los 5s finales
-- está concentrado en el último segundo; nunca se rebaja un burst existente.

with historical_profiles as (
  select
    record.id,
    sum(coalesce((hit->>''amount'')::numeric, 0)) as window_damage,
    sum(coalesce((hit->>''amount'')::numeric, 0)) filter (
      where coalesce((hit->>''time_ms'')::numeric, 0)
        >= coalesce((record.death_cause->>''timeMs'')::numeric, 0) - 1000
    ) as terminal_burst_damage
  from player_pull_records record
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(record.death_cause->''damageWindowEvents'') = ''array''
      then record.death_cause->''damageWindowEvents''
      else ''[]''::jsonb
    end
  ) hit
  where record.death_cause is not null
  group by record.id
), classified as (
  select
    id,
    window_damage,
    coalesce(terminal_burst_damage, 0) as terminal_burst_damage,
    window_damage > 0 and coalesce(terminal_burst_damage, 0) / window_damage >= 0.8 as temporal_burst
  from historical_profiles
)
update player_pull_records record
set death_cause = record.death_cause || jsonb_build_object(
  ''damageProfile'', case
    when classified.temporal_burst then ''burst''
    else coalesce(record.death_cause->>''damageProfile'', ''unknown'')
  end,
  ''terminalBurstDamage'', classified.terminal_burst_damage,
  ''burstWindowMs'', 1000
)
from classified
where classified.id = record.id"}', 'oneshot_burst_window', NULL, NULL, NULL),
	('20260827090000', '{"-- §\"cuando se hace un ninja pull (un pull del boss por error) también
-- cuenta en la estadística de wipes... habría que clasificarlo de otra
-- manera para saberlo\" (feedback real): alguien engancha al boss sin que la
-- raid lo haya decidido -- corrió de más, se le fue el pull -- y WCL igual
-- crea una fight real: unos pocos segundos, casi nadie de la raid llegó a
-- entrar en combate. Hoy eso cuenta exactamente igual que un intento serio
-- en todas las estadísticas de wipes/intentos: sesión en vivo, histórico de
-- boss, fiabilidad, informe de noche.
--
-- Mismo principio que el wipe call (§3): no se borra la fila (conserva
-- duración/pull_number/contexto para quien quiera auditar qué pasó), solo
-- se excluye de las estadísticas que asumen que hubo un intento real.
-- is_ninja_pull guarda el veredicto de la heurística; ninja_pull_excluded
-- es la puerta que de verdad usan las vistas para filtrar -- hoy siempre
-- coincide con is_ninja_pull, pero separarlas deja sitio a un override
-- manual futuro (un raid lead corrigiendo un falso positivo) sin otra
-- migración, igual que wipe_call_confidence/wipe_call_excluded.
alter table pulls
  add column if not exists is_ninja_pull boolean not null default false,
  add column if not exists ninja_pull_excluded boolean not null default false,
  add column if not exists ninja_pull_signals jsonb","comment on column pulls.is_ninja_pull is
  ''Heurística en analyze-report: pull muy corto donde casi nadie de la raid llegó a entrar en combate -- probable enganche accidental, no un intento real.''","comment on column pulls.ninja_pull_excluded is
  ''Puerta real usada por las vistas para excluir de estadísticas de intentos/wipes. Por defecto igual a is_ninja_pull; queda separada para permitir corregir un falso positivo sin recalcular la heurística.''","comment on column pulls.ninja_pull_signals is
  ''Señales que motivaron el veredicto: durationMs, raidSize, engagedPlayerCount y engagedFraction (jugadores que murieron o recibieron daño durante el pull, sobre el total de la raid).''","-- Backfill conservador de datos ya analizados: no quedan los eventos de
-- daño crudos para releer sin reanalizar el report (igual que el backfill
-- de melee del §4.3), así que se aproxima \"se enganchó\" con las únicas
-- señales ya guardadas por jugador -- murió, o tiene dps/hps > 0 durante el
-- pull. Un kill nunca es ninja pull (igual que un kill nunca es wipe call:
-- si el boss murió, hubo un intento real).
with engagement as (
  select
    pull_id,
    count(*) as raid_size,
    count(*) filter (where died or coalesce(dps, 0) > 0 or coalesce(hps, 0) > 0) as engaged_count
  from player_pull_records
  group by pull_id
)
update pulls p
set
  is_ninja_pull = true,
  ninja_pull_excluded = true,
  ninja_pull_signals = jsonb_build_object(
    ''durationMs'', p.duration_ms,
    ''raidSize'', e.raid_size,
    ''engagedPlayerCount'', e.engaged_count,
    ''engagedFraction'', round((e.engaged_count::numeric / greatest(e.raid_size, 1)), 2)
  )
from engagement e
where e.pull_id = p.id
  and coalesce(p.wipe_pct, 100) > 0
  and p.duration_ms is not null
  and p.duration_ms < 15000
  and e.raid_size > 0
  and (e.engaged_count::numeric / e.raid_size) <= 0.3","-- Fiabilidad tampoco debe aprender de un pull que nunca fue un intento
-- real -- ni como \"pull limpio\" (nadie se enganchó, no que la ejecución
-- fuera perfecta) ni como muestra de preparación/defensivos. Mismo
-- contrato que la versión anterior de esta vista (20260826100000), con el
-- filtro de ninja pull añadido al final.
drop view if exists player_pull_reliability_inputs","create view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded","comment on view player_pull_reliability_inputs is
  ''Una fila por jugador+pull real (excluye ninja pulls). Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11); disciplina defensiva y exclusiones respetan wipeCallStartMs.''","-- Los patrones de ofensores repetidos tampoco deben aprender de un pull que
-- nunca fue un intento real.
drop view if exists player_mechanic_offenses","create view player_mechanic_offenses as
select
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  e.category,
  e.ability_id,
  e.mechanic_name,
  e.outcome,
  unnest(e.players_hit_names) as player_name
from applicable_pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category is not null
  and e.outcome <> ''clean''
  and array_length(e.players_hit_names, 1) > 0
  and not p.ninja_pull_excluded
  and not (
    p.wipe_call_excluded
    and p.wipe_call_signals is not null
    and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
  )","comment on view player_mechanic_offenses is
  ''Una fila por jugador golpeado por una mecánica fallada y aplicable a la dificultad, en un pull real (excluye ninja pulls). Excluye eventos posteriores a wipeCallStartMs.''"}', 'ninja_pull_detection', NULL, NULL, NULL),
	('20260827120000', '{"-- §\"WCL tiene fases de encuentro, importarlas e implementarlas en todos
-- los sitios donde corresponda\" (feedback real). Verificado por
-- introspección real contra la API de WCL (2026-08-27): ReportFight expone
-- `phaseTransitions { id startTime }`, `lastPhaseAsAbsoluteIndex` y
-- `lastPhaseIsIntermission`; Report expone `phases { encounterID
-- separatesWipes phases { id name isIntermission } }` con el nombre legible
-- de cada fase. No todos los bosses tienen fases (bosses de un solo golpe
-- devuelven null en los cuatro campos) -- eso es una fase única implícita,
-- no un fallo de ingesta.
alter table pulls
  add column if not exists phase_transitions jsonb,
  add column if not exists last_phase_absolute_index integer,
  add column if not exists last_phase_is_intermission boolean","comment on column pulls.phase_transitions is
  ''Lista cronológica de transiciones de fase observadas EN ESTE pull: [{id, startTime}]. id referencia boss_encounter_phases(boss_id, phase_id). Null = boss sin fases definidas en WCL.''","comment on column pulls.last_phase_absolute_index is
  ''Índice absoluto (0-based, cuenta fases normales + intermedios) de la fase en la que terminó el pull -- mejor proxy de progreso que wipe_pct en bosses donde el % de vida se reinicia por fase (ver boss_encounter_phases.separates_wipes).''","comment on column pulls.last_phase_is_intermission is
  ''true si el pull terminó durante un intermedio (p.ej. fase de adds/transición), no durante una fase de daño normal al boss.''","-- Metadata ESTÁTICA de fases por boss -- igual para todos los pulls de ese
-- encuentro, se sincroniza best-effort desde analyze-report (mismo patrón
-- que boss_reference_stats: nunca bloquea el análisis si WCL no la trae).
create table if not exists boss_encounter_phases (
  boss_id text not null,
  phase_id integer not null,
  name text not null,
  is_intermission boolean,
  -- \"Si las fases pueden usarse para separar wipes en la UI del report\"
  -- (descripción oficial de WCL) -- señal de que bossPercentage/fightPercentage
  -- pueden no ser comparables directamente entre fases de este boss.
  separates_wipes boolean,
  updated_at timestamptz not null default now(),
  primary key (boss_id, phase_id)
)","alter table boss_encounter_phases enable row level security","drop policy if exists \"read all - boss_encounter_phases\" on boss_encounter_phases","create policy \"read all - boss_encounter_phases\" on boss_encounter_phases for select using (true)","comment on table boss_encounter_phases is
  ''Nombre legible + metadata de cada fase de cada boss, sincronizado desde Report.phases de WCL en analyze-report. Referencia de solo lectura para la app; no depende de ningún pull concreto.''","-- Igual que pull_mechanic_events ya guarda trigger_time_ms del pull, guarda
-- en qué fase ocurrió -- permite filtrar/mostrar \"esto pasó en fase 2\" sin
-- recalcular phase_transitions cada vez que se lee.
alter table pull_mechanic_events
  add column if not exists phase_id integer","comment on column pull_mechanic_events.phase_id is
  ''Fase (boss_encounter_phases.phase_id) activa en el momento de trigger_time_ms. Null si el boss no tiene fases o el pull no trajo phase_transitions.''"}', 'encounter_phases_and_dispels', NULL, NULL, NULL),
	('20260827150000', '{"-- §\"pantalla nueva para clasificar defensivos (sustain, defensivo, absorb,
-- etc)... parecida a la de mecánicas de bosses pero para defensivos\"
-- (feedback real, con las 4 categorías definidas a mano por el usuario).
--
-- cooldown_catalog YA es la tabla base (§12.1, sincronizada desde el repo
-- real de WoWAnalyzer) y ya tiene una columna `category` — pero esa
-- responde a una pregunta distinta (\"personal/semi/external/utility\" = A
-- QUIÉN protege). survival_type responde a \"QUÉ le hace al daño que te
-- están metiendo\": mitigation (lo reduce antes de que llegue), absorption
-- (lo intercepta con un pool aparte), sustain (repara el HP ya perdido),
-- emergency (evita la muerte o dispara el margen de supervivencia). Son dos
-- ejes ortogonales — no se toca `category`, se añade uno nuevo al lado.
--
-- Mismo patrón exacto que boss_mechanics_candidates: valor confirmado a
-- mano (survival_type) separado de la sugerencia automática
-- (inferred_survival_type), con el razonamiento de la IA en
-- ai_classification y `reviewed` para marcar qué se ha revisado ya.
alter table cooldown_catalog
  add column if not exists survival_type text
    check (survival_type in (''mitigation'', ''absorption'', ''sustain'', ''emergency'')),
  add column if not exists inferred_survival_type text
    check (inferred_survival_type in (''mitigation'', ''absorption'', ''sustain'', ''emergency'')),
  add column if not exists ai_classification jsonb,
  add column if not exists reviewed boolean not null default false","comment on column cooldown_catalog.survival_type is
  ''Confirmado a mano (Ajustes > Defensivos) o aplicado desde una clasificación IA. Eje ortogonal a `category`: category = a quién protege (personal/semi/external/utility), survival_type = qué le hace al daño (mitigation = lo reduce, absorption = lo intercepta con un pool aparte, sustain = repara HP ya perdido, emergency = evita la muerte / dispara el margen de supervivencia).''","comment on column cooldown_catalog.inferred_survival_type is
  ''Sugerencia automática (IA) sin confirmar todavía — nunca pisa survival_type una vez confirmado a mano.''","comment on column cooldown_catalog.ai_classification is
  ''Razonamiento de la clasificación IA: {confidence, sources, notes, classifiedAt} — mismo contrato que boss_mechanics_candidates.ai_classification.''","comment on column cooldown_catalog.reviewed is
  ''true = un humano ha revisado esta fila en la pantalla de Defensivos, confirmada o no. No implica que TODAS las specs de la clase tengan este defensivo — eso depende de spec/talentos, ver cooldown_catalog.spec y el cruce real en defensive-cooldowns.ts.''"}', 'defensive_survival_type', NULL, NULL, NULL),
	('20260827180000', '{"-- §\"podemos quitar la dificultad LFR de ajustes, del prompt y de la
-- sincronización... no es relevante para nada y nos ahorrará unos tokens y
-- molestias\" (feedback real, 2026-08-27): la app ya deja de OFRECER LFR en
-- Ajustes/sync/prompt (ver STANDARD_DIFFICULTY_IDS en shared/format.util.ts
-- y el filtro .neq(''difficulty'',''LFR'') en classify-mechanics) — esto limpia
-- las filas que ya existían de antes, contrastado en real: 101 filas en
-- boss_mechanics_candidates y 4 en boss_reference_stats, cero pulls reales
-- de la guild en LFR (pulls.difficulty nunca lo tiene). Seguro de borrar:
-- ninguna otra tabla referencia estas filas por FK — pull_mechanic_events/
-- death_cause guardan una foto por NOMBRE en el momento de analizar el
-- pull, no un FK a boss_mechanics_candidates.
delete from boss_mechanics_candidates where difficulty = ''LFR''","delete from boss_reference_stats where difficulty = ''LFR''"}', 'drop_lfr_mechanics_data', NULL, NULL, NULL),
	('20260827190000', '{"-- §bug real reportado y contrastado en real (2026-08-27, boss 3445 \"Entombed
-- Sentinels\", feedback: \"es raro que en mítico no haya mecánicas que sí hay
-- en normal o hc\"): el mismo bug direccional que ya se arregló en el
-- frontend (difficulty-evidence.util.ts, isContradictedByOtherDifficulty) se
-- había quedado SIN arreglar aquí — esta vista es la que de verdad filtra
-- boss_mechanics_candidates para classify-mechanics, y en cascada para
-- applicable_pull_mechanic_events / player_mechanic_offenses /
-- player_pull_reliability_inputs (avoidable damage, fiabilidad por
-- jugador...), no solo para lo que se ve en Ajustes.
--
-- Antes: \"otra dificultad tiene evidencia y esta no\" excluía la fila SIN
-- IMPORTAR la dirección — así que Mítica podía perder una mecánica solo
-- porque Normal/Heroico ya la habían visto, exactamente al revés de cómo
-- funciona el diseño real de WoW (las dificultades más duras casi nunca
-- pierden mecánicas que ya existían en las más fáciles). Ahora solo cuenta
-- como pista de exclusividad la evidencia vista en una dificultad MÁS DURA.
create or replace view applicable_boss_mechanics_candidates
with (security_invoker = true) as
select candidate.*
from boss_mechanics_candidates candidate
where candidate.observed_in_logs is true
   or candidate.observed_in_reference_logs is true
   or candidate.observed_as_interrupt is true
   or coalesce(candidate.reference_occurrences, 0) > 0
   or exists (
     select 1
     from pull_mechanic_events event
     join pulls pull on pull.id = event.pull_id
     where pull.boss_id = candidate.boss_id
       and pull.difficulty = candidate.difficulty
       and lower(trim(event.mechanic_name)) = lower(trim(candidate.name))
   )
   or (
     candidate.official_difficulty_applicable is distinct from false
     and (
       candidate.reference_source_report is null
       or not exists (
         select 1
         from boss_mechanics_candidates other
         where other.boss_id = candidate.boss_id
           and other.ability_id = candidate.ability_id
           and other.difficulty <> candidate.difficulty
           and (
             other.observed_in_logs is true
             or other.observed_in_reference_logs is true
             or other.observed_as_interrupt is true
             or coalesce(other.reference_occurrences, 0) > 0
           )
           and (case other.difficulty when ''LFR'' then 1 when ''Normal'' then 3 when ''Heroic'' then 4 when ''Mythic'' then 5 else 0 end)
             > (case candidate.difficulty when ''LFR'' then 1 when ''Normal'' then 3 when ''Heroic'' then 4 when ''Mythic'' then 5 else 0 end)
       )
     )
   )","comment on view applicable_boss_mechanics_candidates is
  ''Mecánicas aplicables por boss+dificultad tras contrastar evidencia oficial, de la guild y de logs públicos. Una dificultad más fácil con evidencia NUNCA excluye una más dura (las dificultades duras no pierden mecánicas de las fáciles) — solo al revés. Evita que filas conservadas para auditoría contaminen análisis y estadísticas.''"}', 'applicable_candidates_difficulty_direction', NULL, NULL, NULL),
	('20260827200000', '{"-- §bug real contrastado en real (2026-08-27, al generar el informe de
-- noche fusionado): \"column applicable_pull_mechanic_events.phase_id does
-- not exist\" -- `select event.*` en la definición de una vista se EXPANDE
-- y se congela a la lista de columnas de la tabla base EN EL MOMENTO de
-- crear la vista. pull_mechanic_events.phase_id se añadió después (migración
-- 20260827120000_encounter_phases_and_dispels.sql) sin volver a ejecutar el
-- create or replace view de applicable_pull_mechanic_events (que sigue
-- siendo la misma que 20260826100000_preparation_slots_and_difficulty_evidence.sql
-- creó, cuando phase_id ni existía) -- la vista se quedó con la lista de
-- columnas vieja para siempre, aunque la tabla real ya tuviera la columna.
-- Volver a ejecutar EXACTAMENTE la misma definición basta para que Postgres
-- reexpanda event.* contra las columnas actuales -- no cambia ningún dato,
-- ninguna columna renombrada ni ninguna dependencia (applicable_pull_mechanic_events
-- sigue exportando las mismas columnas de siempre, más phase_id).
create or replace view applicable_pull_mechanic_events
with (security_invoker = true) as
select event.*
from pull_mechanic_events event
join pulls pull on pull.id = event.pull_id
where not exists (
    select 1
    from boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  )
  or exists (
    select 1
    from applicable_boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  )","comment on view applicable_pull_mechanic_events is
  ''Eventos históricos cuya mecánica sigue siendo aplicable al boss+dificultad. Las filas sin candidata asociada se conservan de forma conservadora. Recreada el 2026-08-27 para que event.* recoja phase_id (columna añadida después de la creación original de esta vista).''"}', 'refresh_applicable_pull_mechanic_events_view', NULL, NULL, NULL),
	('20260827210000', '{"-- §\"acercarnos lo más posible a wipefest... me gusta la idea de que no sea
-- un 0.35 fijo y sea variable\" (feedback real, 2026-08-27): Parte A del plan
-- de severidad variable — ver docs de la sesión. Wipefest puntúa contra una
-- muestra real (percentil), no un umbral fijo; a nuestra escala (una sola
-- guild) se adapta con 3 niveles de fallback: historial propio de Avoid
-- (kills), logs públicos de referencia (ya se traen, ver
-- sync-boss-mechanics), y el umbral fijo actual como último recurso.

-- Array de ratios (jugadores_golpeados / raidSize), uno por log público de
-- referencia donde apareció esta mecánica. Como mucho ~120 números (Mítico,
-- el caso más grande) — un array simple y ordenable, no buckets al estilo
-- Wipefest (esos están pensados para cientos de miles de puntos, no para
-- decenas). NO es lo mismo que reference_avg_players_hit, que es
-- intencionalmente una CUENTA ABSOLUTA para inferencia de categoría, no un
-- ratio (ver 20260822080000_derived_metrics_and_category_inference.sql).
alter table boss_mechanics_candidates
  add column if not exists reference_hit_ratio_samples jsonb","comment on column boss_mechanics_candidates.reference_hit_ratio_samples is
  ''Array de ratios (jugadores_golpeados/raidSize) por log público de referencia donde apareció esta mecánica — la muestra cruda para comparación de severidad tipo Wipefest. NULL/vacío hasta el próximo re-sync.''","-- Informativos, no sustituyen outcome (clean/partial_fail/fail) en ningún
-- sitio — ver resolveSeverity en _shared/mechanic-severity.ts.
alter table pull_mechanic_events
  add column if not exists comparison_source text
    check (comparison_source is null or comparison_source in (''own_history'', ''world_reference'', ''fixed_threshold'')),
  add column if not exists comparison_percentile numeric","comment on column pull_mechanic_events.comparison_source is
  ''De dónde salió el umbral usado para esta instancia: historial propio de Avoid (kills), logs públicos de referencia, o el umbral fijo de siempre como último recurso.''","comment on column pull_mechanic_events.comparison_percentile is
  ''Percentil de este ratio dentro de la muestra de comparison_source (0-100). NULL si comparison_source=fixed_threshold (sin muestra, no hay percentil que dar).''","-- §mismo bug real ya encontrado y documentado en
-- 20260827200000_refresh_applicable_pull_mechanic_events_view.sql: `select
-- event.*` en una vista se congela a la lista de columnas de la tabla base
-- EN EL MOMENTO de crearse — las 2 columnas nuevas de arriba no aparecerían
-- en applicable_pull_mechanic_events sin volver a ejecutar exactamente la
-- misma definición para forzar la re-expansión. No cambia ningún dato.
create or replace view applicable_pull_mechanic_events
with (security_invoker = true) as
select event.*
from pull_mechanic_events event
join pulls pull on pull.id = event.pull_id
where not exists (
    select 1
    from boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  )
  or exists (
    select 1
    from applicable_boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  )","comment on view applicable_pull_mechanic_events is
  ''Eventos históricos cuya mecánica sigue siendo aplicable al boss+dificultad. Las filas sin candidata asociada se conservan de forma conservadora. Recreada el 2026-08-27 para que event.* recoja comparison_source/comparison_percentile.''"}', 'variable_mechanic_severity', NULL, NULL, NULL),
	('20260827220000', '{"-- §Parte A del plan de severidad variable: nivel 1 (historial propio de
-- Avoid) necesita el RATIO (players_hit/raidSize) de cada instancia
-- histórica de una mecánica, en kills únicamente (mismo criterio que
-- Wipefest — comparan contra \"successful fights\", no contra el caos de
-- wipes tempranos). pull_mechanic_events.players_hit es una CUENTA
-- absoluta, no un ratio, y no hay una columna raid_size en pulls — el
-- tamaño de la raid para un pull histórico solo se puede derivar contando
-- player_pull_records de ese mismo pull. Vista en vez de repetir este join
-- a mano en analyze-report cada vez.
create or replace view own_mechanic_hit_ratios
with (security_invoker = true) as
select
  pme.pull_id,
  pme.ability_id,
  p.boss_id,
  p.difficulty,
  pme.players_hit,
  raid.raid_size,
  (pme.players_hit::numeric / nullif(raid.raid_size, 0)) as hit_ratio
from pull_mechanic_events pme
join pulls p on p.id = pme.pull_id
join lateral (
  select count(*) as raid_size
  from player_pull_records ppr
  where ppr.pull_id = pme.pull_id
) raid on true
where p.wipe_pct = 0
  -- category=''interrupt'' reutiliza players_hit como \"¿se resolvió?\" (0/1),
  -- no un conteo de golpes (ver comentario en PullMechanicEventRow,
  -- domain.ts) — su ratio no significaría nada aquí, y de todas formas los
  -- interrupts nunca pasan por resolveSeverity (analyze-report los resuelve
  -- clean/fail antes de llegar a esa lógica).
  and pme.category is distinct from ''interrupt''
  and raid.raid_size > 0","comment on view own_mechanic_hit_ratios is
  ''Ratio (players_hit/raidSize) de cada instancia histórica de mecánica, SOLO en pulls con kill (wipe_pct=0) — la muestra de nivel 1 (historial propio) para resolveSeverity en _shared/mechanic-severity.ts. raidSize derivado de player_pull_records porque pulls no guarda un tamaño de raid propio.''"}', 'own_mechanic_hit_ratios_view', NULL, NULL, NULL),
	('20260827230000', '{"-- §\"actualizar el binario de Mecánica para que use este mismo conteo
-- graduado en vez del sí/no actual, así Fiabilidad hereda la precisión sin
-- duplicar nada... esto parece bastante incongruente, un 77% de puntuación
-- de noche pero a la vez un 44 de fiabilidad en la noche\" (feedback real,
-- 2026-08-27, confirmado explícitamente por el usuario). had_avoidable_damage
-- es un EXISTS binario (¿tomó algo de daño evitable, de cualquier
-- categoría?); pullScore (night-player-summary.service.ts) cuenta CUÁNTAS
-- instancias de responsabilidad individual (avoidable-ground/spread/soak/
-- personal-target) falló de verdad (outcome<>''clean''), no solo si tomó
-- daño. Se añade la columna nueva SIN quitar had_avoidable_damage/
-- self_positioning_death (los niveles de fallback de fetchReliabilityInputs
-- en reliability.service.ts los siguen necesitando para despliegues a
-- medias) — puramente aditivo.
create or replace view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count,
  -- §nuevo, AL FINAL a propósito: Postgres exige que create-or-replace-view
  -- solo AÑADA columnas nuevas al final — insertarla en medio (como en el
  -- primer intento de esta migración) da \"cannot change name of view
  -- column\" porque desplaza posicionalmente todo lo de detrás. Mismo
  -- criterio que mechanicFails en night-player-summary.service.ts
  -- (PERSONAL_RESPONSIBILITY_CATEGORIES de pull-analysis.service.ts, deben
  -- mantenerse en el mismo listado a mano — módulos distintos, sin import
  -- compartido con SQL) — cuenta, no solo existencia.
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as personal_mechanic_fail_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded","comment on view player_pull_reliability_inputs is
  ''Una fila por jugador+pull real (excluye ninja pulls). Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11); disciplina defensiva y exclusiones respetan wipeCallStartMs. personal_mechanic_fail_count (2026-08-27) es la fuente graduada del eje Mecánica; had_avoidable_damage/self_positioning_death se conservan solo para los niveles de fallback de fetchReliabilityInputs.''"}', 'reliability_graduated_mechanic_count', NULL, NULL, NULL),
	('20260827240000', '{"-- §\"el baremo de preparación deberia medir los primeros pulls no los
-- ultimos, porque si en mitad de la raid te toca un objeto y te lo
-- equipas, es normal que ese item no tenga enchant o gema hasta el dia
-- siguiente, por lo que medir que tengas tu pj preparado con enchants y
-- gemas al inicio de la raid es mas correcto\" (feedback real, 2026-08-27).
-- computeReliabilityBreakdown (reliability.service.ts) pondera CADA pull
-- por recencia para los 3 ejes por pull -- para mecánica/defensiva eso es
-- justo lo que se quiere (la tendencia reciente pesa más), pero para
-- preparación es al revés: un loot que cae A MITAD de una noche es, por
-- diseño, imposible de encantar/engemar esa misma noche (nadie para a
-- mitad de raid a ir al herrero) -- promediar TODOS los pulls de la noche
-- penalizaba justo lo contrario de lo que debía, un jugador que mejora de
-- equipo a mitad de raid veía CAER su preparación esa noche cuando lo
-- único medible de verdad es si llegó preparado al PRIMER pull.
--
-- report_code + pull_number (nuevos aquí, al final por el mismo motivo de
-- siempre -- ver el comentario de personal_mechanic_fail_count en la
-- migración anterior, Postgres solo permite añadir columnas al final de un
-- create-or-replace-view) dejan que reliability.service.ts filtre, SOLO
-- para el eje Preparación, al primer pull de cada noche por jugador --
-- mecánica/defensiva/consistencia se quedan exactamente igual (cada pull
-- cuenta, ahí sí importa la tendencia reciente pull a pull).
create or replace view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as personal_mechanic_fail_count,
  -- §nuevo, AL FINAL (mismo motivo que siempre): permiten a
  -- reliability.service.ts encontrar \"el primer pull de esta noche para
  -- este jugador\" sin adivinar por closed_at -- pull_number ya es el
  -- contador secuencial real que asigna analyze-report al insertar.
  p.report_code,
  p.pull_number
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded","comment on view player_pull_reliability_inputs is
  ''Una fila por jugador+pull real (excluye ninja pulls). Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11) -- reliability.service.ts la calcula SOLO sobre el primer pull (min pull_number) de cada report_code por jugador (2026-08-27): un loot equipado a mitad de noche no puede llevar encantar/gema esa misma noche, así que promediar todos los pulls penalizaba justo lo contrario de lo que debía. Mecánica/defensiva sí usan todos los pulls (ahí la tendencia reciente pull a pull es la señal). disciplina defensiva y exclusiones respetan wipeCallStartMs. personal_mechanic_fail_count (2026-08-27) es la fuente graduada del eje Mecánica; had_avoidable_damage/self_positioning_death se conservan solo para los niveles de fallback de fetchReliabilityInputs.''"}', 'reliability_preparation_first_pull', NULL, NULL, NULL),
	('20260827250000', '{"-- §\"hay muchos que estan al 99.8% o 100% incluso el try, eso es obviamente
-- un ninja pull y no deberia contar para ninguna estadistica ni metrica, ni
-- aunque se quede al 96%, si el combate dura menos de 40-50 segundos y a
-- penas le baja la vida, es un ninja pull o un wipe call y deberia
-- excluirse\" (feedback real, 2026-08-27) -- caso real visto: \"The Coiled
-- Altar #6\", 16s de duración, wipe al 100%, NO se marcaba porque el umbral
-- de duración de entonces (15s) se quedaba justo por debajo.
--
-- Backfill del mismo espíritu que el de 20260827090000_ninja_pull_
-- detection.sql, con los criterios ya ampliados en vivo en analyze-report/
-- index.ts (duración 15s -> 45s, más la señal nueva de \"al boss apenas le
-- bajó la vida\" -- wipe_pct >= 90, independiente de la fracción
-- enganchada). Solo AÑADE exclusiones, nunca las quita -- \"where not
-- p.ninja_pull_excluded\" dejará intacto cualquier pull que un RL ya haya
-- corregido a mano (ninja_pull_excluded=false a pesar de is_ninja_pull=true).
with engagement as (
  select
    pull_id,
    count(*) as raid_size,
    count(*) filter (where died or coalesce(dps, 0) > 0 or coalesce(hps, 0) > 0) as engaged_count
  from player_pull_records
  group by pull_id
)
update pulls p
set
  is_ninja_pull = true,
  ninja_pull_excluded = true,
  ninja_pull_signals = jsonb_build_object(
    ''durationMs'', p.duration_ms,
    ''raidSize'', e.raid_size,
    ''engagedPlayerCount'', e.engaged_count,
    ''engagedFraction'', round((e.engaged_count::numeric / greatest(e.raid_size, 1)), 2),
    ''bossHealthPct'', p.wipe_pct,
    ''barelyDamagedBoss'', coalesce(p.wipe_pct, 0) >= 90
  )
from engagement e
where e.pull_id = p.id
  and not p.ninja_pull_excluded
  and coalesce(p.wipe_pct, 100) > 0
  and p.duration_ms is not null
  and p.duration_ms < 45000
  and e.raid_size > 0
  and (
    (e.engaged_count::numeric / e.raid_size) <= 0.3
    or coalesce(p.wipe_pct, 0) >= 90
  )"}', 'ninja_pull_backfill_widened', NULL, NULL, NULL),
	('20260827260000', '{"-- El roster usaba player_mechanic_offenses como si players_hit_names fuese
-- siempre una lista de culpables. En realidad también contiene receptores de
-- daño inevitable de raid, tankbusters y jugadores alcanzados por la explosión
-- de otra persona. Eso producía decenas de falsos \"atascos constantes\".
--
-- Esta vista queda deliberadamente conservadora: solo crea una ofensa cuando
-- la clasificación confirma simultáneamente que el daño era evitable, la
-- responsabilidad era personal y la categoría identifica directamente a la
-- persona que permaneció en el suelo. Es preferible omitir una señal dudosa a
-- acusar a un jugador con evidencia que no permite atribuir responsabilidad.
create or replace view player_mechanic_offenses as
select
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  e.category,
  e.ability_id,
  e.mechanic_name,
  e.outcome,
  unnest(e.players_hit_names) as player_name
from applicable_pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category = ''avoidable-ground''
  and e.avoidable is true
  and e.responsibility = ''personal''
  and e.outcome <> ''clean''
  and array_length(e.players_hit_names, 1) > 0
  and not p.ninja_pull_excluded
  and not (
    p.wipe_call_excluded
    and p.wipe_call_signals is not null
    and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
  )","comment on view player_mechanic_offenses is
  ''Una fila por jugador con un fallo individual atribuible y repetible: solo zonas de suelo confirmadas como evitables y de responsabilidad personal. Excluye daño de raid, tankbusters, responsabilidad compartida, ninja pulls y eventos posteriores a wipeCallStartMs.''"}', 'actionable_player_mechanic_offenses', NULL, NULL, NULL),
	('20260828100000', '{"-- §\"dentro de roster... a mí (Pandokie) me dice que no he usado un
-- defensivo en Coiled Altar pull 7, pero la realidad es que eso es un wipe
-- call... esto aplica a varias partes de la app y varios raiders\" (feedback
-- real, 2026-08-28): el arreglo de detectWipeCall y el backfill de
-- reanalyze-wipe-call SÍ corrigieron el dato en player_pull_reliability_inputs
-- (verificado contra el pull real), pero roster-snapshot-cache.service.ts
-- guarda un snapshot en localStorage y solo lo invalida si cambió el último
-- pull, el último report o el roster de wowaudit — una corrección
-- RETROACTIVA sobre un pull antiguo (wipe call reanalizado, editado a mano,
-- ninja pull revertido) no mueve ninguna de esas tres señales, así que el
-- snapshot cacheado se queda desactualizado indefinidamente aunque la base
-- de datos ya esté bien. `updated_at` es la señal que faltaba: se bumpea en
-- cada corrección posterior a la inserción inicial (reanalyze-wipe-call,
-- set-wipe-call-status, set-ninja-pull-status) y el fingerprint del roster
-- ahora también mira el más reciente.
alter table pulls add column if not exists updated_at timestamptz not null default now()","-- Backfill: closed_at (no el now() que puso el DEFAULT de arriba al recién
-- añadir la columna) para no invalidar de golpe todos los snapshots
-- cacheados existentes por una migración que en sí misma no cambia ningún
-- dato observable. Justo después del ALTER, TODAS las filas tienen el mismo
-- valor puesto por el DEFAULT — pisarlo aquí sin condición es seguro.
update pulls set updated_at = closed_at","comment on column pulls.updated_at is
  ''Última vez que se corrigió algo de este pull DESPUÉS de la inserción inicial (reanalyze-wipe-call, set-wipe-call-status, set-ninja-pull-status) — no se toca en la inserción original (para eso ya está created_at/closed_at). Es la señal que consume roster-snapshot-cache.service.ts para saber si un snapshot cacheado sigue siendo válido tras una corrección retroactiva.''"}', 'pulls_updated_at_cache_invalidation', NULL, NULL, NULL),
	('20260828110000', '{"-- §\"quiero que la puntuación que traigas, parecida a wipefest, sea
-- consistente en realidad, más que intentar calcarlo... para eso tenemos
-- que contemplar muchas posibilidades distintas\" (feedback real,
-- 2026-08-28): personal_mechanic_fail_count penaliza con el mismo -25%
-- fijo tanto a quien falló su ÚNICA oportunidad de esquivar una zona en el
-- suelo como a quien falló 1 de 15 -- un ratio real (instancias
-- esquivadas/instancias elegibles) es más justo, PERO solo es honesto para
-- categorías donde \"te golpeó\" significa sin ambigüedad \"fallaste\":
--   - avoidable-ground/spread: sí, limpio -- elegible = seguía vivo en ese
--     instante, resultado binario (dentro de la zona o no).
--   - soak/personal-target: NO se toca -- en soak que te golpee suele ser
--     lo CORRECTO (alguien tiene que absorberlo) y no sabemos quién estaba
--     asignado; fingir un ratio ahí culparía a quien hizo lo que tenía que
--     hacer. Se quedan en personal_mechanic_fail_count (ya existe, sin
--     cambios) -- reliability.service.ts resta avoidable_mechanic_fail_count
--     de ahí para aislar el conteo plano de soak/personal-target sin
--     necesitar una columna nueva para eso.
--
-- \"elegible\" usa la muerte CRUDA (r.died/r.death_cause), no la ya corregida
-- por wipe call más arriba en la vista: si de verdad estabas inconsciente
-- en el suelo no podías esquivar nada, sin importar si ESA muerte concreta
-- luego se excluye de fiabilidad por ser wipe call -- son preguntas
-- distintas (\"¿podías moverte?\" vs. \"¿se te debe penalizar por morir?\").
create or replace view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as personal_mechanic_fail_count,
  p.report_code,
  p.pull_number,
  -- §nuevo, AL FINAL (mismo motivo de siempre -- Postgres solo permite
  -- añadir columnas al final). \"Elegible\" = seguía vivo (muerte CRUDA, no
  -- la corregida por wipe call de arriba) cuando se disparó una instancia
  -- avoidable-ground/spread no-limpia y no excluida por wipe call.
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and e.outcome <> ''clean''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_eligible_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_fail_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded","comment on view player_pull_reliability_inputs is
  ''Una fila por jugador+pull real (excluye ninja pulls). Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11) -- reliability.service.ts la calcula SOLO sobre el primer pull de cada report_code por jugador. Mecánica combina dos formas de contar: personal_mechanic_fail_count sigue siendo el conteo plano de las 4 categorías de responsabilidad individual (fuente de fallback y del eje soak/personal-target, restando avoidable_mechanic_fail_count) -- avoidable_mechanic_eligible_count/avoidable_mechanic_fail_count (2026-08-28) dan un ratio real solo para avoidable-ground/spread, donde \"te golpeó\" es sin ambigüedad un fallo. disciplina defensiva y exclusiones respetan wipeCallStartMs.''"}', 'reliability_avoidable_mechanic_ratio', NULL, NULL, NULL),
	('20260828120000', '{"-- §\"el baremo de defensiva de esta noche... 17%... no sé si hay alguna
-- inconsistencia de datos o bug real porque parece poco\" (feedback real,
-- 2026-08-28): investigado contra los datos reales de Pandokie. Encontrado
-- un hueco real: had_avoidable_damage y la tercera cláusula de
-- defensive_use_opportunity marcan \"oportunidad de defensivo\" con solo
-- `e.avoidable is true and damage_taken > 0` -- SIN comprobar
-- `e.outcome <> ''clean''`. Eso cuenta como \"deberías haber usado un
-- defensivo\" hasta el roce de una mecánica que estadísticamente salió
-- LIMPIA (dentro de lo normal comparado con el propio historial o la
-- referencia pública) -- exactamente lo que el propio comentario original
-- de defensive_use_opportunity decía que NO debía pasar: \"solo genera una
-- muestra negativa si hubo presión verificable\". avoidable_mechanic_
-- eligible_count/personal_mechanic_fail_count (eje Mecánica) ya exigían
-- outcome<>''clean'' desde el principio -- este era el único sitio que no lo
-- hacía, y por eso Defensiva podía verse mucho peor que Mecánica sin que
-- hubiera ningún fallo real de más detrás.
create or replace view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and e.outcome <> ''clean''
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as personal_mechanic_fail_count,
  p.report_code,
  p.pull_number,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and e.outcome <> ''clean''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_eligible_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_fail_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded","comment on column player_pull_reliability_inputs.had_avoidable_damage is
  ''true = recibió daño de una mecánica marcada avoidable Y esa instancia salió estadísticamente anómala (outcome<>clean, no un roce dentro de lo normal). Antes no exigía outcome<>clean -- inflaba el eje Defensiva contando rozes de mecánicas que salieron limpias como si fueran presión real (2026-08-28).''","comment on column player_pull_reliability_inputs.defensive_use_opportunity is
  ''true = hubo presión verificable para usar un defensivo -- cast propio, muerte con catálogo, o daño de una mecánica avoidable EN UNA INSTANCIA QUE SALIÓ ANÓMALA (outcome<>clean). Mismo criterio que personal_mechanic_fail_count/avoidable_mechanic_eligible_count -- antes la tercera cláusula no exigía outcome<>clean (2026-08-28).''"}', 'defensive_opportunity_requires_verified_fail', NULL, NULL, NULL),
	('20260828130000', '{"-- §\"un bot que crea canales privados dentro de una categoría... solo para
-- rango Raider, ni trial ni oficial\" (feedback real, 2026-08-28): la fuente
-- de verdad del roster ya existe (wowaudit_roster), pero WoWAudit no expone
-- ningún Discord ID (comprobado empíricamente contra la API real, con la key
-- normal Y con la de \"management\" — /v1/characters, /v1/attendance, /v1/team
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
)","insert into discord_roster_channels_settings (id) values (true) on conflict (id) do nothing","create table if not exists discord_roster_channels (
  character_id bigint primary key, -- id de wowaudit (wowaudit_roster.character_id), sin FK — ver comentario de arriba
  character_name text not null, -- snapshot del nombre en el momento de vincular/sincronizar, para el nombre del canal
  discord_user_id text not null,
  discord_display_name text, -- snapshot informativo (nick/username), se refresca en cada sync
  discord_channel_id text, -- null = todavía no elegible (Trial/oficial) o pendiente de la próxima sync
  is_officer boolean not null default false, -- reflejo del rol de Oficiales de Discord en el último sync — misma fuente que decide la visibilidad del canal
  linked_at timestamptz not null default now(),
  channel_synced_at timestamptz,
  updated_at timestamptz not null default now()
)","create index if not exists discord_roster_channels_channel_idx on discord_roster_channels (discord_channel_id)","alter table discord_roster_channels_settings enable row level security","create policy \"discord_roster_channels_settings is publicly readable\"
  on discord_roster_channels_settings for select
  using (true)","alter table discord_roster_channels enable row level security","create policy \"discord_roster_channels is publicly readable\"
  on discord_roster_channels for select
  using (true)"}', 'discord_roster_channels', NULL, NULL, NULL),
	('20260829010000', '{"-- §\"picos de daño... juntando ventanas de daño sufrido + defensivos que usa
-- y tiene disponible, excluyendo muertes, ninja pulls y wipe calls\" (feedback
-- real, 2026-08-29): hoy defensive_use_opportunity/used_defensive_in_pull
-- (ver 20260828120000) son booleanos por pull entero — \"¿hubo presión?
-- sí/no\", \"¿usó algo? sí/no\". No distinguen 8 ventanas de presión con 3
-- usos habiendo opción de cubrir las 8, de 1 ventana con 1 uso. Esta columna
-- guarda, por jugador y pull, CADA ventana de presión detectada (ver
-- supabase/functions/_shared/damage-pressure-windows.ts — diseño validado
-- empíricamente contra 3 pulls reales y 5 perfiles de clase/rol antes de
-- escribir esto) con su estado de cobertura real.
--
-- Se escribe en analyze-report para reports nuevos; el histórico ya
-- importado se rellena aparte (reanalyze-defensive-pressure, backfill
-- explícito) — null aquí significa \"todavía no reanalizado\", no \"sin
-- ventanas\" (mismo criterio que otras columnas de despliegue en dos tiempos
-- de este pipeline, ver reliability.service.ts LEGACY_RELIABILITY_COLUMNS).
alter table player_pull_records
  add column if not exists defensive_pressure_windows jsonb","comment on column player_pull_records.defensive_pressure_windows is
  ''Ventanas de presión detectadas en report.graph(DamageTaken) de este jugador en este pull (umbral relativo a su propia línea base, no un % fijo), cada una con su cobertura real (covered/coverable/options) evaluada con la misma fórmula de cooldown que death_cause.defensiveOptions. null = pull todavía no reanalizado con esta lógica (no \"sin ventanas\") — ver defensive-pressure-windows.ts y el backfill en reanalyze-defensive-pressure.''"}', 'defensive_pressure_windows', NULL, NULL, NULL),
	('20260829020000', '{"-- §\"no es lo mismo usar 0 defensivos que usarlo a destiempo, lo primero debe
-- penalizar mucho y lo segundo debe penalizar un poco pero guiar para
-- corregirlo\" (feedback real, 2026-08-29): el eje defensiva de Fiabilidad
-- hoy usa defensive_use_opportunity/used_defensive_in_pull — booleanos por
-- pull entero (ver 20260828120000), sin distinguir \"no tocó nada en toda la
-- noche\" de \"usó algo, pero no en el momento de presión real\". Con
-- defensive_pressure_windows ya calculado y con backfill completo (ver
-- conversación real, 2026-08-29) se puede contar de verdad en vez de un
-- sí/no. Se AÑADEN columnas nuevas a la vista — used_defensive_in_pull/
-- defensive_use_opportunity se dejan tal cual (otros consumidores, ver
-- pullScore en night-player-summary.service.ts, siguen leyéndolas).
--
-- defensive_window_used_anything: igual criterio que used_defensive_in_pull
-- (cast real, antes del wipe call si lo hay) pero derivado de defensive_casts
-- directamente — \"¿tocó ALGO de su catálogo en toda la noche?\", sin mirar
-- si acertó la ventana. Es la señal que distingue \"nunca lo intentó\" de
-- \"lo intentó a destiempo\" cuando covered_count sale en 0 en ambos casos.
create or replace view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and e.outcome <> ''clean''
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as personal_mechanic_fail_count,
  p.report_code,
  p.pull_number,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and e.outcome <> ''clean''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_eligible_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_fail_count,
  -- §\"no es lo mismo usar 0 defensivos que usarlo a destiempo\" (feedback
  -- real, 2026-08-29): AÑADIDAS al final a propósito — CREATE OR REPLACE VIEW
  -- solo permite añadir columnas al final, no insertarlas en medio (Postgres
  -- las trata por posición); insertarlas donde conceptualmente \"encajan\" con
  -- las demás de defensiva rompía el replace (columnas ya existentes abajo
  -- se re-numeran). Ver comentarios de columna al final del archivo.
  (
    select coalesce(count(*) filter (where (w->>''coverable'')::boolean), 0)
    from jsonb_array_elements(coalesce(r.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where not (
      p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      and (w->>''startMs'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
    )
  ) as defensive_window_coverable_count,
  (
    select coalesce(count(*) filter (where (w->>''covered'')::boolean), 0)
    from jsonb_array_elements(coalesce(r.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where not (
      p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      and (w->>''startMs'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
    )
  ) as defensive_window_covered_count,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as defensive_window_used_anything,
  r.defensive_pressure_windows
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded","comment on column player_pull_reliability_inputs.defensive_window_coverable_count is
  ''Nº de ventanas de presión reales (ver defensive-pressure-windows.ts) donde había al menos un defensivo disponible (excluyendo \"emergency\" sin usar) y no se cubrió — el conteo real que sustituye al booleano defensive_use_opportunity para el eje Defensiva. 0 si el pull no tiene ventanas evaluables (backfill pendiente o sin presión real).''","comment on column player_pull_reliability_inputs.defensive_window_covered_count is
  ''De esas mismas ventanas, cuántas SÍ tuvieron un defensivo activo o casteado dentro de la ventana. covered_count/coverable_count es el ratio real de cobertura de esta noche/pull — no un sí/no.''","comment on column player_pull_reliability_inputs.defensive_window_used_anything is
  ''§\"no es lo mismo usar 0 defensivos que usarlo a destiempo\" (feedback real, 2026-08-29): true si lanzó CUALQUIER defensivo de su catálogo en algún momento del pull, sin mirar si acertó la ventana. Distingue \"nunca lo intentó\" (false, penaliza fuerte) de \"lo intentó pero mal sincronizado\" (true con covered_count=0, penaliza poco y debe guiar con las ventanas concretas).''"}', 'reliability_defensive_windows', NULL, NULL, NULL),
	('20260829030000', '{"-- §\"la raid debe hacerlo, lo que pasa que no marca a nadie a propósito para
-- hacerlo y es el RL quien lo dice o la propia voluntad del raider\" (feedback
-- real, 2026-08-29): mecánicas donde CUALQUIER jugador elegible puede actuar
-- (coger un huevo, un orbe, usar un pez) sin que WCL/el Journal asigne un
-- responsable fijo. Distinto de MechanicCategory (que clasifica peligros a
-- evitar/responder) — esto es un catálogo aparte para acciones de utilidad
-- que SUMAN, nunca restan. Verificado empíricamente contra un log real
-- (Lvp1VCbzmwTRHdQ7) antes de escribir el esquema: huevos de Ula''tek y orbe
-- de Altar son NPCs interactuables (nunca aparecen en
-- applicable_boss_mechanics_candidates, que es 100% Journal — el Journal no
-- documenta objetos del suelo, solo hechizos del boss), mientras que el pez
-- de Lost Explorers es un cast real del jugador con dos IDs de WCL distintos
-- (uno es el estado del propio objeto, el otro — 1296535 — el cast real de
-- Smöll usándolo).
create table if not exists unassigned_mechanic_catalog (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  -- Exactamente uno de los dos debe venir relleno según detection_type:
  -- ability_id para ''cast''/''debuff_applied''/''buff_applied'' (un hechizo real
  -- de WCL), actor_name_pattern para ''npc_interaction'' (un NPC-objeto que no
  -- tiene ability_id propio, como \"Quivering Egg Cluster\").
  ability_id bigint,
  actor_name_pattern text,
  name text not null,
  detection_type text not null check (detection_type in (''cast'', ''debuff_applied'', ''buff_applied'', ''npc_interaction'')),
  -- Solo relevante para debuff_applied/buff_applied: quién aplica el efecto
  -- — un NPC/boss (caso típico al recoger algo) o el propio jugador
  -- (self-buff al usar un ítem). No se usa para filtrar detección, es
  -- documentación de qué evento buscar.
  applied_by text check (applied_by in (''npc'', ''self'')),
  -- §\"la mayoria de estas mecanicas solo afecta a dps\" (feedback real,
  -- 2026-08-29): informativo únicamente — NUNCA filtra qué cuenta como
  -- ocurrencia real (si un healer o un tank la resuelve igual, cuenta igual;
  -- es más meritorio, no menos, por salirse de lo esperado de su rol).
  eligible_roles text[],
  -- Id de la consecuencia (ej. la explosión del orbe, Fishy Feedback) si se
  -- conoce — solo para poder relacionarlas en la UI, nunca se usa para
  -- detectar quién hizo la acción.
  consequence_ability_id bigint,
  reviewed boolean not null default false,
  ai_confidence text,
  ai_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unassigned_mechanic_has_target check (ability_id is not null or actor_name_pattern is not null),
  constraint unassigned_mechanic_unique unique nulls not distinct (boss_id, difficulty, ability_id, actor_name_pattern)
)","comment on table unassigned_mechanic_catalog is ''Mecánicas de un boss donde cualquier jugador elegible puede actuar (sin asignación fija) y la raid sufre si nadie lo hace — coger/usar/depositar algo. Premia, nunca penaliza: no hay responsable individual claro a quien culpar si no se hace.''","-- §\"ese orbe concreto al cogerlo, deja un debuffo que luego expira asi que
-- se puede contabilizar\" (feedback real, 2026-08-29): a nivel de PULL, no de
-- jugador — es intrínsecamente un evento de raid (cualquiera puede ser quien
-- lo haga), igual que ya vive raid_damage_taken_series en pulls y no en
-- player_pull_records.
alter table pulls add column if not exists unassigned_mechanic_occurrences jsonb","comment on column pulls.unassigned_mechanic_occurrences is ''Array de {catalogId, mechanicName, actorId, actorName, timestampMs} — quién resolvió cada mecánica sin asignar de este pull, calculado por analyze-report/reanalyze-unassigned-mechanics contra unassigned_mechanic_catalog.''","-- §\"buscar si hay mas combates con mecanicas similares\" (feedback real,
-- 2026-08-29): los 3 casos verificados contra un log real antes de escribir
-- esta migración (Lvp1VCbzmwTRHdQ7) — el resto de bosses de este tier
-- quedan pendientes de confirmar (ver conversación: Soulcoil Well/Surging
-- Totem/Amani Ghost Stalker se descartaron con evidencia real de que NO son
-- este patrón; Toxin Cloud Stalker/Fountain Stalker quedan \"probablemente no\"
-- sin cerrar del todo, por si resultan ser de Heroico/Mítico).
insert into unassigned_mechanic_catalog (boss_id, difficulty, actor_name_pattern, name, detection_type, applied_by, eligible_roles, reviewed, ai_notes)
values
  (''3492'', ''Normal'', ''Quivering Egg Cluster'', ''Huevos de Ula''''tek (racimo)'', ''npc_interaction'', ''self'', array[''Melee'', ''Ranged''], true, ''Verificado contra Lvp1VCbzmwTRHdQ7 — NPC real en masterData.actors. Guía Wowhead: \"Pick up and break Ula''''tek''''s Eggs to avoid an Empowered Add\".''),
  (''3492'', ''Normal'', ''Squirming Egg'', ''Huevos de Ula''''tek (individual)'', ''npc_interaction'', ''self'', array[''Melee'', ''Ranged''], true, ''Verificado contra Lvp1VCbzmwTRHdQ7 — NPC real en masterData.actors.''),
  (''3492'', ''Normal'', ''Doomscale Egg'', ''Huevo de Doomscale (Fase 2)'', ''npc_interaction'', ''self'', array[''Melee'', ''Ranged''], true, ''Verificado contra Lvp1VCbzmwTRHdQ7 — NPC real en masterData.actors. Guía: \"one player should pick up the Doomscale Egg in the back of the room\".'')
on conflict do nothing","insert into unassigned_mechanic_catalog (boss_id, difficulty, actor_name_pattern, name, detection_type, applied_by, eligible_roles, reviewed, ai_notes)
values
  (''3429'', ''Normal'', ''Coalesced Venom Stalker'', ''Orbe de veneno coalescido'', ''npc_interaction'', ''self'', array[''Melee'', ''Ranged''], true, ''Verificado contra Lvp1VCbzmwTRHdQ7 — NPC real (2 instancias) en masterData.actors. Guía Wowhead: \"Pick up Coalesced Venom and drop them at an assigned point.\"'')
on conflict do nothing","insert into unassigned_mechanic_catalog (boss_id, difficulty, ability_id, name, detection_type, applied_by, eligible_roles, reviewed, ai_notes)
values
  (''3497'', ''Normal'', 1296535, ''Pez asqueroso (Disgusting Fish)'', ''cast'', ''self'', array[''Melee'', ''Ranged''], true, ''Verificado contra Lvp1VCbzmwTRHdQ7, fight 21 — Cast real de Smöll (sourceID jugador). Ability 1292490 (mismo nombre) es el estado del propio objeto (applybuff/removebuff sourceID=targetID=NPC), no la acción del jugador — no usar ese id.'')
on conflict do nothing"}', 'unassigned_mechanics', NULL, NULL, NULL),
	('20260829040000', '{"-- §verificación real contra Lvp1VCbzmwTRHdQ7 (todos los pulls reales de
-- Ula''tek [41,42,43, incluye el kill] y del Altar [37,38,39,40, incluye el
-- kill]): las 4 filas ''npc_interaction'' (3 huevos de Ula''tek + orbe del
-- Altar) dan CERO eventos en Casts/DamageDone/DamageTaken/Buffs/Debuffs/
-- Deaths, tanto de fuente como de objetivo, en TODOS los intentos reales del
-- report que las sembró — el propio kill incluido. También se buscó a mano
-- cualquier buff/debuff cuyo nombre sugiriera \"llevas el orbe/huevo\" (el
-- usuario dijo \"ese orbe concreto al cogerlo, deja un debuffo que luego
-- expira\" — feedback real, 2026-08-29): existe la habilidad \"Coalesced
-- Venom\" en masterData.abilities, pero NUNCA se aplica como buff/debuff real
-- en ninguno de los 4 intentos del Altar — coincide con lo ya documentado en
-- unassigned-mechanics.ts de que esa habilidad es la CONSECUENCIA de raid
-- (AoE) si nadie lo hace, no la marca de quién lo coge.
--
-- Conclusión honesta: recoger estos objetos probablemente sea una
-- interacción de cliente (tipo \"usar objeto del suelo\") sin ningún rastro en
-- el combat log de WCL — no es un fallo de la query, es un techo real de la
-- fuente de datos. La fila ''cast'' de Lost Explorers (Disgusting Fish, ability
-- 1296535) SÍ se verificó con una ocurrencia real (Smöll, pull real) antes de
-- escribir esta migración.
--
-- En vez de borrar la investigación (los actor_name_pattern siguen siendo
-- NPCs reales y correctos, y la clasificación del mecanismo del boss sigue
-- siendo cierta) se añade un interruptor explícito: solo las filas con
-- detección CONFIRMADA contra datos reales entran en el catálogo que usan
-- analyze-report/reanalyze-unassigned-mechanics — así una fila \"investigada
-- pero sin señal en WCL\" no se cuela silenciosamente como si funcionara.
alter table unassigned_mechanic_catalog add column if not exists has_confirmed_detection boolean not null default false","comment on column unassigned_mechanic_catalog.has_confirmed_detection is ''true solo si se ha visto al menos una ocurrencia real en datos de WCL de verdad (no solo \"el NPC/ability existe en masterData\") — analyze-report/reanalyze-unassigned-mechanics filtran por esto, para que una fila investigada-pero-sin-señal no aparente funcionar.''","update unassigned_mechanic_catalog
set has_confirmed_detection = true
where boss_id = ''3497'' and detection_type = ''cast'' and ability_id = 1296535","update unassigned_mechanic_catalog
set ai_notes = ai_notes || '' [2026-08-29: verificado contra TODOS los pulls reales de Lvp1VCbzmwTRHdQ7 incluyendo el kill — 0 eventos en Casts/DamageDone/DamageTaken/Buffs/Debuffs/Deaths para este actor. Probable interacción sin rastro en combat log. has_confirmed_detection=false hasta encontrar señal real.]''
where boss_id in (''3492'', ''3429'') and detection_type = ''npc_interaction''"}', 'unassigned_mechanics_confirmed_detection', NULL, NULL, NULL),
	('20260829050000', '{"-- §el usuario pasó una pista de ChatGPT sobre Coalesced Venom (Altar) con un
-- spell ID (1310005) que NO existe en el directorio de abilities del report
-- real — pero el NOMBRE que daba, \"Volatile Venom\", sí coincidía con algo
-- que ya había encontrado yo mismo antes y había descartado a ojo por el
-- nombre. Esta vez se verificó a fondo contra los 4 intentos reales de
-- Lvp1VCbzmwTRHdQ7 (fights 37/38/39/40, encounterID 3429) antes de tocar
-- nada:
--   - ability real: 1282419 \"Volatile Venom\" (NO 1282288, que da 0 en los 4
--     intentos, ni 1310005, que ni siquiera existe en este report).
--   - applydebuff/removedebuff casan 1:1 en los 3 intentos con tiempo para
--     que expire solo (38: 19/19, 39: 16/16, 40 kill: 44/44) — 0/0 en el
--     intento de 16s que apenas empezó, coherente, no un fallo de detección.
--   - duración real ~5000ms (4991-5025ms en la muestra) — exactamente lo
--     que describía la pista: \"el jugador recibe durante 5s el debuff\".
--   - fuente SIEMPRE el actor \"Zul''jan\" (NPC, el boss), nunca el propio
--     jugador — encaja con applied_by=''npc'', no ''self'' como tenía la fila
--     original.
--   - 8 a 18 jugadores reales distintos por intento, coherente con \"lo
--     recoge cualquiera, no está asignado a nadie en concreto\".
-- Conclusión: la fila ''npc_interaction'' original (actor_name_pattern=
-- ''Coalesced Venom Stalker'') modelaba el mecanismo equivocado — el pickup
-- real no se detecta por Casts/DamageDone contra el NPC-objeto, se detecta
-- por este debuff que aplica el BOSS. Se corrige la fila existente en vez de
-- crear una nueva (mismo boss+dificultad, es el mismo mecanismo real).
update unassigned_mechanic_catalog
set
  detection_type = ''debuff_applied'',
  ability_id = 1282419,
  actor_name_pattern = null,
  applied_by = ''npc'',
  has_confirmed_detection = true,
  ai_notes = ai_notes || '' [2026-08-29: CORREGIDO tras pista externa (ChatGPT, ID equivocado pero nombre correcto) — verificado contra los 4 intentos reales: ability real 1282419 \"Volatile Venom\", aplicada por el boss (Zul''''jan), ~5000ms de duración, apply/remove casan 1:1. detection_type pasa de npc_interaction a debuff_applied, applied_by de self a npc. has_confirmed_detection=true.]''
where boss_id = ''3429'' and detection_type = ''npc_interaction''"}', 'altar_orb_real_signal', NULL, NULL, NULL),
	('20260829060000', '{"-- §misma corrección que el orbe del Altar (migración 20260829050000), esta
-- vez para los huevos de Ula''tek: el usuario pasó otra pista de ChatGPT con
-- \"Malignant Shell\" (spell 1295360) — ESTE nombre coincide exactamente con
-- lo que el propio usuario había dicho de memoria al principio de esta
-- función (\"De ula''tek me refiero a la habilidad Malignant Shell\"), que en
-- su momento no se pudo confirmar. Verificado ahora a fondo contra los 3
-- intentos reales de Lvp1VCbzmwTRHdQ7 (fights 41/42/43, encounterID 3492,
-- kill incluido):
--   - 1295360 \"Malignant Shell\": SIEMPRE aplicado por el actor \"Ula''tek\"
--     (el propio boss, no un NPC-objeto suelto) — 13/14/21 aplicaciones en
--     los 3 intentos, sobre 13/11/15 jugadores distintos. Cubre TANTO el
--     huevo \"racimo\" (Quivering Egg Cluster) como el \"individual\"
--     (Squirming Egg) — son el mismo evento real de recogida, solo con
--     nombres narrativos distintos en el propio juego; un único debuff los
--     representa a los dos.
--   - 1300312 \"Doomscale Shell\": mismo patrón (fuente = Ula''tek), 0/1/2
--     aplicaciones — encaja con \"el huevo grande de fase 2, uno por
--     intento\" (0 en el intento 41 porque ese wipe no llegó a fase 2).
-- La fila ''individual'' (Squirming Egg) queda REDUNDANTE — el mismo evento
-- real que ya cubre la fila ''racimo'' una vez corregida a debuff_applied, no
-- dos mecanismos distintos — se borra en vez de dejarla viva sin usar,
-- para que el catálogo no tenga dos filas confirmadas apuntando al mismo
-- hecho real (contaría dos veces el mismo pickup si las dos quedaran
-- activas con detection_type distinto).
update unassigned_mechanic_catalog
set
  name = ''Huevo de Ula''''tek (Malignant Shell)'',
  detection_type = ''debuff_applied'',
  ability_id = 1295360,
  actor_name_pattern = null,
  applied_by = ''npc'',
  has_confirmed_detection = true,
  ai_notes = ai_notes || '' [2026-08-29: CORREGIDO tras pista externa (ChatGPT + memoria original del usuario, coincidían en el nombre) — verificado contra los 3 intentos reales: ability real 1295360 \"Malignant Shell\", aplicada por el boss (Ula''''tek), cubre tanto racimo como individual. detection_type pasa de npc_interaction a debuff_applied, applied_by de self a npc. has_confirmed_detection=true.]''
where id = ''b67e9dec-9c30-49dc-b2e2-8ec016a2dbd9''","update unassigned_mechanic_catalog
set
  detection_type = ''debuff_applied'',
  ability_id = 1300312,
  actor_name_pattern = null,
  applied_by = ''npc'',
  has_confirmed_detection = true,
  ai_notes = ai_notes || '' [2026-08-29: CORREGIDO — ability real 1300312 \"Doomscale Shell\", aplicada por el boss (Ula''''tek), verificado contra los 3 intentos reales (0/1/2, coherente con \"una vez por intento en fase 2\"). detection_type pasa de npc_interaction a debuff_applied, applied_by de self a npc. has_confirmed_detection=true.]''
where id = ''99ca1166-7bd1-40cd-91f5-2f743c35cc96''","delete from unassigned_mechanic_catalog where id = ''5f661c09-194d-4cc6-bb32-a87e52435118''"}', 'ulatek_eggs_real_signal', NULL, NULL, NULL),
	('20260829070000', '{"-- §\"si un jugador hace una mecanica ''voluntaria'' [...] vamos a decirlo y
-- subir su porcentaje de mecanicas por haberlo hecho con éxito\" (feedback
-- real, 2026-08-29): hasta ahora unassigned_mechanic_occurrences (ver
-- 20260829030000) solo alimentaba una tarjeta informativa en la infografía
-- (\"Mecánicas resueltas\"), nunca el eje Mecánica de verdad. Se añade UNA
-- columna nueva a player_pull_reliability_inputs — la vista que YA es la
-- fuente única de mechanicScoreFor (pull-analysis.service.ts), compartida
-- por Fiabilidad (reliability.service.ts, 60 días Y de la noche) y por
-- pullScore (night-player-summary.service.ts) — así el bonus llega a los
-- dos consumidores por el MISMO camino que ya evita que puedan divergir
-- (motivo original de esta vista: \"un 77% de puntuación de noche pero un 44
-- de fiabilidad\", feedback real 2026-08-27).
--
-- A propósito SIN el recorte por wipeCallStartMs que sí llevan
-- avoidable_mechanic_fail_count/personal_mechanic_fail_count más arriba en
-- esta vista: esas son PENALIZACIONES (se perdonan las que ocurren después
-- de que el RL ya cantó el wipe). Esto es un ACIERTO — mismo criterio ya
-- establecido para interrupts en night-player-summary.service.ts (\"un kick
-- conseguido sigue siendo un acierto real aunque el pull terminase en
-- wipe\"): hacer la mecánica extra sigue siendo mérito real aunque el intento
-- acabara mal. CREATE OR REPLACE VIEW solo permite añadir columnas al
-- final (ver comentario de 20260829020000) — se añade tras
-- defensive_window_used_anything.
create or replace view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and e.outcome <> ''clean''
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as personal_mechanic_fail_count,
  p.report_code,
  p.pull_number,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and e.outcome <> ''clean''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_eligible_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_fail_count,
  (
    select coalesce(count(*) filter (where (w->>''coverable'')::boolean), 0)
    from jsonb_array_elements(coalesce(r.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where not (
      p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      and (w->>''startMs'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
    )
  ) as defensive_window_coverable_count,
  (
    select coalesce(count(*) filter (where (w->>''covered'')::boolean), 0)
    from jsonb_array_elements(coalesce(r.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where not (
      p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      and (w->>''startMs'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
    )
  ) as defensive_window_covered_count,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as defensive_window_used_anything,
  r.defensive_pressure_windows,
  -- §\"subir su porcentaje de mecanicas por haberlo hecho con éxito\" — ver
  -- comentario de cabecera. Sin recorte de wipeCallStartMs a propósito
  -- (es un acierto, no una penalización que perdonar).
  (
    select count(*)
    from jsonb_array_elements(coalesce(p.unassigned_mechanic_occurrences, ''[]''::jsonb)) occ
    where occ->>''actorName'' = r.player_name
  ) as unassigned_mechanic_success_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded","comment on column player_pull_reliability_inputs.unassigned_mechanic_success_count is
  ''§\"vamos a decirlo y subir su porcentaje de mecanicas\" (feedback real, 2026-08-29): cuántas mecánicas sin asignar (ver unassigned_mechanic_catalog) resolvió ESTE jugador en ESTE pull — mechanicScoreFor lo suma como bonus (UNASSIGNED_MECHANIC_BONUS_PER_OCCURRENCE, capado por pull) al ratio/conteo de fallos, nunca lo resta. 0 si el pull no tuvo ninguna (catálogo sin filas confirmadas para ese boss, o nadie la resolvió) — nunca null, a diferencia de avoidable_mechanic_*, porque esta columna no depende de un backfill de otra función, ya vive en pulls desde que se creó la tabla.''"}', 'unassigned_mechanic_success_count', NULL, NULL, NULL),
	('20260829080000', '{"-- §hueco real encontrado al construir la UI de Ajustes para este catálogo
-- (2026-08-29): unassigned_mechanic_catalog se creó (20260829030000) sin
-- activar RLS — a diferencia de cooldown_catalog (mismo tipo de tabla:
-- catálogo de referencia editado a mano desde Ajustes), que sí tiene RLS +
-- una política de solo-lectura, dejando la escritura exclusivamente a
-- service_role (edge functions). Sin esto, cualquiera con la clave
-- publishable (la misma que ya lleva el frontend desplegado) podía
-- INSERT/UPDATE/DELETE directo contra esta tabla por REST, saltándose
-- save-unassigned-mechanic-edit por completo. Mismo patrón exacto que
-- cooldown_catalog.
alter table unassigned_mechanic_catalog enable row level security","create policy \"read all - unassigned_mechanic_catalog\"
  on unassigned_mechanic_catalog
  for select
  using (true)"}', 'unassigned_mechanic_catalog_rls', NULL, NULL, NULL),
	('20260829090000', '{"-- §\"vamos a preparar el login en este proyecto con discord, y que solo
-- puedan continuar el login los que tengan el rol de Oficial en mi
-- servidor\" (feedback real, 2026-08-29): Postgres no puede llamar a la API
-- de Discord desde una policy RLS, así que el resultado de \"es Oficial de
-- verdad ahora mismo\" se cachea aquí — lo escribe la Edge Function
-- verify-officer (service_role, tras consultar el bot de Discord contra
-- discord_roster_channels_settings.officers_role_id, MISMA fuente que ya
-- decide el badge de oficial del roster) justo después de cada login.
-- is_officer() es lo que consultará la migración de cierre de RLS
-- (20260829100000_lock_down_rls_to_officers.sql) en cada tabla.
create table if not exists user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  discord_user_id text not null,
  discord_username text,
  is_officer boolean not null default false,
  checked_at timestamptz not null default now()
)","alter table user_profiles enable row level security","-- El propio usuario puede leer SU fila (para que el frontend sepa si ya se
-- le denegó el acceso y por qué) — nunca la de otro, y sin insert/update
-- para authenticated: solo service_role (verify-officer) escribe aquí.
create policy \"user_profiles: cada usuario lee su propia fila\"
  on user_profiles for select
  using (auth.uid() = user_id)","create or replace function public.is_officer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_officer from user_profiles where user_id = auth.uid()),
    false
  );
$$"}', 'officer_auth', NULL, NULL, NULL),
	('20260829100000', '{"-- §\"proteger todos los datos y rutas salvo que esté logeado un oficial, el
-- resto no debería de poder ver nada\" (feedback real, 2026-08-29): hasta
-- ahora casi todas las tablas v2 tenían `for select using (true)` — lectura
-- pública total con solo la anon key (que va en el bundle desplegado). Se
-- reemplaza cada una de esas políticas por `using (is_officer())`
-- (ver 20260829090000_officer_auth.sql). No se toca insert/update/delete:
-- ninguna de estas tablas concede esas operaciones a anon/authenticated
-- hoy — las escrituras siguen siendo exclusivas de service_role (Edge
-- Functions), sin cambios de comportamiento ahí.
--
-- Se despliega DELIBERADAMENTE después de validar login + verify-officer +
-- el guard de las Edge Functions: si algo de esas piezas fallase, prefiero
-- que la app se quede en su estado actual (sin login) en vez de sin datos
-- para todo el mundo, oficiales incluidos.
do $$
declare
  t text;
  policy_name text;
  tables text[] := array[
    ''boss_mechanics'', ''boss_mechanics_candidates'', ''report_encounters'', ''reports'',
    ''pulls'', ''player_pull_records'', ''pull_briefs'', ''llm_calls'', ''session_state'',
    ''pull_mechanic_events'', ''cooldown_catalog'', ''boss_reference_stats'',
    ''known_raid_bosses'', ''wowaudit_season'', ''night_player_briefs'', ''night_briefs'',
    ''night_full_reports'', ''boss_encounter_phases'', ''unassigned_mechanic_catalog''
  ];
begin
  foreach t in array tables loop
    policy_name := ''read all - '' || t;
    -- §bug real encontrado en despliegue (2026-08-30): un nombre de
    -- política no es un literal de texto, es un identificador — %L lo
    -- entrecomillaba como cadena (''read all - boss_mechanics''), sintaxis
    -- inválida en la posición de nombre de política. %I es el formato
    -- correcto para identificadores (entrecomilla solo si hace falta, p.ej.
    -- por el espacio/guion del nombre). Esta migración nunca había llegado
    -- a aplicarse en remoto por este error — bloqueaba cualquier `db push`
    -- posterior.
    execute format(''drop policy if exists %I on %I'', policy_name, t);
    execute format(''create policy %I on %I for select using (is_officer())'', policy_name, t);
  end loop;
end $$","-- Estas tres tienen un nombre de política distinto (\"... is publicly readable\"), mismo tratamiento.
drop policy if exists \"talent_spell_lookup is publicly readable\" on talent_spell_lookup","create policy \"talent_spell_lookup is publicly readable\" on talent_spell_lookup for select using (is_officer())","drop policy if exists \"wowaudit_roster is publicly readable\" on wowaudit_roster","create policy \"wowaudit_roster is publicly readable\" on wowaudit_roster for select using (is_officer())","drop policy if exists \"discord_roster_channels_settings is publicly readable\" on discord_roster_channels_settings","create policy \"discord_roster_channels_settings is publicly readable\" on discord_roster_channels_settings for select using (is_officer())","drop policy if exists \"discord_roster_channels is publicly readable\" on discord_roster_channels","create policy \"discord_roster_channels is publicly readable\" on discord_roster_channels for select using (is_officer())","-- §hallazgo real de esta auditoría: por defecto una vista NO invocadora
-- (sin `security_invoker = true`) evalúa RLS con los privilegios del OWNER
-- de la vista (el rol de las migraciones, con BYPASSRLS) — así que estas
-- tres seguirían devolviendo TODAS las filas a cualquiera aunque las tablas
-- base ya estén cerradas arriba. applicable_pull_mechanic_events,
-- applicable_boss_mechanics_candidates y own_mechanic_hit_ratios YA tenían
-- security_invoker=true (comprobado en sus migraciones) — no hace falta
-- tocarlas.
alter view player_pull_reliability_inputs set (security_invoker = true)","alter view player_mechanic_offenses set (security_invoker = true)","alter view player_latest_spec set (security_invoker = true)"}', 'lock_down_rls_to_officers', NULL, NULL, NULL),
	('20260830090000', '{"-- §\"hay algo raro en la infografia de gusmi... se ha colado algo en la
-- descripcion\" (feedback real, 2026-08-30): 12 filas de
-- boss_mechanics_candidates (The Coiled Altar, boss_id 3429, Normal+Heroic,
-- las 6 mecánicas clasificadas en el mismo lote resolution_verified_at =
-- 2026-08-29T20:49:03.052+00:00) quedaron con un artefacto de
-- markdown-link+JSON pegado delante del texto real, p.ej.:
--   El](https://www.wowhead.com/guide/.../coiled-altar-boss-strategy-
--   abilities%22,%22https://www.method.gg/.../coiled-altar-heroic%22],%22
--   notes%22:%22%22,%22resolution%22:%22El) tank activo orienta...
-- classify-mechanics/index.ts NO parsea texto libre — recibe rawResponseText
-- ya como JSON desde el cliente (flujo manual: se copia el prompt, se pega
-- en un LLM externo, se pega la respuesta de vuelta) y hace JSON.parse
-- directo, así que un \"resolution\" con esta forma ya llegó corrupto DESDE
-- fuera del pipeline: el paso externo de copiar/pegar la respuesta del LLM
-- (con citas insertadas por esa interfaz) mezcló el arranque de la frase
-- real con metadatos de sources/notes/resolution de su propio JSON. Mythic
-- (mismo lote, mismo prompt) salió limpio — la clasificación en sí era
-- válida, solo el texto guardado quedó mal formado.
--
-- Reconstrucción verificada: en las 12 filas, el patrón es exactamente
-- \"<primera_palabra>](...%22<primera_palabra>) <resto real de la frase>\" —
-- la primera palabra aparece dos veces (como \"etiqueta\" del link roto y
-- justo antes del paréntesis de cierre), así que \"<primera_palabra> <resto>\"
-- reconstruye la frase original sin ambigüedad. Verificado fila a fila
-- contra la fila Mythic (mismo boss, mismo lote, misma redacción esperada)
-- antes de escribir este UPDATE.
begin","update boss_mechanics_candidates
set resolution = ''Golpea a Zul''''jan durante la ventana de daño aumentado mientras Malacrass está protegido; bloquea los fragmentos que intenten llegar a Zul''''jan sin encadenar demasiados Spirit Erasure.''
where boss_id = ''3429'' and difficulty = ''Normal'' and name = ''Soulbinding''","update boss_mechanics_candidates
set resolution = ''Golpea a Zul''''jan durante la ventana de daño aumentado mientras Malacrass está protegido; bloquea los fragmentos que intenten llegar a Zul''''jan sin encadenar demasiados Spirit Erasure.''
where boss_id = ''3429'' and difficulty = ''Heroic'' and name = ''Soulbinding''","update boss_mechanics_candidates
set resolution = ''Jugadores asignados pisan los orbes de uno en uno, los trasladan al punto de agrupación y los dejan reaparecer allí para que Sever los destruya en tandas controladas.''
where boss_id = ''3429'' and difficulty = ''Normal'' and name = ''Coalesced Venom''","update boss_mechanics_candidates
set resolution = ''Rompe Veil of Twilight con daño, esquiva los impactos de Twilight y, en cuanto caiga el escudo, corta Eternal Nightfall con una interrupción estándar.''
where boss_id = ''3429'' and difficulty = ''Normal'' and name = ''Eternal Nightfall''","update boss_mechanics_candidates
set resolution = ''Esquiva los círculos de impacto de Toxic Deluge; después trata los orbes creados como Coalesced Venom y llévalos al punto previsto para Sever.''
where boss_id = ''3429'' and difficulty = ''Normal'' and name = ''Toxic Deluge''","update boss_mechanics_candidates
set resolution = ''El tank activo orienta el frontal hacia los Coalesced Venom agrupados y lejos de la raid; alterna tanks por la vulnerabilidad y no destruyas demasiados orbes de golpe.''
where boss_id = ''3429'' and difficulty = ''Heroic'' and name = ''Sever''","update boss_mechanics_candidates
set resolution = ''El tank apunta Soul Sever a las Manifestations agrupadas y lejos de la raid; después recoge sus fragmentos y los tanks se alternan por la vulnerabilidad.''
where boss_id = ''3429'' and difficulty = ''Normal'' and name = ''Soul Sever''","update boss_mechanics_candidates
set resolution = ''Esquiva los puntos de impacto y no cruces la trayectoria de las hachas que recorren la sala.''
where boss_id = ''3429'' and difficulty = ''Normal'' and name = ''Axegrinder''","update boss_mechanics_candidates
set resolution = ''El tank apunta Soul Sever a las Manifestations agrupadas y lejos de la raid; después recoge sus fragmentos y los tanks se alternan por la vulnerabilidad.''
where boss_id = ''3429'' and difficulty = ''Heroic'' and name = ''Soul Sever''","update boss_mechanics_candidates
set resolution = ''El tank activo orienta el frontal hacia los Coalesced Venom agrupados y lejos de la raid; alterna tanks por la vulnerabilidad y no destruyas demasiados orbes de golpe.''
where boss_id = ''3429'' and difficulty = ''Normal'' and name = ''Sever''","update boss_mechanics_candidates
set resolution = ''Rompe Veil of Twilight con daño, esquiva los impactos de Twilight y, en cuanto caiga el escudo, corta Eternal Nightfall con una interrupción estándar.''
where boss_id = ''3429'' and difficulty = ''Heroic'' and name = ''Eternal Nightfall''","update boss_mechanics_candidates
set resolution = ''Esquiva los círculos de impacto de Toxic Deluge; después trata los orbes creados como Coalesced Venom y llévalos al punto previsto para Sever.''
where boss_id = ''3429'' and difficulty = ''Heroic'' and name = ''Toxic Deluge''","-- Mismo criterio que invalidateNightFullReportsForBossDifficulty
-- (resync-mechanic-category.ts): el texto corrupto puede seguir viviendo
-- dentro de un informe de noche ya cacheado (night_full_reports.report
-- jsonb) para cualquier report de este boss+dificultad — se borra la fila
-- cacheada, no se recalcula aquí, la próxima apertura regenera con el
-- resolution ya limpio.
delete from night_full_reports
where report_code in (
  select distinct report_code from pulls
  where boss_id = ''3429'' and difficulty in (''Normal'', ''Heroic'')
)",commit}', 'fix_corrupted_coiled_altar_resolutions', NULL, NULL, NULL),
	('20260830100000', '{"-- §\"aqui en la descripcion del informe de noche tambien se ha colado algo\"
-- (feedback real, 2026-08-30): la migración anterior
-- (20260830090000_fix_corrupted_coiled_altar_resolutions.sql) arregló 12
-- filas de `resolution` en The Coiled Altar (boss_id 3429). Un barrido
-- completo de la tabla encontró el MISMO artefacto de markdown-link+JSON,
-- esta vez en `ai_classification->>''notes''` — 233 filas repartidas en 4
-- bosses (Sszorak/Ula''tek incluidos, boss_id 3420 y 3492 entre ellos).
-- Mismo origen: classify-mechanics/index.ts no llama al LLM directamente
-- (flujo manual: se copia el prompt, se pega en un LLM externo, se pega la
-- respuesta de vuelta) — un \"notes\" con esta forma llegó corrupto DESDE
-- fuera del pipeline, JSON.parse lo aceptó porque como STRING era válido.
--
-- El patrón es idéntico en las 233 filas y ya verificado exhaustivamente
-- contra la tabla real antes de escribir este UPDATE (ver conversación):
--   \"<primera_palabra>](<sources%22-separadas>],%22notes%22:%22
--   <primera_palabra>) <resto real de la nota>\"
-- La primera palabra aparece dos veces (como \"etiqueta\" del link roto y
-- justo antes del paréntesis de cierre) — \"<primera_palabra> <resto>\"
-- reconstruye la nota original sin ambigüedad. A diferencia del fix
-- anterior (12 filas, reconstrucción manual una a una), aquí se usa una
-- regexp_replace genérica: confirmado con SELECT de verificación que
-- limpia las 233 filas sin dejar ningún residuo \"%22\" ni \"](\" — no hace
-- falta (ni sería practico) escribir 233 UPDATE literales.
--
-- classify-mechanics/index.ts ya lleva un guard (validateResolution)
-- añadido en el mismo bloque de trabajo para que un \"resolution\" con esta
-- forma se rechace en el momento de guardar — pero esa función solo valida
-- resolution, no notes (notes se guarda en un paso de clasificación previo,
-- sin la validación estricta de fuentes/longitud que sí tiene resolution).
-- Este UPDATE es la limpieza retroactiva de datos; no cambia el pipeline.
begin","-- Captura los boss_id afectados ANTES del update de abajo — si se leyera
-- después, el propio UPDATE ya habría limpiado el ''%22'' que identifica las
-- filas a invalidar y esta subconsulta encontraría cero bosses por error.
create temporary table _corrupted_notes_boss_ids on commit drop as
select distinct boss_id
from boss_mechanics_candidates
where strpos(coalesce(ai_classification->>''notes'', ''''), ''%22'') > 0","update boss_mechanics_candidates
set ai_classification = jsonb_set(
  ai_classification,
  ''{notes}'',
  to_jsonb(regexp_replace(ai_classification->>''notes'', ''^(.+?)\\]\\(.*?%22\\1\\)'', ''\\1'')),
  false
)
where strpos(coalesce(ai_classification->>''notes'', ''''), ''%22'') > 0","-- Mismo criterio que la migración anterior: el texto corrupto puede seguir
-- viviendo dentro de un informe de noche ya cacheado. Se invalidan TODOS
-- los informes cacheados de los bosses afectados, la próxima apertura
-- regenera con las notas ya limpias.
delete from night_full_reports
where report_code in (
  select distinct p.report_code
  from pulls p
  where p.boss_id in (select boss_id from _corrupted_notes_boss_ids)
)",commit}', 'fix_corrupted_mechanic_notes', NULL, NULL, NULL),
	('20260830110000', '{"-- §\"si contamos el pain suppression también deberíamos contabilizar la
-- Crisálida vital del monk\" (feedback real, 2026-08-30): comprobado contra
-- producción antes de este cambio — Pain Suppression (Priest/Discipline,
-- external_defensive) SÍ estaba en cooldown_catalog; Life Cocoon (Monk/
-- Mistweaver) no tenía ninguna fila. No es una decisión deliberada de
-- excluirla: el catálogo se puebla por dos vías (una lista corta verificada
-- a mano el 21-08, ver 20260822030000_cooldown_catalog.sql — ahí entró Pain
-- Suppression a propósito — y una sincronización automática desde
-- WoWAnalyzer que solo sube lo que ESE proyecto etiqueta como defensivo en
-- su propio código) y Life Cocoon no entró por ninguna de las dos. Se añade
-- aquí con el mismo tratamiento que Pain Suppression: external_defensive
-- (protege a otro jugador, aunque también sea auto-lanzable) — el eje
-- ortogonal survival_type es ''absorption'' (intercepta daño con un pool
-- aparte, ver comment de 20260827150000_defensive_survival_type.sql), no
-- ''sustain'' como Word of Glory, porque no repara vida ya perdida: crea un
-- absorbedor nuevo.
--
-- Cooldown/duración verificados en vivo contra el tooltip real (Wowhead,
-- 2026-08-30, mismo endpoint que ya usa la app para iconos): \"2 min
-- cooldown\" / \"Encases the target... for 12 sec, absorbing [...] damage\" —
-- 120000ms/12000ms, el valor BASE sin contar la reducción de talento
-- opcional (sp202424, \"1.3 min cooldown\") — mismo criterio de \"peor caso,
-- haste/talentos en 0\" que ya usa el resto del catálogo (ver comentario de
-- extractBaseCooldownMs en supabase/wowanalyzer-extractor/extract.mjs).
-- reviewed=true porque es una confirmación humana explícita (este feedback),
-- no una sugerencia de IA sin revisar.
insert into cooldown_catalog (class, spec, spell_id, name, category, survival_type, base_cooldown_ms, base_duration_ms, reviewed)
values (''Monk'', ''Mistweaver'', 116849, ''Life Cocoon'', ''external_defensive'', ''absorption'', 120000, 12000, true)
on conflict (class, spell_id) do nothing"}', 'add_life_cocoon_defensive', NULL, NULL, NULL),
	('20260830120000', '{"-- §\"si tras sufrir daño uso la piedra de brujo es un uso correcto, usarla
-- por usarla no es correcto\" (feedback real, 2026-08-30): analyze-report/
-- reanalyze-defensive-pressure ya escriben consumables.<healthstone|
-- healthPotion>.usedReactively para cualquier pull procesado a partir de
-- este despliegue (ver _shared/consumables.ts, isReactiveConsumableUse) —
-- esta migración rellena esa misma clave en el histórico ya importado, sin
-- pedir nada a WCL: reactivo = el cast cae dentro de una ventana de presión
-- real de ESE jugador en ESE pull (±2s antes / +8s después, mismo margen
-- que el resto del informe) — y esas ventanas (defensive_pressure_windows)
-- YA están persistidas por pull, así que esto es una transformación
-- puramente sobre datos que ya viven en la base, no un reanálisis.
--
-- Deliberadamente NO toca las filas cuyo defensive_pressure_windows es NULL
-- (pulls de antes del 2026-08-29, cuando esa columna ni existía todavía) —
-- para esas, \"no reactivo\" sería inventado (no hay ventanas con las que
-- comparar), así que se dejan sin la clave usedReactively y el cliente cae
-- al criterio antiguo (cualquier cast cuenta) como fallback explícito, ver
-- night-player-summary.service.ts. Solo se sobrescribe cuando de verdad hay
-- con qué comparar.
do $$
declare
  rec record;
  windows jsonb;
  hs_timestamps numeric[];
  hp_timestamps numeric[];
  hs_reactive boolean;
  hp_reactive boolean;
  updated_consumables jsonb;
  pad_before constant numeric := 2000;
  pad_after constant numeric := 8000;
  rows_updated int := 0;
begin
  for rec in
    select id, consumables
    from player_pull_records
    where defensive_pressure_windows is not null
      and consumables is not null
      and (consumables ? ''healthstone'' or consumables ? ''healthPotion'')
  loop
    select coalesce(defensive_pressure_windows -> ''windows'', ''[]''::jsonb)
      into windows
      from player_pull_records
      where id = rec.id;

    updated_consumables := rec.consumables;

    if rec.consumables ? ''healthstone'' then
      select coalesce(array_agg((elem)::numeric), array[]::numeric[])
        into hs_timestamps
        from jsonb_array_elements_text(coalesce(rec.consumables -> ''healthstone'' -> ''timestampsMs'', ''[]''::jsonb)) as elem;
      hs_reactive := exists (
        select 1
        from unnest(hs_timestamps) as ts
        cross join lateral jsonb_array_elements(windows) as w
        where ts >= (w ->> ''startMs'')::numeric - pad_before
          and ts <= (w ->> ''endMs'')::numeric + pad_after
      );
      updated_consumables := jsonb_set(updated_consumables, ''{healthstone,usedReactively}'', to_jsonb(hs_reactive));
    end if;

    if rec.consumables ? ''healthPotion'' then
      select coalesce(array_agg((elem)::numeric), array[]::numeric[])
        into hp_timestamps
        from jsonb_array_elements_text(coalesce(rec.consumables -> ''healthPotion'' -> ''timestampsMs'', ''[]''::jsonb)) as elem;
      hp_reactive := exists (
        select 1
        from unnest(hp_timestamps) as ts
        cross join lateral jsonb_array_elements(windows) as w
        where ts >= (w ->> ''startMs'')::numeric - pad_before
          and ts <= (w ->> ''endMs'')::numeric + pad_after
      );
      updated_consumables := jsonb_set(updated_consumables, ''{healthPotion,usedReactively}'', to_jsonb(hp_reactive));
    end if;

    update player_pull_records set consumables = updated_consumables where id = rec.id;
    rows_updated := rows_updated + 1;
  end loop;

  raise notice ''backfill_reactive_consumable_use: % filas actualizadas'', rows_updated;
end $$"}', 'backfill_reactive_consumable_use', NULL, NULL, NULL),
	('20260830130000', '{"-- §\"Preparación\": catálogo de peligrosidad/timing por mecánica + asignación
-- de defensivos por spec, para generar reminders de MRT — ver plan guardado
-- (conversación real, 2026-08-30). Deliberadamente separado de
-- boss_mechanics_candidates (otro consumidor: severidad de mecánica
-- evitable) aunque comparten clave (boss_id, difficulty, ability_id), sin FK
-- entre ellas — mismo patrón sin FK que ya usa el resto de schema.sql para
-- boss_id/difficulty como texto suelto.

-- Perfil de daño/timing calculado desde logs de referencia (fightRankings
-- públicos, ver fetchPublicRankings) + histórico propio. Los campos
-- reference_* y requires_defensive/requires_defensive_source SOLO los
-- escribe sync-mechanic-defensive-profile (automático); requires_group_split
-- /group_split_notes/reviewed SOLO los toca la edición manual — mismo
-- contrato que ya deja documentado boss_mechanics_candidates para evitar que
-- un resync pise una curación a mano.
create table if not exists boss_mechanic_defensive_profile (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  ability_id bigint not null,
  -- Daño reconstruido (amount+absorbed) en hits SIN un defensivo de
  -- mitigación %-reducción activo en el objetivo — la señal \"cruda\" que no
  -- se ve amortiguada por logs de referencia ya bien jugados (§\"trampeadas\",
  -- ver plan). Uno por hit observado, no agregado, para poder recalcular
  -- percentiles sin re-sincronizar.
  reference_unmitigated_damage_samples numeric[] not null default ''{}'',
  -- Mismos hits pero CON un defensivo de %-reducción activo — delta real de
  -- mitigación observado, no supuesto.
  reference_mitigated_damage_samples numeric[] not null default ''{}'',
  -- { tank: 0.1, healer: 0.05, dps: 0.85 } — fracción de hits por rol.
  reference_role_hit_breakdown jsonb,
  -- Ms desde pull-start de cada ocurrencia observada — solo para
  -- timeline/preview en la pantalla y como fallback si no hay trigger de
  -- bossmod fiable; el trigger real preferido (event=7/BW_TIMER) no depende
  -- de esto.
  reference_cast_offset_ms_samples integer[] not null default ''{}'',
  reference_sample_fight_count integer not null default 0,
  requires_defensive boolean,
  -- ''own_history'' | ''world_reference'' | ''fixed_threshold'' | ''manual_override''
  -- — mismo vocabulario que _shared/mechanic-severity.ts (SeveritySource),
  -- no un esquema de confianza nuevo.
  requires_defensive_source text,
  requires_group_split boolean not null default false,
  group_split_notes text,
  reviewed boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (boss_id, difficulty, ability_id)
)","create index if not exists boss_mechanic_defensive_profile_boss_idx on boss_mechanic_defensive_profile (boss_id, difficulty)","-- Asignación curada a mano: qué defensivo de qué spec cubre qué mecánica, y
-- con qué aviso previo/trigger. Referencia LÓGICA a cooldown_catalog
-- (class+spec+spell_id) — sin FK, mismo motivo que boss_id/difficulty arriba
-- (cooldown_catalog se resincroniza desde WoWAnalyzer y podría no tener fila
-- para un spell_id nuevo todavía sin romper esta asignación).
create table if not exists mechanic_defensive_assignments (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  ability_id bigint not null,
  class text not null,
  spec text not null,
  defensive_spell_id bigint not null,
  prewarn_seconds integer not null default 5,
  trigger_type text not null default ''bossmod'' check (trigger_type in (''bossmod'', ''time'')),
  -- Normalmente = ability_id; distinto solo si el timer real de
  -- BigWigs/DBM usa otro spellID para esta mecánica.
  bossmod_spell_id bigint,
  notes text,
  updated_at timestamptz not null default now(),
  unique (boss_id, difficulty, ability_id, class, spec)
)","create index if not exists mechanic_defensive_assignments_boss_idx on mechanic_defensive_assignments (boss_id, difficulty)","create index if not exists mechanic_defensive_assignments_spec_idx on mechanic_defensive_assignments (class, spec)","-- RLS: mismo tratamiento que el resto de la app desde el cierre a oficiales
-- (ver 20260829100000_lock_down_rls_to_officers.sql) — lectura solo
-- is_officer(), ninguna escritura para anon/authenticated (las dos edge
-- functions que escriben aquí usan la service role key).
alter table boss_mechanic_defensive_profile enable row level security","create policy \"read all - boss_mechanic_defensive_profile\" on boss_mechanic_defensive_profile for select using (is_officer())","alter table mechanic_defensive_assignments enable row level security","create policy \"read all - mechanic_defensive_assignments\" on mechanic_defensive_assignments for select using (is_officer())"}', 'boss_mechanic_defensive_profile', NULL, NULL, NULL),
	('20260831090000', '{"-- §\"un tank de paladin me comentó que una habilidad defensiva la tenemos
-- puesta como suya pero ya no la tiene\" (feedback real, 2026-08-31): `spec`
-- en cooldown_catalog viene del extractor de WoWAnalyzer (o de la IA vía
-- classify-defensives) y no era editable a mano — spec_override es la
-- corrección humana por ENCIMA de eso, mismo eje que ya existe entre
-- inferred_survival_type (sugerencia) y survival_type (confirmado a mano),
-- pero aquí como lista explícita de specs en vez de un único valor: null =
-- sin corrección, se sigue derivando de `spec` tal cual (spec=null → toda la
-- clase, \"Feral/Guardian\" → esas dos); no-null = la lista real, gane lo que
-- gane `spec` o un resync futuro del extractor.
alter table cooldown_catalog add column if not exists spec_override text[]","comment on column cooldown_catalog.spec_override is ''Corrección manual de qué specs tienen este defensivo de verdad — null = sin corregir, se deriva de `spec`. Nunca lo toca el extractor de WoWAnalyzer ni classify-defensives, solo save-defensive-edit.''"}', 'cooldown_catalog_spec_override', NULL, NULL, NULL),
	('20260831110000', '{"-- §Item 4 de \"Preparación\" (auto-asignación en cascada, ver plan guardado):
-- dos piezas de soporte.

-- 1) cooldown_catalog no llevaba updated_at — necesario para el aviso \"se
-- recomienda re-sincronizar/regenerar\" cuando un defensivo se edita
-- DESPUÉS de haber generado asignaciones automáticas para una spec.
alter table cooldown_catalog add column if not exists updated_at timestamptz not null default now()","-- 2) §\"muchos muchos muchos logs... si solo valoramos unos pocos, lo
-- trampeamos\" (feedback real, 2026-08-31): fetchPublicRankings paginado
-- barato (solo metadata de ranking, no fights completos) permite crecer la
-- muestra SIN límite práctico, pero procesar cada fight (DamageTaken+Casts+
-- roles) sí tiene un techo real de CPU por invocación — ya visto esta
-- sesión. La solución es acumular ENTRE sincronizaciones, no traer todo de
-- golpe: esta tabla recuerda cuántos logs de referencia ya se consumieron
-- por boss+dificultad, para que cada sync pida la SIGUIENTE tanda (no
-- repetir los mismos) y boss_mechanic_defensive_profile.reference_*
-- acumule (concatene) en vez de reemplazar.
create table if not exists boss_reference_sync_state (
  boss_id text not null,
  difficulty text not null,
  reference_fights_consumed integer not null default 0,
  last_synced_at timestamptz,
  primary key (boss_id, difficulty)
)","alter table boss_reference_sync_state enable row level security","create policy \"read all - boss_reference_sync_state\" on boss_reference_sync_state for select using (is_officer())"}', 'reference_sync_state_and_catalog_updated_at', NULL, NULL, NULL),
	('20260831130000', '{"-- §\"para las mecánicas que requieren grupos... un desplegable para asignar
-- un grupo (1 al 6, toggle chips)\" (feedback real, 2026-08-31): metadata de
-- planificación sobre una asignación ya existente — a qué grupos de raid
-- (1-6) aplica, para mecánicas tipo \"sokeo 1-3 y 2-4\". NO es un filtro que
-- MRT vaya a aplicar solo (el protocolo de Reminder que ya validamos en
-- real no documenta un campo de grupo — solo players/roles/classes), así
-- que esto es información para el humano que planifica y para el texto del
-- reminder exportado, no una restricción que imponga el propio MRT.
alter table mechanic_defensive_assignments add column if not exists assigned_groups smallint[]","comment on column mechanic_defensive_assignments.assigned_groups is ''Grupos de raid (1-6) a los que aplica esta asignación — null = todos/sin restringir. Solo informativo (se refleja en el texto del reminder exportado), MRT no filtra por esto.''"}', 'assignment_groups', NULL, NULL, NULL),
	('20260831150000', '{"-- §\"que se tiene que auto poner el ''exige defensivo'' cuando lo exija\" +
-- \"columna nueva que se llame prioridad... del 1 al 5 dependiendo la
-- prioridad de defensivo que tiene en base al daño que hace a la raid\"
-- (feedback real, 2026-08-31): prioridad relativa DENTRO de cada
-- boss+dificultad (quintiles por impactScore = mediana de daño sin mitigar
-- × jugadores golpeados, ver sync-mechanic-defensive-profile) — 5 = de las
-- que más pico hacen a la raid en ESTE boss, 1 = de las que menos, null =
-- sin evidencia todavía (ni un solo hit sin mitigar observado).
alter table boss_mechanic_defensive_profile add column if not exists priority smallint check (priority between 1 and 5)","comment on column boss_mechanic_defensive_profile.priority is ''1-5, relativo a las demás mecánicas de este boss+dificultad (quintil por daño sin mitigar × jugadores golpeados) — null = sin evidencia todavía. Solo lo escribe sync-mechanic-defensive-profile.''"}', 'mechanic_priority', NULL, NULL, NULL),
	('20260831170000', '{"-- §\"no tenemos opción de borrar ni de que el prompt borre si no encuentra
-- algo que nos habíamos traído. Por ejemplo el greater invisibility del
-- mago ya no es un defensivo... y no tengo opción de quitarlo de ninguna
-- manera\" (feedback real, 2026-08-31): mismo eje que spec_override —
-- corrección manual por ENCIMA de lo que trae el extractor de WoWAnalyzer,
-- que nunca se pisa en un resync. No se borra la fila (rompería el
-- histórico de defensive_pressure_windows.options que ya la referencia por
-- spellId en pulls antiguos) — se marca como \"esto ya no cuenta como
-- defensivo real\", y todo lo que construye el catálogo disponible de una
-- clase/spec (defensivesForClass/defensivesForSpec, en los dos lados)
-- filtra por esto.
alter table cooldown_catalog add column if not exists excluded boolean not null default false","comment on column cooldown_catalog.excluded is ''true = ya no es un defensivo real (rediseñado/quitado en un parche posterior) — corrección manual, nunca la toca el extractor de WoWAnalyzer ni un resync. Se filtra en defensivesForClass/defensivesForSpec.''"}', 'cooldown_catalog_excluded', NULL, NULL, NULL),
	('20260831200000', '{"-- Planificador defensivo v2: separa el catálogo genérico de los valores por
-- spec, aplica modificadores del build real y guarda calendarios por jugador
-- y ocurrencia. Las tablas antiguas de mechanic_defensive_assignments se
-- conservan intactas como plantillas/curación manual.

alter table boss_mechanic_defensive_profile
  add column if not exists reference_cast_offsets_by_fight jsonb not null default ''[]''::jsonb","comment on column boss_mechanic_defensive_profile.reference_cast_offsets_by_fight is
  ''Timings conservando el fight de origen: [{fightKey, offsetsMs[]}]. Permite alinear ocurrencias por ordinal sin inferirlas desde un array mezclado; reference_cast_offset_ms_samples queda como fallback histórico.''","create table if not exists defensive_spec_profiles (
  class text not null,
  spec text not null,
  spell_id bigint not null,
  base_cooldown_ms integer,
  base_duration_ms integer,
  charges smallint not null default 1 check (charges > 0),
  source text,
  source_note text,
  synced_from_commit text,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (class, spec, spell_id)
)","comment on table defensive_spec_profiles is
  ''Comportamiento base de un defensivo para una spec concreta. Gana sobre cooldown_catalog al planificar; evita fingir que un spell compartido tiene el mismo CD en todas las specs.''","create table if not exists defensive_modifier_rules (
  id uuid primary key default gen_random_uuid(),
  class text not null,
  specs text[],
  modifier_spell_id bigint not null,
  target_spell_id bigint not null,
  operation text not null check (operation in (''subtract_ms'', ''add_ms'', ''multiply'', ''set_ms'', ''charges_add'')),
  value numeric not null,
  per_rank boolean not null default false,
  condition text not null default ''always'' check (condition in (''always'', ''conditional'')),
  description text not null,
  source text,
  verified_at timestamptz,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (class, modifier_spell_id, target_spell_id, operation)
)","comment on table defensive_modifier_rules is
  ''Reglas declarativas de talentos/pasivas que modifican un defensivo. Las reglas conditional se explican en UI pero no reducen el CD garantizado usado por AUTO.''","create or replace function keep_defensive_reference_material_timestamp()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = ''defensive_spec_profiles'' then
    if (new.base_cooldown_ms, new.base_duration_ms, new.charges)
       is distinct from
       (old.base_cooldown_ms, old.base_duration_ms, old.charges) then
      new.updated_at = now();
    else
      new.updated_at = old.updated_at;
    end if;
  elsif tg_table_name = ''defensive_modifier_rules'' then
    if (new.specs, new.modifier_spell_id, new.target_spell_id, new.operation, new.value, new.per_rank, new.condition, new.active)
       is distinct from
       (old.specs, old.modifier_spell_id, old.target_spell_id, old.operation, old.value, old.per_rank, old.condition, old.active) then
      new.updated_at = now();
    else
      new.updated_at = old.updated_at;
    end if;
  end if;
  return new;
end;
$$","drop trigger if exists defensive_spec_profiles_material_timestamp on defensive_spec_profiles","create trigger defensive_spec_profiles_material_timestamp
before update on defensive_spec_profiles
for each row execute function keep_defensive_reference_material_timestamp()","drop trigger if exists defensive_modifier_rules_material_timestamp on defensive_modifier_rules","create trigger defensive_modifier_rules_material_timestamp
before update on defensive_modifier_rules
for each row execute function keep_defensive_reference_material_timestamp()","-- Todo valor que el catálogo ya conocía como específico es una base válida.
-- Los combos \"Feral/Guardian\" se expanden a perfiles independientes.
insert into defensive_spec_profiles
  (class, spec, spell_id, base_cooldown_ms, base_duration_ms, source, source_note, synced_from_commit, verified_at)
select
  catalog.class,
  trim(spec_name),
  catalog.spell_id,
  catalog.base_cooldown_ms,
  catalog.base_duration_ms,
  ''cooldown_catalog_spec'',
  ''Backfill desde una fila del catálogo ya acotada a esta spec.'',
  catalog.synced_from_commit,
  now()
from cooldown_catalog catalog
cross join lateral regexp_split_to_table(catalog.spec, ''/'') spec_name
where catalog.spec is not null
  and catalog.base_cooldown_ms is not null
on conflict (class, spec, spell_id) do nothing","-- Primer caso verificado que motivó el modelo. El prompt de defensivos v4
-- rellena/corrige el resto del catálogo sin meter ifs por clase en código.
insert into defensive_spec_profiles (class, spec, spell_id, base_cooldown_ms, base_duration_ms, source, verified_at)
values
  (''Monk'', ''Mistweaver'', 115203, 120000, 15000, ''Verificación de spec: Fortifying Brew'', now()),
  (''Monk'', ''Windwalker'', 115203, 120000, 15000, ''Verificación de spec: Fortifying Brew'', now()),
  (''Monk'', ''Mistweaver'', 243435, 120000, 15000, ''Verificación de spec: Fortifying Brew (variante)'', now()),
  (''Monk'', ''Windwalker'', 243435, 120000, 15000, ''Verificación de spec: Fortifying Brew (variante)'', now())
on conflict (class, spec, spell_id) do update set
  base_cooldown_ms = excluded.base_cooldown_ms,
  base_duration_ms = excluded.base_duration_ms,
  source = excluded.source,
  verified_at = excluded.verified_at,
  updated_at = now()","insert into defensive_modifier_rules
  (class, specs, modifier_spell_id, target_spell_id, operation, value, condition, description, source, verified_at)
values
  (''Monk'', array[''Mistweaver'', ''Windwalker''], 388813, 115203, ''subtract_ms'', 30000, ''always'',
   ''Expeditious Fortification reduce 30 s el cooldown de Fortifying Brew.'',
   ''Talento Expeditious Fortification'', now()),
  (''Monk'', array[''Mistweaver'', ''Windwalker''], 388813, 243435, ''subtract_ms'', 30000, ''always'',
   ''Expeditious Fortification reduce 30 s el cooldown de Fortifying Brew.'',
   ''Talento Expeditious Fortification'', now())
on conflict (class, modifier_spell_id, target_spell_id, operation) do update set
  specs = excluded.specs,
  value = excluded.value,
  condition = excluded.condition,
  description = excluded.description,
  source = excluded.source,
  verified_at = excluded.verified_at,
  active = true,
  updated_at = now()","-- Una fila por personaje del roster con la evidencia de combate más reciente.
-- Conserva también el pull de origen para poder explicar antigüedad y detectar
-- cuándo un plan quedó obsoleto tras importar un build nuevo.
create or replace view player_latest_loadout
with (security_invoker = true)
as
select
  r.character_id,
  r.name as player_name,
  r.realm,
  r.class as roster_class,
  latest.class,
  latest.spec,
  latest.talent_build,
  latest.pull_id,
  latest.loadout_observed_at
from wowaudit_roster r
left join lateral (
  select
    p.class,
    p.spec,
    p.talent_build,
    p.pull_id,
    pulls.closed_at as loadout_observed_at
  from player_pull_records p
  join pulls on pulls.id = p.pull_id
  where lower(p.player_name) = lower(r.name)
    and p.class = r.class
    and p.spec is not null
    and p.talent_build is not null
  order by pulls.closed_at desc, p.created_at desc
  limit 1
) latest on true","comment on view player_latest_loadout is
  ''Roster canónico + spec/build de talentos más reciente observado en CombatantInfo. Fuente del Effective Defensive Resolver de Preparación.''","create table if not exists defensive_plan_runs (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  character_id bigint not null,
  player_name text not null,
  class text not null,
  spec text not null,
  talent_spell_ids bigint[] not null default ''{}'',
  loadout_hash text not null,
  loadout_observed_at timestamptz,
  catalog_version timestamptz,
  mechanic_profile_version timestamptz,
  generated_at timestamptz not null default now(),
  unique (boss_id, difficulty, character_id)
)","create table if not exists defensive_plan_assignments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references defensive_plan_runs(id) on delete cascade,
  window_key text not null,
  planned_time_ms integer not null check (planned_time_ms >= 0),
  impact_score numeric not null default 0,
  priority smallint check (priority between 1 and 5),
  ability_ids bigint[] not null,
  ability_names text[] not null,
  primary_ability_id bigint not null,
  occurrence_index integer not null check (occurrence_index > 0),
  defensive_spell_id bigint not null,
  effective_cooldown_ms integer not null check (effective_cooldown_ms >= 0),
  cooldown_explanation text not null,
  prewarn_seconds integer not null default 5,
  trigger_type text not null default ''bossmod'' check (trigger_type in (''bossmod'', ''time'')),
  bossmod_spell_id bigint,
  bossmod_counter integer,
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (plan_id, window_key)
)","create index if not exists defensive_plan_runs_boss_idx
  on defensive_plan_runs (boss_id, difficulty)","create index if not exists defensive_plan_assignments_plan_idx
  on defensive_plan_assignments (plan_id, planned_time_ms)","-- Sustitución atómica: si una asignación no cumple el contrato, toda la
-- transacción hace rollback y el plan anterior permanece intacto.
create or replace function replace_defensive_plan_v2(p_run jsonb, p_assignments jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_plan_id uuid;
begin
  delete from defensive_plan_runs
  where boss_id = p_run->>''bossId''
    and difficulty = p_run->>''difficulty''
    and character_id = (p_run->>''characterId'')::bigint;

  insert into defensive_plan_runs (
    boss_id, difficulty, character_id, player_name, class, spec,
    talent_spell_ids, loadout_hash, loadout_observed_at, catalog_version, mechanic_profile_version, generated_at
  ) values (
    p_run->>''bossId'',
    p_run->>''difficulty'',
    (p_run->>''characterId'')::bigint,
    p_run->>''playerName'',
    p_run->>''class'',
    p_run->>''spec'',
    array(select value::bigint from jsonb_array_elements_text(coalesce(p_run->''talentSpellIds'', ''[]''::jsonb))),
    p_run->>''loadoutHash'',
    nullif(p_run->>''loadoutObservedAt'', '''')::timestamptz,
    nullif(p_run->>''catalogVersion'', '''')::timestamptz,
    nullif(p_run->>''mechanicProfileVersion'', '''')::timestamptz,
    now()
  ) returning id into new_plan_id;

  insert into defensive_plan_assignments (
    plan_id, window_key, planned_time_ms, impact_score, priority,
    ability_ids, ability_names, primary_ability_id, occurrence_index,
    defensive_spell_id, effective_cooldown_ms, cooldown_explanation,
    prewarn_seconds, trigger_type, bossmod_spell_id, bossmod_counter, locked
  )
  select
    new_plan_id,
    item->>''windowKey'',
    (item->>''plannedTimeMs'')::integer,
    coalesce((item->>''impactScore'')::numeric, 0),
    nullif(item->>''priority'', '''')::smallint,
    array(select value::bigint from jsonb_array_elements_text(item->''abilityIds'')),
    array(select value from jsonb_array_elements_text(item->''abilityNames'')),
    (item->>''primaryAbilityId'')::bigint,
    (item->>''occurrenceIndex'')::integer,
    (item->>''defensiveSpellId'')::bigint,
    (item->>''effectiveCooldownMs'')::integer,
    item->>''cooldownExplanation'',
    coalesce((item->>''prewarnSeconds'')::integer, 5),
    coalesce(item->>''triggerType'', ''bossmod''),
    nullif(item->>''bossmodSpellId'', '''')::bigint,
    nullif(item->>''bossmodCounter'', '''')::integer,
    coalesce((item->>''locked'')::boolean, false)
  from jsonb_array_elements(coalesce(p_assignments, ''[]''::jsonb)) item;

  return new_plan_id;
end;
$$","revoke all on function replace_defensive_plan_v2(jsonb, jsonb) from public, anon, authenticated","grant execute on function replace_defensive_plan_v2(jsonb, jsonb) to service_role","alter table defensive_spec_profiles enable row level security","alter table defensive_modifier_rules enable row level security","alter table defensive_plan_runs enable row level security","alter table defensive_plan_assignments enable row level security","create policy \"officers read defensive spec profiles\"
  on defensive_spec_profiles for select using (is_officer())","create policy \"officers read defensive modifier rules\"
  on defensive_modifier_rules for select using (is_officer())","create policy \"officers read defensive plan runs\"
  on defensive_plan_runs for select using (is_officer())","create policy \"officers read defensive plan assignments\"
  on defensive_plan_assignments for select using (is_officer())","grant select on defensive_spec_profiles to authenticated","grant select on defensive_modifier_rules to authenticated","grant select on defensive_plan_runs to authenticated","grant select on defensive_plan_assignments to authenticated","grant select on player_latest_loadout to authenticated"}', 'roster_aware_defensive_plans', NULL, NULL, NULL),
	('20260831190000', '{"-- Defensive research v5: the AI pass is no longer limited to classifying
-- rows that WoWAnalyzer already happened to expose. It can also resolve
-- spec-specific timings and talent/passive modifiers. These two tables use
-- the same schema as Planning v2 so that branch can be rebased/merged later
-- without introducing a second representation of the same data.

create table if not exists defensive_spec_profiles (
  class text not null,
  spec text not null,
  spell_id bigint not null,
  base_cooldown_ms integer,
  base_duration_ms integer,
  charges smallint not null default 1 check (charges > 0),
  source text,
  source_note text,
  synced_from_commit text,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (class, spec, spell_id)
)","comment on table defensive_spec_profiles is
  ''Comportamiento base de un defensivo para una spec concreta. Gana sobre cooldown_catalog cuando una spec tenga un valor realmente distinto.''","create table if not exists defensive_modifier_rules (
  id uuid primary key default gen_random_uuid(),
  class text not null,
  specs text[],
  modifier_spell_id bigint not null,
  target_spell_id bigint not null,
  operation text not null check (operation in (''subtract_ms'', ''add_ms'', ''multiply'', ''set_ms'', ''charges_add'')),
  value numeric not null,
  per_rank boolean not null default false,
  condition text not null default ''always'' check (condition in (''always'', ''conditional'')),
  description text not null,
  source text,
  verified_at timestamptz,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (class, modifier_spell_id, target_spell_id, operation)
)","comment on table defensive_modifier_rules is
  ''Reglas declarativas de talentos/pasivas que cambian cooldown, duración o cargas del defensivo. Las conditional no deben asumirse como reducción garantizada.''","-- Estas tablas solo las escribe classify-defensives mediante service_role en
-- main. Planning v2 añadirá las policies/grants de lectura al desplegarse.
alter table defensive_spec_profiles enable row level security","alter table defensive_modifier_rules enable row level security","-- Caso real que destapó el problema de disponibilidad por spec.
-- Desperate Prayer es actualmente un talento del árbol DE CLASE de Priest,
-- por lo que Discipline/Holy/Shadow pueden elegirlo. El cooldown sin
-- modificadores es 90 s y el aumento de vida dura 10 s.
update cooldown_catalog
set
  spec = null,
  category = ''personal_defensive'',
  base_cooldown_ms = 90000,
  base_duration_ms = 10000,
  survival_type = coalesce(survival_type, ''emergency''),
  inferred_survival_type = coalesce(inferred_survival_type, ''emergency''),
  updated_at = now()
where class = ''Priest'' and spell_id = 19236","-- Power Word: Shield no aparecía porque el catálogo heredado depende de lo
-- que WoWAnalyzer modela como cooldown. Es una absorción baseline de Priest,
-- puede lanzarse sobre uno mismo y sobre aliados; semi_defensive hace que
-- siga siendo elegible como herramienta personal sin fingir que es self-only.
insert into cooldown_catalog (
  class,
  spec,
  spell_id,
  name,
  category,
  base_cooldown_ms,
  base_duration_ms,
  survival_type,
  inferred_survival_type,
  reviewed
)
values (
  ''Priest'',
  null,
  17,
  ''Power Word: Shield'',
  ''semi_defensive'',
  7500,
  15000,
  ''absorption'',
  ''absorption'',
  false
)
on conflict (class, spell_id) do update set
  spec = null,
  name = excluded.name,
  category = excluded.category,
  base_cooldown_ms = excluded.base_cooldown_ms,
  base_duration_ms = excluded.base_duration_ms,
  survival_type = coalesce(cooldown_catalog.survival_type, excluded.survival_type),
  inferred_survival_type = coalesce(cooldown_catalog.inferred_survival_type, excluded.inferred_survival_type),
  updated_at = now()","-- Angel''s Mercy is a class-tree passive available to all Priest specs. It
-- reduces Desperate Prayer by 20 s: 90 s base -> 70 s effective for a build
-- that actually contains talent spell 238100. The base catalog intentionally
-- stays at 90 s; effective timing belongs in the modifier layer.
insert into defensive_modifier_rules (
  class,
  specs,
  modifier_spell_id,
  target_spell_id,
  operation,
  value,
  per_rank,
  condition,
  description,
  source,
  verified_at,
  active
)
values (
  ''Priest'',
  null,
  238100,
  19236,
  ''subtract_ms'',
  20000,
  false,
  ''always'',
  ''Angel''''s Mercy reduce 20 s el cooldown de Desperate Prayer.'',
  ''Warcraft Wiki / Mechanical Priest / Murlok, verificado 2026-08-31'',
  now(),
  true
)
on conflict (class, modifier_spell_id, target_spell_id, operation) do update set
  specs = excluded.specs,
  value = excluded.value,
  per_rank = excluded.per_rank,
  condition = excluded.condition,
  description = excluded.description,
  source = excluded.source,
  verified_at = excluded.verified_at,
  active = true,
  updated_at = now()"}', 'defensive_catalog_research_v5', NULL, NULL, NULL),
	('20260902090000', '{"-- Estado operativo del catálogo de mecánicas. Es distinto del estado de
-- consumo del perfil defensivo: sync-boss-mechanics es quien mantiene esto.
create table if not exists boss_mechanic_catalog_sync_state (
  boss_id text not null,
  difficulty text not null,
  last_synced_at timestamptz not null,
  sync_mode text not null check (sync_mode in (''deep'', ''quick'')),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  reference_bundle_count integer not null default 0 check (reference_bundle_count >= 0),
  mapping_status text,
  reference_fetch_error text,
  snapshot_fetch_error text,
  primary key (boss_id, difficulty)
)","alter table boss_mechanic_catalog_sync_state enable row level security","drop policy if exists \"boss_mechanic_catalog_sync_state: officers read\" on boss_mechanic_catalog_sync_state","create policy \"boss_mechanic_catalog_sync_state: officers read\"
  on boss_mechanic_catalog_sync_state for select using (is_officer())","revoke all on boss_mechanic_catalog_sync_state from anon, authenticated","grant select on boss_mechanic_catalog_sync_state to authenticated","comment on table boss_mechanic_catalog_sync_state is
  ''Último resultado persistido de sync-boss-mechanics por boss+dificultad; no representa el consumo incremental del perfil defensivo.''"}', 'boss_mechanic_catalog_sync_state', NULL, NULL, NULL),
	('20260831210000', '{"-- Gestión defensiva v2 · M2
--
-- Amplía el snapshot histórico ya existente. No duplica talent_build: añade
-- identidad determinista, build de reglas y versión del resolver que produjo
-- los derivados defensivos.

alter table player_pull_records
  add column if not exists talent_build_fingerprint text,
  add column if not exists game_build text,
  add column if not exists game_build_source text,
  add column if not exists game_build_confidence text not null default ''uncertain'',
  add column if not exists defensive_resolution_version text,
  add column if not exists defensive_resolution_shadow jsonb","alter table player_pull_records
  drop constraint if exists player_pull_records_game_build_confidence_check","alter table player_pull_records
  add constraint player_pull_records_game_build_confidence_check
  check (game_build_confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain''))","comment on column player_pull_records.talent_build_fingerprint is
  ''SHA-256 determinista de class+spec+game_build+nodos normalizados. Null en histórico pendiente de backfill o cuando el build no es identificable.''","comment on column player_pull_records.game_build is
  ''Build exacto X.Y.Z.build usado para resolver este snapshot. No confundir con WCL masterData.gameVersion, que solo distingue Retail/Classic.''","comment on column player_pull_records.game_build_source is
  ''Provenance del game_build (por ejemplo Blizzard namespace observado al importar o backfill por timeline de patches).''","comment on column player_pull_records.game_build_confidence is
  ''Confianza de la asociación pull→game_build. uncertain excluye decisiones dependientes de reglas del scoring estricto.''","comment on column player_pull_records.defensive_resolution_version is
  ''Versión del resolver usada al materializar death_cause/pressure metadata. Null = pipeline legacy.''","comment on column player_pull_records.defensive_resolution_shadow is
  ''Diagnóstico no autoritativo del resolver v2 (kit, provenance y diferencias). Nunca sustituye scoring legacy por sí solo.''","create index if not exists player_pull_records_latest_build_idx
  on player_pull_records (player_name, created_at desc)
  where class is not null and spec is not null","create index if not exists player_pull_records_build_scope_idx
  on player_pull_records (class, spec, game_build)
  where game_build is not null","drop view if exists player_latest_build","create view player_latest_build
with (security_invoker = true) as
select distinct on (record.player_name)
  record.player_name,
  record.class,
  record.spec,
  record.talent_build,
  record.talent_build_fingerprint,
  record.game_build,
  record.game_build_source,
  record.game_build_confidence,
  coalesce(
    to_timestamp((report.start_time + encounter.start_time) / 1000.0),
    pull.closed_at,
    record.created_at
  ) as observed_at,
  pull.report_code,
  record.pull_id
from player_pull_records record
join pulls pull on pull.id = record.pull_id
left join reports report on report.code = pull.report_code
left join report_encounters encounter
  on encounter.report_code = pull.report_code
 and encounter.fight_id = pull.fight_id
where record.class is not null
  and record.spec is not null
order by
  record.player_name,
  coalesce(
    to_timestamp((report.start_time + encounter.start_time) / 1000.0),
    pull.closed_at,
    record.created_at
  ) desc,
  record.created_at desc","comment on view player_latest_build is
  ''Último build observado por jugador en WCL. Es la fuente de preparación futura; el build histórico de un pull sigue viviendo en player_pull_records.''","revoke all on player_latest_build from anon","grant select on player_latest_build to authenticated"}', 'player_build_fingerprint', NULL, NULL, NULL),
	('20260831220000', '{"-- Gestión defensiva v2 · M3
-- Escape hatch humano acotado a jugador/build. Nunca modifica el catálogo
-- global ni un plan ya publicado.

create table if not exists player_defensive_overrides (
  id uuid primary key default gen_random_uuid(),
  character_id bigint,
  player_name text not null check (btrim(player_name) <> ''''),
  class text not null check (btrim(class) <> ''''),
  spec text,
  spell_id bigint not null,
  build_fingerprint text,
  game_build text not null check (btrim(game_build) <> ''''),
  effective_cooldown_ms integer check (effective_cooldown_ms is null or effective_cooldown_ms >= 0),
  effective_duration_ms integer check (effective_duration_ms is null or effective_duration_ms >= 0),
  charges smallint check (charges is null or charges > 0),
  targeting_mode text check (targeting_mode is null or targeting_mode in (''self'', ''ally'', ''both'', ''raid'', ''unknown'')),
  reason text not null check (btrim(reason) <> ''''),
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    effective_cooldown_ms is not null
    or effective_duration_ms is not null
    or charges is not null
    or targeting_mode is not null
  )
)","comment on table player_defensive_overrides is
  ''Correcciones manuales de valores efectivos por jugador y game build. build_fingerprint null significa scope global explícito para los builds de ese jugador dentro del mismo game_build.''","comment on column player_defensive_overrides.reason is
  ''Motivo auditable obligatorio. El resolver conserva además el valor automático anterior en provenance.''","-- Una única corrección activa por identidad lógica. lower(player_name) evita
-- duplicados por casing cuando todavía no existe character_id para una fila.
create unique index if not exists player_defensive_overrides_active_scope_key
  on player_defensive_overrides (
    (case
      when character_id is not null then ''id:'' || character_id::text
      else ''name:'' || lower(player_name)
    end),
    class,
    coalesce(spec, ''''),
    spell_id,
    coalesce(build_fingerprint, ''''),
    game_build
  )
  where active = true","create index if not exists player_defensive_overrides_resolution_idx
  on player_defensive_overrides (player_name, build_fingerprint, spell_id, game_build)
  where active = true","alter table player_defensive_overrides enable row level security","drop policy if exists \"player_defensive_overrides: officers read\" on player_defensive_overrides","create policy \"player_defensive_overrides: officers read\"
  on player_defensive_overrides for select
  using (is_officer())","revoke all on player_defensive_overrides from anon","grant select on player_defensive_overrides to authenticated"}', 'player_defensive_overrides', NULL, NULL, NULL),
	('20260831230000', '{"-- Gestión defensiva v2 · Bloque C
--
-- Materializaciones paralelas para backfill. No se reutilizan las claves JSON
-- legacy porque las vistas de Fiabilidad actuales las consumen directamente:
-- el cambio de autoridad se hará más adelante mediante flag/dual-read.

alter table player_pull_records
  add column if not exists death_defensive_options_v2 jsonb,
  add column if not exists defensive_pressure_windows_v2 jsonb,
  add column if not exists defensive_resolution_evaluated_at timestamptz","alter table player_pull_records
  drop constraint if exists player_pull_records_death_defensive_options_v2_check","alter table player_pull_records
  add constraint player_pull_records_death_defensive_options_v2_check
  check (death_defensive_options_v2 is null or jsonb_typeof(death_defensive_options_v2) = ''array'')","alter table player_pull_records
  drop constraint if exists player_pull_records_defensive_pressure_windows_v2_check","alter table player_pull_records
  add constraint player_pull_records_defensive_pressure_windows_v2_check
  check (defensive_pressure_windows_v2 is null or jsonb_typeof(defensive_pressure_windows_v2) = ''object'')","comment on column player_pull_records.death_defensive_options_v2 is
  ''Estado en la muerte calculado con kit efectivo, cargas y targeting personal. Paralelo a death_cause.defensiveOptions durante dual-read.''","comment on column player_pull_records.defensive_pressure_windows_v2 is
  ''Sensor de pressure legacy con opciones recalculadas por resolver/state engine v2. coverable sigue siendo diagnóstico, no scoring.''","comment on column player_pull_records.defensive_resolution_evaluated_at is
  ''Fecha de materialización v2; junto a defensive_resolution_version y game_build permite auditar/backfillear derivados.''","create index if not exists player_pull_records_defensive_v2_pending_idx
  on player_pull_records (pull_id)
  where defensive_resolution_version is null"}', 'effective_defensive_materializations', NULL, NULL, NULL),
	('20260901080000', '{"-- Gestión defensiva v2 · Bloque C · cola durable de backfill
--
-- El navegador sigue orquestando una Edge invocation por pull, pero deja de
-- ser la única memoria del trabajo. Cerrar la pestaña conserva queued/error y
-- la siguiente sesión de un oficial puede reanudarlo.

create table if not exists defensive_reanalysis_batches (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (btrim(reason) <> ''''),
  scope jsonb not null default ''{}''::jsonb check (jsonb_typeof(scope) = ''object''),
  status text not null default ''queued'' check (status in (''queued'', ''running'', ''completed'', ''completed_with_errors'')),
  total_jobs integer not null check (total_jobs >= 0),
  completed_jobs integer not null default 0 check (completed_jobs >= 0),
  failed_jobs integer not null default 0 check (failed_jobs >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
)","create table if not exists defensive_reanalysis_jobs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references defensive_reanalysis_batches (id) on delete cascade,
  pull_id uuid not null references pulls (id) on delete cascade,
  status text not null default ''queued'' check (status in (''queued'', ''running'', ''done'', ''error'')),
  attempts smallint not null default 0 check (attempts >= 0),
  last_error text,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, pull_id)
)","create index if not exists defensive_reanalysis_jobs_claim_idx
  on defensive_reanalysis_jobs (status, created_at, attempts)","create index if not exists defensive_reanalysis_jobs_pull_idx
  on defensive_reanalysis_jobs (pull_id, created_at desc)","alter table defensive_reanalysis_batches enable row level security","alter table defensive_reanalysis_jobs enable row level security","drop policy if exists \"defensive_reanalysis_batches: officers read\" on defensive_reanalysis_batches","create policy \"defensive_reanalysis_batches: officers read\"
  on defensive_reanalysis_batches for select
  using (is_officer())","drop policy if exists \"defensive_reanalysis_jobs: officers read\" on defensive_reanalysis_jobs","create policy \"defensive_reanalysis_jobs: officers read\"
  on defensive_reanalysis_jobs for select
  using (is_officer())","revoke all on defensive_reanalysis_batches from anon","revoke all on defensive_reanalysis_jobs from anon","grant select on defensive_reanalysis_batches to authenticated","grant select on defensive_reanalysis_jobs to authenticated","create or replace function enqueue_defensive_reanalysis_batch(
  p_pull_ids uuid[],
  p_reason text,
  p_scope jsonb default ''{}''::jsonb,
  p_requested_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_pull_ids uuid[];
begin
  select coalesce(array_agg(distinct pull_id), ''{}''::uuid[])
  into v_pull_ids
  from unnest(coalesce(p_pull_ids, ''{}''::uuid[])) as value(pull_id);

  if cardinality(v_pull_ids) = 0 then
    return null;
  end if;
  if p_reason is null or btrim(p_reason) = '''' then
    raise exception ''reason is required'';
  end if;
  if p_scope is null or jsonb_typeof(p_scope) <> ''object'' then
    raise exception ''scope must be a JSON object'';
  end if;

  insert into defensive_reanalysis_batches (reason, scope, total_jobs, created_by)
  values (p_reason, p_scope, cardinality(v_pull_ids), p_requested_by)
  returning id into v_batch_id;

  insert into defensive_reanalysis_jobs (batch_id, pull_id)
  select v_batch_id, pull_id
  from unnest(v_pull_ids) as value(pull_id);

  return v_batch_id;
end;
$$","revoke all on function enqueue_defensive_reanalysis_batch(uuid[], text, jsonb, uuid) from public","revoke all on function enqueue_defensive_reanalysis_batch(uuid[], text, jsonb, uuid) from anon","revoke all on function enqueue_defensive_reanalysis_batch(uuid[], text, jsonb, uuid) from authenticated","grant execute on function enqueue_defensive_reanalysis_batch(uuid[], text, jsonb, uuid) to service_role","comment on table defensive_reanalysis_batches is
  ''Motivo y progreso durable de un backfill defensivo. No ejecuta trabajo dentro de SQL.''","comment on table defensive_reanalysis_jobs is
  ''Una unidad reintentable por pull. El cliente/worker invoca una Edge Function por fila para respetar el límite de CPU.''"}', 'defensive_reanalysis_queue', NULL, NULL, NULL),
	('20260901090000', '{"-- Gestión defensiva v2 · Bloque D · ocurrencias world por mecánica
--
-- La tabla legacy conserva todos los offsets mezclados por ability. Esta capa
-- aditiva alinea #1 con #1, #2 con #2, etc. entre fights de referencia, sin
-- cambiar mechanic_defensive_assignments (sigue siendo un template por spec).

create table if not exists boss_mechanic_occurrence_profile (
  boss_id text not null,
  difficulty text not null,
  ability_id bigint not null,
  occurrence_index integer not null check (occurrence_index >= 1),
  median_offset_ms integer not null check (median_offset_ms >= 0),
  p10_offset_ms integer not null check (p10_offset_ms >= 0),
  p90_offset_ms integer not null check (p90_offset_ms >= 0),
  sample_offsets_ms integer[] not null default ''{}'',
  sample_fight_count integer not null default 0 check (sample_fight_count >= 0),
  phase_id integer,
  world_overlap_score numeric,
  local_overlap_score numeric,
  updated_at timestamptz not null default now(),
  check (p10_offset_ms <= median_offset_ms and median_offset_ms <= p90_offset_ms),
  primary key (boss_id, difficulty, ability_id, occurrence_index)
)","create index if not exists boss_mechanic_occurrence_profile_timeline_idx
  on boss_mechanic_occurrence_profile (boss_id, difficulty, median_offset_ms, ability_id, occurrence_index)","alter table boss_mechanic_occurrence_profile enable row level security","drop policy if exists \"boss_mechanic_occurrence_profile: officers read\" on boss_mechanic_occurrence_profile","create policy \"boss_mechanic_occurrence_profile: officers read\"
  on boss_mechanic_occurrence_profile for select
  using (is_officer())","revoke all on boss_mechanic_occurrence_profile from anon","grant select on boss_mechanic_occurrence_profile to authenticated","comment on table boss_mechanic_occurrence_profile is
  ''Timings world por ocurrencia repetida: #1 se agrega con #1 entre fights, nunca como una mediana única por ability.''","comment on column boss_mechanic_occurrence_profile.sample_fight_count is
  ''Número de fights que observaron esta ocurrencia concreta; permite detectar una #N rara causada por distinta duración/fase.''"}', 'mechanic_occurrence_profiles', NULL, NULL, NULL),
	('20260901100000', '{"-- Gestión defensiva v2 · Bloque E · evidencia local separada de world

create table if not exists boss_mechanic_defensive_local_profile (
  boss_id text not null,
  difficulty text not null,
  ability_id bigint not null,
  local_damage_samples numeric[] not null default ''{}'',
  local_unmitigated_estimate_samples numeric[] not null default ''{}'',
  local_max_health_pct_samples numeric[] not null default ''{}'',
  local_player_hit_count_samples integer[] not null default ''{}'',
  local_death_count integer not null default 0 check (local_death_count >= 0),
  local_near_death_count integer not null default 0 check (local_near_death_count >= 0),
  local_pressure_window_count integer not null default 0 check (local_pressure_window_count >= 0),
  local_sample_pull_count integer not null default 0 check (local_sample_pull_count >= 0),
  local_raid_impact_score numeric,
  local_individual_lethality_score numeric,
  local_priority smallint check (local_priority between 1 and 5),
  local_last_observed_at timestamptz,
  sync_revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  primary key (boss_id, difficulty, ability_id)
)","create index if not exists boss_mechanic_defensive_local_profile_priority_idx
  on boss_mechanic_defensive_local_profile (boss_id, difficulty, local_priority desc, ability_id)","alter table boss_mechanic_defensive_local_profile enable row level security","drop policy if exists \"boss_mechanic_defensive_local_profile: officers read\" on boss_mechanic_defensive_local_profile","create policy \"boss_mechanic_defensive_local_profile: officers read\"
  on boss_mechanic_defensive_local_profile for select
  using (is_officer())","revoke all on boss_mechanic_defensive_local_profile from anon","grant select on boss_mechanic_defensive_local_profile to authenticated","create or replace view boss_mechanic_defensive_planning_view
with (security_invoker = true)
as
with joined as (
  select
    coalesce(world.boss_id, local.boss_id) as boss_id,
    coalesce(world.difficulty, local.difficulty) as difficulty,
    coalesce(world.ability_id, local.ability_id) as ability_id,
    world.reference_sample_fight_count as world_sample_fight_count,
    world.priority as world_priority,
    world.requires_defensive as world_requires_defensive,
    world.requires_defensive_source as world_requires_defensive_source,
    case
      when cardinality(world.reference_unmitigated_damage_samples) > 0 then
        (select percentile_cont(0.5) within group (order by value)
         from unnest(world.reference_unmitigated_damage_samples) as value)
      else null
    end as world_median_unmitigated_damage,
    local.local_sample_pull_count,
    local.local_damage_samples,
    local.local_unmitigated_estimate_samples,
    local.local_max_health_pct_samples,
    local.local_player_hit_count_samples,
    local.local_death_count,
    local.local_near_death_count,
    local.local_pressure_window_count,
    local.local_raid_impact_score,
    local.local_individual_lethality_score,
    local.local_priority,
    local.local_last_observed_at,
    greatest(world.updated_at, local.updated_at) as updated_at
  from boss_mechanic_defensive_profile world
  full outer join boss_mechanic_defensive_local_profile local
    on local.boss_id = world.boss_id
   and local.difficulty = world.difficulty
   and local.ability_id = world.ability_id
)
select
  joined.*,
  case
    when world_requires_defensive_source = ''manual_override'' then world_priority
    else greatest(world_priority, local_priority)
  end as combined_planning_priority,
  case
    when world_requires_defensive_source = ''manual_override'' then ''manual_override''
    when world_priority is not null and local_priority is not null then ''world+local''
    when local_priority is not null then ''local''
    when world_priority is not null then ''world''
    else ''none''
  end as combined_priority_source
from joined","revoke all on boss_mechanic_defensive_planning_view from anon","grant select on boss_mechanic_defensive_planning_view to authenticated","comment on table boss_mechanic_defensive_local_profile is
  ''Agregado idempotente de pulls propios. Nunca contiene ni sobrescribe muestras world.''","comment on view boss_mechanic_defensive_planning_view is
  ''Lectura conjunta para planning que conserva columnas y provenance world/local separadas.''","comment on column pull_mechanic_events.player_hit_details is
  ''Array de {name, damage_taken, damage_hits, healing_received, used_defensive_spell_id, max_hit_points?}; max_hit_points está disponible en imports nuevos con WCL resources.''"}', 'local_defensive_profiles', NULL, NULL, NULL),
	('20260901110000', '{"-- Gestión defensiva v2 · Bloque F · plan desplegado y binding histórico

-- Tiempo real del fight, distinto de closed_at (momento en que se importó).
-- Es imprescindible para no asociar retroactivamente un plan actual a un log
-- histórico que se haya importado hoy.
alter table pulls add column if not exists observed_at timestamptz","update pulls p
set observed_at = to_timestamp((r.start_time + re.start_time) / 1000.0)
from reports r
join report_encounters re on re.report_code = r.code
where p.report_code = re.report_code
  and p.fight_id = re.fight_id
  and p.observed_at is null","create index if not exists pulls_observed_at_idx on pulls (boss_id, difficulty, observed_at desc)","create table if not exists defensive_plan_versions (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  name text not null,
  status text not null default ''draft'' check (status in (''draft'', ''published'')),
  plan_mode text not null check (plan_mode in (''full'', ''partial'', ''no_plan'')),
  planning_quality text not null check (planning_quality in (''optimal'', ''fallback_greedy'', ''manual'')),
  game_build text,
  solver_version text not null,
  resolver_version text not null,
  backend_resolved boolean not null default false,
  roster_fingerprint text,
  source_profile_revision timestamptz,
  source_catalog_revision timestamptz,
  supersedes_id uuid references defensive_plan_versions (id) on delete restrict,
  uncertainty_margin_ms integer not null default 0 check (uncertainty_margin_ms >= 0),
  fallback_used boolean not null default false,
  roster_snapshot_at timestamptz not null,
  diagnostics jsonb not null default ''{}''::jsonb check (jsonb_typeof(diagnostics) = ''object''),
  content_fingerprint text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  published_by uuid references auth.users (id) on delete set null,
  published_at timestamptz,
  notes text,
  check ((status = ''draft'' and published_at is null) or (status = ''published'' and published_at is not null))
)","create index if not exists defensive_plan_versions_scope_idx
  on defensive_plan_versions (boss_id, difficulty, status, published_at desc)","create table if not exists defensive_plan_members (
  plan_version_id uuid not null references defensive_plan_versions (id) on delete cascade,
  player_key text not null,
  character_id bigint,
  player_name text not null,
  class text not null,
  spec text,
  role text check (role in (''tank'', ''healer'', ''dps'')),
  raid_group smallint check (raid_group between 1 and 8),
  build_fingerprint text,
  game_build text,
  build_observed_at timestamptz,
  build_confidence text not null check (build_confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  included boolean not null default true,
  resolver_version text not null,
  effective_kit jsonb not null check (jsonb_typeof(effective_kit) = ''array''),
  provenance jsonb not null default ''{}''::jsonb check (jsonb_typeof(provenance) = ''object''),
  created_at timestamptz not null default now(),
  primary key (plan_version_id, player_key)
)","create table if not exists defensive_plan_slots (
  id uuid primary key default gen_random_uuid(),
  plan_version_id uuid not null references defensive_plan_versions (id) on delete cascade,
  ability_id bigint not null check (ability_id > 0),
  occurrence_index integer not null check (occurrence_index > 0),
  slot_index integer not null default 1 check (slot_index > 0),
  occurrence_time_ms integer not null check (occurrence_time_ms >= 0),
  window_start_ms integer not null check (window_start_ms >= 0),
  window_end_ms integer not null check (window_end_ms >= window_start_ms),
  priority smallint check (priority between 1 and 5),
  requirement_level text not null check (requirement_level in (''required'', ''recommended'', ''optional'')),
  demand_type text not null check (demand_type in (''raid'', ''personal'', ''tank'', ''external'', ''utility'')),
  coverage_status text not null check (coverage_status in (''covered'', ''partial'', ''uncovered'', ''excluded'')),
  assigned_player_key text,
  target_player_key text,
  defensive_spell_id bigint check (defensive_spell_id > 0),
  planned_cast_at_ms integer check (planned_cast_at_ms >= 0),
  prewarn_ms integer not null default 5000 check (prewarn_ms >= 0),
  source text not null check (source in (''automatic'', ''manual'', ''locked'', ''emergency'', ''fallback'')),
  locked boolean not null default false,
  emergency_reserved boolean not null default false,
  confidence text not null check (confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  trigger_mode text not null default ''time'' check (trigger_mode in (''time'', ''bossmod'')),
  bossmod_spell_id bigint,
  bossmod_counter text,
  bossmod_counter_verified boolean not null default false,
  assigned_groups smallint[] check (assigned_groups is null or assigned_groups <@ array[1,2,3,4,5,6,7,8]::smallint[]),
  effective_cooldown_ms_snapshot integer check (effective_cooldown_ms_snapshot is null or effective_cooldown_ms_snapshot >= 0),
  effective_duration_ms_snapshot integer check (effective_duration_ms_snapshot is null or effective_duration_ms_snapshot >= 0),
  charges_snapshot smallint check (charges_snapshot is null or charges_snapshot > 0),
  build_fingerprint_snapshot text,
  notes text,
  rationale jsonb not null default ''{}''::jsonb check (jsonb_typeof(rationale) = ''object''),
  created_at timestamptz not null default now(),
  unique (plan_version_id, ability_id, occurrence_index, slot_index),
  foreign key (plan_version_id, assigned_player_key)
    references defensive_plan_members (plan_version_id, player_key),
  foreign key (plan_version_id, target_player_key)
    references defensive_plan_members (plan_version_id, player_key),
  check (
    (coverage_status in (''covered'', ''partial'') and assigned_player_key is not null and defensive_spell_id is not null and planned_cast_at_ms is not null and charges_snapshot is not null)
    or (coverage_status in (''uncovered'', ''excluded'') and assigned_player_key is null and defensive_spell_id is null and planned_cast_at_ms is null and charges_snapshot is null)
  ),
  check (trigger_mode = ''time'' or bossmod_spell_id is not null),
  check (not bossmod_counter_verified or trigger_mode = ''bossmod'')
)","create index if not exists defensive_plan_slots_timeline_idx
  on defensive_plan_slots (plan_version_id, occurrence_time_ms, ability_id, occurrence_index, slot_index)","create table if not exists pull_defensive_plan_binding (
  pull_id uuid primary key references pulls (id) on delete cascade,
  plan_version_id uuid references defensive_plan_versions (id) on delete restrict,
  mode_at_pull text not null check (mode_at_pull in (''full'', ''partial'', ''no_plan'')),
  binding_reason text not null check (binding_reason in (''published_at_fight'', ''manual'', ''none_available'')),
  plan_published_at timestamptz,
  manual_reason text,
  bound_by uuid references auth.users (id) on delete set null,
  bound_at timestamptz not null default now(),
  check (
    (plan_version_id is null and mode_at_pull = ''no_plan'' and binding_reason = ''none_available'' and plan_published_at is null)
    or (plan_version_id is not null and binding_reason <> ''none_available'' and plan_published_at is not null)
  ),
  check ((binding_reason = ''manual'' and nullif(btrim(manual_reason), '''') is not null) or (binding_reason <> ''manual'' and manual_reason is null))
)","create index if not exists pull_defensive_plan_binding_plan_idx
  on pull_defensive_plan_binding (plan_version_id, bound_at desc)","create table if not exists pull_defensive_plan_binding_audit (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null references pulls (id) on delete cascade,
  previous_plan_version_id uuid references defensive_plan_versions (id) on delete restrict,
  new_plan_version_id uuid references defensive_plan_versions (id) on delete restrict,
  previous_mode text not null check (previous_mode in (''full'', ''partial'', ''no_plan'')),
  new_mode text not null check (new_mode in (''full'', ''partial'', ''no_plan'')),
  reason text not null check (nullif(btrim(reason), '''') is not null),
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now()
)","create or replace function defensive_plan_assert_draft()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_plan_id uuid;
  v_status text;
begin
  if tg_op = ''DELETE'' then
    v_plan_id := old.plan_version_id;
  else
    v_plan_id := new.plan_version_id;
  end if;
  select status into v_status from defensive_plan_versions where id = v_plan_id for share;
  if v_status is distinct from ''draft'' then
    raise exception ''El contenido de un plan publicado es inmutable.'' using errcode = ''55000'';
  end if;
  if tg_op = ''DELETE'' then return old; end if;
  return new;
end;
$$","drop trigger if exists defensive_plan_members_draft_only on defensive_plan_members","create trigger defensive_plan_members_draft_only
before insert or update or delete on defensive_plan_members
for each row execute function defensive_plan_assert_draft()","drop trigger if exists defensive_plan_slots_draft_only on defensive_plan_slots","create trigger defensive_plan_slots_draft_only
before insert or update or delete on defensive_plan_slots
for each row execute function defensive_plan_assert_draft()","create or replace function defensive_plan_assert_version_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = ''DELETE'' then
    if old.status = ''published'' then
      raise exception ''Un plan publicado no se puede borrar.'' using errcode = ''55000'';
    end if;
    return old;
  end if;
  if old.status = ''published'' then
    raise exception ''Un plan publicado es inmutable.'' using errcode = ''55000'';
  end if;
  return new;
end;
$$","drop trigger if exists defensive_plan_versions_immutable_published on defensive_plan_versions","create trigger defensive_plan_versions_immutable_published
before update or delete on defensive_plan_versions
for each row execute function defensive_plan_assert_version_mutation()","create or replace function publish_defensive_plan(p_plan_version_id uuid, p_published_by uuid default null)
returns defensive_plan_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan defensive_plan_versions;
  v_uncovered integer;
  v_assigned integer;
  v_fingerprint text;
  v_current_profile_revision timestamptz;
  v_current_catalog_revision timestamptz;
begin
  select * into v_plan from defensive_plan_versions where id = p_plan_version_id for update;
  if not found then raise exception ''Plan no encontrado.'' using errcode = ''P0002''; end if;
  if v_plan.status <> ''draft'' then raise exception ''El plan ya está publicado.'' using errcode = ''55000''; end if;
  if not v_plan.backend_resolved then
    raise exception ''El draft no fue resuelto por backend y no se puede publicar.'' using errcode = ''23514'';
  end if;

  select max(revision) into v_current_profile_revision
  from (
    select max(updated_at) as revision from boss_mechanic_occurrence_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
    union all
    select max(updated_at) from boss_mechanic_defensive_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
    union all
    select max(updated_at) from boss_mechanic_defensive_local_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
  ) revisions;
  if v_plan.source_profile_revision is null or (v_current_profile_revision is not null and v_plan.source_profile_revision < v_current_profile_revision) then
    raise exception ''El perfil de mecánicas cambió; recalcula un draft antes de publicar.'' using errcode = ''55000'';
  end if;

  select max(revision) into v_current_catalog_revision
  from (
    select max(updated_at) as revision from cooldown_catalog
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from defensive_spec_profiles
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from defensive_modifier_rules
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from player_defensive_overrides
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
  ) revisions;
  if v_plan.source_catalog_revision is null or (v_current_catalog_revision is not null and v_plan.source_catalog_revision < v_current_catalog_revision) then
    raise exception ''El catálogo/reglas defensivas cambió; recalcula un draft antes de publicar.'' using errcode = ''55000'';
  end if;

  select
    count(*) filter (where coverage_status in (''partial'', ''uncovered'')),
    count(*) filter (where assigned_player_key is not null)
  into v_uncovered, v_assigned
  from defensive_plan_slots
  where plan_version_id = p_plan_version_id;

  if v_plan.plan_mode = ''full'' and (v_uncovered > 0 or v_assigned = 0) then
    raise exception ''Un plan full debe cubrir todos los slots y contener al menos una asignación.'' using errcode = ''23514'';
  end if;
  if v_plan.plan_mode = ''no_plan'' and v_assigned > 0 then
    raise exception ''Un plan no_plan no puede contener asignaciones.'' using errcode = ''23514'';
  end if;

  select md5(
    to_jsonb(v_plan)::text || ''|'' ||
    coalesce((select jsonb_agg(to_jsonb(m) - ''created_at'' order by m.player_key)::text
              from defensive_plan_members m where m.plan_version_id = p_plan_version_id), ''[]'') || ''|'' ||
    coalesce((select jsonb_agg(to_jsonb(s) - ''created_at'' order by s.occurrence_time_ms, s.ability_id, s.occurrence_index, s.slot_index)::text
              from defensive_plan_slots s where s.plan_version_id = p_plan_version_id), ''[]'')
  ) into v_fingerprint;

  update defensive_plan_versions
  set status = ''published'', published_at = now(), published_by = p_published_by, content_fingerprint = v_fingerprint
  where id = p_plan_version_id
  returning * into v_plan;
  return v_plan;
end;
$$","create or replace function bind_pull_to_defensive_plan(
  p_pull_id uuid,
  p_plan_version_id uuid,
  p_binding_reason text default ''manual'',
  p_bound_by uuid default null,
  p_manual_reason text default null
)
returns pull_defensive_plan_binding
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull pulls;
  v_plan defensive_plan_versions;
  v_binding pull_defensive_plan_binding;
begin
  select * into v_pull from pulls where id = p_pull_id for update;
  if not found then raise exception ''Pull no encontrado.'' using errcode = ''P0002''; end if;
  select * into v_plan from defensive_plan_versions where id = p_plan_version_id;
  if not found or v_plan.status <> ''published'' then
    raise exception ''Solo se puede desplegar un plan publicado.'' using errcode = ''23514'';
  end if;
  if v_plan.boss_id <> v_pull.boss_id or v_plan.difficulty <> v_pull.difficulty then
    raise exception ''El plan no corresponde al boss y dificultad del pull.'' using errcode = ''23514'';
  end if;
  if p_binding_reason not in (''published_at_fight'', ''manual'') then
    raise exception ''binding_reason inválido.'' using errcode = ''23514'';
  end if;
  if p_binding_reason = ''manual'' and nullif(btrim(p_manual_reason), '''') is null then
    raise exception ''Un override manual exige motivo auditable.'' using errcode = ''23514'';
  end if;

  insert into pull_defensive_plan_binding (
    pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
  )
  values (
    p_pull_id, p_plan_version_id, v_plan.plan_mode, p_binding_reason, v_plan.published_at,
    case when p_binding_reason = ''manual'' then btrim(p_manual_reason) else null end,
    p_bound_by
  )
  on conflict (pull_id) do nothing
  returning * into v_binding;

  if v_binding.pull_id is null then
    select * into v_binding from pull_defensive_plan_binding where pull_id = p_pull_id;
    if v_binding.plan_version_id is not distinct from p_plan_version_id then return v_binding; end if;
    if p_binding_reason <> ''manual'' then
      raise exception ''El pull ya tiene binding; no se reinterpreta automáticamente.'' using errcode = ''55000'';
    end if;
    insert into pull_defensive_plan_binding_audit (
      pull_id, previous_plan_version_id, new_plan_version_id, previous_mode, new_mode, reason, changed_by
    ) values (
      p_pull_id, v_binding.plan_version_id, p_plan_version_id, v_binding.mode_at_pull, v_plan.plan_mode,
      btrim(p_manual_reason), p_bound_by
    );
    update pull_defensive_plan_binding
    set plan_version_id = p_plan_version_id,
        mode_at_pull = v_plan.plan_mode,
        binding_reason = ''manual'',
        plan_published_at = v_plan.published_at,
        manual_reason = btrim(p_manual_reason),
        bound_by = p_bound_by,
        bound_at = now()
    where pull_id = p_pull_id
    returning * into v_binding;
  end if;
  return v_binding;
end;
$$","create or replace function bind_pull_to_current_defensive_plan(p_pull_id uuid)
returns pull_defensive_plan_binding
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull pulls;
  v_plan_id uuid;
  v_existing pull_defensive_plan_binding;
begin
  select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
  if found then return v_existing; end if;
  select * into v_pull from pulls where id = p_pull_id;
  if not found then raise exception ''Pull no encontrado.'' using errcode = ''P0002''; end if;

  if v_pull.observed_at is null then
    insert into pull_defensive_plan_binding (
      pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
    ) values (p_pull_id, null, ''no_plan'', ''none_available'', null, null, null)
    on conflict (pull_id) do nothing
    returning * into v_existing;
    if v_existing.pull_id is null then
      select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
    end if;
    return v_existing;
  end if;

  select id into v_plan_id
  from defensive_plan_versions
  where boss_id = v_pull.boss_id
    and difficulty = v_pull.difficulty
    and status = ''published''
    and published_at <= v_pull.observed_at
    and (
      game_build is null
      or exists (
        select 1 from player_pull_records record
        where record.pull_id = v_pull.id and record.game_build = defensive_plan_versions.game_build
      )
    )
  order by published_at desc, id
  limit 1;
  if v_plan_id is null then
    insert into pull_defensive_plan_binding (
      pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
    ) values (p_pull_id, null, ''no_plan'', ''none_available'', null, null, null)
    on conflict (pull_id) do nothing
    returning * into v_existing;
    if v_existing.pull_id is null then
      select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
    end if;
    return v_existing;
  end if;
  return bind_pull_to_defensive_plan(p_pull_id, v_plan_id, ''published_at_fight'', null, null);
end;
$$","alter table defensive_plan_versions enable row level security","alter table defensive_plan_members enable row level security","alter table defensive_plan_slots enable row level security","alter table pull_defensive_plan_binding enable row level security","alter table pull_defensive_plan_binding_audit enable row level security","drop policy if exists \"defensive_plan_versions: officers read\" on defensive_plan_versions","create policy \"defensive_plan_versions: officers read\" on defensive_plan_versions for select using (is_officer())","drop policy if exists \"defensive_plan_members: officers read\" on defensive_plan_members","create policy \"defensive_plan_members: officers read\" on defensive_plan_members for select using (is_officer())","drop policy if exists \"defensive_plan_slots: officers read\" on defensive_plan_slots","create policy \"defensive_plan_slots: officers read\" on defensive_plan_slots for select using (is_officer())","drop policy if exists \"pull_defensive_plan_binding: officers read\" on pull_defensive_plan_binding","create policy \"pull_defensive_plan_binding: officers read\" on pull_defensive_plan_binding for select using (is_officer())","drop policy if exists \"pull_defensive_plan_binding_audit: officers read\" on pull_defensive_plan_binding_audit","create policy \"pull_defensive_plan_binding_audit: officers read\" on pull_defensive_plan_binding_audit for select using (is_officer())","revoke all on defensive_plan_versions, defensive_plan_members, defensive_plan_slots, pull_defensive_plan_binding, pull_defensive_plan_binding_audit from anon, authenticated","grant select on defensive_plan_versions, defensive_plan_members, defensive_plan_slots, pull_defensive_plan_binding, pull_defensive_plan_binding_audit to authenticated","revoke all on function publish_defensive_plan(uuid, uuid) from public","revoke all on function bind_pull_to_defensive_plan(uuid, uuid, text, uuid, text) from public","revoke all on function bind_pull_to_current_defensive_plan(uuid) from public","grant execute on function publish_defensive_plan(uuid, uuid) to service_role","grant execute on function bind_pull_to_defensive_plan(uuid, uuid, text, uuid, text) to service_role","grant execute on function bind_pull_to_current_defensive_plan(uuid) to service_role","comment on table defensive_plan_versions is
  ''Cada ejecución crea una versión. Publicar la vuelve inmutable; una corrección crea otra versión.''","comment on table defensive_plan_members is
  ''Snapshot del roster y kit efectivo que el solver vio. Nunca se resuelve de nuevo dentro de un plan publicado.''","comment on table defensive_plan_slots is
  ''Asignaciones desplegadas por occurrence. Es la única fuente válida para MRT v2 y evaluator v2.''","comment on table pull_defensive_plan_binding is
  ''Versión exacta desplegada para el pull. Una vez ligada no se sustituye silenciosamente.''","comment on table pull_defensive_plan_binding_audit is
  ''Única excepción al binding inmutable: override manual de oficial, siempre con motivo y before/after.''"}', 'defensive_plan_deployments', NULL, NULL, NULL),
	('20260901120000', '{"-- Gestión defensiva v2 · Bloque I · evaluación post-pull autoritativa

create table if not exists player_pull_defensive_evaluations (
  pull_id uuid not null references pulls (id) on delete cascade,
  player_name text not null,
  plan_version_id uuid references defensive_plan_versions (id) on delete restrict,
  mode text not null check (mode in (''full'', ''partial'', ''no_plan'')),
  game_build text,
  build_fingerprint text,
  resolver_version text not null,
  solver_version text not null,
  evaluator_version text not null,
  plan_required_count integer not null default 0 check (plan_required_count >= 0),
  plan_executed_count integer not null default 0 check (plan_executed_count >= 0 and plan_executed_count <= plan_required_count),
  critical_window_count integer not null default 0 check (critical_window_count >= 0),
  critical_covered_count integer not null default 0 check (critical_covered_count >= 0 and critical_covered_count <= critical_window_count),
  correct_hold_count integer not null default 0 check (correct_hold_count >= 0),
  broken_reservation_count integer not null default 0 check (broken_reservation_count >= 0),
  reminder_missed_count integer not null default 0 check (reminder_missed_count >= 0),
  viable_extra_count integer not null default 0 check (viable_extra_count >= 0),
  extra_used_count integer not null default 0 check (extra_used_count >= 0),
  death_viable_cd_count integer not null default 0 check (death_viable_cd_count >= 0),
  management_score numeric check (management_score is null or management_score between 0 and 100),
  data_confidence text not null check (data_confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  events jsonb not null default ''[]''::jsonb check (jsonb_typeof(events) = ''array''),
  evaluated_at timestamptz not null default now(),
  primary key (pull_id, player_name)
)","create index if not exists player_pull_defensive_evaluations_plan_idx
  on player_pull_defensive_evaluations (plan_version_id, evaluated_at desc)","create index if not exists player_pull_defensive_evaluations_scoring_idx
  on player_pull_defensive_evaluations (evaluator_version, data_confidence, evaluated_at desc)","alter table player_pull_defensive_evaluations enable row level security","drop policy if exists \"player_pull_defensive_evaluations: officers read\" on player_pull_defensive_evaluations","create policy \"player_pull_defensive_evaluations: officers read\"
  on player_pull_defensive_evaluations for select using (is_officer())","revoke all on player_pull_defensive_evaluations from anon, authenticated","grant select on player_pull_defensive_evaluations to authenticated","comment on table player_pull_defensive_evaluations is
  ''Una fila autoritativa por jugador+pull. Conserva resultados y reason codes del replay global sin reinterpretar el plan ligado.''","comment on column player_pull_defensive_evaluations.events is
  ''Eventos explicables con estado semántico, cobertura, adherencia, timeline y evidencia contrafactual.''"}', 'defensive_execution_evaluations', NULL, NULL, NULL),
	('20260901130000', '{"-- Gestión defensiva v2 · Bloque K · columnas aditivas y modo sombra.
-- La vista anterior se conserva íntegra como fuente legacy interna. La vista
-- pública mantiene todas sus columnas, en el mismo orden, y añade al final la
-- evaluación semántica v2. Esto evita reescribir de nuevo la consulta legacy
-- y permite retirar sus cálculos por etapas en el bloque L.

alter view player_pull_reliability_inputs
  rename to player_pull_reliability_inputs_legacy_v1","create view player_pull_reliability_inputs
with (security_invoker = true) as
select
  legacy.*,
  evaluation.management_score as defensive_management_score_v2,
  case
    when evaluation.pull_id is null then null
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where event->>''state'' in (
        ''plan_broken'',
        ''death_with_viable_cd'',
        ''safe_extra_use'',
        ''missed_extra_opportunity''
      )
      or (
        event->>''state'' in (''plan_covered'', ''covered_with_substitution'', ''reminder_missed'')
        and event->>''requirementLevel'' in (''required'', ''recommended'')
      )
    )
  end as defensive_management_decision_count,
  evaluation.plan_required_count as defensive_required_count,
  case
    when evaluation.pull_id is null then null
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where event->>''requirementLevel'' = ''required''
        and event->>''state'' in (''plan_covered'', ''covered_with_substitution'')
    )
  end as defensive_required_success_count,
  evaluation.broken_reservation_count as defensive_broken_reservation_count,
  evaluation.death_viable_cd_count as defensive_death_viable_cd_count,
  evaluation.data_confidence as defensive_evaluation_confidence,
  evaluation.evaluator_version as defensive_evaluator_version
from player_pull_reliability_inputs_legacy_v1 legacy
left join player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = legacy.pull_id
 and evaluation.player_name = legacy.player_name","alter view player_pull_reliability_inputs_legacy_v1 set (security_invoker = true)","revoke all on player_pull_reliability_inputs_legacy_v1 from anon, authenticated","grant select on player_pull_reliability_inputs_legacy_v1 to authenticated","revoke all on player_pull_reliability_inputs from anon, authenticated","grant select on player_pull_reliability_inputs to authenticated","comment on view player_pull_reliability_inputs is
  ''Fuente por pull de Fiabilidad: conserva señales legacy y añade evaluación defensiva v2. La elección v1/v2 se hace de forma atómica por fila en ReliabilityService.''","comment on column player_pull_reliability_inputs.defensive_management_score_v2 is
  ''Puntuación semántica 0-100 calculada solo con decisiones evaluables; null sin evaluación fiable/backfill.''","comment on column player_pull_reliability_inputs.defensive_management_decision_count is
  ''Número de decisiones que participaron en la fórmula v2; optional/hold/no-feasible/uncertain quedan fuera.''","comment on column player_pull_reliability_inputs.defensive_evaluation_confidence is
  ''Confianza de la evaluación autoritativa; ReliabilityService solo activa v2 con verified/inferred.''"}', 'reliability_v2_columns', NULL, NULL, NULL),
	('20260901140000', '{"-- Gestión defensiva v2 · Bloque L · frontera de deprecación legacy.
-- No se eliminan columnas durante el rollout: siguen siendo necesarias para
-- registros sin backfill y para comparar v1/v2. Esta migración documenta en el
-- propio contrato SQL que ya no son fuentes autorizadas de scoring v2.

comment on view player_pull_reliability_inputs_legacy_v1 is
  ''Compatibilidad temporal v1. No añadir consumidores nuevos; retirar después de backfill completo, calibración y activación estable de defensiveReliabilityV2.''","comment on column player_pull_reliability_inputs.defensive_window_coverable_count is
  ''DEPRECATED para scoring: sensor v1 conservado solo para fallback/shadow de pulls sin evaluación v2 fiable.''","comment on column player_pull_reliability_inputs.used_defensive_when_died is
  ''DEPRECATED para scoring v2: evidencia legacy conservada para fallback/shadow y UI histórica.''","comment on column player_pull_reliability_inputs.used_defensive_in_pull is
  ''DEPRECATED para scoring v2: booleano legacy; usar defensive_management_score_v2 cuando la fila sea fiable.''","comment on column player_pull_reliability_inputs.defensive_use_opportunity is
  ''DEPRECATED para scoring v2: oportunidad legacy; usar eventos semánticos de player_pull_defensive_evaluations.''","comment on column player_pull_records.defensive_pressure_windows is
  ''DEPRECATED como autoridad: contrato v1 de compatibilidad. Nuevos cálculos se proyectan desde defensive_pressure_windows_v2; coverable no puntúa.''","comment on column player_pull_records.defensive_pressure_windows_v2 is
  ''Sensor v2 resuelto por build/talentos/cargas. availableOpportunity es diagnóstico; solo player_pull_defensive_evaluations decide y puntúa.''","comment on column player_pull_records.death_defensive_options_v2 is
  ''Estado defensivo autoritativo por resolver/state engine v2; death_cause.defensiveOptions es solo proyección legacy.''"}', 'deprecate_legacy_defensive_scoring', NULL, NULL, NULL),
	('20260901150000', '{"-- IRIS Defensivos v2 · consolidación visual · override exacto y auditable
--
-- No elimina overrides antiguos con fingerprint null: se conservan para
-- auditoría/rollback, pero el resolver v2 ya no los consume. Toda escritura
-- nueva exige jugador + hechizo + game_build + fingerprint exactos.

create table if not exists player_defensive_override_audit (
  id uuid primary key default gen_random_uuid(),
  override_id uuid not null references player_defensive_overrides (id) on delete restrict,
  action text not null check (action in (''created'', ''updated'', ''deactivated'')),
  automatic_effective_cooldown_ms integer check (automatic_effective_cooldown_ms is null or automatic_effective_cooldown_ms >= 0),
  automatic_effective_duration_ms integer check (automatic_effective_duration_ms is null or automatic_effective_duration_ms >= 0),
  previous_override jsonb,
  resulting_override jsonb not null check (jsonb_typeof(resulting_override) = ''object''),
  reason text not null check (btrim(reason) <> ''''),
  changed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
)","create index if not exists player_defensive_override_audit_scope_idx
  on player_defensive_override_audit (override_id, created_at desc)","alter table player_defensive_override_audit enable row level security","drop policy if exists \"player_defensive_override_audit: officers read\" on player_defensive_override_audit","create policy \"player_defensive_override_audit: officers read\"
  on player_defensive_override_audit for select using (is_officer())","revoke all on player_defensive_override_audit from anon, authenticated","grant select on player_defensive_override_audit to authenticated","create or replace function save_exact_player_defensive_override(
  p_character_id bigint,
  p_player_name text,
  p_class text,
  p_spec text,
  p_spell_id bigint,
  p_game_build text,
  p_build_fingerprint text,
  p_effective_cooldown_ms integer,
  p_effective_duration_ms integer,
  p_automatic_cooldown_ms integer,
  p_automatic_duration_ms integer,
  p_reason text,
  p_changed_by uuid,
  p_active boolean default true
)
returns player_defensive_overrides
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing player_defensive_overrides;
  v_result player_defensive_overrides;
  v_action text;
begin
  if p_character_id is null or p_character_id <= 0 then raise exception ''character_id exacto obligatorio.'' using errcode = ''23514''; end if;
  if nullif(btrim(p_player_name), '''') is null then raise exception ''player_name obligatorio.'' using errcode = ''23514''; end if;
  if nullif(btrim(p_class), '''') is null then raise exception ''class obligatoria.'' using errcode = ''23514''; end if;
  if p_spell_id is null or p_spell_id <= 0 then raise exception ''spell_id inválido.'' using errcode = ''23514''; end if;
  if nullif(btrim(p_game_build), '''') is null then raise exception ''game_build exacto obligatorio.'' using errcode = ''23514''; end if;
  if p_build_fingerprint !~ ''^sha256:[a-f0-9]{64}$'' then raise exception ''build_fingerprint exacto obligatorio.'' using errcode = ''23514''; end if;
  if nullif(btrim(p_reason), '''') is null then raise exception ''Motivo auditable obligatorio.'' using errcode = ''23514''; end if;
  if p_active and p_effective_cooldown_ms is null and p_effective_duration_ms is null then
    raise exception ''Debe corregirse cooldown o duración.'' using errcode = ''23514'';
  end if;
  if p_effective_cooldown_ms is not null and p_effective_cooldown_ms < 0 then raise exception ''Cooldown inválido.'' using errcode = ''23514''; end if;
  if p_effective_duration_ms is not null and p_effective_duration_ms < 0 then raise exception ''Duración inválida.'' using errcode = ''23514''; end if;

  select * into v_existing
  from player_defensive_overrides
  where active
    and character_id = p_character_id
    and class = btrim(p_class)
    and spec is not distinct from nullif(btrim(p_spec), '''')
    and spell_id = p_spell_id
    and game_build = btrim(p_game_build)
    and build_fingerprint = p_build_fingerprint
  for update;

  if not p_active then
    if v_existing.id is null then raise exception ''No existe override exacto activo.'' using errcode = ''P0002''; end if;
    update player_defensive_overrides
    set active = false, reason = btrim(p_reason), updated_by = p_changed_by, updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    v_action := ''deactivated'';
  elsif v_existing.id is null then
    insert into player_defensive_overrides (
      character_id, player_name, class, spec, spell_id, build_fingerprint, game_build,
      effective_cooldown_ms, effective_duration_ms, reason, active, created_by, updated_by
    ) values (
      p_character_id, btrim(p_player_name), btrim(p_class), nullif(btrim(p_spec), ''''), p_spell_id,
      p_build_fingerprint, btrim(p_game_build), p_effective_cooldown_ms,
      p_effective_duration_ms, btrim(p_reason), true, p_changed_by, p_changed_by
    ) returning * into v_result;
    v_action := ''created'';
  else
    update player_defensive_overrides
    set effective_cooldown_ms = p_effective_cooldown_ms,
        effective_duration_ms = p_effective_duration_ms,
        reason = btrim(p_reason),
        updated_by = p_changed_by,
        updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    v_action := ''updated'';
  end if;

  insert into player_defensive_override_audit (
    override_id, action, automatic_effective_cooldown_ms, automatic_effective_duration_ms,
    previous_override, resulting_override, reason, changed_by
  ) values (
    v_result.id, v_action, p_automatic_cooldown_ms, p_automatic_duration_ms,
    case when v_existing.id is null then null else to_jsonb(v_existing) end,
    to_jsonb(v_result), btrim(p_reason), p_changed_by
  );
  return v_result;
end;
$$","revoke all on function save_exact_player_defensive_override(
  bigint, text, text, text, bigint, text, text, integer, integer, integer, integer, text, uuid, boolean
) from public, anon, authenticated","grant execute on function save_exact_player_defensive_override(
  bigint, text, text, text, bigint, text, text, integer, integer, integer, integer, text, uuid, boolean
) to service_role","comment on table player_defensive_override_audit is
  ''Historial inmutable de correcciones efectivas exactas, incluido valor automático anterior, manual resultante, autor y motivo.''","comment on column player_defensive_overrides.build_fingerprint is
  ''Scope exacto del build de talentos. Las filas legacy con null se conservan para auditoría/rollback, pero el resolver v2 no las aplica.''"}', 'exact_player_defensive_override_audit', NULL, NULL, NULL),
	('20260901160000', '{"-- IRIS Defensivos v2 · reparación forward de deriva M1
--
-- 20260831200000 figura aplicada en el proyecto remoto, pero fue registrada
-- antes de que su copia local incorporase targeting_mode. No se reescribe el
-- historial ni se marca M1 como reverted: esta migración aditiva materializa
-- de forma idempotente el contrato que el resolver v2 necesita.

alter table cooldown_catalog
  add column if not exists targeting_mode text not null default ''unknown''","alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_targeting_mode_check","alter table cooldown_catalog
  add constraint cooldown_catalog_targeting_mode_check
  check (targeting_mode in (''self'', ''ally'', ''both'', ''raid'', ''unknown''))","-- Solo se derivan categorías cuyo target es inequívoco en el contrato
-- existente. External permanece unknown hasta disponer de target/aura real.
update cooldown_catalog
set targeting_mode = case
  when category = ''personal_defensive'' then ''self''
  when category = ''semi_defensive'' then ''both''
  else ''unknown''
end
where targeting_mode = ''unknown''
  and category in (''personal_defensive'', ''semi_defensive'')","comment on column cooldown_catalog.targeting_mode is
  ''A quién puede proteger realmente el spell. external/unknown no puede atribuirse como cobertura propia sin target o aura observada.''","-- Evita que PostgREST conserve temporalmente un schema anterior después del
-- push y que readiness devuelva PGRST204 aunque la columna ya exista.
notify pgrst, ''reload schema''"}', 'repair_cooldown_catalog_targeting_mode', NULL, NULL, NULL),
	('20260901170000', '{"-- IRIS Defensivos v2 · reparación forward del resto del contrato M1
--
-- El historial remoto registra 20260831200000 como aplicada, pero la base
-- conserva el schema v5 de defensive_spec_profiles (sin game_build). La
-- reparación anterior 20260901160000 cerró targeting_mode. Esta migración
-- reexpresa de forma idempotente el versionado de perfiles y modificadores,
-- sin reescribir ni marcar como revertida una migración histórica.

alter table defensive_spec_profiles
  add column if not exists game_build text not null default ''legacy-current'',
  add column if not exists recharge_ms integer","alter table defensive_spec_profiles
  drop constraint if exists defensive_spec_profiles_recharge_ms_check","alter table defensive_spec_profiles
  add constraint defensive_spec_profiles_recharge_ms_check
  check (recharge_ms is null or recharge_ms >= 0)","alter table defensive_spec_profiles
  drop constraint if exists defensive_spec_profiles_game_build_check","alter table defensive_spec_profiles
  add constraint defensive_spec_profiles_game_build_check
  check (btrim(game_build) <> '''')","-- La PK v5 no permite dos builds del mismo perfil. Las filas existentes
-- reciben legacy-current antes de reconstruirla, por lo que no se pierden.
alter table defensive_spec_profiles
  drop constraint if exists defensive_spec_profiles_pkey","alter table defensive_spec_profiles
  add constraint defensive_spec_profiles_pkey
  primary key (class, spec, spell_id, game_build)","comment on column defensive_spec_profiles.game_build is
  ''Build exacto X.Y.Z.build al que pertenece el perfil. legacy-current = fila v5 anterior al versionado; solo puede consumirse como fallback con provenance.''","comment on column defensive_spec_profiles.recharge_ms is
  ''Tiempo de recarga por carga cuando difiere del cooldown conceptual. Null = usar el cooldown efectivo como recharge.''","alter table defensive_modifier_rules
  add column if not exists game_build text not null default ''legacy-current'',
  add column if not exists effect_field text not null default ''cooldown_ms'',
  add column if not exists application_order integer not null default 100","-- charges_add es el único operation legacy cuyo campo afectado es
-- inequívoco. El resto conserva cooldown_ms y confidence de fallback.
update defensive_modifier_rules
set effect_field = ''charges''
where operation = ''charges_add''","alter table defensive_modifier_rules
  drop constraint if exists defensive_modifier_rules_game_build_check","alter table defensive_modifier_rules
  add constraint defensive_modifier_rules_game_build_check
  check (btrim(game_build) <> '''')","alter table defensive_modifier_rules
  drop constraint if exists defensive_modifier_rules_effect_field_check","alter table defensive_modifier_rules
  add constraint defensive_modifier_rules_effect_field_check
  check (effect_field in (''cooldown_ms'', ''duration_ms'', ''charges'', ''recharge_ms''))","alter table defensive_modifier_rules
  drop constraint if exists defensive_modifier_rules_operation_field_check","alter table defensive_modifier_rules
  add constraint defensive_modifier_rules_operation_field_check
  check (
    (operation = ''charges_add'' and effect_field = ''charges'')
    or
    (operation <> ''charges_add'' and effect_field <> ''charges'')
  )","-- Sustituye tanto el UNIQUE v5 como una posible aplicación parcial del
-- UNIQUE v2. No depende del nombre autogenerado por PostgreSQL.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = ''defensive_modifier_rules''::regclass
      and contype = ''u''
  loop
    execute format(
      ''alter table defensive_modifier_rules drop constraint %I'',
      constraint_name
    );
  end loop;
end $$","alter table defensive_modifier_rules
  add constraint defensive_modifier_rules_version_key
  unique (
    class,
    modifier_spell_id,
    target_spell_id,
    operation,
    effect_field,
    game_build
  )","comment on column defensive_modifier_rules.game_build is
  ''Build exacto X.Y.Z.build de la regla. legacy-current conserva research v5 previo al versionado y nunca equivale a una coincidencia histórica verificada.''","comment on column defensive_modifier_rules.effect_field is
  ''Campo efectivo modificado: cooldown_ms, duration_ms, charges o recharge_ms.''","comment on column defensive_modifier_rules.application_order is
  ''Orden declarativo dentro de un mismo defensivo/build. Empates se resuelven por precedencia de operación e id; sets incompatibles degradan confidence a uncertain.''","create index if not exists defensive_modifier_rules_resolution_idx
  on defensive_modifier_rules (class, target_spell_id, game_build)
  where active = true","create index if not exists defensive_modifier_rules_modifier_idx
  on defensive_modifier_rules (modifier_spell_id, game_build)
  where active = true","drop policy if exists \"defensive_spec_profiles: officers read\" on defensive_spec_profiles","create policy \"defensive_spec_profiles: officers read\"
  on defensive_spec_profiles for select
  using (is_officer())","drop policy if exists \"defensive_modifier_rules: officers read\" on defensive_modifier_rules","create policy \"defensive_modifier_rules: officers read\"
  on defensive_modifier_rules for select
  using (is_officer())","revoke all on defensive_spec_profiles from anon","revoke all on defensive_modifier_rules from anon","grant select on defensive_spec_profiles to authenticated","grant select on defensive_modifier_rules to authenticated","notify pgrst, ''reload schema''"}', 'repair_effective_defensive_profile_versioning', NULL, NULL, NULL),
	('20260901180000', '{"-- IRIS Defensivos v2 · semántica activa/pasiva por build
--
-- Una fila del catálogo puede representar una habilidad que deja de ser un
-- botón asignable al seleccionar otro talento (por ejemplo, una conversión
-- a pasiva). category/targeting_mode no expresan esa disponibilidad.

alter table cooldown_catalog
  add column if not exists activation_mode text not null default ''active'',
  add column if not exists passive_conversion_spell_ids bigint[] not null default ''{}'',
  add column if not exists activation_game_build text not null default ''legacy-current''","alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_activation_mode_check","alter table cooldown_catalog
  add constraint cooldown_catalog_activation_mode_check
  check (activation_mode in (''active'', ''passive''))","alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_activation_game_build_check","alter table cooldown_catalog
  add constraint cooldown_catalog_activation_game_build_check
  check (btrim(activation_game_build) <> '''')","alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_passive_conversion_ids_check","alter table cooldown_catalog
  add constraint cooldown_catalog_passive_conversion_ids_check
  check (
    array_position(passive_conversion_spell_ids, null) is null
    and 0::bigint < all(passive_conversion_spell_ids)
  )","comment on column cooldown_catalog.activation_mode is
  ''Forma base actual de la habilidad: active puede asignarse; passive solo se muestra como contexto y nunca entra al solver/reminder.''","comment on column cooldown_catalog.passive_conversion_spell_ids is
  ''Talentos/pasivas cuyo spellId seleccionado convierte esta habilidad activa en pasiva o elimina su botón asignable.''","comment on column cooldown_catalog.activation_game_build is
  ''Build para el que se verificaron activation_mode y passive_conversion_spell_ids. legacy-current conserva filas anteriores sin fingir versionado exacto.''","-- Fiabilidad no puede considerar materializada una evaluación calculada con
-- un resolver anterior: el evaluator puede ser el mismo y, aun así, haber
-- tratado como asignable un botón convertido en pasiva.
create or replace view player_pull_reliability_inputs
with (security_invoker = true) as
select
  legacy.*,
  evaluation.management_score as defensive_management_score_v2,
  case
    when evaluation.pull_id is null then null
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where event->>''state'' in (
        ''plan_broken'',
        ''death_with_viable_cd'',
        ''safe_extra_use'',
        ''missed_extra_opportunity''
      )
      or (
        event->>''state'' in (''plan_covered'', ''covered_with_substitution'', ''reminder_missed'')
        and event->>''requirementLevel'' in (''required'', ''recommended'')
      )
    )
  end as defensive_management_decision_count,
  evaluation.plan_required_count as defensive_required_count,
  case
    when evaluation.pull_id is null then null
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where event->>''requirementLevel'' = ''required''
        and event->>''state'' in (''plan_covered'', ''covered_with_substitution'')
    )
  end as defensive_required_success_count,
  evaluation.broken_reservation_count as defensive_broken_reservation_count,
  evaluation.death_viable_cd_count as defensive_death_viable_cd_count,
  evaluation.data_confidence as defensive_evaluation_confidence,
  evaluation.evaluator_version as defensive_evaluator_version,
  evaluation.resolver_version as defensive_resolver_version
from player_pull_reliability_inputs_legacy_v1 legacy
left join player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = legacy.pull_id
 and evaluation.player_name = legacy.player_name","revoke all on player_pull_reliability_inputs from anon, authenticated","grant select on player_pull_reliability_inputs to authenticated","comment on column player_pull_reliability_inputs.defensive_resolver_version is
  ''Versión exacta del resolver con la que se materializó la evaluación; Fiabilidad v2 solo consume la versión vigente.''","notify pgrst, ''reload schema''"}', 'defensive_activation_semantics', NULL, NULL, NULL),
	('20260901190000', '{"-- Causalidad v3 · Bloque A / M11 · contexto autoritativo por pull.
-- Aditiva: los campos wipe/ninja legacy se conservan y se proyectan desde la
-- nueva autoridad únicamente cuando se use la RPC de transición.

create table if not exists pull_evaluation_context (
  pull_id uuid primary key references pulls (id) on delete cascade,
  evaluation_eligible boolean not null default true,
  evaluation_start_ms integer not null default 0 check (evaluation_start_ms >= 0),
  evaluation_end_ms integer not null check (evaluation_end_ms >= evaluation_start_ms),
  cutoff_reason text not null check (cutoff_reason in (''fight_end'', ''wipe_call'', ''invalid_pull'')),
  wipe_call_at_ms integer check (wipe_call_at_ms is null or wipe_call_at_ms >= 0),
  wipe_call_boss_hp_pct numeric check (wipe_call_boss_hp_pct is null or wipe_call_boss_hp_pct between 0 and 100),
  wipe_call_source text not null default ''none''
    check (wipe_call_source in (''none'', ''manual_rl'', ''instrumented'', ''inferred'')),
  wipe_call_confidence numeric check (wipe_call_confidence is null or wipe_call_confidence between 0 and 100),
  wipe_call_verified boolean not null default false,
  ninja_status text not null default ''unknown''
    check (ninja_status in (''valid'', ''probable'', ''confirmed'', ''unknown'')),
  ninja_source text not null default ''imported''
    check (ninja_source in (''manual'', ''heuristic'', ''imported'')),
  ninja_confidence numeric check (ninja_confidence is null or ninja_confidence between 0 and 100),
  evidence jsonb not null default ''{}''::jsonb check (jsonb_typeof(evidence) = ''object''),
  resolver_version text not null check (nullif(btrim(resolver_version), '''') is not null),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((wipe_call_at_ms is null and wipe_call_source = ''none'') or (wipe_call_at_ms is not null and wipe_call_source <> ''none'')),
  check (not wipe_call_verified or wipe_call_source in (''manual_rl'', ''instrumented'')),
  check ((cutoff_reason = ''wipe_call'') = (evaluation_eligible and wipe_call_at_ms is not null)),
  check ((cutoff_reason = ''invalid_pull'') = (not evaluation_eligible)),
  check (ninja_status <> ''confirmed'' or not evaluation_eligible),
  check ((reviewed_by is null and reviewed_at is null and review_reason is null) or (reviewed_at is not null and nullif(btrim(review_reason), '''') is not null))
)","create index if not exists pull_evaluation_context_diagnostics_idx
  on pull_evaluation_context (evaluation_eligible, updated_at desc)","create index if not exists pull_evaluation_context_version_idx
  on pull_evaluation_context (resolver_version, updated_at desc)","create table if not exists pull_evaluation_context_audit (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null references pulls (id) on delete cascade,
  before_state jsonb check (before_state is null or jsonb_typeof(before_state) = ''object''),
  after_state jsonb not null check (jsonb_typeof(after_state) = ''object''),
  change_source text not null
    check (change_source in (''manual_rl'', ''instrumented'', ''inferred'', ''heuristic'', ''imported'', ''migration'')),
  reason text not null check (nullif(btrim(reason), '''') is not null),
  resolver_version text not null check (nullif(btrim(resolver_version), '''') is not null),
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now()
)","create index if not exists pull_evaluation_context_audit_pull_idx
  on pull_evaluation_context_audit (pull_id, changed_at desc)","create or replace function combat_evaluation_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$","drop trigger if exists pull_evaluation_context_touch_updated_at on pull_evaluation_context","create trigger pull_evaluation_context_touch_updated_at
before update on pull_evaluation_context
for each row execute function combat_evaluation_touch_updated_at()","-- Conserva exactamente la decisión legacy durante el backfill. Un ninja que
-- ya estaba excluido se considera confirmado por la autoridad anterior; una
-- mera señal no excluida queda como probable y no invalida el pull v3.
insert into pull_evaluation_context (
  pull_id,
  evaluation_eligible,
  evaluation_start_ms,
  evaluation_end_ms,
  cutoff_reason,
  wipe_call_at_ms,
  wipe_call_source,
  wipe_call_confidence,
  wipe_call_verified,
  ninja_status,
  ninja_source,
  ninja_confidence,
  evidence,
  resolver_version,
  created_at,
  updated_at
)
select
  p.id,
  not p.ninja_pull_excluded,
  0,
  case
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    then least(greatest(coalesce(p.duration_ms, 0), 0), greatest((p.wipe_call_signals->>''wipeCallStartMs'')::integer, 0))
    else greatest(coalesce(p.duration_ms, 0), 0)
  end,
  case
    when p.ninja_pull_excluded then ''invalid_pull''
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    then ''wipe_call''
    else ''fight_end''
  end,
  case
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    then greatest((p.wipe_call_signals->>''wipeCallStartMs'')::integer, 0)
    else null
  end,
  case
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
    then ''inferred''
    else ''none''
  end,
  case when p.wipe_call_confidence between 0 and 100 then p.wipe_call_confidence else null end,
  false,
  case when p.ninja_pull_excluded then ''confirmed'' when p.is_ninja_pull then ''probable'' else ''valid'' end,
  case when p.is_ninja_pull or p.ninja_pull_excluded then ''heuristic'' else ''imported'' end,
  case
    when jsonb_typeof(p.ninja_pull_signals->''confidence'') = ''number''
      and (p.ninja_pull_signals->>''confidence'')::numeric between 0 and 100
    then (p.ninja_pull_signals->>''confidence'')::numeric
    else null
  end,
  jsonb_build_object(
    ''legacyBackfill'', true,
    ''wipeCallSignals'', coalesce(p.wipe_call_signals, ''{}''::jsonb),
    ''ninjaPullSignals'', coalesce(p.ninja_pull_signals, ''{}''::jsonb)
  ),
  ''pull-evaluation-context@1.0.0:legacy-backfill'',
  coalesce(p.created_at, now()),
  coalesce(p.updated_at, p.closed_at, now())
from pulls p
on conflict (pull_id) do nothing","-- Único write path previsto para el bloque B. Actualiza context, audit,
-- proyección legacy y pulls.updated_at dentro de la misma transacción/RPC.
create or replace function set_pull_evaluation_context_v2(
  p_pull_id uuid,
  p_evaluation_eligible boolean,
  p_evaluation_start_ms integer,
  p_evaluation_end_ms integer,
  p_cutoff_reason text,
  p_wipe_call_at_ms integer,
  p_wipe_call_boss_hp_pct numeric,
  p_wipe_call_source text,
  p_wipe_call_confidence numeric,
  p_wipe_call_verified boolean,
  p_ninja_status text,
  p_ninja_source text,
  p_ninja_confidence numeric,
  p_evidence jsonb,
  p_resolver_version text,
  p_reason text,
  p_changed_by uuid default null
)
returns pull_evaluation_context
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull pulls;
  v_before jsonb;
  v_after jsonb;
  v_context pull_evaluation_context;
  v_change_source text;
begin
  select * into v_pull from pulls where id = p_pull_id for update;
  if not found then raise exception ''Pull no encontrado.'' using errcode = ''P0002''; end if;
  if p_evaluation_end_ms > greatest(coalesce(v_pull.duration_ms, 0), 0) then
    raise exception ''evaluation_end_ms no puede superar la duración del pull.'' using errcode = ''23514'';
  end if;

  select to_jsonb(c) into v_before from pull_evaluation_context c where c.pull_id = p_pull_id;

  insert into pull_evaluation_context (
    pull_id, evaluation_eligible, evaluation_start_ms, evaluation_end_ms, cutoff_reason,
    wipe_call_at_ms, wipe_call_boss_hp_pct, wipe_call_source, wipe_call_confidence,
    wipe_call_verified, ninja_status, ninja_source, ninja_confidence, evidence,
    resolver_version, reviewed_by, reviewed_at, review_reason
  ) values (
    p_pull_id, p_evaluation_eligible, p_evaluation_start_ms, p_evaluation_end_ms, p_cutoff_reason,
    p_wipe_call_at_ms, p_wipe_call_boss_hp_pct, p_wipe_call_source, p_wipe_call_confidence,
    p_wipe_call_verified, p_ninja_status, p_ninja_source, p_ninja_confidence, coalesce(p_evidence, ''{}''::jsonb),
    p_resolver_version,
    case when p_wipe_call_source in (''manual_rl'', ''instrumented'') or p_ninja_source = ''manual'' then p_changed_by else null end,
    case when p_wipe_call_source in (''manual_rl'', ''instrumented'') or p_ninja_source = ''manual'' then now() else null end,
    case when p_wipe_call_source in (''manual_rl'', ''instrumented'') or p_ninja_source = ''manual'' then btrim(p_reason) else null end
  )
  on conflict (pull_id) do update set
    evaluation_eligible = excluded.evaluation_eligible,
    evaluation_start_ms = excluded.evaluation_start_ms,
    evaluation_end_ms = excluded.evaluation_end_ms,
    cutoff_reason = excluded.cutoff_reason,
    wipe_call_at_ms = excluded.wipe_call_at_ms,
    wipe_call_boss_hp_pct = excluded.wipe_call_boss_hp_pct,
    wipe_call_source = excluded.wipe_call_source,
    wipe_call_confidence = excluded.wipe_call_confidence,
    wipe_call_verified = excluded.wipe_call_verified,
    ninja_status = excluded.ninja_status,
    ninja_source = excluded.ninja_source,
    ninja_confidence = excluded.ninja_confidence,
    evidence = excluded.evidence,
    resolver_version = excluded.resolver_version,
    reviewed_by = excluded.reviewed_by,
    reviewed_at = excluded.reviewed_at,
    review_reason = excluded.review_reason
  returning * into v_context;

  v_after := to_jsonb(v_context);
  if v_before is distinct from v_after then
    v_change_source := case
      when p_wipe_call_source in (''manual_rl'', ''instrumented'') then p_wipe_call_source
      when p_ninja_source = ''manual'' then ''manual_rl''
      when p_wipe_call_source = ''inferred'' then ''inferred''
      when p_ninja_source = ''heuristic'' then ''heuristic''
      else ''imported''
    end;
    insert into pull_evaluation_context_audit (
      pull_id, before_state, after_state, change_source, reason, resolver_version, changed_by
    ) values (
      p_pull_id, v_before, v_after, v_change_source, btrim(p_reason), p_resolver_version, p_changed_by
    );
  end if;

  update pulls
  set wipe_call_excluded = p_wipe_call_at_ms is not null,
      wipe_call_confidence = p_wipe_call_confidence,
      wipe_call_signals = case
        when p_wipe_call_at_ms is null then coalesce(wipe_call_signals, ''{}''::jsonb) - ''wipeCallStartMs''
        else jsonb_set(coalesce(wipe_call_signals, ''{}''::jsonb), ''{wipeCallStartMs}'', to_jsonb(p_wipe_call_at_ms), true)
      end,
      is_ninja_pull = p_ninja_status in (''probable'', ''confirmed''),
      ninja_pull_excluded = not p_evaluation_eligible or p_ninja_status = ''confirmed'',
      ninja_pull_signals = coalesce(p_evidence->''ninjaPullSignals'', ninja_pull_signals),
      updated_at = now()
  where id = p_pull_id;

  -- Proyección legacy del mismo intervalo: una muerte solo pertenece al
  -- cierre si su timestamp está en [wipe_call_at_ms, fight_end). Esto evita
  -- que un límite manual nuevo dependa del cluster que propuso el sensor.
  update player_pull_records
  set wipe_call_cluster = case
    when p_wipe_call_at_ms is null then false
    when not died or death_cause is null or jsonb_typeof(death_cause->''timeMs'') <> ''number'' then false
    else (death_cause->>''timeMs'')::numeric >= p_wipe_call_at_ms
  end
  where pull_id = p_pull_id;

  return v_context;
end;
$$","alter table pull_evaluation_context enable row level security","alter table pull_evaluation_context_audit enable row level security","drop policy if exists \"pull_evaluation_context: officers read\" on pull_evaluation_context","create policy \"pull_evaluation_context: officers read\"
  on pull_evaluation_context for select using (is_officer())","drop policy if exists \"pull_evaluation_context_audit: officers read\" on pull_evaluation_context_audit","create policy \"pull_evaluation_context_audit: officers read\"
  on pull_evaluation_context_audit for select using (is_officer())","revoke all on pull_evaluation_context, pull_evaluation_context_audit from anon, authenticated","grant select on pull_evaluation_context, pull_evaluation_context_audit to authenticated","revoke all on function set_pull_evaluation_context_v2(uuid, boolean, integer, integer, text, integer, numeric, text, numeric, boolean, text, text, numeric, jsonb, text, text, uuid) from public, anon, authenticated","grant execute on function set_pull_evaluation_context_v2(uuid, boolean, integer, integer, text, integer, numeric, text, numeric, boolean, text, text, numeric, jsonb, text, text, uuid) to service_role","comment on table pull_evaluation_context is
  ''Autoridad v3 del intervalo evaluable. Flags off mantienen consumidores legacy; la RPC proyecta cada cambio a pulls atómicamente.''","comment on table pull_evaluation_context_audit is
  ''Before/after auditable de toda corrección autoritativa de wipe/ninja/context.''"}', 'pull_evaluation_context', NULL, NULL, NULL),
	('20260901200000', '{"-- Causalidad v3 · Bloque A / M12 · identidad canónica y MechanicPolicy v2.

create table if not exists boss_mechanic_policy (
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null check (nullif(btrim(mechanic_key), '''') is not null),
  policy_version integer not null default 1 check (policy_version > 0),
  display_name text not null check (nullif(btrim(display_name), '''') is not null),
  display_category text check (display_category in (
    ''tankbuster'', ''raid-damage'', ''avoidable-ground'', ''debuff-stack'', ''interrupt'',
    ''soak'', ''spread'', ''healing-absorb'', ''personal-target'', ''enrage''
  )),
  targeting_mode text not null check (targeting_mode in (
    ''tank'', ''selected_player'', ''group'', ''raid'', ''ground'', ''object'', ''none'', ''mixed''
  )),
  required_response text check (required_response is null or nullif(btrim(required_response), '''') is not null),
  responsibility_mode text not null check (responsibility_mode in (
    ''target'', ''tank_role'', ''healer_role'', ''dps_role'', ''assigned_player'',
    ''assigned_group'', ''volunteer'', ''raid'', ''none''
  )),
  damage_semantics text not null check (damage_semantics in (
    ''mandatory'', ''avoidable'', ''partly_avoidable'', ''failure_consequence'', ''none''
  )),
  failure_propagation text not null check (failure_propagation in (
    ''self'', ''nearby_players'', ''group'', ''raid'', ''chained'', ''none''
  )),
  assignment_mode text not null check (assignment_mode in (
    ''none'', ''target_derived'', ''role_derived'', ''plan_optional'', ''plan_required''
  )),
  defensive_expectation text not null check (defensive_expectation in (
    ''none'', ''optional'', ''recommended'', ''required'', ''contingency_only''
  )),
  credit_scope text not null check (credit_scope in (''resolver'', ''target'', ''group'', ''raid'', ''none'')),
  penalty_scope text not null check (penalty_scope in (''owner'', ''assignee'', ''role'', ''raid_only'', ''none'')),
  causal_rule jsonb not null default ''{}''::jsonb check (jsonb_typeof(causal_rule) = ''object''),
  confidence text not null check (confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  provenance jsonb not null default ''{}''::jsonb check (jsonb_typeof(provenance) = ''object''),
  game_build text,
  tier_revision text,
  verified_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (boss_id, difficulty, mechanic_key),
  check (confidence <> ''verified'' or verified_at is not null),
  check (penalty_scope = ''none'' or confidence in (''verified'', ''inferred''))
)","create index if not exists boss_mechanic_policy_revision_idx
  on boss_mechanic_policy (boss_id, difficulty, mechanic_key, policy_version desc)","create index if not exists boss_mechanic_policy_review_idx
  on boss_mechanic_policy (boss_id, difficulty, confidence, verified_at desc)","drop trigger if exists boss_mechanic_policy_touch_updated_at on boss_mechanic_policy","create trigger boss_mechanic_policy_touch_updated_at
before update on boss_mechanic_policy
for each row execute function combat_evaluation_touch_updated_at()","create table if not exists boss_mechanic_policy_audit (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null,
  previous_policy_version integer check (previous_policy_version is null or previous_policy_version > 0),
  new_policy_version integer not null check (new_policy_version > 0),
  before_state jsonb check (before_state is null or jsonb_typeof(before_state) = ''object''),
  after_state jsonb not null check (jsonb_typeof(after_state) = ''object''),
  reason text not null check (nullif(btrim(reason), '''') is not null),
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  foreign key (boss_id, difficulty, mechanic_key)
    references boss_mechanic_policy (boss_id, difficulty, mechanic_key) on delete restrict
)","create index if not exists boss_mechanic_policy_audit_scope_idx
  on boss_mechanic_policy_audit (boss_id, difficulty, mechanic_key, changed_at desc)","create table if not exists boss_mechanic_aliases (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null,
  ability_id bigint check (ability_id is null or ability_id > 0),
  normalized_name text check (normalized_name is null or nullif(btrim(normalized_name), '''') is not null),
  source text not null check (source in (''journal'', ''wcl'', ''manual'', ''classifier'', ''legacy'')),
  confidence text not null check (confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  provenance jsonb not null default ''{}''::jsonb check (jsonb_typeof(provenance) = ''object''),
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (boss_id, difficulty, mechanic_key)
    references boss_mechanic_policy (boss_id, difficulty, mechanic_key) on delete restrict,
  check (ability_id is not null or normalized_name is not null),
  check (confidence <> ''uncertain'' or not active)
)","create unique index if not exists boss_mechanic_aliases_ability_key
  on boss_mechanic_aliases (boss_id, difficulty, ability_id)
  where ability_id is not null and active","create unique index if not exists boss_mechanic_aliases_name_key
  on boss_mechanic_aliases (boss_id, difficulty, normalized_name)
  where normalized_name is not null and active","create index if not exists boss_mechanic_aliases_mechanic_idx
  on boss_mechanic_aliases (boss_id, difficulty, mechanic_key, active)","drop trigger if exists boss_mechanic_aliases_touch_updated_at on boss_mechanic_aliases","create trigger boss_mechanic_aliases_touch_updated_at
before update on boss_mechanic_aliases
for each row execute function combat_evaluation_touch_updated_at()","-- Proyecciones/adaptadores aditivos para los objetos existentes. Permanecen
-- nullable hasta que el bloque C publique identidad/policy por scope.
alter table boss_mechanics_candidates
  add column if not exists mechanic_key text,
  add column if not exists policy_version integer check (policy_version is null or policy_version > 0)","alter table pull_mechanic_events
  add column if not exists mechanic_key text","alter table defensive_plan_slots
  add column if not exists mechanic_key text,
  add column if not exists source_policy_version integer check (source_policy_version is null or source_policy_version > 0)","create index if not exists boss_mechanics_candidates_mechanic_key_idx
  on boss_mechanics_candidates (boss_id, difficulty, mechanic_key)
  where mechanic_key is not null","create index if not exists pull_mechanic_events_mechanic_key_idx
  on pull_mechanic_events (pull_id, mechanic_key, trigger_time_ms)
  where mechanic_key is not null","create index if not exists defensive_plan_slots_mechanic_key_idx
  on defensive_plan_slots (plan_version_id, mechanic_key, occurrence_index)
  where mechanic_key is not null","alter table boss_mechanic_policy enable row level security","alter table boss_mechanic_policy_audit enable row level security","alter table boss_mechanic_aliases enable row level security","drop policy if exists \"boss_mechanic_policy: officers read\" on boss_mechanic_policy","create policy \"boss_mechanic_policy: officers read\"
  on boss_mechanic_policy for select using (is_officer())","drop policy if exists \"boss_mechanic_policy_audit: officers read\" on boss_mechanic_policy_audit","create policy \"boss_mechanic_policy_audit: officers read\"
  on boss_mechanic_policy_audit for select using (is_officer())","drop policy if exists \"boss_mechanic_aliases: officers read\" on boss_mechanic_aliases","create policy \"boss_mechanic_aliases: officers read\"
  on boss_mechanic_aliases for select using (is_officer())","revoke all on boss_mechanic_policy, boss_mechanic_policy_audit, boss_mechanic_aliases from anon, authenticated","grant select on boss_mechanic_policy, boss_mechanic_policy_audit, boss_mechanic_aliases to authenticated","comment on table boss_mechanic_policy is
  ''Policy causal canónica por boss+dificultad+mechanic_key. display_category es compatibilidad visual, nunca autoridad de culpabilidad.''","comment on table boss_mechanic_aliases is
  ''Convergencia versionable de IDs Journal/WCL y nombres normalizados hacia una mechanic_key estable.''","comment on table boss_mechanic_policy_audit is
  ''Historial before/after de revisiones de policy; los consumidores persisten policy_version y no reinterpretan planes publicados.''"}', 'mechanic_identity_policy_v2', NULL, NULL, NULL),
	('20260901210000', '{"-- Causalidad v3 · Bloque A / M13 · occurrence evaluada y grafo de responsabilidad.

create unique index if not exists pulls_identity_scope_key
  on pulls (id, boss_id, difficulty)","create table if not exists mechanic_occurrence_evaluations (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null,
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null,
  occurrence_index integer not null check (occurrence_index > 0),
  start_ms integer not null check (start_ms >= 0),
  resolve_ms integer not null check (resolve_ms >= start_ms),
  end_ms integer not null check (end_ms >= resolve_ms),
  phase_id text,
  boss_hp_pct numeric check (boss_hp_pct is null or boss_hp_pct between 0 and 100),
  target_actor_ids bigint[] not null default ''{}'',
  assignment_snapshot jsonb not null default ''{}''::jsonb check (jsonb_typeof(assignment_snapshot) = ''object''),
  outcome text not null check (outcome in (''success'', ''partial_fail'', ''fail'', ''not_evaluable'', ''uncertain'')),
  failure_mode text check (failure_mode is null or nullif(btrim(failure_mode), '''') is not null),
  evidence jsonb not null default ''{}''::jsonb check (jsonb_typeof(evidence) = ''object''),
  confidence text not null check (confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  policy_version integer not null check (policy_version > 0),
  context_resolver_version text not null check (nullif(btrim(context_resolver_version), '''') is not null),
  occurrence_resolver_version text not null check (nullif(btrim(occurrence_resolver_version), '''') is not null),
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (pull_id, boss_id, difficulty)
    references pulls (id, boss_id, difficulty) on delete cascade,
  foreign key (boss_id, difficulty, mechanic_key)
    references boss_mechanic_policy (boss_id, difficulty, mechanic_key) on delete restrict,
  unique (pull_id, mechanic_key, occurrence_index, occurrence_resolver_version),
  check (array_position(target_actor_ids, null) is null and 0::bigint < all(target_actor_ids)),
  check (outcome <> ''uncertain'' or confidence = ''uncertain''),
  check (outcome <> ''fail'' or failure_mode is not null)
)","create index if not exists mechanic_occurrence_evaluations_timeline_idx
  on mechanic_occurrence_evaluations (pull_id, resolve_ms, mechanic_key, occurrence_index)","create index if not exists mechanic_occurrence_evaluations_mechanic_idx
  on mechanic_occurrence_evaluations (boss_id, difficulty, mechanic_key, occurrence_index)","create index if not exists mechanic_occurrence_evaluations_version_idx
  on mechanic_occurrence_evaluations (context_resolver_version, occurrence_resolver_version, evaluated_at desc)","create table if not exists mechanic_responsibility_edges (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references mechanic_occurrence_evaluations (id) on delete cascade,
  player_name text not null check (nullif(btrim(player_name), '''') is not null),
  actor_id bigint check (actor_id is null or actor_id > 0),
  relationship text not null check (relationship in (
    ''primary_owner'', ''co_owner'', ''assigned_resolver'', ''successful_resolver'',
    ''target'', ''collateral_victim'', ''beneficiary''
  )),
  damage_caused bigint not null default 0 check (damage_caused >= 0),
  damage_taken bigint not null default 0 check (damage_taken >= 0),
  victim_count integer not null default 0 check (victim_count >= 0),
  credit_eligible boolean not null default false,
  penalty_eligible boolean not null default false,
  reason_code text not null check (nullif(btrim(reason_code), '''') is not null),
  confidence text not null check (confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  evidence jsonb not null default ''{}''::jsonb check (jsonb_typeof(evidence) = ''object''),
  created_at timestamptz not null default now(),
  unique (occurrence_id, player_name, relationship, reason_code),
  check (not penalty_eligible or relationship in (''primary_owner'', ''co_owner'', ''assigned_resolver'')),
  check (not penalty_eligible or confidence in (''verified'', ''inferred'')),
  check (relationship <> ''collateral_victim'' or not penalty_eligible)
)","create index if not exists mechanic_responsibility_edges_occurrence_idx
  on mechanic_responsibility_edges (occurrence_id, relationship)","create index if not exists mechanic_responsibility_edges_player_penalty_idx
  on mechanic_responsibility_edges (player_name, penalty_eligible, occurrence_id)","create index if not exists mechanic_responsibility_edges_player_credit_idx
  on mechanic_responsibility_edges (player_name, credit_eligible, occurrence_id)","alter table mechanic_occurrence_evaluations enable row level security","alter table mechanic_responsibility_edges enable row level security","drop policy if exists \"mechanic_occurrence_evaluations: officers read\" on mechanic_occurrence_evaluations","create policy \"mechanic_occurrence_evaluations: officers read\"
  on mechanic_occurrence_evaluations for select using (is_officer())","drop policy if exists \"mechanic_responsibility_edges: officers read\" on mechanic_responsibility_edges","create policy \"mechanic_responsibility_edges: officers read\"
  on mechanic_responsibility_edges for select using (is_officer())","revoke all on mechanic_occurrence_evaluations, mechanic_responsibility_edges from anon, authenticated","grant select on mechanic_occurrence_evaluations, mechanic_responsibility_edges to authenticated","comment on table mechanic_occurrence_evaluations is
  ''Outcome reproducible por pull+mechanic_key+occurrence. Los impactos observados no determinan por sí solos ownership.''","comment on table mechanic_responsibility_edges is
  ''Grafo materializado owner/assignee/resolver/target/víctima. credit_eligible y penalty_eligible son decisiones independientes.''"}', 'mechanic_occurrence_responsibility', NULL, NULL, NULL),
	('20260901220000', '{"-- Causalidad v3 · Bloque A / M14 · Player Execution Ledger y views shadow.

create unique index if not exists mechanic_occurrence_evaluations_id_pull_key
  on mechanic_occurrence_evaluations (id, pull_id)","create table if not exists player_execution_events (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null,
  boss_id text not null,
  difficulty text not null,
  player_name text not null check (nullif(btrim(player_name), '''') is not null),
  occurrence_id uuid,
  causal_group_id uuid not null,
  timestamp_ms integer not null check (timestamp_ms >= 0),
  domain text not null check (domain in (
    ''mechanic'', ''defensive'', ''external'', ''consumable'', ''interrupt'',
    ''dispel'', ''utility'', ''death'', ''preparation''
  )),
  event_type text not null check (nullif(btrim(event_type), '''') is not null),
  verdict text not null check (verdict in (
    ''success'', ''failure'', ''correct_hold'', ''missed'', ''context'',
    ''not_applicable'', ''uncertain''
  )),
  reason_code text not null check (reason_code in (
    ''SPREAD_CARRIER_COLLATERAL'', ''ASSIGNED_SOAK_MISSED'', ''PERSONAL_GROUND_HIT'',
    ''TANK_FRONTAL_HIT_RAID'', ''TANK_SWAP_THRESHOLD_BREACH'', ''ASSIGNED_INTERRUPT_MISSED'',
    ''RAID_INTERRUPT_MISSED'', ''VOLUNTEER_MECHANIC_RESOLVED'', ''VOLUNTEER_MECHANIC_UNRESOLVED'',
    ''SELF_FAILURE_DEATH'', ''COLLATERAL_DEATH'', ''UNAVOIDABLE_PRESSURE_DEATH'',
    ''POST_WIPE_DEATH'', ''UNCERTAIN_CAUSE'', ''PLAN_COVERED'', ''CORRECT_HOLD'',
    ''REMINDER_MISSED'', ''DEATH_VIABLE_CD'', ''VIABLE_CD_NON_PUNITIVE'', ''TARGET_MISMATCH'',
    ''SAFE_EXTRA_USE'', ''PREPOT_USED'', ''PREPOT_MISSED_VERIFIED'', ''HEALTHSTONE_REACTIVE'',
    ''HEALTHSTONE_VIABLE_NOT_USED'', ''HEALTH_POTION_REACTIVE'', ''AVAILABILITY_UNKNOWN''
  )),
  credit_eligible boolean not null default false,
  penalty_eligible boolean not null default false,
  primary_penalty boolean not null default false,
  severity numeric check (severity is null or severity between 0 and 100),
  priority smallint check (priority is null or priority between 1 and 5),
  confidence text not null check (confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  evidence jsonb not null default ''{}''::jsonb check (jsonb_typeof(evidence) = ''object''),
  policy_version integer check (policy_version is null or policy_version > 0),
  context_resolver_version text not null check (nullif(btrim(context_resolver_version), '''') is not null),
  occurrence_resolver_version text check (occurrence_resolver_version is null or nullif(btrim(occurrence_resolver_version), '''') is not null),
  ledger_evaluator_version text not null check (nullif(btrim(ledger_evaluator_version), '''') is not null),
  deduplication_key text not null check (nullif(btrim(deduplication_key), '''') is not null),
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (pull_id, boss_id, difficulty)
    references pulls (id, boss_id, difficulty) on delete cascade,
  foreign key (occurrence_id, pull_id)
    references mechanic_occurrence_evaluations (id, pull_id) on delete cascade,
  unique (pull_id, ledger_evaluator_version, deduplication_key),
  check (not primary_penalty or penalty_eligible),
  check (not penalty_eligible or verdict in (''failure'', ''missed'')),
  check (not penalty_eligible or confidence in (''verified'', ''inferred'')),
  check (verdict <> ''uncertain'' or (not credit_eligible and not penalty_eligible)),
  check (verdict not in (''context'', ''not_applicable'') or not penalty_eligible),
  check (reason_code <> ''AVAILABILITY_UNKNOWN'' or not penalty_eligible),
  check ((occurrence_id is null) = (occurrence_resolver_version is null))
)","create index if not exists player_execution_events_pull_player_timeline_idx
  on player_execution_events (pull_id, player_name, timestamp_ms)","create index if not exists player_execution_events_player_domain_idx
  on player_execution_events (player_name, domain, verdict, evaluated_at desc)","create index if not exists player_execution_events_occurrence_idx
  on player_execution_events (occurrence_id)
  where occurrence_id is not null","create index if not exists player_execution_events_penalty_idx
  on player_execution_events (player_name, penalty_eligible, primary_penalty, evaluated_at desc)","create index if not exists player_execution_events_causal_group_idx
  on player_execution_events (causal_group_id, primary_penalty)","alter table player_execution_events enable row level security","drop policy if exists \"player_execution_events: officers read\" on player_execution_events","create policy \"player_execution_events: officers read\"
  on player_execution_events for select using (is_officer())","revoke all on player_execution_events from anon, authenticated","grant select on player_execution_events to authenticated","create or replace view player_pull_execution_summary_v3
with (security_invoker = true)
as
select
  e.pull_id,
  e.boss_id,
  e.difficulty,
  e.player_name,
  e.ledger_evaluator_version,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = ''success'')::integer as success_count,
  count(*) filter (where e.verdict in (''failure'', ''missed''))::integer as failure_count,
  count(*) filter (where e.verdict = ''correct_hold'')::integer as correct_hold_count,
  count(*) filter (where e.verdict = ''uncertain'')::integer as uncertain_count,
  count(*) filter (where e.domain = ''mechanic'' and e.penalty_eligible)::integer as mechanic_failure_count,
  count(*) filter (where e.domain in (''defensive'', ''external'') and e.penalty_eligible)::integer as defensive_failure_count,
  count(*) filter (where e.domain = ''consumable'' and e.penalty_eligible)::integer as consumable_failure_count,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at
from player_execution_events e
group by e.pull_id, e.boss_id, e.difficulty, e.player_name, e.ledger_evaluator_version","create or replace view night_player_execution_summary_v3
with (security_invoker = true)
as
select
  p.report_code,
  e.player_name,
  count(distinct e.pull_id)::integer as pull_count,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = ''uncertain'')::integer as uncertain_count,
  array_agg(distinct e.ledger_evaluator_version order by e.ledger_evaluator_version) as ledger_evaluator_versions,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.ledger_evaluator_version) = 1
    and count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at
from player_execution_events e
join pulls p on p.id = e.pull_id
group by p.report_code, e.player_name","create or replace view player_mechanic_offenses_v3
with (security_invoker = true)
as
select
  e.id as execution_event_id,
  e.pull_id,
  e.boss_id,
  e.difficulty,
  e.player_name,
  e.timestamp_ms,
  e.occurrence_id,
  o.mechanic_key,
  o.occurrence_index,
  edge.relationship,
  e.reason_code,
  e.severity,
  e.priority,
  e.confidence,
  e.evidence,
  e.policy_version,
  e.context_resolver_version,
  e.occurrence_resolver_version,
  e.ledger_evaluator_version
from player_execution_events e
join mechanic_occurrence_evaluations o on o.id = e.occurrence_id
join mechanic_responsibility_edges edge
  on edge.occurrence_id = e.occurrence_id
 and edge.player_name = e.player_name
 and edge.penalty_eligible
 and edge.relationship in (''primary_owner'', ''co_owner'', ''assigned_resolver'')
where e.domain = ''mechanic''
  and e.verdict in (''failure'', ''missed'')
  and e.penalty_eligible","create or replace view boss_mechanic_execution_stats_v3
with (security_invoker = true)
as
select
  o.boss_id,
  o.difficulty,
  o.mechanic_key,
  o.policy_version,
  o.occurrence_resolver_version,
  count(*)::integer as occurrence_count,
  count(*) filter (where o.outcome = ''success'')::integer as success_count,
  count(*) filter (where o.outcome in (''partial_fail'', ''fail''))::integer as failure_count,
  count(*) filter (where o.outcome in (''not_evaluable'', ''uncertain''))::integer as non_evaluable_count,
  count(distinct o.pull_id)::integer as pull_count,
  max(o.evaluated_at) as evaluated_at
from mechanic_occurrence_evaluations o
group by o.boss_id, o.difficulty, o.mechanic_key, o.policy_version, o.occurrence_resolver_version","revoke all on player_pull_execution_summary_v3, night_player_execution_summary_v3,
  player_mechanic_offenses_v3, boss_mechanic_execution_stats_v3 from anon","grant select on player_pull_execution_summary_v3, night_player_execution_summary_v3,
  player_mechanic_offenses_v3, boss_mechanic_execution_stats_v3 to authenticated","comment on table player_execution_events is
  ''Ledger v3 idempotente de decisiones por jugador. Solo filas penalty_eligible con confidence trusted pueden alimentar scoring futuro.''","comment on view player_mechanic_offenses_v3 is
  ''Failures mecánicos atribuibles desde ledger+responsibility graph; nunca deriva culpabilidad desde players_hit.''"}', 'player_execution_ledger', NULL, NULL, NULL),
	('20260901230000', '{"-- Causalidad v3 · Bloque B / M11b · cola genérica, durable e idempotente.
-- No reutiliza la cola defensiva: este pipeline encadena contexto, policy,
-- occurrences, ledger y evaluadores causales por pull.

create table if not exists combat_evaluation_batches (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (nullif(btrim(reason), '''') is not null),
  scope jsonb not null default ''{}''::jsonb check (jsonb_typeof(scope) = ''object''),
  status text not null default ''queued'' check (status in (''queued'', ''running'', ''completed'', ''completed_with_errors'')),
  total_jobs integer not null default 0 check (total_jobs >= 0),
  completed_jobs integer not null default 0 check (completed_jobs between 0 and total_jobs),
  failed_jobs integer not null default 0 check (failed_jobs between 0 and total_jobs),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
)","create table if not exists combat_evaluation_jobs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references combat_evaluation_batches (id) on delete cascade,
  pull_id uuid not null references pulls (id) on delete cascade,
  job_type text not null check (job_type in (
    ''pull_context'', ''mechanic_policy'', ''mechanic_assignment'',
    ''consumable_policy'', ''full_execution_backfill''
  )),
  status text not null default ''queued'' check (status in (''queued'', ''running'', ''done'', ''error'')),
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  payload jsonb not null default ''{}''::jsonb check (jsonb_typeof(payload) = ''object''),
  stage_progress jsonb not null default ''{}''::jsonb check (jsonb_typeof(stage_progress) = ''object''),
  last_error text,
  lease_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pull_id, job_type)
)","create index if not exists combat_evaluation_jobs_claim_idx
  on combat_evaluation_jobs (status, lease_expires_at, created_at, attempts)","create index if not exists combat_evaluation_jobs_batch_idx
  on combat_evaluation_jobs (batch_id, status)","-- La invalidación nace en base de datos, dentro de la misma transacción que
-- cambia la autoridad. Así cerrar el navegador no puede perder la cascada.
create or replace function queue_pull_context_reanalysis()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_old_batch_id uuid;
begin
  select batch_id into v_old_batch_id
  from combat_evaluation_jobs
  where pull_id = new.pull_id and job_type = ''pull_context'';
  insert into combat_evaluation_batches (reason, scope, total_jobs, created_by)
  values (
    ''pull_evaluation_context_changed'',
    jsonb_build_object(''pullId'', new.pull_id, ''resolverVersion'', new.resolver_version),
    1,
    new.reviewed_by
  ) returning id into v_batch_id;

  insert into combat_evaluation_jobs (batch_id, pull_id, job_type, payload)
  values (
    v_batch_id,
    new.pull_id,
    ''pull_context'',
    jsonb_build_object(''contextUpdatedAt'', new.updated_at, ''contextResolverVersion'', new.resolver_version)
  )
  on conflict (pull_id, job_type) do update set
    batch_id = excluded.batch_id, status = ''queued'', attempts = 0,
    payload = excluded.payload, stage_progress = ''{}''::jsonb, last_error = null,
    lease_token = null, claimed_at = null, lease_expires_at = null,
    finished_at = null, updated_at = now();
  if v_old_batch_id is not null and v_old_batch_id <> v_batch_id then
    perform refresh_combat_evaluation_batch(v_old_batch_id);
  end if;
  perform refresh_combat_evaluation_batch(v_batch_id);
  return new;
end;
$$","drop trigger if exists pull_evaluation_context_queue_reanalysis on pull_evaluation_context","create trigger pull_evaluation_context_queue_reanalysis
after insert or update on pull_evaluation_context
for each row execute function queue_pull_context_reanalysis()","create or replace function refresh_combat_evaluation_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_done integer;
  v_error integer;
  v_running integer;
begin
  select count(*), count(*) filter (where status = ''done''),
         count(*) filter (where status = ''error''), count(*) filter (where status = ''running'')
  into v_total, v_done, v_error, v_running
  from combat_evaluation_jobs where batch_id = p_batch_id;

  update combat_evaluation_batches set
    total_jobs = v_total,
    completed_jobs = v_done,
    failed_jobs = v_error,
    status = case
      when v_total > 0 and v_done + v_error = v_total then case when v_error > 0 then ''completed_with_errors'' else ''completed'' end
      when v_running > 0 or v_done > 0 then ''running''
      else ''queued''
    end,
    started_at = case when (v_running > 0 or v_done > 0 or v_error > 0) then coalesce(started_at, now()) else started_at end,
    finished_at = case when v_total > 0 and v_done + v_error = v_total then coalesce(finished_at, now()) else null end,
    updated_at = now()
  where id = p_batch_id;
end;
$$","create or replace function enqueue_combat_evaluation_jobs(
  p_pull_ids uuid[],
  p_job_type text,
  p_reason text,
  p_scope jsonb default ''{}''::jsonb,
  p_payload jsonb default ''{}''::jsonb,
  p_requested_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_pull_ids uuid[];
  v_old_batch_ids uuid[];
  v_old_batch_id uuid;
begin
  if p_job_type not in (''pull_context'', ''mechanic_policy'', ''mechanic_assignment'', ''consumable_policy'', ''full_execution_backfill'') then
    raise exception ''job_type no soportado.'' using errcode = ''22023'';
  end if;
  if p_reason is null or btrim(p_reason) = '''' then raise exception ''reason es obligatorio.'' using errcode = ''22023''; end if;
  if jsonb_typeof(coalesce(p_scope, ''{}''::jsonb)) <> ''object'' or jsonb_typeof(coalesce(p_payload, ''{}''::jsonb)) <> ''object'' then
    raise exception ''scope y payload deben ser objetos JSON.'' using errcode = ''22023'';
  end if;

  select coalesce(array_agg(distinct pull_id), ''{}''::uuid[]) into v_pull_ids
  from unnest(coalesce(p_pull_ids, ''{}''::uuid[])) as value(pull_id);
  if cardinality(v_pull_ids) = 0 then return null; end if;

  select coalesce(array_agg(distinct batch_id), ''{}''::uuid[]) into v_old_batch_ids
  from combat_evaluation_jobs where pull_id = any(v_pull_ids) and job_type = p_job_type;

  insert into combat_evaluation_batches (reason, scope, total_jobs, created_by)
  values (btrim(p_reason), coalesce(p_scope, ''{}''::jsonb), cardinality(v_pull_ids), p_requested_by)
  returning id into v_batch_id;

  insert into combat_evaluation_jobs (batch_id, pull_id, job_type, payload)
  select v_batch_id, pull_id, p_job_type, coalesce(p_payload, ''{}''::jsonb)
  from unnest(v_pull_ids) as value(pull_id)
  on conflict (pull_id, job_type) do update set
    batch_id = excluded.batch_id,
    status = ''queued'', attempts = 0, payload = excluded.payload,
    stage_progress = ''{}''::jsonb, last_error = null, lease_token = null,
    claimed_at = null, lease_expires_at = null, finished_at = null, updated_at = now();

  foreach v_old_batch_id in array v_old_batch_ids loop
    if v_old_batch_id <> v_batch_id then perform refresh_combat_evaluation_batch(v_old_batch_id); end if;
  end loop;
  perform refresh_combat_evaluation_batch(v_batch_id);
  return v_batch_id;
end;
$$","create or replace function claim_combat_evaluation_job(
  p_job_type text default null,
  p_lease_seconds integer default 300
)
returns combat_evaluation_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_job combat_evaluation_jobs;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 900 then raise exception ''lease fuera de rango.'' using errcode = ''22023''; end if;
  select * into v_job from combat_evaluation_jobs
  where (p_job_type is null or job_type = p_job_type)
    and attempts < max_attempts
    and (status = ''queued'' or (status = ''running'' and lease_expires_at < now()))
  order by created_at for update skip locked limit 1;
  if not found then return null; end if;

  update combat_evaluation_jobs set status = ''running'', attempts = attempts + 1,
    lease_token = gen_random_uuid(), claimed_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = v_job.id returning * into v_job;
  perform refresh_combat_evaluation_batch(v_job.batch_id);
  return v_job;
end;
$$","create or replace function finish_combat_evaluation_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_succeeded boolean,
  p_stage_progress jsonb default ''{}''::jsonb,
  p_error text default null
)
returns combat_evaluation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare v_job combat_evaluation_jobs;
begin
  update combat_evaluation_jobs set
    status = case when p_succeeded then ''done'' else ''error'' end,
    stage_progress = coalesce(p_stage_progress, ''{}''::jsonb),
    last_error = case when p_succeeded then null else left(coalesce(p_error, ''Error sin detalle.''), 4000) end,
    finished_at = now(), lease_expires_at = null, updated_at = now()
  where id = p_job_id and status = ''running'' and lease_token = p_lease_token
  returning * into v_job;
  if not found then raise exception ''Lease inválido o job no ejecutable.'' using errcode = ''55000''; end if;
  perform refresh_combat_evaluation_batch(v_job.batch_id);
  return v_job;
end;
$$","alter table combat_evaluation_batches enable row level security","alter table combat_evaluation_jobs enable row level security","create policy \"combat_evaluation_batches: officers read\" on combat_evaluation_batches for select using (is_officer())","create policy \"combat_evaluation_jobs: officers read\" on combat_evaluation_jobs for select using (is_officer())","revoke all on combat_evaluation_batches, combat_evaluation_jobs from anon, authenticated","grant select on combat_evaluation_batches, combat_evaluation_jobs to authenticated","revoke all on function enqueue_combat_evaluation_jobs(uuid[], text, text, jsonb, jsonb, uuid) from public, anon, authenticated","revoke all on function claim_combat_evaluation_job(text, integer) from public, anon, authenticated","revoke all on function finish_combat_evaluation_job(uuid, uuid, boolean, jsonb, text) from public, anon, authenticated","grant execute on function enqueue_combat_evaluation_jobs(uuid[], text, text, jsonb, jsonb, uuid) to service_role","grant execute on function claim_combat_evaluation_job(text, integer) to service_role","grant execute on function finish_combat_evaluation_job(uuid, uuid, boolean, jsonb, text) to service_role","comment on table combat_evaluation_jobs is
  ''Cola causal genérica: una unidad idempotente por pull+tipo, lease recuperable y progreso por etapas.''"}', 'combat_evaluation_queue', NULL, NULL, NULL),
	('20260901240000', '{"-- Causalidad v3 · Bloque E: línea temporal auditable de dispels de WCL.
-- Los datos ya se descargaban para atribuir muertes, pero se descartaban al
-- cerrar analyze-report. Esta tabla conserva los hechos sin inferir culpa.

create table if not exists pull_dispel_events (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null references pulls (id) on delete cascade,
  source_actor_id integer,
  source_player_name text,
  target_actor_id integer,
  target_player_name text,
  dispelled_ability_id bigint,
  timestamp_ms integer not null check (timestamp_ms >= 0),
  is_buff boolean not null default false,
  created_at timestamptz not null default now(),
  unique (pull_id, source_actor_id, target_actor_id, dispelled_ability_id, timestamp_ms, is_buff)
)","create index if not exists pull_dispel_events_pull_timeline_idx
  on pull_dispel_events (pull_id, timestamp_ms)","create index if not exists pull_dispel_events_pull_target_idx
  on pull_dispel_events (pull_id, target_actor_id, dispelled_ability_id, timestamp_ms)","alter table pull_dispel_events enable row level security","drop policy if exists \"pull_dispel_events: officers read\" on pull_dispel_events","create policy \"pull_dispel_events: officers read\"
  on pull_dispel_events for select using (is_officer())","revoke all on pull_dispel_events from anon, authenticated","grant select on pull_dispel_events to authenticated","comment on table pull_dispel_events is
  ''Hechos WCL de dispel por pull. is_buff=true representa dispel ofensivo y no cuenta como limpieza aliada.''"}', 'pull_dispel_events', NULL, NULL, NULL),
	('20260901250000', '{"-- Causalidad v3 · Historial inmutable de MechanicPolicy.
-- boss_mechanic_policy conserva la versión vigente para no romper FKs existentes.
-- Esta tabla conserva cada snapshot publicado y permite reproducir una versión.

create table if not exists boss_mechanic_policy_versions (
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null check (nullif(btrim(mechanic_key), '''') is not null),
  policy_version integer not null check (policy_version > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = ''object''),
  confidence text not null check (confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  published_by uuid references auth.users (id) on delete set null,
  published_at timestamptz not null default now(),
  primary key (boss_id, difficulty, mechanic_key, policy_version)
)","create index if not exists boss_mechanic_policy_versions_scope_idx
  on boss_mechanic_policy_versions (boss_id, difficulty, mechanic_key, policy_version desc)","create or replace function snapshot_boss_mechanic_policy_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into boss_mechanic_policy_versions (
    boss_id, difficulty, mechanic_key, policy_version, snapshot, confidence,
    published_by, published_at
  ) values (
    new.boss_id, new.difficulty, new.mechanic_key, new.policy_version,
    to_jsonb(new), new.confidence, new.reviewed_by, new.updated_at
  ) on conflict (boss_id, difficulty, mechanic_key, policy_version) do nothing;
  return new;
end;
$$","drop trigger if exists boss_mechanic_policy_snapshot_version on boss_mechanic_policy","create trigger boss_mechanic_policy_snapshot_version
after insert or update on boss_mechanic_policy
for each row execute function snapshot_boss_mechanic_policy_version()","insert into boss_mechanic_policy_versions (
  boss_id, difficulty, mechanic_key, policy_version, snapshot, confidence,
  published_by, published_at
)
select
  boss_id, difficulty, mechanic_key, policy_version, to_jsonb(boss_mechanic_policy),
  confidence, reviewed_by, updated_at
from boss_mechanic_policy
on conflict (boss_id, difficulty, mechanic_key, policy_version) do nothing","alter table boss_mechanic_policy_versions enable row level security","drop policy if exists \"boss_mechanic_policy_versions: officers read\" on boss_mechanic_policy_versions","create policy \"boss_mechanic_policy_versions: officers read\"
  on boss_mechanic_policy_versions for select using (is_officer())","revoke all on boss_mechanic_policy_versions from anon, authenticated","grant select on boss_mechanic_policy_versions to authenticated","comment on table boss_mechanic_policy_versions is
  ''Snapshots inmutables de cada publicación de policy. La tabla boss_mechanic_policy conserva únicamente el estado vigente compatible con FKs legacy.''"}', 'mechanic_policy_versions', NULL, NULL, NULL),
	('20260902110000', '{"-- M12 añadió mechanic_key y policy_version a boss_mechanics_candidates
-- después de crear esta vista. PostgreSQL congela la expansión de candidate.*
-- al crearla, por lo que hay que recrearla para exponer las columnas nuevas.
create or replace view applicable_boss_mechanics_candidates
with (security_invoker = true) as
select candidate.*
from boss_mechanics_candidates candidate
where candidate.observed_in_logs is true
   or candidate.observed_in_reference_logs is true
   or candidate.observed_as_interrupt is true
   or coalesce(candidate.reference_occurrences, 0) > 0
   or exists (
     select 1
     from pull_mechanic_events event
     join pulls pull on pull.id = event.pull_id
     where pull.boss_id = candidate.boss_id
       and pull.difficulty = candidate.difficulty
       and lower(trim(event.mechanic_name)) = lower(trim(candidate.name))
   )
   or (
     candidate.official_difficulty_applicable is distinct from false
     and (
       candidate.reference_source_report is null
       or not exists (
         select 1
         from boss_mechanics_candidates other
         where other.boss_id = candidate.boss_id
           and other.ability_id = candidate.ability_id
           and other.difficulty <> candidate.difficulty
           and (
             other.observed_in_logs is true
             or other.observed_in_reference_logs is true
             or other.observed_as_interrupt is true
             or coalesce(other.reference_occurrences, 0) > 0
           )
           and (case other.difficulty when ''LFR'' then 1 when ''Normal'' then 3 when ''Heroic'' then 4 when ''Mythic'' then 5 else 0 end)
             > (case candidate.difficulty when ''LFR'' then 1 when ''Normal'' then 3 when ''Heroic'' then 4 when ''Mythic'' then 5 else 0 end)
       )
     )
   )","comment on view applicable_boss_mechanics_candidates is
  ''Mecánicas aplicables por boss+dificultad. Recreada tras M12 para exponer mechanic_key y policy_version sin cambiar el filtro de aplicabilidad.''"}', 'refresh_applicable_candidates_causal_identity', NULL, NULL, NULL),
	('20260902130000', '{"-- Causalidad v3 · Publicación acotada y atómica de policies clasificadas.
-- La Edge Function solo valida/prepara un lote de una dificultad. PostgreSQL
-- versiona, publica, dispara el snapshot M16 y audita dentro de una transacción.

create or replace function publish_mechanic_policy_batch(
  p_boss_id text,
  p_difficulty text,
  p_entries jsonb,
  p_changed_by uuid,
  p_reason text
)
returns table (mechanic_key text, policy_version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry jsonb;
  v_mechanic_key text;
  v_before_state jsonb;
  v_previous_version integer;
  v_created_by uuid;
  v_created_at timestamptz;
  v_after boss_mechanic_policy%rowtype;
begin
  if nullif(btrim(p_boss_id), '''') is null then
    raise exception ''bossId es obligatorio'';
  end if;
  if nullif(btrim(p_difficulty), '''') is null then
    raise exception ''difficulty es obligatoria'';
  end if;
  if nullif(btrim(p_reason), '''') is null then
    raise exception ''reason es obligatorio'';
  end if;
  if jsonb_typeof(p_entries) <> ''array'' then
    raise exception ''entries debe ser un array JSON'';
  end if;
  if jsonb_array_length(p_entries) = 0 or jsonb_array_length(p_entries) > 20 then
    raise exception ''el lote debe contener entre 1 y 20 policies'';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    v_mechanic_key := nullif(btrim(v_entry->>''mechanic_key''), '''');
    if v_mechanic_key is null then
      raise exception ''mechanic_key es obligatorio en todas las policies'';
    end if;

    -- También serializa el primer INSERT, cuando todavía no existe una fila
    -- que SELECT ... FOR UPDATE pueda bloquear.
    perform pg_advisory_xact_lock(
      hashtextextended(p_boss_id || '':'' || p_difficulty || '':'' || v_mechanic_key, 0)
    );

    v_before_state := null;
    v_previous_version := null;
    v_created_by := null;
    v_created_at := null;
    select to_jsonb(policy_row), policy_row.policy_version, policy_row.created_by, policy_row.created_at
      into v_before_state, v_previous_version, v_created_by, v_created_at
      from boss_mechanic_policy as policy_row
      where policy_row.boss_id = p_boss_id
        and policy_row.difficulty = p_difficulty
        and policy_row.mechanic_key = v_mechanic_key
      for update;

    insert into boss_mechanic_policy (
      boss_id,
      difficulty,
      mechanic_key,
      policy_version,
      display_name,
      display_category,
      targeting_mode,
      required_response,
      responsibility_mode,
      damage_semantics,
      failure_propagation,
      assignment_mode,
      defensive_expectation,
      credit_scope,
      penalty_scope,
      causal_rule,
      confidence,
      provenance,
      verified_at,
      reviewed_by,
      created_by,
      created_at,
      updated_at
    ) values (
      p_boss_id,
      p_difficulty,
      v_mechanic_key,
      coalesce(v_previous_version, 0) + 1,
      coalesce(nullif(btrim(v_entry->>''display_name''), ''''), v_mechanic_key),
      nullif(v_entry->>''display_category'', ''''),
      v_entry->>''targeting_mode'',
      nullif(btrim(v_entry->>''required_response''), ''''),
      v_entry->>''responsibility_mode'',
      v_entry->>''damage_semantics'',
      v_entry->>''failure_propagation'',
      v_entry->>''assignment_mode'',
      v_entry->>''defensive_expectation'',
      v_entry->>''credit_scope'',
      v_entry->>''penalty_scope'',
      coalesce(v_entry->''causal_rule'', ''{}''::jsonb),
      v_entry->>''confidence'',
      coalesce(v_entry->''provenance'', ''{}''::jsonb),
      null,
      p_changed_by,
      coalesce(v_created_by, p_changed_by),
      coalesce(v_created_at, now()),
      now()
    )
    on conflict (boss_id, difficulty, mechanic_key) do update set
      policy_version = excluded.policy_version,
      display_name = excluded.display_name,
      display_category = excluded.display_category,
      targeting_mode = excluded.targeting_mode,
      required_response = excluded.required_response,
      responsibility_mode = excluded.responsibility_mode,
      damage_semantics = excluded.damage_semantics,
      failure_propagation = excluded.failure_propagation,
      assignment_mode = excluded.assignment_mode,
      defensive_expectation = excluded.defensive_expectation,
      credit_scope = excluded.credit_scope,
      penalty_scope = excluded.penalty_scope,
      causal_rule = excluded.causal_rule,
      confidence = excluded.confidence,
      provenance = excluded.provenance,
      verified_at = excluded.verified_at,
      reviewed_by = excluded.reviewed_by,
      updated_at = excluded.updated_at
    returning * into v_after;

    insert into boss_mechanic_policy_audit (
      boss_id,
      difficulty,
      mechanic_key,
      previous_policy_version,
      new_policy_version,
      before_state,
      after_state,
      reason,
      changed_by,
      changed_at
    ) values (
      p_boss_id,
      p_difficulty,
      v_mechanic_key,
      v_previous_version,
      v_after.policy_version,
      v_before_state,
      to_jsonb(v_after),
      p_reason,
      p_changed_by,
      v_after.updated_at
    );

    mechanic_key := v_after.mechanic_key;
    policy_version := v_after.policy_version;
    return next;
  end loop;
end;
$$","revoke all on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text)
  from public, anon, authenticated","grant execute on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text)
  to service_role","comment on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text) is
  ''Publica como máximo 20 policies de un único boss+dificultad con versionado, snapshot y auditoría atómicos.''"}', 'publish_mechanic_policy_batch', NULL, NULL, NULL),
	('20260902140000', '{"-- Causalidad v3 · Hardening de publicación atómica por lote.
--
-- M19 declaró RETURNS TABLE (mechanic_key, policy_version). En PL/pgSQL esos
-- nombres también son variables OUT, por lo que el conflict target
-- ON CONFLICT (..., mechanic_key) quedaba ambiguo al ejecutar la sentencia.
-- Se conserva la firma pública, se dirige el UPSERT por la PK nominal y se
-- obliga a resolver como columnas cualquier futura colisión dentro de SQL.

create or replace function publish_mechanic_policy_batch(
  p_boss_id text,
  p_difficulty text,
  p_entries jsonb,
  p_changed_by uuid,
  p_reason text
)
returns table (mechanic_key text, policy_version integer)
language plpgsql
security definer
set search_path = public
as $function$
#variable_conflict use_column
declare
  v_entry jsonb;
  v_mechanic_key text;
  v_before_state jsonb;
  v_previous_version integer;
  v_created_by uuid;
  v_created_at timestamptz;
  v_after boss_mechanic_policy%rowtype;
begin
  if nullif(btrim(p_boss_id), '''') is null then
    raise exception ''bossId es obligatorio'';
  end if;
  if nullif(btrim(p_difficulty), '''') is null then
    raise exception ''difficulty es obligatoria'';
  end if;
  if nullif(btrim(p_reason), '''') is null then
    raise exception ''reason es obligatorio'';
  end if;
  if jsonb_typeof(p_entries) <> ''array'' then
    raise exception ''entries debe ser un array JSON'';
  end if;
  if jsonb_array_length(p_entries) = 0 or jsonb_array_length(p_entries) > 20 then
    raise exception ''el lote debe contener entre 1 y 20 policies'';
  end if;

  for v_entry in select element.value from jsonb_array_elements(p_entries) as element(value)
  loop
    v_mechanic_key := nullif(btrim(v_entry->>''mechanic_key''), '''');
    if v_mechanic_key is null then
      raise exception ''mechanic_key es obligatorio en todas las policies'';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(p_boss_id || '':'' || p_difficulty || '':'' || v_mechanic_key, 0)
    );

    v_before_state := null;
    v_previous_version := null;
    v_created_by := null;
    v_created_at := null;
    select
      to_jsonb(policy_row),
      policy_row.policy_version,
      policy_row.created_by,
      policy_row.created_at
    into v_before_state, v_previous_version, v_created_by, v_created_at
    from boss_mechanic_policy as policy_row
    where policy_row.boss_id = p_boss_id
      and policy_row.difficulty = p_difficulty
      and policy_row.mechanic_key = v_mechanic_key
    for update;

    insert into boss_mechanic_policy (
      boss_id,
      difficulty,
      mechanic_key,
      policy_version,
      display_name,
      display_category,
      targeting_mode,
      required_response,
      responsibility_mode,
      damage_semantics,
      failure_propagation,
      assignment_mode,
      defensive_expectation,
      credit_scope,
      penalty_scope,
      causal_rule,
      confidence,
      provenance,
      verified_at,
      reviewed_by,
      created_by,
      created_at,
      updated_at
    ) values (
      p_boss_id,
      p_difficulty,
      v_mechanic_key,
      coalesce(v_previous_version, 0) + 1,
      coalesce(nullif(btrim(v_entry->>''display_name''), ''''), v_mechanic_key),
      nullif(v_entry->>''display_category'', ''''),
      v_entry->>''targeting_mode'',
      nullif(btrim(v_entry->>''required_response''), ''''),
      v_entry->>''responsibility_mode'',
      v_entry->>''damage_semantics'',
      v_entry->>''failure_propagation'',
      v_entry->>''assignment_mode'',
      v_entry->>''defensive_expectation'',
      v_entry->>''credit_scope'',
      v_entry->>''penalty_scope'',
      coalesce(v_entry->''causal_rule'', ''{}''::jsonb),
      v_entry->>''confidence'',
      coalesce(v_entry->''provenance'', ''{}''::jsonb),
      null,
      p_changed_by,
      coalesce(v_created_by, p_changed_by),
      coalesce(v_created_at, now()),
      now()
    )
    on conflict on constraint boss_mechanic_policy_pkey do update set
      policy_version = excluded.policy_version,
      display_name = excluded.display_name,
      display_category = excluded.display_category,
      targeting_mode = excluded.targeting_mode,
      required_response = excluded.required_response,
      responsibility_mode = excluded.responsibility_mode,
      damage_semantics = excluded.damage_semantics,
      failure_propagation = excluded.failure_propagation,
      assignment_mode = excluded.assignment_mode,
      defensive_expectation = excluded.defensive_expectation,
      credit_scope = excluded.credit_scope,
      penalty_scope = excluded.penalty_scope,
      causal_rule = excluded.causal_rule,
      confidence = excluded.confidence,
      provenance = excluded.provenance,
      verified_at = excluded.verified_at,
      reviewed_by = excluded.reviewed_by,
      updated_at = excluded.updated_at
    returning * into v_after;

    insert into boss_mechanic_policy_audit (
      boss_id,
      difficulty,
      mechanic_key,
      previous_policy_version,
      new_policy_version,
      before_state,
      after_state,
      reason,
      changed_by,
      changed_at
    ) values (
      p_boss_id,
      p_difficulty,
      v_mechanic_key,
      v_previous_version,
      v_after.policy_version,
      v_before_state,
      to_jsonb(v_after),
      p_reason,
      p_changed_by,
      v_after.updated_at
    );

    return query select v_after.mechanic_key, v_after.policy_version;
  end loop;
end;
$function$","revoke all on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text)
  from public, anon, authenticated","grant execute on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text)
  to service_role","comment on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text) is
  ''Publica como máximo 20 policies de un único boss+dificultad con versionado, snapshot y auditoría atómicos; conflict target no ambiguo desde M20.''","-- Ejecuta la rama real INSERT/UPSERT/RETURN sobre una policy existente dentro
-- de un subbloque. La excepción centinela revierte policy, snapshot y audit;
-- cualquier error anterior (incluido 42702 ambiguous_column) aborta M20.
do $self_test$
declare
  v_sample boss_mechanic_policy%rowtype;
  v_call_completed boolean := false;
begin
  select policy_row.*
  into v_sample
  from boss_mechanic_policy as policy_row
  order by policy_row.updated_at desc, policy_row.mechanic_key
  limit 1;

  if not found then
    return;
  end if;

  begin
    perform *
    from publish_mechanic_policy_batch(
      v_sample.boss_id,
      v_sample.difficulty,
      jsonb_build_array(jsonb_build_object(
        ''mechanic_key'', v_sample.mechanic_key,
        ''display_name'', v_sample.display_name,
        ''display_category'', v_sample.display_category,
        ''targeting_mode'', v_sample.targeting_mode,
        ''required_response'', v_sample.required_response,
        ''responsibility_mode'', v_sample.responsibility_mode,
        ''damage_semantics'', v_sample.damage_semantics,
        ''failure_propagation'', v_sample.failure_propagation,
        ''assignment_mode'', v_sample.assignment_mode,
        ''defensive_expectation'', v_sample.defensive_expectation,
        ''credit_scope'', v_sample.credit_scope,
        ''penalty_scope'', v_sample.penalty_scope,
        ''causal_rule'', v_sample.causal_rule,
        ''confidence'', v_sample.confidence,
        ''provenance'', v_sample.provenance
      )),
      v_sample.reviewed_by,
      ''M20 transactional self-test; rolled back''
    );
    v_call_completed := true;
    raise exception ''publish_mechanic_policy_batch_self_test_rollback'';
  exception
    when raise_exception then
      if not v_call_completed then
        raise;
      end if;
  end;
end;
$self_test$"}', 'harden_publish_mechanic_policy_batch', NULL, NULL, NULL),
	('20260902150000', '{"-- IRIS Defensivos v2 · cierre de consistencia previo a infografía fiable.
--
-- Mantiene compatibilidad con plan_executed_count, pero deja de usar ese
-- nombre ambiguo como única verdad: adherencia exacta y cobertura funcional
-- son dimensiones distintas. También completa la clave semántica que consume
-- Fiabilidad para poder seleccionar v2 de forma atómica.

alter table player_pull_defensive_evaluations
  add column if not exists required_exact_adherence_count integer not null default 0,
  add column if not exists required_coverage_success_count integer not null default 0","update player_pull_defensive_evaluations evaluation
set
  required_exact_adherence_count = (
    select count(*)::integer
    from jsonb_array_elements(evaluation.events) event
    where event->>''requirementLevel'' = ''required''
      and event->>''state'' = ''plan_covered''
  ),
  required_coverage_success_count = (
    select count(*)::integer
    from jsonb_array_elements(evaluation.events) event
    where event->>''requirementLevel'' = ''required''
      and event->>''coverageOutcome'' = ''covered''
  )","alter table player_pull_defensive_evaluations
  drop constraint if exists player_pull_defensive_evaluations_exact_adherence_check","alter table player_pull_defensive_evaluations
  add constraint player_pull_defensive_evaluations_exact_adherence_check
  check (
    required_exact_adherence_count >= 0
    and required_exact_adherence_count <= required_coverage_success_count
    and required_exact_adherence_count <= plan_required_count
  )","alter table player_pull_defensive_evaluations
  drop constraint if exists player_pull_defensive_evaluations_coverage_success_check","alter table player_pull_defensive_evaluations
  add constraint player_pull_defensive_evaluations_coverage_success_check
  check (
    required_coverage_success_count >= 0
    and required_coverage_success_count <= plan_required_count
  )","comment on column player_pull_defensive_evaluations.required_exact_adherence_count is
  ''Required cubiertos exactamente con el spell planificado. Una sustitución no incrementa este contador.''","comment on column player_pull_defensive_evaluations.required_coverage_success_count is
  ''Required funcionalmente cubiertos, incluyendo sustituciones. No implica que la gestión de reserva fuese correcta.''","create or replace view player_pull_reliability_inputs
with (security_invoker = true) as
select
  legacy.*,
  evaluation.management_score as defensive_management_score_v2,
  case
    when evaluation.pull_id is null then null
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where event->>''state'' in (
        ''plan_broken'',
        ''death_with_viable_cd'',
        ''safe_extra_use'',
        ''missed_extra_opportunity''
      )
      or (
        event->>''state'' in (''plan_covered'', ''covered_with_substitution'', ''reminder_missed'')
        and event->>''requirementLevel'' in (''required'', ''recommended'')
      )
    )
  end as defensive_management_decision_count,
  evaluation.plan_required_count as defensive_required_count,
  evaluation.required_coverage_success_count as defensive_required_success_count,
  evaluation.broken_reservation_count as defensive_broken_reservation_count,
  evaluation.death_viable_cd_count as defensive_death_viable_cd_count,
  evaluation.data_confidence as defensive_evaluation_confidence,
  evaluation.evaluator_version as defensive_evaluator_version,
  evaluation.resolver_version as defensive_resolver_version,
  -- PostgreSQL exige conservar intactos nombre y orden de las columnas ya
  -- publicadas por M18; toda superficie nueva se añade después.
  evaluation.required_exact_adherence_count as defensive_required_exact_adherence_count,
  evaluation.solver_version as defensive_solver_version,
  evaluation.game_build as defensive_game_build,
  evaluation.build_fingerprint as defensive_build_fingerprint,
  evaluation.evaluated_at as defensive_evaluated_at
from player_pull_reliability_inputs_legacy_v1 legacy
left join player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = legacy.pull_id
 and evaluation.player_name = legacy.player_name","revoke all on player_pull_reliability_inputs from anon, authenticated","grant select on player_pull_reliability_inputs to authenticated","comment on column player_pull_reliability_inputs.defensive_required_success_count is
  ''Cobertura required funcional. No equivale a adherencia exacta ni a éxito de gestión.''","comment on column player_pull_reliability_inputs.defensive_required_exact_adherence_count is
  ''Required cubiertos con el spell exacto publicado en el plan.''","comment on column player_pull_reliability_inputs.defensive_solver_version is
  ''Versión del solver ligada a la evaluación defensiva.''","comment on column player_pull_reliability_inputs.defensive_evaluated_at is
  ''Revisión derivada usada para invalidación y selección de generación visible.''","notify pgrst, ''reload schema''"}', 'defensive_evaluation_consistency', NULL, NULL, NULL),
	('20260902160000', '{"-- Ingesta de reports recuperable por pull.
--
-- analyze-report escribe varias tablas mediante HTTP independientes. El cursor
-- del report no puede ser la única señal de completitud: un fallo después de
-- insertar pulls deja una fila real pero incompleta. Este estado explícito
-- permite reemplazar únicamente ese trabajo parcial y conservar cualquier pull
-- que sí llegó a completarse aunque después fallase el avance del cursor.

alter table pulls
  add column if not exists ingestion_status text not null default ''processing'',
  add column if not exists ingestion_error text","alter table pulls
  drop constraint if exists pulls_ingestion_status_check","alter table pulls
  add constraint pulls_ingestion_status_check
  check (ingestion_status in (''processing'', ''complete'', ''failed''))","-- Todas las filas anteriores al despliegue se consideran completas salvo las
-- que quedaron por delante del cursor persistido: esas son exactamente las
-- creadas por un batch que no llegó a confirmar su final.
update pulls
set ingestion_status = ''complete'', ingestion_error = null","update pulls pull
set
  ingestion_status = ''failed'',
  ingestion_error = ''Ingesta parcial detectada: el fight quedó por delante de last_processed_fight_id.''
from reports report
where report.code = pull.report_code
  and pull.fight_id > coalesce(report.last_processed_fight_id, 0)","create index if not exists pulls_report_ingestion_status_idx
  on pulls (report_code, ingestion_status, fight_id)","comment on column pulls.ingestion_status is
  ''Estado transaccional lógico de analyze-report. Solo complete puede tratarse como evidencia importada íntegra.''","comment on column pulls.ingestion_error is
  ''Último error verificable si la ingesta del pull quedó parcial. Null en processing/complete.''","notify pgrst, ''reload schema''"}', 'pull_ingestion_recovery', NULL, NULL, NULL),
	('20260903070000', '{"-- M23 · Ninguna superficie de lectura puede tratar una ingesta parcial como
-- evidencia. M22 ya añadió el estado y recuperó el huérfano histórico; esta
-- migración separada endurece consumidores después de comprobar que M22 ya
-- estaba aplicada en producción.

-- La service_role de analyze-report conserva acceso para recuperar filas
-- processing/failed, pero ningún lector autenticado debe verlas como pulls.
drop policy if exists \"read all - pulls\" on pulls","drop policy if exists \"read complete - pulls\" on pulls","create policy \"read complete - pulls\" on pulls
  for select using (ingestion_status = ''complete'')","-- La readiness usa service_role y por tanto salta RLS. El filtro explícito
-- evita que un pull parcial infle sus totales incluso en esa ruta privilegiada.
-- Se conserva exactamente el contrato y el orden de columnas publicados por M21.
create or replace view player_pull_reliability_inputs
with (security_invoker = true) as
select
  legacy.*,
  evaluation.management_score as defensive_management_score_v2,
  case
    when evaluation.pull_id is null then null
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where event->>''state'' in (
        ''plan_broken'',
        ''death_with_viable_cd'',
        ''safe_extra_use'',
        ''missed_extra_opportunity''
      )
      or (
        event->>''state'' in (''plan_covered'', ''covered_with_substitution'', ''reminder_missed'')
        and event->>''requirementLevel'' in (''required'', ''recommended'')
      )
    )
  end as defensive_management_decision_count,
  evaluation.plan_required_count as defensive_required_count,
  evaluation.required_coverage_success_count as defensive_required_success_count,
  evaluation.broken_reservation_count as defensive_broken_reservation_count,
  evaluation.death_viable_cd_count as defensive_death_viable_cd_count,
  evaluation.data_confidence as defensive_evaluation_confidence,
  evaluation.evaluator_version as defensive_evaluator_version,
  evaluation.resolver_version as defensive_resolver_version,
  evaluation.required_exact_adherence_count as defensive_required_exact_adherence_count,
  evaluation.solver_version as defensive_solver_version,
  evaluation.game_build as defensive_game_build,
  evaluation.build_fingerprint as defensive_build_fingerprint,
  evaluation.evaluated_at as defensive_evaluated_at
from player_pull_reliability_inputs_legacy_v1 legacy
join pulls source_pull
  on source_pull.id = legacy.pull_id
 and source_pull.ingestion_status = ''complete''
left join player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = legacy.pull_id
 and evaluation.player_name = legacy.player_name","revoke all on player_pull_reliability_inputs from anon, authenticated","grant select on player_pull_reliability_inputs to authenticated","notify pgrst, ''reload schema''"}', 'harden_pull_ingestion_recovery', NULL, NULL, NULL),
	('20260903090000', '{"-- §\"además del boss ID quiero mandar también el zoneID al que pertenece ese
-- boss... porque me suena que en alguna prueba que hice en el pasado si no se
-- ponía eso no salía\" (feedback real, 2026-09-03): known_raid_bosses.zone_id
-- ya existe, pero es el ID de zona de Warcraft Logs (53 para The Venomous
-- Abyss) — un ID interno del API de WCL sin relación con lo que el cliente
-- de WoW/MRT/BigWigs conocen en juego. Blizzard usa un ID de instancia
-- completamente distinto (3004 para The Venomous Abyss, confirmado en juego
-- por el usuario) para lo que MRT llama zoneID en su reminder. Aditivo: no
-- toca zone_id ni ninguna columna existente.
alter table public.known_raid_bosses
  add column if not exists blizzard_zone_id bigint","comment on column public.known_raid_bosses.blizzard_zone_id is
  ''ID de instancia/zona de Blizzard (el que usan el cliente de WoW y addons como MRT/BigWigs), distinto de zone_id (ID de zona de la API de Warcraft Logs). Ver mrt-reminder-codec.ts.''","-- Primer valor conocido, confirmado en juego por el usuario (2026-09-03).
update public.known_raid_bosses
set blizzard_zone_id = 3004
where zone_name = ''The Venomous Abyss'' and blizzard_zone_id is null"}', 'known_raid_bosses_blizzard_zone_id', NULL, NULL, NULL),
	('20260903100000', '{"-- §\"un cast debe cubrir toda su ventana de duración (no un recordatorio por
-- cada ocurrencia cercana)\" (feedback real, 2026-09-03). El solver
-- (defensive-plan-solver@2.2.0) ahora detecta cuándo una ocurrencia cubierta
-- ya está protegida por la duración de un cast anterior del mismo
-- jugador+defensivo — no hace falta un press nuevo, así que no debe generar
-- un segundo recordatorio de MRT para lo mismo.

alter table defensive_plan_slots
  add column if not exists needs_fresh_cast boolean not null default true,
  add column if not exists covered_by_prior_cast_at_ms integer
    check (covered_by_prior_cast_at_ms is null or covered_by_prior_cast_at_ms >= 0)","alter table defensive_plan_slots
  drop constraint if exists defensive_plan_slots_duration_coverage_check","alter table defensive_plan_slots
  add constraint defensive_plan_slots_duration_coverage_check
  check (needs_fresh_cast or coverage_status in (''covered'', ''partial''))","comment on column defensive_plan_slots.needs_fresh_cast is
  ''false = este slot ya está protegido por la duración de un cast anterior del mismo jugador+defensivo; no generar un recordatorio MRT nuevo.''","comment on column defensive_plan_slots.covered_by_prior_cast_at_ms is
  ''planned_cast_at_ms del cast anterior que ya cubre este slot, cuando needs_fresh_cast es false.''"}', 'defensive_plan_slots_duration_coverage', NULL, NULL, NULL),
	('20260903110000', '{"-- §\"el trigger... se puede anclar a una mecánica de bossmod o de bigwigs...
-- ten en cuenta todo esto\" (feedback real, 2026-09-03). El plan automático
-- (generate-defensive-plan) convierte cada fila de mechanic_defensive_
-- assignments en una reserva blanda para cada ocurrencia de esa ability, pero
-- SIEMPRE mandaba bossmodCounterVerified=false al solver — no existía forma
-- de guardar el counter real de BigWigs/DBM, así que la asignación
-- automática degradaba en silencio a un trigger de tiempo fijo incluso
-- cuando el oficial ya había puesto bossmod_spell_id a mano. Mismo patrón de
-- verificación explícita que defensive_plan_slots (migración 20260901110000):
-- sin marcar verified, sigue degradando de forma segura, nunca se asume.

alter table mechanic_defensive_assignments
  add column if not exists bossmod_counter text,
  add column if not exists bossmod_counter_verified boolean not null default false","alter table mechanic_defensive_assignments
  drop constraint if exists mechanic_defensive_assignments_bossmod_counter_check","alter table mechanic_defensive_assignments
  add constraint mechanic_defensive_assignments_bossmod_counter_check
  check (not bossmod_counter_verified or (trigger_type = ''bossmod'' and nullif(btrim(bossmod_counter), '''') is not null))","comment on column mechanic_defensive_assignments.bossmod_counter is
  ''Contador de la ocurrencia en el timer de BigWigs/DBM (p.ej. \"2\" para el 2º cast de esta ability). Ver mrt-reminder-codec.ts.''","comment on column mechanic_defensive_assignments.bossmod_counter_verified is
  ''true = el oficial confirmó este counter contra un timer real en juego. Sin esto, generate-defensive-plan degrada a trigger de tiempo fijo aunque haya bossmod_spell_id — nunca se asume un counter sin verificar.''"}', 'mechanic_defensive_assignments_bossmod_counter', NULL, NULL, NULL),
	('20260903120000', '{"-- §\"si a Gusmi le marco que tiene Barkskin y Frenzied Regeneration, no tiene
-- sentido que cada vez que entre en Gusmi tenga que quitarle el check de
-- Ironfur y ponerle el check de Frenzied Regeneration\" (feedback real,
-- 2026-09-03): planningResourceSelections en boss-prep.component.ts vivía
-- solo en memoria (signal sin persistencia), se perdía en cada recarga y no
-- se compartía entre oficiales. No se reutiliza player_defensive_overrides
-- (migración 20260831220000): esa tabla exige `reason` obligatorio y al
-- menos una corrección numérica/targeting — es para correcciones auditadas
-- de valores efectivos, no para el checkbox \"usar en el plan\" que un
-- oficial marca sobre un kit ya resuelto. Aditiva, sin tocar tablas/RLS
-- existentes.

create table if not exists player_planning_resource_selections (
  id uuid primary key default gen_random_uuid(),
  character_id bigint,
  player_name text not null check (btrim(player_name) <> ''''),
  class text not null check (btrim(class) <> ''''),
  -- Conjunto COMPLETO de spellIds seleccionados, no un diff — mismo criterio
  -- que ya usa hoy togglePlanningResource() en el cliente (siempre
  -- materializa el conjunto entero antes de guardar).
  selected_spell_ids bigint[] not null default ''{}'',
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)","comment on table player_planning_resource_selections is
  ''Qué defensivos personales tiene marcados un oficial para entrar en la planificación de un jugador. Una fila por jugador (no por boss/dificultad: la selección es del kit del jugador, igual que ya se comportaba en memoria).''","comment on column player_planning_resource_selections.selected_spell_ids is
  ''Conjunto completo de spellId marcados \"usar en el plan\" — se reemplaza entero en cada guardado, nunca se parchea.''","-- Una fila activa por identidad lógica — mismo patrón exacto que
-- player_defensive_overrides_active_scope_key (migración 20260831220000):
-- character_id cuando existe, si no nombre en minúsculas.
create unique index if not exists player_planning_resource_selections_identity_key
  on player_planning_resource_selections (
    (case
      when character_id is not null then ''id:'' || character_id::text
      else ''name:'' || lower(player_name)
    end)
  )","alter table player_planning_resource_selections enable row level security","drop policy if exists \"player_planning_resource_selections: officers read\" on player_planning_resource_selections","create policy \"player_planning_resource_selections: officers read\"
  on player_planning_resource_selections for select
  using (is_officer())","revoke all on player_planning_resource_selections from anon","grant select on player_planning_resource_selections to authenticated","-- Único punto de escritura (mismo criterio que save_exact_player_defensive_
-- override, migración 20260901150000): el índice único de identidad es una
-- expresión (case character_id/nombre), y PostgREST upsert() solo sabe
-- resolver ON CONFLICT sobre columnas literales — hace falta una función.
-- Sin tabla de auditoría aparte: no es una corrección de valores auditada,
-- es un checkbox de planificación que se reemplaza entero en cada guardado.
create or replace function save_planning_resource_selection(
  p_character_id bigint,
  p_player_name text,
  p_class text,
  p_selected_spell_ids bigint[],
  p_changed_by uuid
)
returns player_planning_resource_selections
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing player_planning_resource_selections;
  v_result player_planning_resource_selections;
begin
  if nullif(btrim(p_player_name), '''') is null then raise exception ''player_name obligatorio.'' using errcode = ''23514''; end if;
  if nullif(btrim(p_class), '''') is null then raise exception ''class obligatoria.'' using errcode = ''23514''; end if;

  select * into v_existing
  from player_planning_resource_selections
  where (case when p_character_id is not null then ''id:'' || p_character_id::text else ''name:'' || lower(btrim(p_player_name)) end)
      = (case when character_id is not null then ''id:'' || character_id::text else ''name:'' || lower(player_name) end)
  for update;

  if v_existing.id is null then
    insert into player_planning_resource_selections (character_id, player_name, class, selected_spell_ids, updated_by)
    values (p_character_id, btrim(p_player_name), btrim(p_class), coalesce(p_selected_spell_ids, ''{}''), p_changed_by)
    returning * into v_result;
  else
    update player_planning_resource_selections
    set selected_spell_ids = coalesce(p_selected_spell_ids, ''{}''),
        class = btrim(p_class),
        character_id = coalesce(p_character_id, character_id),
        updated_by = p_changed_by,
        updated_at = now()
    where id = v_existing.id
    returning * into v_result;
  end if;
  return v_result;
end;
$$","revoke all on function save_planning_resource_selection(bigint, text, text, bigint[], uuid) from public, anon, authenticated","grant execute on function save_planning_resource_selection(bigint, text, text, bigint[], uuid) to service_role"}', 'player_planning_resource_selections', NULL, NULL, NULL),
	('20260903130000', '{"-- §\"el oso del druida y el paladín... esa fuente de información no debe
-- existir en una infografía\" / \"los nombres de las habilidades deberían
-- salir bien... lo mismo con Pandokie que es monk y sí tiene pulls\"
-- (feedback real, 2026-09-03): un envío manual de classify-defensives dejó
-- en cooldown_catalog.name un fragmento de cita markdown/JSON sin terminar
-- de parsear — patrón real confirmado por consulta directa (15 filas):
-- \"Bear](https://.../survival-of-the-fittest%22}]}],%22missingDefensives%22:
-- [{%22spellId%22:5487,%22name%22:%22Bear) Form\" en vez de \"Bear Form\". La
-- app ya no muestra el texto crudo gracias a safeSpellName() (detecta el
-- patrón y cae a \"#<spellId>\"), pero eso es un salvavidas de presentación,
-- no una corrección del dato — esta migración corrige el dato en origen
-- para las 15 filas confirmadas por consulta de solo lectura contra
-- producción. Todas identificadas sin ambigüedad por spellId (nombres reales
-- de habilidades conocidas, no una interpretación).
--
-- Se corrige por spell_id + class (no solo spell_id) como guarda adicional,
-- aunque los IDs de hechizo son globales en WoW. No se toca ninguna otra
-- columna (spec, category, survival_type, etc.) ni se reintroduce ningún
-- dato nuevo — solo el nombre.

update cooldown_catalog set name = ''Bear Form'' where spell_id = 5487 and class = ''Druid''","update cooldown_catalog set name = ''Incarnation: Tree of Life'' where spell_id = 33891 and class = ''Druid''","update cooldown_catalog set name = ''Incarnation: Guardian of Ursoc'' where spell_id = 102558 and class = ''Druid''","update cooldown_catalog set name = ''Nature''''s Swiftness'' where spell_id = 132158 and class = ''Druid''","update cooldown_catalog set name = ''Lunar Beam'' where spell_id = 204066 and class = ''Druid''","update cooldown_catalog set name = ''Call of the Elder Druid'' where spell_id = 426784 and class = ''Druid''","update cooldown_catalog set name = ''Purifying Brew'' where spell_id = 119582 and class = ''Monk''","update cooldown_catalog set name = ''Expel Harm'' where spell_id = 322101 and class = ''Monk''","update cooldown_catalog set name = ''Exploding Keg'' where spell_id = 325153 and class = ''Monk''","update cooldown_catalog set name = ''Transcendence: Transfer'' where spell_id = 434766 and class = ''Monk''","update cooldown_catalog set name = ''Celestial Conduit'' where spell_id = 443028 and class = ''Monk''","update cooldown_catalog set name = ''Elixir of Determination'' where spell_id = 455139 and class = ''Monk''","update cooldown_catalog set name = ''Flash of Light'' where spell_id = 19750 and class = ''Paladin''","update cooldown_catalog set name = ''Aura Mastery'' where spell_id = 31821 and class = ''Paladin''","update cooldown_catalog set name = ''Shield of the Righteous'' where spell_id = 53600 and class = ''Paladin''","-- Verificación explícita (falla la migración entera si algo no cuadra en
-- vez de dejar una fila corregida a medias sin que nadie se entere): las 15
-- filas ya no deben matchear el mismo patrón de corrupción que usa
-- safeSpellName() en el cliente (format.util.ts TECHNICAL_NAME_PATTERN).
do $$
declare
  v_still_corrupted integer;
begin
  select count(*) into v_still_corrupted
  from cooldown_catalog
  where spell_id in (5487, 33891, 102558, 132158, 204066, 426784, 119582, 322101, 325153, 434766, 443028, 455139, 19750, 31821, 53600)
    and (name ~* ''(https?://|[{}\\[\\]]|%[0-9a-f]{2}|\"[a-z]+\"\\s*:)'' or length(name) > 40);
  if v_still_corrupted > 0 then
    raise exception ''Quedan % filas todavía con nombre corrupto tras la corrección.'', v_still_corrupted;
  end if;
end $$"}', 'fix_corrupted_cooldown_catalog_names', NULL, NULL, NULL),
	('20260903140000', '{"-- IRIS Defensive Canonicalization v1 · Paso A-1
-- Ver iris-defensive-canonicalization-v1-plan.md §2.1/§4/§8 para el
-- razonamiento completo.
--
-- cooldown_catalog se queda como FACTS (sincronización externa: qué existe,
-- cooldown/duración base). Esta migración añade una tabla compañera que
-- guarda la SEMÁNTICA IRIS (qué significa esa habilidad para nuestros KPI)
-- — una sincronización futura puede volver a decir \"Barkskin ahora dura X\"
-- pero nunca \"Riptide ahora es personal defensive\". category/targeting_mode
-- de cooldown_catalog NO se tocan ni se retiran todavía (siguen siendo
-- consumidos por classify-defensives y por el resolver v2.1.0 actual);
-- esta migración es puramente aditiva salvo el punto 4 (default peligroso).
--
-- Migración 100% aditiva: no se borra ni renombra ninguna columna/tabla
-- existente, no se reescribe ninguna fila de cooldown_catalog.

-- 1) Tabla de semántica IRIS, 1:1 con cooldown_catalog.
create table if not exists defensive_ability_semantics (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references cooldown_catalog (id) on delete cascade,

  -- Función real de la habilidad para el KPI defensivo. Ver §1 del plan.
  usage_role text not null default ''unknown''
    check (usage_role in (
      ''personal_survival'', ''survival_state'', ''active_mitigation'',
      ''rotational_survival'', ''healer_throughput'', ''external'',
      ''raid_defensive'', ''utility'', ''unknown''
    )),

  -- Quién puede ser el destinatario PRINCIPAL elegido por el jugador.
  -- Sustituye a la pareja activationScope+allySelectable de la propuesta
  -- original (ver §4.1 del plan: eran redundantes por construcción — una
  -- habilidad no puede ser simultáneamente ''self'' y ally-selectable).
  activation_scope text not null default ''unknown''
    check (activation_scope in (''self'', ''ally_selectable'', ''enemy'', ''ground'', ''raid'', ''unknown'')),

  -- Efecto secundario automático sobre terceros (no elegido por el
  -- jugador). No afecta a si la habilidad cuenta como personal — ver AMS.
  secondary_propagation text not null default ''none''
    check (secondary_propagation in (''none'', ''automatic_ally'', ''automatic_party'', ''automatic_raid'')),

  -- Puede tener más de un mecanismo simultáneo (ej. Desperate Prayer:
  -- sustain + effective_health).
  mechanisms text[] not null default ''{}''
    check (mechanisms <@ array[''mitigation'', ''absorption'', ''sustain'', ''immunity'', ''avoidance'', ''effective_health'']::text[]),

  -- credit_only (ej. Bear Form): puede resolver un episodio ya evaluable
  -- pero nunca fabrica un missed_ready por su mera disponibilidad.
  opportunity_mode text not null default ''normal''
    check (opportunity_mode in (''normal'', ''credit_only'', ''none'')),

  -- pending = todavía sin clasificar de verdad; nunca penaliza a un
  -- raider mientras esté en pending. rejected = se evaluó y no es
  -- relevante para ningún KPI defensivo (ej. cosmético).
  semantic_status text not null default ''pending''
    check (semantic_status in (''verified'', ''pending'', ''rejected'')),

  semantic_version text not null default ''defensive-semantics@1.0.0'',

  -- Mismo vocabulario de confidence ya usado en player_execution_events /
  -- player_mechanic_offenses_v3 (verified/inferred/fallback/uncertain) —
  -- no se inventa uno nuevo para este dominio.
  confidence text
    check (confidence is null or confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),

  -- Una fila verified+locked no puede ser pisada por una sincronización
  -- automática futura (invariante 11 del plan) — solo edición de officer.
  locked boolean not null default false,

  source text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (catalog_id)
)","comment on table defensive_ability_semantics is
  ''Semántica IRIS de una habilidad del catálogo: qué significa para los KPI defensivos, separada de los facts (cooldown_catalog). Membership de \"defensivo personal\" se DERIVA de estas columnas (ver vista defensive_ability_semantic_catalog), nunca se guarda como booleano editable directo.''","comment on column defensive_ability_semantics.usage_role is
  ''personal_survival = entra en Respuesta defensiva. survival_state = entra en el kit pero opportunity_mode=credit_only. El resto queda fuera del KPI general (puede vivir en módulos específicos: active_mitigation en tank, etc.).''","comment on column defensive_ability_semantics.activation_scope is
  ''self = el jugador no puede elegir a otro como destinatario principal (aunque propague automáticamente, ver secondary_propagation). ally_selectable/raid = el jugador SÍ puede elegir a otro — nunca cuenta como kit personal aunque a veces se lance sobre uno mismo.''","comment on column defensive_ability_semantics.semantic_status is
  ''pending = sin clasificar todavía, NUNCA penaliza a un raider. verified = clasificación confirmada, entra en los predicados derivados. rejected = evaluada y descartada explícitamente de todo KPI.''","comment on column defensive_ability_semantics.locked is
  ''true = una sincronización externa (classify-defensives en modo sync, wowanalyzer-extractor) no puede sobrescribir esta fila; solo edición explícita de officer.''","create index if not exists defensive_ability_semantics_status_idx
  on defensive_ability_semantics (semantic_status)","-- 2) Modificadores de semántica por build/talento (ej. Refractive Images
-- convierte Mirror Image de utility a personal_survival+mitigation).
-- Mismo patrón de tabla que defensive_modifier_rules (research v5), pero
-- para SEMÁNTICA en vez de para timings numéricos.
create table if not exists defensive_semantic_rules (
  id uuid primary key default gen_random_uuid(),
  modifier_spell_id bigint not null,
  target_spell_id bigint not null,
  specs text[] not null default ''{}'',
  game_build text not null default ''legacy-current'',
  rule_type text not null check (rule_type in (''augment'', ''replace'', ''suppress'')),
  -- payload declarativo, ej. {\"usageRole\":\"personal_survival\",\"addMechanisms\":[\"mitigation\"]}
  payload jsonb not null default ''{}''::jsonb,
  source text,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (modifier_spell_id, target_spell_id, game_build, rule_type)
)","comment on table defensive_semantic_rules is
  ''Reglas declarativas: un talento/pasivo (modifier_spell_id) que cambia la semántica IRIS de otra habilidad (target_spell_id) para las specs/build indicadas. verified=false no se aplica todavía en el resolver, queda como propuesta.''","create index if not exists defensive_semantic_rules_target_idx
  on defensive_semantic_rules (target_spell_id, game_build)
  where verified = true","-- 3) Vista única de membership derivada — el resolver del Paso C y
-- cualquier UI/test deben consumir esta vista, no reimplementar el
-- predicado. Dos predicados, no uno (ver §4.2 del plan: un solo
-- countsAsPersonalDefensive excluía Bear Form por accidente).
create or replace view defensive_ability_semantic_catalog
with (security_invoker = true) as
select
  c.id as catalog_id,
  c.class,
  c.spec,
  c.spell_id,
  c.name,
  c.category,
  c.targeting_mode,
  c.activation_mode,
  c.passive_conversion_spell_ids,
  c.activation_game_build,
  s.usage_role,
  s.activation_scope,
  s.secondary_propagation,
  s.mechanisms,
  s.opportunity_mode,
  s.semantic_status,
  s.semantic_version,
  s.confidence,
  s.locked,
  s.source,
  s.reviewed_at,
  (
    coalesce(s.semantic_status, ''pending'') = ''verified''
    and c.activation_mode = ''active''
    and s.activation_scope = ''self''
    and s.usage_role in (''personal_survival'', ''survival_state'')
    and coalesce(array_length(s.mechanisms, 1), 0) > 0
  ) as is_defensive_kit_member,
  (
    coalesce(s.semantic_status, ''pending'') = ''verified''
    and c.activation_mode = ''active''
    and s.activation_scope = ''self''
    and s.usage_role = ''personal_survival''
    and coalesce(array_length(s.mechanisms, 1), 0) > 0
    and s.opportunity_mode = ''normal''
  ) as creates_missable_opportunity
from cooldown_catalog c
left join defensive_ability_semantics s on s.catalog_id = c.id","comment on view defensive_ability_semantic_catalog is
  ''Única fuente de membership defensiva derivada. is_defensive_kit_member (incluye survival_state, ej. Bear Form) alimenta Uso observado y puede resolver un episodio. creates_missable_opportunity (excluye survival_state) es el único que puede generar missed_ready. Ningún consumer debe recalcular este predicado por su cuenta (invariante 1 del plan).''","-- 4) Nace pendiente, no defensiva: cualquier fila nueva de cooldown_catalog
-- (classify-defensives, sync futuro, seed manual) recibe automáticamente
-- una fila de semántica en pending — no depende de que cada writer se
-- actualice para no dejar huecos.
create or replace function ensure_defensive_ability_semantics_pending()
returns trigger
language plpgsql
as $$
begin
  insert into defensive_ability_semantics (catalog_id, semantic_status, source)
  values (new.id, ''pending'', ''cooldown_catalog_insert_trigger'')
  on conflict (catalog_id) do nothing;
  return new;
end;
$$","drop trigger if exists trg_cooldown_catalog_semantics_pending on cooldown_catalog","create trigger trg_cooldown_catalog_semantics_pending
  after insert on cooldown_catalog
  for each row execute function ensure_defensive_ability_semantics_pending()","comment on function ensure_defensive_ability_semantics_pending() is
  ''Garantiza que cooldown_catalog.category=... nunca vuelve a ser la única fuente de si algo es defensivo: toda fila nueva nace con semántica pending, nunca verified, sin importar qué Edge Function la insertó.''","-- 5) Backfill: una fila pending por cada entrada YA existente. No
-- clasifica nada todavía (eso es el Paso B, backfill masivo con reglas
-- deterministas + IA) — solo asegura que desde este momento ninguna
-- habilidad del catálogo actual carece de fila de semántica.
insert into defensive_ability_semantics (catalog_id, semantic_status, source)
select id, ''pending'', ''backfill_20260903140000''
from cooldown_catalog
on conflict (catalog_id) do nothing","-- 6) Retirar el default peligroso: una habilidad nueva sin category
-- explícita debe fallar el insert, no nacer silenciosamente dentro del
-- universo defensivo. Verificado: el único writer que inserta filas
-- nuevas hoy (classify-defensives/index.ts) siempre fija `category`
-- explícitamente y la valida contra CATEGORIES antes del insert — no
-- dependía de este default. La columna sigue NOT NULL.
alter table cooldown_catalog alter column category drop default","-- 7) RLS: mismo patrón que defensive_spec_profiles/defensive_modifier_rules
-- (research v5) — lectura solo para officers autenticados, escritura
-- exclusiva de service_role (Edge Functions), sin políticas de
-- insert/update/delete para anon/authenticated.
alter table defensive_ability_semantics enable row level security","alter table defensive_semantic_rules enable row level security","drop policy if exists \"defensive_ability_semantics: officers read\" on defensive_ability_semantics","create policy \"defensive_ability_semantics: officers read\"
  on defensive_ability_semantics for select
  using (is_officer())","drop policy if exists \"defensive_semantic_rules: officers read\" on defensive_semantic_rules","create policy \"defensive_semantic_rules: officers read\"
  on defensive_semantic_rules for select
  using (is_officer())","revoke all on defensive_ability_semantics from anon","revoke all on defensive_semantic_rules from anon","grant select on defensive_ability_semantics to authenticated","grant select on defensive_semantic_rules to authenticated","revoke all on defensive_ability_semantic_catalog from anon","grant select on defensive_ability_semantic_catalog to authenticated","notify pgrst, ''reload schema''"}', 'defensive_ability_semantics', NULL, NULL, NULL),
	('20260903150000', '{"-- IRIS Defensive Canonicalization v1 · Paso B-1 (backfill determinista)
-- Ver iris-defensive-canonicalization-v1-plan.md §5 (Paso B) y §8.
--
-- Solo se marca semantic_status=''verified'' donde el hecho es estructural y
-- no depende de investigar la habilidad una por una:
--
--   1) category IN (semi_defensive, external_defensive) — por definición
--      el jugador PUEDE elegir a otro como destinatario (targeting_mode
--      ''both''/''ally''/''raid''), lo que ya descalifica la fila del KPI
--      personal (criterio §1 del plan) sin importar el usage_role exacto.
--   2) Dos excepciones nombradas explícitamente en el plan (Bear Form,
--      Death Strike) — fixtures obligatorias (§7), no una suposición.
--
-- La auditoría de las 216 filas mostró que category=''personal_defensive''
-- AND targeting_mode=''self'' (146 filas) mezcla CDs personales reales con
-- lo que en muchos casos parecen talentos/pasivos modificadores de otra
-- habilidad (ej. Refractive Images, Ice Cold — el propio §24 del plan ya
-- cita Ice Cold como \"reemplaza/suprime Ice Block\", no como defensivo
-- independiente) y con casos build-dependientes (Mirror Image, Fade).
-- Clasificar eso a mano por SQL recrearía el mismo problema que esta
-- migración existe para arreglar — se deja pending a propósito para el
-- Paso B-2 (classify-defensives extendido, investigación real por
-- habilidad, igual que ya hace con category/cooldown/duration hoy).

-- 1) semi_defensive / external_defensive: nunca cuentan como personales.
update defensive_ability_semantics s
set
  usage_role = case
    when c.category = ''external_defensive'' and c.targeting_mode = ''raid'' then ''raid_defensive''
    when c.category = ''external_defensive'' then ''external''
    else ''healer_throughput'' -- semi_defensive: heal/protección libremente targeteable
  end,
  activation_scope = case c.targeting_mode
    when ''both'' then ''ally_selectable''
    when ''ally'' then ''ally_selectable''
    when ''raid'' then ''raid''
    else ''unknown''
  end,
  secondary_propagation = ''none'',
  mechanisms = case c.survival_type
    when ''mitigation'' then array[''mitigation'']
    when ''absorption'' then array[''absorption'']
    when ''sustain'' then array[''sustain'']
    when ''emergency'' then array[''effective_health'']
    else ''{}''
  end::text[],
  -- No cuentan para el KPI personal en absoluto (activation_scope != self
  -- ya las excluye); opportunity_mode=none lo deja explícito.
  opportunity_mode = ''none'',
  semantic_status = ''verified'',
  confidence = ''inferred'', -- derivado de category/targeting_mode/survival_type ya curados, no re-verificado habilidad por habilidad
  source = ''deterministic_backfill_paso_b1'',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.category in (''semi_defensive'', ''external_defensive'')","-- 2) Pre-fill barato (sin marcar verified): un pasivo nunca fabrica una
-- oportunidad, sin importar cuál acabe siendo su usage_role real. Solo
-- toca filas que sigan pending — no pisa nada ya resuelto arriba.
update defensive_ability_semantics s
set
  opportunity_mode = ''none'',
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.activation_mode = ''passive''
  and s.semantic_status = ''pending''","-- 3) Bear Form — fixture Gusmï (§7 del plan): survival_state, credit_only.
-- Casi siempre disponible; no debe fabricar missed_ready por su mera
-- disponibilidad, pero un uso correcto sí puede resolver un episodio.
update defensive_ability_semantics s
set
  usage_role = ''survival_state'',
  activation_scope = ''self'',
  secondary_propagation = ''none'',
  mechanisms = array[''mitigation'', ''effective_health''],
  opportunity_mode = ''credit_only'',
  semantic_status = ''verified'',
  confidence = ''verified'',
  source = ''plan_fixture_bear_form'',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.class = ''Druid''
  and c.name = ''Bear Form''","-- 4) Death Strike — fixture DK (§1/§5 del plan, \"rotational survival\"):
-- cura al DK pero se lanza CONTRA un enemigo y es parte de la rotación de
-- recursos. targeting_mode=''self'' en cooldown_catalog describe a quién
-- BENEFICIA, no contra quién se dirige el cast — activation_scope=''enemy''
-- corrige esa conflación para este caso concreto. No personal_survival.
update defensive_ability_semantics s
set
  usage_role = ''rotational_survival'',
  activation_scope = ''enemy'',
  secondary_propagation = ''none'',
  mechanisms = array[''sustain''],
  opportunity_mode = ''none'',
  semantic_status = ''verified'',
  confidence = ''verified'',
  source = ''plan_fixture_death_strike'',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.class = ''DeathKnight''
  and c.name = ''Death Strike''","notify pgrst, ''reload schema''"}', 'defensive_semantics_deterministic_backfill', NULL, NULL, NULL),
	('20260903160000', '{"-- IRIS Defensive Canonicalization v1 · alineación con el prompt v10 de
-- classify-defensives (ver iris-defensive-canonicalization-v1-plan.md §5
-- Paso B-2 y su registro de avance §8).
--
-- El prompt v10 introduce un campo que faltaba en el contrato v9 y que es
-- estructuralmente importante: primaryBeneficiary, SEPARADO de
-- activationScope. Sin él, \"Fiery Brand se dirige a un enemigo pero protege
-- al caster\" no se podía modelar como personal_survival — el v9 exigía
-- activationScope=''self'' para contar como kit personal, lo cual es
-- incorrecto en general (ya lo era para Death Strike, que precisamente por
-- eso quedaba fuera vía activation_scope=''enemy''; pero un Fiery Brand-like
-- necesitaría entrar SIENDO enemy-scoped). primary_beneficiary=''self'' pasa a
-- ser la condición real de membership; activation_scope dejó de serlo.
--
-- También amplía los enums (usage_role +hybrid_survival +passive_survival,
-- activation_scope +none para pasivos, mechanisms +lethal_prevention) y
-- añade almacenamiento para defensiveIntent/applicability/
-- specSemanticProfiles — datos que el prompt v10 ya produce y que Paso C
-- (aplicabilidad daño↔defensivo, semántica por spec) va a necesitar leer.
-- applicability/specSemanticProfiles se guardan como jsonb con forma
-- documentada (igual que cooldown_catalog.ai_classification ya hace para
-- datos de razonamiento IA) en vez de normalizarlas en tablas nuevas todavía
-- — Paso C decide su forma normalizada final cuando exista un consumer real
-- que la consulte con patrones de query concretos.
--
-- Aditiva: no se borra ni renombra ninguna columna existente. Los datos ya
-- verified de Paso B-1 se retro-etiquetan con primary_beneficiary/
-- defensive_intent para no perder membership bajo el nuevo predicado (ver
-- backfill al final).

alter table defensive_ability_semantics
  add column if not exists primary_beneficiary text not null default ''unknown''
    check (primary_beneficiary in (''self'', ''self_or_ally_selectable'', ''ally_selectable'', ''party'', ''raid'', ''none'', ''unknown'')),
  add column if not exists defensive_intent text not null default ''unknown''
    check (defensive_intent in (''primary'', ''hybrid'', ''incidental'', ''none'', ''unknown'')),
  add column if not exists applicability jsonb,
  add column if not exists applicability_confidence text
    check (applicability_confidence is null or applicability_confidence in (''high'', ''medium'', ''low'')),
  add column if not exists spec_semantic_profiles jsonb not null default ''[]''::jsonb","comment on column defensive_ability_semantics.primary_beneficiary is
  ''Quién recibe la protección PRINCIPAL — ortogonal a activation_scope (a quién se dirige el cast). Es la condición real de membership al kit personal (self), no activation_scope: Fiery Brand puede ser activation_scope=enemy y primary_beneficiary=self y seguir siendo personal_survival.''","comment on column defensive_ability_semantics.defensive_intent is
  ''primary/hybrid/incidental — informativo para coaching y para que un officer entienda por qué algo cuenta o no; no es una condición del predicado de membership derivado.''","comment on column defensive_ability_semantics.applicability is
  ''Forma: {schoolScope, schools[], deliveryScopes[], requiresDodgeable, requiresParryable, requiresBlockable, requiresSourceAffectedBySpell, timingRelation, notes} — igual que el schema del prompt v10 de classify-defensives. Alimentará canDefensiveCover() en Paso C; hasta entonces es evidencia capturada, no consumida por ningún score.''","comment on column defensive_ability_semantics.spec_semantic_profiles is
  ''Array de overrides semánticos por spec cuando UNA fila de cooldown_catalog cubre varias specs con semántica realmente distinta (mismo patrón que defensive_spec_profiles para timing, pero para usageRole/activationScope/primaryBeneficiary/mechanisms/opportunityMode/applicability). [] = sin diferencias por spec.''","alter table defensive_ability_semantics
  drop constraint defensive_ability_semantics_usage_role_check","alter table defensive_ability_semantics
  add constraint defensive_ability_semantics_usage_role_check
  check (usage_role in (
    ''personal_survival'', ''survival_state'', ''hybrid_survival'', ''active_mitigation'',
    ''rotational_survival'', ''healer_throughput'', ''external'', ''raid_defensive'',
    ''passive_survival'', ''utility'', ''unknown''
  ))","alter table defensive_ability_semantics
  drop constraint defensive_ability_semantics_activation_scope_check","alter table defensive_ability_semantics
  add constraint defensive_ability_semantics_activation_scope_check
  check (activation_scope in (''self'', ''ally_selectable'', ''enemy'', ''ground'', ''raid'', ''none'', ''unknown''))","alter table defensive_ability_semantics
  drop constraint defensive_ability_semantics_mechanisms_check","alter table defensive_ability_semantics
  add constraint defensive_ability_semantics_mechanisms_check
  check (mechanisms <@ array[''mitigation'', ''absorption'', ''sustain'', ''immunity'', ''avoidance'', ''effective_health'', ''lethal_prevention'']::text[])","-- replacementRules del prompt v10 incluye action:\"convert_to_passive\", que
-- el rule_type original (research v5) no contemplaba.
alter table defensive_semantic_rules
  drop constraint defensive_semantic_rules_rule_type_check","alter table defensive_semantic_rules
  add constraint defensive_semantic_rules_rule_type_check
  check (rule_type in (''augment'', ''replace'', ''suppress'', ''convert_to_passive''))","-- Vista de membership: primary_beneficiary sustituye a activation_scope como
-- condición de \"self\". hybrid_survival se une a survival_state en el mismo
-- cubo (cuenta para el kit, nunca fabrica missed_ready por su cuenta) —
-- ambos exigen opportunity_mode=credit_only por contrato (ver
-- defensiveSemanticError en _shared/defensive-classification-semantics.ts).
-- CREATE OR REPLACE VIEW no admite insertar una columna en medio de la lista
-- existente (solo apéndices al final) — primary_beneficiary va entre
-- activation_scope y secondary_propagation, así que hace falta recrearla.
drop view if exists defensive_ability_semantic_catalog","create view defensive_ability_semantic_catalog
with (security_invoker = true) as
select
  c.id as catalog_id,
  c.class,
  c.spec,
  c.spell_id,
  c.name,
  c.category,
  c.targeting_mode,
  c.activation_mode,
  c.passive_conversion_spell_ids,
  c.activation_game_build,
  s.usage_role,
  s.activation_scope,
  s.primary_beneficiary,
  s.secondary_propagation,
  s.mechanisms,
  s.opportunity_mode,
  s.defensive_intent,
  s.applicability,
  s.applicability_confidence,
  s.spec_semantic_profiles,
  s.semantic_status,
  s.semantic_version,
  s.confidence,
  s.locked,
  s.source,
  s.reviewed_at,
  (
    coalesce(s.semantic_status, ''pending'') = ''verified''
    and c.activation_mode = ''active''
    and coalesce(s.primary_beneficiary, ''unknown'') = ''self''
    and s.usage_role in (''personal_survival'', ''survival_state'', ''hybrid_survival'')
    and coalesce(array_length(s.mechanisms, 1), 0) > 0
  ) as is_defensive_kit_member,
  (
    coalesce(s.semantic_status, ''pending'') = ''verified''
    and c.activation_mode = ''active''
    and coalesce(s.primary_beneficiary, ''unknown'') = ''self''
    and s.usage_role = ''personal_survival''
    and coalesce(array_length(s.mechanisms, 1), 0) > 0
    and s.opportunity_mode = ''normal''
  ) as creates_missable_opportunity
from cooldown_catalog c
left join defensive_ability_semantics s on s.catalog_id = c.id","comment on view defensive_ability_semantic_catalog is
  ''Única fuente de membership defensiva derivada (v10: primary_beneficiary, no activation_scope, decide \"self\"). is_defensive_kit_member incluye survival_state/hybrid_survival (credit_only). creates_missable_opportunity solo personal_survival + opportunity_mode=normal. Ningún consumer debe recalcular este predicado por su cuenta (invariante 1 del plan).''","-- Backfill: las 72 filas ya verified de Paso B-1 no tenían primary_beneficiary
-- (nace en ''unknown'' por default) — sin esto, Bear Form perdería
-- is_defensive_kit_member bajo el nuevo predicado.
update defensive_ability_semantics s
set
  primary_beneficiary = case
    when c.category = ''semi_defensive'' then ''self_or_ally_selectable''
    when c.category = ''external_defensive'' and c.targeting_mode = ''raid'' then ''raid''
    when c.category = ''external_defensive'' then ''ally_selectable''
    else s.primary_beneficiary
  end,
  defensive_intent = case
    when c.category in (''semi_defensive'', ''external_defensive'') then ''none''
    else s.defensive_intent
  end,
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and s.semantic_status = ''verified''
  and c.category in (''semi_defensive'', ''external_defensive'')","update defensive_ability_semantics s
set primary_beneficiary = ''self'', defensive_intent = ''primary'', updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id and c.class = ''Druid'' and c.name = ''Bear Form''","update defensive_ability_semantics s
set primary_beneficiary = ''self'', defensive_intent = ''hybrid'', updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id and c.class = ''DeathKnight'' and c.name = ''Death Strike''","-- drop view borra los grants del objeto anterior — se re-otorgan igual que
-- en la migración de Paso A-1.
revoke all on defensive_ability_semantic_catalog from anon","grant select on defensive_ability_semantic_catalog to authenticated","notify pgrst, ''reload schema''"}', 'defensive_semantics_v10_contract', NULL, NULL, NULL),
	('20260904090000', '{"-- §\"la cola está, hay que limpiarla... un botón de cancelar cola que
-- efectivamente cancele toda la cola de forma real y eficiente\" (feedback
-- real, 2026-09-04): 437 jobs bloqueados/reintentables de ANTES del
-- refactor v10 (rate limit de WCL, catálogo viejo) sin forma de descartarlos
-- — \"Reintentar\" solo reencola errores, nunca los descarta.
--
-- Nuevo estado terminal ''cancelled'' en ambas tablas de la cola. Aditivo:
-- amplía los CHECK existentes, no toca filas ni borra nada.

alter table defensive_reanalysis_jobs
  drop constraint defensive_reanalysis_jobs_status_check","alter table defensive_reanalysis_jobs
  add constraint defensive_reanalysis_jobs_status_check
  check (status in (''queued'', ''running'', ''done'', ''error'', ''cancelled''))","alter table defensive_reanalysis_batches
  drop constraint defensive_reanalysis_batches_status_check","alter table defensive_reanalysis_batches
  add constraint defensive_reanalysis_batches_status_check
  check (status in (''queued'', ''running'', ''completed'', ''completed_with_errors'', ''cancelled''))","comment on column defensive_reanalysis_jobs.status is
  ''queued/running/done/error = ciclo de vida normal del worker. cancelled = descartado explícitamente por un officer (botón \"Cancelar cola\") — terminal, nunca se reencola ni cuenta para queued/running/retryableErrors/blockedErrors.''","comment on column defensive_reanalysis_batches.status is
  ''queued/running/completed/completed_with_errors = ciclo de vida normal. cancelled = todos sus jobs no terminales se cancelaron explícitamente.''","notify pgrst, ''reload schema''"}', 'defensive_reanalysis_queue_cancel', NULL, NULL, NULL),
	('20260904100000', '{"-- IRIS Defensive Canonicalization v1 · Paso A-2
-- Ver iris-defensive-canonicalization-v1-plan.md §2.3/§2.8/§5.
--
-- Dos piezas independientes, ambas puramente aditivas:
--
-- 1) canonical_scored_pulls — única población de pulls que CUALQUIER
--    evaluator defensivo (actual o de Paso C) debe usar. Bug real ya
--    encontrado durante la auditoría: un consumer veía 16 pulls, otro 13,
--    porque cada uno construía su propio WHERE contra `pulls` (algunos
--    olvidaban ingestion_status, otros ninja_pull_excluded). M23
--    (20260903070000) ya resolvió esto puntualmente para
--    player_pull_reliability_inputs con un JOIN inline — esta vista
--    generaliza el mismo filtro para que nadie más tenga que repetirlo.
--    security_invoker=true hereda la misma postura de RLS que `pulls` ya
--    tiene hoy (ver \"read complete - pulls\"); no se inventa una política
--    más estricta aquí, eso es un cambio de seguridad aparte, no de esta
--    migración.
--
--    wipe_call_excluded/wipe_call_signals se conservan sin filtrar aquí a
--    propósito: un wipe call recorta EVENTOS dentro de un pull evaluable,
--    nunca invalida el pull entero (ver auditoría Pitpally,
--    iris-mechanics-audit-remediation-progress.md) — esa lógica vive en
--    cada evaluator, no en la población base.
--
-- 2) defensive_generations + defensive_generation_pointer — esqueleto del
--    ciclo BUILDING → READY → PUBLISHED (§2.8). Se crea la tabla y el
--    puntero singleton ahora, sin escribir en ellos todavía: no hay nada
--    que publicar hasta que Paso C (episodios/ledger) produzca una
--    generación real. Puntero singleton (una fila, boolean PK) en vez de
--    una columna en `reports`: una noche puede abarcar varios reports que
--    deben mostrar la MISMA generación simultáneamente — \"una operación\"
--    (§2.8) se cumple literalmente con un único UPDATE de una fila, no con
--    un UPDATE masivo de todos los reports cada vez que se hace cutover.

create or replace view canonical_scored_pulls
with (security_invoker = true) as
select
  p.id,
  p.report_code,
  p.fight_id,
  p.boss_id,
  p.difficulty,
  p.pull_number,
  p.wipe_pct,
  p.duration_ms,
  p.closed_at,
  p.wipe_call_excluded,
  p.wipe_call_signals,
  p.wipe_call_confidence,
  p.is_ninja_pull,
  p.ninja_pull_signals
from pulls p
where p.ingestion_status = ''complete''
  and p.ninja_pull_excluded = false","comment on view canonical_scored_pulls is
  ''Única población de pulls para evaluators defensivos (invariante 2 del plan: ningún consumer construye su propio WHERE). ingestion_status=complete + ninja_pull_excluded=false. wipe_call_* se conserva sin filtrar — recorta eventos dentro del pull, no lo excluye entero; eso lo decide cada evaluator.''","revoke all on canonical_scored_pulls from anon","grant select on canonical_scored_pulls to authenticated","create table if not exists defensive_generations (
  id uuid primary key default gen_random_uuid(),
  status text not null default ''building'' check (status in (''building'', ''ready'', ''published'', ''superseded'', ''failed'')),
  semantic_version text not null,
  resolver_version text not null,
  semantic_resolver_version text not null,
  episode_version text,
  evaluator_version text,
  game_build text not null,
  notes text,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  published_at timestamptz,
  superseded_at timestamptz
)","comment on table defensive_generations is
  ''Ciclo BUILDING→READY→PUBLISHED de una generación defensiva completa (§2.8 del plan). Vacía hasta que Paso C produzca una generación real — esqueleto aditivo, no se escribe todavía.''","comment on column defensive_generations.status is
  ''building = reanálisis en curso. ready = todos los pulls a conservar pasaron invariantes, todavía no visible. published = la que sirve el front hoy. superseded = fue published y ya no lo es. failed = se abortó.''","create index if not exists defensive_generations_status_idx on defensive_generations (status)","create table if not exists defensive_generation_pointer (
  id boolean primary key default true check (id),
  published_generation_id uuid references defensive_generations (id),
  updated_at timestamptz not null default now()
)","insert into defensive_generation_pointer (id) values (true) on conflict (id) do nothing","comment on table defensive_generation_pointer is
  ''Puntero singleton (siempre una fila) a la generación defensiva PUBLICADA vigente. El cutover atómico de Paso F es un único UPDATE de esta fila, no un UPDATE masivo de reports — todas las noches ven la misma generación a la vez, incluidas las que abarcan varios reports. NULL = sin generación v3 publicada todavía, todo el front sigue sirviendo el pipeline legacy.''","alter table defensive_generations enable row level security","alter table defensive_generation_pointer enable row level security","drop policy if exists \"defensive_generations: officers read\" on defensive_generations","create policy \"defensive_generations: officers read\"
  on defensive_generations for select
  using (is_officer())","drop policy if exists \"defensive_generation_pointer: officers read\" on defensive_generation_pointer","create policy \"defensive_generation_pointer: officers read\"
  on defensive_generation_pointer for select
  using (is_officer())","revoke all on defensive_generations from anon","revoke all on defensive_generation_pointer from anon","grant select on defensive_generations to authenticated","grant select on defensive_generation_pointer to authenticated","notify pgrst, ''reload schema''"}', 'defensive_canonicalization_paso_a2', NULL, NULL, NULL),
	('20260904110000', '{"-- IRIS Defensive Canonicalization v1 · §2.6 — staging table + ledger
-- generation-aware. Ver iris-defensive-canonicalization-v1-plan.md §2.6.
--
-- Puramente aditivo, shadow puro: no se toca defensive_generation_pointer,
-- no se marca ninguna generación ''ready'', no se borra/edita ninguna fila V2
-- existente (player_pull_defensive_evaluations). player_execution_events
-- está vacía hoy (0 filas totales, confirmado contra Supabase real antes de
-- escribir esta migración) — el cambio de agrupación de las views es
-- retrocompatible por construcción: agrupar por una columna nueva que hoy
-- es NULL en todas las filas no fragmenta ni cambia ningún número que ya
-- exista.

-- ============================================================================
-- 1) Tabla de staging (patrón evaluate→persist→materialize ya usado por
--    player_pull_defensive_evaluations V2 — mismo RLS, mismo estilo de
--    índices). Versionada por defensive_generation_id: una corrida shadow
--    nueva NO pisa la anterior de otra generación (UNIQUE incluye la
--    generación, no solo pull+player).
-- ============================================================================

create table if not exists player_pull_defensive_episode_evaluations (
  defensive_generation_id uuid not null references defensive_generations (id) on delete cascade,
  pull_id uuid not null references pulls (id) on delete cascade,
  player_name text not null check (nullif(btrim(player_name), '''') is not null),
  episode_evaluator_version text not null check (nullif(btrim(episode_evaluator_version), '''') is not null),
  semantic_version text not null check (nullif(btrim(semantic_version), '''') is not null),
  semantic_resolver_version text not null check (nullif(btrim(semantic_resolver_version), '''') is not null),
  resolver_version text not null check (nullif(btrim(resolver_version), '''') is not null),
  build_fingerprint text,
  data_confidence text not null check (data_confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  episodes jsonb not null default ''[]''::jsonb check (jsonb_typeof(episodes) = ''array''),
  evaluated_at timestamptz not null default now(),
  primary key (defensive_generation_id, pull_id, player_name)
)","create index if not exists player_pull_defensive_episode_evaluations_pull_idx
  on player_pull_defensive_episode_evaluations (pull_id, player_name)","create index if not exists player_pull_defensive_episode_evaluations_scoring_idx
  on player_pull_defensive_episode_evaluations (episode_evaluator_version, data_confidence, evaluated_at desc)","create index if not exists player_pull_defensive_episode_evaluations_generation_idx
  on player_pull_defensive_episode_evaluations (defensive_generation_id, evaluated_at desc)","alter table player_pull_defensive_episode_evaluations enable row level security","drop policy if exists \"player_pull_defensive_episode_evaluations: officers read\" on player_pull_defensive_episode_evaluations","create policy \"player_pull_defensive_episode_evaluations: officers read\"
  on player_pull_defensive_episode_evaluations for select using (is_officer())","revoke all on player_pull_defensive_episode_evaluations from anon, authenticated","grant select on player_pull_defensive_episode_evaluations to authenticated","comment on table player_pull_defensive_episode_evaluations is
  ''Staging v3 (episodios) — una fila por generación+pull+jugador, versionada por defensive_generation_id (§2.6 del plan de canonicalización defensiva). Aditiva junto a player_pull_defensive_evaluations (V2, sin tocar). UNIQUE(generation, pull, player) evita que una corrida shadow nueva pise una generación anterior.''","comment on column player_pull_defensive_episode_evaluations.episodes is
  ''Array de DefensiveEpisode persistidos completos: episodeId, causalGroupId, ventana (startMs/peakMs/endMs), usageEngaged/usageEvaluable, usedSpellIds, applicableCandidates (membership+applicability+availability por spellId), responseVerdict/responseReason, plan linkage opcional (planAssignmentId/planVerdict), evidence, confidence — ver defensive-episode-persistence.ts.''","comment on column player_pull_defensive_episode_evaluations.data_confidence is
  ''Rollup de fila: el confidence más débil entre sus episodios (mismo criterio weakestConfidence que ya usa materialize-execution-ledger para V2). Cada episodio conserva el suyo propio dentro de episodes[].''","-- ============================================================================
-- 2) player_execution_events gana defensive_generation_id — corrección de
--    infraestructura #1 de §2.6: sin esto, defensive_generation_pointer no
--    puede seleccionar qué eventos están realmente publicados (sería una
--    relación conceptual, no real). NULL en todo evento legacy existente y
--    futuro (mechanic/death/preparation/interrupt/external/dispel y
--    defensive_${state} V2); poblado únicamente en los eventos canónicos
--    nuevos defensive_episode_*/defensive_plan_*.
-- ============================================================================

alter table player_execution_events
  add column if not exists defensive_generation_id uuid references defensive_generations (id)","create index if not exists player_execution_events_defensive_generation_idx
  on player_execution_events (defensive_generation_id)
  where defensive_generation_id is not null","comment on column player_execution_events.defensive_generation_id is
  ''NULL en todo evento legacy (mechanic/death/preparation/interrupt/external/dispel y defensive_${state} V2). Poblado únicamente en los eventos canónicos defensive_episode_*/defensive_plan_* (§2.6). El cutover de Paso F filtra por esta columna = generación publicada; nunca por heurística de eventType a secas.''","-- ============================================================================
-- 3) 7 reason codes nuevos, aditivo sobre el CHECK existente de reason_code.
--    Nunca se reutilizan PLAN_COVERED/REMINDER_MISSED/SAFE_EXTRA_USE (son
--    del evaluator de Gestión/Plan legacy) para Respuesta — mezclarían otra
--    vez dos conceptos distintos bajo el mismo código, exactamente el
--    problema que abrió el plan de canonicalización defensiva.
-- ============================================================================

alter table player_execution_events
  drop constraint if exists player_execution_events_reason_code_check","alter table player_execution_events
  add constraint player_execution_events_reason_code_check
  check (reason_code in (
    ''SPREAD_CARRIER_COLLATERAL'', ''ASSIGNED_SOAK_MISSED'', ''PERSONAL_GROUND_HIT'',
    ''TANK_FRONTAL_HIT_RAID'', ''TANK_SWAP_THRESHOLD_BREACH'', ''ASSIGNED_INTERRUPT_MISSED'',
    ''RAID_INTERRUPT_MISSED'', ''VOLUNTEER_MECHANIC_RESOLVED'', ''VOLUNTEER_MECHANIC_UNRESOLVED'',
    ''SELF_FAILURE_DEATH'', ''COLLATERAL_DEATH'', ''UNAVOIDABLE_PRESSURE_DEATH'',
    ''POST_WIPE_DEATH'', ''UNCERTAIN_CAUSE'', ''PLAN_COVERED'', ''CORRECT_HOLD'',
    ''REMINDER_MISSED'', ''DEATH_VIABLE_CD'', ''VIABLE_CD_NON_PUNITIVE'', ''TARGET_MISMATCH'',
    ''SAFE_EXTRA_USE'', ''PREPOT_USED'', ''PREPOT_MISSED_VERIFIED'', ''HEALTHSTONE_REACTIVE'',
    ''HEALTHSTONE_VIABLE_NOT_USED'', ''HEALTH_POTION_REACTIVE'', ''AVAILABILITY_UNKNOWN'',
    ''DEFENSIVE_EPISODE_COVERED'', ''DEFENSIVE_READY_NOT_USED'', ''DEFENSIVE_MISTIMED'',
    ''DEFENSIVE_UNAVAILABLE_LEGITIMATE'', ''DEFENSIVE_NO_APPLICABLE_RESOURCE'',
    ''DEFENSIVE_EPISODE_UNCERTAIN'', ''DEFENSIVE_EPISODE_EXCLUDED''
  ))","-- ============================================================================
-- 4) Views namespace/generation-aware — corrección de infraestructura #3.
--    Agrupar TAMBIÉN por defensive_generation_id separa físicamente
--    cualquier evento canónico futuro (generation_id real) de la fila
--    legacy (generation_id NULL, incluye mechanic/death/preparation/
--    interrupt/external/dispel y defensive_${state} V2 — todos comparten
--    NULL porque solo los eventos canónicos nuevos lo pueblan). Hoy TODAS
--    las filas de player_execution_events son NULL (tabla vacía, 0 filas —
--    confirmado), así que esto es 100% retrocompatible: no fragmenta ni
--    cambia ningún número que ya exista, solo evita que futuras filas
--    canónicas se sumen a las legacy cuando ambas coexistan en shadow.
--
--    Dentro de una fila canónica, defensive_episode_* (Respuesta) y
--    defensive_plan_* (Gestión) nunca comparten contador — cuatro columnas
--    nuevas por view, aditivas; ninguna fórmula existente cambia.
-- ============================================================================

-- NOTA: CREATE OR REPLACE VIEW de Postgres solo permite AÑADIR columnas al
-- final de la lista existente — renombrar o reordenar una columna ya
-- existente falla con \"cannot change name of view column\" (comprobado en
-- vivo). Por eso las columnas nuevas van TODAS al final, después de
-- evaluated_at, en vez de intercaladas junto a la columna conceptualmente
-- más cercana; el orden original de las columnas ya existentes no cambia.
create or replace view player_pull_execution_summary_v3
with (security_invoker = true)
as
select
  e.pull_id,
  e.boss_id,
  e.difficulty,
  e.player_name,
  e.ledger_evaluator_version,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = ''success'')::integer as success_count,
  count(*) filter (where e.verdict in (''failure'', ''missed''))::integer as failure_count,
  count(*) filter (where e.verdict = ''correct_hold'')::integer as correct_hold_count,
  count(*) filter (where e.verdict = ''uncertain'')::integer as uncertain_count,
  count(*) filter (where e.domain = ''mechanic'' and e.penalty_eligible)::integer as mechanic_failure_count,
  count(*) filter (where e.domain in (''defensive'', ''external'') and e.penalty_eligible)::integer as defensive_failure_count,
  count(*) filter (where e.domain = ''consumable'' and e.penalty_eligible)::integer as consumable_failure_count,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  -- columnas nuevas §2.6, añadidas al final (ver nota arriba):
  e.defensive_generation_id,
  count(*) filter (where e.event_type like ''defensive_episode_%'')::integer as defensive_episode_event_count,
  count(*) filter (where e.event_type like ''defensive_episode_%'' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.event_type like ''defensive_episode_%'' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.event_type like ''defensive_episode_%'' and e.verdict = ''uncertain'')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.event_type like ''defensive_plan_%'')::integer as defensive_plan_event_count,
  count(*) filter (where e.event_type like ''defensive_plan_%'' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.event_type like ''defensive_plan_%'' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
group by e.pull_id, e.boss_id, e.difficulty, e.player_name, e.ledger_evaluator_version, e.defensive_generation_id","create or replace view night_player_execution_summary_v3
with (security_invoker = true)
as
select
  p.report_code,
  e.player_name,
  count(distinct e.pull_id)::integer as pull_count,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = ''uncertain'')::integer as uncertain_count,
  array_agg(distinct e.ledger_evaluator_version order by e.ledger_evaluator_version) as ledger_evaluator_versions,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.ledger_evaluator_version) = 1
    and count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  -- columnas nuevas §2.6, añadidas al final (ver nota arriba):
  e.defensive_generation_id,
  count(*) filter (where e.event_type like ''defensive_episode_%'')::integer as defensive_episode_event_count,
  count(*) filter (where e.event_type like ''defensive_episode_%'' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.event_type like ''defensive_episode_%'' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.event_type like ''defensive_episode_%'' and e.verdict = ''uncertain'')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.event_type like ''defensive_plan_%'')::integer as defensive_plan_event_count,
  count(*) filter (where e.event_type like ''defensive_plan_%'' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.event_type like ''defensive_plan_%'' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
join pulls p on p.id = e.pull_id
group by p.report_code, e.player_name, e.defensive_generation_id","comment on view player_pull_execution_summary_v3 is
  ''Resumen por pull+jugador del ledger v3, generation-aware (§2.6 corrección #3): defensive_generation_id en el GROUP BY separa físicamente cualquier evento canónico defensive_episode_*/defensive_plan_* (generation_id real) de la fila legacy (generation_id NULL) — nunca se suman entre sí. defensive_failure_count conserva su fórmula original (domain in (defensive,external) and penalty_eligible) para no romper el shadow comparator existente; defensive_episode_*/defensive_plan_* son columnas nuevas, namespace-scoped, para consumers canónicos.''","comment on view night_player_execution_summary_v3 is
  ''Resumen por noche(report)+jugador del ledger v3, generation-aware — mismo criterio que player_pull_execution_summary_v3 (ver su comentario).''","revoke all on player_pull_execution_summary_v3, night_player_execution_summary_v3 from anon","grant select on player_pull_execution_summary_v3, night_player_execution_summary_v3 to authenticated","notify pgrst, ''reload schema''"}', 'defensive_episode_staging_and_ledger', NULL, NULL, NULL),
	('20260904120000', '{"-- IRIS Defensive Canonicalization v1 · §2.6 — corrección encontrada en
-- verificación en vivo tras 20260904110000.
--
-- Bug real: el legacy V2 (generateDefensiveEvents en
-- materialize-execution-ledger/index.ts) ya produce eventType
-- `defensive_${state}` donde state puede ser ''plan_broken'' o
-- ''plan_covered'' — es decir, YA EXISTEN hoy los literales
-- `defensive_plan_broken`/`defensive_plan_covered` como eventType LEGACY
-- (el propio §2.6 del plan los cita como ejemplo de legacy V2). El filtro
-- `event_type like ''defensive_plan_%''` que añadió 20260904110000 para
-- aislar la Gestión CANÓNICA nueva coincide, por accidente de nombre, con
-- ese eventType legacy — confirmado insertando un fixture real: la fila
-- legacy (generation_id NULL) mostraba defensive_plan_event_count=1 cuando
-- debía ser 0 (esa fila no contiene ningún evento canónico).
--
-- No es doble conteo entre filas (defensive_generation_id ya separaba
-- físicamente legacy de canonical, eso seguía siendo correcto — verificado:
-- las dos filas nunca suman sus penalty_count/credit_count entre sí), pero
-- SÍ es una columna con nombre namespace-scoped que podía llenarse con
-- datos legacy por coincidencia de string — justo lo que la corrección de
-- infraestructura #3 de §2.6 pide evitar \"inequívocamente\".
--
-- Arreglo: las columnas defensive_episode_*/defensive_plan_* exigen
-- ADEMÁS defensive_generation_id is not null — nunca pueden contar una fila
-- legacy, sin importar qué literal tenga su event_type. Solo estas 8
-- columnas cambian de fórmula; el resto de la view queda igual (mismo
-- orden de columnas que 20260904110000 — solo se editan expresiones, no
-- nombres/posiciones, así que CREATE OR REPLACE VIEW es válido aquí).

create or replace view player_pull_execution_summary_v3
with (security_invoker = true)
as
select
  e.pull_id,
  e.boss_id,
  e.difficulty,
  e.player_name,
  e.ledger_evaluator_version,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = ''success'')::integer as success_count,
  count(*) filter (where e.verdict in (''failure'', ''missed''))::integer as failure_count,
  count(*) filter (where e.verdict = ''correct_hold'')::integer as correct_hold_count,
  count(*) filter (where e.verdict = ''uncertain'')::integer as uncertain_count,
  count(*) filter (where e.domain = ''mechanic'' and e.penalty_eligible)::integer as mechanic_failure_count,
  count(*) filter (where e.domain in (''defensive'', ''external'') and e.penalty_eligible)::integer as defensive_failure_count,
  count(*) filter (where e.domain = ''consumable'' and e.penalty_eligible)::integer as consumable_failure_count,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  e.defensive_generation_id,
  -- CORREGIDO: + \"e.defensive_generation_id is not null\" — nunca cuenta
  -- una fila legacy aunque su event_type coincida por string (ver cabecera).
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'')::integer as defensive_episode_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.verdict = ''uncertain'')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'')::integer as defensive_plan_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
group by e.pull_id, e.boss_id, e.difficulty, e.player_name, e.ledger_evaluator_version, e.defensive_generation_id","create or replace view night_player_execution_summary_v3
with (security_invoker = true)
as
select
  p.report_code,
  e.player_name,
  count(distinct e.pull_id)::integer as pull_count,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = ''uncertain'')::integer as uncertain_count,
  array_agg(distinct e.ledger_evaluator_version order by e.ledger_evaluator_version) as ledger_evaluator_versions,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.ledger_evaluator_version) = 1
    and count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  e.defensive_generation_id,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'')::integer as defensive_episode_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.verdict = ''uncertain'')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'')::integer as defensive_plan_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
join pulls p on p.id = e.pull_id
group by p.report_code, e.player_name, e.defensive_generation_id","comment on view player_pull_execution_summary_v3 is
  ''Resumen por pull+jugador del ledger v3, generation-aware (§2.6 corrección #3, con el fix de 20260904120000): defensive_generation_id en el GROUP BY separa físicamente cualquier evento canónico defensive_episode_*/defensive_plan_* de la fila legacy; las columnas defensive_episode_*/defensive_plan_* además exigen generation_id is not null para no contar nunca un evento legacy que coincida de nombre (ej. defensive_plan_broken/defensive_plan_covered ya existen como eventType V2). defensive_failure_count conserva su fórmula original (domain in (defensive,external) and penalty_eligible) para no romper el shadow comparator existente.''","comment on view night_player_execution_summary_v3 is
  ''Resumen por noche(report)+jugador del ledger v3, generation-aware — mismo criterio que player_pull_execution_summary_v3 (ver su comentario, incluido el fix de 20260904120000).''","revoke all on player_pull_execution_summary_v3, night_player_execution_summary_v3 from anon","grant select on player_pull_execution_summary_v3, night_player_execution_summary_v3 to authenticated","notify pgrst, ''reload schema''"}', 'defensive_episode_ledger_namespace_fix', NULL, NULL, NULL),
	('20260904130000', '{"-- IRIS Defensive Canonicalization v1 · Paso C-1 — cache cross-pull de
-- observaciones POSITIVAS del combat table (dodge/parry/block) por
-- ability. Ver iris-defensive-canonicalization-v1-plan.md §2.4.1.
--
-- Decisión explícita del usuario (2026-09-04): dodge/parry/block-capacidad
-- es una propiedad ESTÁTICA de la ability (no cambia entre pulls) y block
-- solo aparece en ~0.4% de los hits reales — un solo pull rara vez lo
-- demuestra. Cache aditivo (contadores, no booleanos eternos), versionado
-- por ability_game_id + game_build, con provenance (primer/último pull y
-- boss donde se observó). Nunca se convierte en fuente de scoring
-- independiente — solo alimenta damage-descriptor-wcl.ts
-- (combatTableVerdictFor), que a su vez solo puede producir true/null
-- (nunca false) hacia canDefensiveCover().

create table if not exists ability_combat_table_facts (
  ability_game_id bigint not null,
  game_build text not null check (nullif(btrim(game_build), '''') is not null),
  dodge_count integer not null default 0 check (dodge_count >= 0),
  parry_count integer not null default 0 check (parry_count >= 0),
  block_count integer not null default 0 check (block_count >= 0),
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  first_observed_pull_id uuid references pulls (id) on delete set null,
  last_observed_pull_id uuid references pulls (id) on delete set null,
  first_observed_boss_id text,
  last_observed_boss_id text,
  primary key (ability_game_id, game_build)
)","create index if not exists ability_combat_table_facts_last_observed_idx
  on ability_combat_table_facts (last_observed_at desc)","alter table ability_combat_table_facts enable row level security","drop policy if exists \"ability_combat_table_facts: officers read\" on ability_combat_table_facts","create policy \"ability_combat_table_facts: officers read\"
  on ability_combat_table_facts for select using (is_officer())","revoke all on ability_combat_table_facts from anon, authenticated","grant select on ability_combat_table_facts to authenticated","comment on table ability_combat_table_facts is
  ''Cache cross-pull, puramente aditivo, de veces que se observó dodge/parry/block real (WCL hitType=7/8, o campo blocked>0) para una abilityGameID+game_build. Evidencia acumulada para DamageDescriptor (damage-descriptor-wcl.ts) — nunca una fuente de scoring independiente. Ausencia de fila = sin evidencia = unknown, nunca false.''","comment on column ability_combat_table_facts.dodge_count is ''Veces que WCL reportó hitType=7 (Dodge, verificado empíricamente vía filterExpression missType) para esta ability — solo cuenta, nunca decrementa.''","comment on column ability_combat_table_facts.parry_count is ''Veces que WCL reportó hitType=8 (Parry, verificado empíricamente) para esta ability.''","comment on column ability_combat_table_facts.block_count is ''Veces que el evento trajo blocked>0 (campo directo de WCL, sin ambigüedad de hitType) para esta ability.''","notify pgrst, ''reload schema''"}', 'ability_combat_table_facts', NULL, NULL, NULL),
	('20260904140000', '{"-- §E2.1 (2026-09-04) — corrección de build-provenance tras la auditoría de
-- roster completo (E2). El E2 audit encontró que TODOS los jugadores
-- evaluables tienen exactamente un nodo de talento SELECCIONADO cuyo
-- entry_to_spell no resuelve a ningún spellId — el resolver interpretaba
-- eso como \"nodo genuinamente sin resolver\" (unresolvedSelectedNodes=true),
-- lo que bloqueaba buildPresence=''absent'' para prácticamente todo el
-- roster. Investigación real: ese nodo existe de verdad en el DB2 del
-- build (probablemente el selector del árbol de Hero Talents, sin spell
-- propio) — no es un dato faltante, es un nodo estructural legítimo.
--
-- entry_to_spell (solo entries que SÍ resuelven a spell) no puede por sí
-- solo distinguir \"entry real sin spell\" de \"entry que no se pudo
-- resolver\". Esta columna añade el snapshot completo de qué TraitNodeEntry
-- existen de verdad en el DB2 de ese build, resuelvan o no — nunca se
-- inventa un spellId para ellos, solo se registra su existencia.
alter table talent_spell_lookup
  add column if not exists known_entry_ids jsonb not null default ''[]''::jsonb","comment on column talent_spell_lookup.known_entry_ids is
  ''Array de TraitNodeEntry.ID que existen de verdad en el DB2 de este build (resuelvan o no a un spellId) — ver wago-db2-client.ts TalentSpellLookup.knownEntryIds. [] en filas cacheadas antes de esta migración; se repuebla en la siguiente sincronización de ese build (fetchTalentSpellLookup ya lo calcula).''","notify pgrst, ''reload schema''"}', 'talent_spell_lookup_known_entries', NULL, NULL, NULL),
	('20260904150000', '{"-- IRIS Defensive Canonicalization v1 · E3 manual semantic closure
-- (2026-09-04). Persists the officer-reviewed residual set: 31 pending
-- rows → 22 verified + 9 rejected, 0 pending. Also repairs the malformed
-- Avatar/Protection specSemanticProfile and locks the reviewed rows so a
-- future automatic v10 classifier sync can never silently overwrite this
-- manually-approved current-build (12.1.0.68914) data.
--
-- Purely data-level: no schema change, no new table, no new column. Every
-- UPDATE sets fixed final values (never reads-then-mutates its own target
-- columns for the manifest fields), so re-running this migration against
-- an already-migrated dataset is a safe no-op for scoring purposes (only
-- reviewed_at/updated_at timestamps advance).
--
-- semantic_version is intentionally left untouched (defensive-semantics@1.0.0
-- stays homogeneous across all 340 rows) — E8 will own generation
-- snapshot/hash provenance later; this migration does not invent one now.

-- ============================================================================
-- 0) PRECONDITION GUARD (§1.1) — fail-fast, never apply to a drifted dataset.
-- ============================================================================

do $$
declare
  v_target_spell_ids int[] := array[
    194679, 196555, 426784, 1261867, 200851, 108238, 61336, 370960, 199483,
    110959, 115181, 322507, 443028, 1241059, 122278, 122783, 455139, 322101,
    115203, 122280, 122281, 132578, 119582, 322109, 122470, 434766, 450991,
    115176, 132413, 12975, 2565
  ];
  v_rejected_spell_ids int[] := array[
    194679, 196555, 200851, 108238, 370960, 122278, 122783, 122281, 115176
  ];
  v_expected_count int := 31;
  v_catalog_count int;
  v_semantics_count int;
  v_avatar_count int;
  v_pending_count int;
  v_post_state_count int;
begin
  -- one cooldown_catalog row per intended identity, no duplicates/missing.
  select count(*) into v_catalog_count from cooldown_catalog where spell_id = any(v_target_spell_ids);
  if v_catalog_count <> v_expected_count then
    raise exception ''E3 closure precondition failed: expected % cooldown_catalog rows for the 31 target spellIds, found % — aborting, dataset does not match the reviewed manifest.'', v_expected_count, v_catalog_count;
  end if;

  -- one defensive_ability_semantics row per intended catalog identity.
  select count(*) into v_semantics_count
  from defensive_ability_semantics s
  join cooldown_catalog c on c.id = s.catalog_id
  where c.spell_id = any(v_target_spell_ids);
  if v_semantics_count <> v_expected_count then
    raise exception ''E3 closure precondition failed: expected % defensive_ability_semantics rows for the 31 target spellIds, found % (duplicate or missing catalog identity) — aborting.'', v_expected_count, v_semantics_count;
  end if;

  -- Avatar resolves to exactly one semantic row.
  select count(*) into v_avatar_count
  from defensive_ability_semantics s
  join cooldown_catalog c on c.id = s.catalog_id
  where c.spell_id = 107574;
  if v_avatar_count <> 1 then
    raise exception ''E3 closure precondition failed: Avatar (spellId 107574) must resolve to exactly one semantic row, found % — aborting.'', v_avatar_count;
  end if;

  -- Residual state must be EXACTLY the expected pre-state (31 pending) OR
  -- the exact E3 post-state already applied (idempotent replay) — never a
  -- partial/drifted state in between.
  select count(*) into v_pending_count
  from defensive_ability_semantics s
  join cooldown_catalog c on c.id = s.catalog_id
  where c.spell_id = any(v_target_spell_ids) and s.semantic_status = ''pending'';

  select count(*) into v_post_state_count
  from defensive_ability_semantics s
  join cooldown_catalog c on c.id = s.catalog_id
  where c.spell_id = any(v_target_spell_ids)
    and s.locked = true
    and s.source = ''IRIS E3 manual closure 2026-09-04''
    and s.semantic_status = (case when c.spell_id = any(v_rejected_spell_ids) then ''rejected'' else ''verified'' end);

  if v_pending_count = v_expected_count then
    raise notice ''E3 closure: pre-state confirmed (31/31 pending) — applying migration.'';
  elsif v_post_state_count = v_expected_count then
    raise notice ''E3 closure: exact post-state already applied (31/31 locked + E3 source + expected status) — re-applying idempotently, values already correct.'';
  else
    raise exception ''E3 closure precondition failed: residual set is neither the expected 31-pending pre-state (found % pending) nor the exact already-migrated E3 post-state (found % matching) — dataset has drifted since review, aborting without applying a partial migration.'', v_pending_count, v_post_state_count;
  end if;
end $$","-- ============================================================================
-- 1) FIVE E3 SEMANTIC RULES (§4) — all rule_type=''augment'', game_build
--    12.1.0.68914, verified=true. Deterministic replay via the real unique
--    constraint (modifier_spell_id, target_spell_id, game_build, rule_type).
-- ============================================================================

insert into defensive_semantic_rules (modifier_spell_id, target_spell_id, specs, game_build, rule_type, payload, source, verified)
values
  (
    1261867, 1261867,
    array[''Balance'', ''Feral'', ''Guardian'', ''Restoration''],
    ''12.1.0.68914'', ''augment'',
    ''{
      \"condition\": \"runtime_state\",
      \"modifierName\": \"Heart of the Wild — Bear Form defensive branch\",
      \"setUsageRole\": \"hybrid_survival\",
      \"setDefensiveIntent\": \"hybrid\",
      \"setOpportunityMode\": \"credit_only\",
      \"setPrimaryBeneficiary\": \"self\",
      \"setSecondaryPropagation\": null,
      \"addMechanisms\": [\"effective_health\"],
      \"removeMechanisms\": [],
      \"applicabilityPatch\": {
        \"schoolScope\": \"all\",
        \"schools\": [],
        \"deliveryScopes\": [\"all\"],
        \"requiresDodgeable\": null,
        \"requiresParryable\": null,
        \"requiresBlockable\": null,
        \"requiresSourceAffectedBySpell\": null,
        \"timingRelation\": \"before_or_during\"
      },
      \"notes\": \"Only the Bear-form branch grants the temporary maximum-health defensive benefit.\"
    }''::jsonb,
    ''IRIS E3 manual closure 2026-09-04'', true
  ),
  (
    443059, 443028,
    array[''Mistweaver'', ''Windwalker''],
    ''12.1.0.68914'', ''augment'',
    ''{
      \"condition\": \"hero_talent_selected\",
      \"modifierName\": \"Jade Sanctuary\",
      \"setUsageRole\": \"hybrid_survival\",
      \"setDefensiveIntent\": \"hybrid\",
      \"setOpportunityMode\": \"credit_only\",
      \"setPrimaryBeneficiary\": \"self\",
      \"setSecondaryPropagation\": null,
      \"addMechanisms\": [\"mitigation\", \"sustain\"],
      \"removeMechanisms\": [],
      \"applicabilityPatch\": {
        \"schoolScope\": \"all\",
        \"schools\": [],
        \"deliveryScopes\": [\"all\"],
        \"requiresDodgeable\": null,
        \"requiresParryable\": null,
        \"requiresBlockable\": null,
        \"requiresSourceAffectedBySpell\": null,
        \"timingRelation\": \"either\"
      },
      \"notes\": \"Jade Sanctuary adds an immediate self-heal and personal damage reduction to Celestial Conduit.\"
    }''::jsonb,
    ''IRIS E3 manual closure 2026-09-04'', true
  ),
  (
    1272452, 322109,
    array[''Brewmaster'', ''Mistweaver'', ''Windwalker''],
    ''12.1.0.68914'', ''augment'',
    ''{
      \"condition\": \"talent_selected\",
      \"modifierName\": \"Chi Transfer\",
      \"setUsageRole\": \"hybrid_survival\",
      \"setDefensiveIntent\": \"hybrid\",
      \"setOpportunityMode\": \"credit_only\",
      \"setPrimaryBeneficiary\": \"self\",
      \"setSecondaryPropagation\": null,
      \"addMechanisms\": [\"sustain\"],
      \"removeMechanisms\": [],
      \"applicabilityPatch\": {
        \"schoolScope\": \"all\",
        \"schools\": [],
        \"deliveryScopes\": [\"all\"],
        \"requiresDodgeable\": null,
        \"requiresParryable\": null,
        \"requiresBlockable\": null,
        \"requiresSourceAffectedBySpell\": null,
        \"timingRelation\": \"after_damage\"
      },
      \"notes\": \"Chi Transfer causes Touch of Death to heal the Monk.\"
    }''::jsonb,
    ''IRIS E3 manual closure 2026-09-04'', true
  ),
  (
    450560, 434766,
    array[''Brewmaster'', ''Mistweaver'', ''Windwalker''],
    ''12.1.0.68914'', ''augment'',
    ''{
      \"condition\": \"talent_selected\",
      \"modifierName\": \"Healing Winds\",
      \"setUsageRole\": \"hybrid_survival\",
      \"setDefensiveIntent\": \"hybrid\",
      \"setOpportunityMode\": \"credit_only\",
      \"setPrimaryBeneficiary\": \"self\",
      \"setSecondaryPropagation\": null,
      \"addMechanisms\": [\"sustain\"],
      \"removeMechanisms\": [],
      \"applicabilityPatch\": {
        \"schoolScope\": \"all\",
        \"schools\": [],
        \"deliveryScopes\": [\"all\"],
        \"requiresDodgeable\": null,
        \"requiresParryable\": null,
        \"requiresBlockable\": null,
        \"requiresSourceAffectedBySpell\": null,
        \"timingRelation\": \"after_damage\"
      },
      \"notes\": \"Healing Winds causes Transcendence: Transfer to immediately heal the Monk.\"
    }''::jsonb,
    ''IRIS E3 manual closure 2026-09-04'', true
  ),
  (
    108503, 132413,
    array[''Affliction'', ''Destruction''],
    ''12.1.0.68914'', ''augment'',
    ''{
      \"condition\": \"runtime_state\",
      \"modifierName\": \"Grimoire of Sacrifice — Shadow Bulwark granted\",
      \"setUsageRole\": \"personal_survival\",
      \"setDefensiveIntent\": \"primary\",
      \"setOpportunityMode\": \"normal\",
      \"setPrimaryBeneficiary\": \"self\",
      \"setSecondaryPropagation\": null,
      \"addMechanisms\": [\"effective_health\", \"sustain\"],
      \"removeMechanisms\": [],
      \"applicabilityPatch\": {
        \"schoolScope\": \"all\",
        \"schools\": [],
        \"deliveryScopes\": [\"all\"],
        \"requiresDodgeable\": null,
        \"requiresParryable\": null,
        \"requiresBlockable\": null,
        \"requiresSourceAffectedBySpell\": null,
        \"timingRelation\": \"either\"
      },
      \"notes\": \"Runtime must prove that the sacrificed demon grants Shadow Bulwark; selecting Grimoire of Sacrifice alone is not sufficient runtime evidence.\"
    }''::jsonb,
    ''IRIS E3 manual closure 2026-09-04'', true
  )
on conflict (modifier_spell_id, target_spell_id, game_build, rule_type)
do update set
  specs = excluded.specs,
  payload = excluded.payload,
  source = excluded.source,
  verified = excluded.verified,
  updated_at = now()","-- ============================================================================
-- 2) 22 VERIFIED (§3) — one UPDATE...FROM(VALUES) manifest, no per-spell
--    ad-hoc statements to duplicate the risk of a typo''d WHERE clause.
-- ============================================================================

with verified_manifest (
  spell_id, usage_role, activation_scope, primary_beneficiary, mechanisms,
  opportunity_mode, defensive_intent, applicability, applicability_confidence,
  spec_semantic_profiles
) as (
  values
    -- Call of the Elder Druid
    (426784, ''passive_survival'', ''none'', ''self'', array[''effective_health'']::text[], ''none'', ''incidental'',
      null::jsonb, null::text, ''[]''::jsonb),
    -- Heart of the Wild (base — Bear-form branch is the runtime rule §4.1)
    (1261867, ''utility'', ''self'', ''none'', array[]::text[], ''none'', ''hybrid'',
      null, null, ''[]''),
    -- Survival Instincts
    (61336, ''personal_survival'', ''self'', ''self'', array[''mitigation''], ''normal'', ''primary'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"before_or_during\"}''::jsonb,
      ''high'', ''[]''),
    -- Camouflage
    (199483, ''utility'', ''self'', ''self'', array[''sustain''], ''none'', ''incidental'',
      null, null, ''[]''),
    -- Greater Invisibility
    (110959, ''utility'', ''self'', ''none'', array[]::text[], ''none'', ''none'',
      null, null, ''[]''),
    -- Breath of Fire (Brewmaster rotational mitigation, source-bound)
    (115181, ''active_mitigation'', ''self'', ''self'', array[''mitigation''], ''none'', ''primary'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":true,\"timingRelation\":\"before_or_during\"}''::jsonb,
      ''high'', ''[]''),
    -- Celestial Brew
    (322507, ''personal_survival'', ''self'', ''self'', array[''absorption''], ''normal'', ''primary'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"before_or_during\"}''::jsonb,
      ''high'', ''[]''),
    -- Celestial Conduit (base — Jade Sanctuary transforms it via §4.2)
    (443028, ''utility'', ''self'', ''none'', array[]::text[], ''none'', ''hybrid'',
      null, null,
      ''[{\"spec\":\"Mistweaver\",\"usageRole\":\"healer_throughput\",\"defensiveIntent\":\"primary\",\"activationScope\":\"self\",\"primaryBeneficiary\":\"party\",\"secondaryPropagation\":\"none\",\"mechanisms\":[\"sustain\"],\"opportunityMode\":\"none\",\"applicability\":{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"after_damage\"},\"source\":\"IRIS E3 manual closure 2026-09-04\",\"confidence\":\"high\"}]''::jsonb),
    -- Celestial Infusion
    (1241059, ''personal_survival'', ''self'', ''self'', array[''absorption''], ''normal'', ''primary'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"before_or_during\"}''::jsonb,
      ''high'', ''[]''),
    -- Elixir of Determination (automatic low-health absorb)
    (455139, ''passive_survival'', ''none'', ''self'', array[''absorption''], ''none'', ''primary'',
      null, null, ''[]''),
    -- Expel Harm
    (322101, ''rotational_survival'', ''self'', ''self'', array[''sustain''], ''none'', ''primary'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"after_damage\"}''::jsonb,
      ''high'', ''[]''),
    -- Fortifying Brew
    (115203, ''personal_survival'', ''self'', ''self'', array[''mitigation'', ''effective_health''], ''normal'', ''primary'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"either\"}''::jsonb,
      ''high'', ''[]''),
    -- Healing Elixir (current passive identity)
    (122280, ''passive_survival'', ''none'', ''self'', array[''sustain''], ''none'', ''primary'',
      null, null, ''[]''),
    -- Invoke Niuzao, the Black Ox
    (132578, ''hybrid_survival'', ''self'', ''self'', array[''mitigation''], ''credit_only'', ''hybrid'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"before_or_during\"}''::jsonb,
      ''high'', ''[]''),
    -- Purifying Brew
    (119582, ''active_mitigation'', ''self'', ''self'', array[''mitigation''], ''none'', ''primary'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"after_damage\"}''::jsonb,
      ''high'', ''[]''),
    -- Touch of Death (base — Chi Transfer transforms it via §4.3)
    (322109, ''utility'', ''enemy'', ''none'', array[]::text[], ''none'', ''none'',
      null, null,
      ''[{\"spec\":\"Brewmaster\",\"usageRole\":\"rotational_survival\",\"defensiveIntent\":\"hybrid\",\"activationScope\":\"enemy\",\"primaryBeneficiary\":\"self\",\"secondaryPropagation\":\"none\",\"mechanisms\":[\"mitigation\"],\"opportunityMode\":\"none\",\"applicability\":{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"after_damage\"},\"source\":\"IRIS E3 manual closure 2026-09-04\",\"confidence\":\"high\"}]''::jsonb),
    -- Touch of Karma
    (122470, ''personal_survival'', ''enemy'', ''self'', array[''absorption''], ''normal'', ''primary'',
      ''{\"schoolScope\":\"all\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":false,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"before_or_during\"}''::jsonb,
      ''high'', ''[]''),
    -- Transcendence: Transfer (base — Healing Winds transforms it via §4.4)
    (434766, ''utility'', ''self'', ''none'', array[]::text[], ''none'', ''none'',
      null, null, ''[]''),
    -- Whirling Steel (automatic low-health proc)
    (450991, ''passive_survival'', ''none'', ''self'', array[''avoidance'', ''mitigation''], ''none'', ''primary'',
      null, null, ''[]''),
    -- Shadow Bulwark (base — Grimoire of Sacrifice runtime transforms it via §4.5)
    (132413, ''utility'', ''self'', ''none'', array[]::text[], ''none'', ''hybrid'',
      null, null, ''[]''),
    -- Last Stand (modifies Shield Wall; preserves existing convert-to-passive rule)
    (12975, ''passive_survival'', ''none'', ''self'', array[''effective_health'', ''sustain''], ''none'', ''primary'',
      null, null, ''[]''),
    -- Shield Block
    (2565, ''active_mitigation'', ''self'', ''self'', array[''mitigation''], ''none'', ''primary'',
      ''{\"schoolScope\":\"physical\",\"schools\":[],\"deliveryScopes\":[\"all\"],\"requiresDodgeable\":false,\"requiresParryable\":false,\"requiresBlockable\":true,\"requiresSourceAffectedBySpell\":false,\"timingRelation\":\"before_or_during\"}''::jsonb,
      ''high'', ''[]'')
)
update defensive_ability_semantics s
set
  semantic_status = ''verified'',
  usage_role = m.usage_role,
  activation_scope = m.activation_scope,
  primary_beneficiary = m.primary_beneficiary,
  secondary_propagation = ''none'',
  mechanisms = m.mechanisms,
  opportunity_mode = m.opportunity_mode,
  defensive_intent = m.defensive_intent,
  applicability = m.applicability,
  applicability_confidence = m.applicability_confidence,
  spec_semantic_profiles = m.spec_semantic_profiles,
  confidence = ''inferred'',
  locked = true,
  source = ''IRIS E3 manual closure 2026-09-04'',
  reviewed_at = now(),
  updated_at = now()
from verified_manifest m
join cooldown_catalog c on c.spell_id = m.spell_id
where s.catalog_id = c.id","-- ============================================================================
-- 3) 9 REJECTED (§2) — uniform template, neutral legacy projection applied
--    in the sync step below (driven by the usage_role/mechanisms just set
--    here, never a separate hardcoded mapping).
-- ============================================================================

update defensive_ability_semantics s
set
  semantic_status = ''rejected'',
  usage_role = ''unknown'',
  activation_scope = ''unknown'',
  primary_beneficiary = ''unknown'',
  secondary_propagation = ''none'',
  mechanisms = ''{}'',
  opportunity_mode = ''none'',
  defensive_intent = ''unknown'',
  applicability = null,
  applicability_confidence = null,
  spec_semantic_profiles = ''[]''::jsonb,
  confidence = ''inferred'',
  locked = true,
  source = ''IRIS E3 manual closure 2026-09-04'',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.spell_id = any(array[194679, 196555, 200851, 108238, 370960, 122278, 122783, 122281, 115176])","-- ============================================================================
-- 4) AVATAR / PROTECTION REPAIR (§5) — replace the ENTIRE
--    spec_semantic_profiles array so no malformed fragment survives; base
--    semantics untouched.
-- ============================================================================

update defensive_ability_semantics s
set
  spec_semantic_profiles = ''[
    {
      \"spec\": \"Arms\",
      \"usageRole\": \"hybrid_survival\",
      \"defensiveIntent\": \"hybrid\",
      \"activationScope\": \"self\",
      \"primaryBeneficiary\": \"self\",
      \"secondaryPropagation\": \"none\",
      \"mechanisms\": [\"mitigation\"],
      \"opportunityMode\": \"credit_only\",
      \"applicability\": {
        \"schoolScope\": \"all\",
        \"schools\": [],
        \"deliveryScopes\": [\"aoe\"],
        \"requiresDodgeable\": null,
        \"requiresParryable\": null,
        \"requiresBlockable\": null,
        \"requiresSourceAffectedBySpell\": null,
        \"timingRelation\": \"before_or_during\"
      },
      \"source\": \"IRIS E3 manual closure 2026-09-04\",
      \"confidence\": \"high\"
    },
    {
      \"spec\": \"Protection\",
      \"usageRole\": \"hybrid_survival\",
      \"defensiveIntent\": \"hybrid\",
      \"activationScope\": \"self\",
      \"primaryBeneficiary\": \"self\",
      \"secondaryPropagation\": \"none\",
      \"mechanisms\": [\"mitigation\"],
      \"opportunityMode\": \"credit_only\",
      \"applicability\": {
        \"schoolScope\": \"all\",
        \"schools\": [],
        \"deliveryScopes\": [\"all\"],
        \"requiresDodgeable\": null,
        \"requiresParryable\": null,
        \"requiresBlockable\": null,
        \"requiresSourceAffectedBySpell\": null,
        \"timingRelation\": \"before_or_during\"
      },
      \"source\": \"IRIS E3 manual closure 2026-09-04\",
      \"confidence\": \"high\"
    }
  ]''::jsonb,
  locked = true,
  source = ''IRIS E3 manual closure 2026-09-04'',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id and c.spell_id = 107574","-- ============================================================================
-- 5) LEGACY cooldown_catalog SYNC (§6) — EXACT same deterministic policy as
--    deriveLegacyClassification()/deriveLegacySurvivalType()
--    (_shared/defensive-classification-semantics.ts). Hygiene only, never
--    canonical scoring truth. Runs AFTER the updates above so it reads the
--    just-persisted usage_role/mechanisms, for all 31 reviewed identities
--    (verified and rejected alike).
-- ============================================================================

update cooldown_catalog c
set
  category = case s.usage_role
    when ''personal_survival'' then ''personal_defensive''
    when ''survival_state'' then ''personal_defensive''
    when ''hybrid_survival'' then ''personal_defensive''
    when ''healer_throughput'' then ''semi_defensive''
    when ''external'' then ''external_defensive''
    when ''raid_defensive'' then ''external_defensive''
    else ''utility''
  end,
  targeting_mode = case s.usage_role
    when ''personal_survival'' then ''self''
    when ''survival_state'' then ''self''
    when ''hybrid_survival'' then ''self''
    when ''healer_throughput'' then ''both''
    when ''external'' then ''ally''
    when ''raid_defensive'' then ''raid''
    else ''unknown''
  end,
  survival_type = case
    when ''mitigation'' = any(s.mechanisms) or ''avoidance'' = any(s.mechanisms) then ''mitigation''
    when ''absorption'' = any(s.mechanisms) then ''absorption''
    when ''sustain'' = any(s.mechanisms) then ''sustain''
    when ''immunity'' = any(s.mechanisms) or ''lethal_prevention'' = any(s.mechanisms) or ''effective_health'' = any(s.mechanisms) then ''emergency''
    else null
  end,
  reviewed = true
from defensive_ability_semantics s
where s.catalog_id = c.id
  and c.spell_id = any(array[
    194679, 196555, 426784, 1261867, 200851, 108238, 61336, 370960, 199483,
    110959, 115181, 322507, 443028, 1241059, 122278, 122783, 455139, 322101,
    115203, 122280, 122281, 132578, 119582, 322109, 122470, 434766, 450991,
    115176, 132413, 12975, 2565
  ])","-- excluded=true only for the 9 rejected — the existing `excluded` value on
-- the 22 verified rows is preserved untouched (never re-excluded/unexcluded
-- here, e.g. Camouflage/Greater Invisibility keep whatever they had).
update cooldown_catalog
set excluded = true
where spell_id = any(array[194679, 196555, 200851, 108238, 370960, 122278, 122783, 122281, 115176])","notify pgrst, ''reload schema''"}', 'e3_defensive_semantic_closure', NULL, NULL, NULL),
	('20260907130000', '{"-- Fiabilidad read-path v2: filtros antes de agregaciones + Response canónico.
--
-- player_pull_reliability_inputs conserva un contrato útil de compatibilidad,
-- pero sus subconsultas correlacionadas repiten applicable_pull_mechanic_events
-- por cada player×pull. En el dosier/Informe eso amplifica mucho el trabajo.
-- Este RPC hace el scope primero y materializa los eventos aplicables una vez.
--
-- La métrica defensiva nueva NO deriva de Management V2 ni de pressure
-- windows. Expone el KPI canónico Response exactamente según
-- defensive-episode-kpis.ts:
--   evaluable = covered_verified + missed_ready + missed_due_to_mistime
--   success   = covered_verified
--   failure   = missed_ready + missed_due_to_mistime
-- uncertain/excluded/unavailable_legitimate/no_applicable_resource no entran.

create or replace function public.get_player_pull_reliability_inputs_v2(
  p_player_name text default null,
  p_since timestamptz default null,
  p_boss_id text default null,
  p_difficulty text default null,
  p_pull_ids uuid[] default null
)
returns table (
  player_name text,
  pull_id uuid,
  boss_id text,
  difficulty text,
  closed_at timestamptz,
  had_avoidable_damage boolean,
  self_positioning_death boolean,
  used_defensive_when_died boolean,
  used_defensive_in_pull boolean,
  defensive_use_opportunity boolean,
  enchanted_slot_count bigint,
  enchantable_slot_count bigint,
  gem_count bigint,
  gemmed_slot_count bigint,
  gemmable_slot_count bigint,
  personal_mechanic_fail_count bigint,
  report_code text,
  pull_number integer,
  avoidable_mechanic_eligible_count bigint,
  avoidable_mechanic_fail_count bigint,
  defensive_window_coverable_count bigint,
  defensive_window_covered_count bigint,
  defensive_window_used_anything boolean,
  unassigned_mechanic_success_count bigint,
  defensive_management_score_v2 numeric,
  defensive_management_decision_count integer,
  defensive_required_count integer,
  defensive_required_success_count integer,
  defensive_required_exact_adherence_count integer,
  defensive_broken_reservation_count integer,
  defensive_death_viable_cd_count integer,
  defensive_evaluation_confidence text,
  defensive_evaluator_version text,
  defensive_resolver_version text,
  defensive_solver_version text,
  defensive_game_build text,
  defensive_build_fingerprint text,
  defensive_evaluated_at timestamptz,
  canonical_response_evaluable_count integer,
  canonical_response_success_count integer,
  canonical_response_failure_count integer,
  canonical_defensive_generation_id uuid,
  canonical_defensive_evaluated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
with base as materialized (
  select
    r.player_name,
    p.id as pull_id,
    p.boss_id,
    p.difficulty,
    p.closed_at,
    p.report_code,
    p.pull_number,
    r.died,
    r.wipe_call_cluster,
    p.wipe_call_excluded,
    r.death_cause,
    r.defensive_casts,
    r.equipped_items,
    r.defensive_pressure_windows,
    p.unassigned_mechanic_occurrences,
    case
      when p.wipe_call_excluded
       and p.wipe_call_signals is not null
       and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      then (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      else null
    end as cutoff_ms
  from public.player_pull_records r
  join public.pulls p on p.id = r.pull_id
  where not p.ninja_pull_excluded
    and p.ingestion_status = ''complete''
    and (p_player_name is null or r.player_name = p_player_name)
    and (p_since is null or p.closed_at >= p_since)
    and (p_boss_id is null or p.boss_id = p_boss_id)
    and (p_difficulty is null or p.difficulty = p_difficulty)
    and (p_pull_ids is null or r.pull_id = any(p_pull_ids))
),
scoped_pulls as materialized (
  select distinct pull_id, cutoff_ms, unassigned_mechanic_occurrences
  from base
),
events as materialized (
  select
    e.pull_id,
    e.trigger_time_ms,
    e.avoidable,
    e.outcome,
    e.category,
    e.responsibility,
    e.player_hit_details
  from public.applicable_pull_mechanic_events e
  join scoped_pulls sp on sp.pull_id = e.pull_id
  where sp.cutoff_ms is null or e.trigger_time_ms::numeric < sp.cutoff_ms
),
eligible_stats as (
  select
    b.pull_id,
    b.player_name,
    count(*) filter (
      where e.category in (''avoidable-ground'', ''spread'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
        and (
          not b.died
          or (
            jsonb_typeof(b.death_cause->''timeMs'') = ''number''
            and (b.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
          )
        )
    )::bigint as avoidable_mechanic_eligible_count
  from base b
  left join events e on e.pull_id = b.pull_id
  group by b.pull_id, b.player_name
),
hit_stats as (
  select
    e.pull_id,
    detail->>''name'' as player_name,
    bool_or(
      e.avoidable is true
      and e.outcome <> ''clean''
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
    ) as had_avoidable_damage,
    count(*) filter (
      where e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
    )::bigint as personal_mechanic_fail_count
  from events e
  cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
  where nullif(detail->>''name'', '''') is not null
  group by e.pull_id, detail->>''name''
),
avoidable_fail_stats as (
  select
    b.pull_id,
    b.player_name,
    count(*) filter (
      where e.category in (''avoidable-ground'', ''spread'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
        and detail->>''name'' = b.player_name
        and (
          not b.died
          or (
            jsonb_typeof(b.death_cause->''timeMs'') = ''number''
            and (b.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
          )
        )
    )::bigint as avoidable_mechanic_fail_count
  from base b
  left join events e on e.pull_id = b.pull_id
  left join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail on true
  group by b.pull_id, b.player_name
),
unassigned_stats as (
  select
    sp.pull_id,
    occ->>''actorName'' as player_name,
    count(*)::bigint as success_count
  from scoped_pulls sp
  cross join lateral jsonb_array_elements(coalesce(sp.unassigned_mechanic_occurrences, ''[]''::jsonb)) occ
  where nullif(occ->>''actorName'', '''') is not null
  group by sp.pull_id, occ->>''actorName''
),
canonical_stats as (
  select
    e.pull_id,
    e.player_name,
    e.defensive_generation_id,
    max(e.evaluated_at) as evaluated_at,
    count(*) filter (
      where ep->>''responseVerdict'' in (
        ''covered_verified'', ''missed_ready'', ''missed_due_to_mistime''
      )
    )::integer as evaluable_count,
    count(*) filter (
      where ep->>''responseVerdict'' = ''covered_verified''
    )::integer as success_count,
    count(*) filter (
      where ep->>''responseVerdict'' in (''missed_ready'', ''missed_due_to_mistime'')
    )::integer as failure_count
  from public.player_pull_defensive_episode_evaluations e
  join public.defensive_generation_pointer ptr
    on ptr.id = true
   and ptr.published_generation_id = e.defensive_generation_id
  join base b
    on b.pull_id = e.pull_id
   and b.player_name = e.player_name
  left join lateral jsonb_array_elements(coalesce(e.episodes, ''[]''::jsonb)) ep on true
  group by e.pull_id, e.player_name, e.defensive_generation_id
)
select
  b.player_name,
  b.pull_id,
  b.boss_id,
  b.difficulty,
  b.closed_at,
  coalesce(hs.had_avoidable_damage, false) as had_avoidable_damage,
  (
    b.died
    and not (
      (b.wipe_call_cluster and b.wipe_call_excluded)
      or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and b.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (b.wipe_call_cluster and b.wipe_call_excluded)
      or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when b.died
      and jsonb_array_length(coalesce(b.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(b.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
    )
    or (
      b.died
      and not (
        (b.wipe_call_cluster and b.wipe_call_excluded)
        or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(b.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or coalesce(hs.had_avoidable_damage, false)
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  )::bigint as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  )::bigint as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb)) item
  )::bigint as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  )::bigint as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  )::bigint as gemmable_slot_count,
  coalesce(hs.personal_mechanic_fail_count, 0)::bigint as personal_mechanic_fail_count,
  b.report_code,
  b.pull_number,
  coalesce(es.avoidable_mechanic_eligible_count, 0)::bigint as avoidable_mechanic_eligible_count,
  coalesce(afs.avoidable_mechanic_fail_count, 0)::bigint as avoidable_mechanic_fail_count,
  (
    select coalesce(count(*) filter (where (w->>''coverable'')::boolean), 0)
    from jsonb_array_elements(coalesce(b.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where b.cutoff_ms is null or (w->>''startMs'')::numeric < b.cutoff_ms
  )::bigint as defensive_window_coverable_count,
  (
    select coalesce(count(*) filter (where (w->>''covered'')::boolean), 0)
    from jsonb_array_elements(coalesce(b.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where b.cutoff_ms is null or (w->>''startMs'')::numeric < b.cutoff_ms
  )::bigint as defensive_window_covered_count,
  exists (
    select 1
    from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
  ) as defensive_window_used_anything,
  coalesce(us.success_count, 0)::bigint as unassigned_mechanic_success_count,
  evaluation.management_score as defensive_management_score_v2,
  case
    when evaluation.pull_id is null then null::integer
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where (event->>''state'') in (
        ''plan_broken'', ''death_with_viable_cd'', ''safe_extra_use'', ''missed_extra_opportunity''
      )
      or (
        (event->>''state'') in (''plan_covered'', ''covered_with_substitution'', ''reminder_missed'')
        and (event->>''requirementLevel'') in (''required'', ''recommended'')
      )
    )
  end as defensive_management_decision_count,
  evaluation.plan_required_count as defensive_required_count,
  evaluation.required_coverage_success_count as defensive_required_success_count,
  evaluation.required_exact_adherence_count as defensive_required_exact_adherence_count,
  evaluation.broken_reservation_count as defensive_broken_reservation_count,
  evaluation.death_viable_cd_count as defensive_death_viable_cd_count,
  evaluation.data_confidence as defensive_evaluation_confidence,
  evaluation.evaluator_version as defensive_evaluator_version,
  evaluation.resolver_version as defensive_resolver_version,
  evaluation.solver_version as defensive_solver_version,
  evaluation.game_build as defensive_game_build,
  evaluation.build_fingerprint as defensive_build_fingerprint,
  evaluation.evaluated_at as defensive_evaluated_at,
  canonical.evaluable_count as canonical_response_evaluable_count,
  canonical.success_count as canonical_response_success_count,
  canonical.failure_count as canonical_response_failure_count,
  canonical.defensive_generation_id as canonical_defensive_generation_id,
  canonical.evaluated_at as canonical_defensive_evaluated_at
from base b
left join hit_stats hs
  on hs.pull_id = b.pull_id and hs.player_name = b.player_name
left join eligible_stats es
  on es.pull_id = b.pull_id and es.player_name = b.player_name
left join avoidable_fail_stats afs
  on afs.pull_id = b.pull_id and afs.player_name = b.player_name
left join unassigned_stats us
  on us.pull_id = b.pull_id and us.player_name = b.player_name
left join public.player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = b.pull_id and evaluation.player_name = b.player_name
left join canonical_stats canonical
  on canonical.pull_id = b.pull_id and canonical.player_name = b.player_name
$$","revoke all on function public.get_player_pull_reliability_inputs_v2(text,timestamptz,text,text,uuid[]) from public","grant execute on function public.get_player_pull_reliability_inputs_v2(text,timestamptz,text,text,uuid[])
  to authenticated, service_role","comment on function public.get_player_pull_reliability_inputs_v2(text,timestamptz,text,text,uuid[]) is
  ''Scoped Fiabilidad read-path. Applies player/time/boss/pull filters before mechanic aggregation and exposes canonical defensive Response from the currently published defensive generation.''","notify pgrst, ''reload schema''"}', 'reliability_read_path_v2', NULL, NULL, NULL),
	('20260907131000', '{"-- Fiabilidad read-path v2 follow-up.
--
-- The first scoped RPC removed the player×pull correlated aggregation, but
-- reading applicable_pull_mechanic_events as a view still made PostgreSQL
-- repeatedly resolve applicability while building the scoped event set.
-- Resolve the two mechanic-name key sets once, then read pull_mechanic_events
-- directly. Semantics are identical to applicable_pull_mechanic_events:
--   include an event when no candidate exists for scope+normalized name,
--   or when that normalized candidate key is currently applicable.

create or replace function public.get_player_pull_reliability_inputs_v2(
  p_player_name text default null,
  p_since timestamptz default null,
  p_boss_id text default null,
  p_difficulty text default null,
  p_pull_ids uuid[] default null
)
returns table (
  player_name text,
  pull_id uuid,
  boss_id text,
  difficulty text,
  closed_at timestamptz,
  had_avoidable_damage boolean,
  self_positioning_death boolean,
  used_defensive_when_died boolean,
  used_defensive_in_pull boolean,
  defensive_use_opportunity boolean,
  enchanted_slot_count bigint,
  enchantable_slot_count bigint,
  gem_count bigint,
  gemmed_slot_count bigint,
  gemmable_slot_count bigint,
  personal_mechanic_fail_count bigint,
  report_code text,
  pull_number integer,
  avoidable_mechanic_eligible_count bigint,
  avoidable_mechanic_fail_count bigint,
  defensive_window_coverable_count bigint,
  defensive_window_covered_count bigint,
  defensive_window_used_anything boolean,
  unassigned_mechanic_success_count bigint,
  defensive_management_score_v2 numeric,
  defensive_management_decision_count integer,
  defensive_required_count integer,
  defensive_required_success_count integer,
  defensive_required_exact_adherence_count integer,
  defensive_broken_reservation_count integer,
  defensive_death_viable_cd_count integer,
  defensive_evaluation_confidence text,
  defensive_evaluator_version text,
  defensive_resolver_version text,
  defensive_solver_version text,
  defensive_game_build text,
  defensive_build_fingerprint text,
  defensive_evaluated_at timestamptz,
  canonical_response_evaluable_count integer,
  canonical_response_success_count integer,
  canonical_response_failure_count integer,
  canonical_defensive_generation_id uuid,
  canonical_defensive_evaluated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
with base as materialized (
  select
    r.player_name,
    p.id as pull_id,
    p.boss_id,
    p.difficulty,
    p.closed_at,
    p.report_code,
    p.pull_number,
    r.died,
    r.wipe_call_cluster,
    p.wipe_call_excluded,
    r.death_cause,
    r.defensive_casts,
    r.equipped_items,
    r.defensive_pressure_windows,
    p.unassigned_mechanic_occurrences,
    case
      when p.wipe_call_excluded
       and p.wipe_call_signals is not null
       and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      then (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      else null
    end as cutoff_ms
  from public.player_pull_records r
  join public.pulls p on p.id = r.pull_id
  where not p.ninja_pull_excluded
    and p.ingestion_status = ''complete''
    and (p_player_name is null or r.player_name = p_player_name)
    and (p_since is null or p.closed_at >= p_since)
    and (p_boss_id is null or p.boss_id = p_boss_id)
    and (p_difficulty is null or p.difficulty = p_difficulty)
    and (p_pull_ids is null or r.pull_id = any(p_pull_ids))
),
scoped_pulls as materialized (
  select distinct pull_id, cutoff_ms, unassigned_mechanic_occurrences
  from base
),
raw_mechanic_keys as materialized (
  select distinct
    boss_id,
    difficulty,
    lower(btrim(name)) as normalized_name
  from public.boss_mechanics_candidates
),
applicable_mechanic_keys as materialized (
  select distinct
    boss_id,
    difficulty,
    lower(btrim(name)) as normalized_name
  from public.applicable_boss_mechanics_candidates
),
events as materialized (
  select
    event.pull_id,
    event.trigger_time_ms,
    event.avoidable,
    event.outcome,
    event.category,
    event.responsibility,
    event.player_hit_details
  from public.pull_mechanic_events event
  join public.pulls pull on pull.id = event.pull_id
  join scoped_pulls sp on sp.pull_id = event.pull_id
  left join raw_mechanic_keys raw_key
    on raw_key.boss_id = pull.boss_id
   and raw_key.difficulty = pull.difficulty
   and raw_key.normalized_name = lower(btrim(event.mechanic_name))
  left join applicable_mechanic_keys applicable_key
    on applicable_key.boss_id = pull.boss_id
   and applicable_key.difficulty = pull.difficulty
   and applicable_key.normalized_name = lower(btrim(event.mechanic_name))
  where (raw_key.normalized_name is null or applicable_key.normalized_name is not null)
    and (sp.cutoff_ms is null or event.trigger_time_ms::numeric < sp.cutoff_ms)
),
eligible_stats as (
  select
    b.pull_id,
    b.player_name,
    count(*) filter (
      where e.category in (''avoidable-ground'', ''spread'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
        and (
          not b.died
          or (
            jsonb_typeof(b.death_cause->''timeMs'') = ''number''
            and (b.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
          )
        )
    )::bigint as avoidable_mechanic_eligible_count
  from base b
  left join events e on e.pull_id = b.pull_id
  group by b.pull_id, b.player_name
),
hit_stats as (
  select
    e.pull_id,
    detail->>''name'' as player_name,
    bool_or(
      e.avoidable is true
      and e.outcome <> ''clean''
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
    ) as had_avoidable_damage,
    count(*) filter (
      where e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
    )::bigint as personal_mechanic_fail_count
  from events e
  cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
  where nullif(detail->>''name'', '''') is not null
  group by e.pull_id, detail->>''name''
),
avoidable_fail_stats as (
  select
    b.pull_id,
    b.player_name,
    count(*) filter (
      where e.category in (''avoidable-ground'', ''spread'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
        and detail->>''name'' = b.player_name
        and (
          not b.died
          or (
            jsonb_typeof(b.death_cause->''timeMs'') = ''number''
            and (b.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
          )
        )
    )::bigint as avoidable_mechanic_fail_count
  from base b
  left join events e on e.pull_id = b.pull_id
  left join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail on true
  group by b.pull_id, b.player_name
),
unassigned_stats as (
  select
    sp.pull_id,
    occ->>''actorName'' as player_name,
    count(*)::bigint as success_count
  from scoped_pulls sp
  cross join lateral jsonb_array_elements(coalesce(sp.unassigned_mechanic_occurrences, ''[]''::jsonb)) occ
  where nullif(occ->>''actorName'', '''') is not null
  group by sp.pull_id, occ->>''actorName''
),
canonical_stats as (
  select
    evaluation.pull_id,
    evaluation.player_name,
    evaluation.defensive_generation_id,
    max(evaluation.evaluated_at) as evaluated_at,
    count(*) filter (
      where episode->>''responseVerdict'' in (
        ''covered_verified'', ''missed_ready'', ''missed_due_to_mistime''
      )
    )::integer as evaluable_count,
    count(*) filter (
      where episode->>''responseVerdict'' = ''covered_verified''
    )::integer as success_count,
    count(*) filter (
      where episode->>''responseVerdict'' in (''missed_ready'', ''missed_due_to_mistime'')
    )::integer as failure_count
  from public.player_pull_defensive_episode_evaluations evaluation
  join public.defensive_generation_pointer pointer
    on pointer.id = true
   and pointer.published_generation_id = evaluation.defensive_generation_id
  join base b
    on b.pull_id = evaluation.pull_id
   and b.player_name = evaluation.player_name
  left join lateral jsonb_array_elements(coalesce(evaluation.episodes, ''[]''::jsonb)) episode on true
  group by evaluation.pull_id, evaluation.player_name, evaluation.defensive_generation_id
)
select
  b.player_name,
  b.pull_id,
  b.boss_id,
  b.difficulty,
  b.closed_at,
  coalesce(hs.had_avoidable_damage, false) as had_avoidable_damage,
  (
    b.died
    and not (
      (b.wipe_call_cluster and b.wipe_call_excluded)
      or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and b.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (b.wipe_call_cluster and b.wipe_call_excluded)
      or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when b.died
      and jsonb_array_length(coalesce(b.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(b.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
    )
    or (
      b.died
      and not (
        (b.wipe_call_cluster and b.wipe_call_excluded)
        or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(b.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or coalesce(hs.had_avoidable_damage, false)
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  )::bigint as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  )::bigint as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb)) item
  )::bigint as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  )::bigint as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  )::bigint as gemmable_slot_count,
  coalesce(hs.personal_mechanic_fail_count, 0)::bigint as personal_mechanic_fail_count,
  b.report_code,
  b.pull_number,
  coalesce(es.avoidable_mechanic_eligible_count, 0)::bigint as avoidable_mechanic_eligible_count,
  coalesce(afs.avoidable_mechanic_fail_count, 0)::bigint as avoidable_mechanic_fail_count,
  (
    select coalesce(count(*) filter (where (w->>''coverable'')::boolean), 0)
    from jsonb_array_elements(coalesce(b.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where b.cutoff_ms is null or (w->>''startMs'')::numeric < b.cutoff_ms
  )::bigint as defensive_window_coverable_count,
  (
    select coalesce(count(*) filter (where (w->>''covered'')::boolean), 0)
    from jsonb_array_elements(coalesce(b.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where b.cutoff_ms is null or (w->>''startMs'')::numeric < b.cutoff_ms
  )::bigint as defensive_window_covered_count,
  exists (
    select 1
    from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
  ) as defensive_window_used_anything,
  coalesce(us.success_count, 0)::bigint as unassigned_mechanic_success_count,
  management.management_score as defensive_management_score_v2,
  case
    when management.pull_id is null then null::integer
    else (
      select count(*)::integer
      from jsonb_array_elements(management.events) event
      where (event->>''state'') in (
        ''plan_broken'', ''death_with_viable_cd'', ''safe_extra_use'', ''missed_extra_opportunity''
      )
      or (
        (event->>''state'') in (''plan_covered'', ''covered_with_substitution'', ''reminder_missed'')
        and (event->>''requirementLevel'') in (''required'', ''recommended'')
      )
    )
  end as defensive_management_decision_count,
  management.plan_required_count as defensive_required_count,
  management.required_coverage_success_count as defensive_required_success_count,
  management.required_exact_adherence_count as defensive_required_exact_adherence_count,
  management.broken_reservation_count as defensive_broken_reservation_count,
  management.death_viable_cd_count as defensive_death_viable_cd_count,
  management.data_confidence as defensive_evaluation_confidence,
  management.evaluator_version as defensive_evaluator_version,
  management.resolver_version as defensive_resolver_version,
  management.solver_version as defensive_solver_version,
  management.game_build as defensive_game_build,
  management.build_fingerprint as defensive_build_fingerprint,
  management.evaluated_at as defensive_evaluated_at,
  canonical.evaluable_count as canonical_response_evaluable_count,
  canonical.success_count as canonical_response_success_count,
  canonical.failure_count as canonical_response_failure_count,
  canonical.defensive_generation_id as canonical_defensive_generation_id,
  canonical.evaluated_at as canonical_defensive_evaluated_at
from base b
left join hit_stats hs
  on hs.pull_id = b.pull_id and hs.player_name = b.player_name
left join eligible_stats es
  on es.pull_id = b.pull_id and es.player_name = b.player_name
left join avoidable_fail_stats afs
  on afs.pull_id = b.pull_id and afs.player_name = b.player_name
left join unassigned_stats us
  on us.pull_id = b.pull_id and us.player_name = b.player_name
left join public.player_pull_defensive_evaluations management
  on management.pull_id = b.pull_id and management.player_name = b.player_name
left join canonical_stats canonical
  on canonical.pull_id = b.pull_id and canonical.player_name = b.player_name
$$","notify pgrst, ''reload schema''"}', 'reliability_read_path_v2_event_keys', NULL, NULL, NULL),
	('20260907132000', '{"-- Fiabilidad read-path v2 follow-up: do not explode player_hit_details for
-- every actor in every scoped event and only filter by player afterwards.
-- Join the already-filtered base first and keep only the requested actor''s
-- hit-detail row. This matters especially for dossier/night reads, which are
-- always player-scoped.

create or replace function public.get_player_pull_reliability_inputs_v2(
  p_player_name text default null,
  p_since timestamptz default null,
  p_boss_id text default null,
  p_difficulty text default null,
  p_pull_ids uuid[] default null
)
returns table (
  player_name text,
  pull_id uuid,
  boss_id text,
  difficulty text,
  closed_at timestamptz,
  had_avoidable_damage boolean,
  self_positioning_death boolean,
  used_defensive_when_died boolean,
  used_defensive_in_pull boolean,
  defensive_use_opportunity boolean,
  enchanted_slot_count bigint,
  enchantable_slot_count bigint,
  gem_count bigint,
  gemmed_slot_count bigint,
  gemmable_slot_count bigint,
  personal_mechanic_fail_count bigint,
  report_code text,
  pull_number integer,
  avoidable_mechanic_eligible_count bigint,
  avoidable_mechanic_fail_count bigint,
  defensive_window_coverable_count bigint,
  defensive_window_covered_count bigint,
  defensive_window_used_anything boolean,
  unassigned_mechanic_success_count bigint,
  defensive_management_score_v2 numeric,
  defensive_management_decision_count integer,
  defensive_required_count integer,
  defensive_required_success_count integer,
  defensive_required_exact_adherence_count integer,
  defensive_broken_reservation_count integer,
  defensive_death_viable_cd_count integer,
  defensive_evaluation_confidence text,
  defensive_evaluator_version text,
  defensive_resolver_version text,
  defensive_solver_version text,
  defensive_game_build text,
  defensive_build_fingerprint text,
  defensive_evaluated_at timestamptz,
  canonical_response_evaluable_count integer,
  canonical_response_success_count integer,
  canonical_response_failure_count integer,
  canonical_defensive_generation_id uuid,
  canonical_defensive_evaluated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
set plan_cache_mode = force_custom_plan
as $$
with base as materialized (
  select
    r.player_name,
    p.id as pull_id,
    p.boss_id,
    p.difficulty,
    p.closed_at,
    p.report_code,
    p.pull_number,
    r.died,
    r.wipe_call_cluster,
    p.wipe_call_excluded,
    r.death_cause,
    r.defensive_casts,
    r.equipped_items,
    r.defensive_pressure_windows,
    p.unassigned_mechanic_occurrences,
    case
      when p.wipe_call_excluded
       and p.wipe_call_signals is not null
       and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      then (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      else null
    end as cutoff_ms
  from public.player_pull_records r
  join public.pulls p on p.id = r.pull_id
  where not p.ninja_pull_excluded
    and p.ingestion_status = ''complete''
    and (p_player_name is null or r.player_name = p_player_name)
    and (p_since is null or p.closed_at >= p_since)
    and (p_boss_id is null or p.boss_id = p_boss_id)
    and (p_difficulty is null or p.difficulty = p_difficulty)
    and (p_pull_ids is null or r.pull_id = any(p_pull_ids))
),
scoped_pulls as materialized (
  select distinct pull_id, cutoff_ms, unassigned_mechanic_occurrences
  from base
),
raw_mechanic_keys as materialized (
  select distinct boss_id, difficulty, lower(btrim(name)) as normalized_name
  from public.boss_mechanics_candidates
),
applicable_mechanic_keys as materialized (
  select distinct boss_id, difficulty, lower(btrim(name)) as normalized_name
  from public.applicable_boss_mechanics_candidates
),
events as materialized (
  select
    event.pull_id,
    event.trigger_time_ms,
    event.avoidable,
    event.outcome,
    event.category,
    event.responsibility,
    event.player_hit_details
  from public.pull_mechanic_events event
  join public.pulls pull on pull.id = event.pull_id
  join scoped_pulls sp on sp.pull_id = event.pull_id
  left join raw_mechanic_keys raw_key
    on raw_key.boss_id = pull.boss_id
   and raw_key.difficulty = pull.difficulty
   and raw_key.normalized_name = lower(btrim(event.mechanic_name))
  left join applicable_mechanic_keys applicable_key
    on applicable_key.boss_id = pull.boss_id
   and applicable_key.difficulty = pull.difficulty
   and applicable_key.normalized_name = lower(btrim(event.mechanic_name))
  where (raw_key.normalized_name is null or applicable_key.normalized_name is not null)
    and (sp.cutoff_ms is null or event.trigger_time_ms::numeric < sp.cutoff_ms)
),
eligible_stats as (
  select
    b.pull_id,
    b.player_name,
    count(*) filter (
      where e.category in (''avoidable-ground'', ''spread'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
        and (
          not b.died
          or (
            jsonb_typeof(b.death_cause->''timeMs'') = ''number''
            and (b.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
          )
        )
    )::bigint as avoidable_mechanic_eligible_count
  from base b
  left join events e on e.pull_id = b.pull_id
  group by b.pull_id, b.player_name
),
hit_stats as (
  select
    b.pull_id,
    b.player_name,
    coalesce(
      bool_or(
        e.avoidable is true
        and e.outcome <> ''clean''
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      ) filter (where detail is not null),
      false
    ) as had_avoidable_damage,
    count(*) filter (
      where detail is not null
        and e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
    )::bigint as personal_mechanic_fail_count
  from base b
  left join events e on e.pull_id = b.pull_id
  left join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    on detail->>''name'' = b.player_name
  group by b.pull_id, b.player_name
),
avoidable_fail_stats as (
  select
    b.pull_id,
    b.player_name,
    count(*) filter (
      where detail is not null
        and e.category in (''avoidable-ground'', ''spread'')
        and (e.responsibility = ''personal'' or e.responsibility is null)
        and e.outcome <> ''clean''
        and (
          not b.died
          or (
            jsonb_typeof(b.death_cause->''timeMs'') = ''number''
            and (b.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
          )
        )
    )::bigint as avoidable_mechanic_fail_count
  from base b
  left join events e on e.pull_id = b.pull_id
  left join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    on detail->>''name'' = b.player_name
  group by b.pull_id, b.player_name
),
unassigned_stats as (
  select sp.pull_id, occ->>''actorName'' as player_name, count(*)::bigint as success_count
  from scoped_pulls sp
  cross join lateral jsonb_array_elements(coalesce(sp.unassigned_mechanic_occurrences, ''[]''::jsonb)) occ
  where nullif(occ->>''actorName'', '''') is not null
  group by sp.pull_id, occ->>''actorName''
),
canonical_stats as (
  select
    evaluation.pull_id,
    evaluation.player_name,
    evaluation.defensive_generation_id,
    max(evaluation.evaluated_at) as evaluated_at,
    count(*) filter (
      where episode->>''responseVerdict'' in (
        ''covered_verified'', ''missed_ready'', ''missed_due_to_mistime''
      )
    )::integer as evaluable_count,
    count(*) filter (where episode->>''responseVerdict'' = ''covered_verified'')::integer as success_count,
    count(*) filter (
      where episode->>''responseVerdict'' in (''missed_ready'', ''missed_due_to_mistime'')
    )::integer as failure_count
  from public.player_pull_defensive_episode_evaluations evaluation
  join public.defensive_generation_pointer pointer
    on pointer.id = true
   and pointer.published_generation_id = evaluation.defensive_generation_id
  join base b
    on b.pull_id = evaluation.pull_id
   and b.player_name = evaluation.player_name
  left join lateral jsonb_array_elements(coalesce(evaluation.episodes, ''[]''::jsonb)) episode on true
  group by evaluation.pull_id, evaluation.player_name, evaluation.defensive_generation_id
)
select
  b.player_name,
  b.pull_id,
  b.boss_id,
  b.difficulty,
  b.closed_at,
  hs.had_avoidable_damage,
  (
    b.died
    and not (
      (b.wipe_call_cluster and b.wipe_call_excluded)
      or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and b.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (b.wipe_call_cluster and b.wipe_call_excluded)
      or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when b.died
      and jsonb_array_length(coalesce(b.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(b.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
    )
    or (
      b.died
      and not (
        (b.wipe_call_cluster and b.wipe_call_excluded)
        or coalesce(b.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(b.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or hs.had_avoidable_damage
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  )::bigint as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  )::bigint as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb)) item
  )::bigint as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  )::bigint as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(b.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  )::bigint as gemmable_slot_count,
  hs.personal_mechanic_fail_count,
  b.report_code,
  b.pull_number,
  coalesce(es.avoidable_mechanic_eligible_count, 0)::bigint,
  coalesce(afs.avoidable_mechanic_fail_count, 0)::bigint,
  (
    select coalesce(count(*) filter (where (w->>''coverable'')::boolean), 0)
    from jsonb_array_elements(coalesce(b.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where b.cutoff_ms is null or (w->>''startMs'')::numeric < b.cutoff_ms
  )::bigint,
  (
    select coalesce(count(*) filter (where (w->>''covered'')::boolean), 0)
    from jsonb_array_elements(coalesce(b.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where b.cutoff_ms is null or (w->>''startMs'')::numeric < b.cutoff_ms
  )::bigint,
  exists (
    select 1
    from jsonb_array_elements(coalesce(b.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and (b.cutoff_ms is null or (cast_time #>> ''{}'')::numeric < b.cutoff_ms)
  ),
  coalesce(us.success_count, 0)::bigint,
  management.management_score,
  case
    when management.pull_id is null then null::integer
    else (
      select count(*)::integer
      from jsonb_array_elements(management.events) event
      where (event->>''state'') in (
        ''plan_broken'', ''death_with_viable_cd'', ''safe_extra_use'', ''missed_extra_opportunity''
      )
      or (
        (event->>''state'') in (''plan_covered'', ''covered_with_substitution'', ''reminder_missed'')
        and (event->>''requirementLevel'') in (''required'', ''recommended'')
      )
    )
  end,
  management.plan_required_count,
  management.required_coverage_success_count,
  management.required_exact_adherence_count,
  management.broken_reservation_count,
  management.death_viable_cd_count,
  management.data_confidence,
  management.evaluator_version,
  management.resolver_version,
  management.solver_version,
  management.game_build,
  management.build_fingerprint,
  management.evaluated_at,
  canonical.evaluable_count,
  canonical.success_count,
  canonical.failure_count,
  canonical.defensive_generation_id,
  canonical.evaluated_at
from base b
left join hit_stats hs on hs.pull_id = b.pull_id and hs.player_name = b.player_name
left join eligible_stats es on es.pull_id = b.pull_id and es.player_name = b.player_name
left join avoidable_fail_stats afs on afs.pull_id = b.pull_id and afs.player_name = b.player_name
left join unassigned_stats us on us.pull_id = b.pull_id and us.player_name = b.player_name
left join public.player_pull_defensive_evaluations management
  on management.pull_id = b.pull_id and management.player_name = b.player_name
left join canonical_stats canonical
  on canonical.pull_id = b.pull_id and canonical.player_name = b.player_name
$$","notify pgrst, ''reload schema''"}', 'reliability_read_path_v2_player_hit_scope', NULL, NULL, NULL),
	('20260907133000', '{"-- Keep the player-scoped reliability RPC inlineable by PostgreSQL.
--
-- The previous function definition carried SET search_path / SET
-- plan_cache_mode clauses. Those clauses make SQL-language functions
-- non-inlineable, so Postgres executed the whole RPC behind an opaque
-- Function Scan. On the production Dewerland/60d case that turned the
-- otherwise set-based read path into ~2.4s of work.
--
-- Every relation referenced by get_player_pull_reliability_inputs_v2 is
-- already schema-qualified where needed, and the function is SECURITY
-- INVOKER, so no per-function GUC is required here. RESET ALL restores the
-- default function proconfig and lets the planner inline the SQL body.

alter function public.get_player_pull_reliability_inputs_v2(
  text,
  timestamptz,
  text,
  text,
  uuid[]
) reset all","notify pgrst, ''reload schema''"}', 'reliability_read_path_v2_inlineable', NULL, NULL, NULL),
	('20260905114500', '{"-- Defensive evidence v5: source/claim normalization discovered by the E7 fixture battery.
-- No player-specific rules. All changes are build/spec/ability semantic facts.

alter table public.defensive_modifier_rules
  add column if not exists presence_mode text not null default ''talent_selected''","do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = ''defensive_modifier_rules_presence_mode_check''
  ) then
    alter table public.defensive_modifier_rules
      add constraint defensive_modifier_rules_presence_mode_check
      check (presence_mode in (''talent_selected'',''spec_baseline''));
  end if;
end $$","-- Spec passives are auto-granted by the spec and do not appear as selectable
-- WCL talent nodes. Their modifiers must be applied from class/spec/build.
update public.defensive_modifier_rules
set presence_mode = ''spec_baseline''
where game_build = ''12.1.0.68914''
  and class = ''Monk''
  and target_spell_id = 115203
  and modifier_spell_id in (1258138, 1258122)","-- Exact-current charge modifiers verified against current spell data.
update public.defensive_modifier_rules
set active = true
where game_build = ''12.1.0.68914''
  and (
    (class = ''DemonHunter'' and modifier_spell_id = 1266307 and target_spell_id in (198589,203720))
    or
    (class = ''Paladin'' and modifier_spell_id = 1246481 and target_spell_id = 86659)
  )","-- Fade with Translucent Image is a real, finite-CD, self 10% DR. Base Fade
-- remains utility; only the verified talent-selected augment creates a normal
-- personal mitigation opportunity. This is intentionally NOT a code hardcode.
update public.defensive_semantic_rules
set payload = jsonb_set(payload, ''{setOpportunityMode}'', ''\"normal\"''::jsonb, true)
where game_build = ''12.1.0.68914''
  and verified = true
  and rule_type = ''augment''
  and modifier_spell_id = 373446
  and target_spell_id = 586
  and payload->>''condition'' = ''talent_selected''"}', 'defensive_evidence_claims_v5', NULL, NULL, NULL),
	('20260905144500', '{"-- Defensive evidence v6: close the empirical gaps found by Shadow v5.
-- No player-specific exceptions. All changes are class/spec/build semantic or
-- source-precedence facts that the generic resolver can consume.

-- 1) Fade base remains utility. Translucent Image atomically promotes the
-- effective Fade semantic contract to a normal personal survival cooldown.
update public.defensive_semantic_rules
set payload = payload
  || jsonb_build_object(
    ''setUsageRole'', ''personal_survival'',
    ''setOpportunityMode'', ''normal'',
    ''setDefensiveIntent'', ''primary'',
    ''setPrimaryBeneficiary'', ''self''
  )
where game_build = ''12.1.0.68914''
  and verified = true
  and rule_type = ''augment''
  and modifier_spell_id = 373446
  and target_spell_id = 586
  and payload->>''condition'' = ''talent_selected''","-- Exact-current Translucent Image timing and Fade-CD talent modifiers were
-- already sourced/verified but were disabled during the conservative shadow.
-- Their presence remains talent_selected, so activating the rule does not
-- apply it to builds that do not select the talent.
update public.defensive_modifier_rules
set active = true
where game_build = ''12.1.0.68914''
  and class = ''Priest''
  and target_spell_id = 586
  and modifier_spell_id in (373446, 390670)
  and presence_mode = ''talent_selected''","-- Improved Prismatic Barrier is an exact-current, talent-selected charge fact.
-- Barrier Diffusion remains disabled because it is conditional runtime state
-- and must not be applied as an unconditional cooldown modifier.
update public.defensive_modifier_rules
set active = true
where game_build = ''12.1.0.68914''
  and class = ''Mage''
  and target_spell_id = 235450
  and modifier_spell_id = 321745
  and operation = ''charges_add''
  and presence_mode = ''talent_selected''","-- Guardrails: fail the migration if the effective Fade semantic rule would
-- still be structurally incomplete. These checks validate data shape only;
-- the TypeScript semantic-closure gate validates the final materialized
-- combination for every resolved build.
do $$
declare
  p jsonb;
begin
  select payload into p
  from public.defensive_semantic_rules
  where game_build = ''12.1.0.68914''
    and verified = true
    and rule_type = ''augment''
    and modifier_spell_id = 373446
    and target_spell_id = 586
  limit 1;

  if p is null
     or p->>''setUsageRole'' <> ''personal_survival''
     or p->>''setOpportunityMode'' <> ''normal''
     or p->>''setPrimaryBeneficiary'' <> ''self''
     or not (coalesce(p->''addMechanisms'', ''[]''::jsonb) ? ''mitigation'') then
    raise exception ''defensive evidence v6: Translucent Image semantic promotion is incomplete'';
  end if;
end $$"}', 'defensive_evidence_v6', NULL, NULL, NULL),
	('20260905150000', '{"-- Shadow v6 provenance closure.
--
-- These rows already carried exact 12.1.0.68914 identities and the correct
-- numeric values, but `reviewed=false` forced the resolver to let redundant
-- legacy-current spec profiles degrade availability confidence to fallback.
-- The values below were independently re-checked against current live spell
-- tooltips for the exact spell IDs used by WCL in this corpus:
--   Blur 198589             -> 60s cooldown, 10s effect
--   Prismatic Barrier 235450 -> 30s cooldown, 60s effect
-- Improved Prismatic Barrier''s additional charge is handled separately by
-- the exact-current talent-selected modifier rule activated in v6.
-- Barrier Diffusion remains disabled because its reduction is conditional at
-- runtime and must never be flattened into an unconditional cooldown value.

DO $$
DECLARE
  blur record;
  barrier record;
BEGIN
  SELECT * INTO blur
  FROM public.cooldown_catalog
  WHERE spell_id = 198589
    AND activation_game_build = ''12.1.0.68914''
  LIMIT 1;

  IF blur.id IS NULL
     OR blur.base_cooldown_ms <> 60000
     OR blur.base_duration_ms <> 10000
     OR blur.excluded IS TRUE THEN
    RAISE EXCEPTION ''v6 exact-current review: Blur 198589 row/value drift'';
  END IF;

  SELECT * INTO barrier
  FROM public.cooldown_catalog
  WHERE spell_id = 235450
    AND activation_game_build = ''12.1.0.68914''
  LIMIT 1;

  IF barrier.id IS NULL
     OR barrier.base_cooldown_ms <> 30000
     OR barrier.base_duration_ms <> 60000
     OR barrier.excluded IS TRUE THEN
    RAISE EXCEPTION ''v6 exact-current review: Prismatic Barrier 235450 row/value drift'';
  END IF;
END $$","UPDATE public.cooldown_catalog
SET reviewed = true,
    updated_at = now()
WHERE activation_game_build = ''12.1.0.68914''
  AND (
    (spell_id = 198589 AND base_cooldown_ms = 60000 AND base_duration_ms = 10000)
    OR
    (spell_id = 235450 AND base_cooldown_ms = 30000 AND base_duration_ms = 60000)
  )"}', 'defensive_exact_current_review_v6', NULL, NULL, NULL),
	('20260905165500', '{"-- Final defensive semantic closure: Protection Divine Shield + Final Stand.
--
-- Contract:
--   * Protection + Divine Shield without Final Stand => credit_only.
--     A correct bubble may receive credit, but mere availability must never
--     manufacture a missed defensive opportunity for a tank that would lose
--     enemy targeting while immune.
--   * Protection + Final Stand selected => normal.
--     Final Stand is the explicit build fact that makes Divine Shield a normal
--     missable opportunity for Protection.
--   * Holy / Retribution keep the existing base semantic: normal.
--
-- This is deliberately data-only. The canonical resolver already applies
-- specSemanticProfiles before verified talent_selected augment rules, so no
-- evaluator/timing special-case is required.

DO $$
DECLARE
  semantic_row record;
BEGIN
  SELECT s.*, c.spell_id, c.name
    INTO semantic_row
  FROM public.defensive_ability_semantics s
  JOIN public.cooldown_catalog c ON c.id = s.catalog_id
  WHERE c.spell_id = 642
    AND c.activation_game_build = ''12.1.0.68914''
  LIMIT 1;

  IF semantic_row.id IS NULL THEN
    RAISE EXCEPTION ''Divine Shield 642 exact-current semantic row missing'';
  END IF;

  IF semantic_row.usage_role <> ''personal_survival''
     OR semantic_row.activation_scope <> ''self''
     OR semantic_row.primary_beneficiary <> ''self''
     OR semantic_row.opportunity_mode <> ''normal''
     OR semantic_row.semantic_status <> ''verified''
     OR NOT (semantic_row.mechanisms @> ARRAY[''immunity'']::text[]) THEN
    RAISE EXCEPTION ''Divine Shield 642 base semantic drift; refusing targeted Protection override'';
  END IF;
END $$","UPDATE public.defensive_ability_semantics s
SET spec_semantic_profiles = (
      SELECT COALESCE(jsonb_agg(entry), ''[]''::jsonb)
      FROM (
        SELECT value AS entry
        FROM jsonb_array_elements(COALESCE(s.spec_semantic_profiles, ''[]''::jsonb))
        WHERE value->>''spec'' <> ''Protection''
        UNION ALL
        SELECT jsonb_build_object(
          ''spec'', ''Protection'',
          ''usageRole'', ''personal_survival'',
          ''defensiveIntent'', ''primary'',
          ''activationScope'', ''self'',
          ''primaryBeneficiary'', ''self'',
          ''secondaryPropagation'', ''none'',
          ''mechanisms'', jsonb_build_array(''immunity''),
          ''opportunityMode'', ''credit_only'',
          ''applicability'', NULL,
          ''source'', ''IRIS final shadow review 2026-09-05: Protection Divine Shield requires Final Stand for normal missable opportunity'',
          ''confidence'', ''high''
        ) AS entry
      ) profiles
    ),
    semantic_version = ''defensive-semantics@1.0.1'',
    source = ''classify-defensives v10 + IRIS Protection Divine Shield/Final Stand closure 2026-09-05'',
    reviewed_at = now(),
    updated_at = now()
FROM public.cooldown_catalog c
WHERE c.id = s.catalog_id
  AND c.spell_id = 642
  AND c.activation_game_build = ''12.1.0.68914''","INSERT INTO public.defensive_semantic_rules (
  id,
  modifier_spell_id,
  target_spell_id,
  specs,
  game_build,
  rule_type,
  payload,
  source,
  verified,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  204077,
  642,
  ARRAY[''Protection'']::text[],
  ''12.1.0.68914'',
  ''augment'',
  jsonb_build_object(
    ''condition'', ''talent_selected'',
    ''modifierName'', ''Final Stand'',
    ''setUsageRole'', NULL,
    ''setDefensiveIntent'', NULL,
    ''setOpportunityMode'', ''normal'',
    ''setPrimaryBeneficiary'', NULL,
    ''setSecondaryPropagation'', NULL,
    ''addMechanisms'', jsonb_build_array(),
    ''removeMechanisms'', jsonb_build_array(),
    ''applicabilityPatch'', NULL,
    ''notes'', ''Protection-only: Final Stand converts Divine Shield from credit_only to a normal missable opportunity.''
  ),
  ''IRIS final shadow review 2026-09-05'',
  true,
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.defensive_semantic_rules r
  WHERE r.modifier_spell_id = 204077
    AND r.target_spell_id = 642
    AND r.game_build = ''12.1.0.68914''
    AND r.rule_type = ''augment''
)","DO $$
DECLARE
  protection_profile jsonb;
  final_stand_rule record;
BEGIN
  SELECT profile
    INTO protection_profile
  FROM public.defensive_ability_semantics s
  JOIN public.cooldown_catalog c ON c.id = s.catalog_id
  CROSS JOIN LATERAL jsonb_array_elements(s.spec_semantic_profiles) profile
  WHERE c.spell_id = 642
    AND c.activation_game_build = ''12.1.0.68914''
    AND profile->>''spec'' = ''Protection''
  LIMIT 1;

  IF protection_profile IS NULL
     OR protection_profile->>''usageRole'' <> ''personal_survival''
     OR protection_profile->>''opportunityMode'' <> ''credit_only'' THEN
    RAISE EXCEPTION ''Protection Divine Shield credit_only profile not established'';
  END IF;

  SELECT * INTO final_stand_rule
  FROM public.defensive_semantic_rules r
  WHERE r.modifier_spell_id = 204077
    AND r.target_spell_id = 642
    AND r.game_build = ''12.1.0.68914''
    AND r.rule_type = ''augment''
    AND r.verified = true
  LIMIT 1;

  IF final_stand_rule.id IS NULL
     OR final_stand_rule.payload->>''condition'' <> ''talent_selected''
     OR final_stand_rule.payload->>''setOpportunityMode'' <> ''normal'' THEN
    RAISE EXCEPTION ''Final Stand -> Divine Shield normal opportunity rule not established'';
  END IF;
END $$"}', 'protection_divine_shield_final_stand_semantics', NULL, NULL, NULL),
	('20260905230000', '{"-- Attribution Safety v1 · mechanics.
--
-- Problema demostrado en producción: player_hit_details describe receptores
-- de daño, no necesariamente autores del fallo. El eje Mecánica seguía
-- usando category como proxy de culpabilidad aun cuando pull_mechanic_events
-- ya conserva responsibility (tank/healer/dps/raid/personal).
--
-- Regla de transición, deliberadamente conservadora:
--   * si responsibility existe, solo ''personal'' puede alimentar penalización
--     individual genérica;
--   * tank/healer/dps/raid nunca penalizan al receptor del daño;
--   * si responsibility es null (histórico), se conserva el criterio legacy
--     por category para no vaciar noches antiguas de golpe.
--
-- No intenta resolver todavía autoría de tank swaps, soaks, spreads o
-- asignaciones: esos casos requieren responsibility graph/evidence causal.
-- Mantiene exactamente el contrato y orden de columnas del legacy view para
-- no romper el wrapper player_pull_reliability_inputs ni sus consumidores.

create or replace view player_pull_reliability_inputs_legacy_v1
with (security_invoker = true) as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    )
    and r.death_cause->>''rootCause'' = ''self_positioning''
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0 then (
      select bool_and((opt->>''status'') <> ''available_unused'')
      from jsonb_array_elements(r.death_cause->''defensiveOptions'') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
      where jsonb_typeof(cast_time) = ''number''
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>''statisticalExclusionReason'', '''') = ''boss_melee_on_non_tank''
      )
      and jsonb_array_length(coalesce(r.death_cause->''defensiveOptions'', ''[]''::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and e.outcome <> ''clean''
        and detail->>''name'' = r.player_name
        and coalesce((detail->>''damage_taken'')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
          and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>''permanentEnchant'')::bigint, 0) > 0
        and coalesce((item->>''id'')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>''id'')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->''gems'', ''[]''::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>''id'')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, ''[]''::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'', ''soak'', ''personal-target'')
      and (e.responsibility = ''personal'' or e.responsibility is null)
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as personal_mechanic_fail_count,
  p.report_code,
  p.pull_number,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and (e.responsibility = ''personal'' or e.responsibility is null)
      and e.outcome <> ''clean''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_eligible_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, ''[]''::jsonb)) detail
    where e.pull_id = p.id
      and e.category in (''avoidable-ground'', ''spread'')
      and (e.responsibility = ''personal'' or e.responsibility is null)
      and e.outcome <> ''clean''
      and detail->>''name'' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and e.trigger_time_ms >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->''timeMs'') = ''number''
          and (r.death_cause->>''timeMs'')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_fail_count,
  (
    select coalesce(count(*) filter (where (w->>''coverable'')::boolean), 0)
    from jsonb_array_elements(coalesce(r.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where not (
      p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      and (w->>''startMs'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
    )
  ) as defensive_window_coverable_count,
  (
    select coalesce(count(*) filter (where (w->>''covered'')::boolean), 0)
    from jsonb_array_elements(coalesce(r.defensive_pressure_windows->''windows'', ''[]''::jsonb)) w
    where not (
      p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
      and (w->>''startMs'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
    )
  ) as defensive_window_covered_count,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, ''[]''::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->''timestampsMs'', ''[]''::jsonb)) cast_time
    where jsonb_typeof(cast_time) = ''number''
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->''wipeCallStartMs'') = ''number''
        and (cast_time #>> ''{}'')::numeric >= (p.wipe_call_signals->>''wipeCallStartMs'')::numeric
      )
  ) as defensive_window_used_anything,
  r.defensive_pressure_windows,
  (
    select count(*)
    from jsonb_array_elements(coalesce(p.unassigned_mechanic_occurrences, ''[]''::jsonb)) occ
    where occ->>''actorName'' = r.player_name
  ) as unassigned_mechanic_success_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded","comment on view player_pull_reliability_inputs_legacy_v1 is
  ''Compatibilidad v1 con Attribution Safety: responsibility explícita manda sobre category para penalización mecánica individual; category legacy solo se usa cuando responsibility es null.''","comment on column player_pull_reliability_inputs_legacy_v1.personal_mechanic_fail_count is
  ''Fallos personales graduados: solo eventos con responsibility=personal; si responsibility es null se conserva temporalmente el fallback histórico por category.''","notify pgrst, ''reload schema''"}', 'mechanic_attribution_safety_v1', NULL, NULL, NULL),
	('20260905233000', '{"-- Mechanic Attribution Canonical Shadow v1.
--
-- Additive, officer-only and deliberately non-punitive. This table stores how
-- far IRIS can safely attribute a real mechanic occurrence without changing
-- dossier/scoring consumers. Shadow v1 has a DB-enforced invariant:
-- canonical attribution may validate/reduce Attribution Safety v1, but it may
-- never create a new player accusation.

create table if not exists mechanic_attribution_shadow_evaluations (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references mechanic_occurrence_evaluations(id) on delete cascade,
  pull_id uuid not null references pulls(id) on delete cascade,
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null,
  occurrence_index integer not null check (occurrence_index > 0),
  attribution_status text not null check (attribution_status in (
    ''verified'', ''role_only'', ''raid_only'', ''unresolved'', ''not_applicable''
  )),
  attribution_reason text not null check (attribution_reason in (
    ''NO_FAILURE_TO_ATTRIBUTE'',
    ''OCCURRENCE_NOT_EVALUABLE'',
    ''IDENTITY_OR_POLICY_MISSING'',
    ''UNTRUSTED_EVIDENCE'',
    ''SEMANTIC_CONTRADICTION'',
    ''RAID_RESPONSIBILITY_ONLY'',
    ''ROLE_RESPONSIBILITY_ONLY'',
    ''NO_PUNITIVE_SCOPE'',
    ''DIRECT_PERSONAL_AVOIDABLE_GROUND'',
    ''PERSONAL_TARGET_REQUIRES_RESPONSE_EVIDENCE'',
    ''ASSIGNED_PLAYER_VERIFIED'',
    ''ASSIGNMENT_NOT_MATERIALIZED'',
    ''MULTI_ACTOR_PERSONAL_FAMILY_REQUIRES_OWNERSHIP'',
    ''UNSUPPORTED_PERSONAL_FAMILY'',
    ''PERSONAL_RESPONSIBILITY_WITHOUT_PLAYER_EVIDENCE'',
    ''SAFETY_V1_GUARD_BLOCKED_NEW_ACCUSATION''
  )),
  responsible_players text[] not null default ''{}'',
  safety_v1_players text[] not null default ''{}'',
  new_accusation_players text[] not null default ''{}'',
  confidence text not null check (confidence in (''verified'', ''inferred'', ''fallback'', ''uncertain'')),
  evidence_claims jsonb not null default ''[]''::jsonb check (jsonb_typeof(evidence_claims) = ''array''),
  evaluator_version text not null check (nullif(btrim(evaluator_version), '''') is not null),
  occurrence_resolver_version text not null check (nullif(btrim(occurrence_resolver_version), '''') is not null),
  policy_version integer not null check (policy_version > 0),
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (occurrence_id, evaluator_version),
  check (array_position(responsible_players, null) is null),
  check (array_position(safety_v1_players, null) is null),
  check (array_position(new_accusation_players, null) is null),
  -- The most important rollout invariant: shadow v1 cannot expand blame.
  check (cardinality(new_accusation_players) = 0),
  check (
    (attribution_status = ''verified'' and cardinality(responsible_players) > 0)
    or
    (attribution_status <> ''verified'' and cardinality(responsible_players) = 0)
  ),
  check (attribution_status <> ''verified'' or confidence in (''verified'', ''inferred''))
)","create index if not exists mechanic_attribution_shadow_pull_idx
  on mechanic_attribution_shadow_evaluations (pull_id, occurrence_index)","create index if not exists mechanic_attribution_shadow_status_idx
  on mechanic_attribution_shadow_evaluations (attribution_status, attribution_reason, evaluated_at desc)","create index if not exists mechanic_attribution_shadow_mechanic_idx
  on mechanic_attribution_shadow_evaluations (
    boss_id, difficulty, mechanic_key, occurrence_resolver_version, evaluator_version
  )","alter table mechanic_attribution_shadow_evaluations enable row level security","drop policy if exists \"mechanic_attribution_shadow_evaluations: officers read\"
  on mechanic_attribution_shadow_evaluations","create policy \"mechanic_attribution_shadow_evaluations: officers read\"
  on mechanic_attribution_shadow_evaluations for select using (is_officer())","revoke all on mechanic_attribution_shadow_evaluations from anon, authenticated","grant select on mechanic_attribution_shadow_evaluations to authenticated","create or replace view mechanic_attribution_shadow_report_v1
with (security_invoker = true)
as
select
  p.report_code,
  s.evaluator_version,
  s.occurrence_resolver_version,
  count(*)::integer as occurrence_count,
  count(*) filter (where s.attribution_status = ''verified'')::integer as verified_occurrence_count,
  count(*) filter (where s.attribution_status = ''role_only'')::integer as role_only_count,
  count(*) filter (where s.attribution_status = ''raid_only'')::integer as raid_only_count,
  count(*) filter (where s.attribution_status = ''unresolved'')::integer as unresolved_count,
  count(*) filter (where s.attribution_status = ''not_applicable'')::integer as not_applicable_count,
  coalesce(sum(cardinality(s.responsible_players)), 0)::integer as canonical_verified_player_count,
  coalesce(sum(cardinality(s.safety_v1_players)), 0)::integer as safety_v1_player_count,
  coalesce(sum(cardinality(s.new_accusation_players)), 0)::integer as new_accusation_count,
  count(distinct s.policy_version)::integer as policy_version_count,
  max(s.evaluated_at) as evaluated_at
from mechanic_attribution_shadow_evaluations s
join pulls p on p.id = s.pull_id
group by p.report_code, s.evaluator_version, s.occurrence_resolver_version","revoke all on mechanic_attribution_shadow_report_v1 from anon","grant select on mechanic_attribution_shadow_report_v1 to authenticated","comment on table mechanic_attribution_shadow_evaluations is
  ''Non-punitive mechanic ownership shadow. verified means actor ownership can be defended with current evidence; role_only/raid_only/unresolved never identify a player. new_accusation_players is DB-constrained to empty in shadow v1.''","comment on view mechanic_attribution_shadow_report_v1 is
  ''Report-level quality gate for canonical mechanic attribution shadow. UI/scoring must not consume this view during v1 rollout.''"}', 'mechanic_attribution_canonical_shadow_v1', NULL, NULL, NULL),
	('20260906214500', '{"-- Atomic replacement primitive for replaying historical pull_mechanic_events.
-- The caller supplies rows produced by the SAME buildMechanicEventRows() helper
-- used by analyze-report. DELETE + INSERT live in one PostgreSQL transaction:
-- if any replacement row is invalid, the previous evidence is preserved.

create or replace function public.replace_pull_mechanic_events(
  p_pull_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
  v_inserted integer := 0;
  v_exists boolean := false;
begin
  if p_pull_id is null then
    raise exception ''p_pull_id is required'';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> ''array'' then
    raise exception ''p_rows must be a JSON array'';
  end if;

  -- Serialize replay against any concurrent mutation of this pull.
  select true
    into v_exists
    from public.pulls
   where id = p_pull_id
   for update;

  if not coalesce(v_exists, false) then
    raise exception ''pull % not found'', p_pull_id;
  end if;

  select count(*)::integer
    into v_deleted
    from public.pull_mechanic_events
   where pull_id = p_pull_id;

  delete from public.pull_mechanic_events
   where pull_id = p_pull_id;

  insert into public.pull_mechanic_events (
    pull_id,
    ability_id,
    mechanic_name,
    description,
    category,
    responsibility,
    trigger_time_ms,
    outcome,
    players_hit,
    players_hit_names,
    avoidable,
    player_hit_details,
    phase_id,
    comparison_source,
    comparison_percentile
  )
  select
    p_pull_id,
    (row_data ->> ''ability_id'')::bigint,
    row_data ->> ''mechanic_name'',
    row_data ->> ''description'',
    row_data ->> ''category'',
    row_data ->> ''responsibility'',
    (row_data ->> ''trigger_time_ms'')::integer,
    row_data ->> ''outcome'',
    coalesce((row_data ->> ''players_hit'')::integer, 0),
    array(
      select jsonb_array_elements_text(
        case
          when jsonb_typeof(row_data -> ''players_hit_names'') = ''array''
            then row_data -> ''players_hit_names''
          else ''[]''::jsonb
        end
      )
    ),
    case
      when row_data ? ''avoidable'' and jsonb_typeof(row_data -> ''avoidable'') <> ''null''
        then (row_data ->> ''avoidable'')::boolean
      else null
    end,
    case
      when jsonb_typeof(row_data -> ''player_hit_details'') = ''array''
        then row_data -> ''player_hit_details''
      else ''[]''::jsonb
    end,
    case
      when row_data ? ''phase_id'' and jsonb_typeof(row_data -> ''phase_id'') <> ''null''
        then (row_data ->> ''phase_id'')::integer
      else null
    end,
    row_data ->> ''comparison_source'',
    case
      when row_data ? ''comparison_percentile'' and jsonb_typeof(row_data -> ''comparison_percentile'') <> ''null''
        then (row_data ->> ''comparison_percentile'')::numeric
      else null
    end
  from jsonb_array_elements(p_rows) as rows(row_data);

  get diagnostics v_inserted = row_count;

  update public.pulls
     set updated_at = now()
   where id = p_pull_id;

  return jsonb_build_object(
    ''pullId'', p_pull_id,
    ''deleted'', v_deleted,
    ''inserted'', v_inserted
  );
end;
$$","revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from public","revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from anon","revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from authenticated","grant execute on function public.replace_pull_mechanic_events(uuid, jsonb) to service_role","comment on function public.replace_pull_mechanic_events(uuid, jsonb) is
  ''Atomically replaces pull_mechanic_events for one pull with rows produced by the canonical materializer.''"}', 'replace_pull_mechanic_events', NULL, NULL, NULL),
	('20260907100000', '{"-- Dossier / player infographic read-path performance.
--
-- Context (2026-09-07): opening a cold NightPlayerSummary fans out several
-- reads through applicable_pull_mechanic_events. The applicability view was
-- resolving \"has this mechanic ever been observed in this boss+difficulty?\"
-- by joining/scanning the complete pull_mechanic_events history on every
-- read. pg_stat_statements showed the timing-pattern query alone being
-- executed tens of thousands of times and holding PostgREST connections long
-- enough for unrelated reads to fail with PGRST003 (pool acquisition timeout).
--
-- This migration is deliberately semantics-preserving:
--   * it does NOT change scoring, attribution, candidate policy or UI data;
--   * it materializes only the tiny observed identity key set used by the
--     existing EXISTS predicate, exactly per pull;
--   * applicable_boss_mechanics_candidates keeps the same predicate, replacing
--     only the repeated historical scan with an indexed key lookup;
--   * supporting indexes match the concrete dossier/infographic read paths.

create table if not exists public.pull_mechanic_observation_keys (
  pull_id uuid not null references public.pulls(id) on delete cascade,
  boss_id text not null,
  difficulty text not null,
  normalized_name text not null,
  event_count bigint not null check (event_count > 0),
  primary key (pull_id, normalized_name)
)","create index if not exists pull_mechanic_observation_keys_scope_idx
  on public.pull_mechanic_observation_keys (boss_id, difficulty, normalized_name)","comment on table public.pull_mechanic_observation_keys is
  ''Exact compact projection of observed pull_mechanic_events identities per pull. The scope index answers boss+difficulty+mechanic observation without rescanning the event history.''","comment on column public.pull_mechanic_observation_keys.event_count is
  ''Number of backing pull_mechanic_events for this pull+normalized mechanic. Recomputed for touched pulls after event mutations/replays.''","-- Initial exact projection.
insert into public.pull_mechanic_observation_keys (
  pull_id,
  boss_id,
  difficulty,
  normalized_name,
  event_count
)
select
  p.id,
  p.boss_id,
  p.difficulty,
  lower(btrim(e.mechanic_name)) as normalized_name,
  count(*)::bigint as event_count
from public.pull_mechanic_events e
join public.pulls p on p.id = e.pull_id
where e.mechanic_name is not null
group by p.id, p.boss_id, p.difficulty, lower(btrim(e.mechanic_name))
on conflict (pull_id, normalized_name)
do update set
  boss_id = excluded.boss_id,
  difficulty = excluded.difficulty,
  event_count = excluded.event_count","-- Recompute only touched pulls from canonical rows. This is intentionally
-- simpler than increment/decrement bookkeeping: replay does DELETE+INSERT in
-- one transaction, classification updates remain exact, and stale keys cannot
-- survive a rename/removal. pull_mechanic_events_pull_idx bounds this work to
-- the affected pull(s), never the full history.
create or replace function public.refresh_pull_mechanic_observation_keys(
  p_pull_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pull_ids is null or cardinality(p_pull_ids) = 0 then
    return;
  end if;

  delete from public.pull_mechanic_observation_keys
   where pull_id = any (p_pull_ids);

  insert into public.pull_mechanic_observation_keys (
    pull_id,
    boss_id,
    difficulty,
    normalized_name,
    event_count
  )
  select
    p.id,
    p.boss_id,
    p.difficulty,
    lower(btrim(e.mechanic_name)),
    count(*)::bigint
  from public.pull_mechanic_events e
  join public.pulls p on p.id = e.pull_id
  where e.pull_id = any (p_pull_ids)
    and e.mechanic_name is not null
  group by p.id, p.boss_id, p.difficulty, lower(btrim(e.mechanic_name));
end;
$$","create or replace function public.sync_pull_mechanic_observation_keys_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull_ids uuid[];
begin
  select array_agg(distinct pull_id) into v_pull_ids from new_rows;
  perform public.refresh_pull_mechanic_observation_keys(v_pull_ids);
  return null;
end;
$$","create or replace function public.sync_pull_mechanic_observation_keys_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull_ids uuid[];
begin
  select array_agg(distinct pull_id) into v_pull_ids from old_rows;
  perform public.refresh_pull_mechanic_observation_keys(v_pull_ids);
  return null;
end;
$$","create or replace function public.sync_pull_mechanic_observation_keys_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull_ids uuid[];
begin
  select array_agg(distinct pull_id)
    into v_pull_ids
    from (
      select pull_id from old_rows
      union
      select pull_id from new_rows
    ) touched;
  perform public.refresh_pull_mechanic_observation_keys(v_pull_ids);
  return null;
end;
$$","drop trigger if exists pull_mechanic_observation_keys_insert on public.pull_mechanic_events","create trigger pull_mechanic_observation_keys_insert
after insert on public.pull_mechanic_events
referencing new table as new_rows
for each statement execute function public.sync_pull_mechanic_observation_keys_insert()","drop trigger if exists pull_mechanic_observation_keys_delete on public.pull_mechanic_events","create trigger pull_mechanic_observation_keys_delete
after delete on public.pull_mechanic_events
referencing old table as old_rows
for each statement execute function public.sync_pull_mechanic_observation_keys_delete()","drop trigger if exists pull_mechanic_observation_keys_update on public.pull_mechanic_events","create trigger pull_mechanic_observation_keys_update
after update on public.pull_mechanic_events
referencing old table as old_rows new table as new_rows
for each statement execute function public.sync_pull_mechanic_observation_keys_update()","-- A pull''s boss/difficulty is identity and normally immutable, but keep the
-- compact projection correct if recovery tooling ever repairs that scope.
create or replace function public.sync_pull_mechanic_observation_keys_pull_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.pull_mechanic_observation_keys
     set boss_id = new.boss_id,
         difficulty = new.difficulty
   where pull_id = new.id;
  return new;
end;
$$","drop trigger if exists pull_mechanic_observation_keys_pull_update on public.pulls","create trigger pull_mechanic_observation_keys_pull_update
after update of boss_id, difficulty on public.pulls
for each row execute function public.sync_pull_mechanic_observation_keys_pull_update()","-- Exact same applicability contract as before. Only the historical
-- pull_mechanic_events EXISTS is replaced with the compact exact projection.
create or replace view public.applicable_boss_mechanics_candidates
with (security_invoker = true)
as
select candidate.*
from public.boss_mechanics_candidates candidate
where candidate.observed_in_logs is true
   or candidate.observed_in_reference_logs is true
   or candidate.observed_as_interrupt is true
   or coalesce(candidate.reference_occurrences, 0) > 0
   or exists (
     select 1
     from public.pull_mechanic_observation_keys observed
     where observed.boss_id = candidate.boss_id
       and observed.difficulty = candidate.difficulty
       and observed.normalized_name = lower(btrim(candidate.name))
   )
   or (
     candidate.official_difficulty_applicable is distinct from false
     and (
       candidate.reference_source_report is null
       or not exists (
         select 1
         from public.boss_mechanics_candidates other
         where other.boss_id = candidate.boss_id
           and other.ability_id = candidate.ability_id
           and other.difficulty <> candidate.difficulty
           and (
             other.observed_in_logs is true
             or other.observed_in_reference_logs is true
             or other.observed_as_interrupt is true
             or coalesce(other.reference_occurrences, 0) > 0
           )
           and case other.difficulty
                 when ''LFR'' then 1
                 when ''Normal'' then 3
                 when ''Heroic'' then 4
                 when ''Mythic'' then 5
                 else 0
               end
               > case candidate.difficulty
                   when ''LFR'' then 1
                   when ''Normal'' then 3
                   when ''Heroic'' then 4
                   when ''Mythic'' then 5
                   else 0
                 end
       )
     )
   )","-- Concrete read paths observed in the dossier/infographic.
create index if not exists player_pull_records_player_pull_idx
  on public.player_pull_records (player_name, pull_id)","create index if not exists pull_mechanic_events_ability_pull_time_idx
  on public.pull_mechanic_events (ability_id, pull_id, trigger_time_ms)","create index if not exists pull_mechanic_events_players_hit_names_gin_idx
  on public.pull_mechanic_events using gin (players_hit_names)","create index if not exists boss_mechanics_candidates_scope_normalized_name_idx
  on public.boss_mechanics_candidates (boss_id, difficulty, lower(btrim(name)))","-- Match the current source-table access contract: the existing mechanic
-- tables grant SELECT to anon/authenticated but RLS exposes rows only when
-- is_officer() is true. applicable_* are security_invoker views, so the helper
-- must preserve that distinction (RLS-filtered result, not permission error).
alter table public.pull_mechanic_observation_keys enable row level security","drop policy if exists \"pull_mechanic_observation_keys: officers read\"
  on public.pull_mechanic_observation_keys","create policy \"pull_mechanic_observation_keys: officers read\"
  on public.pull_mechanic_observation_keys
  for select
  to public
  using (is_officer())","revoke all on public.pull_mechanic_observation_keys from anon, authenticated","grant select on public.pull_mechanic_observation_keys to anon, authenticated, service_role","revoke all on function public.refresh_pull_mechanic_observation_keys(uuid[]) from public, anon, authenticated","revoke all on function public.sync_pull_mechanic_observation_keys_insert() from public, anon, authenticated","revoke all on function public.sync_pull_mechanic_observation_keys_delete() from public, anon, authenticated","revoke all on function public.sync_pull_mechanic_observation_keys_update() from public, anon, authenticated","revoke all on function public.sync_pull_mechanic_observation_keys_pull_update() from public, anon, authenticated","analyze public.pull_mechanic_observation_keys"}', 'dossier_read_path_performance', NULL, NULL, NULL),
	('20260907110000', '{"-- IRIS canonical defensives: production lifecycle + completeness invariants.
--
-- Root cause fixed here: the first published episode-evaluator@7 generation
-- was an empirical two-report corpus, while defensive_generation_pointer is
-- global. Nothing in the DB proved that a generation covered the full player
-- population later consumed by product. New reports therefore had valid V2
-- facts but zero canonical rows.
--
-- The invariant after this migration is executable, not documentary:
-- build, publication validation and frontend coverage use one eligibility
-- contract; published generations are immutable; refresh is copy-on-write;
-- and neither status nor pointer can be moved to an incomplete generation.

create or replace view canonical_defensive_eligible_player_pulls
with (security_invoker = true) as
select
  p.id as pull_id,
  p.report_code,
  p.fight_id,
  p.boss_id,
  p.difficulty,
  p.pull_number,
  r.player_name,
  r.game_build
from canonical_scored_pulls p
join player_pull_records r on r.pull_id = p.id
where r.game_build is not null
  and r.class is not null
  and r.spec is not null
  and jsonb_typeof(r.talent_build) = ''array''","comment on view canonical_defensive_eligible_player_pulls is
  ''Single canonical player/pull eligibility contract for the episode evaluator. A generation additionally filters by its exact game_build.''","revoke all on canonical_defensive_eligible_player_pulls from anon","grant select on canonical_defensive_eligible_player_pulls to authenticated","create or replace view published_defensive_expected_player_pulls
with (security_invoker = true) as
select
  e.pull_id,
  e.report_code,
  e.fight_id,
  e.boss_id,
  e.difficulty,
  e.pull_number,
  e.player_name,
  e.game_build,
  g.id as defensive_generation_id
from defensive_generation_pointer ptr
join defensive_generations g on g.id = ptr.published_generation_id
join canonical_defensive_eligible_player_pulls e on e.game_build = g.game_build
where ptr.id = true and g.status = ''published''","comment on view published_defensive_expected_player_pulls is
  ''Exact player/pull population expected from the currently published defensive generation.''","revoke all on published_defensive_expected_player_pulls from anon","grant select on published_defensive_expected_player_pulls to authenticated","create unique index if not exists defensive_generations_single_building_idx
  on defensive_generations ((status)) where status = ''building''","create unique index if not exists defensive_generations_single_published_idx
  on defensive_generations ((status)) where status = ''published''","create or replace function defensive_generation_expected_ledger_keys(p_generation_id uuid)
returns table (
  pull_id uuid,
  player_name text,
  deduplication_key text,
  event_family text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with generation as (
    select * from defensive_generations where id = p_generation_id
  ), safe_rows as (
    select s.*
    from player_pull_defensive_episode_evaluations s
    join generation g on true
    join canonical_defensive_eligible_player_pulls e
      on e.pull_id = s.pull_id
     and e.player_name = s.player_name
     and e.game_build = g.game_build
    where s.defensive_generation_id = g.id
      and s.episode_evaluator_version = g.evaluator_version
      and s.semantic_version = g.semantic_version
      and s.semantic_resolver_version = g.semantic_resolver_version
      and s.resolver_version = g.resolver_version
  ), episodes as (
    select s.pull_id, s.player_name, ep.value as episode
    from safe_rows s
    cross join lateral jsonb_array_elements(s.episodes) ep(value)
  )
  select
    pull_id,
    player_name,
    p_generation_id::text || '':'' || (episode ->> ''episodeId'') || '':'' || player_name || '':response'',
    ''response''::text
  from episodes
  where nullif(episode ->> ''episodeId'', '''') is not null
  union all
  select
    pull_id,
    player_name,
    p_generation_id::text || '':'' || (episode ->> ''episodeId'') || '':'' || player_name || '':plan:'' || (episode ->> ''planAssignmentId''),
    ''plan''::text
  from episodes
  where nullif(episode ->> ''episodeId'', '''') is not null
    and nullif(episode ->> ''planAssignmentId'', '''') is not null
    and nullif(episode ->> ''planVerdict'', '''') is not null;
$$","revoke all on function defensive_generation_expected_ledger_keys(uuid) from public, anon, authenticated","grant execute on function defensive_generation_expected_ledger_keys(uuid) to service_role","create or replace function defensive_generation_coverage(p_generation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  g defensive_generations%rowtype;
  expected_player_rows integer := 0;
  safe_staged_rows integer := 0;
  missing_player_rows integer := 0;
  extra_staged_rows integer := 0;
  version_drift_rows integer := 0;
  expected_pulls integer := 0;
  staged_pulls integer := 0;
  expected_ledger_events integer := 0;
  actual_ledger_events integer := 0;
  missing_ledger_events integer := 0;
  orphan_ledger_events integer := 0;
begin
  select * into g from defensive_generations where id = p_generation_id;
  if not found then raise exception ''Unknown defensive generation %'', p_generation_id; end if;
  if g.evaluator_version is null or g.episode_version is null then
    raise exception ''Generation % has no evaluator/episode version'', p_generation_id;
  end if;

  select count(*), count(distinct e.pull_id)
    into expected_player_rows, expected_pulls
  from canonical_defensive_eligible_player_pulls e
  where e.game_build = g.game_build;

  select count(*), count(distinct s.pull_id)
    into safe_staged_rows, staged_pulls
  from player_pull_defensive_episode_evaluations s
  join canonical_defensive_eligible_player_pulls e
    on e.pull_id = s.pull_id
   and e.player_name = s.player_name
   and e.game_build = g.game_build
  where s.defensive_generation_id = g.id
    and s.episode_evaluator_version = g.evaluator_version
    and s.semantic_version = g.semantic_version
    and s.semantic_resolver_version = g.semantic_resolver_version
    and s.resolver_version = g.resolver_version;

  select count(*) into missing_player_rows
  from canonical_defensive_eligible_player_pulls e
  where e.game_build = g.game_build
    and not exists (
      select 1 from player_pull_defensive_episode_evaluations s
      where s.defensive_generation_id = g.id
        and s.pull_id = e.pull_id
        and s.player_name = e.player_name
        and s.episode_evaluator_version = g.evaluator_version
        and s.semantic_version = g.semantic_version
        and s.semantic_resolver_version = g.semantic_resolver_version
        and s.resolver_version = g.resolver_version
    );

  select count(*) into extra_staged_rows
  from player_pull_defensive_episode_evaluations s
  where s.defensive_generation_id = g.id
    and not exists (
      select 1 from canonical_defensive_eligible_player_pulls e
      where e.pull_id = s.pull_id
        and e.player_name = s.player_name
        and e.game_build = g.game_build
    );

  select count(*) into version_drift_rows
  from player_pull_defensive_episode_evaluations s
  join canonical_defensive_eligible_player_pulls e
    on e.pull_id = s.pull_id
   and e.player_name = s.player_name
   and e.game_build = g.game_build
  where s.defensive_generation_id = g.id
    and (
      s.episode_evaluator_version is distinct from g.evaluator_version
      or s.semantic_version is distinct from g.semantic_version
      or s.semantic_resolver_version is distinct from g.semantic_resolver_version
      or s.resolver_version is distinct from g.resolver_version
    );

  select count(*) into expected_ledger_events
  from defensive_generation_expected_ledger_keys(g.id);

  select count(*) into actual_ledger_events
  from player_execution_events e
  where e.defensive_generation_id = g.id
    and e.domain = ''defensive''
    and (e.event_type like ''defensive_episode_%'' or e.event_type like ''defensive_plan_%'');

  select count(*) into missing_ledger_events
  from defensive_generation_expected_ledger_keys(g.id) k
  where not exists (
    select 1 from player_execution_events e
    where e.defensive_generation_id = g.id
      and e.pull_id = k.pull_id
      and e.player_name = k.player_name
      and e.deduplication_key = k.deduplication_key
  );

  select count(*) into orphan_ledger_events
  from player_execution_events e
  where e.defensive_generation_id = g.id
    and e.domain = ''defensive''
    and (e.event_type like ''defensive_episode_%'' or e.event_type like ''defensive_plan_%'')
    and not exists (
      select 1 from defensive_generation_expected_ledger_keys(g.id) k
      where k.pull_id = e.pull_id
        and k.player_name = e.player_name
        and k.deduplication_key = e.deduplication_key
    );

  return jsonb_build_object(
    ''generationId'', g.id,
    ''gameBuild'', g.game_build,
    ''expectedPulls'', expected_pulls,
    ''stagedPulls'', staged_pulls,
    ''expectedPlayerRows'', expected_player_rows,
    ''safeStagedRows'', safe_staged_rows,
    ''missingPlayerRows'', missing_player_rows,
    ''extraStagedRows'', extra_staged_rows,
    ''versionDriftRows'', version_drift_rows,
    ''expectedLedgerEvents'', expected_ledger_events,
    ''actualLedgerEvents'', actual_ledger_events,
    ''missingLedgerEvents'', missing_ledger_events,
    ''orphanLedgerEvents'', orphan_ledger_events,
    ''complete'',
      missing_player_rows = 0
      and extra_staged_rows = 0
      and version_drift_rows = 0
      and missing_ledger_events = 0
      and orphan_ledger_events = 0
      and expected_ledger_events = actual_ledger_events
  );
end;
$$","revoke all on function defensive_generation_coverage(uuid) from public, anon, authenticated","grant execute on function defensive_generation_coverage(uuid) to service_role","create or replace function assert_defensive_generation_complete(p_generation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare coverage jsonb;
begin
  coverage := defensive_generation_coverage(p_generation_id);
  if coalesce((coverage ->> ''complete'')::boolean, false) is not true then
    raise exception ''Defensive generation % is incomplete: %'', p_generation_id, coverage::text;
  end if;
  return coverage;
end;
$$","revoke all on function assert_defensive_generation_complete(uuid) from public, anon, authenticated","grant execute on function assert_defensive_generation_complete(uuid) to service_role","create or replace function begin_defensive_generation_refresh(
  p_game_build text,
  p_semantic_version text,
  p_resolver_version text,
  p_semantic_resolver_version text,
  p_episode_version text,
  p_evaluator_version text,
  p_report_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_id uuid;
  parent defensive_generations%rowtype;
  parent_id uuid;
  child_id uuid;
  bad_parent_keys integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext(''iris:defensive-generation-refresh''));

  select id into existing_id from defensive_generations where status = ''building'' limit 1;
  if existing_id is not null then
    if not exists (
      select 1 from defensive_generations g
      where g.id = existing_id
        and g.game_build = p_game_build
        and g.semantic_version = p_semantic_version
        and g.resolver_version = p_resolver_version
        and g.semantic_resolver_version = p_semantic_resolver_version
        and g.episode_version = p_episode_version
        and g.evaluator_version = p_evaluator_version
    ) then
      raise exception ''A different defensive generation is already building: %'', existing_id;
    end if;

    -- If a second request asks to refresh an already-cloned report while the
    -- same child is still building, force those rows back into the missing
    -- set. This makes concurrent/manual report refreshes deterministic.
    if p_report_code is not null then
      delete from player_execution_events pe
      where pe.defensive_generation_id = existing_id
        and pe.domain = ''defensive''
        and exists (
          select 1 from canonical_defensive_eligible_player_pulls x
          where x.pull_id = pe.pull_id
            and x.player_name = pe.player_name
            and x.report_code = p_report_code
            and x.game_build = p_game_build
        );
      delete from player_pull_defensive_episode_evaluations s
      where s.defensive_generation_id = existing_id
        and exists (
          select 1 from canonical_defensive_eligible_player_pulls x
          where x.pull_id = s.pull_id
            and x.player_name = s.player_name
            and x.report_code = p_report_code
            and x.game_build = p_game_build
        );
    end if;
    return existing_id;
  end if;

  select ptr.published_generation_id into parent_id
  from defensive_generation_pointer ptr where ptr.id = true for update;
  if parent_id is not null then
    select * into parent from defensive_generations where id = parent_id;
  end if;

  insert into defensive_generations (
    status, semantic_version, resolver_version, semantic_resolver_version,
    episode_version, evaluator_version, game_build, notes
  ) values (
    ''building'', p_semantic_version, p_resolver_version, p_semantic_resolver_version,
    p_episode_version, p_evaluator_version, p_game_build,
    jsonb_build_object(
      ''kind'', ''canonical_defensive_production_refresh'',
      ''startedAt'', now(),
      ''sourceReportCode'', p_report_code,
      ''parentGenerationId'', parent_id,
      ''contract'', jsonb_build_object(
        ''gameBuild'', p_game_build,
        ''semanticVersion'', p_semantic_version,
        ''resolverVersion'', p_resolver_version,
        ''semanticResolverVersion'', p_semantic_resolver_version,
        ''episodeVersion'', p_episode_version,
        ''evaluatorVersion'', p_evaluator_version
      )
    )::text
  ) returning id into child_id;

  if parent_id is not null
     and parent.status = ''published''
     and parent.game_build = p_game_build
     and parent.semantic_version = p_semantic_version
     and parent.resolver_version = p_resolver_version
     and parent.semantic_resolver_version = p_semantic_resolver_version
     and parent.episode_version = p_episode_version
     and parent.evaluator_version = p_evaluator_version then

    insert into player_pull_defensive_episode_evaluations (
      defensive_generation_id, pull_id, player_name, episode_evaluator_version,
      semantic_version, semantic_resolver_version, resolver_version,
      build_fingerprint, data_confidence, episodes, evaluated_at
    )
    select
      child_id, s.pull_id, s.player_name, s.episode_evaluator_version,
      s.semantic_version, s.semantic_resolver_version, s.resolver_version,
      s.build_fingerprint, s.data_confidence, s.episodes, s.evaluated_at
    from player_pull_defensive_episode_evaluations s
    join canonical_defensive_eligible_player_pulls e
      on e.pull_id = s.pull_id
     and e.player_name = s.player_name
     and e.game_build = p_game_build
    where s.defensive_generation_id = parent_id
      and s.episode_evaluator_version = p_evaluator_version
      and s.semantic_version = p_semantic_version
      and s.semantic_resolver_version = p_semantic_resolver_version
      and s.resolver_version = p_resolver_version
      and (p_report_code is null or e.report_code <> p_report_code);

    select count(*) into bad_parent_keys
    from player_execution_events e
    join canonical_defensive_eligible_player_pulls x
      on x.pull_id = e.pull_id
     and x.player_name = e.player_name
     and x.game_build = p_game_build
    where e.defensive_generation_id = parent_id
      and e.domain = ''defensive''
      and (p_report_code is null or x.report_code <> p_report_code)
      and e.deduplication_key not like parent_id::text || '':%'';
    if bad_parent_keys <> 0 then
      raise exception ''Published defensive ledger has % non-canonical dedupe keys; clone aborted'', bad_parent_keys;
    end if;

    insert into player_execution_events (
      pull_id, boss_id, difficulty, player_name, occurrence_id, causal_group_id,
      timestamp_ms, domain, event_type, verdict, reason_code, credit_eligible,
      penalty_eligible, primary_penalty, severity, priority, confidence, evidence,
      policy_version, context_resolver_version, occurrence_resolver_version,
      ledger_evaluator_version, deduplication_key, evaluated_at, defensive_generation_id
    )
    select
      e.pull_id, e.boss_id, e.difficulty, e.player_name, e.occurrence_id, e.causal_group_id,
      e.timestamp_ms, e.domain, e.event_type, e.verdict, e.reason_code, e.credit_eligible,
      e.penalty_eligible, e.primary_penalty, e.severity, e.priority, e.confidence, e.evidence,
      e.policy_version, e.context_resolver_version, e.occurrence_resolver_version,
      e.ledger_evaluator_version,
      child_id::text || substring(e.deduplication_key from length(parent_id::text) + 1),
      e.evaluated_at, child_id
    from player_execution_events e
    join canonical_defensive_eligible_player_pulls x
      on x.pull_id = e.pull_id
     and x.player_name = e.player_name
     and x.game_build = p_game_build
    where e.defensive_generation_id = parent_id
      and e.domain = ''defensive''
      and (p_report_code is null or x.report_code <> p_report_code);
  end if;

  return child_id;
end;
$$","revoke all on function begin_defensive_generation_refresh(text,text,text,text,text,text,text) from public, anon, authenticated","grant execute on function begin_defensive_generation_refresh(text,text,text,text,text,text,text) to service_role","create or replace function next_missing_defensive_generation_pull(p_generation_id uuid)
returns table (
  pull_id uuid,
  report_code text,
  fight_id integer,
  boss_id text,
  difficulty text,
  expected_player_rows integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with g as (
    select * from defensive_generations where id = p_generation_id and status = ''building''
  ), expected as (
    select e.* from canonical_defensive_eligible_player_pulls e join g on e.game_build = g.game_build
  ), per_pull as (
    select
      e.pull_id,
      min(e.report_code) as report_code,
      min(e.fight_id) as fight_id,
      min(e.boss_id) as boss_id,
      min(e.difficulty) as difficulty,
      count(*)::integer as expected_player_rows,
      count(s.pull_id) filter (
        where s.episode_evaluator_version = g.evaluator_version
          and s.semantic_version = g.semantic_version
          and s.semantic_resolver_version = g.semantic_resolver_version
          and s.resolver_version = g.resolver_version
      )::integer as safe_rows
    from expected e
    join g on true
    left join player_pull_defensive_episode_evaluations s
      on s.defensive_generation_id = g.id
     and s.pull_id = e.pull_id
     and s.player_name = e.player_name
    group by e.pull_id
  ), ledger_bad as (
    select distinct k.pull_id
    from defensive_generation_expected_ledger_keys(p_generation_id) k
    where not exists (
      select 1 from player_execution_events x
      where x.defensive_generation_id = p_generation_id
        and x.pull_id = k.pull_id
        and x.player_name = k.player_name
        and x.deduplication_key = k.deduplication_key
    )
  )
  select p.pull_id, p.report_code, p.fight_id, p.boss_id, p.difficulty, p.expected_player_rows
  from per_pull p
  left join ledger_bad l on l.pull_id = p.pull_id
  where p.safe_rows <> p.expected_player_rows or l.pull_id is not null
  order by p.report_code, p.fight_id, p.pull_id
  limit 1;
$$","revoke all on function next_missing_defensive_generation_pull(uuid) from public, anon, authenticated","grant execute on function next_missing_defensive_generation_pull(uuid) to service_role","create or replace function reset_building_defensive_generation_pull(p_generation_id uuid, p_pull_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from defensive_generations where id = p_generation_id and status = ''building'') then
    raise exception ''Generation % is not building'', p_generation_id;
  end if;
  delete from player_execution_events
  where defensive_generation_id = p_generation_id and pull_id = p_pull_id and domain = ''defensive'';
  delete from player_pull_defensive_episode_evaluations
  where defensive_generation_id = p_generation_id and pull_id = p_pull_id;
end;
$$","revoke all on function reset_building_defensive_generation_pull(uuid,uuid) from public, anon, authenticated","grant execute on function reset_building_defensive_generation_pull(uuid,uuid) to service_role","create or replace function publish_complete_defensive_generation(p_generation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare current_id uuid; coverage jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(''iris:defensive-generation-refresh''));
  select published_generation_id into current_id
  from defensive_generation_pointer where id = true for update;
  if not exists (
    select 1 from defensive_generations where id = p_generation_id and status in (''building'', ''ready'')
  ) then
    raise exception ''Generation % is not publishable from its current status'', p_generation_id;
  end if;
  coverage := assert_defensive_generation_complete(p_generation_id);
  update defensive_generations
  set status = ''superseded'', superseded_at = now()
  where id = current_id and current_id is distinct from p_generation_id;
  update defensive_generations
  set status = ''published'', ready_at = coalesce(ready_at, now()), published_at = coalesce(published_at, now())
  where id = p_generation_id;
  update defensive_generation_pointer
  set published_generation_id = p_generation_id, updated_at = now()
  where id = true;
  return coverage || jsonb_build_object(''published'', true, ''previousGenerationId'', current_id);
end;
$$","revoke all on function publish_complete_defensive_generation(uuid) from public, anon, authenticated","grant execute on function publish_complete_defensive_generation(uuid) to service_role","create or replace function guard_defensive_generation_publication()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = ''published'' and old.status is distinct from ''published'' then
    perform assert_defensive_generation_complete(new.id);
  end if;
  return new;
end;
$$","drop trigger if exists defensive_generation_publication_guard on defensive_generations","create trigger defensive_generation_publication_guard
before update of status on defensive_generations
for each row execute function guard_defensive_generation_publication()","create or replace function guard_defensive_generation_pointer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.published_generation_id is not null
     and new.published_generation_id is distinct from old.published_generation_id then
    if not exists (
      select 1 from defensive_generations where id = new.published_generation_id and status = ''published''
    ) then
      raise exception ''Pointer target % is not PUBLISHED'', new.published_generation_id;
    end if;
    perform assert_defensive_generation_complete(new.published_generation_id);
  end if;
  return new;
end;
$$","drop trigger if exists defensive_generation_pointer_guard on defensive_generation_pointer","create trigger defensive_generation_pointer_guard
before update of published_generation_id on defensive_generation_pointer
for each row execute function guard_defensive_generation_pointer()","create or replace function guard_defensive_generation_fact_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare gid uuid; state text;
begin
  if tg_op = ''DELETE'' then
    gid := old.defensive_generation_id;
  else
    gid := new.defensive_generation_id;
  end if;
  if gid is not null then
    select status into state from defensive_generations where id = gid;
    if state in (''ready'', ''published'', ''superseded'') then
      raise exception ''Defensive generation % is immutable in status %'', gid, state;
    end if;
  end if;
  if tg_op = ''DELETE'' then return old; else return new; end if;
end;
$$","drop trigger if exists defensive_episode_staging_immutability on player_pull_defensive_episode_evaluations","create trigger defensive_episode_staging_immutability
before insert or update or delete on player_pull_defensive_episode_evaluations
for each row execute function guard_defensive_generation_fact_mutation()","drop trigger if exists defensive_ledger_immutability on player_execution_events","create trigger defensive_ledger_immutability
before insert or update or delete on player_execution_events
for each row execute function guard_defensive_generation_fact_mutation()","-- Historical immutable generations remain in the ledger for audit, but product
-- summaries must expose only the singleton published defensive generation.
create or replace view player_pull_execution_summary_v3 as
select
  e.pull_id,
  e.boss_id,
  e.difficulty,
  e.player_name,
  e.ledger_evaluator_version,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = ''success'')::integer as success_count,
  count(*) filter (where e.verdict in (''failure'', ''missed''))::integer as failure_count,
  count(*) filter (where e.verdict = ''correct_hold'')::integer as correct_hold_count,
  count(*) filter (where e.verdict = ''uncertain'')::integer as uncertain_count,
  count(*) filter (where e.domain = ''mechanic'' and e.penalty_eligible)::integer as mechanic_failure_count,
  count(*) filter (where e.domain in (''defensive'', ''external'') and e.penalty_eligible)::integer as defensive_failure_count,
  count(*) filter (where e.domain = ''consumable'' and e.penalty_eligible)::integer as consumable_failure_count,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1 as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  e.defensive_generation_id,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'')::integer as defensive_episode_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.verdict = ''uncertain'')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'')::integer as defensive_plan_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
where e.defensive_generation_id is null
   or e.defensive_generation_id = (select published_generation_id from defensive_generation_pointer where id = true)
group by e.pull_id, e.boss_id, e.difficulty, e.player_name, e.ledger_evaluator_version, e.defensive_generation_id","create or replace view night_player_execution_summary_v3 as
select
  p.report_code,
  e.player_name,
  count(distinct e.pull_id)::integer as pull_count,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = ''uncertain'')::integer as uncertain_count,
  array_agg(distinct e.ledger_evaluator_version order by e.ledger_evaluator_version) as ledger_evaluator_versions,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.ledger_evaluator_version) = 1
    and count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1 as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  e.defensive_generation_id,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'')::integer as defensive_episode_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_episode_%'' and e.verdict = ''uncertain'')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'')::integer as defensive_plan_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like ''defensive_plan_%'' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
join pulls p on p.id = e.pull_id
where e.defensive_generation_id is null
   or e.defensive_generation_id = (select published_generation_id from defensive_generation_pointer where id = true)
group by p.report_code, e.player_name, e.defensive_generation_id","notify pgrst, ''reload schema''"}', 'defensive_generation_lifecycle_integrity', NULL, NULL, NULL),
	('20260907120000', '{"-- IRIS ninja-pull statistical population integrity.
--
-- Regression fixed here: PullEvaluationContext v3 intentionally converted a
-- strict detectNinjaPull result into `probable + evaluationEligible=true`,
-- while the previous production contract auto-excluded the same short/low-
-- progress fights. Because WCL only lists actors that actually engage a fight,
-- those accidental pulls gave different players different denominators.
--
-- Invariants after this migration:
-- 1) a heuristic candidate that satisfies the strict detector contract is an
--    invalid statistical pull (`confirmed`, heuristic source, not evaluable);
-- 2) the authoritative PullEvaluationContext always projects to legacy
--    pulls.is_ninja_pull / ninja_pull_excluded, so consumers cannot diverge;
-- 3) a manual ninja decision can never be overwritten by an automatic write;
-- 4) historical auto-candidates are repaired only when the CURRENT strict
--    signals still qualify and there is no manual audit entry.

create or replace function public.ninja_pull_auto_excludable(
  p_duration_ms integer,
  p_signals jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_duration integer := p_duration_ms;
  v_engaged_fraction numeric := null;
  v_boss_health_pct numeric := null;
begin
  if p_signals is not null and jsonb_typeof(p_signals) = ''object'' then
    if jsonb_typeof(p_signals -> ''durationMs'') = ''number'' then
      v_duration := (p_signals ->> ''durationMs'')::integer;
    end if;
    if jsonb_typeof(p_signals -> ''engagedFraction'') = ''number'' then
      v_engaged_fraction := (p_signals ->> ''engagedFraction'')::numeric;
    end if;
    if jsonb_typeof(p_signals -> ''bossHealthPct'') = ''number'' then
      v_boss_health_pct := (p_signals ->> ''bossHealthPct'')::numeric;
    end if;
  end if;

  -- Exact hard boundary used by detectNinjaPull. A detector result only
  -- exists for non-kills; the persisted signals are intentionally required
  -- for the two semantic checks so an old boolean alone can never exclude a
  -- pull retroactively.
  if v_duration is null or v_duration <= 0 or v_duration >= 45000 then
    return false;
  end if;

  return coalesce(v_engaged_fraction <= 0.30, false)
      or coalesce(v_boss_health_pct >= 90, false);
end;
$$","revoke all on function public.ninja_pull_auto_excludable(integer, jsonb) from public, anon, authenticated","grant execute on function public.ninja_pull_auto_excludable(integer, jsonb) to service_role","comment on function public.ninja_pull_auto_excludable(integer, jsonb) is
  ''Strict automatic invalid-pull policy: duration <45s and either engagedFraction <=0.30 or bossHealthPct >=90. Requires persisted evidence; is_ninja_pull alone is never enough.''","create or replace function public.normalize_pull_evaluation_ninja_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_duration integer;
  v_pull_signals jsonb;
  v_signals jsonb;
begin
  -- Manual is authoritative. An automatic reanalysis must fail loudly rather
  -- than silently reverting a raid-leader correction.
  if tg_op = ''UPDATE''
     and old.ninja_source = ''manual''
     and new.ninja_source <> ''manual'' then
    raise exception ''Automatic ninja decision cannot overwrite manual decision for pull %'', new.pull_id
      using errcode = ''55000'';
  end if;

  select p.duration_ms, p.ninja_pull_signals
    into v_duration, v_pull_signals
  from public.pulls p
  where p.id = new.pull_id;

  v_signals := coalesce(
    new.evidence #> ''{ninjaPullCandidate,evidence}'',
    new.evidence -> ''ninjaPullSignals'',
    v_pull_signals,
    ''{}''::jsonb
  );

  if new.ninja_source = ''heuristic''
     and new.ninja_status = ''probable''
     and public.ninja_pull_auto_excludable(v_duration, v_signals) then
    new.evaluation_eligible := false;
    new.evaluation_start_ms := 0;
    new.evaluation_end_ms := greatest(coalesce(v_duration, new.evaluation_end_ms, 0), 0);
    new.cutoff_reason := ''invalid_pull'';
    new.wipe_call_at_ms := null;
    new.wipe_call_boss_hp_pct := null;
    new.wipe_call_source := ''none'';
    new.wipe_call_confidence := null;
    new.wipe_call_verified := false;
    new.ninja_status := ''confirmed'';
    -- Keep source=heuristic: `confirmed` describes statistical authority;
    -- source tells us it was automatic and therefore remains reversible.
    new.evidence := jsonb_set(
      coalesce(new.evidence, ''{}''::jsonb),
      ''{autoNinjaPolicy}'',
      jsonb_build_object(
        ''version'', ''ninja-auto-exclusion@1'',
        ''applied'', true,
        ''signals'', v_signals
      ),
      true
    );
  end if;

  return new;
end;
$$","revoke all on function public.normalize_pull_evaluation_ninja_policy() from public, anon, authenticated","drop trigger if exists pull_evaluation_context_normalize_ninja_policy on public.pull_evaluation_context","create trigger pull_evaluation_context_normalize_ninja_policy
before insert or update on public.pull_evaluation_context
for each row execute function public.normalize_pull_evaluation_ninja_policy()","-- PullEvaluationContext is the authority; legacy flags are projections. This
-- trigger also makes direct/old write paths unable to diverge after context
-- exists. It deliberately runs only when either legacy ninja flag is being
-- written, which is the path used by set_pull_evaluation_context_v2.
create or replace function public.enforce_pull_ninja_projection_from_context()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_context public.pull_evaluation_context%rowtype;
begin
  select * into v_context
  from public.pull_evaluation_context c
  where c.pull_id = new.id;

  if found then
    new.is_ninja_pull := v_context.ninja_status in (''probable'', ''confirmed'');
    new.ninja_pull_excluded := (not v_context.evaluation_eligible)
      or v_context.ninja_status = ''confirmed'';
  end if;

  return new;
end;
$$","revoke all on function public.enforce_pull_ninja_projection_from_context() from public, anon, authenticated","drop trigger if exists pulls_enforce_ninja_context_projection on public.pulls","create trigger pulls_enforce_ninja_context_projection
before update of is_ninja_pull, ninja_pull_excluded on public.pulls
for each row execute function public.enforce_pull_ninja_projection_from_context()","-- Repair historical v3 regressions through the official audited RPC instead
-- of mutating the two authorities independently. We deliberately DO NOT use
-- `is_ninja_pull=true` as evidence. The candidate has to satisfy today''s
-- strict signal contract, and any recorded manual decision protects the row.
do $$
declare
  r public.pull_evaluation_context%rowtype;
  v_signals jsonb;
begin
  for r in
    select c.*
    from public.pull_evaluation_context c
    join public.pulls p on p.id = c.pull_id
    where c.ninja_source = ''heuristic''
      and c.ninja_status = ''probable''
      and c.evaluation_eligible = true
      and public.ninja_pull_auto_excludable(
        p.duration_ms,
        coalesce(
          c.evidence #> ''{ninjaPullCandidate,evidence}'',
          c.evidence -> ''ninjaPullSignals'',
          p.ninja_pull_signals,
          ''{}''::jsonb
        )
      )
      and not exists (
        select 1
        from public.pull_evaluation_context_audit a
        where a.pull_id = c.pull_id
          and a.change_source = ''manual_rl''
      )
  loop
    perform public.set_pull_evaluation_context_v2(
      r.pull_id,
      r.evaluation_eligible,
      r.evaluation_start_ms,
      r.evaluation_end_ms,
      r.cutoff_reason,
      r.wipe_call_at_ms,
      r.wipe_call_boss_hp_pct,
      r.wipe_call_source,
      r.wipe_call_confidence,
      r.wipe_call_verified,
      r.ninja_status,
      r.ninja_source,
      r.ninja_confidence,
      r.evidence,
      ''pull-evaluation-context@1.0.0:commands-v3'',
      ''Migración: candidato ninja estricto autoexcluido de la población estadística.'',
      null
    );
  end loop;

  if exists (
    select 1
    from public.pull_evaluation_context c
    join public.pulls p on p.id = c.pull_id
    where c.ninja_source = ''heuristic''
      and c.ninja_status = ''probable''
      and c.evaluation_eligible = true
      and public.ninja_pull_auto_excludable(
        p.duration_ms,
        coalesce(
          c.evidence #> ''{ninjaPullCandidate,evidence}'',
          c.evidence -> ''ninjaPullSignals'',
          p.ninja_pull_signals,
          ''{}''::jsonb
        )
      )
      and not exists (
        select 1
        from public.pull_evaluation_context_audit a
        where a.pull_id = c.pull_id
          and a.change_source = ''manual_rl''
      )
  ) then
    raise exception ''Ninja population backfill left auto-excludable probable pulls behind'';
  end if;
end;
$$","comment on trigger pull_evaluation_context_normalize_ninja_policy on public.pull_evaluation_context is
  ''Auto-confirms strict heuristic ninja candidates while refusing automatic overwrites of manual ninja decisions.''","comment on trigger pulls_enforce_ninja_context_projection on public.pulls is
  ''Makes legacy ninja flags a projection of authoritative pull_evaluation_context whenever they are written.''"}', 'ninja_pull_statistical_population_integrity', NULL, NULL, NULL),
	('20260908210000', '{"-- IRIS defensive identity hotfix · 2026-09-08
--
-- Root cause (verified against production data + WCL-facing persistence):
-- 20260823110000 treated Paladin Divine Protection spellIds 498 and 403876 as
-- duplicate rows and deleted 403876. That assumption is unsafe for combat-log
-- identity: Holy uses 498 while Retribution is observed under 403876. All
-- defensive evaluators intentionally key casts/buffs by exact spellId, so the
-- collapsed row made Retribution casts disappear and could turn real uses into
-- false available_unused / missed_ready verdicts.
--
-- Do NOT model the two ids as two simultaneously available cooldowns. They are
-- the same named defensive with mutually exclusive spec-scoped runtime
-- identities. This migration restores that invariant at the existing canonical
-- source of truth (cooldown_catalog + semantics/rules), so analyze-report,
-- reanalyze-defensive-pressure and canonical-defensive-refresh all consume the
-- fix without adding a parallel spell-id mapping mechanism.

-- 1) The existing 498 row becomes Holy-only.
do $$
begin
  if not exists (
    select 1 from cooldown_catalog
    where class = ''Paladin'' and spell_id = 498 and excluded = false
  ) then
    raise exception ''Cannot split Divine Protection runtime identity: Paladin spellId 498 is missing'';
  end if;
end $$","update cooldown_catalog
set
  spec = ''Holy'',
  spec_override = array[''Holy'']::text[],
  updated_at = now()
where class = ''Paladin''
  and spell_id = 498","-- 2) Restore the Retribution runtime identity by cloning the curated factual
-- fields from 498. The spec scope is deliberately disjoint, so no player can
-- receive both entries from specApplies().
insert into cooldown_catalog (
  class,
  spec,
  spell_id,
  name,
  category,
  synced_from_commit,
  synced_at,
  base_cooldown_ms,
  base_duration_ms,
  survival_type,
  inferred_survival_type,
  ai_classification,
  reviewed,
  spec_override,
  excluded,
  targeting_mode,
  activation_mode,
  passive_conversion_spell_ids,
  activation_game_build,
  updated_at
)
select
  class,
  ''Retribution'',
  403876,
  name,
  category,
  synced_from_commit,
  synced_at,
  base_cooldown_ms,
  base_duration_ms,
  survival_type,
  inferred_survival_type,
  ai_classification,
  true,
  array[''Retribution'']::text[],
  false,
  targeting_mode,
  activation_mode,
  passive_conversion_spell_ids,
  activation_game_build,
  now()
from cooldown_catalog
where class = ''Paladin''
  and spell_id = 498
on conflict (class, spell_id) do update
set
  spec = excluded.spec,
  name = excluded.name,
  category = excluded.category,
  base_cooldown_ms = excluded.base_cooldown_ms,
  base_duration_ms = excluded.base_duration_ms,
  survival_type = excluded.survival_type,
  inferred_survival_type = excluded.inferred_survival_type,
  ai_classification = excluded.ai_classification,
  reviewed = true,
  spec_override = excluded.spec_override,
  excluded = false,
  targeting_mode = excluded.targeting_mode,
  activation_mode = excluded.activation_mode,
  passive_conversion_spell_ids = excluded.passive_conversion_spell_ids,
  activation_game_build = excluded.activation_game_build,
  updated_at = now()","-- 3) Clone the verified semantic contract to the new catalog identity. Semantics
-- are attached to catalog_id, not name, so without this the runtime cast would
-- be visible but canonical Usage/Response would correctly fail closed instead
-- of scoring it.
insert into defensive_ability_semantics (
  catalog_id,
  usage_role,
  activation_scope,
  secondary_propagation,
  mechanisms,
  opportunity_mode,
  semantic_status,
  semantic_version,
  confidence,
  locked,
  source,
  reviewed_at,
  updated_at,
  primary_beneficiary,
  defensive_intent,
  applicability,
  applicability_confidence,
  spec_semantic_profiles
)
select
  ret.id,
  sem.usage_role,
  sem.activation_scope,
  sem.secondary_propagation,
  sem.mechanisms,
  sem.opportunity_mode,
  sem.semantic_status,
  sem.semantic_version,
  sem.confidence,
  sem.locked,
  concat_ws('' | '', sem.source, ''runtime identity split 498->403876 (Retribution, 2026-09-08)''),
  coalesce(sem.reviewed_at, now()),
  now(),
  sem.primary_beneficiary,
  sem.defensive_intent,
  sem.applicability,
  sem.applicability_confidence,
  sem.spec_semantic_profiles
from cooldown_catalog holy
join defensive_ability_semantics sem on sem.catalog_id = holy.id
join cooldown_catalog ret
  on ret.class = holy.class
 and ret.spell_id = 403876
where holy.class = ''Paladin''
  and holy.spell_id = 498
on conflict (catalog_id) do update
set
  usage_role = excluded.usage_role,
  activation_scope = excluded.activation_scope,
  secondary_propagation = excluded.secondary_propagation,
  mechanisms = excluded.mechanisms,
  opportunity_mode = excluded.opportunity_mode,
  semantic_status = excluded.semantic_status,
  semantic_version = excluded.semantic_version,
  confidence = excluded.confidence,
  locked = excluded.locked,
  source = excluded.source,
  reviewed_at = excluded.reviewed_at,
  updated_at = now(),
  primary_beneficiary = excluded.primary_beneficiary,
  defensive_intent = excluded.defensive_intent,
  applicability = excluded.applicability,
  applicability_confidence = excluded.applicability_confidence,
  spec_semantic_profiles = excluded.spec_semantic_profiles","-- 4) Semantic rules are spellId-addressed too. Split every rule that currently
-- targets 498 and applies to Retribution. Mixed Holy/Retribution rules keep the
-- Holy half on 498 and receive a Retribution copy on 403876; Ret-only rules are
-- retargeted in place. Protection-only replacement semantics remain untouched.
insert into defensive_semantic_rules (
  modifier_spell_id,
  target_spell_id,
  specs,
  game_build,
  rule_type,
  payload,
  source,
  verified,
  updated_at
)
select
  modifier_spell_id,
  403876,
  array[''Retribution'']::text[],
  game_build,
  rule_type,
  payload,
  source,
  verified,
  now()
from defensive_semantic_rules
where target_spell_id = 498
  and ''Retribution'' = any(specs)
  and cardinality(specs) > 1
on conflict (modifier_spell_id, target_spell_id, game_build, rule_type) do update
set
  specs = excluded.specs,
  payload = excluded.payload,
  source = excluded.source,
  verified = excluded.verified,
  updated_at = now()","update defensive_semantic_rules
set
  target_spell_id = 403876,
  updated_at = now()
where target_spell_id = 498
  and ''Retribution'' = any(specs)
  and cardinality(specs) = 1","update defensive_semantic_rules
set
  specs = array_remove(specs, ''Retribution''),
  updated_at = now()
where target_spell_id = 498
  and ''Retribution'' = any(specs)
  and cardinality(specs) > 1","-- 5) Timing modifier rules use the same targetSpellId contract. There is an
-- inactive shared Paladin rule today; splitting it now prevents a future
-- reactivation/resync from silently applying only to Holy.
insert into defensive_modifier_rules (
  class,
  specs,
  modifier_spell_id,
  target_spell_id,
  operation,
  value,
  per_rank,
  condition,
  description,
  source,
  verified_at,
  active,
  updated_at,
  game_build,
  effect_field,
  application_order,
  presence_mode
)
select
  class,
  array[''Retribution'']::text[],
  modifier_spell_id,
  403876,
  operation,
  value,
  per_rank,
  condition,
  description,
  source,
  verified_at,
  active,
  now(),
  game_build,
  effect_field,
  application_order,
  presence_mode
from defensive_modifier_rules
where class = ''Paladin''
  and target_spell_id = 498
  and ''Retribution'' = any(coalesce(specs, ''{}''::text[]))
  and cardinality(coalesce(specs, ''{}''::text[])) > 1
on conflict (class, modifier_spell_id, target_spell_id, operation, effect_field, game_build) do update
set
  specs = excluded.specs,
  value = excluded.value,
  per_rank = excluded.per_rank,
  condition = excluded.condition,
  description = excluded.description,
  source = excluded.source,
  verified_at = excluded.verified_at,
  active = excluded.active,
  updated_at = now(),
  application_order = excluded.application_order,
  presence_mode = excluded.presence_mode","update defensive_modifier_rules
set
  target_spell_id = 403876,
  updated_at = now()
where class = ''Paladin''
  and target_spell_id = 498
  and ''Retribution'' = any(coalesce(specs, ''{}''::text[]))
  and cardinality(coalesce(specs, ''{}''::text[])) = 1","update defensive_modifier_rules
set
  specs = array_remove(specs, ''Retribution''),
  updated_at = now()
where class = ''Paladin''
  and target_spell_id = 498
  and ''Retribution'' = any(coalesce(specs, ''{}''::text[]))
  and cardinality(coalesce(specs, ''{}''::text[])) > 1","-- 6) Executable migration invariants. If a future schema/data change makes
-- this split unsafe, abort rather than publishing a half-fixed catalog that
-- can create player-facing false penalties.
do $$
declare
  holy_semantics integer;
  ret_semantics integer;
begin
  if not exists (
    select 1 from cooldown_catalog
    where class = ''Paladin''
      and spell_id = 498
      and excluded = false
      and spec = ''Holy''
      and spec_override = array[''Holy'']::text[]
  ) then
    raise exception ''Divine Protection invariant failed: 498 is not Holy-only'';
  end if;

  if not exists (
    select 1 from cooldown_catalog
    where class = ''Paladin''
      and spell_id = 403876
      and excluded = false
      and spec = ''Retribution''
      and spec_override = array[''Retribution'']::text[]
  ) then
    raise exception ''Divine Protection invariant failed: 403876 is not Retribution-only'';
  end if;

  if exists (
    select 1 from cooldown_catalog
    where class = ''Paladin''
      and spell_id = 498
      and ''Retribution'' = any(coalesce(spec_override, ''{}''::text[]))
  ) then
    raise exception ''Divine Protection invariant failed: Retribution still resolves 498'';
  end if;

  if exists (
    select 1 from cooldown_catalog
    where class = ''Paladin''
      and spell_id = 403876
      and ''Holy'' = any(coalesce(spec_override, ''{}''::text[]))
  ) then
    raise exception ''Divine Protection invariant failed: Holy resolves 403876'';
  end if;

  select count(*) into holy_semantics
  from defensive_ability_semantics sem
  join cooldown_catalog cc on cc.id = sem.catalog_id
  where cc.class = ''Paladin''
    and cc.spell_id = 498
    and sem.semantic_status = ''verified''
    and sem.usage_role = ''personal_survival''
    and sem.activation_scope = ''self''
    and sem.opportunity_mode = ''normal''
    and ''mitigation'' = any(sem.mechanisms);

  select count(*) into ret_semantics
  from defensive_ability_semantics sem
  join cooldown_catalog cc on cc.id = sem.catalog_id
  where cc.class = ''Paladin''
    and cc.spell_id = 403876
    and sem.semantic_status = ''verified''
    and sem.usage_role = ''personal_survival''
    and sem.activation_scope = ''self''
    and sem.opportunity_mode = ''normal''
    and ''mitigation'' = any(sem.mechanisms);

  if holy_semantics <> 1 or ret_semantics <> 1 then
    raise exception ''Divine Protection invariant failed: verified semantic rows Holy=%, Ret=%'', holy_semantics, ret_semantics;
  end if;

  if exists (
    select 1 from defensive_semantic_rules
    where target_spell_id = 498
      and ''Retribution'' = any(specs)
  ) then
    raise exception ''Divine Protection invariant failed: a Retribution semantic rule still targets 498'';
  end if;

  if exists (
    select 1 from defensive_modifier_rules
    where class = ''Paladin''
      and target_spell_id = 498
      and ''Retribution'' = any(coalesce(specs, ''{}''::text[]))
  ) then
    raise exception ''Divine Protection invariant failed: a Retribution timing rule still targets 498'';
  end if;
end $$","comment on column cooldown_catalog.spec_override is
  ''Manual spec applicability override. Runtime spell identities that share a display name must remain separate when WCL uses different spellIds per spec (e.g. Divine Protection: Holy 498, Retribution 403876).''"}', 'fix_paladin_divine_protection_runtime_identity', NULL, NULL, NULL),
	('20260908061917', '{"-- Durable automatic refresh of the published canonical defensive generation.
--
-- The v3 player infographic reads only the published canonical generation.
-- A newly imported report therefore needs a copy-on-write refresh after its
-- final encounter is ingested; otherwise V2/player_pull_records can be valid
-- while canonical episode rows are still zero.
--
-- Invariants:
-- - completion is based on report_encounters + last_processed_fight_id, never
--   reports.is_raid (manual raid imports can legitimately have is_raid=false);
-- - one idempotent request per report_code;
-- - one global renewable lease serializes the global BUILDING generation;
-- - retries are durable/bounded and failures become visible as blocked;
-- - dispatcher auth uses a DB-generated token that is never committed;
-- - pg_net wake-up failure never fails report ingestion: the request stays
--   pending and can be resumed by the next wake-up/manual start;
-- - publication completeness remains enforced by the existing generation
--   lifecycle guards introduced in 20260907110000.

create table if not exists canonical_defensive_refresh_requests (
  report_code text primary key references reports(code) on delete cascade,
  status text not null default ''pending''
    check (status in (''pending'', ''running'', ''completed'', ''blocked'')),
  requested_at timestamptz not null default now(),
  not_before timestamptz not null default now(),
  attempts smallint not null default 0 check (attempts >= 0 and attempts <= 100),
  generation_id uuid references defensive_generations(id),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists canonical_defensive_refresh_requests_claim_idx
  on canonical_defensive_refresh_requests (status, not_before, requested_at);

alter table canonical_defensive_refresh_requests enable row level security;
revoke all on canonical_defensive_refresh_requests from anon, authenticated;

create table if not exists canonical_defensive_refresh_dispatch_runtime (
  id boolean primary key default true check (id),
  dispatch_token uuid not null default gen_random_uuid(),
  function_url text,
  lease_token uuid,
  lease_report_code text references reports(code) on delete set null,
  lease_generation_id uuid references defensive_generations(id),
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into canonical_defensive_refresh_dispatch_runtime (id)
values (true)
on conflict (id) do nothing;

alter table canonical_defensive_refresh_dispatch_runtime enable row level security;
revoke all on canonical_defensive_refresh_dispatch_runtime from anon, authenticated;

create or replace function canonical_defensive_report_ingestion_complete(p_report_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select
      r.last_processed_fight_id is not null
      and max(e.fight_id) is not null
      and r.last_processed_fight_id >= max(e.fight_id)
    from reports r
    left join report_encounters e on e.report_code = r.code
    where r.code = p_report_code
    group by r.last_processed_fight_id
  ), false);
$$;
revoke all on function canonical_defensive_report_ingestion_complete(text) from public, anon, authenticated;
grant execute on function canonical_defensive_report_ingestion_complete(text) to service_role;

create or replace function canonical_defensive_report_needs_refresh(p_report_code text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  eligible_rows integer := 0;
  published_expected_rows integer := 0;
  published_generation_id uuid;
begin
  if not canonical_defensive_report_ingestion_complete(p_report_code) then
    return false;
  end if;

  select count(*) into eligible_rows
  from canonical_defensive_eligible_player_pulls e
  where e.report_code = p_report_code;

  if eligible_rows = 0 then
    return false;
  end if;

  select ptr.published_generation_id into published_generation_id
  from defensive_generation_pointer ptr
  where ptr.id = true;

  if published_generation_id is null then
    return true;
  end if;

  select count(*) into published_expected_rows
  from published_defensive_expected_player_pulls e
  where e.report_code = p_report_code;

  if published_expected_rows <> eligible_rows then
    return true;
  end if;

  return exists (
    select 1
    from published_defensive_expected_player_pulls e
    join defensive_generations g on g.id = e.defensive_generation_id
    left join player_pull_defensive_episode_evaluations s
      on s.defensive_generation_id = e.defensive_generation_id
     and s.pull_id = e.pull_id
     and s.player_name = e.player_name
     and s.episode_evaluator_version = g.evaluator_version
     and s.semantic_version = g.semantic_version
     and s.semantic_resolver_version = g.semantic_resolver_version
     and s.resolver_version = g.resolver_version
    where e.report_code = p_report_code
      and s.pull_id is null
  );
end;
$$;
revoke all on function canonical_defensive_report_needs_refresh(text) from public, anon, authenticated;
grant execute on function canonical_defensive_report_needs_refresh(text) to service_role;

create or replace function enqueue_canonical_defensive_refresh(p_report_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not canonical_defensive_report_needs_refresh(p_report_code) then
    return false;
  end if;

  insert into canonical_defensive_refresh_requests (
    report_code, status, requested_at, not_before, attempts,
    generation_id, lease_token, lease_expires_at, last_error,
    completed_at, updated_at
  ) values (
    p_report_code, ''pending'', now(), now(), 0,
    null, null, null, null, null, now()
  )
  on conflict (report_code) do update
  set requested_at = excluded.requested_at,
      not_before = now(),
      status = case
        when canonical_defensive_refresh_requests.status = ''running''
         and canonical_defensive_refresh_requests.lease_expires_at > now()
          then ''running''
        else ''pending''
      end,
      attempts = case
        when canonical_defensive_refresh_requests.status = ''blocked'' then 0
        else canonical_defensive_refresh_requests.attempts
      end,
      generation_id = case
        when canonical_defensive_refresh_requests.status = ''running''
         and canonical_defensive_refresh_requests.lease_expires_at > now()
          then canonical_defensive_refresh_requests.generation_id
        else null
      end,
      lease_token = case
        when canonical_defensive_refresh_requests.status = ''running''
         and canonical_defensive_refresh_requests.lease_expires_at > now()
          then canonical_defensive_refresh_requests.lease_token
        else null
      end,
      lease_expires_at = case
        when canonical_defensive_refresh_requests.status = ''running''
         and canonical_defensive_refresh_requests.lease_expires_at > now()
          then canonical_defensive_refresh_requests.lease_expires_at
        else null
      end,
      last_error = null,
      completed_at = null,
      updated_at = now();

  return true;
end;
$$;
revoke all on function enqueue_canonical_defensive_refresh(text) from public, anon, authenticated;
grant execute on function enqueue_canonical_defensive_refresh(text) to service_role;

create or replace function remember_canonical_defensive_dispatch_url_from_request()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  headers jsonb := ''{}''::jsonb;
  host text;
  discovered_url text;
  current_url text;
begin
  begin
    headers := coalesce(nullif(current_setting(''request.headers'', true), '''')::jsonb, ''{}''::jsonb);
  exception when others then
    headers := ''{}''::jsonb;
  end;

  host := lower(split_part(coalesce(headers ->> ''x-forwarded-host'', headers ->> ''host'', ''''), '':'', 1));
  if host ~ ''^[a-z0-9-]+\\.supabase\\.co$'' then
    discovered_url := ''https://'' || host || ''/functions/v1/canonical-defensive-auto-refresh'';
    update canonical_defensive_refresh_dispatch_runtime
    set function_url = discovered_url,
        updated_at = now()
    where id = true
      and function_url is distinct from discovered_url;
  end if;

  select function_url into current_url
  from canonical_defensive_refresh_dispatch_runtime
  where id = true;
  return current_url;
end;
$$;
revoke all on function remember_canonical_defensive_dispatch_url_from_request() from public, anon, authenticated;
grant execute on function remember_canonical_defensive_dispatch_url_from_request() to service_role;

create or replace function dispatch_canonical_defensive_refresh_async()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, net, pg_temp
as $$
declare
  target_url text;
  token uuid;
begin
  target_url := remember_canonical_defensive_dispatch_url_from_request();
  select dispatch_token into token
  from canonical_defensive_refresh_dispatch_runtime
  where id = true;

  if target_url is null or token is null then
    return false;
  end if;

  perform net.http_post(
    url := target_url,
    body := jsonb_build_object(''action'', ''drain''),
    headers := jsonb_build_object(
      ''content-type'', ''application/json'',
      ''x-iris-dispatch-token'', token::text
    ),
    timeout_milliseconds := 5000
  );
  return true;
exception when others then
  return false;
end;
$$;
revoke all on function dispatch_canonical_defensive_refresh_async() from public, anon, authenticated;
grant execute on function dispatch_canonical_defensive_refresh_async() to service_role;

create or replace function maybe_enqueue_canonical_defensive_refresh(p_report_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare enqueued boolean;
begin
  enqueued := enqueue_canonical_defensive_refresh(p_report_code);
  if enqueued then
    perform dispatch_canonical_defensive_refresh_async();
  end if;
  return enqueued;
end;
$$;
revoke all on function maybe_enqueue_canonical_defensive_refresh(text) from public, anon, authenticated;
grant execute on function maybe_enqueue_canonical_defensive_refresh(text) to service_role;

create or replace function trigger_canonical_defensive_refresh_from_report()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.last_processed_fight_id is not null then
    perform maybe_enqueue_canonical_defensive_refresh(new.code);
  end if;
  return new;
end;
$$;

create or replace function trigger_canonical_defensive_refresh_from_encounter()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform maybe_enqueue_canonical_defensive_refresh(new.report_code);
  return new;
end;
$$;

drop trigger if exists reports_canonical_defensive_auto_refresh on reports;
create trigger reports_canonical_defensive_auto_refresh
after insert or update of last_processed_fight_id on reports
for each row execute function trigger_canonical_defensive_refresh_from_report();

drop trigger if exists report_encounters_canonical_defensive_auto_refresh on report_encounters;
create trigger report_encounters_canonical_defensive_auto_refresh
after insert or update of fight_id on report_encounters
for each row execute function trigger_canonical_defensive_refresh_from_encounter();

create or replace function claim_canonical_defensive_refresh_request()
returns table (report_code text, lease_token uuid, attempt smallint)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  runtime canonical_defensive_refresh_dispatch_runtime%rowtype;
  selected canonical_defensive_refresh_requests%rowtype;
  new_token uuid;
begin
  perform pg_advisory_xact_lock(hashtext(''iris:canonical-defensive-auto-refresh:claim''));

  select * into runtime
  from canonical_defensive_refresh_dispatch_runtime
  where id = true
  for update;

  if runtime.lease_token is not null and runtime.lease_expires_at <= now() then
    update canonical_defensive_refresh_requests
    set status = ''pending'',
        lease_token = null,
        lease_expires_at = null,
        generation_id = null,
        not_before = now(),
        updated_at = now()
    where status = ''running''
      and lease_token = runtime.lease_token;

    update canonical_defensive_refresh_dispatch_runtime
    set lease_token = null,
        lease_report_code = null,
        lease_generation_id = null,
        lease_expires_at = null,
        updated_at = now()
    where id = true;

    runtime.lease_token := null;
    runtime.lease_expires_at := null;
  end if;

  if runtime.lease_token is not null and runtime.lease_expires_at > now() then
    return;
  end if;

  update canonical_defensive_refresh_requests q
  set status = ''completed'',
      completed_at = coalesce(q.completed_at, now()),
      lease_token = null,
      lease_expires_at = null,
      last_error = null,
      updated_at = now()
  where q.status in (''pending'', ''running'')
    and not canonical_defensive_report_needs_refresh(q.report_code);

  select q.* into selected
  from canonical_defensive_refresh_requests q
  where q.status = ''pending''
    and q.not_before <= now()
    and canonical_defensive_report_needs_refresh(q.report_code)
  order by q.requested_at, q.report_code
  for update skip locked
  limit 1;

  if not found then return; end if;

  new_token := gen_random_uuid();
  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = new_token,
      lease_report_code = selected.report_code,
      lease_generation_id = null,
      lease_expires_at = now() + interval ''5 minutes'',
      updated_at = now()
  where id = true;

  update canonical_defensive_refresh_requests q
  set status = ''running'',
      attempts = q.attempts + 1,
      lease_token = new_token,
      lease_expires_at = now() + interval ''5 minutes'',
      last_error = null,
      updated_at = now()
  where q.report_code = selected.report_code;

  return query
  select selected.report_code, new_token, (selected.attempts + 1)::smallint;
end;
$$;
revoke all on function claim_canonical_defensive_refresh_request() from public, anon, authenticated;
grant execute on function claim_canonical_defensive_refresh_request() to service_role;

create or replace function bind_canonical_defensive_refresh_generation(
  p_report_code text,
  p_lease_token uuid,
  p_generation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare changed integer;
begin
  update canonical_defensive_refresh_dispatch_runtime
  set lease_generation_id = p_generation_id,
      lease_expires_at = now() + interval ''5 minutes'',
      updated_at = now()
  where id = true
    and lease_token = p_lease_token
    and lease_report_code = p_report_code
    and lease_expires_at > now();
  get diagnostics changed = row_count;
  if changed = 0 then return false; end if;

  update canonical_defensive_refresh_requests
  set generation_id = p_generation_id,
      lease_expires_at = now() + interval ''5 minutes'',
      updated_at = now()
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = ''running'';
  return found;
end;
$$;
revoke all on function bind_canonical_defensive_refresh_generation(text, uuid, uuid) from public, anon, authenticated;
grant execute on function bind_canonical_defensive_refresh_generation(text, uuid, uuid) to service_role;

create or replace function renew_canonical_defensive_refresh_lease(
  p_report_code text,
  p_lease_token uuid,
  p_generation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare changed integer;
begin
  update canonical_defensive_refresh_dispatch_runtime
  set lease_expires_at = now() + interval ''5 minutes'',
      updated_at = now()
  where id = true
    and lease_token = p_lease_token
    and lease_report_code = p_report_code
    and lease_generation_id = p_generation_id
    and lease_expires_at > now();
  get diagnostics changed = row_count;
  if changed = 0 then return false; end if;

  update canonical_defensive_refresh_requests
  set lease_expires_at = now() + interval ''5 minutes'',
      updated_at = now()
  where report_code = p_report_code
    and lease_token = p_lease_token
    and generation_id = p_generation_id
    and status = ''running'';
  return found;
end;
$$;
revoke all on function renew_canonical_defensive_refresh_lease(text, uuid, uuid) from public, anon, authenticated;
grant execute on function renew_canonical_defensive_refresh_lease(text, uuid, uuid) to service_role;

create or replace function complete_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_generation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare owns_lease boolean;
begin
  select exists (
    select 1
    from canonical_defensive_refresh_dispatch_runtime r
    where r.id = true
      and r.lease_token = p_lease_token
      and r.lease_report_code = p_report_code
      and r.lease_generation_id = p_generation_id
  ) into owns_lease;
  if not owns_lease then return false; end if;

  update canonical_defensive_refresh_requests q
  set status = ''completed'',
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null,
      generation_id = coalesce(q.generation_id, p_generation_id),
      last_error = null,
      updated_at = now()
  where q.status in (''pending'', ''running'')
    and not canonical_defensive_report_needs_refresh(q.report_code);

  if canonical_defensive_report_needs_refresh(p_report_code) then
    update canonical_defensive_refresh_requests
    set status = ''blocked'',
        last_error = ''La generación se publicó, pero el report sigue fuera de cobertura canónica.'',
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
    where report_code = p_report_code;
  end if;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;
  return true;
end;
$$;
revoke all on function complete_canonical_defensive_refresh_request(text, uuid, uuid) from public, anon, authenticated;
grant execute on function complete_canonical_defensive_refresh_request(text, uuid, uuid) to service_role;

create or replace function block_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_error text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update canonical_defensive_refresh_requests
  set status = ''blocked'',
      last_error = left(coalesce(p_error, ''canonical refresh blocked''), 4000),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = ''running'';
  if not found then return false; end if;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;
  return true;
end;
$$;
revoke all on function block_canonical_defensive_refresh_request(text, uuid, text) from public, anon, authenticated;
grant execute on function block_canonical_defensive_refresh_request(text, uuid, text) to service_role;

create or replace function fail_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempts integer;
  retry_after_seconds integer;
  will_retry boolean;
begin
  select attempts into current_attempts
  from canonical_defensive_refresh_requests
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = ''running''
  for update;

  if current_attempts is null then
    return jsonb_build_object(''retryScheduled'', false, ''retryAfterSeconds'', 0, ''staleLease'', true);
  end if;

  will_retry := current_attempts < 5;
  retry_after_seconds := least(60, greatest(2, (power(2, current_attempts)::integer) * 2));

  update canonical_defensive_refresh_requests
  set status = case when will_retry then ''pending'' else ''blocked'' end,
      not_before = case
        when will_retry then now() + make_interval(secs => retry_after_seconds)
        else not_before
      end,
      last_error = left(coalesce(p_error, ''canonical refresh failed''), 4000),
      lease_token = null,
      lease_expires_at = null,
      generation_id = null,
      updated_at = now()
  where report_code = p_report_code;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;

  return jsonb_build_object(
    ''retryScheduled'', will_retry,
    ''retryAfterSeconds'', case when will_retry then retry_after_seconds else 0 end,
    ''staleLease'', false
  );
end;
$$;
revoke all on function fail_canonical_defensive_refresh_request(text, uuid, text) from public, anon, authenticated;
grant execute on function fail_canonical_defensive_refresh_request(text, uuid, text) to service_role;

insert into canonical_defensive_refresh_requests (
  report_code, status, requested_at, not_before, updated_at
)
select r.code, ''pending'', now(), now(), now()
from reports r
where canonical_defensive_report_needs_refresh(r.code)
on conflict (report_code) do update
set status = case
      when canonical_defensive_refresh_requests.status = ''running''
       and canonical_defensive_refresh_requests.lease_expires_at > now()
        then ''running''
      else ''pending''
    end,
    requested_at = now(),
    not_before = now(),
    completed_at = null,
    last_error = null,
    updated_at = now();"}', 'canonical_defensive_auto_refresh', 'alvaropompa@gmail.com', NULL, NULL),
	('20260908073535', '{"create or replace function fail_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempts integer;
  current_generation_id uuid;
  retry_after_seconds integer;
  will_retry boolean;
  generation_coverage jsonb;
  published_result jsonb;
begin
  select attempts, generation_id
    into current_attempts, current_generation_id
  from canonical_defensive_refresh_requests
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = ''running''
  for update;

  if current_attempts is null then
    return jsonb_build_object(
      ''retryScheduled'', false,
      ''retryAfterSeconds'', 0,
      ''staleLease'', true,
      ''recoveredPublished'', false
    );
  end if;

  if current_generation_id is not null
     and exists (
       select 1
       from defensive_generations g
       where g.id = current_generation_id
         and g.status = ''building''
     ) then
    begin
      generation_coverage := defensive_generation_coverage(current_generation_id);
      if coalesce((generation_coverage ->> ''complete'')::boolean, false) then
        published_result := publish_complete_defensive_generation(current_generation_id);

        update canonical_defensive_refresh_requests
        set status = ''completed'',
            completed_at = coalesce(completed_at, now()),
            last_error = left(
              ''Recovered after worker failure: '' || coalesce(p_error, ''canonical refresh failed''),
              4000
            ),
            lease_token = null,
            lease_expires_at = null,
            generation_id = current_generation_id,
            updated_at = now()
        where report_code = p_report_code
          and lease_token = p_lease_token
          and status = ''running'';

        update canonical_defensive_refresh_dispatch_runtime
        set lease_token = null,
            lease_report_code = null,
            lease_generation_id = null,
            lease_expires_at = null,
            updated_at = now()
        where id = true
          and lease_token = p_lease_token;

        return jsonb_build_object(
          ''retryScheduled'', false,
          ''retryAfterSeconds'', 0,
          ''staleLease'', false,
          ''recoveredPublished'', true,
          ''generationId'', current_generation_id,
          ''coverage'', generation_coverage,
          ''publication'', published_result
        );
      end if;
    exception when others then
      p_error := concat(
        coalesce(p_error, ''canonical refresh failed''),
        '' | complete-generation recovery failed: '',
        sqlerrm
      );
    end;
  end if;

  will_retry := current_attempts < 5;
  retry_after_seconds := least(60, greatest(2, (power(2, current_attempts)::integer) * 2));

  update canonical_defensive_refresh_requests
  set status = case when will_retry then ''pending'' else ''blocked'' end,
      not_before = case
        when will_retry then now() + make_interval(secs => retry_after_seconds)
        else not_before
      end,
      last_error = left(coalesce(p_error, ''canonical refresh failed''), 4000),
      lease_token = null,
      lease_expires_at = null,
      generation_id = null,
      updated_at = now()
  where report_code = p_report_code;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;

  return jsonb_build_object(
    ''retryScheduled'', will_retry,
    ''retryAfterSeconds'', case when will_retry then retry_after_seconds else 0 end,
    ''staleLease'', false,
    ''recoveredPublished'', false
  );
end;
$$;

revoke all on function fail_canonical_defensive_refresh_request(text, uuid, text)
from public, anon, authenticated;
grant execute on function fail_canonical_defensive_refresh_request(text, uuid, text)
to service_role;"}', 'canonical_defensive_auto_refresh_publish_recovery', 'alvaropompa@gmail.com', NULL, NULL),
	('20260908074031', '{"create or replace function begin_defensive_generation_refresh(
  p_game_build text,
  p_semantic_version text,
  p_resolver_version text,
  p_semantic_resolver_version text,
  p_episode_version text,
  p_evaluator_version text,
  p_report_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_id uuid;
  parent defensive_generations%rowtype;
  parent_id uuid;
  child_id uuid;
  bad_parent_keys integer := 0;
  is_dispatch_resume boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext(''iris:defensive-generation-refresh''));

  select id into existing_id from defensive_generations where status = ''building'' limit 1;
  if existing_id is not null then
    if not exists (
      select 1 from defensive_generations g
      where g.id = existing_id
        and g.game_build = p_game_build
        and g.semantic_version = p_semantic_version
        and g.resolver_version = p_resolver_version
        and g.semantic_resolver_version = p_semantic_resolver_version
        and g.episode_version = p_episode_version
        and g.evaluator_version = p_evaluator_version
    ) then
      raise exception ''A different defensive generation is already building: %'', existing_id;
    end if;

    if p_report_code is not null then
      select exists (
        select 1
        from canonical_defensive_refresh_requests q
        where q.report_code = p_report_code
          and q.status = ''running''
          and q.generation_id = existing_id
          and q.lease_expires_at > now()
      ) into is_dispatch_resume;

      if not is_dispatch_resume then
        delete from player_execution_events pe
        where pe.defensive_generation_id = existing_id
          and pe.domain = ''defensive''
          and exists (
            select 1 from canonical_defensive_eligible_player_pulls x
            where x.pull_id = pe.pull_id
              and x.player_name = pe.player_name
              and x.report_code = p_report_code
              and x.game_build = p_game_build
          );
        delete from player_pull_defensive_episode_evaluations s
        where s.defensive_generation_id = existing_id
          and exists (
            select 1 from canonical_defensive_eligible_player_pulls x
            where x.pull_id = s.pull_id
              and x.player_name = s.player_name
              and x.report_code = p_report_code
              and x.game_build = p_game_build
          );
      end if;
    end if;
    return existing_id;
  end if;

  select ptr.published_generation_id into parent_id
  from defensive_generation_pointer ptr where ptr.id = true for update;
  if parent_id is not null then
    select * into parent from defensive_generations where id = parent_id;
  end if;

  insert into defensive_generations (
    status, semantic_version, resolver_version, semantic_resolver_version,
    episode_version, evaluator_version, game_build, notes
  ) values (
    ''building'', p_semantic_version, p_resolver_version, p_semantic_resolver_version,
    p_episode_version, p_evaluator_version, p_game_build,
    jsonb_build_object(
      ''kind'', ''canonical_defensive_production_refresh'',
      ''startedAt'', now(),
      ''sourceReportCode'', p_report_code,
      ''parentGenerationId'', parent_id,
      ''contract'', jsonb_build_object(
        ''gameBuild'', p_game_build,
        ''semanticVersion'', p_semantic_version,
        ''resolverVersion'', p_resolver_version,
        ''semanticResolverVersion'', p_semantic_resolver_version,
        ''episodeVersion'', p_episode_version,
        ''evaluatorVersion'', p_evaluator_version
      )
    )::text
  ) returning id into child_id;

  if parent_id is not null
     and parent.status = ''published''
     and parent.game_build = p_game_build
     and parent.semantic_version = p_semantic_version
     and parent.resolver_version = p_resolver_version
     and parent.semantic_resolver_version = p_semantic_resolver_version
     and parent.episode_version = p_episode_version
     and parent.evaluator_version = p_evaluator_version then

    insert into player_pull_defensive_episode_evaluations (
      defensive_generation_id, pull_id, player_name, episode_evaluator_version,
      semantic_version, semantic_resolver_version, resolver_version,
      build_fingerprint, data_confidence, episodes, evaluated_at
    )
    select
      child_id, s.pull_id, s.player_name, s.episode_evaluator_version,
      s.semantic_version, s.semantic_resolver_version, s.resolver_version,
      s.build_fingerprint, s.data_confidence, s.episodes, s.evaluated_at
    from player_pull_defensive_episode_evaluations s
    join canonical_defensive_eligible_player_pulls e
      on e.pull_id = s.pull_id
     and e.player_name = s.player_name
     and e.game_build = p_game_build
    where s.defensive_generation_id = parent_id
      and s.episode_evaluator_version = p_evaluator_version
      and s.semantic_version = p_semantic_version
      and s.semantic_resolver_version = p_semantic_resolver_version
      and s.resolver_version = p_resolver_version
      and (p_report_code is null or e.report_code <> p_report_code);

    select count(*) into bad_parent_keys
    from player_execution_events e
    join canonical_defensive_eligible_player_pulls x
      on x.pull_id = e.pull_id
     and x.player_name = e.player_name
     and x.game_build = p_game_build
    where e.defensive_generation_id = parent_id
      and e.domain = ''defensive''
      and (p_report_code is null or x.report_code <> p_report_code)
      and e.deduplication_key not like parent_id::text || '':%'';
    if bad_parent_keys <> 0 then
      raise exception ''Published defensive ledger has % non-canonical dedupe keys; clone aborted'', bad_parent_keys;
    end if;

    insert into player_execution_events (
      pull_id, boss_id, difficulty, player_name, occurrence_id, causal_group_id,
      timestamp_ms, domain, event_type, verdict, reason_code, credit_eligible,
      penalty_eligible, primary_penalty, severity, priority, confidence, evidence,
      policy_version, context_resolver_version, occurrence_resolver_version,
      ledger_evaluator_version, deduplication_key, evaluated_at, defensive_generation_id
    )
    select
      e.pull_id, e.boss_id, e.difficulty, e.player_name, e.occurrence_id, e.causal_group_id,
      e.timestamp_ms, e.domain, e.event_type, e.verdict, e.reason_code, e.credit_eligible,
      e.penalty_eligible, e.primary_penalty, e.severity, e.priority, e.confidence, e.evidence,
      e.policy_version, e.context_resolver_version, e.occurrence_resolver_version,
      e.ledger_evaluator_version,
      child_id::text || substring(e.deduplication_key from length(parent_id::text) + 1),
      e.evaluated_at, child_id
    from player_execution_events e
    join canonical_defensive_eligible_player_pulls x
      on x.pull_id = e.pull_id
     and x.player_name = e.player_name
     and x.game_build = p_game_build
    where e.defensive_generation_id = parent_id
      and e.domain = ''defensive''
      and (p_report_code is null or x.report_code <> p_report_code);
  end if;

  return child_id;
end;
$$;
revoke all on function begin_defensive_generation_refresh(text,text,text,text,text,text,text)
from public, anon, authenticated;
grant execute on function begin_defensive_generation_refresh(text,text,text,text,text,text,text)
to service_role;

create or replace function claim_canonical_defensive_refresh_request()
returns table (report_code text, lease_token uuid, attempt smallint)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  runtime canonical_defensive_refresh_dispatch_runtime%rowtype;
  selected canonical_defensive_refresh_requests%rowtype;
  new_token uuid;
begin
  perform pg_advisory_xact_lock(hashtext(''iris:canonical-defensive-auto-refresh:claim''));

  select * into runtime
  from canonical_defensive_refresh_dispatch_runtime
  where id = true
  for update;

  if runtime.lease_token is not null and runtime.lease_expires_at <= now() then
    update canonical_defensive_refresh_requests
    set status = ''pending'',
        lease_token = null,
        lease_expires_at = null,
        not_before = now(),
        updated_at = now()
    where status = ''running''
      and lease_token = runtime.lease_token;

    update canonical_defensive_refresh_dispatch_runtime
    set lease_token = null,
        lease_report_code = null,
        lease_generation_id = null,
        lease_expires_at = null,
        updated_at = now()
    where id = true;

    runtime.lease_token := null;
    runtime.lease_expires_at := null;
  end if;

  if runtime.lease_token is not null and runtime.lease_expires_at > now() then
    return;
  end if;

  update canonical_defensive_refresh_requests q
  set status = ''completed'',
      completed_at = coalesce(q.completed_at, now()),
      lease_token = null,
      lease_expires_at = null,
      last_error = null,
      updated_at = now()
  where q.status in (''pending'', ''running'')
    and not canonical_defensive_report_needs_refresh(q.report_code);

  select q.* into selected
  from canonical_defensive_refresh_requests q
  where q.status = ''pending''
    and q.not_before <= now()
    and canonical_defensive_report_needs_refresh(q.report_code)
  order by q.requested_at, q.report_code
  for update skip locked
  limit 1;

  if not found then return; end if;

  new_token := gen_random_uuid();
  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = new_token,
      lease_report_code = selected.report_code,
      lease_generation_id = selected.generation_id,
      lease_expires_at = now() + interval ''5 minutes'',
      updated_at = now()
  where id = true;

  update canonical_defensive_refresh_requests q
  set status = ''running'',
      attempts = q.attempts + 1,
      lease_token = new_token,
      lease_expires_at = now() + interval ''5 minutes'',
      last_error = null,
      updated_at = now()
  where q.report_code = selected.report_code;

  return query
  select selected.report_code, new_token, (selected.attempts + 1)::smallint;
end;
$$;
revoke all on function claim_canonical_defensive_refresh_request() from public, anon, authenticated;
grant execute on function claim_canonical_defensive_refresh_request() to service_role;

create or replace function fail_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempts integer;
  current_generation_id uuid;
  retry_after_seconds integer;
  will_retry boolean;
  generation_coverage jsonb;
  published_result jsonb;
begin
  select attempts, generation_id
    into current_attempts, current_generation_id
  from canonical_defensive_refresh_requests
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = ''running''
  for update;

  if current_attempts is null then
    return jsonb_build_object(
      ''retryScheduled'', false,
      ''retryAfterSeconds'', 0,
      ''staleLease'', true,
      ''recoveredPublished'', false
    );
  end if;

  if current_generation_id is not null
     and exists (
       select 1
       from defensive_generations g
       where g.id = current_generation_id
         and g.status = ''building''
     ) then
    begin
      generation_coverage := defensive_generation_coverage(current_generation_id);
      if coalesce((generation_coverage ->> ''complete'')::boolean, false) then
        published_result := publish_complete_defensive_generation(current_generation_id);

        update canonical_defensive_refresh_requests
        set status = ''completed'',
            completed_at = coalesce(completed_at, now()),
            last_error = left(
              ''Recovered after worker failure: '' || coalesce(p_error, ''canonical refresh failed''),
              4000
            ),
            lease_token = null,
            lease_expires_at = null,
            generation_id = current_generation_id,
            updated_at = now()
        where report_code = p_report_code
          and lease_token = p_lease_token
          and status = ''running'';

        update canonical_defensive_refresh_dispatch_runtime
        set lease_token = null,
            lease_report_code = null,
            lease_generation_id = null,
            lease_expires_at = null,
            updated_at = now()
        where id = true
          and lease_token = p_lease_token;

        return jsonb_build_object(
          ''retryScheduled'', false,
          ''retryAfterSeconds'', 0,
          ''staleLease'', false,
          ''recoveredPublished'', true,
          ''generationId'', current_generation_id,
          ''coverage'', generation_coverage,
          ''publication'', published_result
        );
      end if;
    exception when others then
      p_error := concat(
        coalesce(p_error, ''canonical refresh failed''),
        '' | complete-generation recovery failed: '',
        sqlerrm
      );
    end;
  end if;

  will_retry := current_attempts < 5;
  retry_after_seconds := least(60, greatest(2, (power(2, current_attempts)::integer) * 2));

  update canonical_defensive_refresh_requests
  set status = case when will_retry then ''pending'' else ''blocked'' end,
      not_before = case
        when will_retry then now() + make_interval(secs => retry_after_seconds)
        else not_before
      end,
      last_error = left(coalesce(p_error, ''canonical refresh failed''), 4000),
      lease_token = null,
      lease_expires_at = null,
      generation_id = current_generation_id,
      updated_at = now()
  where report_code = p_report_code;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;

  return jsonb_build_object(
    ''retryScheduled'', will_retry,
    ''retryAfterSeconds'', case when will_retry then retry_after_seconds else 0 end,
    ''staleLease'', false,
    ''recoveredPublished'', false,
    ''generationId'', current_generation_id
  );
end;
$$;
revoke all on function fail_canonical_defensive_refresh_request(text, uuid, text)
from public, anon, authenticated;
grant execute on function fail_canonical_defensive_refresh_request(text, uuid, text)
to service_role;"}', 'canonical_defensive_auto_refresh_resume', 'alvaropompa@gmail.com', NULL, NULL);


--
-- PostgreSQL database dump complete
--

-- \unrestrict OABiey7lVWY4RpB4rZ4SCWY8C1FQir8pUNgyJo8xQMjM5VJcX6Mkgd187ecfESI

RESET ALL;
