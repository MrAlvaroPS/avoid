-- §bug real contrastado en real (2026-08-27, al generar el informe de
-- noche fusionado): "column applicable_pull_mechanic_events.phase_id does
-- not exist" -- `select event.*` en la definición de una vista se EXPANDE
-- y se congela a la lista de columnas de la tabla base EN EL MOMENTO de
-- crear la vista. pull_mechanic_events.phase_id se añadió después (migración
-- 20260827120000_encounter_phases_and_dispels.sql) sin volver a ejecutar el
-- create or replace view de applicable_pull_mechanic_events (que sigue
-- siendo la misma que 20260826100000_preparation_slots_and_difficulty_evidence.sql
-- creó, cuando phase_id ni existía) -- la vista se quedó con la lista de
-- columnas vieja para siempre, aunque la tabla real ya tuviera la columna.
-- Volver a ejecutar EXACTAMENTE la misma definición basta para que Postgres
-- reexpanda event.* contra las columnas actuales -- no cambia ningún dato,
-- ninguna columna renombrada ni ninguna dependencia (applicable_pull_mechanic_events
-- sigue exportando las mismas columnas de siempre, más phase_id).
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
  'Eventos históricos cuya mecánica sigue siendo aplicable al boss+dificultad. Las filas sin candidata asociada se conservan de forma conservadora. Recreada el 2026-08-27 para que event.* recoja phase_id (columna añadida después de la creación original de esta vista).';
