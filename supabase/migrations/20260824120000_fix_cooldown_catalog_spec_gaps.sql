-- §"tienes que repasar defensivos REALMENTE que pueden usar y tienen
-- disponible, por ejemplo linkedara es un sacerdote disciplina y le pones
-- disponible dispersión, que es exclusivo de sacerdote sombras... supongo
-- que esto mismo afecta a varias clases distintas" (feedback real,
-- 2026-08-24, con captura real: Linkedara/Disciplina viendo Dispersion
-- disponible).
--
-- Causa raíz: el extractor (supabase/wowanalyzer-extractor/extract.mjs)
-- deriva `spec` del PATH del fichero fuente de WoWAnalyzer
-- (analysis/retail/{clase}/{spec}/Abilities.tsx -> spec; carpeta "shared"
-- o el fichero directamente en la carpeta de clase -> spec=null,
-- "compartido entre todas las specs"). Esa heurística asume que WoWAnalyzer
-- organiza sus ficheros por disponibilidad real, pero varias defensivas
-- viven en su carpeta "shared" solo por conveniencia de organización del
-- código de esa librería, no porque las tenga toda la clase — de ahí que
-- salieran con spec=null en cooldown_catalog aunque el hechizo sea de UNA
-- sola spec en el juego real.
--
-- Auditada TODA la tabla fila a fila contra el diseño real de cada clase
-- (confirmado además con la descripción real de Blizzard Game Data API para
-- cada spell_id de aquí abajo — ej. Shield Block "Raise your shield..."
-- solo tiene sentido con escudo, exclusivo de Protection). Sin checkout de
-- WoWAnalyzer disponible en esta sesión para re-ejecutar el extractor
-- (requiere Docker) — esto es una corrección de datos puntual sobre las
-- filas hoy erróneas, no un cambio al extractor en sí. Si se vuelve a
-- ejecutar el extractor sin arreglar la heurística de "shared" primero,
-- estas mismas filas pueden volver a quedar en null.

-- Demon Hunter: Demon Spikes y Fiery Brand son herramientas de mitigación
-- de Vengeance (armadura/reducción de daño de tanque) — Havoc no las tiene.
update cooldown_catalog set spec = 'Vengeance' where class = 'DemonHunter' and spell_id in (203720, 204021);

-- Mage: las tres "barrera" son variantes paralelas, una por spec — un mago
-- solo tiene UNA de las tres en su hechizario según su especialización.
update cooldown_catalog set spec = 'Fire' where class = 'Mage' and spell_id = 235313; -- Blazing Barrier
update cooldown_catalog set spec = 'Frost' where class = 'Mage' and spell_id = 11426; -- Ice Barrier
update cooldown_catalog set spec = 'Arcane' where class = 'Mage' and spell_id = 235450; -- Prismatic Barrier

-- Priest: Dispersion es exclusivo de Shadow — el caso reportado en real.
update cooldown_catalog set spec = 'Shadow' where class = 'Priest' and spell_id = 47585;

-- Warrior: Defensive Stance (la propia stance es de Protection), Ignore
-- Pain y Shield Block (exige escudo equipado) son herramientas de
-- mitigación exclusivas de Protection — Arms/Fury no las tienen.
update cooldown_catalog set spec = 'Protection' where class = 'Warrior' and spell_id in (386208, 190456, 2565);
