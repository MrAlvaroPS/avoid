-- M23 · Ninguna superficie de lectura puede tratar una ingesta parcial como
-- evidencia. M22 ya añadió el estado y recuperó el huérfano histórico; esta
-- migración separada endurece consumidores después de comprobar que M22 ya
-- estaba aplicada en producción.

-- La service_role de analyze-report conserva acceso para recuperar filas
-- processing/failed, pero ningún lector autenticado debe verlas como pulls.
drop policy if exists "read all - pulls" on pulls;
drop policy if exists "read complete - pulls" on pulls;
create policy "read complete - pulls" on pulls
  for select using (ingestion_status = 'complete');

-- La readiness usa service_role y por tanto salta RLS. El filtro explícito
-- evita que un pull parcial infle sus totales incluso en esa ruta privilegiada.
-- Se conserva exactamente el contrato y el orden de columnas publicados por M21.
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
  evaluation.required_exact_adherence_count as defensive_required_exact_adherence_count,
  evaluation.solver_version as defensive_solver_version,
  evaluation.game_build as defensive_game_build,
  evaluation.build_fingerprint as defensive_build_fingerprint,
  evaluation.evaluated_at as defensive_evaluated_at
from player_pull_reliability_inputs_legacy_v1 legacy
join pulls source_pull
  on source_pull.id = legacy.pull_id
 and source_pull.ingestion_status = 'complete'
left join player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = legacy.pull_id
 and evaluation.player_name = legacy.player_name;

revoke all on player_pull_reliability_inputs from anon, authenticated;
grant select on player_pull_reliability_inputs to authenticated;

notify pgrst, 'reload schema';
