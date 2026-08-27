-- Preparación de la season: enchants en cabeza/hombros/pecho/piernas/botas/
-- anillos; gemas en cuello/anillos. Los índices son los de CombatantInfo de
-- WCL (trinkets 12/13), no IDs de inventario de Blizzard.
--
-- También se separa la evidencia observada en logs públicos de la evidencia
-- de la guild para poder contrastar la aplicabilidad por dificultad.

alter table boss_mechanics_candidates
  add column if not exists observed_in_reference_logs boolean not null default false,
  add column if not exists official_difficulty_applicable boolean;

comment on column boss_mechanics_candidates.observed_in_reference_logs is
  'True cuando la habilidad se observó en uno o más logs públicos de referencia de esta dificultad exacta (cast, daño o interrupt). Evidencia para evitar mezclar dificultades.';

comment on column boss_mechanics_candidates.official_difficulty_applicable is
  'True/false cuando las restricciones oficiales DB2 permiten/excluyen la habilidad en esta dificultad; null cuando DB2 no pudo resolverlo. No se borran filas ni ediciones manuales al excluir.';

update boss_mechanics_candidates
set observed_in_reference_logs = true
where coalesce(reference_occurrences, 0) > 0
   or observed_as_interrupt is true;

-- Recupera también evidencia propia de pulls anteriores. El cruce es por
-- nombre porque el ability_id del Journal y el abilityGameID de WCL suelen
-- ser distintos; es el mismo contrato que usa analyze-report.
update boss_mechanics_candidates candidate
set observed_in_logs = true
where exists (
  select 1
  from pull_mechanic_events event
  join pulls pull on pull.id = event.pull_id
  where pull.boss_id = candidate.boss_id
    and pull.difficulty = candidate.difficulty
    and lower(trim(event.mechanic_name)) = lower(trim(candidate.name))
);

-- Una candidata es aplicable a la dificultad exacta cuando existe evidencia
-- positiva en ella, o cuando todavía no se ha podido contrastar. Solo se
-- excluye si el muestreo de esta dificultad sí se ejecutó, no encontró la
-- habilidad y otra dificultad del mismo boss sí aporta evidencia positiva.
-- La tabla base conserva todas las filas y su procedencia para poder auditar
-- la decisión; todas las lecturas que afectan a estadísticas usan esta vista.
create or replace view applicable_boss_mechanics_candidates
with (security_invoker = true) as
select candidate.*
from boss_mechanics_candidates candidate
where candidate.observed_in_logs is true
   or candidate.observed_in_reference_logs is true
   or candidate.observed_as_interrupt is true
   or coalesce(candidate.reference_occurrences, 0) > 0
   or exists (
     select 1
     from pull_mechanic_events event
     join pulls pull on pull.id = event.pull_id
     where pull.boss_id = candidate.boss_id
       and pull.difficulty = candidate.difficulty
       and lower(trim(event.mechanic_name)) = lower(trim(candidate.name))
   )
   or (
     candidate.official_difficulty_applicable is distinct from false
     and (
       candidate.reference_source_report is null
       or not exists (
         select 1
         from boss_mechanics_candidates other
         where other.boss_id = candidate.boss_id
           and other.ability_id = candidate.ability_id
           and other.difficulty <> candidate.difficulty
           and (
             other.observed_in_logs is true
             or other.observed_in_reference_logs is true
             or other.observed_as_interrupt is true
             or coalesce(other.reference_occurrences, 0) > 0
           )
       )
     )
   );

comment on view applicable_boss_mechanics_candidates is
  'Mecánicas aplicables por boss+dificultad tras contrastar evidencia oficial, de la guild y de logs públicos. Evita que filas conservadas para auditoría contaminen análisis y estadísticas.';

create or replace view applicable_pull_mechanic_events
with (security_invoker = true) as
select event.*
from pull_mechanic_events event
join pulls pull on pull.id = event.pull_id
where not exists (
    select 1
    from boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  )
  or exists (
    select 1
    from applicable_boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  );

comment on view applicable_pull_mechanic_events is
  'Eventos históricos cuya mecánica sigue siendo aplicable al boss+dificultad. Las filas sin candidata asociada se conservan de forma conservadora.';

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
join pulls p on p.id = r.pull_id;

comment on view player_pull_reliability_inputs is
  'Una fila por jugador+pull. Preparación mide 7 slots de enchant (0,2,4,6,7,10,11) y 3 slots de gema (1,10,11); disciplina defensiva y exclusiones respetan wipeCallStartMs.';

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
  and not (
    p.wipe_call_excluded
    and p.wipe_call_signals is not null
    and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
  );

comment on view player_mechanic_offenses is
  'Una fila por jugador golpeado por una mecánica fallada y aplicable a la dificultad; excluye eventos posteriores a wipeCallStartMs.';
