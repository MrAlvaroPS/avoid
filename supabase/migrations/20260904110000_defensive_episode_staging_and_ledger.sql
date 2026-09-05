-- IRIS Defensive Canonicalization v1 · §2.6 — staging table + ledger
-- generation-aware. Ver iris-defensive-canonicalization-v1-plan.md §2.6.
--
-- Puramente aditivo, shadow puro: no se toca defensive_generation_pointer,
-- no se marca ninguna generación 'ready', no se borra/edita ninguna fila V2
-- existente (player_pull_defensive_evaluations). player_execution_events
-- está vacía hoy (0 filas totales, confirmado contra Supabase real antes de
-- escribir esta migración) — el cambio de agrupación de las views es
-- retrocompatible por construcción: agrupar por una columna nueva que hoy
-- es NULL en todas las filas no fragmenta ni cambia ningún número que ya
-- exista.

-- ============================================================================
-- 1) Tabla de staging (patrón evaluate→persist→materialize ya usado por
--    player_pull_defensive_evaluations V2 — mismo RLS, mismo estilo de
--    índices). Versionada por defensive_generation_id: una corrida shadow
--    nueva NO pisa la anterior de otra generación (UNIQUE incluye la
--    generación, no solo pull+player).
-- ============================================================================

create table if not exists player_pull_defensive_episode_evaluations (
  defensive_generation_id uuid not null references defensive_generations (id) on delete cascade,
  pull_id uuid not null references pulls (id) on delete cascade,
  player_name text not null check (nullif(btrim(player_name), '') is not null),
  episode_evaluator_version text not null check (nullif(btrim(episode_evaluator_version), '') is not null),
  semantic_version text not null check (nullif(btrim(semantic_version), '') is not null),
  semantic_resolver_version text not null check (nullif(btrim(semantic_resolver_version), '') is not null),
  resolver_version text not null check (nullif(btrim(resolver_version), '') is not null),
  build_fingerprint text,
  data_confidence text not null check (data_confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  episodes jsonb not null default '[]'::jsonb check (jsonb_typeof(episodes) = 'array'),
  evaluated_at timestamptz not null default now(),
  primary key (defensive_generation_id, pull_id, player_name)
);

create index if not exists player_pull_defensive_episode_evaluations_pull_idx
  on player_pull_defensive_episode_evaluations (pull_id, player_name);
create index if not exists player_pull_defensive_episode_evaluations_scoring_idx
  on player_pull_defensive_episode_evaluations (episode_evaluator_version, data_confidence, evaluated_at desc);
create index if not exists player_pull_defensive_episode_evaluations_generation_idx
  on player_pull_defensive_episode_evaluations (defensive_generation_id, evaluated_at desc);

alter table player_pull_defensive_episode_evaluations enable row level security;
drop policy if exists "player_pull_defensive_episode_evaluations: officers read" on player_pull_defensive_episode_evaluations;
create policy "player_pull_defensive_episode_evaluations: officers read"
  on player_pull_defensive_episode_evaluations for select using (is_officer());

revoke all on player_pull_defensive_episode_evaluations from anon, authenticated;
grant select on player_pull_defensive_episode_evaluations to authenticated;

comment on table player_pull_defensive_episode_evaluations is
  'Staging v3 (episodios) — una fila por generación+pull+jugador, versionada por defensive_generation_id (§2.6 del plan de canonicalización defensiva). Aditiva junto a player_pull_defensive_evaluations (V2, sin tocar). UNIQUE(generation, pull, player) evita que una corrida shadow nueva pise una generación anterior.';
comment on column player_pull_defensive_episode_evaluations.episodes is
  'Array de DefensiveEpisode persistidos completos: episodeId, causalGroupId, ventana (startMs/peakMs/endMs), usageEngaged/usageEvaluable, usedSpellIds, applicableCandidates (membership+applicability+availability por spellId), responseVerdict/responseReason, plan linkage opcional (planAssignmentId/planVerdict), evidence, confidence — ver defensive-episode-persistence.ts.';
comment on column player_pull_defensive_episode_evaluations.data_confidence is
  'Rollup de fila: el confidence más débil entre sus episodios (mismo criterio weakestConfidence que ya usa materialize-execution-ledger para V2). Cada episodio conserva el suyo propio dentro de episodes[].';

-- ============================================================================
-- 2) player_execution_events gana defensive_generation_id — corrección de
--    infraestructura #1 de §2.6: sin esto, defensive_generation_pointer no
--    puede seleccionar qué eventos están realmente publicados (sería una
--    relación conceptual, no real). NULL en todo evento legacy existente y
--    futuro (mechanic/death/preparation/interrupt/external/dispel y
--    defensive_${state} V2); poblado únicamente en los eventos canónicos
--    nuevos defensive_episode_*/defensive_plan_*.
-- ============================================================================

