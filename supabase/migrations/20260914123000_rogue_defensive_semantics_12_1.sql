-- Rogue 12.1 defensive semantic correction (2026-09-14).
--
-- Real case that exposed the problem: Rivax (Assassination) has Evasion 5277
-- and Cheat Death selected, NOT Elusiveness 79008. The catalog classified
-- baseline Evasion as opportunity_mode=normal, so a niche dodge-only button
-- could manufacture missed raid-defensive opportunities even when the damage
-- was not dodgeable. Crimson Vial 185311 was also normal even though it is a
-- small recovery/sustain tool used after damage, not prevention of a spike.
--
-- Contract after this migration:
--   * Evasion baseline => credit_only + avoidance. It remains visible and a
--     correct situational use can receive credit, but availability alone never
--     creates a generic missed raid defensive.
--   * Evasion + Elusiveness => normal + mitigation, all damage, no dodgeability
--     requirement. This is the talent that turns Evasion into a real general
--     damage-reduction cooldown.
--   * Evasion + Bait and Switch => remains normal when that verified hero
--     augment is selected; otherwise changing the base to credit_only would
--     silently regress Deathstalker builds that do gain direct mitigation.
--   * Crimson Vial => credit_only + sustain/after_damage. It stays in the
--     personal survival kit as bonus/recovery evidence, but never satisfies a
--     missed-spike obligation merely because it was ready.
--
-- Data-only semantic changes are observable scoring changes, so this migration
-- also advances the semantic resolver contract to 1.8.0. The TypeScript source
-- of truth is bumped in the same PR; expected_contract makes the canonical
-- refresh pipeline invalidate old 1.7.0 generations instead of mixing old and
-- new semantics under one version.

DO $$
DECLARE
  evasion_row record;
  vial_row record;
BEGIN
  SELECT s.*, c.spell_id, c.name
    INTO evasion_row
  FROM public.defensive_ability_semantics s
  JOIN public.cooldown_catalog c ON c.id = s.catalog_id
  WHERE c.class = 'Rogue'
    AND c.spell_id = 5277
    AND c.activation_game_build = '12.1.0.68914'
  LIMIT 1;

  IF evasion_row.id IS NULL THEN
    RAISE EXCEPTION 'Rogue Evasion 5277 exact-current semantic row missing';
  END IF;
  IF evasion_row.usage_role <> 'personal_survival'
     OR evasion_row.activation_scope <> 'self'
     OR evasion_row.primary_beneficiary <> 'self'
     OR evasion_row.semantic_status <> 'verified'
     OR NOT (evasion_row.mechanisms @> ARRAY['avoidance']::text[]) THEN
    RAISE EXCEPTION 'Rogue Evasion 5277 semantic drift; refusing targeted 12.1 correction';
  END IF;

  SELECT s.*, c.spell_id, c.name
    INTO vial_row
  FROM public.defensive_ability_semantics s
  JOIN public.cooldown_catalog c ON c.id = s.catalog_id
  WHERE c.class = 'Rogue'
    AND c.spell_id = 185311
    AND c.activation_game_build = '12.1.0.68914'
  LIMIT 1;

  IF vial_row.id IS NULL THEN
    RAISE EXCEPTION 'Rogue Crimson Vial 185311 exact-current semantic row missing';
  END IF;
  IF vial_row.usage_role <> 'personal_survival'
     OR vial_row.activation_scope <> 'self'
     OR vial_row.primary_beneficiary <> 'self'
     OR vial_row.semantic_status <> 'verified'
     OR NOT (vial_row.mechanisms @> ARRAY['sustain']::text[]) THEN
    RAISE EXCEPTION 'Rogue Crimson Vial 185311 semantic drift; refusing targeted 12.1 correction';
  END IF;
END $$;

-- Baseline Evasion is an avoidance resource, not a generic raid-spike
-- mitigator. Keep it in the kit but make it bonus/conditional.
UPDATE public.defensive_ability_semantics s
SET opportunity_mode = 'credit_only',
    locked = true,
    source = 'IRIS Rogue 12.1 defensive review 2026-09-14: baseline Evasion is dodge-only/conditional; Elusiveness promotes it to general mitigation',
    reviewed_at = now(),
    updated_at = now()
FROM public.cooldown_catalog c
WHERE c.id = s.catalog_id
  AND c.class = 'Rogue'
  AND c.spell_id = 5277
  AND c.activation_game_build = '12.1.0.68914';

-- Crimson Vial is a minor self-heal/recovery button. It can earn positive
-- credit when used well, but readiness must never manufacture a missed spike.
UPDATE public.defensive_ability_semantics s
SET opportunity_mode = 'credit_only',
    locked = true,
    source = 'IRIS Rogue 12.1 defensive review 2026-09-14: Crimson Vial is sustain/recovery, not pre-hit mitigation',
    reviewed_at = now(),
    updated_at = now()
FROM public.cooldown_catalog c
WHERE c.id = s.catalog_id
  AND c.class = 'Rogue'
  AND c.spell_id = 185311
  AND c.activation_game_build = '12.1.0.68914';

