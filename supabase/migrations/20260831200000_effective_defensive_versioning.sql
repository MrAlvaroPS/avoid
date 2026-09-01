-- Gestión defensiva v2 · M1
--
-- Prepara las tablas creadas por el research v5 para que una regla de la
-- patch actual no reinterprete silenciosamente un pull histórico. El valor
-- `legacy-current` es deliberadamente explícito: conserva las filas v5 ya
-- existentes, pero el resolver las tratará como fallback y no como evidencia
-- de que pertenecen a un build concreto.

alter table defensive_spec_profiles
  add column if not exists game_build text not null default 'legacy-current',
  add column if not exists recharge_ms integer;

alter table defensive_spec_profiles
  drop constraint if exists defensive_spec_profiles_recharge_ms_check;
alter table defensive_spec_profiles
  add constraint defensive_spec_profiles_recharge_ms_check
  check (recharge_ms is null or recharge_ms >= 0);

alter table defensive_spec_profiles
  drop constraint if exists defensive_spec_profiles_game_build_check;
alter table defensive_spec_profiles
  add constraint defensive_spec_profiles_game_build_check
  check (btrim(game_build) <> '');

-- La PK v5 impedía conservar dos versiones del mismo perfil. No hay FKs a
-- esta PK en la baseline auditada; el catálogo sigue identificado aparte.
alter table defensive_spec_profiles
  drop constraint if exists defensive_spec_profiles_pkey;
alter table defensive_spec_profiles
  add constraint defensive_spec_profiles_pkey
  primary key (class, spec, spell_id, game_build);

comment on column defensive_spec_profiles.game_build is
  'Build exacto X.Y.Z.build al que pertenece el perfil. legacy-current = fila v5 anterior al versionado; solo puede consumirse como fallback con provenance.';
comment on column defensive_spec_profiles.recharge_ms is
  'Tiempo de recarga por carga cuando difiere del cooldown conceptual. Null = usar el cooldown efectivo como recharge.';

alter table defensive_modifier_rules
  add column if not exists game_build text not null default 'legacy-current',
  add column if not exists effect_field text not null default 'cooldown_ms',
  add column if not exists application_order integer not null default 100;

-- v5 no distinguía el campo afectado. charges_add sí es inequívoco; el resto
-- de filas legacy se investigó como modificación de cooldown y queda marcado
-- como tal, conservando game_build=legacy-current y por tanto confidence baja.
update defensive_modifier_rules
set effect_field = 'charges'
where operation = 'charges_add';

alter table defensive_modifier_rules
  drop constraint if exists defensive_modifier_rules_game_build_check;
alter table defensive_modifier_rules
  add constraint defensive_modifier_rules_game_build_check
  check (btrim(game_build) <> '');

alter table defensive_modifier_rules
  drop constraint if exists defensive_modifier_rules_effect_field_check;
alter table defensive_modifier_rules
  add constraint defensive_modifier_rules_effect_field_check
  check (effect_field in ('cooldown_ms', 'duration_ms', 'charges', 'recharge_ms'));

alter table defensive_modifier_rules
  drop constraint if exists defensive_modifier_rules_operation_field_check;
alter table defensive_modifier_rules
  add constraint defensive_modifier_rules_operation_field_check
  check (
    (operation = 'charges_add' and effect_field = 'charges')
    or
    (operation <> 'charges_add' and effect_field <> 'charges')
  );

-- El nombre autogenerado del UNIQUE v5 puede truncarse de forma distinta
-- entre versiones de Postgres. Solo había un UNIQUE no-PK en esta tabla, así
-- que se localiza por catálogo en vez de depender de ese nombre truncado.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'defensive_modifier_rules'::regclass
      and contype = 'u'
  loop
    execute format(
      'alter table defensive_modifier_rules drop constraint %I',
      constraint_name
    );
  end loop;
end $$;

alter table defensive_modifier_rules
  add constraint defensive_modifier_rules_version_key
  unique (
    class,
    modifier_spell_id,
    target_spell_id,
    operation,
    effect_field,
    game_build
  );

comment on column defensive_modifier_rules.game_build is
  'Build exacto X.Y.Z.build de la regla. legacy-current conserva research v5 previo al versionado y nunca equivale a una coincidencia histórica verificada.';
comment on column defensive_modifier_rules.effect_field is
  'Campo efectivo modificado: cooldown_ms, duration_ms, charges o recharge_ms.';
comment on column defensive_modifier_rules.application_order is
  'Orden declarativo dentro de un mismo defensivo/build. Empates se resuelven por precedencia de operación e id; sets incompatibles degradan confidence a uncertain.';

create index if not exists defensive_modifier_rules_resolution_idx
  on defensive_modifier_rules (class, target_spell_id, game_build)
  where active = true;
create index if not exists defensive_modifier_rules_modifier_idx
  on defensive_modifier_rules (modifier_spell_id, game_build)
  where active = true;

-- Target y categoría son ejes distintos. Solo se derivan los casos que la
-- categoría actual hace inequívocos; external queda unknown hasta conservar
-- targetID/aura real y semi se marca both por su contrato existente.
alter table cooldown_catalog
  add column if not exists targeting_mode text not null default 'unknown';

alter table cooldown_catalog
  drop constraint if exists cooldown_catalog_targeting_mode_check;
alter table cooldown_catalog
  add constraint cooldown_catalog_targeting_mode_check
  check (targeting_mode in ('self', 'ally', 'both', 'raid', 'unknown'));

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

-- Las tablas v5 tenían RLS habilitado pero ninguna policy de lectura. Se
-- completa el mismo contrato de acceso de la aplicación: oficiales leen;
-- las escrituras siguen reservadas a Edge Functions con service_role.
drop policy if exists "defensive_spec_profiles: officers read" on defensive_spec_profiles;
create policy "defensive_spec_profiles: officers read"
  on defensive_spec_profiles for select
  using (is_officer());

drop policy if exists "defensive_modifier_rules: officers read" on defensive_modifier_rules;
create policy "defensive_modifier_rules: officers read"
  on defensive_modifier_rules for select
  using (is_officer());

revoke all on defensive_spec_profiles from anon;
revoke all on defensive_modifier_rules from anon;
grant select on defensive_spec_profiles to authenticated;
grant select on defensive_modifier_rules to authenticated;

