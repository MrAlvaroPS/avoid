-- Dossier / player infographic read-path performance.
--
-- Context (2026-09-07): opening a cold NightPlayerSummary fans out several
-- reads through applicable_pull_mechanic_events. The applicability view was
-- resolving "has this mechanic ever been observed in this boss+difficulty?"
-- by joining/scanning the complete pull_mechanic_events history on every
-- read. pg_stat_statements showed the timing-pattern query alone being
-- executed tens of thousands of times and holding PostgREST connections long
-- enough for unrelated reads to fail with PGRST003 (pool acquisition timeout).
--
-- This migration is deliberately semantics-preserving:
--   * it does NOT change scoring, attribution, candidate policy or UI data;
--   * it materializes only the tiny observed identity key set used by the
--     existing EXISTS predicate and maintains exact counts per pull;
--   * applicable_boss_mechanics_candidates keeps the same predicate, replacing
--     only the repeated historical scan with an indexed key lookup;
--   * supporting indexes match the concrete dossier/infographic read paths.

create table if not exists public.pull_mechanic_observation_keys (
  pull_id uuid not null references public.pulls(id) on delete cascade,
  boss_id text not null,
  difficulty text not null,
  normalized_name text not null,
  event_count bigint not null check (event_count > 0),
  primary key (pull_id, normalized_name)
);

create index if not exists pull_mechanic_observation_keys_scope_idx
  on public.pull_mechanic_observation_keys (boss_id, difficulty, normalized_name);

comment on table public.pull_mechanic_observation_keys is
  'Exact compact projection of observed pull_mechanic_events identities per pull. The scope index answers boss+difficulty+mechanic observation without rescanning the event history.';
comment on column public.pull_mechanic_observation_keys.event_count is
  'Number of backing pull_mechanic_events for this pull+normalized mechanic. Exact counts keep replay/delete/update operations free of stale observed keys.';

-- Initial exact projection. ON CONFLICT makes the migration retry-safe without
-- deleting any pre-existing helper rows.
insert into public.pull_mechanic_observation_keys (
  pull_id,
  boss_id,
  difficulty,
  normalized_name,
  event_count
)
select
  p.id,
  p.boss_id,
  p.difficulty,
  lower(btrim(e.mechanic_name)) as normalized_name,
  count(*)::bigint as event_count
from public.pull_mechanic_events e
join public.pulls p on p.id = e.pull_id
where e.mechanic_name is not null
group by p.id, p.boss_id, p.difficulty, lower(btrim(e.mechanic_name))
on conflict (pull_id, normalized_name)
do update set
  boss_id = excluded.boss_id,
  difficulty = excluded.difficulty,
  event_count = excluded.event_count;

-- Keep the helper exact for normal ingestion and for the atomic historical
-- replay primitive (DELETE + bulk INSERT). Transition tables aggregate an
-- entire statement, avoiding a trigger/function call for every event row.
create or replace function public.sync_pull_mechanic_observation_keys_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pull_mechanic_observation_keys as observation (
    pull_id,
    boss_id,
    difficulty,
    normalized_name,
    event_count
  )
  select
    p.id,
    p.boss_id,
    p.difficulty,
    lower(btrim(e.mechanic_name)),
    count(*)::bigint
  from new_rows e
  join public.pulls p on p.id = e.pull_id
  where e.mechanic_name is not null
  group by p.id, p.boss_id, p.difficulty, lower(btrim(e.mechanic_name))
  on conflict (pull_id, normalized_name)
  do update set
    boss_id = excluded.boss_id,
    difficulty = excluded.difficulty,
    event_count = observation.event_count + excluded.event_count;

  return null;
end;
$$;

