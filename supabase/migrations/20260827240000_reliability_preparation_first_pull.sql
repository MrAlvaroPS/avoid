-- §"el baremo de preparación deberia medir los primeros pulls no los
-- ultimos, porque si en mitad de la raid te toca un objeto y te lo
-- equipas, es normal que ese item no tenga enchant o gema hasta el dia
-- siguiente, por lo que medir que tengas tu pj preparado con enchants y
-- gemas al inicio de la raid es mas correcto" (feedback real, 2026-08-27).
-- computeReliabilityBreakdown (reliability.service.ts) pondera CADA pull
-- por recencia para los 3 ejes por pull -- para mecánica/defensiva eso es
-- justo lo que se quiere (la tendencia reciente pesa más), pero para
-- preparación es al revés: un loot que cae A MITAD de una noche es, por
-- diseño, imposible de encantar/engemar esa misma noche (nadie para a
-- mitad de raid a ir al herrero) -- promediar TODOS los pulls de la noche
-- penalizaba justo lo contrario de lo que debía, un jugador que mejora de
-- equipo a mitad de raid veía CAER su preparación esa noche cuando lo
-- único medible de verdad es si llegó preparado al PRIMER pull.
--
-- report_code + pull_number (nuevos aquí, al final por el mismo motivo de
-- siempre -- ver el comentario de personal_mechanic_fail_count en la
-- migración anterior, Postgres solo permite añadir columnas al final de un
-- create-or-replace-view) dejan que reliability.service.ts filtre, SOLO
-- para el eje Preparación, al primer pull de cada noche por jugador --
-- mecánica/defensiva/consistencia se quedan exactamente igual (cada pull
-- cuenta, ahí sí importa la tendencia reciente pull a pull).
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
  -- §nuevo, AL FINAL (mismo motivo que siempre): permiten a
  -- reliability.service.ts encontrar "el primer pull de esta noche para
  -- este jugador" sin adivinar por closed_at -- pull_number ya es el
  -- contador secuencial real que asigna analyze-report al insertar.
  p.report_code,
  p.pull_number
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded;

comment on view player_pull_reliability_inputs is
  'Una fila por jugador+pull real (excluye ninja pulls). Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11) -- reliability.service.ts la calcula SOLO sobre el primer pull (min pull_number) de cada report_code por jugador (2026-08-27): un loot equipado a mitad de noche no puede llevar encantar/gema esa misma noche, así que promediar todos los pulls penalizaba justo lo contrario de lo que debía. Mecánica/defensiva sí usan todos los pulls (ahí la tendencia reciente pull a pull es la señal). disciplina defensiva y exclusiones respetan wipeCallStartMs. personal_mechanic_fail_count (2026-08-27) es la fuente graduada del eje Mecánica; had_avoidable_damage/self_positioning_death se conservan solo para los niveles de fallback de fetchReliabilityInputs.';
