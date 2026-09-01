-- Gestión defensiva v2 · Bloque F · plan desplegado y binding histórico

-- Tiempo real del fight, distinto de closed_at (momento en que se importó).
-- Es imprescindible para no asociar retroactivamente un plan actual a un log
-- histórico que se haya importado hoy.
alter table pulls add column if not exists observed_at timestamptz;

update pulls p
set observed_at = to_timestamp((r.start_time + re.start_time) / 1000.0)
from reports r
join report_encounters re on re.report_code = r.code
where p.report_code = re.report_code
  and p.fight_id = re.fight_id
  and p.observed_at is null;

create index if not exists pulls_observed_at_idx on pulls (boss_id, difficulty, observed_at desc);

create table if not exists defensive_plan_versions (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  plan_mode text not null check (plan_mode in ('full', 'partial', 'no_plan')),
  planning_quality text not null check (planning_quality in ('optimal', 'fallback_greedy', 'manual')),
  game_build text,
  solver_version text not null,
  resolver_version text not null,
  backend_resolved boolean not null default false,
  roster_fingerprint text,
  source_profile_revision timestamptz,
  source_catalog_revision timestamptz,
  supersedes_id uuid references defensive_plan_versions (id) on delete restrict,
  uncertainty_margin_ms integer not null default 0 check (uncertainty_margin_ms >= 0),
  fallback_used boolean not null default false,
  roster_snapshot_at timestamptz not null,
  diagnostics jsonb not null default '{}'::jsonb check (jsonb_typeof(diagnostics) = 'object'),
  content_fingerprint text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  published_by uuid references auth.users (id) on delete set null,
  published_at timestamptz,
  notes text,
  check ((status = 'draft' and published_at is null) or (status = 'published' and published_at is not null))
);

create index if not exists defensive_plan_versions_scope_idx
  on defensive_plan_versions (boss_id, difficulty, status, published_at desc);

