-- §"el oso del druida y el paladín... esa fuente de información no debe
-- existir en una infografía" / "los nombres de las habilidades deberían
-- salir bien... lo mismo con Pandokie que es monk y sí tiene pulls"
-- (feedback real, 2026-09-03): un envío manual de classify-defensives dejó
-- en cooldown_catalog.name un fragmento de cita markdown/JSON sin terminar
-- de parsear — patrón real confirmado por consulta directa (15 filas):
-- "Bear](https://.../survival-of-the-fittest%22}]}],%22missingDefensives%22:
-- [{%22spellId%22:5487,%22name%22:%22Bear) Form" en vez de "Bear Form". La
-- app ya no muestra el texto crudo gracias a safeSpellName() (detecta el
-- patrón y cae a "#<spellId>"), pero eso es un salvavidas de presentación,
-- no una corrección del dato — esta migración corrige el dato en origen
-- para las 15 filas confirmadas por consulta de solo lectura contra
-- producción. Todas identificadas sin ambigüedad por spellId (nombres reales
-- de habilidades conocidas, no una interpretación).
--
-- Se corrige por spell_id + class (no solo spell_id) como guarda adicional,
-- aunque los IDs de hechizo son globales en WoW. No se toca ninguna otra
-- columna (spec, category, survival_type, etc.) ni se reintroduce ningún
-- dato nuevo — solo el nombre.

update cooldown_catalog set name = 'Bear Form' where spell_id = 5487 and class = 'Druid';
update cooldown_catalog set name = 'Incarnation: Tree of Life' where spell_id = 33891 and class = 'Druid';
update cooldown_catalog set name = 'Incarnation: Guardian of Ursoc' where spell_id = 102558 and class = 'Druid';
update cooldown_catalog set name = 'Nature''s Swiftness' where spell_id = 132158 and class = 'Druid';
update cooldown_catalog set name = 'Lunar Beam' where spell_id = 204066 and class = 'Druid';
update cooldown_catalog set name = 'Call of the Elder Druid' where spell_id = 426784 and class = 'Druid';

update cooldown_catalog set name = 'Purifying Brew' where spell_id = 119582 and class = 'Monk';
update cooldown_catalog set name = 'Expel Harm' where spell_id = 322101 and class = 'Monk';
update cooldown_catalog set name = 'Exploding Keg' where spell_id = 325153 and class = 'Monk';
update cooldown_catalog set name = 'Transcendence: Transfer' where spell_id = 434766 and class = 'Monk';
update cooldown_catalog set name = 'Celestial Conduit' where spell_id = 443028 and class = 'Monk';
update cooldown_catalog set name = 'Elixir of Determination' where spell_id = 455139 and class = 'Monk';

update cooldown_catalog set name = 'Flash of Light' where spell_id = 19750 and class = 'Paladin';
update cooldown_catalog set name = 'Aura Mastery' where spell_id = 31821 and class = 'Paladin';
update cooldown_catalog set name = 'Shield of the Righteous' where spell_id = 53600 and class = 'Paladin';

-- Verificación explícita (falla la migración entera si algo no cuadra en
-- vez de dejar una fila corregida a medias sin que nadie se entere): las 15
-- filas ya no deben matchear el mismo patrón de corrupción que usa
-- safeSpellName() en el cliente (format.util.ts TECHNICAL_NAME_PATTERN).
do $$
declare
  v_still_corrupted integer;
begin
  select count(*) into v_still_corrupted
  from cooldown_catalog
  where spell_id in (5487, 33891, 102558, 132158, 204066, 426784, 119582, 322101, 325153, 434766, 443028, 455139, 19750, 31821, 53600)
    and (name ~* '(https?://|[{}\[\]]|%[0-9a-f]{2}|"[a-z]+"\s*:)' or length(name) > 40);
  if v_still_corrupted > 0 then
    raise exception 'Quedan % filas todavía con nombre corrupto tras la corrección.', v_still_corrupted;
  end if;
end $$;
