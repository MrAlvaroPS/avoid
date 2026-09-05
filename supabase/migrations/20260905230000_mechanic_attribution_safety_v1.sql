-- Attribution Safety v1 · mechanics.
--
-- Problema demostrado en producción: player_hit_details describe receptores
-- de daño, no necesariamente autores del fallo. El eje Mecánica seguía
-- usando category como proxy de culpabilidad aun cuando pull_mechanic_events
-- ya conserva responsibility (tank/healer/dps/raid/personal).
--
-- Regla de transición, deliberadamente conservadora:
--   * si responsibility existe, solo 'personal' puede alimentar penalización
--     individual genérica;
--   * tank/healer/dps/raid nunca penalizan al receptor del daño;
--   * si responsibility es null (histórico), se conserva el criterio legacy
--     por category para no vaciar noches antiguas de golpe.
--
-- No intenta resolver todavía autoría de tank swaps, soaks, spreads o
-- asignaciones: esos casos requieren responsibility graph/evidence causal.
-- Mantiene exactamente el contrato y orden de columnas del legacy view para
-- no romper el wrapper player_pull_reliability_inputs ni sus consumidores.

create or replace view player_pull_reliability_inputs_legacy_v1
with (security_invoker = true) as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>'statisticalExclusionReason', '') = 'boss_melee_on_non_tank'
    )
  ) as died,
  exists (
    select 1
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
    where e.pull_id = p.id
      and e.avoidable is true
      and e.outcome <> 'clean'
      and detail->>'name' = r.player_name
      and coalesce((detail->>'damage_taken')::numeric, 0) > 0
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
  ) as had_avoidable_damage,
  (
    r.died
    and not (
      (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>'statisticalExclusionReason', '') = 'boss_melee_on_non_tank'
    )
    and r.death_cause->>'rootCause' = 'self_positioning'
  ) as self_positioning_death,
  case
    when (r.wipe_call_cluster and p.wipe_call_excluded)
      or coalesce(r.death_cause->>'statisticalExclusionReason', '') = 'boss_melee_on_non_tank'
    then null
    when r.died and jsonb_array_length(coalesce(r.death_cause->'defensiveOptions', '[]'::jsonb)) > 0 then (
      select bool_and((opt->>'status') <> 'available_unused')
      from jsonb_array_elements(r.death_cause->'defensiveOptions') opt
    )
    else null
  end as used_defensive_when_died,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, '[]'::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->'timestampsMs', '[]'::jsonb)) cast_time
    where jsonb_typeof(cast_time) = 'number'
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and (cast_time #>> '{}')::numeric >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
  ) as used_defensive_in_pull,
  (
    exists (
      select 1
      from jsonb_array_elements(coalesce(r.defensive_casts, '[]'::jsonb)) defensive
      cross join lateral jsonb_array_elements(coalesce(defensive->'timestampsMs', '[]'::jsonb)) cast_time
      where jsonb_typeof(cast_time) = 'number'
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
          and (cast_time #>> '{}')::numeric >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
        )
    )
    or (
      r.died
      and not (
        (r.wipe_call_cluster and p.wipe_call_excluded)
        or coalesce(r.death_cause->>'statisticalExclusionReason', '') = 'boss_melee_on_non_tank'
      )
      and jsonb_array_length(coalesce(r.death_cause->'defensiveOptions', '[]'::jsonb)) > 0
    )
    or exists (
      select 1
      from applicable_pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and e.outcome <> 'clean'
        and detail->>'name' = r.player_name
        and coalesce((detail->>'damage_taken')::numeric, 0) > 0
        and not (
          p.wipe_call_excluded
          and p.wipe_call_signals is not null
          and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
          and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
        )
    )
  ) as defensive_use_opportunity,
  (
    select count(*) filter (
      where coalesce((item->>'permanentEnchant')::bigint, 0) > 0
        and coalesce((item->>'id')::bigint, 0) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where coalesce((item->>'id')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (0, 2, 4, 6, 7, 10, 11)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->'gems', '[]'::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) item
  ) as gem_count,
  (
    select count(*) filter (
      where coalesce((item->>'id')::bigint, 0) > 0
        and jsonb_array_length(coalesce(item->'gems', '[]'::jsonb)) > 0
    )
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmed_slot_count,
  (
    select count(*) filter (where coalesce((item->>'id')::bigint, 0) > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (1, 10, 11)
  ) as gemmable_slot_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
    where e.pull_id = p.id
      and e.category in ('avoidable-ground', 'spread', 'soak', 'personal-target')
      and (e.responsibility = 'personal' or e.responsibility is null)
      and e.outcome <> 'clean'
      and detail->>'name' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
  ) as personal_mechanic_fail_count,
  p.report_code,
  p.pull_number,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.category in ('avoidable-ground', 'spread')
      and (e.responsibility = 'personal' or e.responsibility is null)
      and e.outcome <> 'clean'
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->'timeMs') = 'number'
          and (r.death_cause->>'timeMs')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_eligible_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
    where e.pull_id = p.id
      and e.category in ('avoidable-ground', 'spread')
      and (e.responsibility = 'personal' or e.responsibility is null)
      and e.outcome <> 'clean'
      and detail->>'name' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->'timeMs') = 'number'
          and (r.death_cause->>'timeMs')::numeric > e.trigger_time_ms
        )
      )
  ) as avoidable_mechanic_fail_count,
  (
    select coalesce(count(*) filter (where (w->>'coverable')::boolean), 0)
    from jsonb_array_elements(coalesce(r.defensive_pressure_windows->'windows', '[]'::jsonb)) w
    where not (
      p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
      and (w->>'startMs')::numeric >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
    )
  ) as defensive_window_coverable_count,
  (
    select coalesce(count(*) filter (where (w->>'covered')::boolean), 0)
    from jsonb_array_elements(coalesce(r.defensive_pressure_windows->'windows', '[]'::jsonb)) w
    where not (
      p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
      and (w->>'startMs')::numeric >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
    )
  ) as defensive_window_covered_count,
  exists (
    select 1
    from jsonb_array_elements(coalesce(r.defensive_casts, '[]'::jsonb)) defensive
    cross join lateral jsonb_array_elements(coalesce(defensive->'timestampsMs', '[]'::jsonb)) cast_time
    where jsonb_typeof(cast_time) = 'number'
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and (cast_time #>> '{}')::numeric >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
  ) as defensive_window_used_anything,
  r.defensive_pressure_windows,
  (
    select count(*)
    from jsonb_array_elements(coalesce(p.unassigned_mechanic_occurrences, '[]'::jsonb)) occ
    where occ->>'actorName' = r.player_name
  ) as unassigned_mechanic_success_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded;

comment on view player_pull_reliability_inputs_legacy_v1 is
  'Compatibilidad v1 con Attribution Safety: responsibility explícita manda sobre category para penalización mecánica individual; category legacy solo se usa cuando responsibility es null.';

comment on column player_pull_reliability_inputs_legacy_v1.personal_mechanic_fail_count is
  'Fallos personales graduados: solo eventos con responsibility=personal; si responsibility es null se conserva temporalmente el fallback histórico por category.';

notify pgrst, 'reload schema';
