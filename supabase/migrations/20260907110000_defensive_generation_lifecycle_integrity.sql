-- IRIS canonical defensives: production lifecycle + completeness invariants.
--
-- Root cause fixed here: the first published episode-evaluator@7 generation
-- was an empirical two-report corpus, while defensive_generation_pointer is
-- global. Nothing in the DB proved that a generation covered the full player
-- population later consumed by product. New reports therefore had valid V2
-- facts but zero canonical rows.
--
-- The invariant after this migration is executable, not documentary:
-- build, publication validation and frontend coverage use one eligibility
-- contract; published generations are immutable; refresh is copy-on-write;
-- and neither status nor pointer can be moved to an incomplete generation.

create or replace view canonical_defensive_eligible_player_pulls
with (security_invoker = true) as
select
  p.id as pull_id,
  p.report_code,
  p.fight_id,
  p.boss_id,
  p.difficulty,
  p.pull_number,
  r.player_name,
  r.game_build
from canonical_scored_pulls p
join player_pull_records r on r.pull_id = p.id
where r.game_build is not null
  and r.class is not null
  and r.spec is not null
  and jsonb_typeof(r.talent_build) = 'array';

comment on view canonical_defensive_eligible_player_pulls is
  'Single canonical player/pull eligibility contract for the episode evaluator. A generation additionally filters by its exact game_build.';
revoke all on canonical_defensive_eligible_player_pulls from anon;
grant select on canonical_defensive_eligible_player_pulls to authenticated;

create or replace view published_defensive_expected_player_pulls
with (security_invoker = true) as
select
  e.pull_id,
  e.report_code,
  e.fight_id,
  e.boss_id,
  e.difficulty,
  e.pull_number,
  e.player_name,
  e.game_build,
  g.id as defensive_generation_id
from defensive_generation_pointer ptr
join defensive_generations g on g.id = ptr.published_generation_id
join canonical_defensive_eligible_player_pulls e on e.game_build = g.game_build
where ptr.id = true and g.status = 'published';

comment on view published_defensive_expected_player_pulls is
  'Exact player/pull population expected from the currently published defensive generation.';
revoke all on published_defensive_expected_player_pulls from anon;
grant select on published_defensive_expected_player_pulls to authenticated;

create unique index if not exists defensive_generations_single_building_idx
  on defensive_generations ((status)) where status = 'building';
create unique index if not exists defensive_generations_single_published_idx
  on defensive_generations ((status)) where status = 'published';

