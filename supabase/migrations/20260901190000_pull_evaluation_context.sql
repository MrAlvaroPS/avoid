-- Causalidad v3 · Bloque A / M11 · contexto autoritativo por pull.
-- Aditiva: los campos wipe/ninja legacy se conservan y se proyectan desde la
-- nueva autoridad únicamente cuando se use la RPC de transición.

create table if not exists pull_evaluation_context (
  pull_id uuid primary key references pulls (id) on delete cascade,
  evaluation_eligible boolean not null default true,
  evaluation_start_ms integer not null default 0 check (evaluation_start_ms >= 0),
  evaluation_end_ms integer not null check (evaluation_end_ms >= evaluation_start_ms),
  cutoff_reason text not null check (cutoff_reason in ('fight_end', 'wipe_call', 'invalid_pull')),
  wipe_call_at_ms integer check (wipe_call_at_ms is null or wipe_call_at_ms >= 0),
  wipe_call_boss_hp_pct numeric check (wipe_call_boss_hp_pct is null or wipe_call_boss_hp_pct between 0 and 100),
  wipe_call_source text not null default 'none'
    check (wipe_call_source in ('none', 'manual_rl', 'instrumented', 'inferred')),
  wipe_call_confidence numeric check (wipe_call_confidence is null or wipe_call_confidence between 0 and 100),
  wipe_call_verified boolean not null default false,
  ninja_status text not null default 'unknown'
    check (ninja_status in ('valid', 'probable', 'confirmed', 'unknown')),
  ninja_source text not null default 'imported'
    check (ninja_source in ('manual', 'heuristic', 'imported')),
  ninja_confidence numeric check (ninja_confidence is null or ninja_confidence between 0 and 100),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  resolver_version text not null check (nullif(btrim(resolver_version), '') is not null),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((wipe_call_at_ms is null and wipe_call_source = 'none') or (wipe_call_at_ms is not null and wipe_call_source <> 'none')),
  check (not wipe_call_verified or wipe_call_source in ('manual_rl', 'instrumented')),
  check ((cutoff_reason = 'wipe_call') = (evaluation_eligible and wipe_call_at_ms is not null)),
  check ((cutoff_reason = 'invalid_pull') = (not evaluation_eligible)),
  check (ninja_status <> 'confirmed' or not evaluation_eligible),
  check ((reviewed_by is null and reviewed_at is null and review_reason is null) or (reviewed_at is not null and nullif(btrim(review_reason), '') is not null))
);

create index if not exists pull_evaluation_context_diagnostics_idx
  on pull_evaluation_context (evaluation_eligible, updated_at desc);
create index if not exists pull_evaluation_context_version_idx
  on pull_evaluation_context (resolver_version, updated_at desc);

