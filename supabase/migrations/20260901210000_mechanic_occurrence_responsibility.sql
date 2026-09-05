-- Causalidad v3 · Bloque A / M13 · occurrence evaluada y grafo de responsabilidad.

create unique index if not exists pulls_identity_scope_key
  on pulls (id, boss_id, difficulty);

create table if not exists mechanic_occurrence_evaluations (
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
  target_actor_ids bigint[] not null default '{}',
  assignment_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(assignment_snapshot) = 'object'),
  outcome text not null check (outcome in ('success', 'partial_fail', 'fail', 'not_evaluable', 'uncertain')),
  failure_mode text check (failure_mode is null or nullif(btrim(failure_mode), '') is not null),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  confidence text not null check (confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  policy_version integer not null check (policy_version > 0),
  context_resolver_version text not null check (nullif(btrim(context_resolver_version), '') is not null),
  occurrence_resolver_version text not null check (nullif(btrim(occurrence_resolver_version), '') is not null),
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (pull_id, boss_id, difficulty)
    references pulls (id, boss_id, difficulty) on delete cascade,
  foreign key (boss_id, difficulty, mechanic_key)
    references boss_mechanic_policy (boss_id, difficulty, mechanic_key) on delete restrict,
  unique (pull_id, mechanic_key, occurrence_index, occurrence_resolver_version),
  check (array_position(target_actor_ids, null) is null and 0::bigint < all(target_actor_ids)),
  check (outcome <> 'uncertain' or confidence = 'uncertain'),
  check (outcome <> 'fail' or failure_mode is not null)
);

create index if not exists mechanic_occurrence_evaluations_timeline_idx
  on mechanic_occurrence_evaluations (pull_id, resolve_ms, mechanic_key, occurrence_index);
create index if not exists mechanic_occurrence_evaluations_mechanic_idx
  on mechanic_occurrence_evaluations (boss_id, difficulty, mechanic_key, occurrence_index);
create index if not exists mechanic_occurrence_evaluations_version_idx
  on mechanic_occurrence_evaluations (context_resolver_version, occurrence_resolver_version, evaluated_at desc);

create table if not exists mechanic_responsibility_edges (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references mechanic_occurrence_evaluations (id) on delete cascade,
  player_name text not null check (nullif(btrim(player_name), '') is not null),
  actor_id bigint check (actor_id is null or actor_id > 0),
  relationship text not null check (relationship in (
    'primary_owner', 'co_owner', 'assigned_resolver', 'successful_resolver',
    'target', 'collateral_victim', 'beneficiary'
  )),
  damage_caused bigint not null default 0 check (damage_caused >= 0),
  damage_taken bigint not null default 0 check (damage_taken >= 0),
  victim_count integer not null default 0 check (victim_count >= 0),
  credit_eligible boolean not null default false,
  penalty_eligible boolean not null default false,
  reason_code text not null check (nullif(btrim(reason_code), '') is not null),
  confidence text not null check (confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  unique (occurrence_id, player_name, relationship, reason_code),
  check (not penalty_eligible or relationship in ('primary_owner', 'co_owner', 'assigned_resolver')),
  check (not penalty_eligible or confidence in ('verified', 'inferred')),
  check (relationship <> 'collateral_victim' or not penalty_eligible)
);

create index if not exists mechanic_responsibility_edges_occurrence_idx
  on mechanic_responsibility_edges (occurrence_id, relationship);
create index if not exists mechanic_responsibility_edges_player_penalty_idx
  on mechanic_responsibility_edges (player_name, penalty_eligible, occurrence_id);
create index if not exists mechanic_responsibility_edges_player_credit_idx
  on mechanic_responsibility_edges (player_name, credit_eligible, occurrence_id);

alter table mechanic_occurrence_evaluations enable row level security;
alter table mechanic_responsibility_edges enable row level security;

drop policy if exists "mechanic_occurrence_evaluations: officers read" on mechanic_occurrence_evaluations;
create policy "mechanic_occurrence_evaluations: officers read"
  on mechanic_occurrence_evaluations for select using (is_officer());
drop policy if exists "mechanic_responsibility_edges: officers read" on mechanic_responsibility_edges;
create policy "mechanic_responsibility_edges: officers read"
  on mechanic_responsibility_edges for select using (is_officer());

revoke all on mechanic_occurrence_evaluations, mechanic_responsibility_edges from anon, authenticated;
grant select on mechanic_occurrence_evaluations, mechanic_responsibility_edges to authenticated;

comment on table mechanic_occurrence_evaluations is
  'Outcome reproducible por pull+mechanic_key+occurrence. Los impactos observados no determinan por sí solos ownership.';
comment on table mechanic_responsibility_edges is
  'Grafo materializado owner/assignee/resolver/target/víctima. credit_eligible y penalty_eligible son decisiones independientes.';
