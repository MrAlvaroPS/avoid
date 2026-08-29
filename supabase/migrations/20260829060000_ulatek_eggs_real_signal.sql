-- §misma corrección que el orbe del Altar (migración 20260829050000), esta
-- vez para los huevos de Ula'tek: el usuario pasó otra pista de ChatGPT con
-- "Malignant Shell" (spell 1295360) — ESTE nombre coincide exactamente con
-- lo que el propio usuario había dicho de memoria al principio de esta
-- función ("De ula'tek me refiero a la habilidad Malignant Shell"), que en
-- su momento no se pudo confirmar. Verificado ahora a fondo contra los 3
-- intentos reales de Lvp1VCbzmwTRHdQ7 (fights 41/42/43, encounterID 3492,
-- kill incluido):
--   - 1295360 "Malignant Shell": SIEMPRE aplicado por el actor "Ula'tek"
--     (el propio boss, no un NPC-objeto suelto) — 13/14/21 aplicaciones en
--     los 3 intentos, sobre 13/11/15 jugadores distintos. Cubre TANTO el
--     huevo "racimo" (Quivering Egg Cluster) como el "individual"
--     (Squirming Egg) — son el mismo evento real de recogida, solo con
--     nombres narrativos distintos en el propio juego; un único debuff los
--     representa a los dos.
--   - 1300312 "Doomscale Shell": mismo patrón (fuente = Ula'tek), 0/1/2
--     aplicaciones — encaja con "el huevo grande de fase 2, uno por
--     intento" (0 en el intento 41 porque ese wipe no llegó a fase 2).
-- La fila 'individual' (Squirming Egg) queda REDUNDANTE — el mismo evento
-- real que ya cubre la fila 'racimo' una vez corregida a debuff_applied, no
-- dos mecanismos distintos — se borra en vez de dejarla viva sin usar,
-- para que el catálogo no tenga dos filas confirmadas apuntando al mismo
-- hecho real (contaría dos veces el mismo pickup si las dos quedaran
-- activas con detection_type distinto).
update unassigned_mechanic_catalog
set
  name = 'Huevo de Ula''tek (Malignant Shell)',
  detection_type = 'debuff_applied',
  ability_id = 1295360,
  actor_name_pattern = null,
  applied_by = 'npc',
  has_confirmed_detection = true,
  ai_notes = ai_notes || ' [2026-08-29: CORREGIDO tras pista externa (ChatGPT + memoria original del usuario, coincidían en el nombre) — verificado contra los 3 intentos reales: ability real 1295360 "Malignant Shell", aplicada por el boss (Ula''tek), cubre tanto racimo como individual. detection_type pasa de npc_interaction a debuff_applied, applied_by de self a npc. has_confirmed_detection=true.]'
where id = 'b67e9dec-9c30-49dc-b2e2-8ec016a2dbd9';

update unassigned_mechanic_catalog
set
  detection_type = 'debuff_applied',
  ability_id = 1300312,
  actor_name_pattern = null,
  applied_by = 'npc',
  has_confirmed_detection = true,
  ai_notes = ai_notes || ' [2026-08-29: CORREGIDO — ability real 1300312 "Doomscale Shell", aplicada por el boss (Ula''tek), verificado contra los 3 intentos reales (0/1/2, coherente con "una vez por intento en fase 2"). detection_type pasa de npc_interaction a debuff_applied, applied_by de self a npc. has_confirmed_detection=true.]'
where id = '99ca1166-7bd1-40cd-91f5-2f743c35cc96';

delete from unassigned_mechanic_catalog where id = '5f661c09-194d-4cc6-bb32-a87e52435118';
