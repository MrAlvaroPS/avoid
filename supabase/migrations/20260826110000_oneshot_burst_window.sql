-- Recalcula de forma no destructiva los perfiles históricos que ya guardan
-- la secuencia de daño. No existe maxHitPoints en esos JSON antiguos, así
-- que solo se eleva a burst cuando >=80% de todo el daño de los 5s finales
-- está concentrado en el último segundo; nunca se rebaja un burst existente.

with historical_profiles as (
  select
    record.id,
    sum(coalesce((hit->>'amount')::numeric, 0)) as window_damage,
    sum(coalesce((hit->>'amount')::numeric, 0)) filter (
      where coalesce((hit->>'time_ms')::numeric, 0)
        >= coalesce((record.death_cause->>'timeMs')::numeric, 0) - 1000
    ) as terminal_burst_damage
  from player_pull_records record
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(record.death_cause->'damageWindowEvents') = 'array'
      then record.death_cause->'damageWindowEvents'
      else '[]'::jsonb
    end
  ) hit
  where record.death_cause is not null
  group by record.id
), classified as (
  select
    id,
    window_damage,
    coalesce(terminal_burst_damage, 0) as terminal_burst_damage,
    window_damage > 0 and coalesce(terminal_burst_damage, 0) / window_damage >= 0.8 as temporal_burst
  from historical_profiles
)
update player_pull_records record
set death_cause = record.death_cause || jsonb_build_object(
  'damageProfile', case
    when classified.temporal_burst then 'burst'
    else coalesce(record.death_cause->>'damageProfile', 'unknown')
  end,
  'terminalBurstDamage', classified.terminal_burst_damage,
  'burstWindowMs', 1000
)
from classified
where classified.id = record.id;
