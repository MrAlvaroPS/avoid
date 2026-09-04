-- IRIS Defensive Canonicalization v1 · E3 manual semantic closure
-- (2026-09-04). Persists the officer-reviewed residual set: 31 pending
-- rows → 22 verified + 9 rejected, 0 pending. Also repairs the malformed
-- Avatar/Protection specSemanticProfile and locks the reviewed rows so a
-- future automatic v10 classifier sync can never silently overwrite this
-- manually-approved current-build (12.1.0.68914) data.
--
-- Purely data-level: no schema change, no new table, no new column. Every
-- UPDATE sets fixed final values (never reads-then-mutates its own target
-- columns for the manifest fields), so re-running this migration against
-- an already-migrated dataset is a safe no-op for scoring purposes (only
-- reviewed_at/updated_at timestamps advance).
--
-- semantic_version is intentionally left untouched (defensive-semantics@1.0.0
-- stays homogeneous across all 340 rows) — E8 will own generation
-- snapshot/hash provenance later; this migration does not invent one now.

-- ============================================================================
-- 0) PRECONDITION GUARD (§1.1) — fail-fast, never apply to a drifted dataset.
-- ============================================================================

do $$
declare
  v_target_spell_ids int[] := array[
    194679, 196555, 426784, 1261867, 200851, 108238, 61336, 370960, 199483,
    110959, 115181, 322507, 443028, 1241059, 122278, 122783, 455139, 322101,
    115203, 122280, 122281, 132578, 119582, 322109, 122470, 434766, 450991,
    115176, 132413, 12975, 2565
  ];
  v_rejected_spell_ids int[] := array[
    194679, 196555, 200851, 108238, 370960, 122278, 122783, 122281, 115176
  ];
  v_expected_count int := 31;
  v_catalog_count int;
  v_semantics_count int;
  v_avatar_count int;
  v_pending_count int;
  v_post_state_count int;
begin
  -- one cooldown_catalog row per intended identity, no duplicates/missing.
  select count(*) into v_catalog_count from cooldown_catalog where spell_id = any(v_target_spell_ids);
  if v_catalog_count <> v_expected_count then
    raise exception 'E3 closure precondition failed: expected % cooldown_catalog rows for the 31 target spellIds, found % — aborting, dataset does not match the reviewed manifest.', v_expected_count, v_catalog_count;
  end if;

  -- one defensive_ability_semantics row per intended catalog identity.
  select count(*) into v_semantics_count
  from defensive_ability_semantics s
  join cooldown_catalog c on c.id = s.catalog_id
  where c.spell_id = any(v_target_spell_ids);
  if v_semantics_count <> v_expected_count then
    raise exception 'E3 closure precondition failed: expected % defensive_ability_semantics rows for the 31 target spellIds, found % (duplicate or missing catalog identity) — aborting.', v_expected_count, v_semantics_count;
  end if;

  -- Avatar resolves to exactly one semantic row.
  select count(*) into v_avatar_count
  from defensive_ability_semantics s
  join cooldown_catalog c on c.id = s.catalog_id
  where c.spell_id = 107574;
  if v_avatar_count <> 1 then
    raise exception 'E3 closure precondition failed: Avatar (spellId 107574) must resolve to exactly one semantic row, found % — aborting.', v_avatar_count;
  end if;

  -- Residual state must be EXACTLY the expected pre-state (31 pending) OR
  -- the exact E3 post-state already applied (idempotent replay) — never a
  -- partial/drifted state in between.
  select count(*) into v_pending_count
  from defensive_ability_semantics s
  join cooldown_catalog c on c.id = s.catalog_id
  where c.spell_id = any(v_target_spell_ids) and s.semantic_status = 'pending';

  select count(*) into v_post_state_count
  from defensive_ability_semantics s
  join cooldown_catalog c on c.id = s.catalog_id
  where c.spell_id = any(v_target_spell_ids)
    and s.locked = true
    and s.source = 'IRIS E3 manual closure 2026-09-04'
    and s.semantic_status = (case when c.spell_id = any(v_rejected_spell_ids) then 'rejected' else 'verified' end);

  if v_pending_count = v_expected_count then
    raise notice 'E3 closure: pre-state confirmed (31/31 pending) — applying migration.';
  elsif v_post_state_count = v_expected_count then
    raise notice 'E3 closure: exact post-state already applied (31/31 locked + E3 source + expected status) — re-applying idempotently, values already correct.';
  else
    raise exception 'E3 closure precondition failed: residual set is neither the expected 31-pending pre-state (found % pending) nor the exact already-migrated E3 post-state (found % matching) — dataset has drifted since review, aborting without applying a partial migration.', v_pending_count, v_post_state_count;
  end if;
