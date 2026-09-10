-- Recover canonical auto-refresh across evaluator/resolver contract upgrades.
--
-- Production incident (2026-09-10): canonical-defensive-refresh@2 (v8)
-- was deployed while a private v7 generation remained BUILDING. The legacy
-- begin_defensive_generation_refresh RPC correctly rejected the mismatched
-- contract, but the durable queue retried the same impossible start five
-- times, became BLOCKED, and left the published pointer on the previous
-- generation. New-report player infographics consequently failed closed to
-- N/D. This migration never writes the publication pointer. It only retires
-- an incompatible private BUILDING generation, creates/resumes the requested
-- contract and lets the existing exhaustive publication gate move the pointer.

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

-- One-time incident recovery. Only replace the known-incompatible BUILDING
-- contract when no live queue owns it. A fresh database, an already-v8 build
-- or an actively processing build is left untouched.
do $$
begin
  if exists (
    select 1
    from defensive_generations g
    where g.status = 'building'
      and not (
        g.game_build = '12.1.0.68914'
        and g.semantic_version = 'defensive-semantics@1.0.0'
        and g.resolver_version = 'effective-defensives@2.4.0'
        and g.semantic_resolver_version = 'effective-defensive-semantics@1.5.0'
        and g.episode_version = 'episode-evaluator@8'
        and g.evaluator_version = 'episode-evaluator@8'
      )
  ) and not exists (
    select 1
    from canonical_defensive_refresh_requests q
    where q.status = 'running'
      and q.lease_expires_at > now()
  ) and not exists (
    select 1
    from canonical_defensive_refresh_dispatch_runtime r
    where r.id = true
      and r.lease_token is not null
      and r.lease_expires_at > now()
  ) then
    perform begin_or_resume_canonical_defensive_refresh(
      p_game_build => '12.1.0.68914',
      p_semantic_version => 'defensive-semantics@1.0.0',
      p_resolver_version => 'effective-defensives@2.4.0',
      p_semantic_resolver_version => 'effective-defensive-semantics@1.5.0',
      p_episode_version => 'episode-evaluator@8',
      p_evaluator_version => 'episode-evaluator@8',
      p_report_code => null,
      p_dispatch_lease_token => null
    );
  end if;
end;
$$;

-- BLOCKED is operational state, not player evidence. Requeue only reports
-- that the canonical population still proves need refresh; attempts restart
-- because the impossible contract mismatch has been removed.
update canonical_defensive_refresh_requests q
set status = 'pending',
    not_before = now(),
    attempts = 0,
    generation_id = null,
    lease_token = null,
    lease_expires_at = null,
    last_error = null,
    completed_at = null,
    updated_at = now()
where q.status = 'blocked'
  and canonical_defensive_report_needs_refresh(q.report_code);

-- Best-effort wake-up. Queue state remains durable if pg_net is temporarily
-- unavailable; normal product traffic can drain it later as well.
select dispatch_canonical_defensive_refresh_async()
where exists (
  select 1
  from canonical_defensive_refresh_requests
  where status = 'pending'
    and not_before <= now()
);
