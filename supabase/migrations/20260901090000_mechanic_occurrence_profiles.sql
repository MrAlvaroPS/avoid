-- Gestión defensiva v2 · Bloque D · ocurrencias world por mecánica
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
  sample_offsets_ms integer[] not null default '{}',
  sample_fight_count integer not null default 0 check (sample_fight_count >= 0),
  phase_id integer,
  world_overlap_score numeric,
  local_overlap_score numeric,
  updated_at timestamptz not null default now(),
  check (p10_offset_ms <= median_offset_ms and median_offset_ms <= p90_offset_ms),
  primary key (boss_id, difficulty, ability_id, occurrence_index)
);

create index if not exists boss_mechanic_occurrence_profile_timeline_idx
  on boss_mechanic_occurrence_profile (boss_id, difficulty, median_offset_ms, ability_id, occurrence_index);

alter table boss_mechanic_occurrence_profile enable row level security;

drop policy if exists "boss_mechanic_occurrence_profile: officers read" on boss_mechanic_occurrence_profile;
create policy "boss_mechanic_occurrence_profile: officers read"
  on boss_mechanic_occurrence_profile for select
  using (is_officer());

revoke all on boss_mechanic_occurrence_profile from anon;
grant select on boss_mechanic_occurrence_profile to authenticated;

comment on table boss_mechanic_occurrence_profile is
  'Timings world por ocurrencia repetida: #1 se agrega con #1 entre fights, nunca como una mediana única por ability.';
comment on column boss_mechanic_occurrence_profile.sample_fight_count is
  'Número de fights que observaron esta ocurrencia concreta; permite detectar una #N rara causada por distinta duración/fase.';
