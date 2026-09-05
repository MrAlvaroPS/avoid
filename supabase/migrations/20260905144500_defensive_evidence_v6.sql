-- Defensive evidence v6: close the empirical gaps found by Shadow v5.
-- No player-specific exceptions. All changes are class/spec/build semantic or
-- source-precedence facts that the generic resolver can consume.

-- 1) Fade base remains utility. Translucent Image atomically promotes the
-- effective Fade semantic contract to a normal personal survival cooldown.
update public.defensive_semantic_rules
set payload = payload
  || jsonb_build_object(
    'setUsageRole', 'personal_survival',
    'setOpportunityMode', 'normal',
    'setDefensiveIntent', 'primary',
    'setPrimaryBeneficiary', 'self'
  )
where game_build = '12.1.0.68914'
  and verified = true
  and rule_type = 'augment'
  and modifier_spell_id = 373446
  and target_spell_id = 586
  and payload->>'condition' = 'talent_selected';

-- Exact-current Translucent Image timing and Fade-CD talent modifiers were
-- already sourced/verified but were disabled during the conservative shadow.
-- Their presence remains talent_selected, so activating the rule does not
-- apply it to builds that do not select the talent.
update public.defensive_modifier_rules
set active = true
where game_build = '12.1.0.68914'
  and class = 'Priest'
  and target_spell_id = 586
  and modifier_spell_id in (373446, 390670)
  and presence_mode = 'talent_selected';

-- Improved Prismatic Barrier is an exact-current, talent-selected charge fact.
-- Barrier Diffusion remains disabled because it is conditional runtime state
-- and must not be applied as an unconditional cooldown modifier.
update public.defensive_modifier_rules
set active = true
where game_build = '12.1.0.68914'
  and class = 'Mage'
  and target_spell_id = 235450
  and modifier_spell_id = 321745
  and operation = 'charges_add'
  and presence_mode = 'talent_selected';

-- Guardrails: fail the migration if the effective Fade semantic rule would
-- still be structurally incomplete. These checks validate data shape only;
-- the TypeScript semantic-closure gate validates the final materialized
-- combination for every resolved build.
do $$
declare
  p jsonb;
begin
  select payload into p
  from public.defensive_semantic_rules
  where game_build = '12.1.0.68914'
    and verified = true
    and rule_type = 'augment'
    and modifier_spell_id = 373446
    and target_spell_id = 586
  limit 1;

  if p is null
     or p->>'setUsageRole' <> 'personal_survival'
     or p->>'setOpportunityMode' <> 'normal'
     or p->>'setPrimaryBeneficiary' <> 'self'
     or not (coalesce(p->'addMechanisms', '[]'::jsonb) ? 'mitigation') then
    raise exception 'defensive evidence v6: Translucent Image semantic promotion is incomplete';
  end if;
end $$;
