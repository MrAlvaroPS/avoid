-- Cierra dos huecos reales de UX/datos que dejaban "79 nodos" / "ilvl 308"
-- sin nombre en pantalla, algo que un RL no puede usar para nada:
--   1. class/spec por jugador y pull (antes solo vivía en memoria durante
--      analyze-report, nunca se persistía — ni siquiera para mostrar "quién
--      es qué spec" en la tabla de jugadores).
--   2. nombre resuelto de los trinkets (Blizzard Item API), guardado dentro
--      de equipped_items en el momento de clasificar el pull.
alter table player_pull_records
  add column if not exists class text, -- tal cual lo da WCL (actor.subType): "Mage", "DeathKnight"...
  add column if not exists spec text;  -- resuelto vía Blizzard Game Data desde combatantInfo.specID: "Frost", "Destruction"...

comment on column player_pull_records.class is 'actor.subType de WCL para este jugador en este fight.';
comment on column player_pull_records.spec is 'Nombre de spec resuelto contra Blizzard Game Data (/data/wow/playable-specialization/{specID}) a partir de combatantInfo.specID. Null si WCL no dio combatantInfo para este jugador.';
