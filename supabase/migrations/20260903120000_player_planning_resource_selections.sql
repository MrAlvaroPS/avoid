-- §"si a Gusmi le marco que tiene Barkskin y Frenzied Regeneration, no tiene
-- sentido que cada vez que entre en Gusmi tenga que quitarle el check de
-- Ironfur y ponerle el check de Frenzied Regeneration" (feedback real,
-- 2026-09-03): planningResourceSelections en boss-prep.component.ts vivía
-- solo en memoria (signal sin persistencia), se perdía en cada recarga y no
-- se compartía entre oficiales. No se reutiliza player_defensive_overrides
-- (migración 20260831220000): esa tabla exige `reason` obligatorio y al
-- menos una corrección numérica/targeting — es para correcciones auditadas
-- de valores efectivos, no para el checkbox "usar en el plan" que un
-- oficial marca sobre un kit ya resuelto. Aditiva, sin tocar tablas/RLS
-- existentes.

create table if not exists player_planning_resource_selections (
  id uuid primary key default gen_random_uuid(),
  character_id bigint,
  player_name text not null check (btrim(player_name) <> ''),
  class text not null check (btrim(class) <> ''),
  -- Conjunto COMPLETO de spellIds seleccionados, no un diff — mismo criterio
  -- que ya usa hoy togglePlanningResource() en el cliente (siempre
  -- materializa el conjunto entero antes de guardar).
  selected_spell_ids bigint[] not null default '{}',
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table player_planning_resource_selections is
  'Qué defensivos personales tiene marcados un oficial para entrar en la planificación de un jugador. Una fila por jugador (no por boss/dificultad: la selección es del kit del jugador, igual que ya se comportaba en memoria).';
comment on column player_planning_resource_selections.selected_spell_ids is
  'Conjunto completo de spellId marcados "usar en el plan" — se reemplaza entero en cada guardado, nunca se parchea.';

-- Una fila activa por identidad lógica — mismo patrón exacto que
-- player_defensive_overrides_active_scope_key (migración 20260831220000):
-- character_id cuando existe, si no nombre en minúsculas.
create unique index if not exists player_planning_resource_selections_identity_key
  on player_planning_resource_selections (
    (case
      when character_id is not null then 'id:' || character_id::text
      else 'name:' || lower(player_name)
    end)
  );

alter table player_planning_resource_selections enable row level security;

drop policy if exists "player_planning_resource_selections: officers read" on player_planning_resource_selections;
create policy "player_planning_resource_selections: officers read"
  on player_planning_resource_selections for select
  using (is_officer());

revoke all on player_planning_resource_selections from anon;
grant select on player_planning_resource_selections to authenticated;

-- Único punto de escritura (mismo criterio que save_exact_player_defensive_
-- override, migración 20260901150000): el índice único de identidad es una
-- expresión (case character_id/nombre), y PostgREST upsert() solo sabe
-- resolver ON CONFLICT sobre columnas literales — hace falta una función.
-- Sin tabla de auditoría aparte: no es una corrección de valores auditada,
-- es un checkbox de planificación que se reemplaza entero en cada guardado.
create or replace function save_planning_resource_selection(
  p_character_id bigint,
  p_player_name text,
  p_class text,
  p_selected_spell_ids bigint[],
  p_changed_by uuid
)
returns player_planning_resource_selections
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing player_planning_resource_selections;
  v_result player_planning_resource_selections;
begin
  if nullif(btrim(p_player_name), '') is null then raise exception 'player_name obligatorio.' using errcode = '23514'; end if;
  if nullif(btrim(p_class), '') is null then raise exception 'class obligatoria.' using errcode = '23514'; end if;

  select * into v_existing
  from player_planning_resource_selections
  where (case when p_character_id is not null then 'id:' || p_character_id::text else 'name:' || lower(btrim(p_player_name)) end)
      = (case when character_id is not null then 'id:' || character_id::text else 'name:' || lower(player_name) end)
  for update;

  if v_existing.id is null then
    insert into player_planning_resource_selections (character_id, player_name, class, selected_spell_ids, updated_by)
    values (p_character_id, btrim(p_player_name), btrim(p_class), coalesce(p_selected_spell_ids, '{}'), p_changed_by)
    returning * into v_result;
  else
    update player_planning_resource_selections
    set selected_spell_ids = coalesce(p_selected_spell_ids, '{}'),
        class = btrim(p_class),
        character_id = coalesce(p_character_id, character_id),
        updated_by = p_changed_by,
        updated_at = now()
    where id = v_existing.id
    returning * into v_result;
  end if;
  return v_result;
end;
$$;

revoke all on function save_planning_resource_selection(bigint, text, text, bigint[], uuid) from public, anon, authenticated;
grant execute on function save_planning_resource_selection(bigint, text, text, bigint[], uuid) to service_role;
