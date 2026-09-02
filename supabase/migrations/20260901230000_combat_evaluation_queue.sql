-- Causalidad v3 · Bloque B / M11b · cola genérica, durable e idempotente.
-- No reutiliza la cola defensiva: este pipeline encadena contexto, policy,
-- occurrences, ledger y evaluadores causales por pull.

create table if not exists combat_evaluation_batches (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (nullif(btrim(reason), '') is not null),
  scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'completed_with_errors')),
  total_jobs integer not null default 0 check (total_jobs >= 0),
  completed_jobs integer not null default 0 check (completed_jobs between 0 and total_jobs),
  failed_jobs integer not null default 0 check (failed_jobs between 0 and total_jobs),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists combat_evaluation_jobs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references combat_evaluation_batches (id) on delete cascade,
  pull_id uuid not null references pulls (id) on delete cascade,
  job_type text not null check (job_type in (
    'pull_context', 'mechanic_policy', 'mechanic_assignment',
    'consumable_policy', 'full_execution_backfill'
  )),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  stage_progress jsonb not null default '{}'::jsonb check (jsonb_typeof(stage_progress) = 'object'),
  last_error text,
  lease_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pull_id, job_type)
);

create index if not exists combat_evaluation_jobs_claim_idx
  on combat_evaluation_jobs (status, lease_expires_at, created_at, attempts);
create index if not exists combat_evaluation_jobs_batch_idx
  on combat_evaluation_jobs (batch_id, status);

-- La invalidación nace en base de datos, dentro de la misma transacción que
-- cambia la autoridad. Así cerrar el navegador no puede perder la cascada.
create or replace function queue_pull_context_reanalysis()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_old_batch_id uuid;
begin
  select batch_id into v_old_batch_id
  from combat_evaluation_jobs
  where pull_id = new.pull_id and job_type = 'pull_context';
  insert into combat_evaluation_batches (reason, scope, total_jobs, created_by)
  values (
    'pull_evaluation_context_changed',
    jsonb_build_object('pullId', new.pull_id, 'resolverVersion', new.resolver_version),
    1,
    new.reviewed_by
  ) returning id into v_batch_id;

  insert into combat_evaluation_jobs (batch_id, pull_id, job_type, payload)
  values (
    v_batch_id,
    new.pull_id,
    'pull_context',
    jsonb_build_object('contextUpdatedAt', new.updated_at, 'contextResolverVersion', new.resolver_version)
  )
  on conflict (pull_id, job_type) do update set
    batch_id = excluded.batch_id, status = 'queued', attempts = 0,
    payload = excluded.payload, stage_progress = '{}'::jsonb, last_error = null,
    lease_token = null, claimed_at = null, lease_expires_at = null,
    finished_at = null, updated_at = now();
  if v_old_batch_id is not null and v_old_batch_id <> v_batch_id then
    perform refresh_combat_evaluation_batch(v_old_batch_id);
  end if;
  perform refresh_combat_evaluation_batch(v_batch_id);
  return new;
end;
$$;

drop trigger if exists pull_evaluation_context_queue_reanalysis on pull_evaluation_context;
create trigger pull_evaluation_context_queue_reanalysis
after insert or update on pull_evaluation_context
for each row execute function queue_pull_context_reanalysis();

create or replace function refresh_combat_evaluation_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_done integer;
  v_error integer;
  v_running integer;
begin
  select count(*), count(*) filter (where status = 'done'),
         count(*) filter (where status = 'error'), count(*) filter (where status = 'running')
  into v_total, v_done, v_error, v_running
  from combat_evaluation_jobs where batch_id = p_batch_id;

  update combat_evaluation_batches set
    total_jobs = v_total,
    completed_jobs = v_done,
    failed_jobs = v_error,
    status = case
      when v_total > 0 and v_done + v_error = v_total then case when v_error > 0 then 'completed_with_errors' else 'completed' end
      when v_running > 0 or v_done > 0 then 'running'
      else 'queued'
    end,
    started_at = case when (v_running > 0 or v_done > 0 or v_error > 0) then coalesce(started_at, now()) else started_at end,
    finished_at = case when v_total > 0 and v_done + v_error = v_total then coalesce(finished_at, now()) else null end,
    updated_at = now()
  where id = p_batch_id;
end;
$$;

