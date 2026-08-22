-- §12.1 de la hoja de ruta: catálogo de cooldowns defensivos sincronizado
-- desde el repo real de WoWAnalyzer (Docker + extractor), no mantenido a
-- mano. El esquema nuevo (schema.sql) nunca tuvo esta tabla — se reintroduce
-- ahora, con el catálogo verificado a mano (35 entradas, ver
-- _shared/defensive-cooldowns.ts) como semilla inicial, para no perder
-- cobertura mientras se sincroniza la extracción real.
--
-- analyze-report la carga UNA VEZ por invocación (no por evento) y la pasa
-- en memoria a activeDefensives()/defensivesForClass() — con cientos/miles
-- de eventos de daño por pull, una query por evento sería inviable.

create table if not exists cooldown_catalog (
  id uuid primary key default gen_random_uuid(),
  class text not null, -- tal cual lo da WCL en actor.subType (ej. "DeathKnight", no "Death Knight")
  spec text, -- null = aplica a toda la clase, no a una spec concreta
  spell_id int not null,
  name text not null,
  category text not null default 'personal_defensive'
    check (category in ('personal_defensive', 'semi_defensive', 'external_defensive', 'utility')),
  synced_from_commit text, -- SHA del commit de WoWAnalyzer/WoWAnalyzer usado, null = semilla manual
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (class, spell_id)
);
create index if not exists cooldown_catalog_class_idx on cooldown_catalog (class);

alter table cooldown_catalog enable row level security;
create policy "read all - cooldown_catalog" on cooldown_catalog for select using (true);

-- Semilla: el catálogo verificado a mano contra Blizzard Game Data el
-- 2026-08-21 (ver cabecera de _shared/defensive-cooldowns.ts para el
-- proceso de verificación). synced_from_commit queda null a propósito —
-- así se distingue de un dato ya sincronizado desde el repo real.
insert into cooldown_catalog (class, spec, spell_id, name, category) values
  ('Warrior', 'Protection', 871, 'Shield Wall', 'personal_defensive'),
  ('Warrior', 'Arms', 118038, 'Die by the Sword', 'personal_defensive'),
  ('Warrior', 'Fury', 184364, 'Enraged Regeneration', 'personal_defensive'),
  ('Paladin', null, 642, 'Divine Shield', 'personal_defensive'),
  ('Paladin', null, 498, 'Divine Protection', 'personal_defensive'),
  ('Paladin', 'Protection', 31850, 'Ardent Defender', 'personal_defensive'),
  ('Paladin', 'Protection', 86659, 'Guardian of Ancient Kings', 'personal_defensive'),
  ('DeathKnight', null, 48792, 'Icebound Fortitude', 'personal_defensive'),
  ('DeathKnight', null, 48707, 'Anti-Magic Shell', 'personal_defensive'),
  ('DeathKnight', 'Blood', 55233, 'Vampiric Blood', 'personal_defensive'),
  ('Hunter', null, 186265, 'Aspect of the Turtle', 'personal_defensive'),
  ('Hunter', null, 109304, 'Exhilaration', 'personal_defensive'),
  ('Rogue', null, 31224, 'Cloak of Shadows', 'personal_defensive'),
  ('Rogue', null, 1966, 'Feint', 'semi_defensive'),
  ('Rogue', null, 185311, 'Crimson Vial', 'personal_defensive'),
  ('Priest', 'Discipline', 33206, 'Pain Suppression', 'external_defensive'),
  ('Priest', 'Holy', 19236, 'Desperate Prayer', 'personal_defensive'),
  ('Priest', null, 586, 'Fade', 'semi_defensive'),
  ('Shaman', null, 108271, 'Astral Shift', 'personal_defensive'),
  ('Mage', null, 45438, 'Ice Block', 'personal_defensive'),
  ('Mage', null, 110959, 'Greater Invisibility', 'personal_defensive'),
  ('Warlock', null, 104773, 'Unending Resolve', 'personal_defensive'),
  ('Warlock', 'Affliction', 108416, 'Dark Pact', 'personal_defensive'),
  ('Monk', null, 115203, 'Fortifying Brew', 'personal_defensive'),
  ('Monk', null, 122783, 'Diffuse Magic', 'personal_defensive'),
  ('Monk', null, 122278, 'Dampen Harm', 'personal_defensive'),
  ('Druid', null, 22812, 'Barkskin', 'personal_defensive'),
  ('Druid', 'Feral/Guardian', 61336, 'Survival Instincts', 'personal_defensive'),
  ('DemonHunter', 'Havoc', 198589, 'Blur', 'personal_defensive'),
  ('DemonHunter', 'Havoc', 196555, 'Netherwalk', 'personal_defensive'),
  ('DemonHunter', 'Vengeance', 187827, 'Metamorphosis', 'personal_defensive'),
  ('Evoker', null, 363916, 'Obsidian Scales', 'personal_defensive'),
  ('Evoker', null, 374348, 'Renewing Blaze', 'personal_defensive'),
  ('Evoker', 'Preservation', 374227, 'Zephyr', 'personal_defensive')
on conflict (class, spell_id) do nothing;
