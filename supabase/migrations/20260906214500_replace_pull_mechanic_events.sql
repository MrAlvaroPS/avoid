-- Atomic replacement primitive for replaying historical pull_mechanic_events.
-- The caller supplies rows produced by the SAME buildMechanicEventRows() helper
-- used by analyze-report. DELETE + INSERT live in one PostgreSQL transaction:
-- if any replacement row is invalid, the previous evidence is preserved.

create or replace function public.replace_pull_mechanic_events(
  p_pull_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
  v_inserted integer := 0;
  v_exists boolean := false;
begin
  if p_pull_id is null then
    raise exception 'p_pull_id is required';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  -- Serialize replay against any concurrent mutation of this pull.
  select true
    into v_exists
    from public.pulls
   where id = p_pull_id
   for update;

  if not coalesce(v_exists, false) then
    raise exception 'pull % not found', p_pull_id;
  end if;

  select count(*)::integer
    into v_deleted
    from public.pull_mechanic_events
   where pull_id = p_pull_id;

  delete from public.pull_mechanic_events
   where pull_id = p_pull_id;

  insert into public.pull_mechanic_events (
    pull_id,
    ability_id,
    mechanic_name,
    description,
    category,
    responsibility,
    trigger_time_ms,
    outcome,
    players_hit,
    players_hit_names,
    avoidable,
    player_hit_details,
    phase_id,
    comparison_source,
    comparison_percentile
  )
  select
    p_pull_id,
    (row_data ->> 'ability_id')::bigint,
    row_data ->> 'mechanic_name',
    row_data ->> 'description',
    row_data ->> 'category',
    row_data ->> 'responsibility',
    (row_data ->> 'trigger_time_ms')::integer,
    row_data ->> 'outcome',
    coalesce((row_data ->> 'players_hit')::integer, 0),
    array(
      select jsonb_array_elements_text(
        case
          when jsonb_typeof(row_data -> 'players_hit_names') = 'array'
            then row_data -> 'players_hit_names'
          else '[]'::jsonb
        end
      )
    ),
    case
      when row_data ? 'avoidable' and jsonb_typeof(row_data -> 'avoidable') <> 'null'
        then (row_data ->> 'avoidable')::boolean
      else null
    end,
    case
      when jsonb_typeof(row_data -> 'player_hit_details') = 'array'
        then row_data -> 'player_hit_details'
      else '[]'::jsonb
    end,
    case
      when row_data ? 'phase_id' and jsonb_typeof(row_data -> 'phase_id') <> 'null'
        then (row_data ->> 'phase_id')::integer
      else null
    end,
    row_data ->> 'comparison_source',
    case
      when row_data ? 'comparison_percentile' and jsonb_typeof(row_data -> 'comparison_percentile') <> 'null'
        then (row_data ->> 'comparison_percentile')::numeric
      else null
    end
  from jsonb_array_elements(p_rows) as rows(row_data);

  get diagnostics v_inserted = row_count;

  update public.pulls
     set updated_at = now()
   where id = p_pull_id;

  return jsonb_build_object(
    'pullId', p_pull_id,
    'deleted', v_deleted,
    'inserted', v_inserted
  );
end;
$$;

revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from public;
revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from anon;
revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from authenticated;
grant execute on function public.replace_pull_mechanic_events(uuid, jsonb) to service_role;

comment on function public.replace_pull_mechanic_events(uuid, jsonb) is
  'Atomically replaces pull_mechanic_events for one pull with rows produced by the canonical materializer.';
