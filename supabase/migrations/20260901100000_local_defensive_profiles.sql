-- Gestión defensiva v2 · Bloque E · evidencia local separada de world

create table if not exists boss_mechanic_defensive_local_profile (
  boss_id text not null,
  difficulty text not null,
  ability_id bigint not null,
  local_damage_samples numeric[] not null default '{}',
  local_unmitigated_estimate_samples numeric[] not null default '{}',
  local_max_health_pct_samples numeric[] not null default '{}',
  local_player_hit_count_samples integer[] not null default '{}',
  local_death_count integer not null default 0 check (local_death_count >= 0),
  local_near_death_count integer not null default 0 check (local_near_death_count >= 0),
  local_pressure_window_count integer not null default 0 check (local_pressure_window_count >= 0),
  local_sample_pull_count integer not null default 0 check (local_sample_pull_count >= 0),
  local_raid_impact_score numeric,
  local_individual_lethality_score numeric,
  local_priority smallint check (local_priority between 1 and 5),
  local_last_observed_at timestamptz,
  sync_revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  primary key (boss_id, difficulty, ability_id)
);

create index if not exists boss_mechanic_defensive_local_profile_priority_idx
  on boss_mechanic_defensive_local_profile (boss_id, difficulty, local_priority desc, ability_id);

alter table boss_mechanic_defensive_local_profile enable row level security;
drop policy if exists "boss_mechanic_defensive_local_profile: officers read" on boss_mechanic_defensive_local_profile;
create policy "boss_mechanic_defensive_local_profile: officers read"
  on boss_mechanic_defensive_local_profile for select
  using (is_officer());

revoke all on boss_mechanic_defensive_local_profile from anon;
grant select on boss_mechanic_defensive_local_profile to authenticated;

create or replace view boss_mechanic_defensive_planning_view
with (security_invoker = true)
as
with joined as (
  select
    coalesce(world.boss_id, local.boss_id) as boss_id,
    coalesce(world.difficulty, local.difficulty) as difficulty,
    coalesce(world.ability_id, local.ability_id) as ability_id,
    world.reference_sample_fight_count as world_sample_fight_count,
    world.priority as world_priority,
    world.requires_defensive as world_requires_defensive,
    world.requires_defensive_source as world_requires_defensive_source,
    case
      when cardinality(world.reference_unmitigated_damage_samples) > 0 then
        (select percentile_cont(0.5) within group (order by value)
         from unnest(world.reference_unmitigated_damage_samples) as value)
      else null
    end as world_median_unmitigated_damage,
    local.local_sample_pull_count,
    local.local_damage_samples,
    local.local_unmitigated_estimate_samples,
    local.local_max_health_pct_samples,
    local.local_player_hit_count_samples,
    local.local_death_count,
    local.local_near_death_count,
    local.local_pressure_window_count,
    local.local_raid_impact_score,
    local.local_individual_lethality_score,
    local.local_priority,
    local.local_last_observed_at,
    greatest(world.updated_at, local.updated_at) as updated_at
  from boss_mechanic_defensive_profile world
  full outer join boss_mechanic_defensive_local_profile local
    on local.boss_id = world.boss_id
   and local.difficulty = world.difficulty
   and local.ability_id = world.ability_id
)
select
  joined.*,
  case
    when world_requires_defensive_source = 'manual_override' then world_priority
    else greatest(world_priority, local_priority)
  end as combined_planning_priority,
  case
    when world_requires_defensive_source = 'manual_override' then 'manual_override'
    when world_priority is not null and local_priority is not null then 'world+local'
    when local_priority is not null then 'local'
    when world_priority is not null then 'world'
    else 'none'
  end as combined_priority_source
from joined;

revoke all on boss_mechanic_defensive_planning_view from anon;
grant select on boss_mechanic_defensive_planning_view to authenticated;

comment on table boss_mechanic_defensive_local_profile is
  'Agregado idempotente de pulls propios. Nunca contiene ni sobrescribe muestras world.';
comment on view boss_mechanic_defensive_planning_view is
  'Lectura conjunta para planning que conserva columnas y provenance world/local separadas.';
comment on column pull_mechanic_events.player_hit_details is
  'Array de {name, damage_taken, damage_hits, healing_received, used_defensive_spell_id, max_hit_points?}; max_hit_points está disponible en imports nuevos con WCL resources.';
