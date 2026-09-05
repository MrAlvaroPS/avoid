-- Mechanic Attribution Canonical Shadow v1.
--
-- Additive, officer-only and deliberately non-punitive. This table stores how
-- far IRIS can safely attribute a real mechanic occurrence without changing
-- dossier/scoring consumers. Shadow v1 has a DB-enforced invariant:
-- canonical attribution may validate/reduce Attribution Safety v1, but it may
-- never create a new player accusation.

create table if not exists mechanic_attribution_shadow_evaluations (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references mechanic_occurrence_evaluations(id) on delete cascade,
  pull_id uuid not null references pulls(id) on delete cascade,
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null,
  occurrence_index integer not null check (occurrence_index > 0),
  attribution_status text not null check (attribution_status in (
    'verified', 'role_only', 'raid_only', 'unresolved', 'not_applicable'
  )),
  attribution_reason text not null check (attribution_reason in (
    'NO_FAILURE_TO_ATTRIBUTE',
    'OCCURRENCE_NOT_EVALUABLE',
    'IDENTITY_OR_POLICY_MISSING',
    'UNTRUSTED_EVIDENCE',
    'SEMANTIC_CONTRADICTION',
    'RAID_RESPONSIBILITY_ONLY',
    'ROLE_RESPONSIBILITY_ONLY',
    'NO_PUNITIVE_SCOPE',
    'DIRECT_PERSONAL_AVOIDABLE_GROUND',
    'SINGLE_PERSONAL_TARGET',
    'ASSIGNED_PLAYER_VERIFIED',
    'ASSIGNMENT_NOT_MATERIALIZED',
    'MULTI_ACTOR_PERSONAL_FAMILY_REQUIRES_OWNERSHIP',
    'UNSUPPORTED_PERSONAL_FAMILY',
    'PERSONAL_RESPONSIBILITY_WITHOUT_PLAYER_EVIDENCE',
    'SAFETY_V1_GUARD_BLOCKED_NEW_ACCUSATION'
  )),
  responsible_players text[] not null default '{}',
  safety_v1_players text[] not null default '{}',
  new_accusation_players text[] not null default '{}',
  confidence text not null check (confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  evidence_claims jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_claims) = 'array'),
  evaluator_version text not null check (nullif(btrim(evaluator_version), '') is not null),
  occurrence_resolver_version text not null check (nullif(btrim(occurrence_resolver_version), '') is not null),
  policy_version integer not null check (policy_version > 0),
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (occurrence_id, evaluator_version),
  check (array_position(responsible_players, null) is null),
  check (array_position(safety_v1_players, null) is null),
  check (array_position(new_accusation_players, null) is null),
  -- The most important rollout invariant: shadow v1 cannot expand blame.
  check (cardinality(new_accusation_players) = 0),
  check (
    (attribution_status = 'verified' and cardinality(responsible_players) > 0)
    or
    (attribution_status <> 'verified' and cardinality(responsible_players) = 0)
  ),
  check (attribution_status <> 'verified' or confidence in ('verified', 'inferred'))
);

create index if not exists mechanic_attribution_shadow_pull_idx
  on mechanic_attribution_shadow_evaluations (pull_id, occurrence_index);
create index if not exists mechanic_attribution_shadow_status_idx
  on mechanic_attribution_shadow_evaluations (attribution_status, attribution_reason, evaluated_at desc);
create index if not exists mechanic_attribution_shadow_mechanic_idx
  on mechanic_attribution_shadow_evaluations (
    boss_id, difficulty, mechanic_key, occurrence_resolver_version, evaluator_version
  );

alter table mechanic_attribution_shadow_evaluations enable row level security;
drop policy if exists "mechanic_attribution_shadow_evaluations: officers read"
  on mechanic_attribution_shadow_evaluations;
create policy "mechanic_attribution_shadow_evaluations: officers read"
  on mechanic_attribution_shadow_evaluations for select using (is_officer());
revoke all on mechanic_attribution_shadow_evaluations from anon, authenticated;
grant select on mechanic_attribution_shadow_evaluations to authenticated;

create or replace view mechanic_attribution_shadow_report_v1
with (security_invoker = true)
as
select
  p.report_code,
  s.evaluator_version,
  s.occurrence_resolver_version,
  count(*)::integer as occurrence_count,
  count(*) filter (where s.attribution_status = 'verified')::integer as verified_occurrence_count,
  count(*) filter (where s.attribution_status = 'role_only')::integer as role_only_count,
  count(*) filter (where s.attribution_status = 'raid_only')::integer as raid_only_count,
  count(*) filter (where s.attribution_status = 'unresolved')::integer as unresolved_count,
  count(*) filter (where s.attribution_status = 'not_applicable')::integer as not_applicable_count,
  coalesce(sum(cardinality(s.responsible_players)), 0)::integer as canonical_verified_player_count,
  coalesce(sum(cardinality(s.safety_v1_players)), 0)::integer as safety_v1_player_count,
  coalesce(sum(cardinality(s.new_accusation_players)), 0)::integer as new_accusation_count,
  count(distinct s.policy_version)::integer as policy_version_count,
  max(s.evaluated_at) as evaluated_at
from mechanic_attribution_shadow_evaluations s
join pulls p on p.id = s.pull_id
group by p.report_code, s.evaluator_version, s.occurrence_resolver_version;

revoke all on mechanic_attribution_shadow_report_v1 from anon;
grant select on mechanic_attribution_shadow_report_v1 to authenticated;

comment on table mechanic_attribution_shadow_evaluations is
  'Non-punitive mechanic ownership shadow. verified means actor ownership can be defended with current evidence; role_only/raid_only/unresolved never identify a player. new_accusation_players is DB-constrained to empty in shadow v1.';
comment on view mechanic_attribution_shadow_report_v1 is
  'Report-level quality gate for canonical mechanic attribution shadow. UI/scoring must not consume this view during v1 rollout.';
