-- Causalidad v3 · Bloque A / M14 · Player Execution Ledger y views shadow.

create unique index if not exists mechanic_occurrence_evaluations_id_pull_key
  on mechanic_occurrence_evaluations (id, pull_id);

create table if not exists player_execution_events (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null,
  boss_id text not null,
  difficulty text not null,
  player_name text not null check (nullif(btrim(player_name), '') is not null),
  occurrence_id uuid,
  causal_group_id uuid not null,
  timestamp_ms integer not null check (timestamp_ms >= 0),
  domain text not null check (domain in (
    'mechanic', 'defensive', 'external', 'consumable', 'interrupt',
    'dispel', 'utility', 'death', 'preparation'
  )),
  event_type text not null check (nullif(btrim(event_type), '') is not null),
  verdict text not null check (verdict in (
    'success', 'failure', 'correct_hold', 'missed', 'context',
    'not_applicable', 'uncertain'
  )),
  reason_code text not null check (reason_code in (
    'SPREAD_CARRIER_COLLATERAL', 'ASSIGNED_SOAK_MISSED', 'PERSONAL_GROUND_HIT',
    'TANK_FRONTAL_HIT_RAID', 'TANK_SWAP_THRESHOLD_BREACH', 'ASSIGNED_INTERRUPT_MISSED',
    'RAID_INTERRUPT_MISSED', 'VOLUNTEER_MECHANIC_RESOLVED', 'VOLUNTEER_MECHANIC_UNRESOLVED',
    'SELF_FAILURE_DEATH', 'COLLATERAL_DEATH', 'UNAVOIDABLE_PRESSURE_DEATH',
    'POST_WIPE_DEATH', 'UNCERTAIN_CAUSE', 'PLAN_COVERED', 'CORRECT_HOLD',
    'REMINDER_MISSED', 'DEATH_VIABLE_CD', 'VIABLE_CD_NON_PUNITIVE', 'TARGET_MISMATCH',
    'SAFE_EXTRA_USE', 'PREPOT_USED', 'PREPOT_MISSED_VERIFIED', 'HEALTHSTONE_REACTIVE',
    'HEALTHSTONE_VIABLE_NOT_USED', 'HEALTH_POTION_REACTIVE', 'AVAILABILITY_UNKNOWN'
  )),
  credit_eligible boolean not null default false,
  penalty_eligible boolean not null default false,
  primary_penalty boolean not null default false,
  severity numeric check (severity is null or severity between 0 and 100),
  priority smallint check (priority is null or priority between 1 and 5),
  confidence text not null check (confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  policy_version integer check (policy_version is null or policy_version > 0),
  context_resolver_version text not null check (nullif(btrim(context_resolver_version), '') is not null),
  occurrence_resolver_version text check (occurrence_resolver_version is null or nullif(btrim(occurrence_resolver_version), '') is not null),
  ledger_evaluator_version text not null check (nullif(btrim(ledger_evaluator_version), '') is not null),
  deduplication_key text not null check (nullif(btrim(deduplication_key), '') is not null),
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (pull_id, boss_id, difficulty)
    references pulls (id, boss_id, difficulty) on delete cascade,
  foreign key (occurrence_id, pull_id)
    references mechanic_occurrence_evaluations (id, pull_id) on delete cascade,
  unique (pull_id, ledger_evaluator_version, deduplication_key),
  check (not primary_penalty or penalty_eligible),
  check (not penalty_eligible or verdict in ('failure', 'missed')),
  check (not penalty_eligible or confidence in ('verified', 'inferred')),
  check (verdict <> 'uncertain' or (not credit_eligible and not penalty_eligible)),
  check (verdict not in ('context', 'not_applicable') or not penalty_eligible),
  check (reason_code <> 'AVAILABILITY_UNKNOWN' or not penalty_eligible),
  check ((occurrence_id is null) = (occurrence_resolver_version is null))
);

create index if not exists player_execution_events_pull_player_timeline_idx
  on player_execution_events (pull_id, player_name, timestamp_ms);
create index if not exists player_execution_events_player_domain_idx
  on player_execution_events (player_name, domain, verdict, evaluated_at desc);
create index if not exists player_execution_events_occurrence_idx
  on player_execution_events (occurrence_id)
  where occurrence_id is not null;
create index if not exists player_execution_events_penalty_idx
  on player_execution_events (player_name, penalty_eligible, primary_penalty, evaluated_at desc);
create index if not exists player_execution_events_causal_group_idx
  on player_execution_events (causal_group_id, primary_penalty);

alter table player_execution_events enable row level security;
drop policy if exists "player_execution_events: officers read" on player_execution_events;
create policy "player_execution_events: officers read"
  on player_execution_events for select using (is_officer());
revoke all on player_execution_events from anon, authenticated;
grant select on player_execution_events to authenticated;

create or replace view player_pull_execution_summary_v3
with (security_invoker = true)
as
select
  e.pull_id,
  e.boss_id,
  e.difficulty,
  e.player_name,
  e.ledger_evaluator_version,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = 'success')::integer as success_count,
  count(*) filter (where e.verdict in ('failure', 'missed'))::integer as failure_count,
  count(*) filter (where e.verdict = 'correct_hold')::integer as correct_hold_count,
  count(*) filter (where e.verdict = 'uncertain')::integer as uncertain_count,
  count(*) filter (where e.domain = 'mechanic' and e.penalty_eligible)::integer as mechanic_failure_count,
  count(*) filter (where e.domain in ('defensive', 'external') and e.penalty_eligible)::integer as defensive_failure_count,
  count(*) filter (where e.domain = 'consumable' and e.penalty_eligible)::integer as consumable_failure_count,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at