-- Elusiveness is the build fact that changes Evasion from niche avoidance into
-- a general damage-reduction opportunity. Replace the malformed/unverified
-- classifier proposal with a deterministic verified rule.
INSERT INTO public.defensive_semantic_rules (
  modifier_spell_id,
  target_spell_id,
  specs,
  game_build,
  rule_type,
  payload,
  source,
  verified,
  created_at,
  updated_at
) VALUES (
  79008,
  5277,
  ARRAY['Assassination', 'Outlaw', 'Subtlety']::text[],
  '12.1.0.68914',
  'augment',
  jsonb_build_object(
    'condition', 'talent_selected',
    'modifierName', 'Elusiveness',
    'setUsageRole', NULL,
    'setDefensiveIntent', NULL,
    'setOpportunityMode', 'normal',
    'setPrimaryBeneficiary', NULL,
    'setSecondaryPropagation', NULL,
    'addMechanisms', jsonb_build_array('mitigation'),
    'removeMechanisms', jsonb_build_array(),
    'applicabilityPatch', jsonb_build_object(
      'schoolScope', 'all',
      'schools', jsonb_build_array(),
      'deliveryScopes', jsonb_build_array('all'),
      'requiresDodgeable', false,
      'requiresParryable', NULL,
      'requiresBlockable', NULL,
      'requiresSourceAffectedBySpell', false,
      'timingRelation', 'before_or_during'
    ),
    'notes', 'Elusiveness adds direct general damage reduction to Evasion; therefore Evasion becomes a normal missable mitigation opportunity only when this talent is selected.'
  ),
  'IRIS Rogue 12.1 defensive review 2026-09-14; live Elusiveness tooltip + current Rogue raid guides',
  true,
  now(),
  now()
)
ON CONFLICT (modifier_spell_id, target_spell_id, game_build, rule_type)
DO UPDATE SET
  specs = EXCLUDED.specs,
  payload = EXCLUDED.payload,
  source = EXCLUDED.source,
  verified = true,
  updated_at = now();

-- Bait and Switch already has a verified Evasion mitigation augment in the
-- current dataset. Baseline Evasion becoming credit_only must not demote that
-- real direct mitigation. Preserve the existing effect/applicability payload
-- and only make its opportunity consequence explicit.
UPDATE public.defensive_semantic_rules
SET payload = jsonb_set(payload, '{setOpportunityMode}', '"normal"'::jsonb, true),
    source = concat_ws(' + ', nullif(source, ''), 'IRIS Rogue 12.1 opportunity correction 2026-09-14'),
    updated_at = now()
WHERE modifier_spell_id = 457034
  AND target_spell_id = 5277
  AND game_build = '12.1.0.68914'
  AND rule_type = 'augment'
  AND verified = true;

-- A semantic behavior change must never share the old generation identity.
UPDATE public.canonical_defensive_expected_contract
SET semantic_resolver_version = 'effective-defensive-semantics@1.8.0',
    updated_at = now()
WHERE id = true;

DO $$
DECLARE
  evasion_mode text;
  vial_mode text;
  elusiveness_rule record;
  bait_rule record;
  expected_version text;
BEGIN
  SELECT s.opportunity_mode
    INTO evasion_mode
  FROM public.defensive_ability_semantics s
  JOIN public.cooldown_catalog c ON c.id = s.catalog_id
  WHERE c.class = 'Rogue'
    AND c.spell_id = 5277
    AND c.activation_game_build = '12.1.0.68914'
  LIMIT 1;

  IF evasion_mode <> 'credit_only' THEN
    RAISE EXCEPTION 'Rogue Evasion 5277 baseline credit_only postcondition failed';
  END IF;

  SELECT s.opportunity_mode
    INTO vial_mode
  FROM public.defensive_ability_semantics s
  JOIN public.cooldown_catalog c ON c.id = s.catalog_id
  WHERE c.class = 'Rogue'
    AND c.spell_id = 185311
    AND c.activation_game_build = '12.1.0.68914'
  LIMIT 1;

  IF vial_mode <> 'credit_only' THEN
    RAISE EXCEPTION 'Rogue Crimson Vial 185311 credit_only postcondition failed';
  END IF;

  SELECT * INTO elusiveness_rule
  FROM public.defensive_semantic_rules
  WHERE modifier_spell_id = 79008
    AND target_spell_id = 5277
    AND game_build = '12.1.0.68914'
    AND rule_type = 'augment'
  LIMIT 1;

  IF elusiveness_rule.id IS NULL
     OR elusiveness_rule.verified <> true
     OR elusiveness_rule.payload->>'condition' <> 'talent_selected'
     OR elusiveness_rule.payload->>'setOpportunityMode' <> 'normal'
     OR NOT ((elusiveness_rule.payload->'addMechanisms') @> '["mitigation"]'::jsonb)
     OR (elusiveness_rule.payload#>>'{applicabilityPatch,schoolScope}') <> 'all'
     OR (elusiveness_rule.payload#>>'{applicabilityPatch,requiresDodgeable}') <> 'false' THEN
    RAISE EXCEPTION 'Elusiveness -> Evasion verified mitigation rule postcondition failed';
  END IF;

  SELECT * INTO bait_rule
  FROM public.defensive_semantic_rules
  WHERE modifier_spell_id = 457034
    AND target_spell_id = 5277
    AND game_build = '12.1.0.68914'
    AND rule_type = 'augment'
    AND verified = true
  LIMIT 1;

  IF bait_rule.id IS NOT NULL AND bait_rule.payload->>'setOpportunityMode' <> 'normal' THEN
    RAISE EXCEPTION 'Bait and Switch -> Evasion normal opportunity postcondition failed';
  END IF;

  SELECT semantic_resolver_version
    INTO expected_version
  FROM public.canonical_defensive_expected_contract
  WHERE id = true;

  IF expected_version IS DISTINCT FROM 'effective-defensive-semantics@1.8.0' THEN
    RAISE EXCEPTION 'canonical_defensive_expected_contract semantic resolver bump failed';
  END IF;
END $$;