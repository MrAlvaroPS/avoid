-- §"para las mecánicas que requieren grupos... un desplegable para asignar
-- un grupo (1 al 6, toggle chips)" (feedback real, 2026-08-31): metadata de
-- planificación sobre una asignación ya existente — a qué grupos de raid
-- (1-6) aplica, para mecánicas tipo "sokeo 1-3 y 2-4". NO es un filtro que
-- MRT vaya a aplicar solo (el protocolo de Reminder que ya validamos en
-- real no documenta un campo de grupo — solo players/roles/classes), así
-- que esto es información para el humano que planifica y para el texto del
-- reminder exportado, no una restricción que imponga el propio MRT.
alter table mechanic_defensive_assignments add column if not exists assigned_groups smallint[];
comment on column mechanic_defensive_assignments.assigned_groups is 'Grupos de raid (1-6) a los que aplica esta asignación — null = todos/sin restringir. Solo informativo (se refleja en el texto del reminder exportado), MRT no filtra por esto.';
