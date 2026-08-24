-- §3.1/§7.1 de la hoja de ruta (auditoría v2): percentil de parse real por
-- jugador — "cómo de bien lo está haciendo Fulanito comparado con el resto
-- del mundo jugando su misma spec en este mismo boss+dificultad". Sale de
-- Report.rankings(fightIDs), que YA da el percentil resuelto por WCL
-- (rankPercent) sin tener que traer ni comparar contra un leaderboard entero
-- a mano — verificado en real contra un pull real: un valor por jugador,
-- coherente con clase/spec/tamaño de raid reales de ese pull.
alter table player_pull_records
  add column if not exists world_rank_percent numeric,
  add column if not exists world_total_parses integer;

comment on column player_pull_records.world_rank_percent is
  'Percentil real (0-100) de WCL para este jugador en este pull concreto (Report.rankings) — comparado contra el resto del mundo con su misma clase/spec en este boss+dificultad. Null si WCL no pudo rankear el pull (ej. log privado sin permiso de ranking, o boss no rankeable todavía) — best-effort, nunca bloquea el resto del análisis.';
comment on column player_pull_records.world_total_parses is
  'Tamaño de la muestra sobre la que se calculó world_rank_percent — un percentil sobre 40 parses no pesa igual que uno sobre 15000.';
