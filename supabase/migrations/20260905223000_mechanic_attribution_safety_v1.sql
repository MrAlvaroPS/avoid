-- Mechanic attribution safety v1.
--
-- Additive projection used by current Reliability consumers while the causal
-- occurrence/responsibility ledger remains in shadow/E2E. It deliberately
-- cannot create a new personal failure: explicit responsibility may only
-- remove legacy accusations that contradict responsibility; historical rows
-- without responsibility retain the previous category-based behavior.
--
-- IMPORTANT: this view does not identify the actor of tank/healer/dps/raid
-- failures. It only answers the narrower question "may this hit still count as
-- this player's personal failure under the legacy scoring model?".

create or replace view player_pull_mechanic_attribution_safety_v1
with (security_invoker = true) as
select
  r.player_name,
  p.id as pull_id,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
    where e.pull_id = p.id
      and e.outcome <> 'clean'
      and detail->>'name' = r.player_name
      and (
        (
          e.responsibility = 'personal'
          and e.category in ('avoidable-ground', 'spread', 'soak', 'personal-target')
        )
        or (
          e.responsibility is null
          and e.category in ('avoidable-ground', 'spread', 'soak', 'personal-target')
        )
      )
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
  )::integer as personal_mechanic_fail_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.category in ('avoidable-ground', 'spread')
      and e.outcome <> 'clean'
      and (e.responsibility = 'personal' or e.responsibility is null)
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->'timeMs') = 'number'
          and (r.death_cause->>'timeMs')::numeric > e.trigger_time_ms
        )
      )
  )::integer as avoidable_mechanic_eligible_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    cross join lateral jsonb_array_elements(coalesce(e.player_hit_details, '[]'::jsonb)) detail
    where e.pull_id = p.id
      and e.category in ('avoidable-ground', 'spread')
      and e.outcome <> 'clean'
      and (e.responsibility = 'personal' or e.responsibility is null)
      and detail->>'name' = r.player_name
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
      and (
        not r.died
        or (
          jsonb_typeof(r.death_cause->'timeMs') = 'number'
          and (r.death_cause->>'timeMs')::numeric > e.trigger_time_ms
        )
      )
  )::integer as avoidable_mechanic_fail_count,
  (
    select count(*)
    from applicable_pull_mechanic_events e
    where e.pull_id = p.id
      and e.outcome <> 'clean'
      and e.responsibility is null
      and e.category in ('avoidable-ground', 'spread', 'soak', 'personal-target')
      and not (
        p.wipe_call_excluded
        and p.wipe_call_signals is not null
        and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
        and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
      )
  )::integer as legacy_fallback_event_count,
  'mechanic-attribution-safety@1.0.0'::text as attribution_version
from player_pull_records r
join pulls p on p.id = r.pull_id
where not p.ninja_pull_excluded;

revoke all on player_pull_mechanic_attribution_safety_v1 from anon, authenticated;
grant select on player_pull_mechanic_attribution_safety_v1 to authenticated;

comment on view player_pull_mechanic_attribution_safety_v1 is
  'Responsibility-aware safety overlay for current mechanic scoring. Explicit raid/tank/healer/dps responsibility can never become a personal failure merely because the player was hit. Historical responsibility=null rows preserve the old category fallback. This is transitional until causal mechanic occurrence/edge E2E is promoted.';
