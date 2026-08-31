-- Planificador defensivo v2: separa el catálogo genérico de los valores por
-- spec, aplica modificadores del build real y guarda calendarios por jugador
-- y ocurrencia. Las tablas antiguas de mechanic_defensive_assignments se
-- conservan intactas como plantillas/curación manual.

alter table boss_mechanic_defensive_profile
  add column if not exists reference_cast_offsets_by_fight jsonb not null default '[]'::jsonb;

comment on column boss_mechanic_defensive_profile.reference_cast_offsets_by_fight is
  'Timings conservando el fight de origen: [{fightKey, offsetsMs[]}]. Permite alinear ocurrencias por ordinal sin inferirlas desde un array mezclado; reference_cast_offset_ms_samples queda como fallback histórico.';

create table if not exists defensive_spec_profiles (
  class text not null,
  spec text not null,
  spell_id bigint not null,
  base_cooldown_ms integer,
  base_duration_ms integer,
  charges smallint not null default 1 check (charges > 0),
  source text,
  source_note text,
  synced_from_commit text,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (class, spec, spell_id)
);

comment on table defensive_spec_profiles is
  'Comportamiento base de un defensivo para una spec concreta. Gana sobre cooldown_catalog al planificar; evita fingir que un spell compartido tiene el mismo CD en todas las specs.';

create table if not exists defensive_modifier_rules (
  id uuid primary key default gen_random_uuid(),
  class text not null,
  specs text[],
  modifier_spell_id bigint not null,
  target_spell_id bigint not null,
  operation text not null check (operation in ('subtract_ms', 'add_ms', 'multiply', 'set_ms', 'charges_add')),
  value numeric not null,
  per_rank boolean not null default false,
  condition text not null default 'always' check (condition in ('always', 'conditional')),
  description text not null,
  source text,
  verified_at timestamptz,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (class, modifier_spell_id, target_spell_id, operation)
);

comment on table defensive_modifier_rules is
  'Reglas declarativas de talentos/pasivas que modifican un defensivo. Las reglas conditional se explican en UI pero no reducen el CD garantizado usado por AUTO.';

create or replace function keep_defensive_reference_material_timestamp()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'defensive_spec_profiles' then
    if (new.base_cooldown_ms, new.base_duration_ms, new.charges)
       is distinct from
       (old.base_cooldown_ms, old.base_duration_ms, old.charges) then
      new.updated_at = now();
    else
      new.updated_at = old.updated_at;
    end if;
  elsif tg_table_name = 'defensive_modifier_rules' then
    if (new.specs, new.modifier_spell_id, new.target_spell_id, new.operation, new.value, new.per_rank, new.condition, new.active)
       is distinct from
       (old.specs, old.modifier_spell_id, old.target_spell_id, old.operation, old.value, old.per_rank, old.condition, old.active) then
      new.updated_at = now();
    else
      new.updated_at = old.updated_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists defensive_spec_profiles_material_timestamp on defensive_spec_profiles;
create trigger defensive_spec_profiles_material_timestamp
before update on defensive_spec_profiles
for each row execute function keep_defensive_reference_material_timestamp();

drop trigger if exists defensive_modifier_rules_material_timestamp on defensive_modifier_rules;
create trigger defensive_modifier_rules_material_timestamp
before update on defensive_modifier_rules
for each row execute function keep_defensive_reference_material_timestamp();

-- Todo valor que el catálogo ya conocía como específico es una base válida.
-- Los combos "Feral/Guardian" se expanden a perfiles independientes.
insert into defensive_spec_profiles
  (class, spec, spell_id, base_cooldown_ms, base_duration_ms, source, source_note, synced_from_commit, verified_at)
select
  catalog.class,
  trim(spec_name),
  catalog.spell_id,
  catalog.base_cooldown_ms,
  catalog.base_duration_ms,
  'cooldown_catalog_spec',
  'Backfill desde una fila del catálogo ya acotada a esta spec.',
  catalog.synced_from_commit,
  now()
from cooldown_catalog catalog
cross join lateral regexp_split_to_table(catalog.spec, '/') spec_name
where catalog.spec is not null
  and catalog.base_cooldown_ms is not null
on conflict (class, spec, spell_id) do nothing;

