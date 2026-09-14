-- Incident (2026-09-14): "Actualizar infografías" failing every raid night with
--
--   canonical-defensive-refresh start failed (500): 57014: canceling statement
--   due to statement timeout
--
-- Root cause, confirmed empirically against production data: `start` runs
-- begin_or_resume_canonical_defensive_refresh -> begin_defensive_generation_refresh,
-- which copy-on-write clones the ENTIRE previous published generation's
-- player_pull_defensive_episode_evaluations + player_execution_events rows into
-- the new BUILDING generation (everything except the report being refreshed).
-- Measured directly (EXPLAIN ANALYZE, rolled back) against the real published
-- generation on 2026-09-14: the episode-evaluations clone took ~12.4s and the
-- ledger-events clone ~21.3s — ~33s combined for ~10k rows across two ~300MB
-- JSONB-heavy tables.
--
-- PostgREST (and therefore every supabase-js `.rpc()` call from an edge
-- function, service-role key included) connects as the `authenticator`
-- role, whose `rolconfig` pins `statement_timeout=8s` — regardless of
-- `service_role` having no override of its own. `SET ROLE` (what PostgREST
-- does internally to become service_role) does not reset GUCs already set on
-- the login role, so this single production RPC has effectively always run
-- under an 8s budget. It happened to fit before; it does not any more, and
-- the clone only grows as more reports are canonicalized — this will keep
-- recurring, and get worse, on every future raid night without this fix.
--
-- Fix: give ONLY this maintenance RPC (and the copy-on-write worker it
-- delegates to) a much larger, LOCAL statement_timeout. `set_config(...,
-- true)` is transaction-scoped — it reverts automatically at commit/rollback
-- of this single RPC call and never touches the authenticator/service_role
-- defaults that protect every other query. 120s matches this project's own
-- platform-level statement_timeout default (`show statement_timeout` = 2min)
-- and comfortably covers the ~33s measured today plus room to grow.
--
-- This is a stopgap for tonight, not a scalability fix: the clone is still
-- O(size of the published generation) on every `start` call. If raid data
-- keeps growing, revisit doing an incremental/delta clone instead of a full
-- copy-on-write snapshot per generation.

