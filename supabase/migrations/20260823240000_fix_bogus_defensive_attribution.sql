-- §bug real encontrado y arreglado el 2026-08-23 (feedback real: "sale
-- gusmi con lluvia de estrellas como defensivo, es erróneo"): buildPlayerHitDetails
-- en analyze-report indexaba TODOS los casts del jugador (rotación normal
-- incluida), no solo su catálogo de defensivos — la primera spell que
-- cayera en la ventana de reacción se guardaba como "defensivo usado",
-- fuera o no un defensivo de verdad. El código ya se corrigió (acota al
-- catálogo real de clase/spec/talentos antes de mirar timestamps) y afecta
-- a análisis NUEVOS — esto repara lo YA guardado.
--
-- Verificado antes de aplicar: de 6.670 entradas con used_defensive_spell_id
-- puesto, 6.656 (99,8%) no correspondían a ningún defensivo real del
-- catálogo de ese jugador (player_pull_records.defensive_casts, que SÍ
-- estuvo siempre bien acotado al catálogo — es la fuente de verdad contra
-- la que se valida aquí). Solo se pone a null el campo erróneo dentro de
-- cada elemento de player_hit_details — el resto (daño, sanación, nombre)
-- no se toca.
update pull_mechanic_events e
set player_hit_details = (
  select jsonb_agg(
    case
      when (elem->>'used_defensive_spell_id') is not null
        and not exists (
          select 1
          from player_pull_records r, jsonb_array_elements(coalesce(r.defensive_casts, '[]'::jsonb)) dc
          where r.pull_id = e.pull_id
            and r.player_name = elem->>'name'
            and (dc->>'spellId')::bigint = (elem->>'used_defensive_spell_id')::bigint
        )
      then jsonb_set(elem, '{used_defensive_spell_id}', 'null'::jsonb)
      else elem
    end
  )
  from jsonb_array_elements(e.player_hit_details) elem
)
where jsonb_array_length(e.player_hit_details) > 0;
