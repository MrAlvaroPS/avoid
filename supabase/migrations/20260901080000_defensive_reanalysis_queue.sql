-- Gestión defensiva v2 · Bloque C · cola durable de backfill
--
-- El navegador sigue orquestando una Edge invocation por pull, pero deja de
-- ser la única memoria del trabajo. Cerrar la pestaña conserva queued/error y
-- la siguiente sesión de un oficial puede reanudarlo.

create table if not exists defensive_reanalysis_batches (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (btrim(reason) <> ''),
  scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'completed_with_errors')),
  total_jobs integer not null check (total_jobs >= 0),
  completed_jobs integer not null default 0 check (completed_jobs >= 0),
  failed_jobs integer not null default 0 check (failed_jobs >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists defensive_reanalysis_jobs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references defensive_reanalysis_batches (id) on delete cascade,
  pull_id uuid not null references pulls (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  attempts smallint not null default 0 check (attempts >= 0),
  last_error text,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, pull_id)
);

create index if not exists defensive_reanalysis_jobs_claim_idx
  on defensive_reanalysis_jobs (status, created_at, attempts);
create index if not exists defensive_reanalysis_jobs_pull_idx
  on defensive_reanalysis_jobs (pull_id, created_at desc);

alter table defensive_reanalysis_batches enable row level security;
alter table defensive_reanalysis_jobs enable row level security;

drop policy if exists "defensive_reanalysis_batches: officers read" on defensive_reanalysis_batches;
create policy "defensive_reanalysis_batches: officers read"
  on defensive_reanalysis_batches for select
  using (is_officer());

drop policy if exists "defensive_reanalysis_jobs: officers read" on defensive_reanalysis_jobs;
create policy "defensive_reanalysis_jobs: officers read"
  on defensive_reanalysis_jobs for select
  using (is_officer());

revoke all on defensive_reanalysis_batches from anon;
revoke all on defensive_reanalysis_jobs from anon;
grant select on defensive_reanalysis_batches to authenticated;
grant select on defensive_reanalysis_jobs to authenticated;

create or replace function enqueue_defensive_reanalysis_batch(
  p_pull_ids uuid[],
  p_reason text,
  p_scope jsonb default '{}'::jsonb,
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
begin
  select coalesce(array_agg(distinct pull_id), '{}'::uuid[])
  into v_pull_ids
  from unnest(coalesce(p_pull_ids, '{}'::uuid[])) as value(pull_id);

  if cardinality(v_pull_ids) = 0 then
    return null;
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason is required';
  end if;
  if p_scope is null or jsonb_typeof(p_scope) <> 'object' then
    raise exception 'scope must be a JSON object';
  end if;

  insert into defensive_reanalysis_batches (reason, scope, total_jobs, created_by)
  values (p_reason, p_scope, cardinality(v_pull_ids), p_requested_by)
  returning id into v_batch_id;

  insert into defensive_reanalysis_jobs (batch_id, pull_id)
  select v_batch_id, pull_id
  from unnest(v_pull_ids) as value(pull_id);

  return v_batch_id;
end;
$$;

revoke all on function enqueue_defensive_reanalysis_batch(uuid[], text, jsonb, uuid) from public;
revoke all on function enqueue_defensive_reanalysis_batch(uuid[], text, jsonb, uuid) from anon;
revoke all on function enqueue_defensive_reanalysis_batch(uuid[], text, jsonb, uuid) from authenticated;
grant execute on function enqueue_defensive_reanalysis_batch(uuid[], text, jsonb, uuid) to service_role;

comment on table defensive_reanalysis_batches is
  'Motivo y progreso durable de un backfill defensivo. No ejecuta trabajo dentro de SQL.';
comment on table defensive_reanalysis_jobs is
  'Una unidad reintentable por pull. El cliente/worker invoca una Edge Function por fila para respetar el límite de CPU.';
