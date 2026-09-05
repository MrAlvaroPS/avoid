-- Final defensive semantic closure: Protection Divine Shield + Final Stand.
--
-- Contract:
--   * Protection + Divine Shield without Final Stand => credit_only.
--     A correct bubble may receive credit, but mere availability must never
--     manufacture a missed defensive opportunity for a tank that would lose
--     enemy targeting while immune.
--   * Protection + Final Stand selected => normal.
--     Final Stand is the explicit build fact that makes Divine Shield a normal
--     missable opportunity for Protection.
--   * Holy / Retribution keep the existing base semantic: normal.
--
-- This is deliberately data-only. The canonical resolver already applies
-- specSemanticProfiles before verified talent_selected augment rules, so no
-- evaluator/timing special-case is required.

DO $$
DECLARE
  semantic_row record;
BEGIN
  SELECT s.*, c.spell_id, c.name
    INTO semantic_row
  FROM public.defensive_ability_semantics s
  JOIN public.cooldown_catalog c ON c.id = s.catalog_id
  WHERE c.spell_id = 642
    AND c.activation_game_build = '12.1.0.68914'
  LIMIT 1;

  IF semantic_row.id IS NULL THEN
    RAISE EXCEPTION 'Divine Shield 642 exact-current semantic row missing';
  END IF;

  IF semantic_row.usage_role <> 'personal_survival'
     OR semantic_row.activation_scope <> 'self'
     OR semantic_row.primary_beneficiary <> 'self'
     OR semantic_row.opportunity_mode <> 'normal'
     OR semantic_row.semantic_status <> 'verified'
     OR NOT (semantic_row.mechanisms @> ARRAY['immunity']::text[]) THEN
    RAISE EXCEPTION 'Divine Shield 642 base semantic drift; refusing targeted Protection override';
  END IF;
END $$;

UPDATE public.defensive_ability_semantics s
SET spec_semantic_profiles = (
      SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb)
      FROM (
        SELECT value AS entry
        FROM jsonb_array_elements(COALESCE(s.spec_semantic_profiles, '[]'::jsonb))
        WHERE value->>'spec' <> 'Protection'
        UNION ALL
        SELECT jsonb_build_object(
          'spec', 'Protection',
          'usageRole', 'personal_survival',
          'defensiveIntent', 'primary',
          'activationScope', 'self',
          'primaryBeneficiary', 'self',
          'secondaryPropagation', 'none',
          'mechanisms', jsonb_build_array('immunity'),
          'opportunityMode', 'credit_only',
          'applicability', NULL,
          'source', 'IRIS final shadow review 2026-09-05: Protection Divine Shield requires Final Stand for normal missable opportunity',
          'confidence', 'high'
        ) AS entry
      ) profiles
    ),
    semantic_version = 'defensive-semantics@1.0.1',
    source = 'classify-defensives v10 + IRIS Protection Divine Shield/Final Stand closure 2026-09-05',
    reviewed_at = now(),
    updated_at = now()
FROM public.cooldown_catalog c
WHERE c.id = s.catalog_id
  AND c.spell_id = 642
  AND c.activation_game_build = '12.1.0.68914';

INSERT INTO public.defensive_semantic_rules (
  id,
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
)
SELECT
  gen_random_uuid(),
  204077,
  642,
  ARRAY['Protection']::text[],
  '12.1.0.68914',
  'augment',
  jsonb_build_object(
    'condition', 'talent_selected',
    'modifierName', 'Final Stand',
    'setUsageRole', NULL,
    'setDefensiveIntent', NULL,
    'setOpportunityMode', 'normal',
    'setPrimaryBeneficiary', NULL,
    'setSecondaryPropagation', NULL,
    'addMechanisms', jsonb_build_array(),
    'removeMechanisms', jsonb_build_array(),
    'applicabilityPatch', NULL,
    'notes', 'Protection-only: Final Stand converts Divine Shield from credit_only to a normal missable opportunity.'
  ),
  'IRIS final shadow review 2026-09-05',
  true,
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.defensive_semantic_rules r
  WHERE r.modifier_spell_id = 204077
    AND r.target_spell_id = 642
    AND r.game_build = '12.1.0.68914'
    AND r.rule_type = 'augment'
);

DO $$
DECLARE
  protection_profile jsonb;
  final_stand_rule record;
BEGIN
  SELECT profile
    INTO protection_profile
  FROM public.defensive_ability_semantics s
  JOIN public.cooldown_catalog c ON c.id = s.catalog_id
  CROSS JOIN LATERAL jsonb_array_elements(s.spec_semantic_profiles) profile
  WHERE c.spell_id = 642
    AND c.activation_game_build = '12.1.0.68914'
    AND profile->>'spec' = 'Protection'
  LIMIT 1;

  IF protection_profile IS NULL
     OR protection_profile->>'usageRole' <> 'personal_survival'
     OR protection_profile->>'opportunityMode' <> 'credit_only' THEN
    RAISE EXCEPTION 'Protection Divine Shield credit_only profile not established';
  END IF;

  SELECT * INTO final_stand_rule
  FROM public.defensive_semantic_rules r
  WHERE r.modifier_spell_id = 204077
    AND r.target_spell_id = 642
    AND r.game_build = '12.1.0.68914'
    AND r.rule_type = 'augment'
    AND r.verified = true
  LIMIT 1;

  IF final_stand_rule.id IS NULL
     OR final_stand_rule.payload->>'condition' <> 'talent_selected'
     OR final_stand_rule.payload->>'setOpportunityMode' <> 'normal' THEN
    RAISE EXCEPTION 'Final Stand -> Divine Shield normal opportunity rule not established';
  END IF;
END $$;
