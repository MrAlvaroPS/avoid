-- IRIS Defensive Canonicalization v1 · Paso A-1
-- Ver iris-defensive-canonicalization-v1-plan.md §2.1/§4/§8 para el
-- razonamiento completo.
--
-- cooldown_catalog se queda como FACTS (sincronización externa: qué existe,
-- cooldown/duración base). Esta migración añade una tabla compañera que
-- guarda la SEMÁNTICA IRIS (qué significa esa habilidad para nuestros KPI)
-- — una sincronización futura puede volver a decir "Barkskin ahora dura X"
-- pero nunca "Riptide ahora es personal defensive". category/targeting_mode
-- de cooldown_catalog NO se tocan ni se retiran todavía (siguen siendo
-- consumidos por classify-defensives y por el resolver v2.1.0 actual);
-- esta migración es puramente aditiva salvo el punto 4 (default peligroso).
--
-- Migración 100% aditiva: no se borra ni renombra ninguna columna/tabla
-- existente, no se reescribe ninguna fila de cooldown_catalog.

-- 1) Tabla de semántica IRIS, 1:1 con cooldown_catalog.
create table if not exists defensive_ability_semantics (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references cooldown_catalog (id) on delete cascade,

  -- Función real de la habilidad para el KPI defensivo. Ver §1 del plan.
  usage_role text not null default 'unknown'
    check (usage_role in (
      'personal_survival', 'survival_state', 'active_mitigation',
      'rotational_survival', 'healer_throughput', 'external',
      'raid_defensive', 'utility', 'unknown'
    )),

  -- Quién puede ser el destinatario PRINCIPAL elegido por el jugador.
  -- Sustituye a la pareja activationScope+allySelectable de la propuesta
  -- original (ver §4.1 del plan: eran redundantes por construcción — una
  -- habilidad no puede ser simultáneamente 'self' y ally-selectable).
  activation_scope text not null default 'unknown'
    check (activation_scope in ('self', 'ally_selectable', 'enemy', 'ground', 'raid', 'unknown')),

  -- Efecto secundario automático sobre terceros (no elegido por el
  -- jugador). No afecta a si la habilidad cuenta como personal — ver AMS.
  secondary_propagation text not null default 'none'
    check (secondary_propagation in ('none', 'automatic_ally', 'automatic_party', 'automatic_raid')),

  -- Puede tener más de un mecanismo simultáneo (ej. Desperate Prayer:
  -- sustain + effective_health).
  mechanisms text[] not null default '{}'
    check (mechanisms <@ array['mitigation', 'absorption', 'sustain', 'immunity', 'avoidance', 'effective_health']::text[]),

  -- credit_only (ej. Bear Form): puede resolver un episodio ya evaluable
  -- pero nunca fabrica un missed_ready por su mera disponibilidad.
  opportunity_mode text not null default 'normal'
    check (opportunity_mode in ('normal', 'credit_only', 'none')),

  -- pending = todavía sin clasificar de verdad; nunca penaliza a un
  -- raider mientras esté en pending. rejected = se evaluó y no es
  -- relevante para ningún KPI defensivo (ej. cosmético).
  semantic_status text not null default 'pending'
    check (semantic_status in ('verified', 'pending', 'rejected')),

  semantic_version text not null default 'defensive-semantics@1.0.0',

  -- Mismo vocabulario de confidence ya usado en player_execution_events /
  -- player_mechanic_offenses_v3 (verified/inferred/fallback/uncertain) —
  -- no se inventa uno nuevo para este dominio.
  confidence text
    check (confidence is null or confidence in ('verified', 'inferred', 'fallback', 'uncertain')),

  -- Una fila verified+locked no puede ser pisada por una sincronización
  -- automática futura (invariante 11 del plan) — solo edición de officer.
  locked boolean not null default false,

  source text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (catalog_id)
);

