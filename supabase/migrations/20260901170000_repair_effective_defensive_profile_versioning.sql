-- IRIS Defensivos v2 · reparación forward del resto del contrato M1
--
-- El historial remoto registra 20260831200000 como aplicada, pero la base
-- conserva el schema v5 de defensive_spec_profiles (sin game_build). La
-- reparación anterior 20260901160000 cerró targeting_mode. Esta migración
-- reexpresa de forma idempotente el versionado de perfiles y modificadores,
-- sin reescribir ni marcar como revertida una migración histórica.

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

-- La PK v5 no permite dos builds del mismo perfil. Las filas existentes
-- reciben legacy-current antes de reconstruirla, por lo que no se pierden.
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

-- charges_add es el único operation legacy cuyo campo afectado es
-- inequívoco. El resto conserva cooldown_ms y confidence de fallback.
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

-- Sustituye tanto el UNIQUE v5 como una posible aplicación parcial del
-- UNIQUE v2. No depende del nombre autogenerado por PostgreSQL.
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

notify pgrst, 'reload schema';
