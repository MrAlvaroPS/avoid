-- §"no es lo mismo usar 0 defensivos que usarlo a destiempo, lo primero debe
-- penalizar mucho y lo segundo debe penalizar un poco pero guiar para
-- corregirlo" (feedback real, 2026-08-29): el eje defensiva de Fiabilidad
-- hoy usa defensive_use_opportunity/used_defensive_in_pull — booleanos por
-- pull entero (ver 20260828120000), sin distinguir "no tocó nada en toda la
-- noche" de "usó algo, pero no en el momento de presión real". Con
-- defensive_pressure_windows ya calculado y con backfill completo (ver
-- conversación real, 2026-08-29) se puede contar de verdad en vez de un
-- sí/no. Se AÑADEN columnas nuevas a la vista — used_defensive_in_pull/
-- defensive_use_opportunity se dejan tal cual (otros consumidores, ver
-- pullScore en night-player-summary.service.ts, siguen leyéndolas).
--
-- defensive_window_used_anything: igual criterio que used_defensive_in_pull
-- (cast real, antes del wipe call si lo hay) pero derivado de defensive_casts
-- directamente — "¿tocó ALGO de su catálogo en toda la noche?", sin mirar
-- si acertó la ventana. Es la señal que distingue "nunca lo intentó" de
-- "lo intentó a destiempo" cuando covered_count sale en 0 en ambos casos.
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
  -- §"no es lo mismo usar 0 defensivos que usarlo a destiempo" (feedback
  -- real, 2026-08-29): AÑADIDAS al final a propósito — CREATE OR REPLACE VIEW
  -- solo permite añadir columnas al final, no insertarlas en medio (Postgres
  -- las trata por posición); insertarlas donde conceptualmente "encajan" con
  -- las demás de defensiva rompía el replace (columnas ya existentes abajo
  -- se re-numeran). Ver comentarios de columna al final del archivo.
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
  r.defensive_pressure_windows
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded;

comment on column player_pull_reliability_inputs.defensive_window_coverable_count is
  'Nº de ventanas de presión reales (ver defensive-pressure-windows.ts) donde había al menos un defensivo disponible (excluyendo "emergency" sin usar) y no se cubrió — el conteo real que sustituye al booleano defensive_use_opportunity para el eje Defensiva. 0 si el pull no tiene ventanas evaluables (backfill pendiente o sin presión real).';
comment on column player_pull_reliability_inputs.defensive_window_covered_count is
  'De esas mismas ventanas, cuántas SÍ tuvieron un defensivo activo o casteado dentro de la ventana. covered_count/coverable_count es el ratio real de cobertura de esta noche/pull — no un sí/no.';
comment on column player_pull_reliability_inputs.defensive_window_used_anything is
  '§"no es lo mismo usar 0 defensivos que usarlo a destiempo" (feedback real, 2026-08-29): true si lanzó CUALQUIER defensivo de su catálogo en algún momento del pull, sin mirar si acertó la ventana. Distingue "nunca lo intentó" (false, penaliza fuerte) de "lo intentó pero mal sincronizado" (true con covered_count=0, penaliza poco y debe guiar con las ventanas concretas).';