create or replace function enqueue_combat_evaluation_jobs(
  p_pull_ids uuid[],
  p_job_type text,
  p_reason text,
  p_scope jsonb default '{}'::jsonb,
  p_payload jsonb default '{}'::jsonb,
  p_requested_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_pull_ids uuid[];
  v_old_batch_ids uuid[];
  v_old_batch_id uuid;
begin
  if p_job_type not in ('pull_context', 'mechanic_policy', 'mechanic_assignment', 'consumable_policy', 'full_execution_backfill') then
    raise exception 'job_type no soportado.' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason es obligatorio.' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_scope, '{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then
    raise exception 'scope y payload deben ser objetos JSON.' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct pull_id), '{}'::uuid[]) into v_pull_ids
  from unnest(coalesce(p_pull_ids, '{}'::uuid[])) as value(pull_id);
  if cardinality(v_pull_ids) = 0 then return null; end if;

  select coalesce(array_agg(distinct batch_id), '{}'::uuid[]) into v_old_batch_ids
  from combat_evaluation_jobs where pull_id = any(v_pull_ids) and job_type = p_job_type;

  insert into combat_evaluation_batches (reason, scope, total_jobs, created_by)
  values (btrim(p_reason), coalesce(p_scope, '{}'::jsonb), cardinality(v_pull_ids), p_requested_by)
  returning id into v_batch_id;

  insert into combat_evaluation_jobs (batch_id, pull_id, job_type, payload)
  select v_batch_id, pull_id, p_job_type, coalesce(p_payload, '{}'::jsonb)
  from unnest(v_pull_ids) as value(pull_id)
  on conflict (pull_id, job_type) do update set
    batch_id = excluded.batch_id,
    status = 'queued', attempts = 0, payload = excluded.payload,
    stage_progress = '{}'::jsonb, last_error = null, lease_token = null,
    claimed_at = null, lease_expires_at = null, finished_at = null, updated_at = now();

  foreach v_old_batch_id in array v_old_batch_ids loop
    if v_old_batch_id <> v_batch_id then perform refresh_combat_evaluation_batch(v_old_batch_id); end if;
  end loop;
  perform refresh_combat_evaluation_batch(v_batch_id);
  return v_batch_id;
end;
$$;

create or replace function claim_combat_evaluation_job(
  p_job_type text default null,
  p_lease_seconds integer default 300
)
returns combat_evaluation_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_job combat_evaluation_jobs;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 900 then raise exception 'lease fuera de rango.' using errcode = '22023'; end if;
  select * into v_job from combat_evaluation_jobs
  where (p_job_type is null or job_type = p_job_type)
    and attempts < max_attempts
    and (status = 'queued' or (status = 'running' and lease_expires_at < now()))
  order by created_at for update skip locked limit 1;
  if not found then return null; end if;

  update combat_evaluation_jobs set status = 'running', attempts = attempts + 1,
    lease_token = gen_random_uuid(), claimed_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = v_job.id returning * into v_job;
  perform refresh_combat_evaluation_batch(v_job.batch_id);
  return v_job;
end;
$$;

create or replace function finish_combat_evaluation_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_succeeded boolean,
  p_stage_progress jsonb default '{}'::jsonb,
  p_error text default null
)
returns combat_evaluation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare v_job combat_evaluation_jobs;
begin
  update combat_evaluation_jobs set
    status = case when p_succeeded then 'done' else 'error' end,
    stage_progress = coalesce(p_stage_progress, '{}'::jsonb),
    last_error = case when p_succeeded then null else left(coalesce(p_error, 'Error sin detalle.'), 4000) end,
    finished_at = now(), lease_expires_at = null, updated_at = now()
  where id = p_job_id and status = 'running' and lease_token = p_lease_token
  returning * into v_job;
  if not found then raise exception 'Lease inválido o job no ejecutable.' using errcode = '55000'; end if;
  perform refresh_combat_evaluation_batch(v_job.batch_id);
  return v_job;
end;
$$;

alter table combat_evaluation_batches enable row level security;
alter table combat_evaluation_jobs enable row level security;
create policy "combat_evaluation_batches: officers read" on combat_evaluation_batches for select using (is_officer());
create policy "combat_evaluation_jobs: officers read" on combat_evaluation_jobs for select using (is_officer());
revoke all on combat_evaluation_batches, combat_evaluation_jobs from anon, authenticated;
grant select on combat_evaluation_batches, combat_evaluation_jobs to authenticated;
revoke all on function enqueue_combat_evaluation_jobs(uuid[], text, text, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function claim_combat_evaluation_job(text, integer) from public, anon, authenticated;
revoke all on function finish_combat_evaluation_job(uuid, uuid, boolean, jsonb, text) from public, anon, authenticated;
grant execute on function enqueue_combat_evaluation_jobs(uuid[], text, text, jsonb, jsonb, uuid) to service_role;
grant execute on function claim_combat_evaluation_job(text, integer) to service_role;
grant execute on function finish_combat_evaluation_job(uuid, uuid, boolean, jsonb, text) to service_role;

comment on table combat_evaluation_jobs is
  'Cola causal genérica: una unidad idempotente por pull+tipo, lease recuperable y progreso por etapas.';
