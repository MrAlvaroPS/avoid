-- Causalidad v3 · Bloque A / M12 · identidad canónica y MechanicPolicy v2.

create table if not exists boss_mechanic_policy (
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null check (nullif(btrim(mechanic_key), '') is not null),
  policy_version integer not null default 1 check (policy_version > 0),
  display_name text not null check (nullif(btrim(display_name), '') is not null),
  display_category text check (display_category in (
    'tankbuster', 'raid-damage', 'avoidable-ground', 'debuff-stack', 'interrupt',
    'soak', 'spread', 'healing-absorb', 'personal-target', 'enrage'
  )),
  targeting_mode text not null check (targeting_mode in (
    'tank', 'selected_player', 'group', 'raid', 'ground', 'object', 'none', 'mixed'
  )),
  required_response text check (required_response is null or nullif(btrim(required_response), '') is not null),
  responsibility_mode text not null check (responsibility_mode in (
    'target', 'tank_role', 'healer_role', 'dps_role', 'assigned_player',
    'assigned_group', 'volunteer', 'raid', 'none'
  )),
  damage_semantics text not null check (damage_semantics in (
    'mandatory', 'avoidable', 'partly_avoidable', 'failure_consequence', 'none'
  )),
  failure_propagation text not null check (failure_propagation in (
    'self', 'nearby_players', 'group', 'raid', 'chained', 'none'
  )),
  assignment_mode text not null check (assignment_mode in (
    'none', 'target_derived', 'role_derived', 'plan_optional', 'plan_required'
  )),
  defensive_expectation text not null check (defensive_expectation in (
    'none', 'optional', 'recommended', 'required', 'contingency_only'
  )),
  credit_scope text not null check (credit_scope in ('resolver', 'target', 'group', 'raid', 'none')),
  penalty_scope text not null check (penalty_scope in ('owner', 'assignee', 'role', 'raid_only', 'none')),
  causal_rule jsonb not null default '{}'::jsonb check (jsonb_typeof(causal_rule) = 'object'),
  confidence text not null check (confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  game_build text,
  tier_revision text,
  verified_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (boss_id, difficulty, mechanic_key),
  check (confidence <> 'verified' or verified_at is not null),
  check (penalty_scope = 'none' or confidence in ('verified', 'inferred'))
);

create index if not exists boss_mechanic_policy_revision_idx
  on boss_mechanic_policy (boss_id, difficulty, mechanic_key, policy_version desc);
create index if not exists boss_mechanic_policy_review_idx
  on boss_mechanic_policy (boss_id, difficulty, confidence, verified_at desc);

drop trigger if exists boss_mechanic_policy_touch_updated_at on boss_mechanic_policy;
create trigger boss_mechanic_policy_touch_updated_at
before update on boss_mechanic_policy
for each row execute function combat_evaluation_touch_updated_at();

create table if not exists boss_mechanic_policy_audit (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null,
  previous_policy_version integer check (previous_policy_version is null or previous_policy_version > 0),
  new_policy_version integer not null check (new_policy_version > 0),
  before_state jsonb check (before_state is null or jsonb_typeof(before_state) = 'object'),
  after_state jsonb not null check (jsonb_typeof(after_state) = 'object'),
  reason text not null check (nullif(btrim(reason), '') is not null),
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  foreign key (boss_id, difficulty, mechanic_key)
    references boss_mechanic_policy (boss_id, difficulty, mechanic_key) on delete restrict
);

create index if not exists boss_mechanic_policy_audit_scope_idx
  on boss_mechanic_policy_audit (boss_id, difficulty, mechanic_key, changed_at desc);

create table if not exists boss_mechanic_aliases (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null,
  ability_id bigint check (ability_id is null or ability_id > 0),
  normalized_name text check (normalized_name is null or nullif(btrim(normalized_name), '') is not null),
  source text not null check (source in ('journal', 'wcl', 'manual', 'classifier', 'legacy')),
  confidence text not null check (confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (boss_id, difficulty, mechanic_key)
    references boss_mechanic_policy (boss_id, difficulty, mechanic_key) on delete restrict,
  check (ability_id is not null or normalized_name is not null),
  check (confidence <> 'uncertain' or not active)
);

create unique index if not exists boss_mechanic_aliases_ability_key
  on boss_mechanic_aliases (boss_id, difficulty, ability_id)
  where ability_id is not null and active;
create unique index if not exists boss_mechanic_aliases_name_key
  on boss_mechanic_aliases (boss_id, difficulty, normalized_name)
  where normalized_name is not null and active;
create index if not exists boss_mechanic_aliases_mechanic_idx
  on boss_mechanic_aliases (boss_id, difficulty, mechanic_key, active);

drop trigger if exists boss_mechanic_aliases_touch_updated_at on boss_mechanic_aliases;
create trigger boss_mechanic_aliases_touch_updated_at
before update on boss_mechanic_aliases
for each row execute function combat_evaluation_touch_updated_at();

-- Proyecciones/adaptadores aditivos para los objetos existentes. Permanecen
-- nullable hasta que el bloque C publique identidad/policy por scope.
alter table boss_mechanics_candidates
  add column if not exists mechanic_key text,
  add column if not exists policy_version integer check (policy_version is null or policy_version > 0);

alter table pull_mechanic_events
  add column if not exists mechanic_key text;

alter table defensive_plan_slots
  add column if not exists mechanic_key text,
  add column if not exists source_policy_version integer check (source_policy_version is null or source_policy_version > 0);

create index if not exists boss_mechanics_candidates_mechanic_key_idx
  on boss_mechanics_candidates (boss_id, difficulty, mechanic_key)
  where mechanic_key is not null;
create index if not exists pull_mechanic_events_mechanic_key_idx
  on pull_mechanic_events (pull_id, mechanic_key, trigger_time_ms)
  where mechanic_key is not null;
create index if not exists defensive_plan_slots_mechanic_key_idx
  on defensive_plan_slots (plan_version_id, mechanic_key, occurrence_index)
  where mechanic_key is not null;

alter table boss_mechanic_policy enable row level security;
alter table boss_mechanic_policy_audit enable row level security;
alter table boss_mechanic_aliases enable row level security;

drop policy if exists "boss_mechanic_policy: officers read" on boss_mechanic_policy;
create policy "boss_mechanic_policy: officers read"
  on boss_mechanic_policy for select using (is_officer());
drop policy if exists "boss_mechanic_policy_audit: officers read" on boss_mechanic_policy_audit;
create policy "boss_mechanic_policy_audit: officers read"
  on boss_mechanic_policy_audit for select using (is_officer());
drop policy if exists "boss_mechanic_aliases: officers read" on boss_mechanic_aliases;
create policy "boss_mechanic_aliases: officers read"
  on boss_mechanic_aliases for select using (is_officer());

revoke all on boss_mechanic_policy, boss_mechanic_policy_audit, boss_mechanic_aliases from anon, authenticated;
grant select on boss_mechanic_policy, boss_mechanic_policy_audit, boss_mechanic_aliases to authenticated;

comment on table boss_mechanic_policy is
  'Policy causal canónica por boss+dificultad+mechanic_key. display_category es compatibilidad visual, nunca autoridad de culpabilidad.';
comment on table boss_mechanic_aliases is
  'Convergencia versionable de IDs Journal/WCL y nombres normalizados hacia una mechanic_key estable.';
comment on table boss_mechanic_policy_audit is
  'Historial before/after de revisiones de policy; los consumidores persisten policy_version y no reinterpretan planes publicados.';