create table if not exists pull_evaluation_context_audit (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null references pulls (id) on delete cascade,
  before_state jsonb check (before_state is null or jsonb_typeof(before_state) = 'object'),
  after_state jsonb not null check (jsonb_typeof(after_state) = 'object'),
  change_source text not null
    check (change_source in ('manual_rl', 'instrumented', 'inferred', 'heuristic', 'imported', 'migration')),
  reason text not null check (nullif(btrim(reason), '') is not null),
  resolver_version text not null check (nullif(btrim(resolver_version), '') is not null),
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists pull_evaluation_context_audit_pull_idx
  on pull_evaluation_context_audit (pull_id, changed_at desc);

create or replace function combat_evaluation_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pull_evaluation_context_touch_updated_at on pull_evaluation_context;
create trigger pull_evaluation_context_touch_updated_at
before update on pull_evaluation_context
for each row execute function combat_evaluation_touch_updated_at();

-- Conserva exactamente la decisión legacy durante el backfill. Un ninja que
-- ya estaba excluido se considera confirmado por la autoridad anterior; una
-- mera señal no excluida queda como probable y no invalida el pull v3.
insert into pull_evaluation_context (
  pull_id,
  evaluation_eligible,
  evaluation_start_ms,
  evaluation_end_ms,
  cutoff_reason,
  wipe_call_at_ms,
  wipe_call_source,
  wipe_call_confidence,
  wipe_call_verified,
  ninja_status,
  ninja_source,
  ninja_confidence,
  evidence,
  resolver_version,
  created_at,
  updated_at
)
select
  p.id,
  not p.ninja_pull_excluded,
  0,
  case
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    then least(greatest(coalesce(p.duration_ms, 0), 0), greatest((p.wipe_call_signals->>'wipeCallStartMs')::integer, 0))
    else greatest(coalesce(p.duration_ms, 0), 0)
  end,
  case
    when p.ninja_pull_excluded then 'invalid_pull'
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    then 'wipe_call'
    else 'fight_end'
  end,
  case
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    then greatest((p.wipe_call_signals->>'wipeCallStartMs')::integer, 0)
    else null
  end,
  case
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    then 'inferred'
    else 'none'
  end,
  case when p.wipe_call_confidence between 0 and 100 then p.wipe_call_confidence else null end,
  false,
  case when p.ninja_pull_excluded then 'confirmed' when p.is_ninja_pull then 'probable' else 'valid' end,
  case when p.is_ninja_pull or p.ninja_pull_excluded then 'heuristic' else 'imported' end,
  case
    when jsonb_typeof(p.ninja_pull_signals->'confidence') = 'number'
      and (p.ninja_pull_signals->>'confidence')::numeric between 0 and 100
    then (p.ninja_pull_signals->>'confidence')::numeric
    else null
  end,
  jsonb_build_object(
    'legacyBackfill', true,
    'wipeCallSignals', coalesce(p.wipe_call_signals, '{}'::jsonb),
    'ninjaPullSignals', coalesce(p.ninja_pull_signals, '{}'::jsonb)
  ),
  'pull-evaluation-context@1.0.0:legacy-backfill',
  coalesce(p.created_at, now()),
  coalesce(p.updated_at, p.closed_at, now())
from pulls p
on conflict (pull_id) do nothing;

-- Único write path previsto para el bloque B. Actualiza context, audit,
-- proyección legacy y pulls.updated_at dentro de la misma transacción/RPC.
create or replace function set_pull_evaluation_context_v2(
  p_pull_id uuid,
  p_evaluation_eligible boolean,
  p_evaluation_start_ms integer,
  p_evaluation_end_ms integer,
  p_cutoff_reason text,
  p_wipe_call_at_ms integer,
  p_wipe_call_boss_hp_pct numeric,
  p_wipe_call_source text,
  p_wipe_call_confidence numeric,
  p_wipe_call_verified boolean,
  p_ninja_status text,
  p_ninja_source text,
  p_ninja_confidence numeric,
  p_evidence jsonb,
  p_resolver_version text,
  p_reason text,
  p_changed_by uuid default null
)
returns pull_evaluation_context
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull pulls;
  v_before jsonb;
  v_after jsonb;
  v_context pull_evaluation_context;
  v_change_source text;
begin
  select * into v_pull from pulls where id = p_pull_id for update;
  if not found then raise exception 'Pull no encontrado.' using errcode = 'P0002'; end if;
  if p_evaluation_end_ms > greatest(coalesce(v_pull.duration_ms, 0), 0) then
    raise exception 'evaluation_end_ms no puede superar la duración del pull.' using errcode = '23514';
  end if;

  select to_jsonb(c) into v_before from pull_evaluation_context c where c.pull_id = p_pull_id;

  insert into pull_evaluation_context (
    pull_id, evaluation_eligible, evaluation_start_ms, evaluation_end_ms, cutoff_reason,
    wipe_call_at_ms, wipe_call_boss_hp_pct, wipe_call_source, wipe_call_confidence,
    wipe_call_verified, ninja_status, ninja_source, ninja_confidence, evidence,
    resolver_version, reviewed_by, reviewed_at, review_reason
  ) values (
    p_pull_id, p_evaluation_eligible, p_evaluation_start_ms, p_evaluation_end_ms, p_cutoff_reason,
    p_wipe_call_at_ms, p_wipe_call_boss_hp_pct, p_wipe_call_source, p_wipe_call_confidence,
    p_wipe_call_verified, p_ninja_status, p_ninja_source, p_ninja_confidence, coalesce(p_evidence, '{}'::jsonb),
    p_resolver_version,
    case when p_wipe_call_source in ('manual_rl', 'instrumented') or p_ninja_source = 'manual' then p_changed_by else null end,
    case when p_wipe_call_source in ('manual_rl', 'instrumented') or p_ninja_source = 'manual' then now() else null end,
    case when p_wipe_call_source in ('manual_rl', 'instrumented') or p_ninja_source = 'manual' then btrim(p_reason) else null end
  )
  on conflict (pull_id) do update set
    evaluation_eligible = excluded.evaluation_eligible,
    evaluation_start_ms = excluded.evaluation_start_ms,
    evaluation_end_ms = excluded.evaluation_end_ms,
    cutoff_reason = excluded.cutoff_reason,
    wipe_call_at_ms = excluded.wipe_call_at_ms,
    wipe_call_boss_hp_pct = excluded.wipe_call_boss_hp_pct,
    wipe_call_source = excluded.wipe_call_source,
    wipe_call_confidence = excluded.wipe_call_confidence,
    wipe_call_verified = excluded.wipe_call_verified,
    ninja_status = excluded.ninja_status,
    ninja_source = excluded.ninja_source,
    ninja_confidence = excluded.ninja_confidence,
    evidence = excluded.evidence,
    resolver_version = excluded.resolver_version,
    reviewed_by = excluded.reviewed_by,
    reviewed_at = excluded.reviewed_at,
    review_reason = excluded.review_reason
  returning * into v_context;

  v_after := to_jsonb(v_context);
  if v_before is distinct from v_after then
    v_change_source := case
      when p_wipe_call_source in ('manual_rl', 'instrumented') then p_wipe_call_source
      when p_ninja_source = 'manual' then 'manual_rl'
      when p_wipe_call_source = 'inferred' then 'inferred'
      when p_ninja_source = 'heuristic' then 'heuristic'
      else 'imported'
    end;
    insert into pull_evaluation_context_audit (
      pull_id, before_state, after_state, change_source, reason, resolver_version, changed_by
    ) values (
      p_pull_id, v_before, v_after, v_change_source, btrim(p_reason), p_resolver_version, p_changed_by
    );
  end if;

  update pulls
  set wipe_call_excluded = p_wipe_call_at_ms is not null,
      wipe_call_confidence = p_wipe_call_confidence,
      wipe_call_signals = case
        when p_wipe_call_at_ms is null then coalesce(wipe_call_signals, '{}'::jsonb) - 'wipeCallStartMs'
        else jsonb_set(coalesce(wipe_call_signals, '{}'::jsonb), '{wipeCallStartMs}', to_jsonb(p_wipe_call_at_ms), true)
      end,
      is_ninja_pull = p_ninja_status in ('probable', 'confirmed'),
      ninja_pull_excluded = not p_evaluation_eligible or p_ninja_status = 'confirmed',
      ninja_pull_signals = coalesce(p_evidence->'ninjaPullSignals', ninja_pull_signals),
      updated_at = now()
  where id = p_pull_id;

  -- Proyección legacy del mismo intervalo: una muerte solo pertenece al
  -- cierre si su timestamp está en [wipe_call_at_ms, fight_end). Esto evita
  -- que un límite manual nuevo dependa del cluster que propuso el sensor.
  update player_pull_records
  set wipe_call_cluster = case
    when p_wipe_call_at_ms is null then false
    when not died or death_cause is null or jsonb_typeof(death_cause->'timeMs') <> 'number' then false
    else (death_cause->>'timeMs')::numeric >= p_wipe_call_at_ms
  end
  where pull_id = p_pull_id;

  return v_context;
end;
$$;

alter table pull_evaluation_context enable row level security;
alter table pull_evaluation_context_audit enable row level security;

drop policy if exists "pull_evaluation_context: officers read" on pull_evaluation_context;
create policy "pull_evaluation_context: officers read"
  on pull_evaluation_context for select using (is_officer());
drop policy if exists "pull_evaluation_context_audit: officers read" on pull_evaluation_context_audit;
create policy "pull_evaluation_context_audit: officers read"
  on pull_evaluation_context_audit for select using (is_officer());

revoke all on pull_evaluation_context, pull_evaluation_context_audit from anon, authenticated;
grant select on pull_evaluation_context, pull_evaluation_context_audit to authenticated;
revoke all on function set_pull_evaluation_context_v2(uuid, boolean, integer, integer, text, integer, numeric, text, numeric, boolean, text, text, numeric, jsonb, text, text, uuid) from public, anon, authenticated;
grant execute on function set_pull_evaluation_context_v2(uuid, boolean, integer, integer, text, integer, numeric, text, numeric, boolean, text, text, numeric, jsonb, text, text, uuid) to service_role;

comment on table pull_evaluation_context is
  'Autoridad v3 del intervalo evaluable. Flags off mantienen consumidores legacy; la RPC proyecta cada cambio a pulls atómicamente.';
comment on table pull_evaluation_context_audit is
  'Before/after auditable de toda corrección autoritativa de wipe/ninja/context.';
