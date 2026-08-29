-- §"aqui en la descripcion del informe de noche tambien se ha colado algo"
-- (feedback real, 2026-08-30): la migración anterior
-- (20260830090000_fix_corrupted_coiled_altar_resolutions.sql) arregló 12
-- filas de `resolution` en The Coiled Altar (boss_id 3429). Un barrido
-- completo de la tabla encontró el MISMO artefacto de markdown-link+JSON,
-- esta vez en `ai_classification->>'notes'` — 233 filas repartidas en 4
-- bosses (Sszorak/Ula'tek incluidos, boss_id 3420 y 3492 entre ellos).
-- Mismo origen: classify-mechanics/index.ts no llama al LLM directamente
-- (flujo manual: se copia el prompt, se pega en un LLM externo, se pega la
-- respuesta de vuelta) — un "notes" con esta forma llegó corrupto DESDE
-- fuera del pipeline, JSON.parse lo aceptó porque como STRING era válido.
--
-- El patrón es idéntico en las 233 filas y ya verificado exhaustivamente
-- contra la tabla real antes de escribir este UPDATE (ver conversación):
--   "<primera_palabra>](<sources%22-separadas>],%22notes%22:%22
--   <primera_palabra>) <resto real de la nota>"
-- La primera palabra aparece dos veces (como "etiqueta" del link roto y
-- justo antes del paréntesis de cierre) — "<primera_palabra> <resto>"
-- reconstruye la nota original sin ambigüedad. A diferencia del fix
-- anterior (12 filas, reconstrucción manual una a una), aquí se usa una
-- regexp_replace genérica: confirmado con SELECT de verificación que
-- limpia las 233 filas sin dejar ningún residuo "%22" ni "](" — no hace
-- falta (ni sería practico) escribir 233 UPDATE literales.
--
-- classify-mechanics/index.ts ya lleva un guard (validateResolution)
-- añadido en el mismo bloque de trabajo para que un "resolution" con esta
-- forma se rechace en el momento de guardar — pero esa función solo valida
-- resolution, no notes (notes se guarda en un paso de clasificación previo,
-- sin la validación estricta de fuentes/longitud que sí tiene resolution).
-- Este UPDATE es la limpieza retroactiva de datos; no cambia el pipeline.
begin;

-- Captura los boss_id afectados ANTES del update de abajo — si se leyera
-- después, el propio UPDATE ya habría limpiado el '%22' que identifica las
-- filas a invalidar y esta subconsulta encontraría cero bosses por error.
create temporary table _corrupted_notes_boss_ids on commit drop as
select distinct boss_id
from boss_mechanics_candidates
where strpos(coalesce(ai_classification->>'notes', ''), '%22') > 0;

update boss_mechanics_candidates
set ai_classification = jsonb_set(
  ai_classification,
  '{notes}',
  to_jsonb(regexp_replace(ai_classification->>'notes', '^(.+?)\]\(.*?%22\1\)', '\1')),
  false
)
where strpos(coalesce(ai_classification->>'notes', ''), '%22') > 0;

-- Mismo criterio que la migración anterior: el texto corrupto puede seguir
-- viviendo dentro de un informe de noche ya cacheado. Se invalidan TODOS
-- los informes cacheados de los bosses afectados, la próxima apertura
-- regenera con las notas ya limpias.
delete from night_full_reports
where report_code in (
  select distinct p.report_code
  from pulls p
  where p.boss_id in (select boss_id from _corrupted_notes_boss_ids)
);

commit;
