-- Defensive research v5: the AI pass is no longer limited to classifying
-- rows that WoWAnalyzer already happened to expose. It can also resolve
-- spec-specific timings and talent/passive modifiers. These two tables use
-- the same schema as Planning v2 so that branch can be rebased/merged later
-- without introducing a second representation of the same data.

create table if not exists defensive_spec_profiles (
  class text not null,
  spec text not null,
  spell_id bigint not null,
  base_cooldown_ms integer,
  base_duration_ms integer,
  charges smallint not null default 1 check (charges > 0),
  source text,
  source_note text,
  synced_from_commit text,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (class, spec, spell_id)
);

comment on table defensive_spec_profiles is
  'Comportamiento base de un defensivo para una spec concreta. Gana sobre cooldown_catalog cuando una spec tenga un valor realmente distinto.';

create table if not exists defensive_modifier_rules (
  id uuid primary key default gen_random_uuid(),
  class text not null,
  specs text[],
  modifier_spell_id bigint not null,
  target_spell_id bigint not null,
  operation text not null check (operation in ('subtract_ms', 'add_ms', 'multiply', 'set_ms', 'charges_add')),
  value numeric not null,
  per_rank boolean not null default false,
  condition text not null default 'always' check (condition in ('always', 'conditional')),
  description text not null,
  source text,
  verified_at timestamptz,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (class, modifier_spell_id, target_spell_id, operation)
);

comment on table defensive_modifier_rules is
  'Reglas declarativas de talentos/pasivas que cambian cooldown, duración o cargas del defensivo. Las conditional no deben asumirse como reducción garantizada.';

-- Estas tablas solo las escribe classify-defensives mediante service_role en
-- main. Planning v2 añadirá las policies/grants de lectura al desplegarse.
alter table defensive_spec_profiles enable row level security;
alter table defensive_modifier_rules enable row level security;

-- Caso real que destapó el problema de disponibilidad por spec.
-- Desperate Prayer es actualmente un talento del árbol DE CLASE de Priest,
-- por lo que Discipline/Holy/Shadow pueden elegirlo. El cooldown sin
-- modificadores es 90 s y el aumento de vida dura 10 s.
update cooldown_catalog
set
  spec = null,
  category = 'personal_defensive',
  base_cooldown_ms = 90000,
  base_duration_ms = 10000,
  survival_type = coalesce(survival_type, 'emergency'),
  inferred_survival_type = coalesce(inferred_survival_type, 'emergency'),
  updated_at = now()
where class = 'Priest' and spell_id = 19236;

-- Power Word: Shield no aparecía porque el catálogo heredado depende de lo
-- que WoWAnalyzer modela como cooldown. Es una absorción baseline de Priest,
-- puede lanzarse sobre uno mismo y sobre aliados; semi_defensive hace que
-- siga siendo elegible como herramienta personal sin fingir que es self-only.
insert into cooldown_catalog (
  class,
  spec,
  spell_id,
  name,
  category,
  base_cooldown_ms,
  base_duration_ms,
  survival_type,
  inferred_survival_type,
  reviewed
)
values (
  'Priest',
  null,
  17,
  'Power Word: Shield',
  'semi_defensive',
  7500,
  15000,
  'absorption',
  'absorption',
  false
)
on conflict (class, spell_id) do update set
  spec = null,
  name = excluded.name,
  category = excluded.category,
  base_cooldown_ms = excluded.base_cooldown_ms,
  base_duration_ms = excluded.base_duration_ms,
  survival_type = coalesce(cooldown_catalog.survival_type, excluded.survival_type),
  inferred_survival_type = coalesce(cooldown_catalog.inferred_survival_type, excluded.inferred_survival_type),
  updated_at = now();

-- Angel's Mercy is a class-tree passive available to all Priest specs. It
-- reduces Desperate Prayer by 20 s: 90 s base -> 70 s effective for a build
-- that actually contains talent spell 238100. The base catalog intentionally
-- stays at 90 s; effective timing belongs in the modifier layer.
insert into defensive_modifier_rules (
  class,
  specs,
  modifier_spell_id,
  target_spell_id,
  operation,
  value,
  per_rank,
  condition,
  description,
  source,
  verified_at,
  active
)
values (
  'Priest',
  null,
  238100,
  19236,
  'subtract_ms',
  20000,
  false,
  'always',
  'Angel''s Mercy reduce 20 s el cooldown de Desperate Prayer.',
  'Warcraft Wiki / Mechanical Priest / Murlok, verificado 2026-08-31',
  now(),
  true
)
on conflict (class, modifier_spell_id, target_spell_id, operation) do update set
  specs = excluded.specs,
  value = excluded.value,
  per_rank = excluded.per_rank,
  condition = excluded.condition,
  description = excluded.description,
  source = excluded.source,
  verified_at = excluded.verified_at,
  active = true,
  updated_at = now();
