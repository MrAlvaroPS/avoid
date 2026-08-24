-- §"las habilidades deberían estar en inglés y de subtítulo en castellano
-- para poder localizarlas bien" (feedback real, 2026-08-24): nombre de la
-- habilidad en castellano, sacado del Journal de Blizzard con locale=es_ES
-- (ver getJournalEncounterLocalized en _shared/blizzard-client.ts). Null si
-- Blizzard no tiene traducción todavía o la llamada falló esa vez — nunca
-- bloquea el sync por esto.
alter table boss_mechanics_candidates
  add column if not exists name_es text;
