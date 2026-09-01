-- Gestión defensiva v2 · Bloque K · columnas aditivas y modo sombra.
-- La vista anterior se conserva íntegra como fuente legacy interna. La vista
-- pública mantiene todas sus columnas, en el mismo orden, y añade al final la
-- evaluación semántica v2. Esto evita reescribir de nuevo la consulta legacy
-- y permite retirar sus cálculos por etapas en el bloque L.

alter view player_pull_reliability_inputs
  rename to player_pull_reliability_inputs_legacy_v1;

create view player_pull_reliability_inputs
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
  case
    when evaluation.pull_id is null then null
    else (
      select count(*)::integer
      from jsonb_array_elements(evaluation.events) event
      where event->>'requirementLevel' = 'required'
        and event->>'state' in ('plan_covered', 'covered_with_substitution')
    )
  end as defensive_required_success_count,
  evaluation.broken_reservation_count as defensive_broken_reservation_count,
  evaluation.death_viable_cd_count as defensive_death_viable_cd_count,
  evaluation.data_confidence as defensive_evaluation_confidence,
  evaluation.evaluator_version as defensive_evaluator_version
from player_pull_reliability_inputs_legacy_v1 legacy
left join player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = legacy.pull_id
 and evaluation.player_name = legacy.player_name;

alter view player_pull_reliability_inputs_legacy_v1 set (security_invoker = true);
revoke all on player_pull_reliability_inputs_legacy_v1 from anon, authenticated;
grant select on player_pull_reliability_inputs_legacy_v1 to authenticated;
revoke all on player_pull_reliability_inputs from anon, authenticated;
grant select on player_pull_reliability_inputs to authenticated;

comment on view player_pull_reliability_inputs is
  'Fuente por pull de Fiabilidad: conserva señales legacy y añade evaluación defensiva v2. La elección v1/v2 se hace de forma atómica por fila en ReliabilityService.';
comment on column player_pull_reliability_inputs.defensive_management_score_v2 is
  'Puntuación semántica 0-100 calculada solo con decisiones evaluables; null sin evaluación fiable/backfill.';
comment on column player_pull_reliability_inputs.defensive_management_decision_count is
  'Número de decisiones que participaron en la fórmula v2; optional/hold/no-feasible/uncertain quedan fuera.';
comment on column player_pull_reliability_inputs.defensive_evaluation_confidence is
  'Confianza de la evaluación autoritativa; ReliabilityService solo activa v2 con verified/inferred.';
