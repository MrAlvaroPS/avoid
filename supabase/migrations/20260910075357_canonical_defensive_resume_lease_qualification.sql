-- PostgreSQL resolves OUT parameters of RETURNS TABLE as PL/pgSQL variables.
-- The previous resume path used an unqualified `lease_token` predicate, which
-- becomes ambiguous against the output parameter exactly when a five-minute
-- Edge lease expires. Qualify every request predicate; publication invariants
-- and pointer ownership remain unchanged.

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

  select r.* into runtime
  from canonical_defensive_refresh_dispatch_runtime r
  where r.id = true
  for update;

  if runtime.lease_token is not null and runtime.lease_expires_at <= now() then
    update canonical_defensive_refresh_requests q
    set status = 'pending',
        lease_token = null,
        lease_expires_at = null,
        not_before = now(),
        updated_at = now()
    where q.status = 'running'
      and q.lease_token = runtime.lease_token;

    update canonical_defensive_refresh_dispatch_runtime r
    set lease_token = null,
        lease_report_code = null,
        lease_generation_id = null,
        lease_expires_at = null,
        updated_at = now()
    where r.id = true;

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
  update canonical_defensive_refresh_dispatch_runtime r
  set lease_token = new_token,
      lease_report_code = selected.report_code,
      lease_generation_id = selected.generation_id,
      lease_expires_at = now() + interval '5 minutes',
      updated_at = now()
  where r.id = true;

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

revoke all on function claim_canonical_defensive_refresh_request()
  from public, anon, authenticated;
grant execute on function claim_canonical_defensive_refresh_request()
  to service_role;

select dispatch_canonical_defensive_refresh_async()
where exists (
  select 1
  from canonical_defensive_refresh_requests q
  where q.status in ('pending', 'running')
);
