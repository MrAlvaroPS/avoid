-- Un wipe call tiene un instante de inicio, no invalida el pull completo.
-- Los datos ya analizados guardaban wipe_call_cluster solo en el pile-on, por
-- lo que su primera muerte marcada permite reconstruir el límite histórico.
update pulls p
set wipe_call_signals = jsonb_set(
  p.wipe_call_signals,
  '{wipeCallStartMs}',
  to_jsonb(boundary.start_ms),
  true
)
from (
  select pull_id, min((death_cause->>'timeMs')::numeric) as start_ms
  from player_pull_records
  where wipe_call_cluster
    and death_cause is not null
    and jsonb_typeof(death_cause->'timeMs') = 'number'
  group by pull_id
) boundary
where p.id = boundary.pull_id
  and p.wipe_call_signals is not null
  and not (p.wipe_call_signals ? 'wipeCallStartMs');

-- En datos históricos el detector solo marcaba el grupo compacto que había
-- permitido reconocer el wipe. El límite reconstruido es la fuente de verdad:
-- todas las muertes desde ese instante son cierre del try, aunque llegasen
-- varios segundos después del grupo inicial.
update player_pull_records r
set wipe_call_cluster = true
from pulls p
where p.id = r.pull_id
  and p.wipe_call_excluded
  and p.wipe_call_signals is not null
  and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
  and r.died
  and r.death_cause is not null
  and jsonb_typeof(r.death_cause->'timeMs') = 'number'
  and (r.death_cause->>'timeMs')::numeric >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
  and not r.wipe_call_cluster;

-- Backfill conservador: Melee sobre un no-tank después de que al menos un
-- tank haya muerto en ese wipe. Los análisis nuevos además verifican que la
-- fuente del daño sea el actor del boss y que no haya otro daño mezclado.
with first_tank_death as (
  select r.pull_id, min((r.death_cause->>'timeMs')::numeric) as time_ms
  from player_pull_records r
  where r.died
    and r.death_cause is not null
    and r.spec in ('Blood', 'Vengeance', 'Guardian', 'Brewmaster', 'Protection')
    and jsonb_typeof(r.death_cause->'timeMs') = 'number'
  group by r.pull_id
)
update player_pull_records r
set death_cause = jsonb_set(r.death_cause, '{statisticalExclusionReason}', '"boss_melee_on_non_tank"'::jsonb, true)
from first_tank_death tank_death, pulls p
where r.pull_id = tank_death.pull_id
  and p.id = r.pull_id
  and coalesce(p.wipe_pct, 100) > 0
  and r.died
  and r.death_cause is not null
  and lower(coalesce(r.death_cause->>'mechanicName', '')) = 'melee'
  and coalesce(r.spec, '') not in ('Blood', 'Vengeance', 'Guardian', 'Brewmaster', 'Protection')
  and jsonb_typeof(r.death_cause->'timeMs') = 'number'
  and (r.death_cause->>'timeMs')::numeric >= tank_death.time_ms
  and coalesce(r.death_cause->>'statisticalExclusionReason', '') = '';

-- No se elimina la fila jugador+pull: hacerlo borraba también cualquier daño
-- evitable anterior al wipe call. Solo se neutralizan las señales que dependen
-- de la muerte; preparación y ejecución previa siguen siendo evaluables.
drop view if exists player_pull_reliability_inputs;
create view player_pull_reliability_inputs as
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
  case
    when p.wipe_call_excluded
      and p.wipe_call_signals is not null
      and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    then exists (
      select 1
      from pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
        and e.trigger_time_ms < (p.wipe_call_signals->>'wipeCallStartMs')::numeric
        and detail->>'name' = r.player_name
        and coalesce((detail->>'damage_taken')::numeric, 0) > 0
    )
    else r.avoidable_damage_taken > 0
  end as had_avoidable_damage,
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
    -- Un uso observado crea una muestra positiva aunque el pull fuese limpio.
    -- La ausencia solo se puntúa si hubo una oportunidad verificable: muerte
    -- con catálogo defensivo o daño evitable antes del límite del wipe call.
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
      from pull_mechanic_events e
      cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
      where e.pull_id = p.id
        and e.avoidable is true
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
    select count(*) filter (where (item->>'permanentEnchant') is not null and (item->>'id')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where (item->>'id')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->'gems', '[]'::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) item
  ) as gem_count
from player_pull_records r
join pulls p on p.id = r.pull_id;

comment on view player_pull_reliability_inputs is
  'Una fila por jugador+pull. La disciplina defensiva combina uso durante el try con respuesta al morir; un wipe call o Melee del boss sobre no-tank neutraliza solo señales posteriores/no accionables.';

-- Los patrones cross-boss tampoco deben incorporar eventos posteriores al
-- límite. Un evento anterior del mismo pull permanece y sigue contando.
drop view if exists player_mechanic_offenses;
create view player_mechanic_offenses as
select
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  e.category,
  e.ability_id,
  e.mechanic_name,
  e.outcome,
  unnest(e.players_hit_names) as player_name
from pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category is not null
  and e.outcome <> 'clean'
  and array_length(e.players_hit_names, 1) > 0
  and not (
    p.wipe_call_excluded
    and p.wipe_call_signals is not null
    and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
  );

comment on view player_mechanic_offenses is
  'Una fila por jugador golpeado por una mecánica fallada; excluye solo eventos desde wipeCallStartMs cuando el wipe call está activo.';
