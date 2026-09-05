-- IRIS Defensive Canonicalization v1 · §2.6 — corrección encontrada en
-- verificación en vivo tras 20260904110000.
--
-- Bug real: el legacy V2 (generateDefensiveEvents en
-- materialize-execution-ledger/index.ts) ya produce eventType
-- `defensive_${state}` donde state puede ser 'plan_broken' o
-- 'plan_covered' — es decir, YA EXISTEN hoy los literales
-- `defensive_plan_broken`/`defensive_plan_covered` como eventType LEGACY
-- (el propio §2.6 del plan los cita como ejemplo de legacy V2). El filtro
-- `event_type like 'defensive_plan_%'` que añadió 20260904110000 para
-- aislar la Gestión CANÓNICA nueva coincide, por accidente de nombre, con
-- ese eventType legacy — confirmado insertando un fixture real: la fila
-- legacy (generation_id NULL) mostraba defensive_plan_event_count=1 cuando
-- debía ser 0 (esa fila no contiene ningún evento canónico).
--
-- No es doble conteo entre filas (defensive_generation_id ya separaba
-- físicamente legacy de canonical, eso seguía siendo correcto — verificado:
-- las dos filas nunca suman sus penalty_count/credit_count entre sí), pero
-- SÍ es una columna con nombre namespace-scoped que podía llenarse con
-- datos legacy por coincidencia de string — justo lo que la corrección de
-- infraestructura #3 de §2.6 pide evitar "inequívocamente".
--
-- Arreglo: las columnas defensive_episode_*/defensive_plan_* exigen
-- ADEMÁS defensive_generation_id is not null — nunca pueden contar una fila
-- legacy, sin importar qué literal tenga su event_type. Solo estas 8
-- columnas cambian de fórmula; el resto de la view queda igual (mismo
-- orden de columnas que 20260904110000 — solo se editan expresiones, no
-- nombres/posiciones, así que CREATE OR REPLACE VIEW es válido aquí).

create or replace view player_pull_execution_summary_v3
with (security_invoker = true)
as
select
  e.pull_id,
  e.boss_id,
  e.difficulty,
  e.player_name,
  e.ledger_evaluator_version,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = 'success')::integer as success_count,
  count(*) filter (where e.verdict in ('failure', 'missed'))::integer as failure_count,
  count(*) filter (where e.verdict = 'correct_hold')::integer as correct_hold_count,
  count(*) filter (where e.verdict = 'uncertain')::integer as uncertain_count,
  count(*) filter (where e.domain = 'mechanic' and e.penalty_eligible)::integer as mechanic_failure_count,
  count(*) filter (where e.domain in ('defensive', 'external') and e.penalty_eligible)::integer as defensive_failure_count,
  count(*) filter (where e.domain = 'consumable' and e.penalty_eligible)::integer as consumable_failure_count,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  e.defensive_generation_id,
  -- CORREGIDO: + "e.defensive_generation_id is not null" — nunca cuenta
  -- una fila legacy aunque su event_type coincida por string (ver cabecera).
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%')::integer as defensive_episode_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.verdict = 'uncertain')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%')::integer as defensive_plan_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
group by e.pull_id, e.boss_id, e.difficulty, e.player_name, e.ledger_evaluator_version, e.defensive_generation_id;

create or replace view night_player_execution_summary_v3
with (security_invoker = true)
as
select
  p.report_code,
  e.player_name,
  count(distinct e.pull_id)::integer as pull_count,
  count(*)::integer as event_count,
  count(*) filter (where e.credit_eligible)::integer as credit_count,
  count(*) filter (where e.penalty_eligible)::integer as penalty_count,
  count(*) filter (where e.primary_penalty)::integer as primary_penalty_count,
  count(*) filter (where e.verdict = 'uncertain')::integer as uncertain_count,
  array_agg(distinct e.ledger_evaluator_version order by e.ledger_evaluator_version) as ledger_evaluator_versions,
  array_agg(distinct e.context_resolver_version order by e.context_resolver_version) as context_resolver_versions,
  array_agg(distinct e.occurrence_resolver_version order by e.occurrence_resolver_version)
    filter (where e.occurrence_resolver_version is not null) as occurrence_resolver_versions,
  array_agg(distinct e.policy_version order by e.policy_version)
    filter (where e.policy_version is not null) as policy_versions,
  count(distinct e.ledger_evaluator_version) = 1
    and count(distinct e.context_resolver_version) = 1
    and count(distinct e.occurrence_resolver_version) filter (where e.occurrence_resolver_version is not null) <= 1
    and count(distinct e.policy_version) filter (where e.policy_version is not null) <= 1
    as versions_homogeneous,
  max(e.evaluated_at) as evaluated_at,
  e.defensive_generation_id,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%')::integer as defensive_episode_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_episode_%' and e.verdict = 'uncertain')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%')::integer as defensive_plan_event_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.defensive_generation_id is not null and e.event_type like 'defensive_plan_%' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
join pulls p on p.id = e.pull_id
group by p.report_code, e.player_name, e.defensive_generation_id;

comment on view player_pull_execution_summary_v3 is
  'Resumen por pull+jugador del ledger v3, generation-aware (§2.6 corrección #3, con el fix de 20260904120000): defensive_generation_id en el GROUP BY separa físicamente cualquier evento canónico defensive_episode_*/defensive_plan_* de la fila legacy; las columnas defensive_episode_*/defensive_plan_* además exigen generation_id is not null para no contar nunca un evento legacy que coincida de nombre (ej. defensive_plan_broken/defensive_plan_covered ya existen como eventType V2). defensive_failure_count conserva su fórmula original (domain in (defensive,external) and penalty_eligible) para no romper el shadow comparator existente.';
comment on view night_player_execution_summary_v3 is
  'Resumen por noche(report)+jugador del ledger v3, generation-aware — mismo criterio que player_pull_execution_summary_v3 (ver su comentario, incluido el fix de 20260904120000).';

revoke all on player_pull_execution_summary_v3, night_player_execution_summary_v3 from anon;
grant select on player_pull_execution_summary_v3, night_player_execution_summary_v3 to authenticated;

notify pgrst, 'reload schema';
