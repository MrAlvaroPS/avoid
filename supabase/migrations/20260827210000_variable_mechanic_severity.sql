-- §"acercarnos lo más posible a wipefest... me gusta la idea de que no sea
-- un 0.35 fijo y sea variable" (feedback real, 2026-08-27): Parte A del plan
-- de severidad variable — ver docs de la sesión. Wipefest puntúa contra una
-- muestra real (percentil), no un umbral fijo; a nuestra escala (una sola
-- guild) se adapta con 3 niveles de fallback: historial propio de Avoid
-- (kills), logs públicos de referencia (ya se traen, ver
-- sync-boss-mechanics), y el umbral fijo actual como último recurso.

-- Array de ratios (jugadores_golpeados / raidSize), uno por log público de
-- referencia donde apareció esta mecánica. Como mucho ~120 números (Mítico,
-- el caso más grande) — un array simple y ordenable, no buckets al estilo
-- Wipefest (esos están pensados para cientos de miles de puntos, no para
-- decenas). NO es lo mismo que reference_avg_players_hit, que es
-- intencionalmente una CUENTA ABSOLUTA para inferencia de categoría, no un
-- ratio (ver 20260822080000_derived_metrics_and_category_inference.sql).
alter table boss_mechanics_candidates
  add column if not exists reference_hit_ratio_samples jsonb;

comment on column boss_mechanics_candidates.reference_hit_ratio_samples is
  'Array de ratios (jugadores_golpeados/raidSize) por log público de referencia donde apareció esta mecánica — la muestra cruda para comparación de severidad tipo Wipefest. NULL/vacío hasta el próximo re-sync.';

-- Informativos, no sustituyen outcome (clean/partial_fail/fail) en ningún
-- sitio — ver resolveSeverity en _shared/mechanic-severity.ts.
alter table pull_mechanic_events
  add column if not exists comparison_source text
    check (comparison_source is null or comparison_source in ('own_history', 'world_reference', 'fixed_threshold')),
  add column if not exists comparison_percentile numeric;

comment on column pull_mechanic_events.comparison_source is
  'De dónde salió el umbral usado para esta instancia: historial propio de Avoid (kills), logs públicos de referencia, o el umbral fijo de siempre como último recurso.';
comment on column pull_mechanic_events.comparison_percentile is
  'Percentil de este ratio dentro de la muestra de comparison_source (0-100). NULL si comparison_source=fixed_threshold (sin muestra, no hay percentil que dar).';

-- §mismo bug real ya encontrado y documentado en
-- 20260827200000_refresh_applicable_pull_mechanic_events_view.sql: `select
-- event.*` en una vista se congela a la lista de columnas de la tabla base
-- EN EL MOMENTO de crearse — las 2 columnas nuevas de arriba no aparecerían
-- en applicable_pull_mechanic_events sin volver a ejecutar exactamente la
-- misma definición para forzar la re-expansión. No cambia ningún dato.
create or replace view applicable_pull_mechanic_events
with (security_invoker = true) as
select event.*
from pull_mechanic_events event
join pulls pull on pull.id = event.pull_id
where not exists (
    select 1
    from boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  )
  or exists (
    select 1
    from applicable_boss_mechanics_candidates candidate
    where candidate.boss_id = pull.boss_id
      and candidate.difficulty = pull.difficulty
      and lower(trim(candidate.name)) = lower(trim(event.mechanic_name))
  );

comment on view applicable_pull_mechanic_events is
  'Eventos históricos cuya mecánica sigue siendo aplicable al boss+dificultad. Las filas sin candidata asociada se conservan de forma conservadora. Recreada el 2026-08-27 para que event.* recoja comparison_source/comparison_percentile.';
