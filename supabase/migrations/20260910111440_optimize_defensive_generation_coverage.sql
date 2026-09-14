-- defensive_generation_coverage used to expand the same episode JSON three
-- times per call. Publication calls the guard more than once by design, so a
-- complete 91-pull generation exceeded PostgREST's statement timeout despite
-- containing only ~3k expected ledger keys. Materialize each evidence set once
-- while preserving every existing equality and anti-join invariant.

create index if not exists player_execution_events_defensive_generation_key_idx
  on public.player_execution_events (
    defensive_generation_id,
    pull_id,
    player_name,
    deduplication_key
  )
  where defensive_generation_id is not null;

create or replace function public.defensive_generation_coverage(p_generation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  g defensive_generations%rowtype;
  result jsonb;
begin
  select * into g
  from defensive_generations
  where id = p_generation_id;

  if not found then
    raise exception 'Unknown defensive generation %', p_generation_id;
  end if;
  if g.evaluator_version is null or g.episode_version is null then
    raise exception 'Generation % has no evaluator/episode version', p_generation_id;
  end if;

  with eligible as materialized (
    select e.pull_id, e.player_name
    from canonical_defensive_eligible_player_pulls e
    where e.game_build = g.game_build
  ), safe_rows as materialized (
    select s.pull_id, s.player_name, s.episodes
    from player_pull_defensive_episode_evaluations s
    join eligible e
      on e.pull_id = s.pull_id
     and e.player_name = s.player_name
    where s.defensive_generation_id = g.id
      and s.episode_evaluator_version = g.evaluator_version
      and s.semantic_version = g.semantic_version
      and s.semantic_resolver_version = g.semantic_resolver_version
      and s.resolver_version = g.resolver_version
  ), episodes as materialized (
    select s.pull_id, s.player_name, ep.value as episode
    from safe_rows s
    cross join lateral jsonb_array_elements(s.episodes) ep(value)
  ), expected_keys as materialized (
    select
      ep.pull_id,
      ep.player_name,
      g.id::text || ':' || (ep.episode ->> 'episodeId') || ':' || ep.player_name || ':response'
        as deduplication_key
    from episodes ep
    where nullif(ep.episode ->> 'episodeId', '') is not null

    union all

    select
      ep.pull_id,
      ep.player_name,
      g.id::text || ':' || (ep.episode ->> 'episodeId') || ':' || ep.player_name || ':plan:'
        || (ep.episode ->> 'planAssignmentId') as deduplication_key
    from episodes ep
    where nullif(ep.episode ->> 'episodeId', '') is not null
      and nullif(ep.episode ->> 'planAssignmentId', '') is not null
      and nullif(ep.episode ->> 'planVerdict', '') is not null
  ), actual_keys as materialized (
    select e.pull_id, e.player_name, e.deduplication_key
    from player_execution_events e
    where e.defensive_generation_id = g.id
      and e.domain = 'defensive'
      and (
        e.event_type like 'defensive_episode_%'
        or e.event_type like 'defensive_plan_%'
      )
  ), metrics as (
    select
      (select count(*)::integer from eligible) as expected_player_rows,
      (select count(distinct e.pull_id)::integer from eligible e) as expected_pulls,
      (select count(*)::integer from safe_rows) as safe_staged_rows,
      (select count(distinct s.pull_id)::integer from safe_rows s) as staged_pulls,
      (
        select count(*)::integer
        from eligible e
        where not exists (
          select 1
          from safe_rows s
          where s.pull_id = e.pull_id
            and s.player_name = e.player_name
        )
      ) as missing_player_rows,
      (
        select count(*)::integer
        from player_pull_defensive_episode_evaluations s
        where s.defensive_generation_id = g.id
          and not exists (
            select 1
            from eligible e
            where e.pull_id = s.pull_id
              and e.player_name = s.player_name
          )
      ) as extra_staged_rows,
      (
        select count(*)::integer
        from player_pull_defensive_episode_evaluations s
        join eligible e
          on e.pull_id = s.pull_id
         and e.player_name = s.player_name
        where s.defensive_generation_id = g.id
          and (
            s.episode_evaluator_version is distinct from g.evaluator_version
            or s.semantic_version is distinct from g.semantic_version
            or s.semantic_resolver_version is distinct from g.semantic_resolver_version
            or s.resolver_version is distinct from g.resolver_version
          )
      ) as version_drift_rows,
      (select count(*)::integer from expected_keys) as expected_ledger_events,
      (select count(*)::integer from actual_keys) as actual_ledger_events,
      (
        select count(*)::integer
        from expected_keys k
        where not exists (
          select 1
          from actual_keys e
          where e.pull_id = k.pull_id
            and e.player_name = k.player_name
            and e.deduplication_key = k.deduplication_key
        )
      ) as missing_ledger_events,
      (
        select count(*)::integer
        from actual_keys e
        where not exists (
          select 1
          from expected_keys k
          where k.pull_id = e.pull_id
            and k.player_name = e.player_name
            and k.deduplication_key = e.deduplication_key
        )
      ) as orphan_ledger_events
  )
  select jsonb_build_object(
    'generationId', g.id,
    'gameBuild', g.game_build,
    'expectedPulls', m.expected_pulls,
    'stagedPulls', m.staged_pulls,
    'expectedPlayerRows', m.expected_player_rows,
    'safeStagedRows', m.safe_staged_rows,
    'missingPlayerRows', m.missing_player_rows,
    'extraStagedRows', m.extra_staged_rows,
    'versionDriftRows', m.version_drift_rows,
    'expectedLedgerEvents', m.expected_ledger_events,
    'actualLedgerEvents', m.actual_ledger_events,
    'missingLedgerEvents', m.missing_ledger_events,
    'orphanLedgerEvents', m.orphan_ledger_events,
    'complete',
      m.missing_player_rows = 0
      and m.extra_staged_rows = 0
      and m.version_drift_rows = 0
      and m.missing_ledger_events = 0
      and m.orphan_ledger_events = 0
      and m.expected_ledger_events = m.actual_ledger_events
  ) into result
  from metrics m;

  return result;
end;
$$;

revoke all on function public.defensive_generation_coverage(uuid)
  from public, anon, authenticated;
grant execute on function public.defensive_generation_coverage(uuid)
  to service_role;

comment on function public.defensive_generation_coverage(uuid) is
  'Cobertura canónica exhaustiva con snapshots materializados una vez por comprobación; contrato JSON compatible con el lifecycle v1.';
