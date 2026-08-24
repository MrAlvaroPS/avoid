-- §"un dosier de personaje de una noche concreta... una foto suya de
-- perfil si podemos tenerla" (feedback real): retrato del personaje vía
-- Character Media API de Blizzard, resuelto UNA VEZ en sync-wowaudit-roster
-- (no en cada vista del dosier — evita una llamada externa por carga de
-- pantalla, mismo criterio que ya usa el resto del proyecto para nombres de
-- trinkets/specs). null = personaje no encontrado con ese nombre+reino,
-- perfil oculto, o Blizzard no respondió — best-effort, nunca bloquea el sync.
alter table wowaudit_roster add column if not exists avatar_url text;
