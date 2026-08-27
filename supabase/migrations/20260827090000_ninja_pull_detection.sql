-- §"cuando se hace un ninja pull (un pull del boss por error) también
-- cuenta en la estadística de wipes... habría que clasificarlo de otra
-- manera para saberlo" (feedback real): alguien engancha al boss sin que la
-- raid lo haya decidido -- corrió de más, se le fue el pull -- y WCL igual
-- crea una fight real: unos pocos segundos, casi nadie de la raid llegó a
-- entrar en combate. Hoy eso cuenta exactamente igual que un intento serio
-- en todas las estadísticas de wipes/intentos: sesión en vivo, histórico de
-- boss, fiabilidad, informe de noche.
--
-- Mismo principio que el wipe call (§3): no se borra la fila (conserva
-- duración/pull_number/contexto para quien quiera auditar qué pasó), solo
-- se excluye de las estadísticas que asumen que hubo un intento real.
-- is_ninja_pull guarda el veredicto de la heurística; ninja_pull_excluded
-- es la puerta que de verdad usan las vistas para filtrar -- hoy siempre
-- coincide con is_ninja_pull, pero separarlas deja sitio a un override
-- manual futuro (un raid lead corrigiendo un falso positivo) sin otra
-- migración, igual que wipe_call_confidence/wipe_call_excluded.
alter table pulls
  add column if not exists is_ninja_pull boolean not null default false,
  add column if not exists ninja_pull_excluded boolean not null default false,
  add column if not exists ninja_pull_signals jsonb;

comment on column pulls.is_ninja_pull is
  'Heurística en analyze-report: pull muy corto donde casi nadie de la raid llegó a entrar en combate -- probable enganche accidental, no un intento real.';
comment on column pulls.ninja_pull_excluded is
  'Puerta real usada por las vistas para excluir de estadísticas de intentos/wipes. Por defecto igual a is_ninja_pull; queda separada para permitir corregir un falso positivo sin recalcular la heurística.';
comment on column pulls.ninja_pull_signals is
  'Señales que motivaron el veredicto: durationMs, raidSize, engagedPlayerCount y engagedFraction (jugadores que murieron o recibieron daño durante el pull, sobre el total de la raid).';

-- Backfill conservador de datos ya analizados: no quedan los eventos de
-- daño crudos para releer sin reanalizar el report (igual que el backfill
-- de melee del §4.3), así que se aproxima "se enganchó" con las únicas
-- señales ya guardadas por jugador -- murió, o tiene dps/hps > 0 durante el
-- pull. Un kill nunca es ninja pull (igual que un kill nunca es wipe call:
-- si el boss murió, hubo un intento real).
with engagement as (
  select
    pull_id,
    count(*) as raid_size,
    count(*) filter (where died or coalesce(dps, 0) > 0 or coalesce(hps, 0) > 0) as engaged_count
  from player_pull_records
  group by pull_id
)
update pulls p
set
  is_ninja_pull = true,
  ninja_pull_excluded = true,
  ninja_pull_signals = jsonb_build_object(
    'durationMs', p.duration_ms,
    'raidSize', e.raid_size,
    'engagedPlayerCount', e.engaged_count,
    'engagedFraction', round((e.engaged_count::numeric / greatest(e.raid_size, 1)), 2)
  )
from engagement e
where e.pull_id = p.id
  and coalesce(p.wipe_pct, 100) > 0
  and p.duration_ms is not null
  and p.duration_ms < 15000
  and e.raid_size > 0
  and (e.engaged_count::numeric / e.raid_size) <= 0.3;

-- Fiabilidad tampoco debe aprender de un pull que nunca fue un intento
-- real -- ni como "pull limpio" (nadie se enganchó, no que la ejecución
-- fuera perfecta) ni como muestra de preparación/defensivos. Mismo
-- contrato que la versión anterior de esta vista (20260826100000), con el
-- filtro de ninja pull añadido al final.
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
  ) as gemmable_slot_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded;

comment on view player_pull_reliability_inputs is
  'Una fila por jugador+pull real (excluye ninja pulls). Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11); disciplina defensiva y exclusiones respetan wipeCallStartMs.';

-- Los patrones de ofensores repetidos tampoco deben aprender de un pull que
-- nunca fue un intento real.
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
from applicable_pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category is not null
  and e.outcome <> 'clean'
  and array_length(e.players_hit_names, 1) > 0
  and not p.ninja_pull_excluded
  and not (
    p.wipe_call_excluded
    and p.wipe_call_signals is not null
    and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
  );

comment on view player_mechanic_offenses is
  'Una fila por jugador golpeado por una mecánica fallada y aplicable a la dificultad, en un pull real (excluye ninja pulls). Excluye eventos posteriores a wipeCallStartMs.';