-- Primer caso verificado que motivó el modelo. El prompt de defensivos v4
-- rellena/corrige el resto del catálogo sin meter ifs por clase en código.
insert into defensive_spec_profiles (class, spec, spell_id, base_cooldown_ms, base_duration_ms, source, verified_at)
values
  ('Monk', 'Mistweaver', 115203, 120000, 15000, 'Verificación de spec: Fortifying Brew', now()),
  ('Monk', 'Windwalker', 115203, 120000, 15000, 'Verificación de spec: Fortifying Brew', now()),
  ('Monk', 'Mistweaver', 243435, 120000, 15000, 'Verificación de spec: Fortifying Brew (variante)', now()),
  ('Monk', 'Windwalker', 243435, 120000, 15000, 'Verificación de spec: Fortifying Brew (variante)', now())
on conflict (class, spec, spell_id) do update set
  base_cooldown_ms = excluded.base_cooldown_ms,
  base_duration_ms = excluded.base_duration_ms,
  source = excluded.source,
  verified_at = excluded.verified_at,
  updated_at = now();

insert into defensive_modifier_rules
  (class, specs, modifier_spell_id, target_spell_id, operation, value, condition, description, source, verified_at)
values
  ('Monk', array['Mistweaver', 'Windwalker'], 388813, 115203, 'subtract_ms', 30000, 'always',
   'Expeditious Fortification reduce 30 s el cooldown de Fortifying Brew.',
   'Talento Expeditious Fortification', now()),
  ('Monk', array['Mistweaver', 'Windwalker'], 388813, 243435, 'subtract_ms', 30000, 'always',
   'Expeditious Fortification reduce 30 s el cooldown de Fortifying Brew.',
   'Talento Expeditious Fortification', now())
on conflict (class, modifier_spell_id, target_spell_id, operation) do update set
  specs = excluded.specs,
  value = excluded.value,
  condition = excluded.condition,
  description = excluded.description,
  source = excluded.source,
  verified_at = excluded.verified_at,
  active = true,
  updated_at = now();

-- Una fila por personaje del roster con la evidencia de combate más reciente.
-- Conserva también el pull de origen para poder explicar antigüedad y detectar
-- cuándo un plan quedó obsoleto tras importar un build nuevo.
create or replace view player_latest_loadout
with (security_invoker = true)
as
select
  r.character_id,
  r.name as player_name,
  r.realm,
  r.class as roster_class,
  latest.class,
  latest.spec,
  latest.talent_build,
  latest.pull_id,
  latest.loadout_observed_at
from wowaudit_roster r
left join lateral (
  select
    p.class,
    p.spec,
    p.talent_build,
    p.pull_id,
    pulls.closed_at as loadout_observed_at
  from player_pull_records p
  join pulls on pulls.id = p.pull_id
  where lower(p.player_name) = lower(r.name)
    and p.class = r.class
    and p.spec is not null
    and p.talent_build is not null
  order by pulls.closed_at desc, p.created_at desc
  limit 1
) latest on true;

comment on view player_latest_loadout is
  'Roster canónico + spec/build de talentos más reciente observado en CombatantInfo. Fuente del Effective Defensive Resolver de Preparación.';

create table if not exists defensive_plan_runs (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  character_id bigint not null,
  player_name text not null,
  class text not null,
  spec text not null,
  talent_spell_ids bigint[] not null default '{}',
  loadout_hash text not null,
  loadout_observed_at timestamptz,
  catalog_version timestamptz,
  mechanic_profile_version timestamptz,
  generated_at timestamptz not null default now(),
  unique (boss_id, difficulty, character_id)
);

create table if not exists defensive_plan_assignments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references defensive_plan_runs(id) on delete cascade,
  window_key text not null,
  planned_time_ms integer not null check (planned_time_ms >= 0),
  impact_score numeric not null default 0,
  priority smallint check (priority between 1 and 5),
  ability_ids bigint[] not null,
  ability_names text[] not null,
  primary_ability_id bigint not null,
  occurrence_index integer not null check (occurrence_index > 0),
  defensive_spell_id bigint not null,
  effective_cooldown_ms integer not null check (effective_cooldown_ms >= 0),
  cooldown_explanation text not null,
  prewarn_seconds integer not null default 5,
  trigger_type text not null default 'bossmod' check (trigger_type in ('bossmod', 'time')),
  bossmod_spell_id bigint,
  bossmod_counter integer,
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (plan_id, window_key)
);