create or replace function public.sync_pull_mechanic_observation_keys_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Delete keys whose full per-pull population disappeared first, so the
  -- positive-count constraint is never transiently violated.
  with removed as (
    select
      e.pull_id,
      lower(btrim(e.mechanic_name)) as normalized_name,
      count(*)::bigint as removed_count
    from old_rows e
    where e.mechanic_name is not null
    group by e.pull_id, lower(btrim(e.mechanic_name))
  )
  delete from public.pull_mechanic_observation_keys observation
  using removed
  where observation.pull_id = removed.pull_id
    and observation.normalized_name = removed.normalized_name
    and observation.event_count <= removed.removed_count;

  with removed as (
    select
      e.pull_id,
      lower(btrim(e.mechanic_name)) as normalized_name,
      count(*)::bigint as removed_count
    from old_rows e
    where e.mechanic_name is not null
    group by e.pull_id, lower(btrim(e.mechanic_name))
  )
  update public.pull_mechanic_observation_keys observation
     set event_count = observation.event_count - removed.removed_count
    from removed
   where observation.pull_id = removed.pull_id
     and observation.normalized_name = removed.normalized_name;

  return null;
end;
$$;

create or replace function public.sync_pull_mechanic_observation_keys_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Most pull_mechanic_events UPDATEs only change classification fields. Do
  -- nothing unless the identity-bearing pull/name actually changed.
  with changed_old as (
    select o.*
    from old_rows o
    join new_rows n on n.id = o.id
    where o.pull_id is distinct from n.pull_id
       or o.mechanic_name is distinct from n.mechanic_name
  ), removed as (
    select
      e.pull_id,
      lower(btrim(e.mechanic_name)) as normalized_name,
      count(*)::bigint as removed_count
    from changed_old e
    where e.mechanic_name is not null
    group by e.pull_id, lower(btrim(e.mechanic_name))
  )
  delete from public.pull_mechanic_observation_keys observation
  using removed
  where observation.pull_id = removed.pull_id
    and observation.normalized_name = removed.normalized_name
    and observation.event_count <= removed.removed_count;

  with changed_old as (
    select o.*
    from old_rows o
    join new_rows n on n.id = o.id
    where o.pull_id is distinct from n.pull_id
       or o.mechanic_name is distinct from n.mechanic_name
  ), removed as (
    select
      e.pull_id,
      lower(btrim(e.mechanic_name)) as normalized_name,
      count(*)::bigint as removed_count
    from changed_old e
    where e.mechanic_name is not null
    group by e.pull_id, lower(btrim(e.mechanic_name))
  )
  update public.pull_mechanic_observation_keys observation
     set event_count = observation.event_count - removed.removed_count
    from removed
   where observation.pull_id = removed.pull_id
     and observation.normalized_name = removed.normalized_name;

  insert into public.pull_mechanic_observation_keys as observation (
    pull_id,
    boss_id,
    difficulty,
    normalized_name,
    event_count
  )
  select
    p.id,
    p.boss_id,
    p.difficulty,
    lower(btrim(n.mechanic_name)),
    count(*)::bigint
  from new_rows n
  join old_rows o on o.id = n.id
  join public.pulls p on p.id = n.pull_id
  where (o.pull_id is distinct from n.pull_id
      or o.mechanic_name is distinct from n.mechanic_name)
    and n.mechanic_name is not null
  group by p.id, p.boss_id, p.difficulty, lower(btrim(n.mechanic_name))
  on conflict (pull_id, normalized_name)
  do update set
    boss_id = excluded.boss_id,
    difficulty = excluded.difficulty,
    event_count = observation.event_count + excluded.event_count;

  return null;
end;
$$;

drop trigger if exists pull_mechanic_observation_keys_insert on public.pull_mechanic_events;
create trigger pull_mechanic_observation_keys_insert
after insert on public.pull_mechanic_events
referencing new table as new_rows
for each statement execute function public.sync_pull_mechanic_observation_keys_insert();

drop trigger if exists pull_mechanic_observation_keys_delete on public.pull_mechanic_events;
create trigger pull_mechanic_observation_keys_delete
after delete on public.pull_mechanic_events
referencing old table as old_rows
for each statement execute function public.sync_pull_mechanic_observation_keys_delete();

drop trigger if exists pull_mechanic_observation_keys_update on public.pull_mechanic_events;
create trigger pull_mechanic_observation_keys_update
after update on public.pull_mechanic_events
referencing old table as old_rows new table as new_rows
for each statement execute function public.sync_pull_mechanic_observation_keys_update();

