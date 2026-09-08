-- IRIS defensive identity hotfix · 2026-09-08
--
-- Root cause (verified against production data + WCL-facing persistence):
-- 20260823110000 treated Paladin Divine Protection spellIds 498 and 403876 as
-- duplicate rows and deleted 403876. That assumption is unsafe for combat-log
-- identity: Holy uses 498 while Retribution is observed under 403876. All
-- defensive evaluators intentionally key casts/buffs by exact spellId, so the
-- collapsed row made Retribution casts disappear and could turn real uses into
-- false available_unused / missed_ready verdicts.
--
-- Do NOT model the two ids as two simultaneously available cooldowns. They are
-- the same named defensive with mutually exclusive spec-scoped runtime
-- identities. This migration restores that invariant at the existing canonical
-- source of truth (cooldown_catalog + semantics/rules), so analyze-report,
-- reanalyze-defensive-pressure and canonical-defensive-refresh all consume the
-- fix without adding a parallel spell-id mapping mechanism.

-- 1) The existing 498 row becomes Holy-only.
do $$
begin
  if not exists (
    select 1 from cooldown_catalog
    where class = 'Paladin' and spell_id = 498 and excluded = false
  ) then
    raise exception 'Cannot split Divine Protection runtime identity: Paladin spellId 498 is missing';
  end if;
end $$;

update cooldown_catalog
set
  spec = 'Holy',
  spec_override = array['Holy']::text[],
  updated_at = now()
where class = 'Paladin'
  and spell_id = 498;

-- 2) Restore the Retribution runtime identity by cloning the curated factual
-- fields from 498. The spec scope is deliberately disjoint, so no player can
-- receive both entries from specApplies().
insert into cooldown_catalog (
  class,
  spec,
  spell_id,
  name,
  category,
  synced_from_commit,
  synced_at,
  base_cooldown_ms,
  base_duration_ms,
  survival_type,
  inferred_survival_type,
  ai_classification,
  reviewed,
  spec_override,
  excluded,
  targeting_mode,
  activation_mode,
  passive_conversion_spell_ids,
  activation_game_build,
  updated_at
)
select
  class,
  'Retribution',
  403876,
  name,
  category,
  synced_from_commit,
  synced_at,
  base_cooldown_ms,
  base_duration_ms,
  survival_type,
  inferred_survival_type,
  ai_classification,
  true,
  array['Retribution']::text[],
  false,
  targeting_mode,
  activation_mode,
  passive_conversion_spell_ids,
  activation_game_build,
  now()
from cooldown_catalog
where class = 'Paladin'
  and spell_id = 498
on conflict (class, spell_id) do update
set
  spec = excluded.spec,
  name = excluded.name,
  category = excluded.category,
  base_cooldown_ms = excluded.base_cooldown_ms,
  base_duration_ms = excluded.base_duration_ms,
  survival_type = excluded.survival_type,
  inferred_survival_type = excluded.inferred_survival_type,
  ai_classification = excluded.ai_classification,
  reviewed = true,
  spec_override = excluded.spec_override,
  excluded = false,
  targeting_mode = excluded.targeting_mode,
  activation_mode = excluded.activation_mode,
  passive_conversion_spell_ids = excluded.passive_conversion_spell_ids,
  activation_game_build = excluded.activation_game_build,
  updated_at = now();

-- 3) Clone the verified semantic contract to the new catalog identity. Semantics
-- are attached to catalog_id, not name, so without this the runtime cast would
-- be visible but canonical Usage/Response would correctly fail closed instead
-- of scoring it.
insert into defensive_ability_semantics (
  catalog_id,
  usage_role,
  activation_scope,
  secondary_propagation,
  mechanisms,
  opportunity_mode,
  semantic_status,
  semantic_version,
  confidence,
  locked,
  source,
  reviewed_at,
  updated_at,
  primary_beneficiary,
  defensive_intent,
  applicability,
  applicability_confidence,
  spec_semantic_profiles
)
select
  ret.id,
  sem.usage_role,
  sem.activation_scope,
  sem.secondary_propagation,
  sem.mechanisms,
  sem.opportunity_mode,
  sem.semantic_status,
  sem.semantic_version,
  sem.confidence,
  sem.locked,
  concat_ws(' | ', sem.source, 'runtime identity split 498->403876 (Retribution, 2026-09-08)'),
  coalesce(sem.reviewed_at, now()),
  now(),
  sem.primary_beneficiary,
  sem.defensive_intent,
  sem.applicability,
  sem.applicability_confidence,
  sem.spec_semantic_profiles