end $$;

-- ============================================================================
-- 1) FIVE E3 SEMANTIC RULES (§4) — all rule_type='augment', game_build
--    12.1.0.68914, verified=true. Deterministic replay via the real unique
--    constraint (modifier_spell_id, target_spell_id, game_build, rule_type).
-- ============================================================================

insert into defensive_semantic_rules (modifier_spell_id, target_spell_id, specs, game_build, rule_type, payload, source, verified)
values
  (
    1261867, 1261867,
    array['Balance', 'Feral', 'Guardian', 'Restoration'],
    '12.1.0.68914', 'augment',
    '{
      "condition": "runtime_state",
      "modifierName": "Heart of the Wild — Bear Form defensive branch",
      "setUsageRole": "hybrid_survival",
      "setDefensiveIntent": "hybrid",
      "setOpportunityMode": "credit_only",
      "setPrimaryBeneficiary": "self",
      "setSecondaryPropagation": null,
      "addMechanisms": ["effective_health"],
      "removeMechanisms": [],
      "applicabilityPatch": {
        "schoolScope": "all",
        "schools": [],
        "deliveryScopes": ["all"],
        "requiresDodgeable": null,
        "requiresParryable": null,
        "requiresBlockable": null,
        "requiresSourceAffectedBySpell": null,
        "timingRelation": "before_or_during"
      },
      "notes": "Only the Bear-form branch grants the temporary maximum-health defensive benefit."
    }'::jsonb,
    'IRIS E3 manual closure 2026-09-04', true
  ),
  (
    443059, 443028,
    array['Mistweaver', 'Windwalker'],
    '12.1.0.68914', 'augment',
    '{
      "condition": "hero_talent_selected",
      "modifierName": "Jade Sanctuary",
      "setUsageRole": "hybrid_survival",
      "setDefensiveIntent": "hybrid",
      "setOpportunityMode": "credit_only",
      "setPrimaryBeneficiary": "self",
      "setSecondaryPropagation": null,
      "addMechanisms": ["mitigation", "sustain"],
      "removeMechanisms": [],
      "applicabilityPatch": {
        "schoolScope": "all",
        "schools": [],
        "deliveryScopes": ["all"],
        "requiresDodgeable": null,
        "requiresParryable": null,
        "requiresBlockable": null,
        "requiresSourceAffectedBySpell": null,
        "timingRelation": "either"
      },
      "notes": "Jade Sanctuary adds an immediate self-heal and personal damage reduction to Celestial Conduit."
    }'::jsonb,
    'IRIS E3 manual closure 2026-09-04', true
  ),
  (
    1272452, 322109,
    array['Brewmaster', 'Mistweaver', 'Windwalker'],
    '12.1.0.68914', 'augment',
    '{
      "condition": "talent_selected",
      "modifierName": "Chi Transfer",
      "setUsageRole": "hybrid_survival",
      "setDefensiveIntent": "hybrid",
      "setOpportunityMode": "credit_only",
      "setPrimaryBeneficiary": "self",
      "setSecondaryPropagation": null,
      "addMechanisms": ["sustain"],
      "removeMechanisms": [],
      "applicabilityPatch": {
        "schoolScope": "all",
        "schools": [],
        "deliveryScopes": ["all"],
        "requiresDodgeable": null,
        "requiresParryable": null,
        "requiresBlockable": null,
        "requiresSourceAffectedBySpell": null,
        "timingRelation": "after_damage"
      },
      "notes": "Chi Transfer causes Touch of Death to heal the Monk."
    }'::jsonb,
    'IRIS E3 manual closure 2026-09-04', true
  ),
  (
    450560, 434766,
    array['Brewmaster', 'Mistweaver', 'Windwalker'],
    '12.1.0.68914', 'augment',
    '{
      "condition": "talent_selected",
      "modifierName": "Healing Winds",
      "setUsageRole": "hybrid_survival",
      "setDefensiveIntent": "hybrid",
      "setOpportunityMode": "credit_only",
      "setPrimaryBeneficiary": "self",
      "setSecondaryPropagation": null,
      "addMechanisms": ["sustain"],
      "removeMechanisms": [],
      "applicabilityPatch": {
        "schoolScope": "all",
        "schools": [],
        "deliveryScopes": ["all"],
        "requiresDodgeable": null,
        "requiresParryable": null,
        "requiresBlockable": null,
        "requiresSourceAffectedBySpell": null,
        "timingRelation": "after_damage"
      },
      "notes": "Healing Winds causes Transcendence: Transfer to immediately heal the Monk."
    }'::jsonb,
    'IRIS E3 manual closure 2026-09-04', true
  ),
  (
    108503, 132413,
    array['Affliction', 'Destruction'],
    '12.1.0.68914', 'augment',
    '{
      "condition": "runtime_state",
      "modifierName": "Grimoire of Sacrifice — Shadow Bulwark granted",
      "setUsageRole": "personal_survival",
      "setDefensiveIntent": "primary",
      "setOpportunityMode": "normal",
      "setPrimaryBeneficiary": "self",
      "setSecondaryPropagation": null,
      "addMechanisms": ["effective_health", "sustain"],
      "removeMechanisms": [],
      "applicabilityPatch": {
        "schoolScope": "all",
        "schools": [],
        "deliveryScopes": ["all"],
        "requiresDodgeable": null,
        "requiresParryable": null,
        "requiresBlockable": null,
        "requiresSourceAffectedBySpell": null,
        "timingRelation": "either"
      },
      "notes": "Runtime must prove that the sacrificed demon grants Shadow Bulwark; selecting Grimoire of Sacrifice alone is not sufficient runtime evidence."
    }'::jsonb,
    'IRIS E3 manual closure 2026-09-04', true
  )