comment on table defensive_ability_semantics is
  'Semántica IRIS de una habilidad del catálogo: qué significa para los KPI defensivos, separada de los facts (cooldown_catalog). Membership de "defensivo personal" se DERIVA de estas columnas (ver vista defensive_ability_semantic_catalog), nunca se guarda como booleano editable directo.';
comment on column defensive_ability_semantics.usage_role is
  'personal_survival = entra en Respuesta defensiva. survival_state = entra en el kit pero opportunity_mode=credit_only. El resto queda fuera del KPI general (puede vivir en módulos específicos: active_mitigation en tank, etc.).';
comment on column defensive_ability_semantics.activation_scope is
  'self = el jugador no puede elegir a otro como destinatario principal (aunque propague automáticamente, ver secondary_propagation). ally_selectable/raid = el jugador SÍ puede elegir a otro — nunca cuenta como kit personal aunque a veces se lance sobre uno mismo.';
comment on column defensive_ability_semantics.semantic_status is
  'pending = sin clasificar todavía, NUNCA penaliza a un raider. verified = clasificación confirmada, entra en los predicados derivados. rejected = evaluada y descartada explícitamente de todo KPI.';
comment on column defensive_ability_semantics.locked is
  'true = una sincronización externa (classify-defensives en modo sync, wowanalyzer-extractor) no puede sobrescribir esta fila; solo edición explícita de officer.';

create index if not exists defensive_ability_semantics_status_idx
  on defensive_ability_semantics (semantic_status);

-- 2) Modificadores de semántica por build/talento (ej. Refractive Images
-- convierte Mirror Image de utility a personal_survival+mitigation).
-- Mismo patrón de tabla que defensive_modifier_rules (research v5), pero
-- para SEMÁNTICA en vez de para timings numéricos.
create table if not exists defensive_semantic_rules (
  id uuid primary key default gen_random_uuid(),
  modifier_spell_id bigint not null,
  target_spell_id bigint not null,
  specs text[] not null default '{}',
  game_build text not null default 'legacy-current',
  rule_type text not null check (rule_type in ('augment', 'replace', 'suppress')),
  -- payload declarativo, ej. {"usageRole":"personal_survival","addMechanisms":["mitigation"]}
  payload jsonb not null default '{}'::jsonb,
  source text,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (modifier_spell_id, target_spell_id, game_build, rule_type)
);

comment on table defensive_semantic_rules is
  'Reglas declarativas: un talento/pasivo (modifier_spell_id) que cambia la semántica IRIS de otra habilidad (target_spell_id) para las specs/build indicadas. verified=false no se aplica todavía en el resolver, queda como propuesta.';

create index if not exists defensive_semantic_rules_target_idx
  on defensive_semantic_rules (target_spell_id, game_build)
  where verified = true;

-- 3) Vista única de membership derivada — el resolver del Paso C y
-- cualquier UI/test deben consumir esta vista, no reimplementar el
-- predicado. Dos predicados, no uno (ver §4.2 del plan: un solo
-- countsAsPersonalDefensive excluía Bear Form por accidente).
create or replace view defensive_ability_semantic_catalog
with (security_invoker = true) as
select
  c.id as catalog_id,
  c.class,
  c.spec,
  c.spell_id,
  c.name,
  c.category,
  c.targeting_mode,
  c.activation_mode,
  c.passive_conversion_spell_ids,
  c.activation_game_build,
  s.usage_role,
  s.activation_scope,
  s.secondary_propagation,
  s.mechanisms,
  s.opportunity_mode,
  s.semantic_status,
  s.semantic_version,
  s.confidence,
  s.locked,
  s.source,
  s.reviewed_at,
  (
    coalesce(s.semantic_status, 'pending') = 'verified'
    and c.activation_mode = 'active'
    and s.activation_scope = 'self'
    and s.usage_role in ('personal_survival', 'survival_state')
    and coalesce(array_length(s.mechanisms, 1), 0) > 0
  ) as is_defensive_kit_member,
  (
    coalesce(s.semantic_status, 'pending') = 'verified'
    and c.activation_mode = 'active'
    and s.activation_scope = 'self'
    and s.usage_role = 'personal_survival'
    and coalesce(array_length(s.mechanisms, 1), 0) > 0
    and s.opportunity_mode = 'normal'
  ) as creates_missable_opportunity