create index if not exists defensive_plan_runs_boss_idx
  on defensive_plan_runs (boss_id, difficulty);
create index if not exists defensive_plan_assignments_plan_idx
  on defensive_plan_assignments (plan_id, planned_time_ms);

-- Sustitución atómica: si una asignación no cumple el contrato, toda la
-- transacción hace rollback y el plan anterior permanece intacto.
create or replace function replace_defensive_plan_v2(p_run jsonb, p_assignments jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_plan_id uuid;
begin
  delete from defensive_plan_runs
  where boss_id = p_run->>'bossId'
    and difficulty = p_run->>'difficulty'
    and character_id = (p_run->>'characterId')::bigint;

  insert into defensive_plan_runs (
    boss_id, difficulty, character_id, player_name, class, spec,
    talent_spell_ids, loadout_hash, loadout_observed_at, catalog_version, mechanic_profile_version, generated_at
  ) values (
    p_run->>'bossId',
    p_run->>'difficulty',
    (p_run->>'characterId')::bigint,
    p_run->>'playerName',
    p_run->>'class',
    p_run->>'spec',
    array(select value::bigint from jsonb_array_elements_text(coalesce(p_run->'talentSpellIds', '[]'::jsonb))),
    p_run->>'loadoutHash',
    nullif(p_run->>'loadoutObservedAt', '')::timestamptz,
    nullif(p_run->>'catalogVersion', '')::timestamptz,
    nullif(p_run->>'mechanicProfileVersion', '')::timestamptz,
    now()
  ) returning id into new_plan_id;

  insert into defensive_plan_assignments (
    plan_id, window_key, planned_time_ms, impact_score, priority,
    ability_ids, ability_names, primary_ability_id, occurrence_index,
    defensive_spell_id, effective_cooldown_ms, cooldown_explanation,
    prewarn_seconds, trigger_type, bossmod_spell_id, bossmod_counter, locked
  )
  select
    new_plan_id,
    item->>'windowKey',
    (item->>'plannedTimeMs')::integer,
    coalesce((item->>'impactScore')::numeric, 0),
    nullif(item->>'priority', '')::smallint,
    array(select value::bigint from jsonb_array_elements_text(item->'abilityIds')),
    array(select value from jsonb_array_elements_text(item->'abilityNames')),
    (item->>'primaryAbilityId')::bigint,
    (item->>'occurrenceIndex')::integer,
    (item->>'defensiveSpellId')::bigint,
    (item->>'effectiveCooldownMs')::integer,
    item->>'cooldownExplanation',
    coalesce((item->>'prewarnSeconds')::integer, 5),
    coalesce(item->>'triggerType', 'bossmod'),
    nullif(item->>'bossmodSpellId', '')::bigint,
    nullif(item->>'bossmodCounter', '')::integer,
    coalesce((item->>'locked')::boolean, false)
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) item;

  return new_plan_id;
end;
$$;

revoke all on function replace_defensive_plan_v2(jsonb, jsonb) from public, anon, authenticated;
grant execute on function replace_defensive_plan_v2(jsonb, jsonb) to service_role;

alter table defensive_spec_profiles enable row level security;
alter table defensive_modifier_rules enable row level security;
alter table defensive_plan_runs enable row level security;
alter table defensive_plan_assignments enable row level security;

create policy "officers read defensive spec profiles"
  on defensive_spec_profiles for select using (is_officer());
create policy "officers read defensive modifier rules"
  on defensive_modifier_rules for select using (is_officer());
create policy "officers read defensive plan runs"
  on defensive_plan_runs for select using (is_officer());
create policy "officers read defensive plan assignments"
  on defensive_plan_assignments for select using (is_officer());

grant select on defensive_spec_profiles to authenticated;
grant select on defensive_modifier_rules to authenticated;
grant select on defensive_plan_runs to authenticated;
grant select on defensive_plan_assignments to authenticated;
grant select on player_latest_loadout to authenticated;
