-- Encola la materialización causal requerida por el informe de noche sin
-- invalidar un lease que otro worker ya esté ejecutando. La clasificación de
-- jobs activos y el upsert ocurren bajo el mismo lock transaccional.

create or replace function public.enqueue_night_infographic_readiness_jobs(
  p_pull_ids uuid[],
  p_report_code text,
  p_readiness_version text,
  p_requested_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pull_ids uuid[];
  v_waiting_pull_ids uuid[] := '{}'::uuid[];
  v_enqueued_pull_ids uuid[] := '{}'::uuid[];
  v_old_batch_ids uuid[] := '{}'::uuid[];
  v_old_batch_id uuid;
  v_batch_id uuid;
begin
  if p_report_code is null or btrim(p_report_code) = '' then
    raise exception 'report_code es obligatorio.' using errcode = '22023';
  end if;
  if p_readiness_version is null or btrim(p_readiness_version) = '' then
    raise exception 'readiness_version es obligatorio.' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct requested.pull_id), '{}'::uuid[])
    into v_pull_ids
  from unnest(coalesce(p_pull_ids, '{}'::uuid[])) as requested(pull_id)
  join canonical_scored_pulls p
    on p.id = requested.pull_id
   and p.report_code = btrim(p_report_code);

  if cardinality(v_pull_ids) = 0 then
    return jsonb_build_object(
      'batchId', null,
      'enqueuedPullIds', '[]'::jsonb,
      'waitingPullIds', '[]'::jsonb
    );
  end if;

  -- Dos preflights simultáneos tampoco deben mover el mismo job entre batches.
  perform pg_advisory_xact_lock(hashtextextended('night-infographic-readiness-enqueue', 0));

  -- claim_combat_evaluation_job usa FOR UPDATE SKIP LOCKED. Mantener estos
  -- locks hasta terminar cierra la carrera lectura -> upsert.
  perform 1
  from combat_evaluation_jobs j
  where j.pull_id = any(v_pull_ids)
    and j.job_type = 'full_execution_backfill'
  for update;

  select coalesce(array_agg(j.pull_id), '{}'::uuid[])
    into v_waiting_pull_ids
  from combat_evaluation_jobs j
  where j.pull_id = any(v_pull_ids)
    and j.job_type = 'full_execution_backfill'
    and j.status = 'running'
    and j.lease_expires_at >= now();

  select coalesce(array_agg(requested.pull_id), '{}'::uuid[])
    into v_enqueued_pull_ids
  from unnest(v_pull_ids) as requested(pull_id)
  where not (requested.pull_id = any(v_waiting_pull_ids));

  if cardinality(v_enqueued_pull_ids) = 0 then
    return jsonb_build_object(
      'batchId', null,
      'enqueuedPullIds', to_jsonb(v_enqueued_pull_ids),
      'waitingPullIds', to_jsonb(v_waiting_pull_ids)
    );
  end if;

  select coalesce(array_agg(distinct j.batch_id), '{}'::uuid[])
    into v_old_batch_ids
  from combat_evaluation_jobs j
  where j.pull_id = any(v_enqueued_pull_ids)
    and j.job_type = 'full_execution_backfill';

  insert into combat_evaluation_batches (reason, scope, total_jobs, created_by)
  values (
    'night_infographic_readiness',
    jsonb_build_object(
      'reportCode', btrim(p_report_code),
      'readinessVersion', btrim(p_readiness_version),
      'waitingOnActiveJobs', cardinality(v_waiting_pull_ids)
    ),
    cardinality(v_enqueued_pull_ids),
    p_requested_by
  )
  returning id into v_batch_id;

  insert into combat_evaluation_jobs (batch_id, pull_id, job_type, payload)
  select
    v_batch_id,
    requested.pull_id,
    'full_execution_backfill',
    jsonb_build_object('nightInfographicReadinessVersion', btrim(p_readiness_version))
  from unnest(v_enqueued_pull_ids) as requested(pull_id)
  on conflict (pull_id, job_type) do update set
    batch_id = excluded.batch_id,
    status = 'queued',
    attempts = 0,
    payload = excluded.payload,
    stage_progress = '{}'::jsonb,
    last_error = null,
    lease_token = null,
    claimed_at = null,
    lease_expires_at = null,
    finished_at = null,
    updated_at = now();

  foreach v_old_batch_id in array v_old_batch_ids loop
    if v_old_batch_id <> v_batch_id then
      perform refresh_combat_evaluation_batch(v_old_batch_id);
    end if;
  end loop;
  perform refresh_combat_evaluation_batch(v_batch_id);

  return jsonb_build_object(
    'batchId', v_batch_id,
    'enqueuedPullIds', to_jsonb(v_enqueued_pull_ids),
    'waitingPullIds', to_jsonb(v_waiting_pull_ids)
  );
end;
$$;

revoke all on function public.enqueue_night_infographic_readiness_jobs(uuid[], text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_night_infographic_readiness_jobs(uuid[], text, text, uuid)
  to service_role;

comment on function public.enqueue_night_infographic_readiness_jobs(uuid[], text, text, uuid) is
  'Encola el ledger requerido por Night Report sin invalidar leases activos; devuelve los pulls encolados y los que deben esperarse.';
