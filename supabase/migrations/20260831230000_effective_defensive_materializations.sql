-- Gestión defensiva v2 · Bloque C
--
-- Materializaciones paralelas para backfill. No se reutilizan las claves JSON
-- legacy porque las vistas de Fiabilidad actuales las consumen directamente:
-- el cambio de autoridad se hará más adelante mediante flag/dual-read.

alter table player_pull_records
  add column if not exists death_defensive_options_v2 jsonb,
  add column if not exists defensive_pressure_windows_v2 jsonb,
  add column if not exists defensive_resolution_evaluated_at timestamptz;

alter table player_pull_records
  drop constraint if exists player_pull_records_death_defensive_options_v2_check;
alter table player_pull_records
  add constraint player_pull_records_death_defensive_options_v2_check
  check (death_defensive_options_v2 is null or jsonb_typeof(death_defensive_options_v2) = 'array');

alter table player_pull_records
  drop constraint if exists player_pull_records_defensive_pressure_windows_v2_check;
alter table player_pull_records
  add constraint player_pull_records_defensive_pressure_windows_v2_check
  check (defensive_pressure_windows_v2 is null or jsonb_typeof(defensive_pressure_windows_v2) = 'object');

comment on column player_pull_records.death_defensive_options_v2 is
  'Estado en la muerte calculado con kit efectivo, cargas y targeting personal. Paralelo a death_cause.defensiveOptions durante dual-read.';
comment on column player_pull_records.defensive_pressure_windows_v2 is
  'Sensor de pressure legacy con opciones recalculadas por resolver/state engine v2. coverable sigue siendo diagnóstico, no scoring.';
comment on column player_pull_records.defensive_resolution_evaluated_at is
  'Fecha de materialización v2; junto a defensive_resolution_version y game_build permite auditar/backfillear derivados.';

create index if not exists player_pull_records_defensive_v2_pending_idx
  on player_pull_records (pull_id)
  where defensive_resolution_version is null;
