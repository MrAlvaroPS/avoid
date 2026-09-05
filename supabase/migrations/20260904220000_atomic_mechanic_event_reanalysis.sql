-- Reanálisis histórico de pull_mechanic_events.
--
-- El cálculo nuevo se hace fuera de PostgreSQL porque necesita volver a WCL,
-- pero el reemplazo del materializado debe ser atómico: nunca queremos un
-- pull sin mecánicas porque la petición falló entre DELETE e INSERT.
--
-- La función ignora cualquier pull_id que pueda venir dentro del JSON y usa
-- exclusivamente p_pull_id. También bumpea pulls.updated_at en la MISMA
-- transacción para invalidar NightPlayerSummary/Roster/NightScore caches.

create or replace function public.replace_pull_mechanic_events(
  p_pull_id uuid,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
begin
  if p_pull_id is null then
    raise exception 'p_pull_id no puede ser null';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows debe ser un array JSON';
  end if;
  if not exists (select 1 from public.pulls where id = p_pull_id) then
    raise exception 'Pull % no encontrado', p_pull_id;
  end if;

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
    row.ability_id,
    row.mechanic_name,
    row.description,
    row.category,
    row.responsibility,
    row.trigger_time_ms,
    row.outcome,
    coalesce(row.players_hit, 0),
    coalesce(row.players_hit_names, array[]::text[]),
    row.avoidable,
    coalesce(row.player_hit_details, '[]'::jsonb),
    row.phase_id,
    row.comparison_source,
    row.comparison_percentile
  from jsonb_to_recordset(p_rows) as row(
    ability_id bigint,
    mechanic_name text,
    description text,
    category text,
    responsibility text,
    trigger_time_ms integer,
    outcome text,
    players_hit integer,
    players_hit_names text[],
    avoidable boolean,
    player_hit_details jsonb,
    phase_id integer,
    comparison_source text,
    comparison_percentile numeric
  );

  get diagnostics v_inserted = row_count;

  update public.pulls
  set updated_at = now()
  where id = p_pull_id;

  return v_inserted;
end;
$$;

comment on function public.replace_pull_mechanic_events(uuid, jsonb) is
  'Reemplaza atómicamente todas las pull_mechanic_events de un pull y actualiza pulls.updated_at. Usada por reanalyze-mechanic-events; cualquier error en INSERT revierte también el DELETE.';

revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from public;
revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from anon;
revoke all on function public.replace_pull_mechanic_events(uuid, jsonb) from authenticated;
grant execute on function public.replace_pull_mechanic_events(uuid, jsonb) to service_role;