on conflict (modifier_spell_id, target_spell_id, game_build, rule_type)
do update set
  specs = excluded.specs,
  payload = excluded.payload,
  source = excluded.source,
  verified = excluded.verified,
  updated_at = now();

-- ============================================================================
-- 2) 22 VERIFIED (§3) — one UPDATE...FROM(VALUES) manifest, no per-spell
--    ad-hoc statements to duplicate the risk of a typo'd WHERE clause.
-- ============================================================================

with verified_manifest (
  spell_id, usage_role, activation_scope, primary_beneficiary, mechanisms,
  opportunity_mode, defensive_intent, applicability, applicability_confidence,
  spec_semantic_profiles
) as (
  values
    -- Call of the Elder Druid
    (426784, 'passive_survival', 'none', 'self', array['effective_health']::text[], 'none', 'incidental',
      null::jsonb, null::text, '[]'::jsonb),
    -- Heart of the Wild (base — Bear-form branch is the runtime rule §4.1)
    (1261867, 'utility', 'self', 'none', array[]::text[], 'none', 'hybrid',
      null, null, '[]'),
    -- Survival Instincts
    (61336, 'personal_survival', 'self', 'self', array['mitigation'], 'normal', 'primary',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"before_or_during"}'::jsonb,
      'high', '[]'),
    -- Camouflage
    (199483, 'utility', 'self', 'self', array['sustain'], 'none', 'incidental',
      null, null, '[]'),
    -- Greater Invisibility
    (110959, 'utility', 'self', 'none', array[]::text[], 'none', 'none',
      null, null, '[]'),
    -- Breath of Fire (Brewmaster rotational mitigation, source-bound)
    (115181, 'active_mitigation', 'self', 'self', array['mitigation'], 'none', 'primary',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":true,"timingRelation":"before_or_during"}'::jsonb,
      'high', '[]'),
    -- Celestial Brew
    (322507, 'personal_survival', 'self', 'self', array['absorption'], 'normal', 'primary',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"before_or_during"}'::jsonb,
      'high', '[]'),
    -- Celestial Conduit (base — Jade Sanctuary transforms it via §4.2)
    (443028, 'utility', 'self', 'none', array[]::text[], 'none', 'hybrid',
      null, null,
      '[{"spec":"Mistweaver","usageRole":"healer_throughput","defensiveIntent":"primary","activationScope":"self","primaryBeneficiary":"party","secondaryPropagation":"none","mechanisms":["sustain"],"opportunityMode":"none","applicability":{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"after_damage"},"source":"IRIS E3 manual closure 2026-09-04","confidence":"high"}]'::jsonb),
    -- Celestial Infusion
    (1241059, 'personal_survival', 'self', 'self', array['absorption'], 'normal', 'primary',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"before_or_during"}'::jsonb,
      'high', '[]'),
    -- Elixir of Determination (automatic low-health absorb)
    (455139, 'passive_survival', 'none', 'self', array['absorption'], 'none', 'primary',
      null, null, '[]'),
    -- Expel Harm
    (322101, 'rotational_survival', 'self', 'self', array['sustain'], 'none', 'primary',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"after_damage"}'::jsonb,
      'high', '[]'),
    -- Fortifying Brew
    (115203, 'personal_survival', 'self', 'self', array['mitigation', 'effective_health'], 'normal', 'primary',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"either"}'::jsonb,
      'high', '[]'),
    -- Healing Elixir (current passive identity)
    (122280, 'passive_survival', 'none', 'self', array['sustain'], 'none', 'primary',
      null, null, '[]'),
    -- Invoke Niuzao, the Black Ox
    (132578, 'hybrid_survival', 'self', 'self', array['mitigation'], 'credit_only', 'hybrid',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"before_or_during"}'::jsonb,
      'high', '[]'),
    -- Purifying Brew
    (119582, 'active_mitigation', 'self', 'self', array['mitigation'], 'none', 'primary',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"after_damage"}'::jsonb,
      'high', '[]'),
    -- Touch of Death (base — Chi Transfer transforms it via §4.3)
    (322109, 'utility', 'enemy', 'none', array[]::text[], 'none', 'none',
      null, null,
      '[{"spec":"Brewmaster","usageRole":"rotational_survival","defensiveIntent":"hybrid","activationScope":"enemy","primaryBeneficiary":"self","secondaryPropagation":"none","mechanisms":["mitigation"],"opportunityMode":"none","applicability":{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"after_damage"},"source":"IRIS E3 manual closure 2026-09-04","confidence":"high"}]'::jsonb),
    -- Touch of Karma
    (122470, 'personal_survival', 'enemy', 'self', array['absorption'], 'normal', 'primary',
      '{"schoolScope":"all","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":false,"requiresSourceAffectedBySpell":false,"timingRelation":"before_or_during"}'::jsonb,
      'high', '[]'),
    -- Transcendence: Transfer (base — Healing Winds transforms it via §4.4)
    (434766, 'utility', 'self', 'none', array[]::text[], 'none', 'none',
      null, null, '[]'),
    -- Whirling Steel (automatic low-health proc)
    (450991, 'passive_survival', 'none', 'self', array['avoidance', 'mitigation'], 'none', 'primary',
      null, null, '[]'),
    -- Shadow Bulwark (base — Grimoire of Sacrifice runtime transforms it via §4.5)
    (132413, 'utility', 'self', 'none', array[]::text[], 'none', 'hybrid',
      null, null, '[]'),
    -- Last Stand (modifies Shield Wall; preserves existing convert-to-passive rule)
    (12975, 'passive_survival', 'none', 'self', array['effective_health', 'sustain'], 'none', 'primary',
      null, null, '[]'),
    -- Shield Block
    (2565, 'active_mitigation', 'self', 'self', array['mitigation'], 'none', 'primary',
      '{"schoolScope":"physical","schools":[],"deliveryScopes":["all"],"requiresDodgeable":false,"requiresParryable":false,"requiresBlockable":true,"requiresSourceAffectedBySpell":false,"timingRelation":"before_or_during"}'::jsonb,
      'high', '[]')
)
update defensive_ability_semantics s
set
  semantic_status = 'verified',
  usage_role = m.usage_role,
  activation_scope = m.activation_scope,
  primary_beneficiary = m.primary_beneficiary,
  secondary_propagation = 'none',
  mechanisms = m.mechanisms,
  opportunity_mode = m.opportunity_mode,
  defensive_intent = m.defensive_intent,
  applicability = m.applicability,
  applicability_confidence = m.applicability_confidence,
  spec_semantic_profiles = m.spec_semantic_profiles,
  confidence = 'inferred',
  locked = true,
  source = 'IRIS E3 manual closure 2026-09-04',
  reviewed_at = now(),
  updated_at = now()
