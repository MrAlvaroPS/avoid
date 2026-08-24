-- §"de dónde puedes obtener los enchants y gemas que decíamos para la
-- fiabilidad" (feedback real): las gemas SÍ están en equipped_items[].gems[]
-- (verificado en real contra datos ya guardados — el comentario anterior de
-- esta vista decía que no, era incorrecto/quedó desactualizado). Esta
-- revisión corrige dos cosas del intento anterior:
--   1. enchanted_slot_count/equipped_slot_count contaban TODOS los slots
--      equipados, penalizando injustamente casco/hombreras/manos/cintura/
--      anillos (encantamientos ahí dependen de facción/profesión, no todo
--      el mundo tiene acceso) — se acota a los 7 slots universalmente
--      encantables en cualquier expansión: espalda, pecho, piernas,
--      muñecas, pies, anillo1, anillo2.
--   2. gem_count nuevo — informativo, NO se convierte en ratio (no tenemos
--      de dónde sacar "cuántos engarces DEBERÍA tener" sin datos de sockets
--      por ítem de Blizzard, así que no se puntúa para no inventar un
--      umbral — se expone crudo para quien quiera mirarlo).
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
  -- Eje "preparación" (§12.1, 20%): espalda(14) pecho(4) piernas(6)
  -- muñecas(8) pies(7) anillo1(10) anillo2(11) — el orden de slot que ya usa
  -- el resto del código (ver TRINKET_SLOT_INDICES=[12,13] en analyze-report,
  -- mismo espacio de índices que da WCL).
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
join pulls p on p.id = r.pull_id;

comment on view player_pull_reliability_inputs is
  '§12: entrada cruda (una fila por jugador+pull) para el score de fiabilidad. enchanted_slot_count/enchantable_slot_count (7 slots siempre encantables) alimentan el eje preparación en reliability.service.ts; gem_count es informativo (sin dato de sockets máximos por ítem, no se puntúa).';
