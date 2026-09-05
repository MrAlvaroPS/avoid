-- §"un cast debe cubrir toda su ventana de duración (no un recordatorio por
-- cada ocurrencia cercana)" (feedback real, 2026-09-03). El solver
-- (defensive-plan-solver@2.2.0) ahora detecta cuándo una ocurrencia cubierta
-- ya está protegida por la duración de un cast anterior del mismo
-- jugador+defensivo — no hace falta un press nuevo, así que no debe generar
-- un segundo recordatorio de MRT para lo mismo.

alter table defensive_plan_slots
  add column if not exists needs_fresh_cast boolean not null default true,
  add column if not exists covered_by_prior_cast_at_ms integer
    check (covered_by_prior_cast_at_ms is null or covered_by_prior_cast_at_ms >= 0);

alter table defensive_plan_slots
  drop constraint if exists defensive_plan_slots_duration_coverage_check;
alter table defensive_plan_slots
  add constraint defensive_plan_slots_duration_coverage_check
  check (needs_fresh_cast or coverage_status in ('covered', 'partial'));

comment on column defensive_plan_slots.needs_fresh_cast is
  'false = este slot ya está protegido por la duración de un cast anterior del mismo jugador+defensivo; no generar un recordatorio MRT nuevo.';
comment on column defensive_plan_slots.covered_by_prior_cast_at_ms is
  'planned_cast_at_ms del cast anterior que ya cubre este slot, cuando needs_fresh_cast es false.';