from verified_manifest m
join cooldown_catalog c on c.spell_id = m.spell_id
where s.catalog_id = c.id;

-- ============================================================================
-- 3) 9 REJECTED (§2) — uniform template, neutral legacy projection applied
--    in the sync step below (driven by the usage_role/mechanisms just set
--    here, never a separate hardcoded mapping).
-- ============================================================================

update defensive_ability_semantics s
set
  semantic_status = 'rejected',
  usage_role = 'unknown',
  activation_scope = 'unknown',
  primary_beneficiary = 'unknown',
  secondary_propagation = 'none',
  mechanisms = '{}',
  opportunity_mode = 'none',
  defensive_intent = 'unknown',
  applicability = null,
  applicability_confidence = null,
  spec_semantic_profiles = '[]'::jsonb,
  confidence = 'inferred',
  locked = true,
  source = 'IRIS E3 manual closure 2026-09-04',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.spell_id = any(array[194679, 196555, 200851, 108238, 370960, 122278, 122783, 122281, 115176]);

-- ============================================================================
-- 4) AVATAR / PROTECTION REPAIR (§5) — replace the ENTIRE
--    spec_semantic_profiles array so no malformed fragment survives; base
--    semantics untouched.
-- ============================================================================

update defensive_ability_semantics s
set
  spec_semantic_profiles = '[
    {
      "spec": "Arms",
      "usageRole": "hybrid_survival",
      "defensiveIntent": "hybrid",
      "activationScope": "self",
      "primaryBeneficiary": "self",
      "secondaryPropagation": "none",
      "mechanisms": ["mitigation"],
      "opportunityMode": "credit_only",
      "applicability": {
        "schoolScope": "all",
        "schools": [],
        "deliveryScopes": ["aoe"],
        "requiresDodgeable": null,
        "requiresParryable": null,
        "requiresBlockable": null,
        "requiresSourceAffectedBySpell": null,
        "timingRelation": "before_or_during"
      },
      "source": "IRIS E3 manual closure 2026-09-04",
      "confidence": "high"
    },
    {
      "spec": "Protection",
      "usageRole": "hybrid_survival",
      "defensiveIntent": "hybrid",
      "activationScope": "self",
      "primaryBeneficiary": "self",
      "secondaryPropagation": "none",
      "mechanisms": ["mitigation"],
      "opportunityMode": "credit_only",
      "applicability": {
        "schoolScope": "all",
        "schools": [],
        "deliveryScopes": ["all"],
        "requiresDodgeable": null,
        "requiresParryable": null,
        "requiresBlockable": null,
        "requiresSourceAffectedBySpell": null,
        "timingRelation": "before_or_during"
      },
      "source": "IRIS E3 manual closure 2026-09-04",
      "confidence": "high"
    }
  ]'::jsonb,
  locked = true,
  source = 'IRIS E3 manual closure 2026-09-04',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id and c.spell_id = 107574;