create or replace function defensive_generation_expected_ledger_keys(p_generation_id uuid)
returns table (
  pull_id uuid,
  player_name text,
  deduplication_key text,
  event_family text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with generation as (
    select * from defensive_generations where id = p_generation_id
  ), safe_rows as (
    select s.*
    from player_pull_defensive_episode_evaluations s
    join generation g on true
    join canonical_defensive_eligible_player_pulls e
      on e.pull_id = s.pull_id
     and e.player_name = s.player_name
     and e.game_build = g.game_build
    where s.defensive_generation_id = g.id
      and s.episode_evaluator_version = g.evaluator_version
      and s.semantic_version = g.semantic_version
      and s.semantic_resolver_version = g.semantic_resolver_version
      and s.resolver_version = g.resolver_version
  ), episodes as (
    select s.pull_id, s.player_name, ep.value as episode
    from safe_rows s
    cross join lateral jsonb_array_elements(s.episodes) ep(value)
  )
  select
    pull_id,
    player_name,
    p_generation_id::text || ':' || (episode ->> 'episodeId') || ':' || player_name || ':response',
    'response'::text
  from episodes
  where nullif(episode ->> 'episodeId', '') is not null
  union all
  select
    pull_id,
    player_name,
    p_generation_id::text || ':' || (episode ->> 'episodeId') || ':' || player_name || ':plan:' || (episode ->> 'planAssignmentId'),
    'plan'::text
  from episodes
  where nullif(episode ->> 'episodeId', '') is not null
    and nullif(episode ->> 'planAssignmentId', '') is not null
    and nullif(episode ->> 'planVerdict', '') is not null;
$$;
revoke all on function defensive_generation_expected_ledger_keys(uuid) from public, anon, authenticated;
grant execute on function defensive_generation_expected_ledger_keys(uuid) to service_role;

create or replace function defensive_generation_coverage(p_generation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  g defensive_generations%rowtype;
  expected_player_rows integer := 0;
  safe_staged_rows integer := 0;
  missing_player_rows integer := 0;
  extra_staged_rows integer := 0;
  version_drift_rows integer := 0;
  expected_pulls integer := 0;
  staged_pulls integer := 0;
  expected_ledger_events integer := 0;
  actual_ledger_events integer := 0;
  missing_ledger_events integer := 0;
  orphan_ledger_events integer := 0;
begin
  select * into g from defensive_generations where id = p_generation_id;
  if not found then raise exception 'Unknown defensive generation %', p_generation_id; end if;
  if g.evaluator_version is null or g.episode_version is null then
    raise exception 'Generation % has no evaluator/episode version', p_generation_id;
  end if;

  select count(*), count(distinct e.pull_id)
    into expected_player_rows, expected_pulls
  from canonical_defensive_eligible_player_pulls e
  where e.game_build = g.game_build;

  select count(*), count(distinct s.pull_id)
    into safe_staged_rows, staged_pulls
  from player_pull_defensive_episode_evaluations s
  join canonical_defensive_eligible_player_pulls e
    on e.pull_id = s.pull_id
   and e.player_name = s.player_name
   and e.game_build = g.game_build
  where s.defensive_generation_id = g.id
    and s.episode_evaluator_version = g.evaluator_version
    and s.semantic_version = g.semantic_version
    and s.semantic_resolver_version = g.semantic_resolver_version
    and s.resolver_version = g.resolver_version;

  select count(*) into missing_player_rows
  from canonical_defensive_eligible_player_pulls e
  where e.game_build = g.game_build
    and not exists (
      select 1 from player_pull_defensive_episode_evaluations s
      where s.defensive_generation_id = g.id
        and s.pull_id = e.pull_id
        and s.player_name = e.player_name
        and s.episode_evaluator_version = g.evaluator_version
        and s.semantic_version = g.semantic_version
        and s.semantic_resolver_version = g.semantic_resolver_version
        and s.resolver_version = g.resolver_version
    );

  select count(*) into extra_staged_rows
  from player_pull_defensive_episode_evaluations s
  where s.defensive_generation_id = g.id
    and not exists (
      select 1 from canonical_defensive_eligible_player_pulls e
      where e.pull_id = s.pull_id
        and e.player_name = s.player_name
        and e.game_build = g.game_build
    );

  select count(*) into version_drift_rows
  from player_pull_defensive_episode_evaluations s
  join canonical_defensive_eligible_player_pulls e
    on e.pull_id = s.pull_id
   and e.player_name = s.player_name
   and e.game_build = g.game_build
  where s.defensive_generation_id = g.id
    and (
      s.episode_evaluator_version is distinct from g.evaluator_version
      or s.semantic_version is distinct from g.semantic_version
      or s.semantic_resolver_version is distinct from g.semantic_resolver_version
      or s.resolver_version is distinct from g.resolver_version
    );

  select count(*) into expected_ledger_events
  from defensive_generation_expected_ledger_keys(g.id);

  select count(*) into actual_ledger_events
  from player_execution_events e
  where e.defensive_generation_id = g.id
    and e.domain = 'defensive'
    and (e.event_type like 'defensive_episode_%' or e.event_type like 'defensive_plan_%');

  select count(*) into missing_ledger_events
  from defensive_generation_expected_ledger_keys(g.id) k
  where not exists (
    select 1 from player_execution_events e
    where e.defensive_generation_id = g.id
      and e.pull_id = k.pull_id
      and e.player_name = k.player_name
      and e.deduplication_key = k.deduplication_key
  );

  select count(*) into orphan_ledger_events
  from player_execution_events e
  where e.defensive_generation_id = g.id
    and e.domain = 'defensive'
    and (e.event_type like 'defensive_episode_%' or e.event_type like 'defensive_plan_%')
    and not exists (
      select 1 from defensive_generation_expected_ledger_keys(g.id) k
      where k.pull_id = e.pull_id
        and k.player_name = e.player_name
        and k.deduplication_key = e.deduplication_key
    );

  return jsonb_build_object(
    'generationId', g.id,
    'gameBuild', g.game_build,
    'expectedPulls', expected_pulls,
    'stagedPulls', staged_pulls,
    'expectedPlayerRows', expected_player_rows,
    'safeStagedRows', safe_staged_rows,
    'missingPlayerRows', missing_player_rows,
    'extraStagedRows', extra_staged_rows,
    'versionDriftRows', version_drift_rows,
    'expectedLedgerEvents', expected_ledger_events,
    'actualLedgerEvents', actual_ledger_events,
    'missingLedgerEvents', missing_ledger_events,
    'orphanLedgerEvents', orphan_ledger_events,
    'complete',
      missing_player_rows = 0
      and extra_staged_rows = 0
      and version_drift_rows = 0
      and missing_ledger_events = 0
      and orphan_ledger_events = 0
      and expected_ledger_events = actual_ledger_events
  );
end;
$$;
revoke all on function defensive_generation_coverage(uuid) from public, anon, authenticated;
grant execute on function defensive_generation_coverage(uuid) to service_role;

create or replace function assert_defensive_generation_complete(p_generation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare coverage jsonb;
begin
  coverage := defensive_generation_coverage(p_generation_id);
  if coalesce((coverage ->> 'complete')::boolean, false) is not true then
    raise exception 'Defensive generation % is incomplete: %', p_generation_id, coverage::text;
  end if;
  return coverage;
end;
$$;
revoke all on function assert_defensive_generation_complete(uuid) from public, anon, authenticated;
grant execute on function assert_defensive_generation_complete(uuid) to service_role;

create or replace function begin_defensive_generation_refresh(
  p_game_build text,
  p_semantic_version text,
  p_resolver_version text,
  p_semantic_resolver_version text,
  p_episode_version text,
  p_evaluator_version text,
  p_report_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_id uuid;
  parent defensive_generations%rowtype;
  parent_id uuid;
  child_id uuid;
  bad_parent_keys integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('iris:defensive-generation-refresh'));

  select id into existing_id from defensive_generations where status = 'building' limit 1;
  if existing_id is not null then
    if not exists (
      select 1 from defensive_generations g
      where g.id = existing_id
        and g.game_build = p_game_build
        and g.semantic_version = p_semantic_version
        and g.resolver_version = p_resolver_version
        and g.semantic_resolver_version = p_semantic_resolver_version
        and g.episode_version = p_episode_version
        and g.evaluator_version = p_evaluator_version
    ) then
      raise exception 'A different defensive generation is already building: %', existing_id;
    end if;

    -- If a second request asks to refresh an already-cloned report while the
    -- same child is still building, force those rows back into the missing
    -- set. This makes concurrent/manual report refreshes deterministic.
    if p_report_code is not null then
      delete from player_execution_events pe
      where pe.defensive_generation_id = existing_id
        and pe.domain = 'defensive'
        and exists (
          select 1 from canonical_defensive_eligible_player_pulls x
          where x.pull_id = pe.pull_id
            and x.player_name = pe.player_name
            and x.report_code = p_report_code
            and x.game_build = p_game_build
        );
      delete from player_pull_defensive_episode_evaluations s
      where s.defensive_generation_id = existing_id
        and exists (
          select 1 from canonical_defensive_eligible_player_pulls x
          where x.pull_id = s.pull_id
            and x.player_name = s.player_name
            and x.report_code = p_report_code
            and x.game_build = p_game_build
        );
    end if;
    return existing_id;
  end if;

  select ptr.published_generation_id into parent_id
  from defensive_generation_pointer ptr where ptr.id = true for update;
  if parent_id is not null then
    select * into parent from defensive_generations where id = parent_id;
  end if;

  insert into defensive_generations (
    status, semantic_version, resolver_version, semantic_resolver_version,
    episode_version, evaluator_version, game_build, notes
  ) values (
    'building', p_semantic_version, p_resolver_version, p_semantic_resolver_version,
    p_episode_version, p_evaluator_version, p_game_build,
    jsonb_build_object(
      'kind', 'canonical_defensive_production_refresh',
      'startedAt', now(),
      'sourceReportCode', p_report_code,
      'parentGenerationId', parent_id,
      'contract', jsonb_build_object(
        'gameBuild', p_game_build,
        'semanticVersion', p_semantic_version,
        'resolverVersion', p_resolver_version,
        'semanticResolverVersion', p_semantic_resolver_version,
        'episodeVersion', p_episode_version,
        'evaluatorVersion', p_evaluator_version
      )
    )::text
  ) returning id into child_id;

  if parent_id is not null
     and parent.status = 'published'
     and parent.game_build = p_game_build
     and parent.semantic_version = p_semantic_version
     and parent.resolver_version = p_resolver_version
     and parent.semantic_resolver_version = p_semantic_resolver_version
     and parent.episode_version = p_episode_version
     and parent.evaluator_version = p_evaluator_version then

    insert into player_pull_defensive_episode_evaluations (
      defensive_generation_id, pull_id, player_name, episode_evaluator_version,
      semantic_version, semantic_resolver_version, resolver_version,
      build_fingerprint, data_confidence, episodes, evaluated_at
    )
    select
      child_id, s.pull_id, s.player_name, s.episode_evaluator_version,
      s.semantic_version, s.semantic_resolver_version, s.resolver_version,
      s.build_fingerprint, s.data_confidence, s.episodes, s.evaluated_at
    from player_pull_defensive_episode_evaluations s
    join canonical_defensive_eligible_player_pulls e
      on e.pull_id = s.pull_id
     and e.player_name = s.player_name
     and e.game_build = p_game_build
    where s.defensive_generation_id = parent_id
      and s.episode_evaluator_version = p_evaluator_version
      and s.semantic_version = p_semantic_version
      and s.semantic_resolver_version = p_semantic_resolver_version
      and s.resolver_version = p_resolver_version
      and (p_report_code is null or e.report_code <> p_report_code);

    select count(*) into bad_parent_keys
    from player_execution_events e
    join canonical_defensive_eligible_player_pulls x
      on x.pull_id = e.pull_id
     and x.player_name = e.player_name
     and x.game_build = p_game_build
    where e.defensive_generation_id = parent_id
      and e.domain = 'defensive'
      and (p_report_code is null or x.report_code <> p_report_code)
      and e.deduplication_key not like parent_id::text || ':%';
    if bad_parent_keys <> 0 then
      raise exception 'Published defensive ledger has % non-canonical dedupe keys; clone aborted', bad_parent_keys;
    end if;

    insert into player_execution_events (
      pull_id, boss_id, difficulty, player_name, occurrence_id, causal_group_id,
      timestamp_ms, domain, event_type, verdict, reason_code, credit_eligible,
      penalty_eligible, primary_penalty, severity, priority, confidence, evidence,
      policy_version, context_resolver_version, occurrence_resolver_version,
      ledger_evaluator_version, deduplication_key, evaluated_at, defensive_generation_id
    )
    select
      e.pull_id, e.boss_id, e.difficulty, e.player_name, e.occurrence_id, e.causal_group_id,
      e.timestamp_ms, e.domain, e.event_type, e.verdict, e.reason_code, e.credit_eligible,
      e.penalty_eligible, e.primary_penalty, e.severity, e.priority, e.confidence, e.evidence,
      e.policy_version, e.context_resolver_version, e.occurrence_resolver_version,
      e.ledger_evaluator_version,
      child_id::text || substring(e.deduplication_key from length(parent_id::text) + 1),
      e.evaluated_at, child_id
    from player_execution_events e
    join canonical_defensive_eligible_player_pulls x
      on x.pull_id = e.pull_id
     and x.player_name = e.player_name
     and x.game_build = p_game_build
    where e.defensive_generation_id = parent_id
      and e.domain = 'defensive'
      and (p_report_code is null or x.report_code <> p_report_code);
  end if;

  return child_id;
end;
$$;
revoke all on function begin_defensive_generation_refresh(text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function begin_defensive_generation_refresh(text,text,text,text,text,text,text) to service_role;

create or replace function next_missing_defensive_generation_pull(p_generation_id uuid)
returns table (
  pull_id uuid,
  report_code text,
  fight_id integer,
  boss_id text,
  difficulty text,
  expected_player_rows integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with g as (
    select * from defensive_generations where id = p_generation_id and status = 'building'
  ), expected as (
    select e.* from canonical_defensive_eligible_player_pulls e join g on e.game_build = g.game_build
  ), per_pull as (
    select
      e.pull_id,
      min(e.report_code) as report_code,
      min(e.fight_id) as fight_id,
      min(e.boss_id) as boss_id,
      min(e.difficulty) as difficulty,
      count(*)::integer as expected_player_rows,
      count(s.pull_id) filter (
        where s.episode_evaluator_version = g.evaluator_version
          and s.semantic_version = g.semantic_version
          and s.semantic_resolver_version = g.semantic_resolver_version
          and s.resolver_version = g.resolver_version
      )::integer as safe_rows
    from expected e
    join g on true
    left join player_pull_defensive_episode_evaluations s
      on s.defensive_generation_id = g.id
     and s.pull_id = e.pull_id
     and s.player_name = e.player_name
    group by e.pull_id
  ), ledger_bad as (
    select distinct k.pull_id
    from defensive_generation_expected_ledger_keys(p_generation_id) k
    where not exists (
      select 1 from player_execution_events x
      where x.defensive_generation_id = p_generation_id
        and x.pull_id = k.pull_id
        and x.player_name = k.player_name
        and x.deduplication_key = k.deduplication_key
    )
  )
  select p.pull_id, p.report_code, p.fight_id, p.boss_id, p.difficulty, p.expected_player_rows
  from per_pull p
  left join ledger_bad l on l.pull_id = p.pull_id
  where p.safe_rows <> p.expected_player_rows or l.pull_id is not null
  order by p.report_code, p.fight_id, p.pull_id
  limit 1;
$$;
revoke all on function next_missing_defensive_generation_pull(uuid) from public, anon, authenticated;
grant execute on function next_missing_defensive_generation_pull(uuid) to service_role;

create or replace function reset_building_defensive_generation_pull(p_generation_id uuid, p_pull_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from defensive_generations where id = p_generation_id and status = 'building') then
    raise exception 'Generation % is not building', p_generation_id;
  end if;
  delete from player_execution_events
  where defensive_generation_id = p_generation_id and pull_id = p_pull_id and domain = 'defensive';
  delete from player_pull_defensive_episode_evaluations
  where defensive_generation_id = p_generation_id and pull_id = p_pull_id;
end;
$$;
revoke all on function reset_building_defensive_generation_pull(uuid,uuid) from public, anon, authenticated;
grant execute on function reset_building_defensive_generation_pull(uuid,uuid) to service_role;

create or replace function publish_complete_defensive_generation(p_generation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare current_id uuid; coverage jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('iris:defensive-generation-refresh'));
  select published_generation_id into current_id
  from defensive_generation_pointer where id = true for update;
  if not exists (
    select 1 from defensive_generations where id = p_generation_id and status in ('building', 'ready')
  ) then
    raise exception 'Generation % is not publishable from its current status', p_generation_id;
  end if;
  coverage := assert_defensive_generation_complete(p_generation_id);
  update defensive_generations
  set status = 'superseded', superseded_at = now()
  where id = current_id and current_id is distinct from p_generation_id;
  update defensive_generations
  set status = 'published', ready_at = coalesce(ready_at, now()), published_at = coalesce(published_at, now())
  where id = p_generation_id;
  update defensive_generation_pointer
  set published_generation_id = p_generation_id, updated_at = now()
  where id = true;
  return coverage || jsonb_build_object('published', true, 'previousGenerationId', current_id);
end;
$$;
revoke all on function publish_complete_defensive_generation(uuid) from public, anon, authenticated;
grant execute on function publish_complete_defensive_generation(uuid) to service_role;

create or replace function guard_defensive_generation_publication()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    perform assert_defensive_generation_complete(new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists defensive_generation_publication_guard on defensive_generations;
create trigger defensive_generation_publication_guard
before update of status on defensive_generations
for each row execute function guard_defensive_generation_publication();

create or replace function guard_defensive_generation_pointer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.published_generation_id is not null
     and new.published_generation_id is distinct from old.published_generation_id then
    if not exists (
      select 1 from defensive_generations where id = new.published_generation_id and status = 'published'
    ) then
      raise exception 'Pointer target % is not PUBLISHED', new.published_generation_id;
    end if;
    perform assert_defensive_generation_complete(new.published_generation_id);
  end if;
  return new;
end;
$$;
drop trigger if exists defensive_generation_pointer_guard on defensive_generation_pointer;
create trigger defensive_generation_pointer_guard
before update of published_generation_id on defensive_generation_pointer
for each row execute function guard_defensive_generation_pointer();

create or replace function guard_defensive_generation_fact_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare gid uuid; state text;
begin
  if tg_op = 'DELETE' then
    gid := old.defensive_generation_id;
  else
    gid := new.defensive_generation_id;
  end if;
  if gid is not null then
    select status into state from defensive_generations where id = gid;
    if state in ('ready', 'published', 'superseded') then
      raise exception 'Defensive generation % is immutable in status %', gid, state;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists defensive_episode_staging_immutability on player_pull_defensive_episode_evaluations;
create trigger defensive_episode_staging_immutability
before insert or update or delete on player_pull_defensive_episode_evaluations
for each row execute function guard_defensive_generation_fact_mutation();

drop trigger if exists defensive_ledger_immutability on player_execution_events;
create trigger defensive_ledger_immutability
before insert or update or delete on player_execution_events
for each row execute function guard_defensive_generation_fact_mutation();

-- Historical immutable generations remain in the ledger for audit, but product
-- summaries must expose only the singleton published defensive generation.
create or replace view player_pull_execution_summary_v3 as
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
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1 as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  e.defensive_generation_id,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%')::integer as defensive_episode_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.verdict = 'uncertain')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%')::integer as defensive_plan_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
where e.defensive_generation_id is null
   or e.defensive_generation_id = (select published_generation_id from defensive_generation_pointer where id = true)
group by e.pull_id, e.boss_id, e.difficulty, e.player_name, e.ledger_evaluator_version, e.defensive_generation_id;

create or replace view night_player_execution_summary_v3 as
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
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1 as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  e.defensive_generation_id,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%')::integer as defensive_episode_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.verdict = 'uncertain')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%')::integer as defensive_plan_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
join pulls p on p.id = e.pull_id
where e.defensive_generation_id is null
   or e.defensive_generation_id = (select published_generation_id from defensive_generation_pointer where id = true)
group by p.report_code, e.player_name, e.defensive_generation_id;

notify pgrst, 'reload schema';
