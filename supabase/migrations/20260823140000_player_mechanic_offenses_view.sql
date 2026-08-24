-- §"atascos constantes... a través de todos los bosses" (feedback real):
-- reliability.service.ts da un número por jugador (sin desglosar por
-- categoría) y boss-history.service.ts da tendencia por categoría PERO
-- acotada a un solo boss. Ninguno responde "¿este jugador falla SIEMPRE
-- zona evitable, en varios bosses distintos, no solo en uno?" — que es
-- justo la definición de un atasco constante (un mal pull puntual en un
-- boss no cuenta, repetirse across bosses sí). players_hit_names ya
-- identifica QUIÉN falló cada instancia de mecánica (20260822130000); esta
-- vista solo hace unnest + join con pulls para tener boss_id/closed_at por
-- fila jugador+mecánica-fallada. El umbral de "cuántos bosses distintos
-- hacen falta para llamarlo patrón" vive en offenders.service.ts, no aquí.
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
from pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category is not null
  and e.outcome <> 'clean'
  and array_length(e.players_hit_names, 1) > 0;

comment on view player_mechanic_offenses is
  '§"ofensor repetido cross-boss": una fila por jugador golpeado por una instancia de mecánica FALLADA (outcome<>clean), con boss_id/category/closed_at para que offenders.service.ts pueda agrupar "misma categoría, en cuántos bosses distintos, en qué ventana" sin tener que traerse pull_mechanic_events entero al cliente.';
