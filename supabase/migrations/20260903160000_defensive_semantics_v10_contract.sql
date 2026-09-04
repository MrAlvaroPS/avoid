-- IRIS Defensive Canonicalization v1 · alineación con el prompt v10 de
-- classify-defensives (ver iris-defensive-canonicalization-v1-plan.md §5
-- Paso B-2 y su registro de avance §8).
--
-- El prompt v10 introduce un campo que faltaba en el contrato v9 y que es
-- estructuralmente importante: primaryBeneficiary, SEPARADO de
-- activationScope. Sin él, "Fiery Brand se dirige a un enemigo pero protege
-- al caster" no se podía modelar como personal_survival — el v9 exigía
-- activationScope='self' para contar como kit personal, lo cual es
-- incorrecto en general (ya lo era para Death Strike, que precisamente por
-- eso quedaba fuera vía activation_scope='enemy'; pero un Fiery Brand-like
-- necesitaría entrar SIENDO enemy-scoped). primary_beneficiary='self' pasa a
-- ser la condición real de membership; activation_scope dejó de serlo.
--
-- También amplía los enums (usage_role +hybrid_survival +passive_survival,
-- activation_scope +none para pasivos, mechanisms +lethal_prevention) y
-- añade almacenamiento para defensiveIntent/applicability/
-- specSemanticProfiles — datos que el prompt v10 ya produce y que Paso C
-- (aplicabilidad daño↔defensivo, semántica por spec) va a necesitar leer.
-- applicability/specSemanticProfiles se guardan como jsonb con forma
-- documentada (igual que cooldown_catalog.ai_classification ya hace para
-- datos de razonamiento IA) en vez de normalizarlas en tablas nuevas todavía
-- — Paso C decide su forma normalizada final cuando exista un consumer real
-- que la consulte con patrones de query concretos.
--
-- Aditiva: no se borra ni renombra ninguna columna existente. Los datos ya
-- verified de Paso B-1 se retro-etiquetan con primary_beneficiary/
-- defensive_intent para no perder membership bajo el nuevo predicado (ver
-- backfill al final).

alter table defensive_ability_semantics
  add column if not exists primary_beneficiary text not null default 'unknown'
    check (primary_beneficiary in ('self', 'self_or_ally_selectable', 'ally_selectable', 'party', 'raid', 'none', 'unknown')),
  add column if not exists defensive_intent text not null default 'unknown'
    check (defensive_intent in ('primary', 'hybrid', 'incidental', 'none', 'unknown')),
  add column if not exists applicability jsonb,
  add column if not exists applicability_confidence text
    check (applicability_confidence is null or applicability_confidence in ('high', 'medium', 'low')),
  add column if not exists spec_semantic_profiles jsonb not null default '[]'::jsonb;

comment on column defensive_ability_semantics.primary_beneficiary is
  'Quién recibe la protección PRINCIPAL — ortogonal a activation_scope (a quién se dirige el cast). Es la condición real de membership al kit personal (self), no activation_scope: Fiery Brand puede ser activation_scope=enemy y primary_beneficiary=self y seguir siendo personal_survival.';
comment on column defensive_ability_semantics.defensive_intent is
  'primary/hybrid/incidental — informativo para coaching y para que un officer entienda por qué algo cuenta o no; no es una condición del predicado de membership derivado.';
comment on column defensive_ability_semantics.applicability is
  'Forma: {schoolScope, schools[], deliveryScopes[], requiresDodgeable, requiresParryable, requiresBlockable, requiresSourceAffectedBySpell, timingRelation, notes} — igual que el schema del prompt v10 de classify-defensives. Alimentará canDefensiveCover() en Paso C; hasta entonces es evidencia capturada, no consumida por ningún score.';
comment on column defensive_ability_semantics.spec_semantic_profiles is
  'Array de overrides semánticos por spec cuando UNA fila de cooldown_catalog cubre varias specs con semántica realmente distinta (mismo patrón que defensive_spec_profiles para timing, pero para usageRole/activationScope/primaryBeneficiary/mechanisms/opportunityMode/applicability). [] = sin diferencias por spec.';

alter table defensive_ability_semantics
  drop constraint defensive_ability_semantics_usage_role_check;
alter table defensive_ability_semantics
  add constraint defensive_ability_semantics_usage_role_check
  check (usage_role in (
    'personal_survival', 'survival_state', 'hybrid_survival', 'active_mitigation',
    'rotational_survival', 'healer_throughput', 'external', 'raid_defensive',
    'passive_survival', 'utility', 'unknown'
  ));

alter table defensive_ability_semantics
  drop constraint defensive_ability_semantics_activation_scope_check;
