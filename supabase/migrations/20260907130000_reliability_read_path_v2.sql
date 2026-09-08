-- Fiabilidad read-path v2: filtros antes de agregaciones + Response canónico.
--
-- player_pull_reliability_inputs conserva un contrato útil de compatibilidad,
-- pero sus subconsultas correlacionadas repiten applicable_pull_mechanic_events
-- por cada player×pull. En el dosier/Informe eso amplifica mucho el trabajo.
-- Este RPC hace el scope primero y materializa los eventos aplicables una vez.
--
-- La métrica defensiva nueva NO deriva de Management V2 ni de pressure
-- windows. Expone el KPI canónico Response exactamente según
-- defensive-episode-kpis.ts:
--   evaluable = covered_verified + missed_ready + missed_due_to_mistime
--   success   = covered_verified
--   failure   = missed_ready + missed_due_to_mistime
-- uncertain/excluded/unavailable_legitimate/no_applicable_resource no entran.

create or replace function public.get_player_pull_reliability_inputs_v2(
  p_player_name text default null,
  p_since timestamptz default null,
  p_boss_id text default null,
  p_difficulty text default null,
  p_pull_ids uuid[] default null
)
returns table (
  player_name text,
  pull_id uuid,
  boss_id text,
  difficulty text,
  closed_at timestamptz,
  had_avoidable_damage boolean,
  self_positioning_death boolean,
  used_defensive_when_died boolean,
  used_defensive_in_pull boolean,
  defensive_use_opportunity boolean,
  enchanted_slot_count bigint,
  enchantable_slot_count bigint,
  gem_count bigint,
  gemmed_slot_count bigint,
  gemmable_slot_count bigint,
  personal_mechanic_fail_count bigint,
  report_code text,
  pull_number integer,
  avoidable_mechanic_eligible_count bigint,
  avoidable_mechanic_fail_count bigint,
  defensive_window_coverable_count bigint,
  defensive_window_covered_count bigint,
  defensive_window_used_anything boolean,
  unassigned_mechanic_success_count bigint,
  defensive_management_score_v2 numeric,
  defensive_management_decision_count integer,
  defensive_required_count integer,
  defensive_required_success_count integer,
  defensive_required_exact_adherence_count integer,
  defensive_broken_reservation_count integer,
  defensive_death_viable_cd_count integer,
  defensive_evaluation_confidence text,
  defensive_evaluator_version text,
  defensive_resolver_version text,
  defensive_solver_version text,
  defensive_game_build text,
  defensive_build_fingerprint text,
  defensive_evaluated_at timestamptz,
  canonical_response_evaluable_count integer,
  canonical_response_success_count integer,
  canonical_response_failure_count integer,
  canonical_defensive_generation_id uuid,
  canonical_defensive_evaluated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
with base as materialized (
  select
    r.player_name,
    p.id as pull_id,
    p.boss_id,
    p.difficulty,
    p.closed_at,
    p.report_code,
    p.pull_number,
    r.died,
    r.wipe_call_cluster,
    p.wipe_call_excluded,
    r.death_cause,
    r.defensive_casts,
    r.equipped_items,
    r.defensive_pressure_windows,
    p.unassigned_mechanic_occurrences,
    case
      when p.wipe_call_excluded
       and p.wipe_call_signals is not null
       and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
      then (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      else null
    end as cutoff_ms
  from public.player_pull_records r
  join public.pulls p on p.id = r.pull_id
  where not p.ninja_pull_excluded
    and p.ingestion_status = 'complete'
    and (p_player_name is null or r.player_name = p_player_name)
    and (p_since is null or p.closed_at >= p_since)
    and (p_boss_id is null or p.boss_id = p_boss_id)
    and (p_difficulty is null or p.difficulty = p_difficulty)
    and (p_pull_ids is null or r.pull_id = any(p_pull_ids))
),
scoped_pulls as materialized (
  select distinct pull_id, cutoff_ms, unassigned_mechanic_occurrences
  from base
),
events as materialized (
  select
    e.pull_id,
    e.trigger_time_ms,
    e.avoidable,
    e.outcome,
    e.category,
    e.responsibility,
    e.player_hit_details
  from public.applicable_pull_mechanic_events e
  join scoped_pulls sp on sp.pull_id = e.pull_id
  where sp.cutoff_ms is null or e.trigger_time_ms::numeric < sp.cutoff_ms
),
eligible_stats as (
  select
    b.pull_id,
    b.player_name,
    count(*) filter (
      where e.category in ('avoidable-ground', 'spread')
        and (e.responsibility = 'personal' or e.responsibility is null)
        and e.outcome <> 'clean'
        and (
          not b.died
          or (
            jsonb_typeof(b.death_cause->'timeMs') = 'number'
            and (b.death_cause->>'timeMs')::numeric > e.trigger_time_ms
          )
        )
    )::bigint as avoidable_mechanic_eligible_count
  from base b
  left join events e on e.pull_id = b.pull_id
  group by b.pull_id, b.player_name
),
hit_stats as (
  select
    e.pull_id,
    detail->>'name' as player_name,
    bool_or(
      e.avoidable is true
      and e.outcome <> 'clean'
      and coalesce((detail->>'damage_taken')::numeric, 0) > 0
    ) as had_avoidable_damage,
    count(*) filter (
      where e.category in ('avoidable-ground', 'spread', 'soak', 'personal-target')
        and (e.responsibility = 'personal' or e.responsibility is null)
        and e.outcome <> 'clean'
    )::bigint as personal_mechanic_fail_count
  from events e
  cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
  where nullif(detail->>'name', '') is not null
  group by e.pull_id, detail->>'name'
),
avoidable_fail_stats as (
  select
    b.pull_id,
    b.player_name,
    count(*) filter (
      where e.category in ('avoidable-ground', 'spread')
        and (e.responsibility = 'personal' or e.responsibility is null)
        and e.outcome <> 'clean'
        and detail->>'name' = b.player_name
        and (
          not b.died
          or (
            jsonb_typeof(b.death_cause->'timeMs') = 'number'
            and (b.death_cause->>'timeMs')::numeric > e.trigger_time_ms
          )
        )
    )::bigint as avoidable_mechanic_fail_count
  from base b
  left join events e on e.pull_id = b.pull_id
  left join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail on true
  group by b.pull_id, b.player_name
),
unassigned_stats as (
  select
    sp.pull_id,
    occ->>'actorName' as player_name,
    count(*)::bigint as success_count
  from scoped_pulls sp
  cross join lateral jsonb_array_elements(coalesce(sp.unassigned_mechanic_occurrences, '[]'::jsonb)) occ
  where nullif(occ->>'actorName', '') is not null
  group by sp.pull_id, occ->>'actorName'
),
canonical_stats as (
  select
    e.pull_id,
    e.player_name,
    e.defensive_generation_id,
    max(e.evaluated_at) as evaluated_at,
    count(*) filter (
      where ep->>'responseVerdict' in (
        'covered_verified', 'missed_ready', 'missed_due_to_mistime'
      )
    )::integer as evaluable_count,
    count(*) filter (
      where ep->>'responseVerdict' = 'covered_verified'
    )::integer as success_count,
    count(*) filter (
      where ep->>'responseVerdict' in ('missed_ready', 'missed_due_to_mistime')
    )::integer as failure_count
  from public.player_pull_defensive_episode_evaluations e
  join public.defensive_generation_pointer ptr
    on ptr.id = true
   and ptr.published_generation_id = e.defensive_generation_id
  join base b
    on b.pull_id = e.pull_id
   and b.player_name = e.player_name
  left join lateral jsonb_array_elements(coalesce(e.episodes, '[]'::jsonb)) ep on true
  group by e.pull_id, e.player_name, e.defensive_generation_id
)
select
  b.player_name,
  b.pull_id,
  b.boss_id,
  b.difficulty,
  b.closed_at,
  coalesce(hs.had_avoidable_damage, false) as had_avoidable_damage,
  (
    b.died
    and not (
      (b.wipe_call_cluster and b.wipe_call_excluded)
      or coalesce(b.death_cause->>'statisticalExclusionReason', '') = 'boss_melee_on_non_tank'
    )
    and b.death_cause->>'rootCause' = 'self_positioning'
  ) as self_positioning_death,
  case
    when (b.wipe_call_cluster and b.wipe_call_excluded)
      or coalesce(b.death_cause->>'statisticalExclusionReason', '') = 'boss_melee_on_non_tank'
    then null
    when b.died
      and jsonb_array_length(coalesce(b.death_cause->'defensiveOptions', '[]'::jsonb)) > 0
    then (
      select bool_and((opt->>'status') <> 'available_unused')
      from jsonb_array_elements(b.death_cause->'defensiveOptions') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(b.defensive_casts, '[]'::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->'timestampsMs', '[]'::jsonb)) cast_time
    where jsonb_typeof(cast_time) = 'number'
      and (b.cutoff_ms is null or (cast_time #>> '{}')::numeric < b.cutoff_ms)
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(b.defensive_casts, '[]'::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->'timestampsMs', '[]'::jsonb)) cast_time
      where jsonb_typeof(cast_time) = 'number'
        and (b.cutoff_ms is null or (cast_time #>> '{}')::numeric < b.cutoff_ms)
    )
    or (
      b.died
      and not (
        (b.wipe_call_cluster and b.wipe_call_excluded)
        or coalesce(b.death_cause->>'statisticalExclusionReason', '') = 'boss_melee_on_non_tank'
      )
      and jsonb_array_length(coalesce(b.death_cause->'defensiveOptions', '[]'::jsonb)) > 0
    )
    or coalesce(hs.had_avoidable_damage, false)
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>'permanentEnchant')::bigint, 0) > 0
        and coalesce((item->>'id')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(b.equipped_items, '[]'::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  )::bigint as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>'id')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(b.equipped_items, '[]'::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  )::bigint as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->'gems', '[]'::jsonb))), 0)
    from jsonb_array_elements(coalesce(b.equipped_items, '[]'::jsonb)) item
  )::bigint as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>'id')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->'gems', '[]'::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(b.equipped_items, '[]'::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  )::bigint as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>'id')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(b.equipped_items, '[]'::jsonb))
      with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  )::bigint as gemmable_slot_count,
  coalesce(hs.personal_mechanic_fail_count, 0)::bigint as personal_mechanic_fail_count,
  b.report_code,
  b.pull_number,
  coalesce(es.avoidable_mechanic_eligible_count, 0)::bigint as avoidable_mechanic_eligible_count,
  coalesce(afs.avoidable_mechanic_fail_count, 0)::bigint as avoidable_mechanic_fail_count,
  (
    select coalesce(count(*) filter (where (w->>'coverable')::boolean), 0)
    from jsonb_array_elements(coalesce(b.defensive_pressure_windows->'windows', '[]'::jsonb)) w
    where b.cutoff_ms is null or (w->>'startMs')::numeric < b.cutoff_ms
  )::bigint as defensive_window_coverable_count,
  (
    select coalesce(count(*) filter (where (w->>'covered')::boolean), 0)
    from jsonb_array_elements(coalesce(b.defensive_pressure_windows->'windows', '[]'::jsonb)) w
    where b.cutoff_ms is null or (w->>'startMs')::numeric < b.cutoff_ms
  )::bigint as defensive_window_covered_count,
  exists (
    select 1
    from jsonb_array_elements(coalesce(b.defensive_casts, '[]'::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->'timestampsMs', '[]'::jsonb)) cast_time
    where jsonb_typeof(cast_time) = 'number'
      and (b.cutoff_ms is null or (cast_time #>> '{}')::numeric < b.cutoff_ms)
  ) as defensive_window_used_anything,
  coalesce(us.success_count, 0)::bigint as unassigned_mechanic_success_count,
  evaluation.management_score as defensive_management_score_v2,
  case
    when evaluation.pull_id is null then null::integer
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where (event->>'state') in (
        'plan_broken', 'death_with_viable_cd', 'safe_extra_use', 'missed_extra_opportunity'
      )
      or (
        (event->>'state') in ('plan_covered', 'covered_with_substitution', 'reminder_missed')
        and (event->>'requirementLevel') in ('required', 'recommended')
      )
    )
  end as defensive_management_decision_count,
  evaluation.plan_required_count as defensive_required_count,
  evaluation.required_coverage_success_count as defensive_required_success_count,
  evaluation.required_exact_adherence_count as defensive_required_exact_adherence_count,
  evaluation.broken_reservation_count as defensive_broken_reservation_count,
  evaluation.death_viable_cd_count as defensive_death_viable_cd_count,
  evaluation.data_confidence as defensive_evaluation_confidence,
  evaluation.evaluator_version as defensive_evaluator_version,
  evaluation.resolver_version as defensive_resolver_version,
  evaluation.solver_version as defensive_solver_version,
  evaluation.game_build as defensive_game_build,
  evaluation.build_fingerprint as defensive_build_fingerprint,
  evaluation.evaluated_at as defensive_evaluated_at,
  canonical.evaluable_count as canonical_response_evaluable_count,
  canonical.success_count as canonical_response_success_count,
  canonical.failure_count as canonical_response_failure_count,
  canonical.defensive_generation_id as canonical_defensive_generation_id,
  canonical.evaluated_at as canonical_defensive_evaluated_at
from base b
left join hit_stats hs
  on hs.pull_id = b.pull_id and hs.player_name = b.player_name
left join eligible_stats es
  on es.pull_id = b.pull_id and es.player_name = b.player_name
left join avoidable_fail_stats afs
  on afs.pull_id = b.pull_id and afs.player_name = b.player_name
left join unassigned_stats us
  on us.pull_id = b.pull_id and us.player_name = b.player_name
left join public.player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = b.pull_id and evaluation.player_name = b.player_name
left join canonical_stats canonical
  on canonical.pull_id = b.pull_id and canonical.player_name = b.player_name
$$;

revoke all on function public.get_player_pull_reliability_inputs_v2(text,timestamptz,text,text,uuid[]) from public;
grant execute on function public.get_player_pull_reliability_inputs_v2(text,timestamptz,text,text,uuid[])
  to authenticated, service_role;

comment on function public.get_player_pull_reliability_inputs_v2(text,timestamptz,text,text,uuid[]) is
  'Scoped Fiabilidad read-path. Applies player/time/boss/pull filters before mechanic aggregation and exposes canonical defensive Response from the currently published defensive generation.';

notify pgrst, 'reload schema';