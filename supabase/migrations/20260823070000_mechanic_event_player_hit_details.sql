-- §"la mecánica, cuánto daño ha sufrido, si ha gastado o no defensivo": el
-- detalle por jugador de una instancia de mecánica fallada SIN muerte de por
-- medio (analyze-report ya calculaba esto para muertes vía death_cause, pero
-- pull_mechanic_events solo guardaba nombres, sin números). jsonb porque el
-- número de jugadores golpeados por instancia varía libremente.
alter table pull_mechanic_events
  add column if not exists player_hit_details jsonb not null default '[]';

comment on column pull_mechanic_events.player_hit_details is
  'Array de {name, damage_taken, damage_hits, healing_received, used_defensive_spell_id} — uno por jugador en players_hit_names. Vacío para categoría interrupt (players_hit no cuenta golpes ahí).';
