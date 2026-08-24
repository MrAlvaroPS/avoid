-- §"a los paladines les aparecen muchísimos defensivos, hay que verificarlos"
-- (feedback real): auditoría completa del catálogo (group by class,name
-- having count>1) encontró UN solo duplicado real en TODA la tabla —
-- Paladin "Divine Protection" con dos spell_id distintos (498 y 403876).
-- Verificado en Wowhead: mismo efecto exacto (-20% daño, 8s, 1min CD) — es
-- la misma habilidad para el jugador aunque Blizzard use dos IDs internos
-- (probablemente uno por rama del árbol de talentos). Se queda 498, que ya
-- tiene base_duration_ms verificado (20260823100000); 403876 no.
delete from cooldown_catalog where class = 'Paladin' and spell_id = 403876;