from player_execution_events e
group by e.pull_id, e.boss_id, e.difficulty, e.player_name, e.ledger_evaluator_version;

create or replace view night_player_execution_summary_v3
with (security_invoker = true)
as
select
  p.report_code,
  e.player_name,
  count(distinct e.pull_id)::integer as pull_count,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = 'uncertain')::integer as uncertain_count,
  array_agg(distinct e.ledger_evaluator_version order by e.ledger_evaluator_version) as ledger_evaluator_versions,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.ledger_evaluator_version) = 1
    and count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at
from player_execution_events e
join pulls p on p.id = e.pull_id
group by p.report_code, e.player_name;

create or replace view player_mechanic_offenses_v3
with (security_invoker = true)
as
select
  e.id as execution_event_id,
  e.pull_id,
  e.boss_id,
  e.difficulty,
  e.player_name,
  e.timestamp_ms,
  e.occurrence_id,
  o.mechanic_key,
  o.occurrence_index,
  edge.relationship,
  e.reason_code,
  e.severity,
  e.priority,
  e.confidence,
  e.evidence,
  e.policy_version,
  e.context_resolver_version,
  e.occurrence_resolver_version,
  e.ledger_evaluator_version
from player_execution_events e
join mechanic_occurrence_evaluations o on o.id = e.occurrence_id
join mechanic_responsibility_edges edge
  on edge.occurrence_id = e.occurrence_id
 and edge.player_name = e.player_name
 and edge.penalty_eligible
 and edge.relationship in ('primary_owner', 'co_owner', 'assigned_resolver')
where e.domain = 'mechanic'
  and e.verdict in ('failure', 'missed')
  and e.penalty_eligible;

create or replace view boss_mechanic_execution_stats_v3
with (security_invoker = true)
as
select
  o.boss_id,
  o.difficulty,
  o.mechanic_key,
  o.policy_version,
  o.occurrence_resolver_version,
  count(*)::integer as occurrence_count,
  count(*) filter (where o.outcome = 'success')::integer as success_count,
  count(*) filter (where o.outcome in ('partial_fail', 'fail'))::integer as failure_count,
  count(*) filter (where o.outcome in ('not_evaluable', 'uncertain'))::integer as non_evaluable_count,
  count(distinct o.pull_id)::integer as pull_count,
  max(o.evaluated_at) as evaluated_at
from mechanic_occurrence_evaluations o
group by o.boss_id, o.difficulty, o.mechanic_key, o.policy_version, o.occurrence_resolver_version;

revoke all on player_pull_execution_summary_v3, night_player_execution_summary_v3,
  player_mechanic_offenses_v3, boss_mechanic_execution_stats_v3 from anon;
grant select on player_pull_execution_summary_v3, night_player_execution_summary_v3,
  player_mechanic_offenses_v3, boss_mechanic_execution_stats_v3 to authenticated;

comment on table player_execution_events is
  'Ledger v3 idempotente de decisiones por jugador. Solo filas penalty_eligible con confidence trusted pueden alimentar scoring futuro.';
comment on view player_mechanic_offenses_v3 is
  'Failures mecánicos atribuibles desde ledger+responsibility graph; nunca deriva culpabilidad desde players_hit.';
