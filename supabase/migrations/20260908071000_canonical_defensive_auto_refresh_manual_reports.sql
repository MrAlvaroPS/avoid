-- Review pass #1: manually pasted WCL raid reports are not guaranteed to carry
-- reports.is_raid=true. The real ingestion contract is the presence of boss
-- report_encounters plus a cursor that reached the final encounter. Using the
-- metadata flag would reproduce the exact failure for TvZnzN16tKPdVp2D, which
-- has 21 boss encounters but reports.is_raid=false.

create or replace function canonical_defensive_report_ingestion_complete(p_report_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select
      r.last_processed_fight_id is not null
      and max(e.fight_id) is not null
      and r.last_processed_fight_id >= max(e.fight_id)
    from reports r
    left join report_encounters e on e.report_code = r.code
    where r.code = p_report_code
    group by r.last_processed_fight_id
  ), false);
$$;

revoke all on function canonical_defensive_report_ingestion_complete(text) from public, anon, authenticated;
grant execute on function canonical_defensive_report_ingestion_complete(text) to service_role;

create or replace function trigger_canonical_defensive_refresh_from_report()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.last_processed_fight_id is not null then
    perform maybe_enqueue_canonical_defensive_refresh(new.code);
  end if;
  return new;
end;
$$;

-- Re-run the idempotent backfill under the corrected completion predicate so
-- already-imported manual reports are not left behind until a future write.
insert into canonical_defensive_refresh_requests (report_code, status, requested_at, not_before, updated_at)
select r.code, 'pending', now(), now(), now()
from reports r
where canonical_defensive_report_needs_refresh(r.code)
on conflict (report_code) do update
set status = case
      when canonical_defensive_refresh_requests.status = 'running'
        and canonical_defensive_refresh_requests.lease_expires_at > now()
        then 'running'
      else 'pending'
    end,
    requested_at = now(),
    not_before = now(),
    completed_at = null,
    last_error = null,
    updated_at = now();