from cooldown_catalog holy
join defensive_ability_semantics sem on sem.catalog_id = holy.id
join cooldown_catalog ret
  on ret.class = holy.class
 and ret.spell_id = 403876
where holy.class = 'Paladin'
  and holy.spell_id = 498
on conflict (catalog_id) do update
set
  usage_role = excluded.usage_role,
  activation_scope = excluded.activation_scope,
  secondary_propagation = excluded.secondary_propagation,
  mechanisms = excluded.mechanisms,
  opportunity_mode = excluded.opportunity_mode,
  semantic_status = excluded.semantic_status,
  semantic_version = excluded.semantic_version,
  confidence = excluded.confidence,
  locked = excluded.locked,
  source = excluded.source,
  reviewed_at = excluded.reviewed_at,
  updated_at = now(),
  primary_beneficiary = excluded.primary_beneficiary,
  defensive_intent = excluded.defensive_intent,
  applicability = excluded.applicability,
  applicability_confidence = excluded.applicability_confidence,
  spec_semantic_profiles = excluded.spec_semantic_profiles;

-- 4) Semantic rules are spellId-addressed too. Split every rule that currently
-- targets 498 and applies to Retribution. Mixed Holy/Retribution rules keep the
-- Holy half on 498 and receive a Retribution copy on 403876; Ret-only rules are
-- retargeted in place. Protection-only replacement semantics remain untouched.
insert into defensive_semantic_rules (
  modifier_spell_id,
  target_spell_id,
  specs,
  game_build,
  rule_type,
  payload,
  source,
  verified,
  updated_at
)
select
  modifier_spell_id,
  403876,
  array['Retribution']::text[],
  game_build,
  rule_type,
  payload,
  source,
  verified,
  now()
from defensive_semantic_rules
where target_spell_id = 498
  and 'Retribution' = any(specs)
  and cardinality(specs) > 1
on conflict (modifier_spell_id, target_spell_id, game_build, rule_type) do update
set
  specs = excluded.specs,
  payload = excluded.payload,
  source = excluded.source,
  verified = excluded.verified,
  updated_at = now();

update defensive_semantic_rules
set
  target_spell_id = 403876,
  updated_at = now()
where target_spell_id = 498
  and 'Retribution' = any(specs)
  and cardinality(specs) = 1;

update defensive_semantic_rules
set
  specs = array_remove(specs, 'Retribution'),
  updated_at = now()
where target_spell_id = 498
  and 'Retribution' = any(specs)
  and cardinality(specs) > 1;

-- 5) Timing modifier rules use the same targetSpellId contract. There is an
-- inactive shared Paladin rule today; splitting it now prevents a future
-- reactivation/resync from silently applying only to Holy.
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
  active,
  updated_at,
  game_build,
  effect_field,
  application_order,
  presence_mode
)
select
  class,
  array['Retribution']::text[],
  modifier_spell_id,
  403876,
  operation,
  value,
  per_rank,
  condition,
  description,
  source,
  verified_at,
  active,
  now(),
  game_build,
  effect_field,
  application_order,
  presence_mode
from defensive_modifier_rules
where class = 'Paladin'
  and target_spell_id = 498
  and 'Retribution' = any(coalesce(specs, '{}'::text[]))
  and cardinality(coalesce(specs, '{}'::text[])) > 1
on conflict (class, modifier_spell_id, target_spell_id, operation, effect_field, game_build) do update
set
  specs = excluded.specs,
  value = excluded.value,
  per_rank = excluded.per_rank,
  condition = excluded.condition,
  description = excluded.description,
  source = excluded.source,
  verified_at = excluded.verified_at,
  active = excluded.active,
  updated_at = now(),
  application_order = excluded.application_order,
  presence_mode = excluded.presence_mode;

