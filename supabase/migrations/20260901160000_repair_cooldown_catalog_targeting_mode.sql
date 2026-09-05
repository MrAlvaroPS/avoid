-- IRIS Defensivos v2 · reparación forward de deriva M1
--
-- 20260831200000 figura aplicada en el proyecto remoto, pero fue registrada
-- antes de que su copia local incorporase targeting_mode. No se reescribe el
-- historial ni se marca M1 como reverted: esta migración aditiva materializa
-- de forma idempotente el contrato que el resolver v2 necesita.

alter table cooldown_catalog
  add column if not exists targeting_mode text not null default 'unknown';

alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_targeting_mode_check;
alter table cooldown_catalog
  add constraint cooldown_catalog_targeting_mode_check
  check (targeting_mode in ('self', 'ally', 'both', 'raid', 'unknown'));

-- Solo se derivan categorías cuyo target es inequívoco en el contrato
-- existente. External permanece unknown hasta disponer de target/aura real.
update cooldown_catalog
set targeting_mode = case
  when category = 'personal_defensive' then 'self'
  when category = 'semi_defensive' then 'both'
  else 'unknown'
end
where targeting_mode = 'unknown'
  and category in ('personal_defensive', 'semi_defensive');

comment on column cooldown_catalog.targeting_mode is
  'A quién puede proteger realmente el spell. external/unknown no puede atribuirse como cobertura propia sin target o aura observada.';

-- Evita que PostgREST conserve temporalmente un schema anterior después del
-- push y que readiness devuelva PGRST204 aunque la columna ya exista.
notify pgrst, 'reload schema';
