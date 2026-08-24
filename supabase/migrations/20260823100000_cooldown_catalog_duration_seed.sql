-- Duración real (base_duration_ms) de los 34 defensivos sembrados a mano en
-- 20260822030000_cooldown_catalog.sql, verificada contra el tooltip real de
-- Wowhead spell=<id> uno a uno (no de memoria — ver conversación). Donde
-- Wowhead mostraba "Duration: n/a" (Fortifying Brew, Greater Invisibility,
-- Blur, Renewing Blaze — efectos con fases/mecánica no reducible a una
-- duración simple) se deja NULL a propósito: mejor "no lo sé" que un número
-- inventado que marque "activo"/"no activo" mal en una muerte real.
-- Exhilaration y Crimson Vial/Desperate Prayer son sanaciones (con o sin
-- componente de buff con duración real, según el tooltip) — sus valores
-- también vienen del tooltip, no de la categoría de la habilidad.
update cooldown_catalog set base_duration_ms = 8000  where class = 'Warrior'     and spell_id = 871;     -- Shield Wall
update cooldown_catalog set base_duration_ms = 8000  where class = 'Warrior'     and spell_id = 118038;  -- Die by the Sword
update cooldown_catalog set base_duration_ms = 8000  where class = 'Warrior'     and spell_id = 184364;  -- Enraged Regeneration
update cooldown_catalog set base_duration_ms = 8000  where class = 'Paladin'     and spell_id = 642;     -- Divine Shield
update cooldown_catalog set base_duration_ms = 8000  where class = 'Paladin'     and spell_id = 498;     -- Divine Protection
update cooldown_catalog set base_duration_ms = 12000 where class = 'Paladin'     and spell_id = 31850;   -- Ardent Defender
update cooldown_catalog set base_duration_ms = 8000  where class = 'Paladin'     and spell_id = 86659;   -- Guardian of Ancient Kings
update cooldown_catalog set base_duration_ms = 8000  where class = 'DeathKnight' and spell_id = 48792;   -- Icebound Fortitude
update cooldown_catalog set base_duration_ms = 5000  where class = 'DeathKnight' and spell_id = 48707;   -- Anti-Magic Shell
update cooldown_catalog set base_duration_ms = 10000 where class = 'DeathKnight' and spell_id = 55233;   -- Vampiric Blood
update cooldown_catalog set base_duration_ms = 8000  where class = 'Hunter'      and spell_id = 186265;  -- Aspect of the Turtle
-- Exhilaration (109304): sanación instantánea, sin buff con duración — se queda NULL a propósito.
update cooldown_catalog set base_duration_ms = 5000  where class = 'Rogue'       and spell_id = 31224;   -- Cloak of Shadows
update cooldown_catalog set base_duration_ms = 6000  where class = 'Rogue'       and spell_id = 1966;    -- Feint
update cooldown_catalog set base_duration_ms = 4000  where class = 'Rogue'       and spell_id = 185311;  -- Crimson Vial (aura de regen, 4s)
update cooldown_catalog set base_duration_ms = 8000  where class = 'Priest'      and spell_id = 33206;   -- Pain Suppression
update cooldown_catalog set base_duration_ms = 10000 where class = 'Priest'      and spell_id = 19236;   -- Desperate Prayer (buff de salud máx., 10s)
update cooldown_catalog set base_duration_ms = 10000 where class = 'Priest'      and spell_id = 586;     -- Fade
update cooldown_catalog set base_duration_ms = 12000 where class = 'Shaman'      and spell_id = 108271;  -- Astral Shift
update cooldown_catalog set base_duration_ms = 10000 where class = 'Mage'        and spell_id = 45438;   -- Ice Block
-- Greater Invisibility (110959): Wowhead da "Duration: n/a" (tiene fases: DR breve + invis más larga) — se queda NULL.
update cooldown_catalog set base_duration_ms = 8000  where class = 'Warlock'     and spell_id = 104773;  -- Unending Resolve
update cooldown_catalog set base_duration_ms = 20000 where class = 'Warlock'     and spell_id = 108416;  -- Dark Pact
-- Fortifying Brew (115203): Wowhead da "Duration: n/a" — se queda NULL.
update cooldown_catalog set base_duration_ms = 6000  where class = 'Monk'        and spell_id = 122783;  -- Diffuse Magic
update cooldown_catalog set base_duration_ms = 10000 where class = 'Monk'        and spell_id = 122278;  -- Dampen Harm
update cooldown_catalog set base_duration_ms = 8000  where class = 'Druid'       and spell_id = 22812;   -- Barkskin
update cooldown_catalog set base_duration_ms = 6000  where class = 'Druid'       and spell_id = 61336;   -- Survival Instincts
-- Blur (198589, DemonHunter Havoc): Wowhead da "Duration: n/a" — se queda NULL.
update cooldown_catalog set base_duration_ms = 2500  where class = 'DemonHunter' and spell_id = 196555;  -- Netherwalk
update cooldown_catalog set base_duration_ms = 15000 where class = 'DemonHunter' and spell_id = 187827;  -- Metamorphosis (Vengeance)
update cooldown_catalog set base_duration_ms = 12000 where class = 'Evoker'      and spell_id = 363916;  -- Obsidian Scales
-- Renewing Blaze (374348): Wowhead da "Duration: n/a" — se queda NULL.
update cooldown_catalog set base_duration_ms = 8000  where class = 'Evoker'      and spell_id = 374227;  -- Zephyr
