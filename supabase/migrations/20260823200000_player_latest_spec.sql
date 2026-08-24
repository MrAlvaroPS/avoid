-- §"en la tabla de roster... Mechavalec sale de dps cuando el log pone
-- 'guerrero protección' que es tank" (feedback real, investigado): wowaudit
-- SÍ dice role='Melee' para Mechavalec (confirmado contra la API real) —
-- no es un bug de sync, es la configuración de wowaudit desactualizada
-- frente a lo que de verdad está jugando. wowaudit-roster.service.ts cruza
-- esto con la spec REAL más reciente que ya tenemos de WCL (más fiable que
-- una config manual) — esta vista da esa spec más reciente por jugador,
-- barata (una fila por jugador, no todo el historial).
drop view if exists player_latest_spec;
create view player_latest_spec as
select distinct on (player_name)
  player_name,
  class,
  spec
from player_pull_records
where spec is not null and class is not null
order by player_name, created_at desc;

comment on view player_latest_spec is
  '§"cómo se clasifica la gente": una fila por jugador con su class/spec del pull MÁS RECIENTE que tenemos — wowaudit-roster.service.ts la usa para corregir el role de wowaudit cuando está desactualizado (ej. alguien que cambió a tank de main-spec y wowaudit no se actualizó).';