alter table defensive_ability_semantics
  add constraint defensive_ability_semantics_activation_scope_check
  check (activation_scope in ('self', 'ally_selectable', 'enemy', 'ground', 'raid', 'none', 'unknown'));

alter table defensive_ability_semantics
  drop constraint defensive_ability_semantics_mechanisms_check;
alter table defensive_ability_semantics
  add constraint defensive_ability_semantics_mechanisms_check
  check (mechanisms <@ array['mitigation', 'absorption', 'sustain', 'immunity', 'avoidance', 'effective_health', 'lethal_prevention']::text[]);

-- replacementRules del prompt v10 incluye action:"convert_to_passive", que
-- el rule_type original (research v5) no contemplaba.
alter table defensive_semantic_rules
  drop constraint defensive_semantic_rules_rule_type_check;
alter table defensive_semantic_rules
  add constraint defensive_semantic_rules_rule_type_check
  check (rule_type in ('augment', 'replace', 'suppress', 'convert_to_passive'));

-- Vista de membership: primary_beneficiary sustituye a activation_scope como
-- condición de "self". hybrid_survival se une a survival_state en el mismo
-- cubo (cuenta para el kit, nunca fabrica missed_ready por su cuenta) —
-- ambos exigen opportunity_mode=credit_only por contrato (ver
-- defensiveSemanticError en _shared/defensive-classification-semantics.ts).
-- CREATE OR REPLACE VIEW no admite insertar una columna en medio de la lista
-- existente (solo apéndices al final) — primary_beneficiary va entre
-- activation_scope y secondary_propagation, así que hace falta recrearla.
drop view if exists defensive_ability_semantic_catalog;
create view defensive_ability_semantic_catalog
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
  s.primary_beneficiary,
  s.secondary_propagation,
  s.mechanisms,
  s.opportunity_mode,
  s.defensive_intent,
  s.applicability,
  s.applicability_confidence,
  s.spec_semantic_profiles,
  s.semantic_status,
  s.semantic_version,
  s.confidence,
  s.locked,
  s.source,
  s.reviewed_at,
  (
    coalesce(s.semantic_status, 'pending') = 'verified'
    and c.activation_mode = 'active'
    and coalesce(s.primary_beneficiary, 'unknown') = 'self'
    and s.usage_role in ('personal_survival', 'survival_state', 'hybrid_survival')
    and coalesce(array_length(s.mechanisms, 1), 0) > 0
  ) as is_defensive_kit_member,
  (
    coalesce(s.semantic_status, 'pending') = 'verified'
    and c.activation_mode = 'active'
    and coalesce(s.primary_beneficiary, 'unknown') = 'self'
    and s.usage_role = 'personal_survival'
    and coalesce(array_length(s.mechanisms, 1), 0) > 0
    and s.opportunity_mode = 'normal'
  ) as creates_missable_opportunity
from cooldown_catalog c
left join defensive_ability_semantics s on s.catalog_id = c.id;

comment on view defensive_ability_semantic_catalog is
  'Única fuente de membership defensiva derivada (v10: primary_beneficiary, no activation_scope, decide "self"). is_defensive_kit_member incluye survival_state/hybrid_survival (credit_only). creates_missable_opportunity solo personal_survival + opportunity_mode=normal. Ningún consumer debe recalcular este predicado por su cuenta (invariante 1 del plan).';

-- Backfill: las 72 filas ya verified de Paso B-1 no tenían primary_beneficiary
-- (nace en 'unknown' por default) — sin esto, Bear Form perdería
-- is_defensive_kit_member bajo el nuevo predicado.
update defensive_ability_semantics s
set
  primary_beneficiary = case
    when c.category = 'semi_defensive' then 'self_or_ally_selectable'
    when c.category = 'external_defensive' and c.targeting_mode = 'raid' then 'raid'
    when c.category = 'external_defensive' then 'ally_selectable'
    else s.primary_beneficiary
  end,
  defensive_intent = case
    when c.category in ('semi_defensive', 'external_defensive') then 'none'
    else s.defensive_intent
  end,
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and s.semantic_status = 'verified'
  and c.category in ('semi_defensive', 'external_defensive');

update defensive_ability_semantics s
set primary_beneficiary = 'self', defensive_intent = 'primary', updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id and c.class = 'Druid' and c.name = 'Bear Form';

update defensive_ability_semantics s
set primary_beneficiary = 'self', defensive_intent = 'hybrid', updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id and c.class = 'DeathKnight' and c.name = 'Death Strike';

-- drop view borra los grants del objeto anterior — se re-otorgan igual que
-- en la migración de Paso A-1.
revoke all on defensive_ability_semantic_catalog from anon;
grant select on defensive_ability_semantic_catalog to authenticated;

notify pgrst, 'reload schema';
