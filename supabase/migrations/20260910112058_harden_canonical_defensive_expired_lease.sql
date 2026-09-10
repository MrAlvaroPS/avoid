-- Un lease perdido debe recorrer exactamente la misma recuperación
-- fail-closed y el mismo presupuesto de reintentos que un error capturado.
-- La versión anterior lo devolvía a pending sin consultar attempts, lo que
-- permitía reintentos ilimitados si la plataforma cortaba una invocación.

create or replace function public.claim_canonical_defensive_refresh_request()
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
    -- This RPC publishes an already-complete bound generation through the
    -- guarded lifecycle; otherwise it schedules a bounded retry or BLOCKED.
    perform fail_canonical_defensive_refresh_request(
      runtime.lease_report_code,
      runtime.lease_token,
      'dispatcher lease expired before completion'
    );

    select r.* into runtime
    from canonical_defensive_refresh_dispatch_runtime r
    where r.id = true;
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

  update canonical_defensive_refresh_requests q
  set status = 'blocked',
      last_error = coalesce(q.last_error, 'canonical defensive refresh exhausted five attempts'),
      updated_at = now()
  where q.status = 'pending'
    and q.attempts >= 5
    and canonical_defensive_report_needs_refresh(q.report_code);

  select q.* into selected
  from canonical_defensive_refresh_requests q
  where q.status = 'pending'
    and q.attempts < 5
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

revoke all on function public.claim_canonical_defensive_refresh_request()
  from public, anon, authenticated;
grant execute on function public.claim_canonical_defensive_refresh_request()
  to service_role;

comment on function public.claim_canonical_defensive_refresh_request() is
  'Claim serializado: los leases expirados usan la recuperación exhaustiva y el límite común de cinco intentos.';

select dispatch_canonical_defensive_refresh_async()
where exists (
  select 1
  from canonical_defensive_refresh_requests q
  where q.status in ('pending', 'running')
);
