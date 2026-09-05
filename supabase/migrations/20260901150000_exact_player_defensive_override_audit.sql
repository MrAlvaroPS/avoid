-- IRIS Defensivos v2 · consolidación visual · override exacto y auditable
--
-- No elimina overrides antiguos con fingerprint null: se conservan para
-- auditoría/rollback, pero el resolver v2 ya no los consume. Toda escritura
-- nueva exige jugador + hechizo + game_build + fingerprint exactos.

create table if not exists player_defensive_override_audit (
  id uuid primary key default gen_random_uuid(),
  override_id uuid not null references player_defensive_overrides (id) on delete restrict,
  action text not null check (action in ('created', 'updated', 'deactivated')),
  automatic_effective_cooldown_ms integer check (automatic_effective_cooldown_ms is null or automatic_effective_cooldown_ms >= 0),
  automatic_effective_duration_ms integer check (automatic_effective_duration_ms is null or automatic_effective_duration_ms >= 0),
  previous_override jsonb,
  resulting_override jsonb not null check (jsonb_typeof(resulting_override) = 'object'),
  reason text not null check (btrim(reason) <> ''),
  changed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists player_defensive_override_audit_scope_idx
  on player_defensive_override_audit (override_id, created_at desc);

alter table player_defensive_override_audit enable row level security;
drop policy if exists "player_defensive_override_audit: officers read" on player_defensive_override_audit;
create policy "player_defensive_override_audit: officers read"
  on player_defensive_override_audit for select using (is_officer());
revoke all on player_defensive_override_audit from anon, authenticated;
grant select on player_defensive_override_audit to authenticated;

create or replace function save_exact_player_defensive_override(
  p_character_id bigint,
  p_player_name text,
  p_class text,
  p_spec text,
  p_spell_id bigint,
  p_game_build text,
  p_build_fingerprint text,
  p_effective_cooldown_ms integer,
  p_effective_duration_ms integer,
  p_automatic_cooldown_ms integer,
  p_automatic_duration_ms integer,
  p_reason text,
  p_changed_by uuid,
  p_active boolean default true
)
returns player_defensive_overrides
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing player_defensive_overrides;
  v_result player_defensive_overrides;
  v_action text;
begin
  if p_character_id is null or p_character_id <= 0 then raise exception 'character_id exacto obligatorio.' using errcode = '23514'; end if;
  if nullif(btrim(p_player_name), '') is null then raise exception 'player_name obligatorio.' using errcode = '23514'; end if;
  if nullif(btrim(p_class), '') is null then raise exception 'class obligatoria.' using errcode = '23514'; end if;
  if p_spell_id is null or p_spell_id <= 0 then raise exception 'spell_id inválido.' using errcode = '23514'; end if;
  if nullif(btrim(p_game_build), '') is null then raise exception 'game_build exacto obligatorio.' using errcode = '23514'; end if;
  if p_build_fingerprint !~ '^sha256:[a-f0-9]{64}$' then raise exception 'build_fingerprint exacto obligatorio.' using errcode = '23514'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Motivo auditable obligatorio.' using errcode = '23514'; end if;
  if p_active and p_effective_cooldown_ms is null and p_effective_duration_ms is null then
    raise exception 'Debe corregirse cooldown o duración.' using errcode = '23514';
  end if;
  if p_effective_cooldown_ms is not null and p_effective_cooldown_ms < 0 then raise exception 'Cooldown inválido.' using errcode = '23514'; end if;
  if p_effective_duration_ms is not null and p_effective_duration_ms < 0 then raise exception 'Duración inválida.' using errcode = '23514'; end if;

  select * into v_existing
  from player_defensive_overrides
  where active
    and character_id = p_character_id
    and class = btrim(p_class)
    and spec is not distinct from nullif(btrim(p_spec), '')
    and spell_id = p_spell_id
    and game_build = btrim(p_game_build)
    and build_fingerprint = p_build_fingerprint
  for update;

  if not p_active then
    if v_existing.id is null then raise exception 'No existe override exacto activo.' using errcode = 'P0002'; end if;
    update player_defensive_overrides
    set active = false, reason = btrim(p_reason), updated_by = p_changed_by, updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    v_action := 'deactivated';
  elsif v_existing.id is null then
    insert into player_defensive_overrides (
      character_id, player_name, class, spec, spell_id, build_fingerprint, game_build,
      effective_cooldown_ms, effective_duration_ms, reason, active, created_by, updated_by
    ) values (
      p_character_id, btrim(p_player_name), btrim(p_class), nullif(btrim(p_spec), ''), p_spell_id,
      p_build_fingerprint, btrim(p_game_build), p_effective_cooldown_ms,
      p_effective_duration_ms, btrim(p_reason), true, p_changed_by, p_changed_by
    ) returning * into v_result;
    v_action := 'created';
  else
    update player_defensive_overrides
    set effective_cooldown_ms = p_effective_cooldown_ms,
        effective_duration_ms = p_effective_duration_ms,
        reason = btrim(p_reason),
        updated_by = p_changed_by,
        updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    v_action := 'updated';
  end if;

  insert into player_defensive_override_audit (
    override_id, action, automatic_effective_cooldown_ms, automatic_effective_duration_ms,
    previous_override, resulting_override, reason, changed_by
  ) values (
    v_result.id, v_action, p_automatic_cooldown_ms, p_automatic_duration_ms,
    case when v_existing.id is null then null else to_jsonb(v_existing) end,
    to_jsonb(v_result), btrim(p_reason), p_changed_by
  );
  return v_result;
end;
$$;

revoke all on function save_exact_player_defensive_override(
  bigint, text, text, text, bigint, text, text, integer, integer, integer, integer, text, uuid, boolean
) from public, anon, authenticated;
grant execute on function save_exact_player_defensive_override(
  bigint, text, text, text, bigint, text, text, integer, integer, integer, integer, text, uuid, boolean
) to service_role;

comment on table player_defensive_override_audit is
  'Historial inmutable de correcciones efectivas exactas, incluido valor automático anterior, manual resultante, autor y motivo.';

comment on column player_defensive_overrides.build_fingerprint is
  'Scope exacto del build de talentos. Las filas legacy con null se conservan para auditoría/rollback, pero el resolver v2 no las aplica.';
