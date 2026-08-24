-- §"la asistencia en el roster sigue saliendo rara... la raid abrió el
-- miércoles 19 de agosto y solo hemos raideado una vez, así que la
-- asistencia debería ser 100%" (feedback real, investigado): wowaudit
-- calcula attended_percentage sobre SU PROPIO calendario de eventos
-- programados/firmas (verificado en real contra la API: total_amount_of_raids
-- varía por personaje — 1, 4, 5... — no es "noches de raid reales", es
-- "eventos programados en wowaudit a los que ese personaje pertenecía"), no
-- sobre raids que de verdad ocurrieron. Fila única con la fecha de inicio de
-- la season vigente (current_season.start_date de /v1/period, que
-- sync-wowaudit-roster ya trae) — attendance.service.ts la usa para contar
-- asistencia real: noches = reports YA IMPORTADOS en Avoid desde esa fecha,
-- asistido = el jugador aparece en player_pull_records de ese report. Dato
-- propio, no una copia de wowaudit.
create table if not exists wowaudit_season (
  id boolean primary key default true,
  start_date date not null,
  synced_at timestamptz not null default now(),
  constraint wowaudit_season_single_row check (id)
);

alter table wowaudit_season enable row level security;
create policy "read all - wowaudit_season" on wowaudit_season for select using (true);

comment on table wowaudit_season is
  'Fila única (id=true) con el inicio de la season vigente según wowaudit (/v1/period) — usada para acotar "asistencia real" (attendance.service.ts) y cualquier otra métrica que deba mirar solo la season actual.';
