-- Cierra un hueco real frente a la hoja de ruta (§12): el motor determinista
-- necesita una línea temporal de instancias de mecánica (para
-- MechanicTimelineComponent, el "elemento de firma" de la vista Live Pull),
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
  outcome text not null check (outcome in ('clean', 'partial_fail', 'fail')),
  players_hit integer not null default 0,
  avoidable boolean,
  created_at timestamptz not null default now()
);
create index if not exists pull_mechanic_events_pull_idx on pull_mechanic_events (pull_id, trigger_time_ms);

alter table pull_mechanic_events enable row level security;
create policy "read all - pull_mechanic_events" on pull_mechanic_events for select using (true);

alter publication supabase_realtime add table pull_mechanic_events;
