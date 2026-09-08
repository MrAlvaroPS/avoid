-- Recovery hardening for the canonical defensive auto-refresh dispatcher.
--
-- Empirical production failure on 2026-09-08: TvZnzN16tKPdVp2D reached a
-- COMPLETE BUILDING generation (1745/1745 player rows, 3016/3016 ledger
-- events) but the final canonical worker invocation returned HTTP 500. The
-- generic retry path retried five times and finally marked the request
-- blocked, leaving the old generation published even though the child was
-- already safe to publish.
--
-- The database lifecycle is the publication authority. If an active request
-- fails after its bound BUILDING generation is already exhaustively complete,
-- recover by publishing that generation through the existing guarded RPC
-- instead of consuming retry budget. Incomplete generations keep the original
-- bounded retry/block behavior.

create or replace function fail_canonical_defensive_refresh_request(
  p_report_code text,
  p_lease_token uuid,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  current_attempts integer;
  current_generation_id uuid;
  retry_after_seconds integer;
  will_retry boolean;
  generation_coverage jsonb;
  published_result jsonb;
begin
  select attempts, generation_id
    into current_attempts, current_generation_id
  from canonical_defensive_refresh_requests
  where report_code = p_report_code
    and lease_token = p_lease_token
    and status = 'running'
  for update;

  if current_attempts is null then
    return jsonb_build_object(
      'retryScheduled', false,
      'retryAfterSeconds', 0,
      'staleLease', true,
      'recoveredPublished', false
    );
  end if;

  -- Fail-safe publication recovery. This does NOT weaken publication rules:
  -- defensive_generation_coverage is exhaustive and
  -- publish_complete_defensive_generation re-runs assert completeness plus
  -- the pointer/status guards atomically.
  if current_generation_id is not null
     and exists (
       select 1
       from defensive_generations g
       where g.id = current_generation_id
         and g.status = 'building'
     ) then
    begin
      generation_coverage := defensive_generation_coverage(current_generation_id);
      if coalesce((generation_coverage ->> 'complete')::boolean, false) then
        published_result := publish_complete_defensive_generation(current_generation_id);

        update canonical_defensive_refresh_requests
        set status = 'completed',
            completed_at = coalesce(completed_at, now()),
            last_error = left(
              'Recovered after worker failure: ' || coalesce(p_error, 'canonical refresh failed'),
              4000
            ),
            lease_token = null,
            lease_expires_at = null,
            generation_id = current_generation_id,
            updated_at = now()
        where report_code = p_report_code
          and lease_token = p_lease_token
          and status = 'running';

        update canonical_defensive_refresh_dispatch_runtime
        set lease_token = null,
            lease_report_code = null,
            lease_generation_id = null,
            lease_expires_at = null,
            updated_at = now()
        where id = true
          and lease_token = p_lease_token;

        return jsonb_build_object(
          'retryScheduled', false,
          'retryAfterSeconds', 0,
          'staleLease', false,
          'recoveredPublished', true,
          'generationId', current_generation_id,
          'coverage', generation_coverage,
          'publication', published_result
        );
      end if;
    exception when others then
      -- A recovery publication failure must never hide the original failure
      -- or bypass the bounded retry path. Preserve both diagnostics.
      p_error := concat(
        coalesce(p_error, 'canonical refresh failed'),
        ' | complete-generation recovery failed: ',
        sqlerrm
      );
    end;
  end if;

  will_retry := current_attempts < 5;
  retry_after_seconds := least(60, greatest(2, (power(2, current_attempts)::integer) * 2));

  update canonical_defensive_refresh_requests
  set status = case when will_retry then 'pending' else 'blocked' end,
      not_before = case
        when will_retry then now() + make_interval(secs => retry_after_seconds)
        else not_before
      end,
      last_error = left(coalesce(p_error, 'canonical refresh failed'), 4000),
      lease_token = null,
      lease_expires_at = null,
      generation_id = null,
      updated_at = now()
  where report_code = p_report_code;

  update canonical_defensive_refresh_dispatch_runtime
  set lease_token = null,
      lease_report_code = null,
      lease_generation_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = true
    and lease_token = p_lease_token;

  return jsonb_build_object(
    'retryScheduled', will_retry,
    'retryAfterSeconds', case when will_retry then retry_after_seconds else 0 end,
    'staleLease', false,
    'recoveredPublished', false
  );
end;
$$;

revoke all on function fail_canonical_defensive_refresh_request(text, uuid, text)
from public, anon, authenticated;
grant execute on function fail_canonical_defensive_refresh_request(text, uuid, text)
to service_role;
