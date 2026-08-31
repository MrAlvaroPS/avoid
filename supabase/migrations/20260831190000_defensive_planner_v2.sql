-- Planner v2: capa ADITIVA para resolver cooldowns efectivos por spec/build.
-- No toca ni migra mechanic_defensive_assignments: la planificación nueva se
-- valida en paralelo y las asignaciones v1 existentes siguen intactas.

create table if not exists defensive_cooldown_spec_overrides (
  id uuid primary key default gen_random_uuid(),
  class text not null,
  spec text not null,
  spell_id bigint not null,
  base_cooldown_ms bigint not null check (base_cooldown_ms >= 0),
  base_duration_ms bigint check (base_duration_ms is null or base_duration_ms >= 0),
  source text not null default 'verified_source',
  source_note text,
  synced_from_commit text,
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class, spec, spell_id)
);

comment on table defensive_cooldown_spec_overrides is
  'Planner v2: valor base por spec cuando el mismo hechizo cambia de cooldown/duración según especialización. Gana sobre cooldown_catalog.base_*; no contiene modificadores de talentos.';

create table if not exists defensive_cooldown_talent_modifiers (
  id uuid primary key default gen_random_uuid(),
  class text not null,
  spec text not null,
  defensive_spell_id bigint not null,
  talent_spell_id bigint not null,
  cooldown_delta_ms bigint not null default 0,
  cooldown_multiplier numeric not null default 1 check (cooldown_multiplier > 0),
  duration_delta_ms bigint not null default 0,
  source text not null default 'verified_source',
  source_note text,
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class, spec, defensive_spell_id, talent_spell_id)
);

comment on table defensive_cooldown_talent_modifiers is
  'Planner v2: modificadores DETERMINISTAS de cooldown/duración causados por un talento seleccionado. El resolver solo aplica una fila si talent_build contiene talent_spell_id.';

-- Backfill seguro: las filas que el catálogo YA conoce como específicas de
-- una spec son una base válida para la nueva capa. Un override verificado y
-- específico insertado después gana por la misma clave.
insert into defensive_cooldown_spec_overrides (class, spec, spell_id, base_cooldown_ms, base_duration_ms, source, source_note, synced_from_commit, verified_at, updated_at)
select class, spec, spell_id, base_cooldown_ms, base_duration_ms,
       'cooldown_catalog_spec', 'Backfill desde una fila del catálogo ya acotada a esta spec.', synced_from_commit, now(), now()
from cooldown_catalog
where spec is not null and base_cooldown_ms is not null
on conflict (class, spec, spell_id) do nothing;

-- Caso real que motivó la v2. El tooltip genérico de Fortifying Brew no es
-- el cooldown de Mistweaver/Windwalker: ambas specs tienen base 120s. Se
-- incluyen los IDs que WoW usa históricamente para las variantes del cast;
-- solo tendrá efecto el que exista en cooldown_catalog para esa spec.
insert into defensive_cooldown_spec_overrides (class, spec, spell_id, base_cooldown_ms, base_duration_ms, source, source_note, verified_at, updated_at)
values
  ('Monk', 'Mistweaver', 243435, 120000, 15000, 'verified_2026_08_31', 'Fortifying Brew: Mistweaver base 2 min; duración 15s.', now(), now()),
  ('Monk', 'Mistweaver', 115203, 120000, 15000, 'verified_2026_08_31', 'Fortifying Brew: alias/variante de spell usada por algunas fuentes; Mistweaver base 2 min.', now(), now()),
  ('Monk', 'Windwalker', 115203, 120000, 15000, 'verified_2026_08_31', 'Fortifying Brew: Windwalker base 2 min; duración 15s.', now(), now()),
  ('Monk', 'Windwalker', 243435, 120000, 15000, 'verified_2026_08_31', 'Fortifying Brew: alias/variante; Windwalker base 2 min.', now(), now())
on conflict (class, spec, spell_id) do update
set base_cooldown_ms = excluded.base_cooldown_ms,
    base_duration_ms = excluded.base_duration_ms,
    source = excluded.source,
    source_note = excluded.source_note,
    verified_at = excluded.verified_at,
    updated_at = excluded.updated_at;

-- Expeditious Fortification (#388813) reduce Fortifying Brew 30s para MW/WW.
insert into defensive_cooldown_talent_modifiers (class, spec, defensive_spell_id, talent_spell_id, cooldown_delta_ms, source, source_note, verified_at, updated_at)
values
  ('Monk', 'Mistweaver', 243435, 388813, -30000, 'verified_2026_08_31', 'Expeditious Fortification: Fortifying Brew -30s.', now(), now()),
  ('Monk', 'Mistweaver', 115203, 388813, -30000, 'verified_2026_08_31', 'Expeditious Fortification: Fortifying Brew -30s.', now(), now()),
  ('Monk', 'Windwalker', 115203, 388813, -30000, 'verified_2026_08_31', 'Expeditious Fortification: Fortifying Brew -30s.', now(), now()),
  ('Monk', 'Windwalker', 243435, 388813, -30000, 'verified_2026_08_31', 'Expeditious Fortification: Fortifying Brew -30s.', now(), now())
on conflict (class, spec, defensive_spell_id, talent_spell_id) do update
set cooldown_delta_ms = excluded.cooldown_delta_ms,
    source = excluded.source,
    source_note = excluded.source_note,
    verified_at = excluded.verified_at,
    updated_at = excluded.updated_at;

-- Build real más reciente del jugador. A diferencia de player_latest_spec,
-- conserva talent_build (nodos enriquecidos con spellId en analyze-report),
-- que es lo que permite aplicar reglas de CD al jugador concreto.
drop view if exists player_latest_build;
create view player_latest_build with (security_invoker = true) as
select distinct on (player_name)
  player_name,
  class,
  spec,
  talent_build,
  created_at as observed_at
from player_pull_records
where spec is not null and class is not null
order by player_name, created_at desc;

comment on view player_latest_build is
  'Planner v2: class/spec/talent_build del pull más reciente de cada jugador; security_invoker conserva el RLS de player_pull_records.';

alter table defensive_cooldown_spec_overrides enable row level security;
alter table defensive_cooldown_talent_modifiers enable row level security;
create policy "read all - defensive_cooldown_spec_overrides" on defensive_cooldown_spec_overrides for select using (is_officer());
create policy "read all - defensive_cooldown_talent_modifiers" on defensive_cooldown_talent_modifiers for select using (is_officer());

grant select on defensive_cooldown_spec_overrides to authenticated;
grant select on defensive_cooldown_talent_modifiers to authenticated;
grant select on player_latest_build to authenticated;