-- ============================================================================
-- 5) LEGACY cooldown_catalog SYNC (§6) — EXACT same deterministic policy as
--    deriveLegacyClassification()/deriveLegacySurvivalType()
--    (_shared/defensive-classification-semantics.ts). Hygiene only, never
--    canonical scoring truth. Runs AFTER the updates above so it reads the
--    just-persisted usage_role/mechanisms, for all 31 reviewed identities
--    (verified and rejected alike).
-- ============================================================================

update cooldown_catalog c
set
  category = case s.usage_role
    when 'personal_survival' then 'personal_defensive'
    when 'survival_state' then 'personal_defensive'
    when 'hybrid_survival' then 'personal_defensive'
    when 'healer_throughput' then 'semi_defensive'
    when 'external' then 'external_defensive'
    when 'raid_defensive' then 'external_defensive'
    else 'utility'
  end,
  targeting_mode = case s.usage_role
    when 'personal_survival' then 'self'
    when 'survival_state' then 'self'
    when 'hybrid_survival' then 'self'
    when 'healer_throughput' then 'both'
    when 'external' then 'ally'
    when 'raid_defensive' then 'raid'
    else 'unknown'
  end,
  survival_type = case
    when 'mitigation' = any(s.mechanisms) or 'avoidance' = any(s.mechanisms) then 'mitigation'
    when 'absorption' = any(s.mechanisms) then 'absorption'
    when 'sustain' = any(s.mechanisms) then 'sustain'
    when 'immunity' = any(s.mechanisms) or 'lethal_prevention' = any(s.mechanisms) or 'effective_health' = any(s.mechanisms) then 'emergency'
    else null
  end,
  reviewed = true
from defensive_ability_semantics s
where s.catalog_id = c.id
  and c.spell_id = any(array[
    194679, 196555, 426784, 1261867, 200851, 108238, 61336, 370960, 199483,
    110959, 115181, 322507, 443028, 1241059, 122278, 122783, 455139, 322101,
    115203, 122280, 122281, 132578, 119582, 322109, 122470, 434766, 450991,
    115176, 132413, 12975, 2565
  ]);

-- excluded=true only for the 9 rejected — the existing `excluded` value on
-- the 22 verified rows is preserved untouched (never re-excluded/unexcluded
-- here, e.g. Camouflage/Greater Invisibility keep whatever they had).
update cooldown_catalog
set excluded = true
where spell_id = any(array[194679, 196555, 200851, 108238, 370960, 122278, 122783, 122281, 115176]);

notify pgrst, 'reload schema';
