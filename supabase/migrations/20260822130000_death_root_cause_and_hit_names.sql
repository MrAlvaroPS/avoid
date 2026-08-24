-- §10 de la hoja de ruta (auditoría v2): clasificación fina de muertes —
-- distinguir "murió de un oneshot porque nadie entró a soakear" de "murió
-- por sanación insuficiente durante 20s". player_pull_records.death_cause
-- (jsonb) ya existe y gana un campo nuevo `rootCause` dentro del jsonb, así
-- que no hace falta columna nueva para eso — solo documentado aquí.
--
-- players_hit_names SÍ es columna nueva: hasta ahora pull_mechanic_events
-- solo guardaba CUÁNTOS jugadores golpeó cada mecánica (players_hit int),
-- nunca QUIÉN — un raid lead no puede dirigirse a nadie con solo un número.
-- Se rellena en analyze-report a partir de los mismos eventos WCL que ya
-- calculan el conteo, sin llamada nueva a la API.
alter table pull_mechanic_events
  add column if not exists players_hit_names text[] not null default '{}';

comment on column pull_mechanic_events.players_hit_names is
  'Nombres de los jugadores golpeados por esta instancia de mecánica (mismo criterio que players_hit, pero con quién, no solo cuántos). Vacío en la categoría interrupt, donde players_hit se reutiliza como "¿se resolvió?" y no representa golpes reales.';
