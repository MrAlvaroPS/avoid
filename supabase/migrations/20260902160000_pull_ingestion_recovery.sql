-- Ingesta de reports recuperable por pull.
--
-- analyze-report escribe varias tablas mediante HTTP independientes. El cursor
-- del report no puede ser la única señal de completitud: un fallo después de
-- insertar pulls deja una fila real pero incompleta. Este estado explícito
-- permite reemplazar únicamente ese trabajo parcial y conservar cualquier pull
-- que sí llegó a completarse aunque después fallase el avance del cursor.

alter table pulls
  add column if not exists ingestion_status text not null default 'processing',
  add column if not exists ingestion_error text;

alter table pulls
  drop constraint if exists pulls_ingestion_status_check;
alter table pulls
  add constraint pulls_ingestion_status_check
  check (ingestion_status in ('processing', 'complete', 'failed'));

-- Todas las filas anteriores al despliegue se consideran completas salvo las
-- que quedaron por delante del cursor persistido: esas son exactamente las
-- creadas por un batch que no llegó a confirmar su final.
update pulls
set ingestion_status = 'complete', ingestion_error = null;

update pulls pull
set
  ingestion_status = 'failed',
  ingestion_error = 'Ingesta parcial detectada: el fight quedó por delante de last_processed_fight_id.'
from reports report
where report.code = pull.report_code
  and pull.fight_id > coalesce(report.last_processed_fight_id, 0);

create index if not exists pulls_report_ingestion_status_idx
  on pulls (report_code, ingestion_status, fight_id);

comment on column pulls.ingestion_status is
  'Estado transaccional lógico de analyze-report. Solo complete puede tratarse como evidencia importada íntegra.';
comment on column pulls.ingestion_error is
  'Último error verificable si la ingesta del pull quedó parcial. Null en processing/complete.';

notify pgrst, 'reload schema';
