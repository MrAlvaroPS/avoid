-- §verificación real contra Lvp1VCbzmwTRHdQ7 (todos los pulls reales de
-- Ula'tek [41,42,43, incluye el kill] y del Altar [37,38,39,40, incluye el
-- kill]): las 4 filas 'npc_interaction' (3 huevos de Ula'tek + orbe del
-- Altar) dan CERO eventos en Casts/DamageDone/DamageTaken/Buffs/Debuffs/
-- Deaths, tanto de fuente como de objetivo, en TODOS los intentos reales del
-- report que las sembró — el propio kill incluido. También se buscó a mano
-- cualquier buff/debuff cuyo nombre sugiriera "llevas el orbe/huevo" (el
-- usuario dijo "ese orbe concreto al cogerlo, deja un debuffo que luego
-- expira" — feedback real, 2026-08-29): existe la habilidad "Coalesced
-- Venom" en masterData.abilities, pero NUNCA se aplica como buff/debuff real
-- en ninguno de los 4 intentos del Altar — coincide con lo ya documentado en
-- unassigned-mechanics.ts de que esa habilidad es la CONSECUENCIA de raid
-- (AoE) si nadie lo hace, no la marca de quién lo coge.
--
-- Conclusión honesta: recoger estos objetos probablemente sea una
-- interacción de cliente (tipo "usar objeto del suelo") sin ningún rastro en
-- el combat log de WCL — no es un fallo de la query, es un techo real de la
-- fuente de datos. La fila 'cast' de Lost Explorers (Disgusting Fish, ability
-- 1296535) SÍ se verificó con una ocurrencia real (Smöll, pull real) antes de
-- escribir esta migración.
--
-- En vez de borrar la investigación (los actor_name_pattern siguen siendo
-- NPCs reales y correctos, y la clasificación del mecanismo del boss sigue
-- siendo cierta) se añade un interruptor explícito: solo las filas con
-- detección CONFIRMADA contra datos reales entran en el catálogo que usan
-- analyze-report/reanalyze-unassigned-mechanics — así una fila "investigada
-- pero sin señal en WCL" no se cuela silenciosamente como si funcionara.
alter table unassigned_mechanic_catalog add column if not exists has_confirmed_detection boolean not null default false;
comment on column unassigned_mechanic_catalog.has_confirmed_detection is 'true solo si se ha visto al menos una ocurrencia real en datos de WCL de verdad (no solo "el NPC/ability existe en masterData") — analyze-report/reanalyze-unassigned-mechanics filtran por esto, para que una fila investigada-pero-sin-señal no aparente funcionar.';

update unassigned_mechanic_catalog
set has_confirmed_detection = true
where boss_id = '3497' and detection_type = 'cast' and ability_id = 1296535;

update unassigned_mechanic_catalog
set ai_notes = ai_notes || ' [2026-08-29: verificado contra TODOS los pulls reales de Lvp1VCbzmwTRHdQ7 incluyendo el kill — 0 eventos en Casts/DamageDone/DamageTaken/Buffs/Debuffs/Deaths para este actor. Probable interacción sin rastro en combat log. has_confirmed_detection=false hasta encontrar señal real.]'
where boss_id in ('3492', '3429') and detection_type = 'npc_interaction';
