-- Causalidad v3 · Bloque E: línea temporal auditable de dispels de WCL.
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
);

create index if not exists pull_dispel_events_pull_timeline_idx
  on pull_dispel_events (pull_id, timestamp_ms);
create index if not exists pull_dispel_events_pull_target_idx
  on pull_dispel_events (pull_id, target_actor_id, dispelled_ability_id, timestamp_ms);

alter table pull_dispel_events enable row level security;
drop policy if exists "pull_dispel_events: officers read" on pull_dispel_events;
create policy "pull_dispel_events: officers read"
  on pull_dispel_events for select using (is_officer());
revoke all on pull_dispel_events from anon, authenticated;
grant select on pull_dispel_events to authenticated;

comment on table pull_dispel_events is
  'Hechos WCL de dispel por pull. is_buff=true representa dispel ofensivo y no cuenta como limpieza aliada.';
