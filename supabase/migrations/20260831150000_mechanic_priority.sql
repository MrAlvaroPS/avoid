-- §"que se tiene que auto poner el 'exige defensivo' cuando lo exija" +
-- "columna nueva que se llame prioridad... del 1 al 5 dependiendo la
-- prioridad de defensivo que tiene en base al daño que hace a la raid"
-- (feedback real, 2026-08-31): prioridad relativa DENTRO de cada
-- boss+dificultad (quintiles por impactScore = mediana de daño sin mitigar
-- × jugadores golpeados, ver sync-mechanic-defensive-profile) — 5 = de las
-- que más pico hacen a la raid en ESTE boss, 1 = de las que menos, null =
-- sin evidencia todavía (ni un solo hit sin mitigar observado).
alter table boss_mechanic_defensive_profile add column if not exists priority smallint check (priority between 1 and 5);
comment on column boss_mechanic_defensive_profile.priority is '1-5, relativo a las demás mecánicas de este boss+dificultad (quintil por daño sin mitigar × jugadores golpeados) — null = sin evidencia todavía. Solo lo escribe sync-mechanic-defensive-profile.';
