-- §"hay muchos que estan al 99.8% o 100% incluso el try, eso es obviamente
-- un ninja pull y no deberia contar para ninguna estadistica ni metrica, ni
-- aunque se quede al 96%, si el combate dura menos de 40-50 segundos y a
-- penas le baja la vida, es un ninja pull o un wipe call y deberia
-- excluirse" (feedback real, 2026-08-27) -- caso real visto: "The Coiled
-- Altar #6", 16s de duración, wipe al 100%, NO se marcaba porque el umbral
-- de duración de entonces (15s) se quedaba justo por debajo.
--
-- Backfill del mismo espíritu que el de 20260827090000_ninja_pull_
-- detection.sql, con los criterios ya ampliados en vivo en analyze-report/
-- index.ts (duración 15s -> 45s, más la señal nueva de "al boss apenas le
-- bajó la vida" -- wipe_pct >= 90, independiente de la fracción
-- enganchada). Solo AÑADE exclusiones, nunca las quita -- "where not
-- p.ninja_pull_excluded" dejará intacto cualquier pull que un RL ya haya
-- corregido a mano (ninja_pull_excluded=false a pesar de is_ninja_pull=true).
with engagement as (
  select
    pull_id,
    count(*) as raid_size,
    count(*) filter (where died or coalesce(dps, 0) > 0 or coalesce(hps, 0) > 0) as engaged_count
  from player_pull_records
  group by pull_id
)
update pulls p
set
  is_ninja_pull = true,
  ninja_pull_excluded = true,
  ninja_pull_signals = jsonb_build_object(
    'durationMs', p.duration_ms,
    'raidSize', e.raid_size,
    'engagedPlayerCount', e.engaged_count,
    'engagedFraction', round((e.engaged_count::numeric / greatest(e.raid_size, 1)), 2),
    'bossHealthPct', p.wipe_pct,
    'barelyDamagedBoss', coalesce(p.wipe_pct, 0) >= 90
  )
from engagement e
where e.pull_id = p.id
  and not p.ninja_pull_excluded
  and coalesce(p.wipe_pct, 100) > 0
  and p.duration_ms is not null
  and p.duration_ms < 45000
  and e.raid_size > 0
  and (
    (e.engaged_count::numeric / e.raid_size) <= 0.3
    or coalesce(p.wipe_pct, 0) >= 90
  );
