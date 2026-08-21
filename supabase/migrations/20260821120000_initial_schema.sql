-- Colocar en: supabase/migrations/20260821120000_initial_schema.sql
-- Esquema completo de la sección 7 de la hoja de ruta, con RLS.
-- Fase 1 solo usa raid_teams / encounters / raid_nights / pulls, pero se crea
-- todo de una vez para no tener que ir migrando por fases.

-- ============ NÚCLEO ============

create table raid_teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users not null,
  name text not null,
  created_at timestamptz default now()
);

create table raiders (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references raid_teams(id) not null,
  main_character_name text not null,
  realm text not null,
  class text not null,
  active_spec text,
  role text check (role in ('tank','healer','dps')),
  created_at timestamptz default now()
);

create table encounters (
  id uuid primary key default gen_random_uuid(),
  wcl_encounter_id int unique,
  name text not null,
  raid_zone text not null,
  order_index int,
  is_final_boss boolean default false,
  created_at timestamptz default now()
);

-- ============ MANIFIESTO DE MECÁNICAS (tarea manual #1, fase 2) ============

create table encounter_mechanics (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid references encounters(id) not null,
  spell_id int not null,
  name text not null,
  mechanic_type text check (mechanic_type in
    ('avoidable_raid_damage','soak','tank_swap','interrupt','dispel',
     'stack_spread','add_priority','positioning','bloodlust_timing','other')),
  expected_role text check (expected_role in ('tank','healer','dps','all')),
  response_window_ms int,
  raid_wide_threshold numeric default 0.35,
  notes text,
  source text,
  manifest_version int default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table cooldown_catalog (       -- auto-sincronizado desde el Docker de WoWAnalyzer, §12.1
  id uuid primary key default gen_random_uuid(),
  class text not null,
  spec text not null,
  spell_id int not null,
  name text not null,
  base_cooldown_ms int not null,
  category text check (category in ('personal_defensive','external_defensive','utility','offensive_cd')),
  synced_from_commit text,
  synced_at timestamptz,
  unique (spec, spell_id)
);

-- ============ RAID NIGHTS Y PULLS (fase 1) ============

create table raid_nights (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references raid_teams(id) not null,
  date date not null,
  wcl_report_code text,
  status text check (status in ('live','closed')) default 'live'
);

create table pulls (
  id uuid primary key default gen_random_uuid(),
  raid_night_id uuid references raid_nights(id) not null,
  encounter_id uuid references encounters(id) not null,
  pull_number int not null,
  difficulty text check (difficulty in ('normal','heroic','mythic')),
  wcl_fight_id int,
  is_live boolean default false,
  is_kill boolean default false,
  pull_duration_ms int,
  boss_hp_pct_final numeric,
  started_at timestamptz,
  ended_at timestamptz,
  raw_source text check (raw_source in ('wcl_live_poll','wcl_historical_import')),
  analysis_state text check (analysis_state in ('pending','computing','ready','stale')) default 'pending',
  analysis_manifest_version int,
  created_at timestamptz default now(),
  unique (raid_night_id, wcl_fight_id)   -- evita duplicados si se reimporta el mismo report
);

-- ============ RESULTADOS DEL ANÁLISIS (fases 2-4, se crean ya para no migrar de nuevo) ============

create table pull_mechanic_instances (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid references pulls(id) not null,
  mechanic_id uuid references encounter_mechanics(id) not null,
  trigger_time_ms int,
  boss_hp_pct_at_trigger numeric,
  outcome text check (outcome in ('clean','partial_fail','fail')),
  players_hit uuid[],
  deaths_caused uuid[],
  detail jsonb,
  provenance jsonb
);

create table pull_deaths (
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
);

create table pull_player_stats (
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
);

create table pull_diffs (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid references pulls(id) not null,
  compared_against_pull_id uuid references pulls(id) not null,
  mechanic_regressions jsonb,
  mechanic_improvements jsonb,
  recurring_death_patterns jsonb,
  progress_delta_pct numeric,
  created_at timestamptz default now(),
  unique (pull_id, compared_against_pull_id)
);

create table baseline_pulls (
  encounter_id uuid references encounters(id),
  difficulty text,
  best_pull_id uuid references pulls(id),
  updated_at timestamptz default now(),
  primary key (encounter_id, difficulty)
);

create table pull_llm_analysis (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid unique references pulls(id) not null,
  summary_well text not null,
  summary_wrong text not null,
  top_priority_fix text not null,
  model_used text not null,
  tokens_used int,
  input_hash text not null,
  created_at timestamptz default now()
);

-- ============ RLS ============
-- Patrón: todo cuelga de raid_teams.owner_id = auth.uid(), vía el join que
-- corresponda en cada tabla. Las tablas de referencia global (encounters,
-- encounter_mechanics, cooldown_catalog) son de lectura abierta a cualquier
-- usuario autenticado; solo se escriben desde las Edge Functions con la
-- service role key, que ignora RLS por diseño.

alter table raid_teams enable row level security;
create policy "owner manages own teams" on raid_teams
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table raiders enable row level security;
create policy "owner manages own raiders" on raiders
  for all using (team_id in (select id from raid_teams where owner_id = auth.uid()))
  with check (team_id in (select id from raid_teams where owner_id = auth.uid()));

alter table encounters enable row level security;
create policy "authenticated can read encounters" on encounters
  for select using (auth.role() = 'authenticated');

alter table encounter_mechanics enable row level security;
create policy "authenticated can read mechanics" on encounter_mechanics
  for select using (auth.role() = 'authenticated');

alter table cooldown_catalog enable row level security;
create policy "authenticated can read cooldowns" on cooldown_catalog
  for select using (auth.role() = 'authenticated');

alter table raid_nights enable row level security;
create policy "owner manages own raid nights" on raid_nights
  for all using (team_id in (select id from raid_teams where owner_id = auth.uid()))
  with check (team_id in (select id from raid_teams where owner_id = auth.uid()));

alter table pulls enable row level security;
create policy "owner manages own pulls" on pulls
  for all using (raid_night_id in (
    select rn.id from raid_nights rn
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  )) with check (raid_night_id in (
    select rn.id from raid_nights rn
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ));

alter table pull_mechanic_instances enable row level security;
create policy "owner manages own mechanic instances" on pull_mechanic_instances
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ));

alter table pull_deaths enable row level security;
create policy "owner manages own deaths" on pull_deaths
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ));

alter table pull_player_stats enable row level security;
create policy "owner manages own player stats" on pull_player_stats
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ));

alter table pull_diffs enable row level security;
create policy "owner manages own diffs" on pull_diffs
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ));

alter table baseline_pulls enable row level security;
create policy "authenticated can read baselines" on baseline_pulls
  for select using (auth.role() = 'authenticated');

alter table pull_llm_analysis enable row level security;
create policy "owner manages own llm analysis" on pull_llm_analysis
  for all using (pull_id in (
    select p.id from pulls p
    join raid_nights rn on rn.id = p.raid_night_id
    join raid_teams rt on rt.id = rn.team_id
    where rt.owner_id = auth.uid()
  ));