-- A pull's boss/difficulty is identity and normally immutable, but keep the
-- projection correct if recovery tooling ever repairs that scope in place.
create or replace function public.sync_pull_mechanic_observation_keys_pull_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.pull_mechanic_observation_keys observation
     set boss_id = new.boss_id,
         difficulty = new.difficulty
   where observation.pull_id = new.id
     and (old.boss_id is distinct from new.boss_id
       or old.difficulty is distinct from new.difficulty);
  return new;
end;
$$;

drop trigger if exists pull_mechanic_observation_keys_pull_update on public.pulls;
create trigger pull_mechanic_observation_keys_pull_update
after update of boss_id, difficulty on public.pulls
for each row execute function public.sync_pull_mechanic_observation_keys_pull_update();

-- Exact same applicability contract as before. Only the historical
-- pull_mechanic_events EXISTS is replaced with the compact exact projection.
create or replace view public.applicable_boss_mechanics_candidates
with (security_invoker = true)
as
select candidate.*
from public.boss_mechanics_candidates candidate
where candidate.observed_in_logs is true
   or candidate.observed_in_reference_logs is true
   or candidate.observed_as_interrupt is true
   or coalesce(candidate.reference_occurrences, 0) > 0
   or exists (
     select 1
     from public.pull_mechanic_observation_keys observed
     where observed.boss_id = candidate.boss_id
       and observed.difficulty = candidate.difficulty
       and observed.normalized_name = lower(btrim(candidate.name))
   )
   or (
     candidate.official_difficulty_applicable is distinct from false
     and (
       candidate.reference_source_report is null
       or not exists (
         select 1
         from public.boss_mechanics_candidates other
         where other.boss_id = candidate.boss_id
           and other.ability_id = candidate.ability_id
           and other.difficulty <> candidate.difficulty
           and (
             other.observed_in_logs is true
             or other.observed_in_reference_logs is true
             or other.observed_as_interrupt is true
             or coalesce(other.reference_occurrences, 0) > 0
           )
           and case other.difficulty
                 when 'LFR' then 1
                 when 'Normal' then 3
                 when 'Heroic' then 4
                 when 'Mythic' then 5
                 else 0
               end
               > case candidate.difficulty
                   when 'LFR' then 1
                   when 'Normal' then 3
                   when 'Heroic' then 4
                   when 'Mythic' then 5
                   else 0
                 end
       )
     )
   );

-- Concrete read paths observed in the dossier/infographic.
create index if not exists player_pull_records_player_pull_idx
  on public.player_pull_records (player_name, pull_id);

create index if not exists pull_mechanic_events_ability_pull_time_idx
  on public.pull_mechanic_events (ability_id, pull_id, trigger_time_ms);

create index if not exists pull_mechanic_events_players_hit_names_gin_idx
  on public.pull_mechanic_events using gin (players_hit_names);

create index if not exists boss_mechanics_candidates_scope_normalized_name_idx
  on public.boss_mechanics_candidates (boss_id, difficulty, lower(btrim(name)));

-- The applicability views are security_invoker=true, so officers need SELECT
-- on the helper just as they already need SELECT on the underlying source
-- tables. No writes are exposed to clients; maintenance is trigger-owned.
alter table public.pull_mechanic_observation_keys enable row level security;

drop policy if exists "pull_mechanic_observation_keys: officers read"
  on public.pull_mechanic_observation_keys;
create policy "pull_mechanic_observation_keys: officers read"
  on public.pull_mechanic_observation_keys
  for select
  to authenticated
  using (is_officer());

revoke all on public.pull_mechanic_observation_keys from anon, authenticated;
grant select on public.pull_mechanic_observation_keys to authenticated;
grant select on public.pull_mechanic_observation_keys to service_role;

revoke all on function public.sync_pull_mechanic_observation_keys_insert() from public, anon, authenticated;
revoke all on function public.sync_pull_mechanic_observation_keys_delete() from public, anon, authenticated;
revoke all on function public.sync_pull_mechanic_observation_keys_update() from public, anon, authenticated;
revoke all on function public.sync_pull_mechanic_observation_keys_pull_update() from public, anon, authenticated;

analyze public.pull_mechanic_observation_keys;
