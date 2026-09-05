-- M12 añadió mechanic_key y policy_version a boss_mechanics_candidates
-- después de crear esta vista. PostgreSQL congela la expansión de candidate.*
-- al crearla, por lo que hay que recrearla para exponer las columnas nuevas.
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
           and (case other.difficulty when 'LFR' then 1 when 'Normal' then 3 when 'Heroic' then 4 when 'Mythic' then 5 else 0 end)
             > (case candidate.difficulty when 'LFR' then 1 when 'Normal' then 3 when 'Heroic' then 4 when 'Mythic' then 5 else 0 end)
       )
     )
   );

comment on view applicable_boss_mechanics_candidates is
  'Mecánicas aplicables por boss+dificultad. Recreada tras M12 para exponer mechanic_key y policy_version sin cambiar el filtro de aplicabilidad.';