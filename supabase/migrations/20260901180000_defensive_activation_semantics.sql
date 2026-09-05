-- IRIS Defensivos v2 · semántica activa/pasiva por build
--
-- Una fila del catálogo puede representar una habilidad que deja de ser un
-- botón asignable al seleccionar otro talento (por ejemplo, una conversión
-- a pasiva). category/targeting_mode no expresan esa disponibilidad.

alter table cooldown_catalog
  add column if not exists activation_mode text not null default 'active',
  add column if not exists passive_conversion_spell_ids bigint[] not null default '{}',
  add column if not exists activation_game_build text not null default 'legacy-current';

alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_activation_mode_check;
alter table cooldown_catalog
  add constraint cooldown_catalog_activation_mode_check
  check (activation_mode in ('active', 'passive'));

alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_activation_game_build_check;
alter table cooldown_catalog
  add constraint cooldown_catalog_activation_game_build_check
  check (btrim(activation_game_build) <> '');

alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_passive_conversion_ids_check;
alter table cooldown_catalog
  add constraint cooldown_catalog_passive_conversion_ids_check
  check (
    array_position(passive_conversion_spell_ids, null) is null
    and 0::bigint < all(passive_conversion_spell_ids)
  );

comment on column cooldown_catalog.activation_mode is
  'Forma base actual de la habilidad: active puede asignarse; passive solo se muestra como contexto y nunca entra al solver/reminder.';
comment on column cooldown_catalog.passive_conversion_spell_ids is
  'Talentos/pasivas cuyo spellId seleccionado convierte esta habilidad activa en pasiva o elimina su botón asignable.';
comment on column cooldown_catalog.activation_game_build is
  'Build para el que se verificaron activation_mode y passive_conversion_spell_ids. legacy-current conserva filas anteriores sin fingir versionado exacto.';

-- Fiabilidad no puede considerar materializada una evaluación calculada con
-- un resolver anterior: el evaluator puede ser el mismo y, aun así, haber
-- tratado como asignable un botón convertido en pasiva.
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
  evaluation.evaluator_version as defensive_evaluator_version,
  evaluation.resolver_version as defensive_resolver_version
from player_pull_reliability_inputs_legacy_v1 legacy
left join player_pull_defensive_evaluations evaluation
  on evaluation.pull_id = legacy.pull_id
 and evaluation.player_name = legacy.player_name;

revoke all on player_pull_reliability_inputs from anon, authenticated;
grant select on player_pull_reliability_inputs to authenticated;

comment on column player_pull_reliability_inputs.defensive_resolver_version is
  'Versión exacta del resolver con la que se materializó la evaluación; Fiabilidad v2 solo consume la versión vigente.';

notify pgrst, 'reload schema';