create table if not exists defensive_plan_members (
  plan_version_id uuid not null references defensive_plan_versions (id) on delete cascade,
  player_key text not null,
  character_id bigint,
  player_name text not null,
  class text not null,
  spec text,
  role text check (role in ('tank', 'healer', 'dps')),
  raid_group smallint check (raid_group between 1 and 8),
  build_fingerprint text,
  game_build text,
  build_observed_at timestamptz,
  build_confidence text not null check (build_confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  included boolean not null default true,
  resolver_version text not null,
  effective_kit jsonb not null check (jsonb_typeof(effective_kit) = 'array'),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  primary key (plan_version_id, player_key)
);

create table if not exists defensive_plan_slots (
  id uuid primary key default gen_random_uuid(),
  plan_version_id uuid not null references defensive_plan_versions (id) on delete cascade,
  ability_id bigint not null check (ability_id > 0),
  occurrence_index integer not null check (occurrence_index > 0),
  slot_index integer not null default 1 check (slot_index > 0),
  occurrence_time_ms integer not null check (occurrence_time_ms >= 0),
  window_start_ms integer not null check (window_start_ms >= 0),
  window_end_ms integer not null check (window_end_ms >= window_start_ms),
  priority smallint check (priority between 1 and 5),
  requirement_level text not null check (requirement_level in ('required', 'recommended', 'optional')),
  demand_type text not null check (demand_type in ('raid', 'personal', 'tank', 'external', 'utility')),
  coverage_status text not null check (coverage_status in ('covered', 'partial', 'uncovered', 'excluded')),
  assigned_player_key text,
  target_player_key text,
  defensive_spell_id bigint check (defensive_spell_id > 0),
  planned_cast_at_ms integer check (planned_cast_at_ms >= 0),
  prewarn_ms integer not null default 5000 check (prewarn_ms >= 0),
  source text not null check (source in ('automatic', 'manual', 'locked', 'emergency', 'fallback')),
  locked boolean not null default false,
  emergency_reserved boolean not null default false,
  confidence text not null check (confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  trigger_mode text not null default 'time' check (trigger_mode in ('time', 'bossmod')),
  bossmod_spell_id bigint,
  bossmod_counter text,
  bossmod_counter_verified boolean not null default false,
  assigned_groups smallint[] check (assigned_groups is null or assigned_groups <@ array[1,2,3,4,5,6,7,8]::smallint[]),
  effective_cooldown_ms_snapshot integer check (effective_cooldown_ms_snapshot is null or effective_cooldown_ms_snapshot >= 0),
  effective_duration_ms_snapshot integer check (effective_duration_ms_snapshot is null or effective_duration_ms_snapshot >= 0),
  charges_snapshot smallint check (charges_snapshot is null or charges_snapshot > 0),
  build_fingerprint_snapshot text,
  notes text,
  rationale jsonb not null default '{}'::jsonb check (jsonb_typeof(rationale) = 'object'),
  created_at timestamptz not null default now(),
  unique (plan_version_id, ability_id, occurrence_index, slot_index),
  foreign key (plan_version_id, assigned_player_key)
    references defensive_plan_members (plan_version_id, player_key),
  foreign key (plan_version_id, target_player_key)
    references defensive_plan_members (plan_version_id, player_key),
  check (
    (coverage_status in ('covered', 'partial') and assigned_player_key is not null and defensive_spell_id is not null and planned_cast_at_ms is not null and charges_snapshot is not null)
    or (coverage_status in ('uncovered', 'excluded') and assigned_player_key is null and defensive_spell_id is null and planned_cast_at_ms is null and charges_snapshot is null)
  ),
  check (trigger_mode = 'time' or bossmod_spell_id is not null),
  check (not bossmod_counter_verified or trigger_mode = 'bossmod')
);

create index if not exists defensive_plan_slots_timeline_idx
  on defensive_plan_slots (plan_version_id, occurrence_time_ms, ability_id, occurrence_index, slot_index);

create table if not exists pull_defensive_plan_binding (
  pull_id uuid primary key references pulls (id) on delete cascade,
  plan_version_id uuid references defensive_plan_versions (id) on delete restrict,
  mode_at_pull text not null check (mode_at_pull in ('full', 'partial', 'no_plan')),
  binding_reason text not null check (binding_reason in ('published_at_fight', 'manual', 'none_available')),
  plan_published_at timestamptz,
  manual_reason text,
  bound_by uuid references auth.users (id) on delete set null,
  bound_at timestamptz not null default now(),
  check (
    (plan_version_id is null and mode_at_pull = 'no_plan' and binding_reason = 'none_available' and plan_published_at is null)
    or (plan_version_id is not null and binding_reason <> 'none_available' and plan_published_at is not null)
  ),
  check ((binding_reason = 'manual' and nullif(btrim(manual_reason), '') is not null) or (binding_reason <> 'manual' and manual_reason is null))
);

create index if not exists pull_defensive_plan_binding_plan_idx
  on pull_defensive_plan_binding (plan_version_id, bound_at desc);

create table if not exists pull_defensive_plan_binding_audit (
  id uuid primary key default gen_random_uuid(),
  pull_id uuid not null references pulls (id) on delete cascade,
  previous_plan_version_id uuid references defensive_plan_versions (id) on delete restrict,
  new_plan_version_id uuid references defensive_plan_versions (id) on delete restrict,
  previous_mode text not null check (previous_mode in ('full', 'partial', 'no_plan')),
  new_mode text not null check (new_mode in ('full', 'partial', 'no_plan')),
  reason text not null check (nullif(btrim(reason), '') is not null),
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now()
);

create or replace function defensive_plan_assert_draft()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_plan_id uuid;
  v_status text;
begin
  if tg_op = 'DELETE' then
    v_plan_id := old.plan_version_id;
  else
    v_plan_id := new.plan_version_id;
  end if;
  select status into v_status from defensive_plan_versions where id = v_plan_id for share;
  if v_status is distinct from 'draft' then
    raise exception 'El contenido de un plan publicado es inmutable.' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists defensive_plan_members_draft_only on defensive_plan_members;
create trigger defensive_plan_members_draft_only
before insert or update or delete on defensive_plan_members
for each row execute function defensive_plan_assert_draft();

drop trigger if exists defensive_plan_slots_draft_only on defensive_plan_slots;
create trigger defensive_plan_slots_draft_only
before insert or update or delete on defensive_plan_slots
for each row execute function defensive_plan_assert_draft();

create or replace function defensive_plan_assert_version_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'Un plan publicado no se puede borrar.' using errcode = '55000';
    end if;
    return old;
  end if;
  if old.status = 'published' then
    raise exception 'Un plan publicado es inmutable.' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists defensive_plan_versions_immutable_published on defensive_plan_versions;
create trigger defensive_plan_versions_immutable_published
before update or delete on defensive_plan_versions
for each row execute function defensive_plan_assert_version_mutation();

create or replace function publish_defensive_plan(p_plan_version_id uuid, p_published_by uuid default null)
returns defensive_plan_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan defensive_plan_versions;
  v_uncovered integer;
  v_assigned integer;
  v_fingerprint text;
  v_current_profile_revision timestamptz;
  v_current_catalog_revision timestamptz;
begin
  select * into v_plan from defensive_plan_versions where id = p_plan_version_id for update;
  if not found then raise exception 'Plan no encontrado.' using errcode = 'P0002'; end if;
  if v_plan.status <> 'draft' then raise exception 'El plan ya está publicado.' using errcode = '55000'; end if;
  if not v_plan.backend_resolved then
    raise exception 'El draft no fue resuelto por backend y no se puede publicar.' using errcode = '23514';
  end if;

  select max(revision) into v_current_profile_revision
  from (
    select max(updated_at) as revision from boss_mechanic_occurrence_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
    union all
    select max(updated_at) from boss_mechanic_defensive_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
    union all
    select max(updated_at) from boss_mechanic_defensive_local_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
  ) revisions;
  if v_plan.source_profile_revision is null or (v_current_profile_revision is not null and v_plan.source_profile_revision < v_current_profile_revision) then
    raise exception 'El perfil de mecánicas cambió; recalcula un draft antes de publicar.' using errcode = '55000';
  end if;

  select max(revision) into v_current_catalog_revision
  from (
    select max(updated_at) as revision from cooldown_catalog
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from defensive_spec_profiles
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from defensive_modifier_rules
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from player_defensive_overrides
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
  ) revisions;
  if v_plan.source_catalog_revision is null or (v_current_catalog_revision is not null and v_plan.source_catalog_revision < v_current_catalog_revision) then
    raise exception 'El catálogo/reglas defensivas cambió; recalcula un draft antes de publicar.' using errcode = '55000';
  end if;

  select
    count(*) filter (where coverage_status in ('partial', 'uncovered')),
    count(*) filter (where assigned_player_key is not null)
  into v_uncovered, v_assigned
  from defensive_plan_slots
  where plan_version_id = p_plan_version_id;

  if v_plan.plan_mode = 'full' and (v_uncovered > 0 or v_assigned = 0) then
    raise exception 'Un plan full debe cubrir todos los slots y contener al menos una asignación.' using errcode = '23514';
  end if;
  if v_plan.plan_mode = 'no_plan' and v_assigned > 0 then
    raise exception 'Un plan no_plan no puede contener asignaciones.' using errcode = '23514';
  end if;

  select md5(
    to_jsonb(v_plan)::text || '|' ||
    coalesce((select jsonb_agg(to_jsonb(m) - 'created_at' order by m.player_key)::text
              from defensive_plan_members m where m.plan_version_id = p_plan_version_id), '[]') || '|' ||
    coalesce((select jsonb_agg(to_jsonb(s) - 'created_at' order by s.occurrence_time_ms, s.ability_id, s.occurrence_index, s.slot_index)::text
              from defensive_plan_slots s where s.plan_version_id = p_plan_version_id), '[]')
  ) into v_fingerprint;

  update defensive_plan_versions
  set status = 'published', published_at = now(), published_by = p_published_by, content_fingerprint = v_fingerprint
  where id = p_plan_version_id
  returning * into v_plan;
  return v_plan;
end;
$$;

create or replace function bind_pull_to_defensive_plan(
  p_pull_id uuid,
  p_plan_version_id uuid,
  p_binding_reason text default 'manual',
  p_bound_by uuid default null,
  p_manual_reason text default null
)
returns pull_defensive_plan_binding
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull pulls;
  v_plan defensive_plan_versions;
  v_binding pull_defensive_plan_binding;
begin
  select * into v_pull from pulls where id = p_pull_id for update;
  if not found then raise exception 'Pull no encontrado.' using errcode = 'P0002'; end if;
  select * into v_plan from defensive_plan_versions where id = p_plan_version_id;
  if not found or v_plan.status <> 'published' then
    raise exception 'Solo se puede desplegar un plan publicado.' using errcode = '23514';
  end if;
  if v_plan.boss_id <> v_pull.boss_id or v_plan.difficulty <> v_pull.difficulty then
    raise exception 'El plan no corresponde al boss y dificultad del pull.' using errcode = '23514';
  end if;
  if p_binding_reason not in ('published_at_fight', 'manual') then
    raise exception 'binding_reason inválido.' using errcode = '23514';
  end if;
  if p_binding_reason = 'manual' and nullif(btrim(p_manual_reason), '') is null then
    raise exception 'Un override manual exige motivo auditable.' using errcode = '23514';
  end if;

  insert into pull_defensive_plan_binding (
    pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
  )
  values (
    p_pull_id, p_plan_version_id, v_plan.plan_mode, p_binding_reason, v_plan.published_at,
    case when p_binding_reason = 'manual' then btrim(p_manual_reason) else null end,
    p_bound_by
  )
  on conflict (pull_id) do nothing
  returning * into v_binding;

  if v_binding.pull_id is null then
    select * into v_binding from pull_defensive_plan_binding where pull_id = p_pull_id;
    if v_binding.plan_version_id is not distinct from p_plan_version_id then return v_binding; end if;
    if p_binding_reason <> 'manual' then
      raise exception 'El pull ya tiene binding; no se reinterpreta automáticamente.' using errcode = '55000';
    end if;
    insert into pull_defensive_plan_binding_audit (
      pull_id, previous_plan_version_id, new_plan_version_id, previous_mode, new_mode, reason, changed_by
    ) values (
      p_pull_id, v_binding.plan_version_id, p_plan_version_id, v_binding.mode_at_pull, v_plan.plan_mode,
      btrim(p_manual_reason), p_bound_by
    );
    update pull_defensive_plan_binding
    set plan_version_id = p_plan_version_id,
        mode_at_pull = v_plan.plan_mode,
        binding_reason = 'manual',
        plan_published_at = v_plan.published_at,
        manual_reason = btrim(p_manual_reason),
        bound_by = p_bound_by,
        bound_at = now()
    where pull_id = p_pull_id
    returning * into v_binding;
  end if;
  return v_binding;
end;
$$;

create or replace function bind_pull_to_current_defensive_plan(p_pull_id uuid)
returns pull_defensive_plan_binding
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pull pulls;
  v_plan_id uuid;
  v_existing pull_defensive_plan_binding;
begin
  select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
  if found then return v_existing; end if;
  select * into v_pull from pulls where id = p_pull_id;
  if not found then raise exception 'Pull no encontrado.' using errcode = 'P0002'; end if;

  if v_pull.observed_at is null then
    insert into pull_defensive_plan_binding (
      pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
    ) values (p_pull_id, null, 'no_plan', 'none_available', null, null, null)
    on conflict (pull_id) do nothing
    returning * into v_existing;
    if v_existing.pull_id is null then
      select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
    end if;
    return v_existing;
  end if;

  select id into v_plan_id
  from defensive_plan_versions
  where boss_id = v_pull.boss_id
    and difficulty = v_pull.difficulty
    and status = 'published'
    and published_at <= v_pull.observed_at
    and (
      game_build is null
      or exists (
        select 1 from player_pull_records record
        where record.pull_id = v_pull.id and record.game_build = defensive_plan_versions.game_build
      )
    )
  order by published_at desc, id
  limit 1;
  if v_plan_id is null then
    insert into pull_defensive_plan_binding (
      pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
    ) values (p_pull_id, null, 'no_plan', 'none_available', null, null, null)
    on conflict (pull_id) do nothing
    returning * into v_existing;
    if v_existing.pull_id is null then
      select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
    end if;
    return v_existing;
  end if;
  return bind_pull_to_defensive_plan(p_pull_id, v_plan_id, 'published_at_fight', null, null);
end;
$$;

alter table defensive_plan_versions enable row level security;
alter table defensive_plan_members enable row level security;
alter table defensive_plan_slots enable row level security;
alter table pull_defensive_plan_binding enable row level security;
alter table pull_defensive_plan_binding_audit enable row level security;

drop policy if exists "defensive_plan_versions: officers read" on defensive_plan_versions;
create policy "defensive_plan_versions: officers read" on defensive_plan_versions for select using (is_officer());
drop policy if exists "defensive_plan_members: officers read" on defensive_plan_members;
create policy "defensive_plan_members: officers read" on defensive_plan_members for select using (is_officer());
drop policy if exists "defensive_plan_slots: officers read" on defensive_plan_slots;
create policy "defensive_plan_slots: officers read" on defensive_plan_slots for select using (is_officer());
drop policy if exists "pull_defensive_plan_binding: officers read" on pull_defensive_plan_binding;
create policy "pull_defensive_plan_binding: officers read" on pull_defensive_plan_binding for select using (is_officer());
drop policy if exists "pull_defensive_plan_binding_audit: officers read" on pull_defensive_plan_binding_audit;
create policy "pull_defensive_plan_binding_audit: officers read" on pull_defensive_plan_binding_audit for select using (is_officer());

revoke all on defensive_plan_versions, defensive_plan_members, defensive_plan_slots, pull_defensive_plan_binding, pull_defensive_plan_binding_audit from anon, authenticated;
grant select on defensive_plan_versions, defensive_plan_members, defensive_plan_slots, pull_defensive_plan_binding, pull_defensive_plan_binding_audit to authenticated;
revoke all on function publish_defensive_plan(uuid, uuid) from public;
revoke all on function bind_pull_to_defensive_plan(uuid, uuid, text, uuid, text) from public;
revoke all on function bind_pull_to_current_defensive_plan(uuid) from public;
grant execute on function publish_defensive_plan(uuid, uuid) to service_role;
grant execute on function bind_pull_to_defensive_plan(uuid, uuid, text, uuid, text) to service_role;
grant execute on function bind_pull_to_current_defensive_plan(uuid) to service_role;

comment on table defensive_plan_versions is
  'Cada ejecución crea una versión. Publicar la vuelve inmutable; una corrección crea otra versión.';
comment on table defensive_plan_members is
  'Snapshot del roster y kit efectivo que el solver vio. Nunca se resuelve de nuevo dentro de un plan publicado.';
comment on table defensive_plan_slots is
  'Asignaciones desplegadas por occurrence. Es la única fuente válida para MRT v2 y evaluator v2.';
comment on table pull_defensive_plan_binding is
  'Versión exacta desplegada para el pull. Una vez ligada no se sustituye silenciosamente.';
comment on table pull_defensive_plan_binding_audit is
  'Única excepción al binding inmutable: override manual de oficial, siempre con motivo y before/after.';
