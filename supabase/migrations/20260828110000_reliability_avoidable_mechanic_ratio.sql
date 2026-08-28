-- §"quiero que la puntuación que traigas, parecida a wipefest, sea
-- consistente en realidad, más que intentar calcarlo... para eso tenemos
-- que contemplar muchas posibilidades distintas" (feedback real,
-- 2026-08-28): personal_mechanic_fail_count penaliza con el mismo -25%
-- fijo tanto a quien falló su ÚNICA oportunidad de esquivar una zona en el
-- suelo como a quien falló 1 de 15 -- un ratio real (instancias
-- esquivadas/instancias elegibles) es más justo, PERO solo es honesto para
-- categorías donde "te golpeó" significa sin ambigüedad "fallaste":
--   - avoidable-ground/spread: sí, limpio -- elegible = seguía vivo en ese
--     instante, resultado binario (dentro de la zona o no).
--   - soak/personal-target: NO se toca -- en soak que te golpee suele ser
--     lo CORRECTO (alguien tiene que absorberlo) y no sabemos quién estaba
--     asignado; fingir un ratio ahí culparía a quien hizo lo que tenía que
--     hacer. Se quedan en personal_mechanic_fail_count (ya existe, sin
--     cambios) -- reliability.service.ts resta avoidable_mechanic_fail_count
--     de ahí para aislar el conteo plano de soak/personal-target sin
--     necesitar una columna nueva para eso.
--
-- "elegible" usa la muerte CRUDA (r.died/r.death_cause), no la ya corregida
-- por wipe call más arriba en la vista: si de verdad estabas inconsciente
-- en el suelo no podías esquivar nada, sin importar si ESA muerte concreta
-- luego se excluye de fiabilidad por ser wipe call -- son preguntas
-- distintas ("¿podías moverte?" vs. "¿se te debe penalizar por morir?").
create or replace view player_pull_reliability_inputs as
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
  -- §nuevo, AL FINAL (mismo motivo de siempre -- Postgres solo permite
  -- añadir columnas al final). "Elegible" = seguía vivo (muerte CRUDA, no
  -- la corregida por wipe call de arriba) cuando se disparó una instancia
  -- avoidable-ground/spread no-limpia y no excluida por wipe call.
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.category in ('avoidable-ground', 'spread')
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
  ) as avoidable_mechanic_fail_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded;

comment on view player_pull_reliability_inputs is
  'Una fila por jugador+pull real (excluye ninja pulls). Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11) -- reliability.service.ts la calcula SOLO sobre el primer pull de cada report_code por jugador. Mecánica combina dos formas de contar: personal_mechanic_fail_count sigue siendo el conteo plano de las 4 categorías de responsabilidad individual (fuente de fallback y del eje soak/personal-target, restando avoidable_mechanic_fail_count) -- avoidable_mechanic_eligible_count/avoidable_mechanic_fail_count (2026-08-28) dan un ratio real solo para avoidable-ground/spread, donde "te golpeó" es sin ambigüedad un fallo. disciplina defensiva y exclusiones respetan wipeCallStartMs.';
