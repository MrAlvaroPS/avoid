-- Canonical defensive auto-refresh for newly completed reports.
--
-- Problem fixed here: the published defensive generation is intentionally immutable,
-- so a report imported after publication can have valid player_pull_records and V2
-- defensive facts while the v3 infographic sees zero canonical episode rows. The
-- production canonical worker already knows how to build a copy-on-write generation;
-- this migration adds the missing durable trigger/queue/lease layer that starts that
-- worker whenever a report becomes fully ingested.
--
-- Safety properties:
-- - report completion is determined from reports.last_processed_fight_id versus the
--   full report_encounters corpus, not from timing guesses;
-- - requests are idempotent per report_code;
-- - one global lease serializes the global defensive generation worker;
-- - leases expire, so a crashed Edge invocation can be reclaimed;
-- - retry state is persisted, with bounded automatic retries and visible blocked state;
-- - the dispatcher secret is generated in the DB and never committed to source;
-- - pg_net dispatch URL is learned from a real Supabase request (or provisioned at
--   deploy time), so the migration contains no project-specific hostname;
-- - the existing defensive_generation publication guards remain the final authority:
--   this queue can request work but can never publish an incomplete generation.

create table if not exists canonical_defensive_refresh_requests (
  report_code text primary key references reports(code) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'blocked')),
  requested_at timestamptz not null default now(),
  not_before timestamptz not null default now(),
  attempts smallint not null default 0 check (attempts >= 0 and attempts <= 100),
  generation_id uuid references defensive_generations(id),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists canonical_defensive_refresh_requests_claim_idx
  on canonical_defensive_refresh_requests (status, not_before, requested_at);

alter table canonical_defensive_refresh_requests enable row level security;
revoke all on canonical_defensive_refresh_requests from anon, authenticated;

create table if not exists canonical_defensive_refresh_dispatch_runtime (
  id boolean primary key default true check (id),
  dispatch_token uuid not null default gen_random_uuid(),
  function_url text,
  lease_token uuid,
  lease_report_code text references reports(code) on delete set null,
  lease_generation_id uuid references defensive_generations(id),
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into canonical_defensive_refresh_dispatch_runtime (id)
values (true)
on conflict (id) do nothing;

alter table canonical_defensive_refresh_dispatch_runtime enable row level security;
revoke all on canonical_defensive_refresh_dispatch_runtime from anon, authenticated;

create or replace function canonical_defensive_report_ingestion_complete(p_report_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select
      r.is_raid is true
      and r.last_processed_fight_id is not null
      and max(e.fight_id) is not null
      and r.last_processed_fight_id >= max(e.fight_id)
    from reports r
    left join report_encounters e on e.report_code = r.code
    where r.code = p_report_code
    group by r.is_raid, r.last_processed_fight_id
  ), false);
$$;

revoke all on function canonical_defensive_report_ingestion_complete(text) from public, anon, authenticated;
grant execute on function canonical_defensive_report_ingestion_complete(text) to service_role;

