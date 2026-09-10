-- Druid defensive runtime-opportunity safety closure (2026-09-10).
--
-- Empirical trigger:
-- - Balance Druids in current 12.1 raid data use Frenzied Regeneration (22842)
--   as a Bear Form response, not as an unconditional standalone button.
-- - Legacy and canonical scoring can currently turn `off cooldown` into a
--   punitive opportunity even when the runtime preconditions for the heal are
--   not proven. That produced false `preventableWithDefensive=true` deaths and
--   FR-only `missed_ready` episodes.
--
-- Safety policy until IRIS has a generic resource/form-state opportunity
-- resolver: Frenzied Regeneration remains a personal-kit member and receives
-- positive Usage/coverage credit when it is actually used, but its mere
-- availability cannot manufacture a negative denominator. This is exactly
-- what opportunity_mode='credit_only' means in the canonical semantic
-- contract. The semantic row is locked so classify-defensives cannot silently
-- restore the unsafe `normal` value.
--
-- This migration also closes the current-build Barkskin duration split:
-- Balance/Guardian = 8s, Feral/Restoration = 12s. Exact spec profiles are the
-- supported timing override mechanism; no spell-specific evaluator hardcode
-- is introduced.

DO $$
DECLARE
  v_fr_count integer;
  v_bark_count integer;
  v_fr_post_count integer;
BEGIN
  SELECT count(*) INTO v_fr_count
  FROM defensive_ability_semantics s
  JOIN cooldown_catalog c ON c.id = s.catalog_id
  WHERE c.class = 'Druid' AND c.spell_id = 22842;

  IF v_fr_count <> 1 THEN
    RAISE EXCEPTION 'Druid safety precondition failed: expected exactly one Frenzied Regeneration semantic row, found %', v_fr_count;
  END IF;

  SELECT count(*) INTO v_bark_count
  FROM cooldown_catalog c
  WHERE c.class = 'Druid' AND c.spell_id = 22812;

  IF v_bark_count <> 1 THEN
    RAISE EXCEPTION 'Druid safety precondition failed: expected exactly one Barkskin catalog row, found %', v_bark_count;
  END IF;

  -- Accept either the exact current unsafe pre-state or our exact post-state.
  -- Anything else is drift and must be reviewed rather than overwritten.
  SELECT count(*) INTO v_fr_post_count
  FROM defensive_ability_semantics s
  JOIN cooldown_catalog c ON c.id = s.catalog_id
  WHERE c.class = 'Druid'
    AND c.spell_id = 22842
    AND s.semantic_status = 'verified'
    AND s.usage_role = 'personal_survival'
    AND s.primary_beneficiary = 'self'
    AND s.mechanisms @> ARRAY['sustain']::text[]
    AND s.applicability ->> 'timingRelation' = 'after_damage'
    AND (
      s.opportunity_mode = 'normal'
      OR (
        s.opportunity_mode = 'credit_only'
        AND s.locked = true
        AND s.source = 'IRIS Druid runtime opportunity safety 2026-09-10'
      )
    );

  IF v_fr_post_count <> 1 THEN
    RAISE EXCEPTION 'Druid safety precondition failed: Frenzied Regeneration semantics drifted from the reviewed normal/credit_only state';
  END IF;
END $$;

UPDATE defensive_ability_semantics s
SET opportunity_mode = 'credit_only',
    locked = true,
    source = 'IRIS Druid runtime opportunity safety 2026-09-10',
    reviewed_at = now(),
    updated_at = now()
FROM cooldown_catalog c
WHERE c.id = s.catalog_id
  AND c.class = 'Druid'
  AND c.spell_id = 22842;

-- Current-build Barkskin timing by spec. These are exact profiles, so the
-- resolver applies them with current-build authority rather than legacy
-- fallback confidence.
INSERT INTO defensive_spec_profiles (
  class, spec, spell_id, game_build,
  base_cooldown_ms, base_duration_ms, charges, recharge_ms,
  source, source_note, synced_from_commit, verified_at, updated_at
)
VALUES
  ('Druid', 'Balance',     22812, '12.1.0.68914', 60000,  8000, 1, NULL,
    'IRIS Druid runtime opportunity safety 2026-09-10',
    'Current 12.1 Barkskin duration for Balance.', NULL, now(), now()),
  ('Druid', 'Guardian',    22812, '12.1.0.68914', 60000,  8000, 1, NULL,
    'IRIS Druid runtime opportunity safety 2026-09-10',
    'Current 12.1 Barkskin duration for Guardian.', NULL, now(), now()),
  ('Druid', 'Feral',       22812, '12.1.0.68914', 60000, 12000, 1, NULL,
    'IRIS Druid runtime opportunity safety 2026-09-10',
    'Current 12.1 Barkskin duration for Feral.', NULL, now(), now()),
  ('Druid', 'Restoration', 22812, '12.1.0.68914', 60000, 12000, 1, NULL,
    'IRIS Druid runtime opportunity safety 2026-09-10',
    'Current 12.1 Barkskin duration for Restoration.', NULL, now(), now())
ON CONFLICT (class, spec, spell_id, game_build)
DO UPDATE SET
  base_cooldown_ms = EXCLUDED.base_cooldown_ms,
  base_duration_ms = EXCLUDED.base_duration_ms,
  charges = EXCLUDED.charges,
  recharge_ms = EXCLUDED.recharge_ms,
  source = EXCLUDED.source,
  source_note = EXCLUDED.source_note,
  synced_from_commit = EXCLUDED.synced_from_commit,
  verified_at = EXCLUDED.verified_at,
  updated_at = EXCLUDED.updated_at;

DO $$
DECLARE
  v_fr_safe integer;
  v_bark_profiles integer;
BEGIN
  SELECT count(*) INTO v_fr_safe
  FROM defensive_ability_semantic_catalog
  WHERE class = 'Druid'
    AND spell_id = 22842
    AND semantic_status = 'verified'
    AND is_defensive_kit_member = true
    AND creates_missable_opportunity = false
    AND opportunity_mode = 'credit_only';

  IF v_fr_safe <> 1 THEN
    RAISE EXCEPTION 'Druid safety postcondition failed: Frenzied Regeneration must remain a kit member but must not create missable opportunities';
  END IF;

  SELECT count(*) INTO v_bark_profiles
  FROM defensive_spec_profiles
  WHERE class = 'Druid'
    AND spell_id = 22812
    AND game_build = '12.1.0.68914'
    AND (
      (spec IN ('Balance', 'Guardian') AND base_cooldown_ms = 60000 AND base_duration_ms = 8000 AND charges = 1)
      OR
      (spec IN ('Feral', 'Restoration') AND base_cooldown_ms = 60000 AND base_duration_ms = 12000 AND charges = 1)
    );

  IF v_bark_profiles <> 4 THEN
    RAISE EXCEPTION 'Druid safety postcondition failed: expected four exact Barkskin spec profiles, found %', v_bark_profiles;
  END IF;
END $$;
