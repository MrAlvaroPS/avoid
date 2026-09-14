-- Canonical defensive audit evidence v8.
--
-- Additive only: published v7 generations remain immutable and readable. The
-- new canonical worker writes episode-evaluator@8 rows with an explicit
-- effective-kit snapshot and peak magnitude. The pointer is never moved by
-- this migration; normal completeness gates and auto-refresh own publication.

alter table player_pull_defensive_episode_evaluations
  add column if not exists effective_kit jsonb not null default '[]'::jsonb;

alter table player_pull_defensive_episode_evaluations
  drop constraint if exists player_pull_defensive_episode_evaluations_effective_kit_check;
alter table player_pull_defensive_episode_evaluations
  add constraint player_pull_defensive_episode_evaluations_effective_kit_check
  check (jsonb_typeof(effective_kit) = 'array');

comment on column player_pull_defensive_episode_evaluations.effective_kit is
  'Build-aware effective defensive kit snapshot produced by the same canonical resolver as episodes. Audit-only projection evidence; never an independent resolver or score.';

-- Keep copy-on-write exact for future report-local refreshes after v8 is
-- published. This is the current resume-safe function from 20260908222000,
-- with effective_kit added to the staging clone and no other semantic change.
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

