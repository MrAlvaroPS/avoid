-- Complemento de 20260824120000_fix_cooldown_catalog_spec_gaps.sql: esa
-- migración corrige el CATÁLOGO (cooldown_catalog), lo que arregla todo
-- análisis FUTURO — pero player_pull_records.death_cause.defensiveOptions ya
-- guardado en el momento de analyze-report queda con las entradas viejas
-- (verificado en real: 44 entradas en 32 registros, ej. Dewerland (Arms)
-- con Shield Block/Defensive Stance, Linkedara (Holy) con Dispersion,
-- Ayriane (Havoc) con Demon Spikes — exactamente el bug reportado). Se
-- eliminan del array esas entradas concretas cuando el spec real del
-- jugador no coincide con el spec exigido — mismo principio que la
-- migración de "99.8% de defensivos atribuidos mal" de antes en esta sesión
-- (corregir el dato ya guardado, no solo el código de aquí en adelante).

with req(spell_id, required_spec) as (
  values (203720,'Vengeance'),(204021,'Vengeance'),(235313,'Fire'),(11426,'Frost'),
         (235450,'Arcane'),(386208,'Protection'),(190456,'Protection'),(2565,'Protection'),
         (47585,'Shadow')
),
to_fix as (
  select r.id,
    (
      select jsonb_agg(opt) from jsonb_array_elements(r.death_cause->'defensiveOptions') opt
      where not exists (
        select 1 from req where req.spell_id = (opt->>'spellId')::int and r.spec is distinct from req.required_spec
      )
    ) as filtered
  from player_pull_records r
  where r.death_cause is not null
    and exists (
      select 1 from jsonb_array_elements(coalesce(r.death_cause->'defensiveOptions', '[]'::jsonb)) opt
      join req on req.spell_id = (opt->>'spellId')::int
      where r.spec is distinct from req.required_spec
    )
)
update player_pull_records r
set death_cause = jsonb_set(r.death_cause, '{defensiveOptions}', coalesce(to_fix.filtered, '[]'::jsonb))
from to_fix
where r.id = to_fix.id;
