-- §pressure-detection-diagnostics (2026-09-10, hallazgo empírico real:
-- report VNvX3MqWxZ9jhT6d pull 23, ~8 minutos Heroic, daño de raid real y
-- variable (550K-5.7M por bucket) — 20 de 24 jugadores registraron 0
-- episodios de presión en todo el pull; solo los 2 tanks y 2 DPS más
-- tuvieron alguno. Txerokee lanzó Astral Shift 30 veces en la noche
-- completa pero el sistema solo detectó 10 "episodios" de presión en total.
--
-- Antes de tocar la fórmula de detectDamageWindows() (damage-pressure-
-- windows.ts — umbral = mediana propia de buckets>0 × 2.5, mínimo 3 buckets
-- no-cero) hace falta ver los números reales por jugador×pull×rol, no
-- adivinar. Esta tabla es puramente diagnóstica: nunca la lee el evaluador,
-- nunca alimenta ningún KPI, no tiene relación con defensive_generations.
-- Es candidata a DROP en cuanto se decida el cambio de fórmula.

create table if not exists canonical_defensive_pressure_diagnostics (
  pull_id uuid not null references pulls(id) on delete cascade,
  player_name text not null,
  class text,
  spec text,
  pull_duration_ms integer,
  point_interval_ms numeric,
  total_buckets integer not null,
  nonzero_buckets integer not null,
  baseline_value numeric not null,
  threshold_value numeric not null,
  max_point_value numeric not null,
  window_count integer not null,
  computed_at timestamptz not null default now(),
  primary key (pull_id, player_name)
);

alter table canonical_defensive_pressure_diagnostics enable row level security;
revoke all on canonical_defensive_pressure_diagnostics from anon, authenticated;
grant select, insert on canonical_defensive_pressure_diagnostics to service_role;
