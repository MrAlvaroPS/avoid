-- Defensive evidence v5: source/claim normalization discovered by the E7 fixture battery.
-- No player-specific rules. All changes are build/spec/ability semantic facts.

alter table public.defensive_modifier_rules
  add column if not exists presence_mode text not null default 'talent_selected';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'defensive_modifier_rules_presence_mode_check'
  ) then
    alter table public.defensive_modifier_rules
      add constraint defensive_modifier_rules_presence_mode_check
      check (presence_mode in ('talent_selected','spec_baseline'));
  end if;
end $$;

-- Spec passives are auto-granted by the spec and do not appear as selectable
-- WCL talent nodes. Their modifiers must be applied from class/spec/build.
update public.defensive_modifier_rules
set presence_mode = 'spec_baseline'
where game_build = '12.1.0.68914'
  and class = 'Monk'
  and target_spell_id = 115203
  and modifier_spell_id in (1258138, 1258122);

-- Exact-current charge modifiers verified against current spell data.
update public.defensive_modifier_rules
set active = true
where game_build = '12.1.0.68914'
  and (
    (class = 'DemonHunter' and modifier_spell_id = 1266307 and target_spell_id in (198589,203720))
    or
    (class = 'Paladin' and modifier_spell_id = 1246481 and target_spell_id = 86659)
  );

-- Fade with Translucent Image is a real, finite-CD, self 10% DR. Base Fade
-- remains utility; only the verified talent-selected augment creates a normal
-- personal mitigation opportunity. This is intentionally NOT a code hardcode.
update public.defensive_semantic_rules
set payload = jsonb_set(payload, '{setOpportunityMode}', '"normal"'::jsonb, true)
where game_build = '12.1.0.68914'
  and verified = true
  and rule_type = 'augment'
  and modifier_spell_id = 373446
  and target_spell_id = 586
  and payload->>'condition' = 'talent_selected';