from cooldown_catalog c
left join defensive_ability_semantics s on s.catalog_id = c.id;

comment on view defensive_ability_semantic_catalog is
  'Única fuente de membership defensiva derivada. is_defensive_kit_member (incluye survival_state, ej. Bear Form) alimenta Uso observado y puede resolver un episodio. creates_missable_opportunity (excluye survival_state) es el único que puede generar missed_ready. Ningún consumer debe recalcular este predicado por su cuenta (invariante 1 del plan).';

-- 4) Nace pendiente, no defensiva: cualquier fila nueva de cooldown_catalog
-- (classify-defensives, sync futuro, seed manual) recibe automáticamente
-- una fila de semántica en pending — no depende de que cada writer se
-- actualice para no dejar huecos.
create or replace function ensure_defensive_ability_semantics_pending()
returns trigger
language plpgsql
as $$
begin
  insert into defensive_ability_semantics (catalog_id, semantic_status, source)
  values (new.id, 'pending', 'cooldown_catalog_insert_trigger')
  on conflict (catalog_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_cooldown_catalog_semantics_pending on cooldown_catalog;
create trigger trg_cooldown_catalog_semantics_pending
  after insert on cooldown_catalog
  for each row execute function ensure_defensive_ability_semantics_pending();

comment on function ensure_defensive_ability_semantics_pending() is
  'Garantiza que cooldown_catalog.category=... nunca vuelve a ser la única fuente de si algo es defensivo: toda fila nueva nace con semántica pending, nunca verified, sin importar qué Edge Function la insertó.';

-- 5) Backfill: una fila pending por cada entrada YA existente. No
-- clasifica nada todavía (eso es el Paso B, backfill masivo con reglas
-- deterministas + IA) — solo asegura que desde este momento ninguna
-- habilidad del catálogo actual carece de fila de semántica.
insert into defensive_ability_semantics (catalog_id, semantic_status, source)
select id, 'pending', 'backfill_20260903140000'
from cooldown_catalog
on conflict (catalog_id) do nothing;

-- 6) Retirar el default peligroso: una habilidad nueva sin category
-- explícita debe fallar el insert, no nacer silenciosamente dentro del
-- universo defensivo. Verificado: el único writer que inserta filas
-- nuevas hoy (classify-defensives/index.ts) siempre fija `category`
-- explícitamente y la valida contra CATEGORIES antes del insert — no
-- dependía de este default. La columna sigue NOT NULL.
alter table cooldown_catalog alter column category drop default;

-- 7) RLS: mismo patrón que defensive_spec_profiles/defensive_modifier_rules
-- (research v5) — lectura solo para officers autenticados, escritura
-- exclusiva de service_role (Edge Functions), sin políticas de
-- insert/update/delete para anon/authenticated.
alter table defensive_ability_semantics enable row level security;
alter table defensive_semantic_rules enable row level security;

drop policy if exists "defensive_ability_semantics: officers read" on defensive_ability_semantics;
create policy "defensive_ability_semantics: officers read"
  on defensive_ability_semantics for select
  using (is_officer());

drop policy if exists "defensive_semantic_rules: officers read" on defensive_semantic_rules;
create policy "defensive_semantic_rules: officers read"
  on defensive_semantic_rules for select
  using (is_officer());

revoke all on defensive_ability_semantics from anon;
revoke all on defensive_semantic_rules from anon;
grant select on defensive_ability_semantics to authenticated;
grant select on defensive_semantic_rules to authenticated;

revoke all on defensive_ability_semantic_catalog from anon;
grant select on defensive_ability_semantic_catalog to authenticated;

notify pgrst, 'reload schema';
