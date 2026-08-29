-- §"hay algo raro en la infografia de gusmi... se ha colado algo en la
-- descripcion" (feedback real, 2026-08-30): 12 filas de
-- boss_mechanics_candidates (The Coiled Altar, boss_id 3429, Normal+Heroic,
-- las 6 mecánicas clasificadas en el mismo lote resolution_verified_at =
-- 2026-08-29T20:49:03.052+00:00) quedaron con un artefacto de
-- markdown-link+JSON pegado delante del texto real, p.ej.:
--   El](https://www.wowhead.com/guide/.../coiled-altar-boss-strategy-
--   abilities%22,%22https://www.method.gg/.../coiled-altar-heroic%22],%22
--   notes%22:%22%22,%22resolution%22:%22El) tank activo orienta...
-- classify-mechanics/index.ts NO parsea texto libre — recibe rawResponseText
-- ya como JSON desde el cliente (flujo manual: se copia el prompt, se pega
-- en un LLM externo, se pega la respuesta de vuelta) y hace JSON.parse
-- directo, así que un "resolution" con esta forma ya llegó corrupto DESDE
-- fuera del pipeline: el paso externo de copiar/pegar la respuesta del LLM
-- (con citas insertadas por esa interfaz) mezcló el arranque de la frase
-- real con metadatos de sources/notes/resolution de su propio JSON. Mythic
-- (mismo lote, mismo prompt) salió limpio — la clasificación en sí era
-- válida, solo el texto guardado quedó mal formado.
--
-- Reconstrucción verificada: en las 12 filas, el patrón es exactamente
-- "<primera_palabra>](...%22<primera_palabra>) <resto real de la frase>" —
-- la primera palabra aparece dos veces (como "etiqueta" del link roto y
-- justo antes del paréntesis de cierre), así que "<primera_palabra> <resto>"
-- reconstruye la frase original sin ambigüedad. Verificado fila a fila
-- contra la fila Mythic (mismo boss, mismo lote, misma redacción esperada)
-- antes de escribir este UPDATE.
begin;

update boss_mechanics_candidates
set resolution = 'Golpea a Zul''jan durante la ventana de daño aumentado mientras Malacrass está protegido; bloquea los fragmentos que intenten llegar a Zul''jan sin encadenar demasiados Spirit Erasure.'
where boss_id = '3429' and difficulty = 'Normal' and name = 'Soulbinding';

update boss_mechanics_candidates
set resolution = 'Golpea a Zul''jan durante la ventana de daño aumentado mientras Malacrass está protegido; bloquea los fragmentos que intenten llegar a Zul''jan sin encadenar demasiados Spirit Erasure.'
where boss_id = '3429' and difficulty = 'Heroic' and name = 'Soulbinding';

update boss_mechanics_candidates
set resolution = 'Jugadores asignados pisan los orbes de uno en uno, los trasladan al punto de agrupación y los dejan reaparecer allí para que Sever los destruya en tandas controladas.'
where boss_id = '3429' and difficulty = 'Normal' and name = 'Coalesced Venom';

update boss_mechanics_candidates
set resolution = 'Rompe Veil of Twilight con daño, esquiva los impactos de Twilight y, en cuanto caiga el escudo, corta Eternal Nightfall con una interrupción estándar.'
where boss_id = '3429' and difficulty = 'Normal' and name = 'Eternal Nightfall';

update boss_mechanics_candidates
set resolution = 'Esquiva los círculos de impacto de Toxic Deluge; después trata los orbes creados como Coalesced Venom y llévalos al punto previsto para Sever.'
where boss_id = '3429' and difficulty = 'Normal' and name = 'Toxic Deluge';

update boss_mechanics_candidates
set resolution = 'El tank activo orienta el frontal hacia los Coalesced Venom agrupados y lejos de la raid; alterna tanks por la vulnerabilidad y no destruyas demasiados orbes de golpe.'
where boss_id = '3429' and difficulty = 'Heroic' and name = 'Sever';

update boss_mechanics_candidates
set resolution = 'El tank apunta Soul Sever a las Manifestations agrupadas y lejos de la raid; después recoge sus fragmentos y los tanks se alternan por la vulnerabilidad.'
where boss_id = '3429' and difficulty = 'Normal' and name = 'Soul Sever';

update boss_mechanics_candidates
set resolution = 'Esquiva los puntos de impacto y no cruces la trayectoria de las hachas que recorren la sala.'
where boss_id = '3429' and difficulty = 'Normal' and name = 'Axegrinder';

update boss_mechanics_candidates
set resolution = 'El tank apunta Soul Sever a las Manifestations agrupadas y lejos de la raid; después recoge sus fragmentos y los tanks se alternan por la vulnerabilidad.'
where boss_id = '3429' and difficulty = 'Heroic' and name = 'Soul Sever';

update boss_mechanics_candidates
set resolution = 'El tank activo orienta el frontal hacia los Coalesced Venom agrupados y lejos de la raid; alterna tanks por la vulnerabilidad y no destruyas demasiados orbes de golpe.'
where boss_id = '3429' and difficulty = 'Normal' and name = 'Sever';

update boss_mechanics_candidates
set resolution = 'Rompe Veil of Twilight con daño, esquiva los impactos de Twilight y, en cuanto caiga el escudo, corta Eternal Nightfall con una interrupción estándar.'
where boss_id = '3429' and difficulty = 'Heroic' and name = 'Eternal Nightfall';

update boss_mechanics_candidates
set resolution = 'Esquiva los círculos de impacto de Toxic Deluge; después trata los orbes creados como Coalesced Venom y llévalos al punto previsto para Sever.'
where boss_id = '3429' and difficulty = 'Heroic' and name = 'Toxic Deluge';

-- Mismo criterio que invalidateNightFullReportsForBossDifficulty
-- (resync-mechanic-category.ts): el texto corrupto puede seguir viviendo
-- dentro de un informe de noche ya cacheado (night_full_reports.report
-- jsonb) para cualquier report de este boss+dificultad — se borra la fila
-- cacheada, no se recalcula aquí, la próxima apertura regenera con el
-- resolution ya limpio.
delete from night_full_reports
where report_code in (
  select distinct report_code from pulls
  where boss_id = '3429' and difficulty in ('Normal', 'Heroic')
);

commit;
