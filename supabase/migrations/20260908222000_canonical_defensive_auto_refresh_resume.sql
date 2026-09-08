-- Resume hardening for transient failures and expired leases.
--
-- Production review found that a transient worker failure cleared generation_id.
-- The next retry called begin_defensive_generation_refresh(reportCode), whose
-- existing BUILDING behavior deliberately invalidates that report. Result: a
-- timeout on pull N could throw away pulls 1..N-1 and replay the whole report.
-- Preserve the bound generation across automatic retries/lease expiry and let
-- begin_defensive_generation_refresh distinguish an automatic resume from a
-- genuine second/manual refresh request.

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
  is_dispatch_resume boolean := false;
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

    if p_report_code is not null then
      -- Automatic retries keep their already-built rows. A genuine second or
      -- manual refresh has no active queue request bound to this generation,
      -- so it retains the original deterministic invalidation behavior.
      select exists (
        select 1
        from canonical_defensive_refresh_requests q
        where q.report_code = p_report_code
          and q.status = 'running'
          and q.generation_id = existing_id
          and q.lease_expires_at > now()
      ) into is_dispatch_resume;

      if not is_dispatch_resume then
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
revoke all on function begin_defensive_generation_refresh(text,text,text,text,text,text,text)
from public, anon, authenticated;
grant execute on function begin_defensive_generation_refresh(text,text,text,text,text,text,text)
to service_role;

create or replace function claim_canonical_defensive_refresh_request()
returns table (report_code text, lease_token uuid, attempt smallint)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  runtime canonical_defensive_refresh_dispatch_runtime%rowtype;
  selected canonical_defensive_refresh_requests%rowtype;
  new_token uuid;
begin
  perform pg_advisory_xact_lock(hashtext('iris:canonical-defensive-auto-refresh:claim'));

  select * into runtime
  from canonical_defensive_refresh_dispatch_runtime
  where id = true
  for update;

  if runtime.lease_token is not null and runtime.lease_expires_at <= now() then
    update canonical_defensive_refresh_requests
    set status = 'pending',
        lease_token = null,
        lease_expires_at = null,
        -- Preserve generation_id: an expired Edge lease must resume the same
        -- private BUILDING generation instead of replaying completed pulls.
        not_before = now(),
        updated_at = now()
    where status = 'running'
      and lease_token = runtime.lease_token;

    update canonical_defensive_refresh_dispatch_runtime
    set lease_token = null,
        lease_report_code = null,
        lease_generation_id = null,
        lease_expires_at = null,
        updated_at = now()
    where id = true;

    runtime.lease_token := null;
    runtime.lease_expires_at := null;
  end if;

  if runtime.lease_token is not null and runtime.lease_expires_at > now() then
    return;
  end if;

  update canonical_defensive_refresh_requests q
  set status = 'completed',
      completed_at = coalesce(q.completed_at, now()),
      lease_token = null,
      lease_expires_at = null,
      last_error = null,
      updated_at = now()
  where q.status in ('pending', 'running')
    and not canonical_defensive_report_needs_refresh(q.report_code);

  select q.* into selected
  from canonical_defensive_refresh_requests q
  where q.status = 'pending'
    and q.not_before <= now()
    and canonical_defensive_report_needs_refresh(q.report_code)
  order by q.requested_at, q.report_code
  for update skip locked
  limit 1;

  if not found then return; end if;

  new_token := gen_random_uuid();
  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = new_token,
      lease_report_code = selected.report_code,
      lease_generation_id = selected.generation_id,
      lease_expires_at = now() + interval '5 minutes',
      updated_at = now()
  where id = true;

  update canonical_defensive_refresh_requests q
  set status = 'running',
      attempts = q.attempts + 1,
      lease_token = new_token,
      lease_expires_at = now() + interval '5 minutes',
      last_error = null,
      updated_at = now()
  where q.report_code = selected.report_code;

  return query
  select selected.report_code, new_token, (selected.attempts + 1)::smallint;
end;
$$;
revoke all on function claim_canonical_defensive_refresh_request() from public, anon, authenticated;
grant execute on function claim_canonical_defensive_refresh_request() to service_role;

create or replace function fail_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempts integer;
  current_generation_id uuid;
  retry_after_seconds integer;
  will_retry boolean;
  generation_coverage jsonb;
  published_result jsonb;
begin
  select attempts, generation_id
    into current_attempts, current_generation_id
  from canonical_defensive_refresh_requests
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = 'running'
  for update;

  if current_attempts is null then
    return jsonb_build_object(
      'retryScheduled', false,
      'retryAfterSeconds', 0,
      'staleLease', true,
      'recoveredPublished', false
    );
  end if;

  if current_generation_id is not null
     and exists (
       select 1 from defensive_generations g
       where g.id = current_generation_id
         and g.status = 'building'
     ) then
    begin
      generation_coverage := defensive_generation_coverage(current_generation_id);
      if coalesce((generation_coverage ->> 'complete')::boolean, false) then
        published_result := publish_complete_defensive_generation(current_generation_id);

        update canonical_defensive_refresh_requests
        set status = 'completed',
            completed_at = coalesce(completed_at, now()),
            last_error = left(
              'Recovered after worker failure: ' || coalesce(p_error, 'canonical refresh failed'),
              4000
            ),
            lease_token = null,
            lease_expires_at = null,
            generation_id = current_generation_id,
            updated_at = now()
        where report_code = p_report_code
          and lease_token = p_lease_token
          and status = 'running';

        update canonical_defensive_refresh_dispatch_runtime
        set lease_token = null,
            lease_report_code = null,
            lease_generation_id = null,
            lease_expires_at = null,
            updated_at = now()
        where id = true
          and lease_token = p_lease_token;

        return jsonb_build_object(
          'retryScheduled', false,
          'retryAfterSeconds', 0,
          'staleLease', false,
          'recoveredPublished', true,
          'generationId', current_generation_id,
          'coverage', generation_coverage,
          'publication', published_result
        );
      end if;
    exception when others then
      p_error := concat(
        coalesce(p_error, 'canonical refresh failed'),
        ' | complete-generation recovery failed: ',
        sqlerrm
      );
    end;
  end if;

  will_retry := current_attempts < 5;
  retry_after_seconds := least(60, greatest(2, (power(2, current_attempts)::integer) * 2));

  update canonical_defensive_refresh_requests
  set status = case when will_retry then 'pending' else 'blocked' end,
      not_before = case
        when will_retry then now() + make_interval(secs => retry_after_seconds)
        else not_before
      end,
      last_error = left(coalesce(p_error, 'canonical refresh failed'), 4000),
      lease_token = null,
      lease_expires_at = null,
      -- Preserve the private generation so the next automatic retry resumes.
      generation_id = current_generation_id,
      updated_at = now()
  where report_code = p_report_code;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;

  return jsonb_build_object(
    'retryScheduled', will_retry,
    'retryAfterSeconds', case when will_retry then retry_after_seconds else 0 end,
    'staleLease', false,
    'recoveredPublished', false,
    'generationId', current_generation_id
  );
end;
$$;
revoke all on function fail_canonical_defensive_refresh_request(text, uuid, text)
from public, anon, authenticated;
grant execute on function fail_canonical_defensive_refresh_request(text, uuid, text)
to service_role;
