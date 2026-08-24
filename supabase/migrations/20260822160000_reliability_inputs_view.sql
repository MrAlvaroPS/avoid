-- §12 de la hoja de ruta (auditoría v2): sistema de fiabilidad del raider,
-- score 1-100. Primera pieza real: la vista que agrega, POR JUGADOR, las
-- señales crudas de cada pull dentro de una ventana móvil — la parte cara
-- (cruzar pulls + player_pull_records de TODA la guild en una ventana de 60
-- días, potencialmente miles de filas) vive en SQL, no en JS del cliente
-- (pull-analysis.service.ts ya deja dicho el principio: "calculado al vuelo
-- en el cliente... si se nota lento, el sitio natural es una tabla/vista
-- nueva" — esto ES ese sitio). La fórmula final (pesos, renormalización si
-- falta un eje, banda de color) SÍ vive en TypeScript (reliability.service.ts,
-- todavía por escribir) porque tiene lógica condicional que en SQL sería
-- ilegible — esta vista solo entrega los números YA agregados por pull.
--
-- Peso por recencia (§12.3 de la hoja de ruta): exponencial con
-- half-life configurable en la query (no fijo aquí), aplicado por FILA
-- (por pull), para que quien consuma la vista pueda sumar
-- weight*valor / sum(weight) con cualquier half-life sin tener que tocar SQL.
--
-- Decisión de normalización PROPIA (la hoja de ruta deja
-- "normalizedAvoidableDamage" sin especificar cómo se normaliza, y una
-- cantidad de daño evitable en bruto no es comparable entre un boss y otro
-- ni entre specs con distinta vida máxima): en vez de daño evitable en
-- bruto, se cuenta si el jugador tuvo ALGÚN daño evitable > 0 ese pull
-- (binario, comparable entre cualquier boss/clase) — "¿este pull estuvo
-- limpio de mecánica evitable, sí o no?", no "¿cuánto dolió cuando falló?".
drop view if exists player_pull_reliability_inputs;
create view player_pull_reliability_inputs as
select
  r.player_name,
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  r.died,
  -- Eje "ejecución mecánica" (§12.1, 40%): DOS señales, no una — verificado
  -- en real que avoidable_damage_taken depende de que alguien haya
  -- confirmado avoidable=true a mano en el manifiesto (save-mechanic-edit);
  -- con la guild real de este proyecto, hoy eso está sin confirmar en
  -- ningún boss todavía, así que had_avoidable_damage sale 0 para TODO EL
  -- MUNDO — no porque vayan limpios, sino porque la señal está apagada.
  -- rootCause='self_positioning' (basado en category, que SÍ se rellena con
  -- inferred_category automático desde este mismo turno) no depende de esa
  -- confirmación manual y es la señal principal hasta que el manifiesto esté
  -- más curado.
  (r.avoidable_damage_taken > 0) as had_avoidable_damage,
  (r.died and r.death_cause->>'rootCause' = 'self_positioning') as self_positioning_death,
  -- Eje "disciplina defensiva" (§12.1, 30%): solo tiene sentido evaluarlo
  -- cuando hay una muerte real que lo ponga a prueba — un pull sin muerte no
  -- prueba nada sobre si el jugador usa sus defensivos bien o mal (podría no
  -- haberlos necesitado). null = "no evaluable este pull", no un cero
  -- silencioso — el consumidor filtra los null antes de promediar.
  -- Solo se afirma true/false cuando de verdad hay opciones que evaluar —
  -- un array vacío (clase/spec sin catálogo cargado todavía) NO cuenta como
  -- "iba limpio", cuenta como "no evaluable" (null), mismo principio que el
  -- resto de esta vista.
  case
    when r.died and jsonb_array_length(coalesce(r.death_cause->'defensiveOptions', '[]'::jsonb)) > 0 then (
      select bool_and((opt->>'status') <> 'available_unused')
      from jsonb_array_elements(r.death_cause->'defensiveOptions') opt
    )
    else null
  end as used_defensive_when_died,
  -- Eje "preparación" (§12.1, 20%): encantamientos ya se pueden calcular hoy
  -- (equipped_items[].permanentEnchant, todos los slots, no solo trinkets);
  -- gemas/flask/comida NO — verificado en real que equipped_items no trae
  -- gems y no hay detección de flask/comida todavía (ver diseño completo en
  -- la respuesta, no solo este comentario). Se deja el cálculo parcial aquí
  -- mismo para no bloquear todo el eje en lo que falta.
  (
    select count(*) filter (where (item->>'permanentEnchant') is not null and (item->>'id')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) item
  ) as enchanted_slot_count,
  (
    select count(*) filter (where (item->>'id')::bigint > 0)
    from jsonb_array_elements(coalesce(r.equipped_items, '[]'::jsonb)) item
  ) as equipped_slot_count
from player_pull_records r
join pulls p on p.id = r.pull_id;

comment on view player_pull_reliability_inputs is
  '§12: entrada cruda (una fila por jugador+pull) para el score de fiabilidad — pesos/renormalización/half-life de recencia se aplican en reliability.service.ts, no aquí. enchanted_slot_count/equipped_slot_count son la mitad ya calculable del eje "preparación"; gemas/flask/comida quedan fuera hasta verificar disponibilidad real en combatantInfo.';
