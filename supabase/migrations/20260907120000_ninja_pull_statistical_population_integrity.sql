-- IRIS ninja-pull statistical population integrity.
--
-- Regression fixed here: PullEvaluationContext v3 intentionally converted a
-- strict detectNinjaPull result into `probable + evaluationEligible=true`,
-- while the previous production contract auto-excluded the same short/low-
-- progress fights. Because WCL only lists actors that actually engage a fight,
-- those accidental pulls gave different players different denominators.
--
-- Invariants after this migration:
-- 1) a heuristic candidate that satisfies the strict detector contract is an
--    invalid statistical pull (`confirmed`, heuristic source, not evaluable);
-- 2) the authoritative PullEvaluationContext always projects to legacy
--    pulls.is_ninja_pull / ninja_pull_excluded, so consumers cannot diverge;
-- 3) a manual ninja decision can never be overwritten by an automatic write;
-- 4) historical auto-candidates are repaired only when the CURRENT strict
--    signals still qualify and there is no manual audit entry.

create or replace function public.ninja_pull_auto_excludable(
  p_duration_ms integer,
  p_signals jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_duration integer := p_duration_ms;
  v_engaged_fraction numeric := null;
  v_boss_health_pct numeric := null;
begin
  if p_signals is not null and jsonb_typeof(p_signals) = 'object' then
    if jsonb_typeof(p_signals -> 'durationMs') = 'number' then
      v_duration := (p_signals ->> 'durationMs')::integer;
    end if;
    if jsonb_typeof(p_signals -> 'engagedFraction') = 'number' then
      v_engaged_fraction := (p_signals ->> 'engagedFraction')::numeric;
    end if;
    if jsonb_typeof(p_signals -> 'bossHealthPct') = 'number' then
      v_boss_health_pct := (p_signals ->> 'bossHealthPct')::numeric;
    end if;
  end if;

  -- Exact hard boundary used by detectNinjaPull. A detector result only
  -- exists for non-kills; the persisted signals are intentionally required
  -- for the two semantic checks so an old boolean alone can never exclude a
  -- pull retroactively.
  if v_duration is null or v_duration <= 0 or v_duration >= 45000 then
    return false;
  end if;

  return coalesce(v_engaged_fraction <= 0.30, false)
      or coalesce(v_boss_health_pct >= 90, false);
end;
$$;

revoke all on function public.ninja_pull_auto_excludable(integer, jsonb) from public, anon, authenticated;
grant execute on function public.ninja_pull_auto_excludable(integer, jsonb) to service_role;

comment on function public.ninja_pull_auto_excludable(integer, jsonb) is
  'Strict automatic invalid-pull policy: duration <45s and either engagedFraction <=0.30 or bossHealthPct >=90. Requires persisted evidence; is_ninja_pull alone is never enough.';

create or replace function public.normalize_pull_evaluation_ninja_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_duration integer;
  v_pull_signals jsonb;
  v_signals jsonb;
begin
  -- Manual is authoritative. An automatic reanalysis must fail loudly rather
  -- than silently reverting a raid-leader correction.
  if tg_op = 'UPDATE'
     and old.ninja_source = 'manual'
     and new.ninja_source <> 'manual' then
    raise exception 'Automatic ninja decision cannot overwrite manual decision for pull %', new.pull_id
      using errcode = '55000';
  end if;

  select p.duration_ms, p.ninja_pull_signals
    into v_duration, v_pull_signals
  from public.pulls p
  where p.id = new.pull_id;

  v_signals := coalesce(
    new.evidence #> '{ninjaPullCandidate,evidence}',
    new.evidence -> 'ninjaPullSignals',
    v_pull_signals,
    '{}'::jsonb
  );

  if new.ninja_source = 'heuristic'
     and new.ninja_status = 'probable'
     and public.ninja_pull_auto_excludable(v_duration, v_signals) then
    new.evaluation_eligible := false;
    new.evaluation_start_ms := 0;
    new.evaluation_end_ms := greatest(coalesce(v_duration, new.evaluation_end_ms, 0), 0);
    new.cutoff_reason := 'invalid_pull';
    new.wipe_call_at_ms := null;
    new.wipe_call_boss_hp_pct := null;
    new.wipe_call_source := 'none';
    new.wipe_call_confidence := null;
    new.wipe_call_verified := false;
    new.ninja_status := 'confirmed';
    -- Keep source=heuristic: `confirmed` describes statistical authority;
    -- source tells us it was automatic and therefore remains reversible.
    new.evidence := jsonb_set(
      coalesce(new.evidence, '{}'::jsonb),
      '{autoNinjaPolicy}',
      jsonb_build_object(
        'version', 'ninja-auto-exclusion@1',
        'applied', true,
        'signals', v_signals
      ),
      true
    );
  end if;

  return new;
end;
$$;

revoke all on function public.normalize_pull_evaluation_ninja_policy() from public, anon, authenticated;

drop trigger if exists pull_evaluation_context_normalize_ninja_policy on public.pull_evaluation_context;
create trigger pull_evaluation_context_normalize_ninja_policy
before insert or update on public.pull_evaluation_context
for each row execute function public.normalize_pull_evaluation_ninja_policy();

-- PullEvaluationContext is the authority; legacy flags are projections. This
-- trigger also makes direct/old write paths unable to diverge after context
-- exists. It deliberately runs only when either legacy ninja flag is being
-- written, which is the path used by set_pull_evaluation_context_v2.
create or replace function public.enforce_pull_ninja_projection_from_context()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_context public.pull_evaluation_context%rowtype;
begin
  select * into v_context
  from public.pull_evaluation_context c
  where c.pull_id = new.id;

  if found then
    new.is_ninja_pull := v_context.ninja_status in ('probable', 'confirmed');
    new.ninja_pull_excluded := (not v_context.evaluation_eligible)
      or v_context.ninja_status = 'confirmed';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_pull_ninja_projection_from_context() from public, anon, authenticated;

drop trigger if exists pulls_enforce_ninja_context_projection on public.pulls;
create trigger pulls_enforce_ninja_context_projection
before update of is_ninja_pull, ninja_pull_excluded on public.pulls
for each row execute function public.enforce_pull_ninja_projection_from_context();

-- Repair historical v3 regressions through the official audited RPC instead
-- of mutating the two authorities independently. We deliberately DO NOT use
-- `is_ninja_pull=true` as evidence. The candidate has to satisfy today's
-- strict signal contract, and any recorded manual decision protects the row.
do $$
declare
  r public.pull_evaluation_context%rowtype;
  v_signals jsonb;
begin
  for r in
    select c.*
    from public.pull_evaluation_context c
    join public.pulls p on p.id = c.pull_id
    where c.ninja_source = 'heuristic'
      and c.ninja_status = 'probable'
      and c.evaluation_eligible = true
      and public.ninja_pull_auto_excludable(
        p.duration_ms,
        coalesce(
          c.evidence #> '{ninjaPullCandidate,evidence}',
          c.evidence -> 'ninjaPullSignals',
          p.ninja_pull_signals,
          '{}'::jsonb
        )
      )
      and not exists (
        select 1
        from public.pull_evaluation_context_audit a
        where a.pull_id = c.pull_id
          and a.change_source = 'manual_rl'
      )
  loop
    perform public.set_pull_evaluation_context_v2(
      r.pull_id,
      r.evaluation_eligible,
      r.evaluation_start_ms,
      r.evaluation_end_ms,
      r.cutoff_reason,
      r.wipe_call_at_ms,
      r.wipe_call_boss_hp_pct,
      r.wipe_call_source,
      r.wipe_call_confidence,
      r.wipe_call_verified,
      r.ninja_status,
      r.ninja_source,
      r.ninja_confidence,
      r.evidence,
      'pull-evaluation-context@1.0.0:commands-v3',
      'Migración: candidato ninja estricto autoexcluido de la población estadística.',
      null
    );
  end loop;

  if exists (
    select 1
    from public.pull_evaluation_context c
    join public.pulls p on p.id = c.pull_id
    where c.ninja_source = 'heuristic'
      and c.ninja_status = 'probable'
      and c.evaluation_eligible = true
      and public.ninja_pull_auto_excludable(
        p.duration_ms,
        coalesce(
          c.evidence #> '{ninjaPullCandidate,evidence}',
          c.evidence -> 'ninjaPullSignals',
          p.ninja_pull_signals,
          '{}'::jsonb
        )
      )
      and not exists (
        select 1
        from public.pull_evaluation_context_audit a
        where a.pull_id = c.pull_id
          and a.change_source = 'manual_rl'
      )
  ) then
    raise exception 'Ninja population backfill left auto-excludable probable pulls behind';
  end if;
end;
$$;

comment on trigger pull_evaluation_context_normalize_ninja_policy on public.pull_evaluation_context is
  'Auto-confirms strict heuristic ninja candidates while refusing automatic overwrites of manual ninja decisions.';
comment on trigger pulls_enforce_ninja_context_projection on public.pulls is
  'Makes legacy ninja flags a projection of authoritative pull_evaluation_context whenever they are written.';
