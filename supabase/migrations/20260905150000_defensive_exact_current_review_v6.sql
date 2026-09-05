-- Shadow v6 provenance closure.
--
-- These rows already carried exact 12.1.0.68914 identities and the correct
-- numeric values, but `reviewed=false` forced the resolver to let redundant
-- legacy-current spec profiles degrade availability confidence to fallback.
-- The values below were independently re-checked against current live spell
-- tooltips for the exact spell IDs used by WCL in this corpus:
--   Blur 198589             -> 60s cooldown, 10s effect
--   Prismatic Barrier 235450 -> 30s cooldown, 60s effect
-- Improved Prismatic Barrier's additional charge is handled separately by
-- the exact-current talent-selected modifier rule activated in v6.
-- Barrier Diffusion remains disabled because its reduction is conditional at
-- runtime and must never be flattened into an unconditional cooldown value.

DO $$
DECLARE
  blur record;
  barrier record;
BEGIN
  SELECT * INTO blur
  FROM public.cooldown_catalog
  WHERE spell_id = 198589
    AND activation_game_build = '12.1.0.68914'
  LIMIT 1;

  IF blur.id IS NULL
     OR blur.base_cooldown_ms <> 60000
     OR blur.base_duration_ms <> 10000
     OR blur.excluded IS TRUE THEN
    RAISE EXCEPTION 'v6 exact-current review: Blur 198589 row/value drift';
  END IF;

  SELECT * INTO barrier
  FROM public.cooldown_catalog
  WHERE spell_id = 235450
    AND activation_game_build = '12.1.0.68914'
  LIMIT 1;

  IF barrier.id IS NULL
     OR barrier.base_cooldown_ms <> 30000
     OR barrier.base_duration_ms <> 60000
     OR barrier.excluded IS TRUE THEN
    RAISE EXCEPTION 'v6 exact-current review: Prismatic Barrier 235450 row/value drift';
  END IF;
END $$;

UPDATE public.cooldown_catalog
SET reviewed = true,
    updated_at = now()
WHERE activation_game_build = '12.1.0.68914'
  AND (
    (spell_id = 198589 AND base_cooldown_ms = 60000 AND base_duration_ms = 10000)
    OR
    (spell_id = 235450 AND base_cooldown_ms = 30000 AND base_duration_ms = 60000)
  );
