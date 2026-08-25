-- §"informe de la noche... darle una vuelta... qué podemos poner que sea
-- real y sin inventar" (feedback real, 2026-08-24): un informe DETERMINISTA
-- (sin LLM, cero riesgo de invención) generado bajo demanda y cacheado por
-- noche — "Generar informe" lo calcula y guarda, "Ver informe" abre el
-- último guardado, "Actualizar" lo recalcula. Distinto del informe de IA
-- (night_briefs) que ya existe — ese sigue narrando con matices; este es
-- puramente números/porcentajes reales agregados, sin interpretación.
create table if not exists night_full_reports (
  report_code text primary key references reports(code) on delete cascade,
  report jsonb not null,
  generated_at timestamptz not null default now()
);
alter table night_full_reports enable row level security;
create policy "read all - night_full_reports" on night_full_reports for select using (true);