alter table player_execution_events
  add column if not exists defensive_generation_id uuid references defensive_generations (id);

create index if not exists player_execution_events_defensive_generation_idx
  on player_execution_events (defensive_generation_id)
  where defensive_generation_id is not null;

comment on column player_execution_events.defensive_generation_id is
  'NULL en todo evento legacy (mechanic/death/preparation/interrupt/external/dispel y defensive_${state} V2). Poblado únicamente en los eventos canónicos defensive_episode_*/defensive_plan_* (§2.6). El cutover de Paso F filtra por esta columna = generación publicada; nunca por heurística de eventType a secas.';

-- ============================================================================
-- 3) 7 reason codes nuevos, aditivo sobre el CHECK existente de reason_code.
--    Nunca se reutilizan PLAN_COVERED/REMINDER_MISSED/SAFE_EXTRA_USE (son
--    del evaluator de Gestión/Plan legacy) para Respuesta — mezclarían otra
--    vez dos conceptos distintos bajo el mismo código, exactamente el
--    problema que abrió el plan de canonicalización defensiva.
-- ============================================================================

alter table player_execution_events
  drop constraint if exists player_execution_events_reason_code_check;
alter table player_execution_events
  add constraint player_execution_events_reason_code_check
  check (reason_code in (
    'SPREAD_CARRIER_COLLATERAL', 'ASSIGNED_SOAK_MISSED', 'PERSONAL_GROUND_HIT',
    'TANK_FRONTAL_HIT_RAID', 'TANK_SWAP_THRESHOLD_BREACH', 'ASSIGNED_INTERRUPT_MISSED',
    'RAID_INTERRUPT_MISSED', 'VOLUNTEER_MECHANIC_RESOLVED', 'VOLUNTEER_MECHANIC_UNRESOLVED',
    'SELF_FAILURE_DEATH', 'COLLATERAL_DEATH', 'UNAVOIDABLE_PRESSURE_DEATH',
    'POST_WIPE_DEATH', 'UNCERTAIN_CAUSE', 'PLAN_COVERED', 'CORRECT_HOLD',
    'REMINDER_MISSED', 'DEATH_VIABLE_CD', 'VIABLE_CD_NON_PUNITIVE', 'TARGET_MISMATCH',
    'SAFE_EXTRA_USE', 'PREPOT_USED', 'PREPOT_MISSED_VERIFIED', 'HEALTHSTONE_REACTIVE',
    'HEALTHSTONE_VIABLE_NOT_USED', 'HEALTH_POTION_REACTIVE', 'AVAILABILITY_UNKNOWN',
    'DEFENSIVE_EPISODE_COVERED', 'DEFENSIVE_READY_NOT_USED', 'DEFENSIVE_MISTIMED',
    'DEFENSIVE_UNAVAILABLE_LEGITIMATE', 'DEFENSIVE_NO_APPLICABLE_RESOURCE',
    'DEFENSIVE_EPISODE_UNCERTAIN', 'DEFENSIVE_EPISODE_EXCLUDED'
  ));

