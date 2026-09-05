-- Causalidad v3 · Hardening de publicación atómica por lote.
--
-- M19 declaró RETURNS TABLE (mechanic_key, policy_version). En PL/pgSQL esos
-- nombres también son variables OUT, por lo que el conflict target
-- ON CONFLICT (..., mechanic_key) quedaba ambiguo al ejecutar la sentencia.
-- Se conserva la firma pública, se dirige el UPSERT por la PK nominal y se
-- obliga a resolver como columnas cualquier futura colisión dentro de SQL.

create or replace function publish_mechanic_policy_batch(
  p_boss_id text,
  p_difficulty text,
  p_entries jsonb,
  p_changed_by uuid,
  p_reason text
)
returns table (mechanic_key text, policy_version integer)
language plpgsql
security definer
set search_path = public
as $function$
#variable_conflict use_column
declare
  v_entry jsonb;
  v_mechanic_key text;
  v_before_state jsonb;
  v_previous_version integer;
  v_created_by uuid;
  v_created_at timestamptz;
  v_after boss_mechanic_policy%rowtype;
begin
  if nullif(btrim(p_boss_id), '') is null then
    raise exception 'bossId es obligatorio';
  end if;
  if nullif(btrim(p_difficulty), '') is null then
    raise exception 'difficulty es obligatoria';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'reason es obligatorio';
  end if;
  if jsonb_typeof(p_entries) <> 'array' then
    raise exception 'entries debe ser un array JSON';
  end if;
  if jsonb_array_length(p_entries) = 0 or jsonb_array_length(p_entries) > 20 then
    raise exception 'el lote debe contener entre 1 y 20 policies';
  end if;

  for v_entry in select element.value from jsonb_array_elements(p_entries) as element(value)
  loop
    v_mechanic_key := nullif(btrim(v_entry->>'mechanic_key'), '');
    if v_mechanic_key is null then
      raise exception 'mechanic_key es obligatorio en todas las policies';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(p_boss_id || ':' || p_difficulty || ':' || v_mechanic_key, 0)
    );

    v_before_state := null;
    v_previous_version := null;
    v_created_by := null;
    v_created_at := null;
    select
      to_jsonb(policy_row),
      policy_row.policy_version,
      policy_row.created_by,
      policy_row.created_at
    into v_before_state, v_previous_version, v_created_by, v_created_at
    from boss_mechanic_policy as policy_row
    where policy_row.boss_id = p_boss_id
      and policy_row.difficulty = p_difficulty
      and policy_row.mechanic_key = v_mechanic_key
    for update;

    insert into boss_mechanic_policy (
      boss_id,
      difficulty,
      mechanic_key,
      policy_version,
      display_name,
      display_category,
      targeting_mode,
      required_response,
      responsibility_mode,
      damage_semantics,
      failure_propagation,
      assignment_mode,
      defensive_expectation,
      credit_scope,
      penalty_scope,
      causal_rule,
      confidence,
      provenance,
      verified_at,
      reviewed_by,
      created_by,
      created_at,
      updated_at
    ) values (
      p_boss_id,
      p_difficulty,
      v_mechanic_key,
      coalesce(v_previous_version, 0) + 1,
      coalesce(nullif(btrim(v_entry->>'display_name'), ''), v_mechanic_key),
      nullif(v_entry->>'display_category', ''),
      v_entry->>'targeting_mode',
      nullif(btrim(v_entry->>'required_response'), ''),
      v_entry->>'responsibility_mode',
      v_entry->>'damage_semantics',
      v_entry->>'failure_propagation',
      v_entry->>'assignment_mode',
      v_entry->>'defensive_expectation',
      v_entry->>'credit_scope',
      v_entry->>'penalty_scope',
      coalesce(v_entry->'causal_rule', '{}'::jsonb),
      v_entry->>'confidence',
      coalesce(v_entry->'provenance', '{}'::jsonb),
      null,
      p_changed_by,
      coalesce(v_created_by, p_changed_by),
      coalesce(v_created_at, now()),
      now()
    )
    on conflict on constraint boss_mechanic_policy_pkey do update set
      policy_version = excluded.policy_version,
      display_name = excluded.display_name,
      display_category = excluded.display_category,
      targeting_mode = excluded.targeting_mode,
      required_response = excluded.required_response,
      responsibility_mode = excluded.responsibility_mode,
      damage_semantics = excluded.damage_semantics,
      failure_propagation = excluded.failure_propagation,
      assignment_mode = excluded.assignment_mode,
      defensive_expectation = excluded.defensive_expectation,
      credit_scope = excluded.credit_scope,
      penalty_scope = excluded.penalty_scope,
      causal_rule = excluded.causal_rule,
      confidence = excluded.confidence,
      provenance = excluded.provenance,
      verified_at = excluded.verified_at,
      reviewed_by = excluded.reviewed_by,
      updated_at = excluded.updated_at
    returning * into v_after;

    insert into boss_mechanic_policy_audit (
      boss_id,
      difficulty,
      mechanic_key,
      previous_policy_version,
      new_policy_version,
      before_state,
      after_state,
      reason,
      changed_by,
      changed_at
    ) values (
      p_boss_id,
      p_difficulty,
      v_mechanic_key,
      v_previous_version,
      v_after.policy_version,
      v_before_state,
      to_jsonb(v_after),
      p_reason,
      p_changed_by,
      v_after.updated_at
    );

    return query select v_after.mechanic_key, v_after.policy_version;
  end loop;
end;
$function$;

revoke all on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text)
  from public, anon, authenticated;
grant execute on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text)
  to service_role;

comment on function publish_mechanic_policy_batch(text, text, jsonb, uuid, text) is
  'Publica como máximo 20 policies de un único boss+dificultad con versionado, snapshot y auditoría atómicos; conflict target no ambiguo desde M20.';

-- Ejecuta la rama real INSERT/UPSERT/RETURN sobre una policy existente dentro
-- de un subbloque. La excepción centinela revierte policy, snapshot y audit;
-- cualquier error anterior (incluido 42702 ambiguous_column) aborta M20.
do $self_test$
declare
  v_sample boss_mechanic_policy%rowtype;
  v_call_completed boolean := false;
begin
  select policy_row.*
  into v_sample
  from boss_mechanic_policy as policy_row
  order by policy_row.updated_at desc, policy_row.mechanic_key
  limit 1;

  if not found then
    return;
  end if;

  begin
    perform *
    from publish_mechanic_policy_batch(
      v_sample.boss_id,
      v_sample.difficulty,
      jsonb_build_array(jsonb_build_object(
        'mechanic_key', v_sample.mechanic_key,
        'display_name', v_sample.display_name,
        'display_category', v_sample.display_category,
        'targeting_mode', v_sample.targeting_mode,
        'required_response', v_sample.required_response,
        'responsibility_mode', v_sample.responsibility_mode,
        'damage_semantics', v_sample.damage_semantics,
        'failure_propagation', v_sample.failure_propagation,
        'assignment_mode', v_sample.assignment_mode,
        'defensive_expectation', v_sample.defensive_expectation,
        'credit_scope', v_sample.credit_scope,
        'penalty_scope', v_sample.penalty_scope,
        'causal_rule', v_sample.causal_rule,
        'confidence', v_sample.confidence,
        'provenance', v_sample.provenance
      )),
      v_sample.reviewed_by,
      'M20 transactional self-test; rolled back'
    );
    v_call_completed := true;
    raise exception 'publish_mechanic_policy_batch_self_test_rollback';
  exception
    when raise_exception then
      if not v_call_completed then
        raise;
      end if;
  end;
end;
$self_test$;
