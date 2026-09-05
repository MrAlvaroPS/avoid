-- Gestión defensiva v2 · M3
-- Escape hatch humano acotado a jugador/build. Nunca modifica el catálogo
-- global ni un plan ya publicado.

create table if not exists player_defensive_overrides (
  id uuid primary key default gen_random_uuid(),
  character_id bigint,
  player_name text not null check (btrim(player_name) <> ''),
  class text not null check (btrim(class) <> ''),
  spec text,
  spell_id bigint not null,
  build_fingerprint text,
  game_build text not null check (btrim(game_build) <> ''),
  effective_cooldown_ms integer check (effective_cooldown_ms is null or effective_cooldown_ms >= 0),
  effective_duration_ms integer check (effective_duration_ms is null or effective_duration_ms >= 0),
  charges smallint check (charges is null or charges > 0),
  targeting_mode text check (targeting_mode is null or targeting_mode in ('self', 'ally', 'both', 'raid', 'unknown')),
  reason text not null check (btrim(reason) <> ''),
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    effective_cooldown_ms is not null
    or effective_duration_ms is not null
    or charges is not null
    or targeting_mode is not null
  )
);

comment on table player_defensive_overrides is
  'Correcciones manuales de valores efectivos por jugador y game build. build_fingerprint null significa scope global explícito para los builds de ese jugador dentro del mismo game_build.';
comment on column player_defensive_overrides.reason is
  'Motivo auditable obligatorio. El resolver conserva además el valor automático anterior en provenance.';

-- Una única corrección activa por identidad lógica. lower(player_name) evita
-- duplicados por casing cuando todavía no existe character_id para una fila.
create unique index if not exists player_defensive_overrides_active_scope_key
  on player_defensive_overrides (
    (case
      when character_id is not null then 'id:' || character_id::text
      else 'name:' || lower(player_name)
    end),
    class,
    coalesce(spec, ''),
    spell_id,
    coalesce(build_fingerprint, ''),
    game_build
  )
  where active = true;

create index if not exists player_defensive_overrides_resolution_idx
  on player_defensive_overrides (player_name, build_fingerprint, spell_id, game_build)
  where active = true;

alter table player_defensive_overrides enable row level security;

drop policy if exists "player_defensive_overrides: officers read" on player_defensive_overrides;
create policy "player_defensive_overrides: officers read"
  on player_defensive_overrides for select
  using (is_officer());

revoke all on player_defensive_overrides from anon;
grant select on player_defensive_overrides to authenticated;
