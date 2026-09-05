-- Gestión defensiva v2 · Bloque I · evaluación post-pull autoritativa

create table if not exists player_pull_defensive_evaluations (
  pull_id uuid not null references pulls (id) on delete cascade,
  player_name text not null,
  plan_version_id uuid references defensive_plan_versions (id) on delete restrict,
  mode text not null check (mode in ('full', 'partial', 'no_plan')),
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
  data_confidence text not null check (data_confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  events jsonb not null default '[]'::jsonb check (jsonb_typeof(events) = 'array'),
  evaluated_at timestamptz not null default now(),
  primary key (pull_id, player_name)
);

create index if not exists player_pull_defensive_evaluations_plan_idx
  on player_pull_defensive_evaluations (plan_version_id, evaluated_at desc);
create index if not exists player_pull_defensive_evaluations_scoring_idx
  on player_pull_defensive_evaluations (evaluator_version, data_confidence, evaluated_at desc);

alter table player_pull_defensive_evaluations enable row level security;
drop policy if exists "player_pull_defensive_evaluations: officers read" on player_pull_defensive_evaluations;
create policy "player_pull_defensive_evaluations: officers read"
  on player_pull_defensive_evaluations for select using (is_officer());

revoke all on player_pull_defensive_evaluations from anon, authenticated;
grant select on player_pull_defensive_evaluations to authenticated;

comment on table player_pull_defensive_evaluations is
  'Una fila autoritativa por jugador+pull. Conserva resultados y reason codes del replay global sin reinterpretar el plan ligado.';
comment on column player_pull_defensive_evaluations.events is
  'Eventos explicables con estado semántico, cobertura, adherencia, timeline y evidencia contrafactual.';
