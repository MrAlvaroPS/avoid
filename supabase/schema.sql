-- Esquema inicial. Ejecutar en el SQL editor de Supabase o vía `supabase db push`.

create extension if not exists "pgcrypto";

create table if not exists boss_mechanics (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  contract jsonb not null, -- el BossMechanic[] curado a mano (ver conversación de diseño)
  updated_at timestamptz not null default now(),
  unique (boss_id, difficulty)
);

-- Candidatos auto-descubiertos (Blizzard Journal, cruzado con Wago DB2 para
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
  sources jsonb not null default '[]'::jsonb, -- ej. ["blizzard-journal"]
  observed_in_logs boolean not null default false,
  journal_encounter_id bigint, -- id del encounter en el Journal de Blizzard, para trazabilidad
  db2_difficulty_id integer, -- id de la tabla Difficulty de Blizzard DB2 (¡no coincide con el id de WCL!) resuelto para esta fila
  difficulty_mapping_status text, -- ver difficulty-mapping.ts: 'mapped-by-*' | 'difficulty-mapping-unresolved' | 'difficulty-mapping-ambiguous' | 'difficulty-metadata-unavailable'
  -- Campos editables a mano, persistentes entre resyncs:
  category text check (category in ('tankbuster','raid-damage','avoidable-ground','debuff-stack','interrupt','soak','spread')),
  avoidable boolean,
  expected_response jsonb, -- { type, scope }
  severity_threshold numeric,
  reviewed boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (boss_id, difficulty, ability_id)
);
create index if not exists boss_mechanics_candidates_boss_idx on boss_mechanics_candidates (boss_id, difficulty);

-- Histórico persistente de reports de WCL de la guild, para no tener que
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
);
create index if not exists reports_start_time_idx on reports (start_time desc);

-- De dónde sale la lista de bosses sin teclear nada: cada fight de raid visto
-- en un report sincronizado (sync-reports) deja aquí su encounterID, nombre y
-- dificultad reales de WCL. El desplegable de "Mecánicas del boss" lee de esta
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
);
create index if not exists report_encounters_encounter_idx on report_encounters (encounter_id, wcl_difficulty_id, start_time desc);

create table if not exists pulls (
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
);
create index if not exists pulls_report_code_idx on pulls (report_code, pull_number desc);

-- Generada por analyze-report (Fase 1): un row por jugador que participó en
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
  defensive_events jsonb not null default '[]'::jsonb,
  avoidable_damage_taken bigint not null default 0,
  -- [{ mechanicId, mechanicName, amount }] — el desglose de avoidable_damage_taken
  -- por mecánica. Sin esto no se puede responder "¿qué mecánica nos está haciendo
  -- daño de verdad?", solo un totalón sin decir de qué viene. Es lo que alimenta
  -- el "marcador" de la sección de mecánicas (ver boss-mechanics.service.ts).
  mechanic_damage jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists player_pull_records_pull_idx on player_pull_records (pull_id);

create table if not exists pull_briefs (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null unique references pulls (id) on delete cascade,
  headline text not null,
  improved jsonb not null default '[]'::jsonb,
  regressed jsonb not null default '[]'::jsonb,
  next_pull_actions jsonb not null default '[]'::jsonb,
  model text not null,
  created_at timestamptz not null default now()
);

-- Guard/contador de llamadas al LLM. Cada llamada (permitida, bloqueada o fallida) se registra aquí.
create table if not exists llm_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  purpose text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 6) not null default 0,
  status text not null check (status in ('ok', 'blocked', 'error')),
  block_reason text
);
create index if not exists llm_calls_created_at_idx on llm_calls (created_at desc);
create index if not exists llm_calls_status_idx on llm_calls (status, created_at desc);

create table if not exists session_state (
  id boolean primary key default true check (id), -- fila única (singleton)
  report_code text,
  active boolean not null default false,
  last_processed_fight_id integer,
  updated_at timestamptz not null default now()
);

-- RLS: lectura pública (anon key) para el dashboard, escritura solo desde
-- las Edge Functions (service_role, que no pasa por RLS). Uso personal,
-- sin login: si te preocupa la exposición, añade Supabase Auth más adelante.
alter table boss_mechanics enable row level security;
alter table boss_mechanics_candidates enable row level security;
alter table report_encounters enable row level security;
alter table reports enable row level security;
alter table pulls enable row level security;
alter table player_pull_records enable row level security;
alter table pull_briefs enable row level security;
alter table llm_calls enable row level security;
alter table session_state enable row level security;

create policy "read all - boss_mechanics" on boss_mechanics for select using (true);
create policy "read all - boss_mechanics_candidates" on boss_mechanics_candidates for select using (true);
create policy "read all - report_encounters" on report_encounters for select using (true);
create policy "read all - reports" on reports for select using (true);
create policy "read all - pulls" on pulls for select using (true);
create policy "read all - player_pull_records" on player_pull_records for select using (true);
create policy "read all - pull_briefs" on pull_briefs for select using (true);
create policy "read all - llm_calls" on llm_calls for select using (true);
create policy "read all - session_state" on session_state for select using (true);

-- Imprescindible para que la suscripción Realtime del front reciba los INSERT.
-- Sin esto, RaidSessionService.subscribeRealtime() se queda callado.
alter publication supabase_realtime add table pulls;
alter publication supabase_realtime add table pull_briefs;
alter publication supabase_realtime add table llm_calls;
alter publication supabase_realtime add table reports;
alter publication supabase_realtime add table boss_mechanics_candidates;
alter publication supabase_realtime add table report_encounters;
