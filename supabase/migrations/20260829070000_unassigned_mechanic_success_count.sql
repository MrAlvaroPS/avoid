-- §"si un jugador hace una mecanica 'voluntaria' [...] vamos a decirlo y
-- subir su porcentaje de mecanicas por haberlo hecho con éxito" (feedback
-- real, 2026-08-29): hasta ahora unassigned_mechanic_occurrences (ver
-- 20260829030000) solo alimentaba una tarjeta informativa en la infografía
-- ("Mecánicas resueltas"), nunca el eje Mecánica de verdad. Se añade UNA
-- columna nueva a player_pull_reliability_inputs — la vista que YA es la
-- fuente única de mechanicScoreFor (pull-analysis.service.ts), compartida
-- por Fiabilidad (reliability.service.ts, 60 días Y de la noche) y por
-- pullScore (night-player-summary.service.ts) — así el bonus llega a los
-- dos consumidores por el MISMO camino que ya evita que puedan divergir
-- (motivo original de esta vista: "un 77% de puntuación de noche pero un 44
-- de fiabilidad", feedback real 2026-08-27).
--
-- A propósito SIN el recorte por wipeCallStartMs que sí llevan
-- avoidable_mechanic_fail_count/personal_mechanic_fail_count más arriba en
-- esta vista: esas son PENALIZACIONES (se perdonan las que ocurren después
-- de que el RL ya cantó el wipe). Esto es un ACIERTO — mismo criterio ya
-- establecido para interrupts en night-player-summary.service.ts ("un kick
-- conseguido sigue siendo un acierto real aunque el pull terminase en
-- wipe"): hacer la mecánica extra sigue siendo mérito real aunque el intento
-- acabara mal. CREATE OR REPLACE VIEW solo permite añadir columnas al
-- final (ver comentario de 20260829020000) — se añade tras
-- defensive_window_used_anything.
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
  -- §"subir su porcentaje de mecanicas por haberlo hecho con éxito" — ver
  -- comentario de cabecera. Sin recorte de wipeCallStartMs a propósito
  -- (es un acierto, no una penalización que perdonar).
  (
    select count(*)
    from jsonb_array_elements(coalesce(p.unassigned_mechanic_occurrences, '[]'::jsonb)) occ
    where occ->>'actorName' = r.player_name
  ) as unassigned_mechanic_success_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded;

comment on column player_pull_reliability_inputs.unassigned_mechanic_success_count is
  '§"vamos a decirlo y subir su porcentaje de mecanicas" (feedback real, 2026-08-29): cuántas mecánicas sin asignar (ver unassigned_mechanic_catalog) resolvió ESTE jugador en ESTE pull — mechanicScoreFor lo suma como bonus (UNASSIGNED_MECHANIC_BONUS_PER_OCCURRENCE, capado por pull) al ratio/conteo de fallos, nunca lo resta. 0 si el pull no tuvo ninguna (catálogo sin filas confirmadas para ese boss, o nadie la resolvió) — nunca null, a diferencia de avoidable_mechanic_*, porque esta columna no depende de un backfill de otra función, ya vive en pulls desde que se creó la tabla.';
