-- §"no tenemos opción de borrar ni de que el prompt borre si no encuentra
-- algo que nos habíamos traído. Por ejemplo el greater invisibility del
-- mago ya no es un defensivo... y no tengo opción de quitarlo de ninguna
-- manera" (feedback real, 2026-08-31): mismo eje que spec_override —
-- corrección manual por ENCIMA de lo que trae el extractor de WoWAnalyzer,
-- que nunca se pisa en un resync. No se borra la fila (rompería el
-- histórico de defensive_pressure_windows.options que ya la referencia por
-- spellId en pulls antiguos) — se marca como "esto ya no cuenta como
-- defensivo real", y todo lo que construye el catálogo disponible de una
-- clase/spec (defensivesForClass/defensivesForSpec, en los dos lados)
-- filtra por esto.
alter table cooldown_catalog add column if not exists excluded boolean not null default false;
comment on column cooldown_catalog.excluded is 'true = ya no es un defensivo real (rediseñado/quitado en un parche posterior) — corrección manual, nunca la toca el extractor de WoWAnalyzer ni un resync. Se filtra en defensivesForClass/defensivesForSpec.';
