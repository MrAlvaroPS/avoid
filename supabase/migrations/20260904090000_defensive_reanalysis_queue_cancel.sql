-- §"la cola está, hay que limpiarla... un botón de cancelar cola que
-- efectivamente cancele toda la cola de forma real y eficiente" (feedback
-- real, 2026-09-04): 437 jobs bloqueados/reintentables de ANTES del
-- refactor v10 (rate limit de WCL, catálogo viejo) sin forma de descartarlos
-- — "Reintentar" solo reencola errores, nunca los descarta.
--
-- Nuevo estado terminal 'cancelled' en ambas tablas de la cola. Aditivo:
-- amplía los CHECK existentes, no toca filas ni borra nada.

alter table defensive_reanalysis_jobs
  drop constraint defensive_reanalysis_jobs_status_check;
alter table defensive_reanalysis_jobs
  add constraint defensive_reanalysis_jobs_status_check
  check (status in ('queued', 'running', 'done', 'error', 'cancelled'));

alter table defensive_reanalysis_batches
  drop constraint defensive_reanalysis_batches_status_check;
alter table defensive_reanalysis_batches
  add constraint defensive_reanalysis_batches_status_check
  check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'cancelled'));

comment on column defensive_reanalysis_jobs.status is
  'queued/running/done/error = ciclo de vida normal del worker. cancelled = descartado explícitamente por un officer (botón "Cancelar cola") — terminal, nunca se reencola ni cuenta para queued/running/retryableErrors/blockedErrors.';
comment on column defensive_reanalysis_batches.status is
  'queued/running/completed/completed_with_errors = ciclo de vida normal. cancelled = todos sus jobs no terminales se cancelaron explícitamente.';

notify pgrst, 'reload schema';
