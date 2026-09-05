-- IRIS Defensivos v2 · cierre de consistencia previo a infografía fiable.
--
-- Mantiene compatibilidad con plan_executed_count, pero deja de usar ese
-- nombre ambiguo como única verdad: adherencia exacta y cobertura funcional
-- son dimensiones distintas. También completa la clave semántica que consume
-- Fiabilidad para poder seleccionar v2 de forma atómica.

alter table player_pull_defensive_evaluations
  add column if not exists required_exact_adherence_count integer not null default 0,
  add column if not exists required_coverage_success_count integer not null default 0;

update player_pull_defensive_evaluations evaluation
set
  required_exact_adherence_count = (
    select count(*)::integer
    from jsonb_array_elements(evaluation.events) event
    where event->>'requirementLevel' = 'required'
      and event->>'state' = 'plan_covered'
  ),
  required_coverage_success_count = (
    select count(*)::integer
    from jsonb_array_elements(evaluation.events) event
    where event->>'requirementLevel' = 'required'
      and event->>'coverageOutcome' = 'covered'
  );

alter table player_pull_defensive_evaluations
  drop constraint if exists player_pull_defensive_evaluations_exact_adherence_check;
alter table player_pull_defensive_evaluations
  add constraint player_pull_defensive_evaluations_exact_adherence_check
  check (
    required_exact_adherence_count >= 0
    and required_exact_adherence_count <= required_coverage_success_count
    and required_exact_adherence_count <= plan_required_count
  );

alter table player_pull_defensive_evaluations
  drop constraint if exists player_pull_defensive_evaluations_coverage_success_check;
alter table player_pull_defensive_evaluations
  add constraint player_pull_defensive_evaluations_coverage_success_check
  check (
    required_coverage_success_count >= 0
    and required_coverage_success_count <= plan_required_count
  );

comment on column player_pull_defensive_evaluations.required_exact_adherence_count is
  'Required cubiertos exactamente con el spell planificado. Una sustitución no incrementa este contador.';
comment on column player_pull_defensive_evaluations.required_coverage_success_count is
  'Required funcionalmente cubiertos, incluyendo sustituciones. No implica que la gestión de reserva fuese correcta.';

create or replace view player_pull_reliability_inputs
with (security_invoker = true) as
select
  legacy.*,
  evaluation.management_score as defensive_management_score_v2,
  case
    when evaluation.pull_id is null then null
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where event->>'state' in (
        'plan_broken',
        'death_with_viable_cd',
        'safe_extra_use',
        'missed_extra_opportunity'
      )
      or (
        event->>'state' in ('plan_covered', 'covered_with_substitution', 'reminder_missed')
        and event->>'requirementLevel' in ('required', 'recommended')
      )
    )
  end as defensive_management_decision_count,
  evaluation.plan_required_count as defensive_required_count,
  evaluation.required_coverage_success_count as defensive_required_success_count,
  evaluation.broken_reservation_count as defensive_broken_reservation_count,
  evaluation.death_viable_cd_count as defensive_death_viable_cd_count,
  evaluation.data_confidence as defensive_evaluation_confidence,
  evaluation.evaluator_version as defensive_evaluator_version,
  evaluation.resolver_version as defensive_resolver_version,
  -- PostgreSQL exige conservar intactos nombre y orden de las columnas ya
  -- publicadas por M18; toda superficie nueva se añade después.
  evaluation.required_exact_adherence_count as defensive_required_exact_adherence_count,
  evaluation.solver_version as defensive_solver_version,
  evaluation.game_build as defensive_game_build,
  evaluation.build_fingerprint as defensive_build_fingerprint,
  evaluation.evaluated_at as defensive_evaluated_at
from player_pull_reliability_inputs_legacy_v1 legacy
left join player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = legacy.pull_id
 and evaluation.player_name = legacy.player_name;

revoke all on player_pull_reliability_inputs from anon, authenticated;
grant select on player_pull_reliability_inputs to authenticated;

comment on column player_pull_reliability_inputs.defensive_required_success_count is
  'Cobertura required funcional. No equivale a adherencia exacta ni a éxito de gestión.';
comment on column player_pull_reliability_inputs.defensive_required_exact_adherence_count is
  'Required cubiertos con el spell exacto publicado en el plan.';
comment on column player_pull_reliability_inputs.defensive_solver_version is
  'Versión del solver ligada a la evaluación defensiva.';
comment on column player_pull_reliability_inputs.defensive_evaluated_at is
  'Revisión derivada usada para invalidación y selección de generación visible.';

notify pgrst, 'reload schema';
