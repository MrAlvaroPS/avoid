-- §el usuario pasó una pista de ChatGPT sobre Coalesced Venom (Altar) con un
-- spell ID (1310005) que NO existe en el directorio de abilities del report
-- real — pero el NOMBRE que daba, "Volatile Venom", sí coincidía con algo
-- que ya había encontrado yo mismo antes y había descartado a ojo por el
-- nombre. Esta vez se verificó a fondo contra los 4 intentos reales de
-- Lvp1VCbzmwTRHdQ7 (fights 37/38/39/40, encounterID 3429) antes de tocar
-- nada:
--   - ability real: 1282419 "Volatile Venom" (NO 1282288, que da 0 en los 4
--     intentos, ni 1310005, que ni siquiera existe en este report).
--   - applydebuff/removedebuff casan 1:1 en los 3 intentos con tiempo para
--     que expire solo (38: 19/19, 39: 16/16, 40 kill: 44/44) — 0/0 en el
--     intento de 16s que apenas empezó, coherente, no un fallo de detección.
--   - duración real ~5000ms (4991-5025ms en la muestra) — exactamente lo
--     que describía la pista: "el jugador recibe durante 5s el debuff".
--   - fuente SIEMPRE el actor "Zul'jan" (NPC, el boss), nunca el propio
--     jugador — encaja con applied_by='npc', no 'self' como tenía la fila
--     original.
--   - 8 a 18 jugadores reales distintos por intento, coherente con "lo
--     recoge cualquiera, no está asignado a nadie en concreto".
-- Conclusión: la fila 'npc_interaction' original (actor_name_pattern=
-- 'Coalesced Venom Stalker') modelaba el mecanismo equivocado — el pickup
-- real no se detecta por Casts/DamageDone contra el NPC-objeto, se detecta
-- por este debuff que aplica el BOSS. Se corrige la fila existente en vez de
-- crear una nueva (mismo boss+dificultad, es el mismo mecanismo real).
update unassigned_mechanic_catalog
set
  detection_type = 'debuff_applied',
  ability_id = 1282419,
  actor_name_pattern = null,
  applied_by = 'npc',
  has_confirmed_detection = true,
  ai_notes = ai_notes || ' [2026-08-29: CORREGIDO tras pista externa (ChatGPT, ID equivocado pero nombre correcto) — verificado contra los 4 intentos reales: ability real 1282419 "Volatile Venom", aplicada por el boss (Zul''jan), ~5000ms de duración, apply/remove casan 1:1. detection_type pasa de npc_interaction a debuff_applied, applied_by de self a npc. has_confirmed_detection=true.]'
where boss_id = '3429' and detection_type = 'npc_interaction';
