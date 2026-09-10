-- Night infographic readiness barrier.
--
-- The generic causal queue is global, but a user waiting to send one night's
-- infographics must be able to advance exactly the durable batch created for
-- that report.  Claiming an arbitrary global job can starve the requested
-- report behind unrelated maintenance work and makes "ready before send" an
-- unverifiable promise.

create or replace function claim_combat_evaluation_job_for_batch(
  p_batch_id uuid,
  p_job_type text default 'full_execution_backfill',
  p_lease_seconds integer default 300
)
returns combat_evaluation_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job combat_evaluation_jobs;
begin
  if p_batch_id is null then
    raise exception 'batch_id es obligatorio.' using errcode = '22023';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'lease fuera de rango.' using errcode = '22023';
  end if;

  select * into v_job
  from combat_evaluation_jobs
  where batch_id = p_batch_id
    and (p_job_type is null or job_type = p_job_type)
    and attempts < max_attempts
    and (
      status = 'queued'
      or (status = 'running' and lease_expires_at < now())
    )
  order by created_at
  for update skip locked
  limit 1;

  if not found then return null; end if;

  update combat_evaluation_jobs
  set status = 'running',
      attempts = attempts + 1,
      lease_token = gen_random_uuid(),
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = v_job.id
  returning * into v_job;

  perform refresh_combat_evaluation_batch(v_job.batch_id);
  return v_job;
end;
$$;

comment on function claim_combat_evaluation_job_for_batch(uuid, text, integer) is
  'Service-only targeted claim used by the Night Report readiness barrier. It preserves the existing durable queue/lease contract while preventing unrelated jobs from starving the report being sent.';

revoke all on function claim_combat_evaluation_job_for_batch(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function claim_combat_evaluation_job_for_batch(uuid, text, integer)
  to service_role;