create or replace function begin_or_resume_canonical_defensive_refresh(
  p_game_build text,
  p_semantic_version text,
  p_resolver_version text,
  p_semantic_resolver_version text,
  p_episode_version text,
  p_evaluator_version text,
  p_report_code text default null,
  p_dispatch_lease_token uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  existing defensive_generations%rowtype;
  new_generation_id uuid;
  conflicting_live_lease boolean := false;
  affected integer := 0;
begin
  -- §incident-2026-09-14 — see migration header. LOCAL to this transaction only.
  perform set_config('statement_timeout', '120000', true);

  perform pg_advisory_xact_lock(hashtext('iris:defensive-generation-refresh'));

  -- A supplied lease is an internal dispatcher claim, not merely a report
  -- hint. Validate both durable records before allowing it to replace a stale
  -- private generation or bind a new one.
  if p_dispatch_lease_token is not null then
    if p_report_code is null then
      raise exception 'A dispatch lease requires report_code';
    end if;
    if not exists (
      select 1
      from canonical_defensive_refresh_requests q
      join canonical_defensive_refresh_dispatch_runtime r
        on r.id = true
       and r.lease_token = q.lease_token
       and r.lease_report_code = q.report_code
      where q.report_code = p_report_code
        and q.status = 'running'
        and q.lease_token = p_dispatch_lease_token
        and q.lease_expires_at > now()
        and r.lease_expires_at > now()
    ) then
      raise exception 'Stale or invalid canonical defensive dispatch lease for report %', p_report_code;
    end if;
  end if;

  select * into existing
  from defensive_generations
  where status = 'building'
  limit 1
  for update;

  if found and not (
    existing.game_build = p_game_build
    and existing.semantic_version = p_semantic_version
    and existing.resolver_version = p_resolver_version
    and existing.semantic_resolver_version = p_semantic_resolver_version
    and existing.episode_version = p_episode_version
    and existing.evaluator_version = p_evaluator_version
  ) then
    -- Never retire somebody else's live build. The one exception is the
    -- exact lease invoking this function: after a deployment, an expired
    -- request may have been reclaimed with its old generation_id preserved.
    -- That claimant owns the transition and old tokens can no longer renew.
    select exists (
      select 1
      from canonical_defensive_refresh_requests q
      where q.status = 'running'
        and q.lease_expires_at > now()
        and (
          p_dispatch_lease_token is null
          or q.report_code is distinct from p_report_code
          or q.lease_token is distinct from p_dispatch_lease_token
        )
    ) into conflicting_live_lease;

    if conflicting_live_lease then
      raise exception 'A different defensive generation is actively building: %', existing.id;
    end if;

    update defensive_generations
    set status = 'failed',
        notes = jsonb_build_object(
          'kind', 'retired_incompatible_building_generation',
          'retiredAt', now(),
          'reason', 'worker_contract_upgrade',
          'previousContract', jsonb_build_object(
            'gameBuild', existing.game_build,
            'semanticVersion', existing.semantic_version,
            'resolverVersion', existing.resolver_version,
            'semanticResolverVersion', existing.semantic_resolver_version,
            'episodeVersion', existing.episode_version,
            'evaluatorVersion', existing.evaluator_version
          ),
          'requestedContract', jsonb_build_object(
            'gameBuild', p_game_build,
            'semanticVersion', p_semantic_version,
            'resolverVersion', p_resolver_version,
            'semanticResolverVersion', p_semantic_resolver_version,
            'episodeVersion', p_episode_version,
            'evaluatorVersion', p_evaluator_version
          ),
          'previousNotes', existing.notes
        )::text
    where id = existing.id
      and status = 'building';

    -- A failed private generation is never a resumable queue target. Preserve
    -- request status/attempt/lease ownership; only detach the obsolete ID.
    update canonical_defensive_refresh_requests
    set generation_id = null,
        updated_at = now()
    where generation_id = existing.id;

    update canonical_defensive_refresh_dispatch_runtime
    set lease_generation_id = null,
        updated_at = now()
    where id = true
      and lease_generation_id = existing.id;
  end if;

  -- Reuse the existing copy-on-write implementation (including effective_kit
  -- in v8). The advisory lock is transaction-scoped and re-entrant here.
  new_generation_id := begin_defensive_generation_refresh(
    p_game_build,
    p_semantic_version,
    p_resolver_version,
    p_semantic_resolver_version,
    p_episode_version,
    p_evaluator_version,
    p_report_code
  );

  if p_dispatch_lease_token is not null then
    update canonical_defensive_refresh_dispatch_runtime
    set lease_generation_id = new_generation_id,
        lease_expires_at = now() + interval '5 minutes',
        updated_at = now()
    where id = true
      and lease_token = p_dispatch_lease_token
      and lease_report_code = p_report_code
      and lease_expires_at > now();
    get diagnostics affected = row_count;
    if affected <> 1 then
      raise exception 'Canonical defensive runtime lease became stale for report %', p_report_code;
    end if;

    update canonical_defensive_refresh_requests
    set generation_id = new_generation_id,
        lease_expires_at = now() + interval '5 minutes',
        updated_at = now()
    where report_code = p_report_code
      and lease_token = p_dispatch_lease_token
      and status = 'running'
      and lease_expires_at > now();
    get diagnostics affected = row_count;
    if affected <> 1 then
      raise exception 'Canonical defensive request lease became stale for report %', p_report_code;
    end if;
  end if;

  return new_generation_id;
end;
$$;

revoke all on function begin_or_resume_canonical_defensive_refresh(
  text, text, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function begin_or_resume_canonical_defensive_refresh(
  text, text, text, text, text, text, text, uuid
) to service_role;

-- Defense in depth: begin_defensive_generation_refresh does the actual heavy
-- copy-on-write clone and is also invoked directly by one-off maintenance
-- migrations (see 20260910001000) outside begin_or_resume_*'s transaction.
create or replace function begin_defensive_generation_refresh(
  p_game_build text,
  p_semantic_version text,
  p_resolver_version text,
  p_semantic_resolver_version text,
  p_episode_version text,
  p_evaluator_version text,
  p_report_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_id uuid;
  parent defensive_generations%rowtype;
  parent_id uuid;
  child_id uuid;
  bad_parent_keys integer := 0;
  is_dispatch_resume boolean := false;
begin
  -- §incident-2026-09-14 — see 20260914120000 migration header. LOCAL to this
  -- transaction only; harmless to set again if the caller already did.
  perform set_config('statement_timeout', '120000', true);

  perform pg_advisory_xact_lock(hashtext('iris:defensive-generation-refresh'));

  select id into existing_id from defensive_generations where status = 'building' limit 1;
  if existing_id is not null then
    if not exists (
      select 1 from defensive_generations g
      where g.id = existing_id
        and g.game_build = p_game_build
        and g.semantic_version = p_semantic_version
        and g.resolver_version = p_resolver_version
        and g.semantic_resolver_version = p_semantic_resolver_version
        and g.episode_version = p_episode_version
        and g.evaluator_version = p_evaluator_version
    ) then
      raise exception 'A different defensive generation is already building: %', existing_id;
    end if;

    if p_report_code is not null then
      select exists (
        select 1
        from canonical_defensive_refresh_requests q
        where q.report_code = p_report_code
          and q.status = 'running'
          and q.generation_id = existing_id
          and q.lease_expires_at > now()
      ) into is_dispatch_resume;

      if not is_dispatch_resume then
        delete from player_execution_events pe
        where pe.defensive_generation_id = existing_id
          and pe.domain = 'defensive'
          and exists (
            select 1 from canonical_defensive_eligible_player_pulls x
            where x.pull_id = pe.pull_id
              and x.player_name = pe.player_name
              and x.report_code = p_report_code
              and x.game_build = p_game_build
          );
        delete from player_pull_defensive_episode_evaluations s
        where s.defensive_generation_id = existing_id
          and exists (
            select 1 from canonical_defensive_eligible_player_pulls x
            where x.pull_id = s.pull_id
              and x.player_name = s.player_name
              and x.report_code = p_report_code
              and x.game_build = p_game_build
          );
      end if;
    end if;
    return existing_id;
  end if;

  select ptr.published_generation_id into parent_id
  from defensive_generation_pointer ptr where ptr.id = true for update;
  if parent_id is not null then
    select * into parent from defensive_generations where id = parent_id;
  end if;

  insert into defensive_generations (
    status, semantic_version, resolver_version, semantic_resolver_version,
    episode_version, evaluator_version, game_build, notes
  ) values (
    'building', p_semantic_version, p_resolver_version, p_semantic_resolver_version,
    p_episode_version, p_evaluator_version, p_game_build,
    jsonb_build_object(
      'kind', 'canonical_defensive_production_refresh',
      'startedAt', now(),
      'sourceReportCode', p_report_code,
      'parentGenerationId', parent_id,
      'contract', jsonb_build_object(
        'gameBuild', p_game_build,
        'semanticVersion', p_semantic_version,
        'resolverVersion', p_resolver_version,
        'semanticResolverVersion', p_semantic_resolver_version,
        'episodeVersion', p_episode_version,
        'evaluatorVersion', p_evaluator_version
      )
    )::text
  ) returning id into child_id;

  if parent_id is not null
     and parent.status = 'published'
     and parent.game_build = p_game_build
     and parent.semantic_version = p_semantic_version
     and parent.resolver_version = p_resolver_version
     and parent.semantic_resolver_version = p_semantic_resolver_version
     and parent.episode_version = p_episode_version
     and parent.evaluator_version = p_evaluator_version then

    insert into player_pull_defensive_episode_evaluations (
      defensive_generation_id, pull_id, player_name, episode_evaluator_version,
      semantic_version, semantic_resolver_version, resolver_version,
      build_fingerprint, data_confidence, effective_kit, episodes, evaluated_at
    )
    select
      child_id, s.pull_id, s.player_name, s.episode_evaluator_version,
      s.semantic_version, s.semantic_resolver_version, s.resolver_version,
      s.build_fingerprint, s.data_confidence, s.effective_kit, s.episodes, s.evaluated_at
    from player_pull_defensive_episode_evaluations s
    join canonical_defensive_eligible_player_pulls e
      on e.pull_id = s.pull_id
     and e.player_name = s.player_name
     and e.game_build = p_game_build
    where s.defensive_generation_id = parent_id
      and s.episode_evaluator_version = p_evaluator_version
      and s.semantic_version = p_semantic_version
      and s.semantic_resolver_version = p_semantic_resolver_version
      and s.resolver_version = p_resolver_version
      and (p_report_code is null or e.report_code <> p_report_code);

    select count(*) into bad_parent_keys
    from player_execution_events e
    join canonical_defensive_eligible_player_pulls x
      on x.pull_id = e.pull_id
     and x.player_name = e.player_name
     and x.game_build = p_game_build
    where e.defensive_generation_id = parent_id
      and e.domain = 'defensive'
      and (p_report_code is null or x.report_code <> p_report_code)
      and e.deduplication_key not like parent_id::text || ':%';
    if bad_parent_keys <> 0 then
      raise exception 'Published defensive ledger has % non-canonical dedupe keys; clone aborted', bad_parent_keys;
    end if;

    insert into player_execution_events (
      pull_id, boss_id, difficulty, player_name, occurrence_id, causal_group_id,
      timestamp_ms, domain, event_type, verdict, reason_code, credit_eligible,
      penalty_eligible, primary_penalty, severity, priority, confidence, evidence,
      policy_version, context_resolver_version, occurrence_resolver_version,
      ledger_evaluator_version, deduplication_key, evaluated_at, defensive_generation_id
    )
    select
      e.pull_id, e.boss_id, e.difficulty, e.player_name, e.occurrence_id, e.causal_group_id,
      e.timestamp_ms, e.domain, e.event_type, e.verdict, e.reason_code, e.credit_eligible,
      e.penalty_eligible, e.primary_penalty, e.severity, e.priority, e.confidence, e.evidence,
      e.policy_version, e.context_resolver_version, e.occurrence_resolver_version,
      e.ledger_evaluator_version,
      child_id::text || substring(e.deduplication_key from length(parent_id::text) + 1),
      e.evaluated_at, child_id
    from player_execution_events e
    join canonical_defensive_eligible_player_pulls x
      on x.pull_id = e.pull_id
     and x.player_name = e.player_name
     and x.game_build = p_game_build
    where e.defensive_generation_id = parent_id
      and e.domain = 'defensive'
      and (p_report_code is null or x.report_code <> p_report_code);
  end if;

  return child_id;
end;
$$;
revoke all on function begin_defensive_generation_refresh(text,text,text,text,text,text,text)
from public, anon, authenticated;
grant execute on function begin_defensive_generation_refresh(text,text,text,text,text,text,text)
to service_role;
