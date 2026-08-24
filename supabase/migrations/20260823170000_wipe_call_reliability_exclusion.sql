-- §"esa gente no debería afectar su fiabilidad ni sus defensivos ni contar
-- como muerte" (feedback real): player_pull_reliability_inputs es la ÚNICA
-- entrada cruda del score de fiabilidad (reliability.service.ts) — excluir
-- la fila entera (mecánica+defensiva+preparación de ESE pull para ESE
-- jugador) cuando su muerte formó parte de un cluster de wipe call
-- confirmado/auto-excluido. No afecta a otros pulls suyos ni a otros
-- jugadores del mismo pull que murieron fuera del cluster.
drop view if exists player_pull_reliability_inputs;
create view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  r.died,
  (r.avoidable_damage_taken > 0) as had_avoidable_damage,
  (r.died and r.death_cause->>'rootCause' = 'self_positioning') as self_positioning_death,
  case
    when r.died and jsonb_array_length(coalesce(r.death_cause->'defensiveOptions', '[]'::jsonb)) > 0 then (
      select bool_and((opt->>'status') <> 'available_unused')
      from jsonb_array_elements(r.death_cause->'defensiveOptions') opt
    )
    else null
  end as used_defensive_when_died,
  (
    select count(*) filter (where (item->>'permanentEnchant') is not null and (item->>'id')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchanted_slot_count,
  (
    select count(*) filter (where (item->>'id')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) with ordinality as t(item, slot)
    where slot - 1 in (4, 6, 7, 8, 10, 11, 14)
  ) as enchantable_slot_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(item->'gems', '[]'::jsonb))), 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) item
  ) as gem_count
from player_pull_records r
join pulls p on p.id = r.pull_id
where not (r.wipe_call_cluster and p.wipe_call_excluded);

comment on view player_pull_reliability_inputs is
  '§12: entrada cruda (una fila por jugador+pull) para el score de fiabilidad. Excluye filas de jugadores cuya muerte formó parte de un wipe call detectado Y marcado como excluido (pulls.wipe_call_excluded) — ver 20260823160000_wipe_call_detection.sql. enchanted_slot_count/enchantable_slot_count (7 slots siempre encantables) alimentan el eje preparación; gem_count es informativo.';