-- ============================================================================
-- 4) Views namespace/generation-aware — corrección de infraestructura #3.
--    Agrupar TAMBIÉN por defensive_generation_id separa físicamente
--    cualquier evento canónico futuro (generation_id real) de la fila
--    legacy (generation_id NULL, incluye mechanic/death/preparation/
--    interrupt/external/dispel y defensive_${state} V2 — todos comparten
--    NULL porque solo los eventos canónicos nuevos lo pueblan). Hoy TODAS
--    las filas de player_execution_events son NULL (tabla vacía, 0 filas —
--    confirmado), así que esto es 100% retrocompatible: no fragmenta ni
--    cambia ningún número que ya exista, solo evita que futuras filas
--    canónicas se sumen a las legacy cuando ambas coexistan en shadow.
--
--    Dentro de una fila canónica, defensive_episode_* (Respuesta) y
--    defensive_plan_* (Gestión) nunca comparten contador — cuatro columnas
--    nuevas por view, aditivas; ninguna fórmula existente cambia.
-- ============================================================================

-- NOTA: CREATE OR REPLACE VIEW de Postgres solo permite AÑADIR columnas al
-- final de la lista existente — renombrar o reordenar una columna ya
-- existente falla con "cannot change name of view column" (comprobado en
-- vivo). Por eso las columnas nuevas van TODAS al final, después de
-- evaluated_at, en vez de intercaladas junto a la columna conceptualmente
-- más cercana; el orden original de las columnas ya existentes no cambia.
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
  -- columnas nuevas §2.6, añadidas al final (ver nota arriba):
  e.defensive_generation_id,
  count(*) filter (where e.event_type like 'defensive_episode_%')::integer as defensive_episode_event_count,
  count(*) filter (where e.event_type like 'defensive_episode_%' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.event_type like 'defensive_episode_%' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.event_type like 'defensive_episode_%' and e.verdict = 'uncertain')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.event_type like 'defensive_plan_%')::integer as defensive_plan_event_count,
  count(*) filter (where e.event_type like 'defensive_plan_%' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.event_type like 'defensive_plan_%' and e.penalty_eligible)::integer as defensive_plan_failure_count
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
  -- columnas nuevas §2.6, añadidas al final (ver nota arriba):
  e.defensive_generation_id,
  count(*) filter (where e.event_type like 'defensive_episode_%')::integer as defensive_episode_event_count,
  count(*) filter (where e.event_type like 'defensive_episode_%' and e.credit_eligible)::integer as defensive_episode_success_count,
  count(*) filter (where e.event_type like 'defensive_episode_%' and e.penalty_eligible)::integer as defensive_episode_failure_count,
  count(*) filter (where e.event_type like 'defensive_episode_%' and e.verdict = 'uncertain')::integer as defensive_episode_uncertain_count,
  count(*) filter (where e.event_type like 'defensive_plan_%')::integer as defensive_plan_event_count,
  count(*) filter (where e.event_type like 'defensive_plan_%' and e.credit_eligible)::integer as defensive_plan_success_count,
  count(*) filter (where e.event_type like 'defensive_plan_%' and e.penalty_eligible)::integer as defensive_plan_failure_count
from player_execution_events e
join pulls p on p.id = e.pull_id
group by p.report_code, e.player_name, e.defensive_generation_id;

comment on view player_pull_execution_summary_v3 is
  'Resumen por pull+jugador del ledger v3, generation-aware (§2.6 corrección #3): defensive_generation_id en el GROUP BY separa físicamente cualquier evento canónico defensive_episode_*/defensive_plan_* (generation_id real) de la fila legacy (generation_id NULL) — nunca se suman entre sí. defensive_failure_count conserva su fórmula original (domain in (defensive,external) and penalty_eligible) para no romper el shadow comparator existente; defensive_episode_*/defensive_plan_* son columnas nuevas, namespace-scoped, para consumers canónicos.';
comment on view night_player_execution_summary_v3 is
  'Resumen por noche(report)+jugador del ledger v3, generation-aware — mismo criterio que player_pull_execution_summary_v3 (ver su comentario).';

revoke all on player_pull_execution_summary_v3, night_player_execution_summary_v3 from anon;
grant select on player_pull_execution_summary_v3, night_player_execution_summary_v3 to authenticated;

notify pgrst, 'reload schema';