create or replace function canonical_defensive_report_needs_refresh(p_report_code text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  eligible_rows integer := 0;
  published_expected_rows integer := 0;
  published_generation_id uuid;
begin
  if not canonical_defensive_report_ingestion_complete(p_report_code) then
    return false;
  end if;

  select count(*) into eligible_rows
  from canonical_defensive_eligible_player_pulls e
  where e.report_code = p_report_code;

  if eligible_rows = 0 then
    return false;
  end if;

  select ptr.published_generation_id
    into published_generation_id
  from defensive_generation_pointer ptr
  where ptr.id = true;

  -- First canonical publication: any completed eligible report is work.
  if published_generation_id is null then
    return true;
  end if;

  select count(*) into published_expected_rows
  from published_defensive_expected_player_pulls e
  where e.report_code = p_report_code;

  -- A build mismatch (or any eligibility drift) must never look like a clean
  -- zero-row report. The worker will either support it or block explicitly.
  if published_expected_rows <> eligible_rows then
    return true;
  end if;

  return exists (
    select 1
    from published_defensive_expected_player_pulls e
    join defensive_generations g on g.id = e.defensive_generation_id
    left join player_pull_defensive_episode_evaluations s
      on s.defensive_generation_id = e.defensive_generation_id
     and s.pull_id = e.pull_id
     and s.player_name = e.player_name
     and s.episode_evaluator_version = g.evaluator_version
     and s.semantic_version = g.semantic_version
     and s.semantic_resolver_version = g.semantic_resolver_version
     and s.resolver_version = g.resolver_version
    where e.report_code = p_report_code
      and s.pull_id is null
  );
end;
$$;

revoke all on function canonical_defensive_report_needs_refresh(text) from public, anon, authenticated;
grant execute on function canonical_defensive_report_needs_refresh(text) to service_role;

create or replace function enqueue_canonical_defensive_refresh(p_report_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not canonical_defensive_report_needs_refresh(p_report_code) then
    return false;
  end if;

  insert into canonical_defensive_refresh_requests (
    report_code,
    status,
    requested_at,
    not_before,
    attempts,
    generation_id,
    lease_token,
    lease_expires_at,
    last_error,
    completed_at,
    updated_at
  ) values (
    p_report_code,
    'pending',
    now(),
    now(),
    0,
    null,
    null,
    null,
    null,
    null,
    now()
  )
  on conflict (report_code) do update
  set requested_at = excluded.requested_at,
      not_before = least(canonical_defensive_refresh_requests.not_before, excluded.not_before),
      status = case
        when canonical_defensive_refresh_requests.status = 'running'
          and canonical_defensive_refresh_requests.lease_expires_at > now()
          then 'running'
        else 'pending'
      end,
      attempts = case
        when canonical_defensive_refresh_requests.status = 'blocked' then 0
        else canonical_defensive_refresh_requests.attempts
      end,
      generation_id = case
        when canonical_defensive_refresh_requests.status = 'running'
          and canonical_defensive_refresh_requests.lease_expires_at > now()
          then canonical_defensive_refresh_requests.generation_id
        else null
      end,
      lease_token = case
        when canonical_defensive_refresh_requests.status = 'running'
          and canonical_defensive_refresh_requests.lease_expires_at > now()
          then canonical_defensive_refresh_requests.lease_token
        else null
      end,
      lease_expires_at = case
        when canonical_defensive_refresh_requests.status = 'running'
          and canonical_defensive_refresh_requests.lease_expires_at > now()
          then canonical_defensive_refresh_requests.lease_expires_at
        else null
      end,
      last_error = null,
      completed_at = null,
      updated_at = now();

  return true;
end;
$$;

revoke all on function enqueue_canonical_defensive_refresh(text) from public, anon, authenticated;
grant execute on function enqueue_canonical_defensive_refresh(text) to service_role;

create or replace function remember_canonical_defensive_dispatch_url_from_request()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  headers jsonb := '{}'::jsonb;
  host text;
  discovered_url text;
  current_url text;
begin
  begin
    headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  exception when others then
    headers := '{}'::jsonb;
  end;

  host := lower(split_part(coalesce(headers ->> 'x-forwarded-host', headers ->> 'host', ''), ':', 1));
  if host ~ '^[a-z0-9-]+\.supabase\.co$' then
    discovered_url := 'https://' || host || '/functions/v1/canonical-defensive-auto-refresh';
    update canonical_defensive_refresh_dispatch_runtime
    set function_url = discovered_url,
        updated_at = now()
    where id = true
      and function_url is distinct from discovered_url;
  end if;

  select function_url into current_url
  from canonical_defensive_refresh_dispatch_runtime
  where id = true;
  return current_url;
end;
$$;

revoke all on function remember_canonical_defensive_dispatch_url_from_request() from public, anon, authenticated;
grant execute on function remember_canonical_defensive_dispatch_url_from_request() to service_role;

create or replace function dispatch_canonical_defensive_refresh_async()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, net, pg_temp
as $$
declare
  target_url text;
  token uuid;
begin
  target_url := remember_canonical_defensive_dispatch_url_from_request();
  select dispatch_token into token
  from canonical_defensive_refresh_dispatch_runtime
  where id = true;

  if target_url is null or token is null then
    -- Queue state is durable; deployment/bootstrap can provision the URL and
    -- call this function later without losing the report request.
    return false;
  end if;

  perform net.http_post(
    url := target_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-iris-dispatch-token', token::text
    ),
    body := jsonb_build_object('action', 'drain'),
    timeout_milliseconds := 5000
  );
  return true;
exception when others then
  -- Never make report ingestion fail because the asynchronous wake-up failed.
  -- The durable request remains pending and can be retried by the next wake-up.
  return false;
end;
$$;

revoke all on function dispatch_canonical_defensive_refresh_async() from public, anon, authenticated;
grant execute on function dispatch_canonical_defensive_refresh_async() to service_role;

create or replace function maybe_enqueue_canonical_defensive_refresh(p_report_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  enqueued boolean;
begin
  enqueued := enqueue_canonical_defensive_refresh(p_report_code);
  if enqueued then
    perform dispatch_canonical_defensive_refresh_async();
  end if;
  return enqueued;
end;
$$;

revoke all on function maybe_enqueue_canonical_defensive_refresh(text) from public, anon, authenticated;
grant execute on function maybe_enqueue_canonical_defensive_refresh(text) to service_role;

create or replace function trigger_canonical_defensive_refresh_from_report()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_raid is true and new.last_processed_fight_id is not null then
    perform maybe_enqueue_canonical_defensive_refresh(new.code);
  end if;
  return new;
end;
$$;

create or replace function trigger_canonical_defensive_refresh_from_encounter()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform maybe_enqueue_canonical_defensive_refresh(new.report_code);
  return new;
end;
$$;

drop trigger if exists reports_canonical_defensive_auto_refresh on reports;
create trigger reports_canonical_defensive_auto_refresh
after insert or update of last_processed_fight_id on reports
for each row execute function trigger_canonical_defensive_refresh_from_report();

drop trigger if exists report_encounters_canonical_defensive_auto_refresh on report_encounters;
create trigger report_encounters_canonical_defensive_auto_refresh
after insert or update of fight_id on report_encounters
for each row execute function trigger_canonical_defensive_refresh_from_encounter();

create or replace function claim_canonical_defensive_refresh_request()
returns table (
  report_code text,
  lease_token uuid,
  attempt smallint
)
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

  -- Recover a crashed chain once its global lease expires.
  if runtime.lease_token is not null and runtime.lease_expires_at <= now() then
    update canonical_defensive_refresh_requests
    set status = 'pending',
        lease_token = null,
        lease_expires_at = null,
        generation_id = null,
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

  -- Clean up requests that a previously published generation already solved.
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

  if not found then
    return;
  end if;

  new_token := gen_random_uuid();

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = new_token,
      lease_report_code = selected.report_code,
      lease_generation_id = null,
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

create or replace function bind_canonical_defensive_refresh_generation(
  p_report_code text,
  p_lease_token uuid,
  p_generation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  update canonical_defensive_refresh_dispatch_runtime
  set lease_generation_id = p_generation_id,
      lease_expires_at = now() + interval '5 minutes',
      updated_at = now()
  where id = true
    and lease_token = p_lease_token
    and lease_report_code = p_report_code
    and lease_expires_at > now();
  get diagnostics changed = row_count;
  if changed = 0 then return false; end if;

  update canonical_defensive_refresh_requests
  set generation_id = p_generation_id,
      lease_expires_at = now() + interval '5 minutes',
      updated_at = now()
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = 'running';
  return found;
end;
$$;

revoke all on function bind_canonical_defensive_refresh_generation(text, uuid, uuid) from public, anon, authenticated;
grant execute on function bind_canonical_defensive_refresh_generation(text, uuid, uuid) to service_role;

create or replace function renew_canonical_defensive_refresh_lease(
  p_report_code text,
  p_lease_token uuid,
  p_generation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  update canonical_defensive_refresh_dispatch_runtime
  set lease_expires_at = now() + interval '5 minutes',
      updated_at = now()
  where id = true
    and lease_token = p_lease_token
    and lease_report_code = p_report_code
    and lease_generation_id = p_generation_id
    and lease_expires_at > now();
  get diagnostics changed = row_count;
  if changed = 0 then return false; end if;

  update canonical_defensive_refresh_requests
  set lease_expires_at = now() + interval '5 minutes',
      updated_at = now()
  where report_code = p_report_code
    and lease_token = p_lease_token
    and generation_id = p_generation_id
    and status = 'running';
  return found;
end;
$$;

revoke all on function renew_canonical_defensive_refresh_lease(text, uuid, uuid) from public, anon, authenticated;
grant execute on function renew_canonical_defensive_refresh_lease(text, uuid, uuid) to service_role;

create or replace function complete_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_generation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  owns_lease boolean;
begin
  select exists (
    select 1
    from canonical_defensive_refresh_dispatch_runtime r
    where r.id = true
      and r.lease_token = p_lease_token
      and r.lease_report_code = p_report_code
      and r.lease_generation_id = p_generation_id
  ) into owns_lease;
  if not owns_lease then return false; end if;

  -- Publication is atomic in the canonical worker. Once it returns done=true,
  -- mark every queued report that the new published pointer now fully covers.
  update canonical_defensive_refresh_requests q
  set status = 'completed',
      completed_at = now(),
      lease_token = null,
      lease_expires_at = null,
      generation_id = coalesce(q.generation_id, p_generation_id),
      last_error = null,
      updated_at = now()
  where q.status in ('pending', 'running')
    and not canonical_defensive_report_needs_refresh(q.report_code);

  -- The active report must be complete after a successful publication. Fail
  -- closed if some unexpected eligibility drift appeared during publication.
  if canonical_defensive_report_needs_refresh(p_report_code) then
    update canonical_defensive_refresh_requests
    set status = 'blocked',
        last_error = 'La generación se publicó, pero el report sigue fuera de cobertura canónica.',
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
    where report_code = p_report_code;
  end if;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;

  return true;
end;
$$;

revoke all on function complete_canonical_defensive_refresh_request(text, uuid, uuid) from public, anon, authenticated;
grant execute on function complete_canonical_defensive_refresh_request(text, uuid, uuid) to service_role;

create or replace function block_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_error text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update canonical_defensive_refresh_requests
  set status = 'blocked',
      last_error = left(coalesce(p_error, 'canonical refresh blocked'), 4000),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = 'running';
  if not found then return false; end if;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;
  return true;
end;
$$;

revoke all on function block_canonical_defensive_refresh_request(text, uuid, text) from public, anon, authenticated;
grant execute on function block_canonical_defensive_refresh_request(text, uuid, text) to service_role;

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
  retry_after_seconds integer;
  will_retry boolean;
begin
  select attempts into current_attempts
  from canonical_defensive_refresh_requests
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = 'running'
  for update;

  if current_attempts is null then
    return jsonb_build_object('retryScheduled', false, 'retryAfterSeconds', 0, 'staleLease', true);
  end if;

  will_retry := current_attempts < 5;
  retry_after_seconds := least(60, greatest(2, (power(2, current_attempts)::integer) * 2));

  update canonical_defensive_refresh_requests
  set status = case when will_retry then 'pending' else 'blocked' end,
      not_before = case when will_retry then now() + make_interval(secs => retry_after_seconds) else not_before end,
      last_error = left(coalesce(p_error, 'canonical refresh failed'), 4000),
      lease_token = null,
      lease_expires_at = null,
      generation_id = null,
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
    'staleLease', false
  );
end;
$$;

revoke all on function fail_canonical_defensive_refresh_request(text, uuid, text) from public, anon, authenticated;
grant execute on function fail_canonical_defensive_refresh_request(text, uuid, text) to service_role;

-- Backfill any already-complete report that arrived after the currently
-- published generation. This is idempotent and intentionally does not publish
-- anything by itself; the dispatcher/worker still owns the lifecycle.
insert into canonical_defensive_refresh_requests (report_code, status, requested_at, not_before, updated_at)
select r.code, 'pending', now(), now(), now()
from reports r
where canonical_defensive_report_needs_refresh(r.code)
on conflict (report_code) do update
set status = case
      when canonical_defensive_refresh_requests.status = 'running'
        and canonical_defensive_refresh_requests.lease_expires_at > now()
        then 'running'
      else 'pending'
    end,
    requested_at = now(),
    not_before = now(),
    completed_at = null,
    last_error = null,
    updated_at = now();