update defensive_modifier_rules
set
  target_spell_id = 403876,
  updated_at = now()
where class = 'Paladin'
  and target_spell_id = 498
  and 'Retribution' = any(coalesce(specs, '{}'::text[]))
  and cardinality(coalesce(specs, '{}'::text[])) = 1;

update defensive_modifier_rules
set
  specs = array_remove(specs, 'Retribution'),
  updated_at = now()
where class = 'Paladin'
  and target_spell_id = 498
  and 'Retribution' = any(coalesce(specs, '{}'::text[]))
  and cardinality(coalesce(specs, '{}'::text[])) > 1;

-- 6) Executable migration invariants. If a future schema/data change makes
-- this split unsafe, abort rather than publishing a half-fixed catalog that
-- can create player-facing false penalties.
do $$
declare
  holy_semantics integer;
  ret_semantics integer;
begin
  if not exists (
    select 1 from cooldown_catalog
    where class = 'Paladin'
      and spell_id = 498
      and excluded = false
      and spec = 'Holy'
      and spec_override = array['Holy']::text[]
  ) then
    raise exception 'Divine Protection invariant failed: 498 is not Holy-only';
  end if;

  if not exists (
    select 1 from cooldown_catalog
    where class = 'Paladin'
      and spell_id = 403876
      and excluded = false
      and spec = 'Retribution'
      and spec_override = array['Retribution']::text[]
  ) then
    raise exception 'Divine Protection invariant failed: 403876 is not Retribution-only';
  end if;

  if exists (
    select 1 from cooldown_catalog
    where class = 'Paladin'
      and spell_id = 498
      and 'Retribution' = any(coalesce(spec_override, '{}'::text[]))
  ) then
    raise exception 'Divine Protection invariant failed: Retribution still resolves 498';
  end if;

  if exists (
    select 1 from cooldown_catalog
    where class = 'Paladin'
      and spell_id = 403876
      and 'Holy' = any(coalesce(spec_override, '{}'::text[]))
  ) then
    raise exception 'Divine Protection invariant failed: Holy resolves 403876';
  end if;

  select count(*) into holy_semantics
  from defensive_ability_semantics sem
  join cooldown_catalog cc on cc.id = sem.catalog_id
  where cc.class = 'Paladin'
    and cc.spell_id = 498
    and sem.semantic_status = 'verified'
    and sem.usage_role = 'personal_survival'
    and sem.activation_scope = 'self'
    and sem.opportunity_mode = 'normal'
    and 'mitigation' = any(sem.mechanisms);

  select count(*) into ret_semantics
  from defensive_ability_semantics sem
  join cooldown_catalog cc on cc.id = sem.catalog_id
  where cc.class = 'Paladin'
    and cc.spell_id = 403876
    and sem.semantic_status = 'verified'
    and sem.usage_role = 'personal_survival'
    and sem.activation_scope = 'self'
    and sem.opportunity_mode = 'normal'
    and 'mitigation' = any(sem.mechanisms);

  if holy_semantics <> 1 or ret_semantics <> 1 then
    raise exception 'Divine Protection invariant failed: verified semantic rows Holy=%, Ret=%', holy_semantics, ret_semantics;
  end if;

  if exists (
    select 1 from defensive_semantic_rules
    where target_spell_id = 498
      and 'Retribution' = any(specs)
  ) then
    raise exception 'Divine Protection invariant failed: a Retribution semantic rule still targets 498';
  end if;

  if exists (
    select 1 from defensive_modifier_rules
    where class = 'Paladin'
      and target_spell_id = 498
      and 'Retribution' = any(coalesce(specs, '{}'::text[]))
  ) then
    raise exception 'Divine Protection invariant failed: a Retribution timing rule still targets 498';
  end if;
end $$;

comment on column cooldown_catalog.spec_override is
  'Manual spec applicability override. Runtime spell identities that share a display name must remain separate when WCL uses different spellIds per spec (e.g. Divine Protection: Holy 498, Retribution 403876).';
