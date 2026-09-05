


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."pull_defensive_plan_binding" (
    "pull_id" "uuid" NOT NULL,
    "plan_version_id" "uuid",
    "mode_at_pull" "text" NOT NULL,
    "binding_reason" "text" NOT NULL,
    "plan_published_at" timestamp with time zone,
    "manual_reason" "text",
    "bound_by" "uuid",
    "bound_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pull_defensive_plan_binding_binding_reason_check" CHECK (("binding_reason" = ANY (ARRAY['published_at_fight'::"text", 'manual'::"text", 'none_available'::"text"]))),
    CONSTRAINT "pull_defensive_plan_binding_check" CHECK (((("plan_version_id" IS NULL) AND ("mode_at_pull" = 'no_plan'::"text") AND ("binding_reason" = 'none_available'::"text") AND ("plan_published_at" IS NULL)) OR (("plan_version_id" IS NOT NULL) AND ("binding_reason" <> 'none_available'::"text") AND ("plan_published_at" IS NOT NULL)))),
    CONSTRAINT "pull_defensive_plan_binding_check1" CHECK (((("binding_reason" = 'manual'::"text") AND (NULLIF("btrim"("manual_reason"), ''::"text") IS NOT NULL)) OR (("binding_reason" <> 'manual'::"text") AND ("manual_reason" IS NULL)))),
    CONSTRAINT "pull_defensive_plan_binding_mode_at_pull_check" CHECK (("mode_at_pull" = ANY (ARRAY['full'::"text", 'partial'::"text", 'no_plan'::"text"])))
);


ALTER TABLE "public"."pull_defensive_plan_binding" OWNER TO "postgres";


COMMENT ON TABLE "public"."pull_defensive_plan_binding" IS 'Versión exacta desplegada para el pull. Una vez ligada no se sustituye silenciosamente.';



CREATE OR REPLACE FUNCTION "public"."bind_pull_to_current_defensive_plan"("p_pull_id" "uuid") RETURNS "public"."pull_defensive_plan_binding"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pull pulls;
  v_plan_id uuid;
  v_existing pull_defensive_plan_binding;
begin
  select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
  if found then return v_existing; end if;
  select * into v_pull from pulls where id = p_pull_id;
  if not found then raise exception 'Pull no encontrado.' using errcode = 'P0002'; end if;

  if v_pull.observed_at is null then
    insert into pull_defensive_plan_binding (
      pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
    ) values (p_pull_id, null, 'no_plan', 'none_available', null, null, null)
    on conflict (pull_id) do nothing
    returning * into v_existing;
    if v_existing.pull_id is null then
      select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
    end if;
    return v_existing;
  end if;

  select id into v_plan_id
  from defensive_plan_versions
  where boss_id = v_pull.boss_id
    and difficulty = v_pull.difficulty
    and status = 'published'
    and published_at <= v_pull.observed_at
    and (
      game_build is null
      or exists (
        select 1 from player_pull_records record
        where record.pull_id = v_pull.id and record.game_build = defensive_plan_versions.game_build
      )
    )
  order by published_at desc, id
  limit 1;
  if v_plan_id is null then
    insert into pull_defensive_plan_binding (
      pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
    ) values (p_pull_id, null, 'no_plan', 'none_available', null, null, null)
    on conflict (pull_id) do nothing
    returning * into v_existing;
    if v_existing.pull_id is null then
      select * into v_existing from pull_defensive_plan_binding where pull_id = p_pull_id;
    end if;
    return v_existing;
  end if;
  return bind_pull_to_defensive_plan(p_pull_id, v_plan_id, 'published_at_fight', null, null);
end;
$$;


ALTER FUNCTION "public"."bind_pull_to_current_defensive_plan"("p_pull_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bind_pull_to_defensive_plan"("p_pull_id" "uuid", "p_plan_version_id" "uuid", "p_binding_reason" "text" DEFAULT 'manual'::"text", "p_bound_by" "uuid" DEFAULT NULL::"uuid", "p_manual_reason" "text" DEFAULT NULL::"text") RETURNS "public"."pull_defensive_plan_binding"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pull pulls;
  v_plan defensive_plan_versions;
  v_binding pull_defensive_plan_binding;
begin
  select * into v_pull from pulls where id = p_pull_id for update;
  if not found then raise exception 'Pull no encontrado.' using errcode = 'P0002'; end if;
  select * into v_plan from defensive_plan_versions where id = p_plan_version_id;
  if not found or v_plan.status <> 'published' then
    raise exception 'Solo se puede desplegar un plan publicado.' using errcode = '23514';
  end if;
  if v_plan.boss_id <> v_pull.boss_id or v_plan.difficulty <> v_pull.difficulty then
    raise exception 'El plan no corresponde al boss y dificultad del pull.' using errcode = '23514';
  end if;
  if p_binding_reason not in ('published_at_fight', 'manual') then
    raise exception 'binding_reason inválido.' using errcode = '23514';
  end if;
  if p_binding_reason = 'manual' and nullif(btrim(p_manual_reason), '') is null then
    raise exception 'Un override manual exige motivo auditable.' using errcode = '23514';
  end if;

  insert into pull_defensive_plan_binding (
    pull_id, plan_version_id, mode_at_pull, binding_reason, plan_published_at, manual_reason, bound_by
  )
  values (
    p_pull_id, p_plan_version_id, v_plan.plan_mode, p_binding_reason, v_plan.published_at,
    case when p_binding_reason = 'manual' then btrim(p_manual_reason) else null end,
    p_bound_by
  )
  on conflict (pull_id) do nothing
  returning * into v_binding;

  if v_binding.pull_id is null then
    select * into v_binding from pull_defensive_plan_binding where pull_id = p_pull_id;
    if v_binding.plan_version_id is not distinct from p_plan_version_id then return v_binding; end if;
    if p_binding_reason <> 'manual' then
      raise exception 'El pull ya tiene binding; no se reinterpreta automáticamente.' using errcode = '55000';
    end if;
    insert into pull_defensive_plan_binding_audit (
      pull_id, previous_plan_version_id, new_plan_version_id, previous_mode, new_mode, reason, changed_by
    ) values (
      p_pull_id, v_binding.plan_version_id, p_plan_version_id, v_binding.mode_at_pull, v_plan.plan_mode,
      btrim(p_manual_reason), p_bound_by
    );
    update pull_defensive_plan_binding
    set plan_version_id = p_plan_version_id,
        mode_at_pull = v_plan.plan_mode,
        binding_reason = 'manual',
        plan_published_at = v_plan.published_at,
        manual_reason = btrim(p_manual_reason),
        bound_by = p_bound_by,
        bound_at = now()
    where pull_id = p_pull_id
    returning * into v_binding;
  end if;
  return v_binding;
end;
$$;


ALTER FUNCTION "public"."bind_pull_to_defensive_plan"("p_pull_id" "uuid", "p_plan_version_id" "uuid", "p_binding_reason" "text", "p_bound_by" "uuid", "p_manual_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."combat_evaluation_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "job_type" "text" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "attempts" smallint DEFAULT 0 NOT NULL,
    "max_attempts" smallint DEFAULT 3 NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "stage_progress" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_error" "text",
    "lease_token" "uuid",
    "claimed_at" timestamp with time zone,
    "lease_expires_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "combat_evaluation_jobs_attempts_check" CHECK (("attempts" >= 0)),
    CONSTRAINT "combat_evaluation_jobs_job_type_check" CHECK (("job_type" = ANY (ARRAY['pull_context'::"text", 'mechanic_policy'::"text", 'mechanic_assignment'::"text", 'consumable_policy'::"text", 'full_execution_backfill'::"text"]))),
    CONSTRAINT "combat_evaluation_jobs_max_attempts_check" CHECK ((("max_attempts" >= 1) AND ("max_attempts" <= 10))),
    CONSTRAINT "combat_evaluation_jobs_payload_check" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "combat_evaluation_jobs_stage_progress_check" CHECK (("jsonb_typeof"("stage_progress") = 'object'::"text")),
    CONSTRAINT "combat_evaluation_jobs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'done'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."combat_evaluation_jobs" OWNER TO "postgres";


COMMENT ON TABLE "public"."combat_evaluation_jobs" IS 'Cola causal genérica: una unidad idempotente por pull+tipo, lease recuperable y progreso por etapas.';



CREATE OR REPLACE FUNCTION "public"."claim_combat_evaluation_job"("p_job_type" "text" DEFAULT NULL::"text", "p_lease_seconds" integer DEFAULT 300) RETURNS "public"."combat_evaluation_jobs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare v_job combat_evaluation_jobs;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 900 then raise exception 'lease fuera de rango.' using errcode = '22023'; end if;
  select * into v_job from combat_evaluation_jobs
  where (p_job_type is null or job_type = p_job_type)
    and attempts < max_attempts
    and (status = 'queued' or (status = 'running' and lease_expires_at < now()))
  order by created_at for update skip locked limit 1;
  if not found then return null; end if;

  update combat_evaluation_jobs set status = 'running', attempts = attempts + 1,
    lease_token = gen_random_uuid(), claimed_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = v_job.id returning * into v_job;
  perform refresh_combat_evaluation_batch(v_job.batch_id);
  return v_job;
end;
$$;


ALTER FUNCTION "public"."claim_combat_evaluation_job"("p_job_type" "text", "p_lease_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."combat_evaluation_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."combat_evaluation_touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."defensive_plan_assert_draft"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_plan_id uuid;
  v_status text;
begin
  if tg_op = 'DELETE' then
    v_plan_id := old.plan_version_id;
  else
    v_plan_id := new.plan_version_id;
  end if;
  select status into v_status from defensive_plan_versions where id = v_plan_id for share;
  if v_status is distinct from 'draft' then
    raise exception 'El contenido de un plan publicado es inmutable.' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."defensive_plan_assert_draft"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."defensive_plan_assert_version_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' then
      raise exception 'Un plan publicado no se puede borrar.' using errcode = '55000';
    end if;
    return old;
  end if;
  if old.status = 'published' then
    raise exception 'Un plan publicado es inmutable.' using errcode = '55000';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."defensive_plan_assert_version_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_combat_evaluation_jobs"("p_pull_ids" "uuid"[], "p_job_type" "text", "p_reason" "text", "p_scope" "jsonb" DEFAULT '{}'::"jsonb", "p_payload" "jsonb" DEFAULT '{}'::"jsonb", "p_requested_by" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_batch_id uuid;
  v_pull_ids uuid[];
  v_old_batch_ids uuid[];
  v_old_batch_id uuid;
begin
  if p_job_type not in ('pull_context', 'mechanic_policy', 'mechanic_assignment', 'consumable_policy', 'full_execution_backfill') then
    raise exception 'job_type no soportado.' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason es obligatorio.' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_scope, '{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then
    raise exception 'scope y payload deben ser objetos JSON.' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct pull_id), '{}'::uuid[]) into v_pull_ids
  from unnest(coalesce(p_pull_ids, '{}'::uuid[])) as value(pull_id);
  if cardinality(v_pull_ids) = 0 then return null; end if;

  select coalesce(array_agg(distinct batch_id), '{}'::uuid[]) into v_old_batch_ids
  from combat_evaluation_jobs where pull_id = any(v_pull_ids) and job_type = p_job_type;

  insert into combat_evaluation_batches (reason, scope, total_jobs, created_by)
  values (btrim(p_reason), coalesce(p_scope, '{}'::jsonb), cardinality(v_pull_ids), p_requested_by)
  returning id into v_batch_id;

  insert into combat_evaluation_jobs (batch_id, pull_id, job_type, payload)
  select v_batch_id, pull_id, p_job_type, coalesce(p_payload, '{}'::jsonb)
  from unnest(v_pull_ids) as value(pull_id)
  on conflict (pull_id, job_type) do update set
    batch_id = excluded.batch_id,
    status = 'queued', attempts = 0, payload = excluded.payload,
    stage_progress = '{}'::jsonb, last_error = null, lease_token = null,
    claimed_at = null, lease_expires_at = null, finished_at = null, updated_at = now();

  foreach v_old_batch_id in array v_old_batch_ids loop
    if v_old_batch_id <> v_batch_id then perform refresh_combat_evaluation_batch(v_old_batch_id); end if;
  end loop;
  perform refresh_combat_evaluation_batch(v_batch_id);
  return v_batch_id;
end;
$$;


ALTER FUNCTION "public"."enqueue_combat_evaluation_jobs"("p_pull_ids" "uuid"[], "p_job_type" "text", "p_reason" "text", "p_scope" "jsonb", "p_payload" "jsonb", "p_requested_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_defensive_reanalysis_batch"("p_pull_ids" "uuid"[], "p_reason" "text", "p_scope" "jsonb" DEFAULT '{}'::"jsonb", "p_requested_by" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_batch_id uuid;
  v_pull_ids uuid[];
begin
  select coalesce(array_agg(distinct pull_id), '{}'::uuid[])
  into v_pull_ids
  from unnest(coalesce(p_pull_ids, '{}'::uuid[])) as value(pull_id);

  if cardinality(v_pull_ids) = 0 then
    return null;
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason is required';
  end if;
  if p_scope is null or jsonb_typeof(p_scope) <> 'object' then
    raise exception 'scope must be a JSON object';
  end if;

  insert into defensive_reanalysis_batches (reason, scope, total_jobs, created_by)
  values (p_reason, p_scope, cardinality(v_pull_ids), p_requested_by)
  returning id into v_batch_id;

  insert into defensive_reanalysis_jobs (batch_id, pull_id)
  select v_batch_id, pull_id
  from unnest(v_pull_ids) as value(pull_id);

  return v_batch_id;
end;
$$;


ALTER FUNCTION "public"."enqueue_defensive_reanalysis_batch"("p_pull_ids" "uuid"[], "p_reason" "text", "p_scope" "jsonb", "p_requested_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finish_combat_evaluation_job"("p_job_id" "uuid", "p_lease_token" "uuid", "p_succeeded" boolean, "p_stage_progress" "jsonb" DEFAULT '{}'::"jsonb", "p_error" "text" DEFAULT NULL::"text") RETURNS "public"."combat_evaluation_jobs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_job combat_evaluation_jobs;
begin
  update combat_evaluation_jobs set
    status = case when p_succeeded then 'done' else 'error' end,
    stage_progress = coalesce(p_stage_progress, '{}'::jsonb),
    last_error = case when p_succeeded then null else left(coalesce(p_error, 'Error sin detalle.'), 4000) end,
    finished_at = now(), lease_expires_at = null, updated_at = now()
  where id = p_job_id and status = 'running' and lease_token = p_lease_token
  returning * into v_job;
  if not found then raise exception 'Lease inválido o job no ejecutable.' using errcode = '55000'; end if;
  perform refresh_combat_evaluation_batch(v_job.batch_id);
  return v_job;
end;
$$;


ALTER FUNCTION "public"."finish_combat_evaluation_job"("p_job_id" "uuid", "p_lease_token" "uuid", "p_succeeded" boolean, "p_stage_progress" "jsonb", "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_officer"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (select is_officer from user_profiles where user_id = auth.uid()),
    false
  );
$$;


ALTER FUNCTION "public"."is_officer"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."keep_defensive_reference_material_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if tg_table_name = 'defensive_spec_profiles' then
    if (new.base_cooldown_ms, new.base_duration_ms, new.charges)
       is distinct from
       (old.base_cooldown_ms, old.base_duration_ms, old.charges) then
      new.updated_at = now();
    else
      new.updated_at = old.updated_at;
    end if;
  elsif tg_table_name = 'defensive_modifier_rules' then
    if (new.specs, new.modifier_spell_id, new.target_spell_id, new.operation, new.value, new.per_rank, new.condition, new.active)
       is distinct from
       (old.specs, old.modifier_spell_id, old.target_spell_id, old.operation, old.value, old.per_rank, old.condition, old.active) then
      new.updated_at = now();
    else
      new.updated_at = old.updated_at;
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."keep_defensive_reference_material_timestamp"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."defensive_plan_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "plan_mode" "text" NOT NULL,
    "planning_quality" "text" NOT NULL,
    "game_build" "text",
    "solver_version" "text" NOT NULL,
    "resolver_version" "text" NOT NULL,
    "backend_resolved" boolean DEFAULT false NOT NULL,
    "roster_fingerprint" "text",
    "source_profile_revision" timestamp with time zone,
    "source_catalog_revision" timestamp with time zone,
    "supersedes_id" "uuid",
    "uncertainty_margin_ms" integer DEFAULT 0 NOT NULL,
    "fallback_used" boolean DEFAULT false NOT NULL,
    "roster_snapshot_at" timestamp with time zone NOT NULL,
    "diagnostics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "content_fingerprint" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "published_by" "uuid",
    "published_at" timestamp with time zone,
    "notes" "text",
    CONSTRAINT "defensive_plan_versions_check" CHECK (((("status" = 'draft'::"text") AND ("published_at" IS NULL)) OR (("status" = 'published'::"text") AND ("published_at" IS NOT NULL)))),
    CONSTRAINT "defensive_plan_versions_diagnostics_check" CHECK (("jsonb_typeof"("diagnostics") = 'object'::"text")),
    CONSTRAINT "defensive_plan_versions_plan_mode_check" CHECK (("plan_mode" = ANY (ARRAY['full'::"text", 'partial'::"text", 'no_plan'::"text"]))),
    CONSTRAINT "defensive_plan_versions_planning_quality_check" CHECK (("planning_quality" = ANY (ARRAY['optimal'::"text", 'fallback_greedy'::"text", 'manual'::"text"]))),
    CONSTRAINT "defensive_plan_versions_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text"]))),
    CONSTRAINT "defensive_plan_versions_uncertainty_margin_ms_check" CHECK (("uncertainty_margin_ms" >= 0))
);


ALTER TABLE "public"."defensive_plan_versions" OWNER TO "postgres";


COMMENT ON TABLE "public"."defensive_plan_versions" IS 'Cada ejecución crea una versión. Publicar la vuelve inmutable; una corrección crea otra versión.';



CREATE OR REPLACE FUNCTION "public"."publish_defensive_plan"("p_plan_version_id" "uuid", "p_published_by" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."defensive_plan_versions"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_plan defensive_plan_versions;
  v_uncovered integer;
  v_assigned integer;
  v_fingerprint text;
  v_current_profile_revision timestamptz;
  v_current_catalog_revision timestamptz;
begin
  select * into v_plan from defensive_plan_versions where id = p_plan_version_id for update;
  if not found then raise exception 'Plan no encontrado.' using errcode = 'P0002'; end if;
  if v_plan.status <> 'draft' then raise exception 'El plan ya está publicado.' using errcode = '55000'; end if;
  if not v_plan.backend_resolved then
    raise exception 'El draft no fue resuelto por backend y no se puede publicar.' using errcode = '23514';
  end if;

  select max(revision) into v_current_profile_revision
  from (
    select max(updated_at) as revision from boss_mechanic_occurrence_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
    union all
    select max(updated_at) from boss_mechanic_defensive_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
    union all
    select max(updated_at) from boss_mechanic_defensive_local_profile where boss_id = v_plan.boss_id and difficulty = v_plan.difficulty
  ) revisions;
  if v_plan.source_profile_revision is null or (v_current_profile_revision is not null and v_plan.source_profile_revision < v_current_profile_revision) then
    raise exception 'El perfil de mecánicas cambió; recalcula un draft antes de publicar.' using errcode = '55000';
  end if;

  select max(revision) into v_current_catalog_revision
  from (
    select max(updated_at) as revision from cooldown_catalog
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from defensive_spec_profiles
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from defensive_modifier_rules
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
    union all
    select max(updated_at) from player_defensive_overrides
      where class in (select class from defensive_plan_members where plan_version_id = p_plan_version_id and included)
  ) revisions;
  if v_plan.source_catalog_revision is null or (v_current_catalog_revision is not null and v_plan.source_catalog_revision < v_current_catalog_revision) then
    raise exception 'El catálogo/reglas defensivas cambió; recalcula un draft antes de publicar.' using errcode = '55000';
  end if;

  select
    count(*) filter (where coverage_status in ('partial', 'uncovered')),
    count(*) filter (where assigned_player_key is not null)
  into v_uncovered, v_assigned
  from defensive_plan_slots
  where plan_version_id = p_plan_version_id;

  if v_plan.plan_mode = 'full' and (v_uncovered > 0 or v_assigned = 0) then
    raise exception 'Un plan full debe cubrir todos los slots y contener al menos una asignación.' using errcode = '23514';
  end if;
  if v_plan.plan_mode = 'no_plan' and v_assigned > 0 then
    raise exception 'Un plan no_plan no puede contener asignaciones.' using errcode = '23514';
  end if;

  select md5(
    to_jsonb(v_plan)::text || '|' ||
    coalesce((select jsonb_agg(to_jsonb(m) - 'created_at' order by m.player_key)::text
              from defensive_plan_members m where m.plan_version_id = p_plan_version_id), '[]') || '|' ||
    coalesce((select jsonb_agg(to_jsonb(s) - 'created_at' order by s.occurrence_time_ms, s.ability_id, s.occurrence_index, s.slot_index)::text
              from defensive_plan_slots s where s.plan_version_id = p_plan_version_id), '[]')
  ) into v_fingerprint;

  update defensive_plan_versions
  set status = 'published', published_at = now(), published_by = p_published_by, content_fingerprint = v_fingerprint
  where id = p_plan_version_id
  returning * into v_plan;
  return v_plan;
end;
$$;


ALTER FUNCTION "public"."publish_defensive_plan"("p_plan_version_id" "uuid", "p_published_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_pull_context_reanalysis"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_batch_id uuid;
  v_old_batch_id uuid;
begin
  select batch_id into v_old_batch_id
  from combat_evaluation_jobs
  where pull_id = new.pull_id and job_type = 'pull_context';
  insert into combat_evaluation_batches (reason, scope, total_jobs, created_by)
  values (
    'pull_evaluation_context_changed',
    jsonb_build_object('pullId', new.pull_id, 'resolverVersion', new.resolver_version),
    1,
    new.reviewed_by
  ) returning id into v_batch_id;

  insert into combat_evaluation_jobs (batch_id, pull_id, job_type, payload)
  values (
    v_batch_id,
    new.pull_id,
    'pull_context',
    jsonb_build_object('contextUpdatedAt', new.updated_at, 'contextResolverVersion', new.resolver_version)
  )
  on conflict (pull_id, job_type) do update set
    batch_id = excluded.batch_id, status = 'queued', attempts = 0,
    payload = excluded.payload, stage_progress = '{}'::jsonb, last_error = null,
    lease_token = null, claimed_at = null, lease_expires_at = null,
    finished_at = null, updated_at = now();
  if v_old_batch_id is not null and v_old_batch_id <> v_batch_id then
    perform refresh_combat_evaluation_batch(v_old_batch_id);
  end if;
  perform refresh_combat_evaluation_batch(v_batch_id);
  return new;
end;
$$;


ALTER FUNCTION "public"."queue_pull_context_reanalysis"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_combat_evaluation_batch"("p_batch_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_total integer;
  v_done integer;
  v_error integer;
  v_running integer;
begin
  select count(*), count(*) filter (where status = 'done'),
         count(*) filter (where status = 'error'), count(*) filter (where status = 'running')
  into v_total, v_done, v_error, v_running
  from combat_evaluation_jobs where batch_id = p_batch_id;

  update combat_evaluation_batches set
    total_jobs = v_total,
    completed_jobs = v_done,
    failed_jobs = v_error,
    status = case
      when v_total > 0 and v_done + v_error = v_total then case when v_error > 0 then 'completed_with_errors' else 'completed' end
      when v_running > 0 or v_done > 0 then 'running'
      else 'queued'
    end,
    started_at = case when (v_running > 0 or v_done > 0 or v_error > 0) then coalesce(started_at, now()) else started_at end,
    finished_at = case when v_total > 0 and v_done + v_error = v_total then coalesce(finished_at, now()) else null end,
    updated_at = now()
  where id = p_batch_id;
end;
$$;


ALTER FUNCTION "public"."refresh_combat_evaluation_batch"("p_batch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_defensive_plan_v2"("p_run" "jsonb", "p_assignments" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  new_plan_id uuid;
begin
  delete from defensive_plan_runs
  where boss_id = p_run->>'bossId'
    and difficulty = p_run->>'difficulty'
    and character_id = (p_run->>'characterId')::bigint;

  insert into defensive_plan_runs (
    boss_id, difficulty, character_id, player_name, class, spec,
    talent_spell_ids, loadout_hash, loadout_observed_at, catalog_version, mechanic_profile_version, generated_at
  ) values (
    p_run->>'bossId',
    p_run->>'difficulty',
    (p_run->>'characterId')::bigint,
    p_run->>'playerName',
    p_run->>'class',
    p_run->>'spec',
    array(select value::bigint from jsonb_array_elements_text(coalesce(p_run->'talentSpellIds', '[]'::jsonb))),
    p_run->>'loadoutHash',
    nullif(p_run->>'loadoutObservedAt', '')::timestamptz,
    nullif(p_run->>'catalogVersion', '')::timestamptz,
    nullif(p_run->>'mechanicProfileVersion', '')::timestamptz,
    now()
  ) returning id into new_plan_id;

  insert into defensive_plan_assignments (
    plan_id, window_key, planned_time_ms, impact_score, priority,
    ability_ids, ability_names, primary_ability_id, occurrence_index,
    defensive_spell_id, effective_cooldown_ms, cooldown_explanation,
    prewarn_seconds, trigger_type, bossmod_spell_id, bossmod_counter, locked
  )
  select
    new_plan_id,
    item->>'windowKey',
    (item->>'plannedTimeMs')::integer,
    coalesce((item->>'impactScore')::numeric, 0),
    nullif(item->>'priority', '')::smallint,
    array(select value::bigint from jsonb_array_elements_text(item->'abilityIds')),
    array(select value from jsonb_array_elements_text(item->'abilityNames')),
    (item->>'primaryAbilityId')::bigint,
    (item->>'occurrenceIndex')::integer,
    (item->>'defensiveSpellId')::bigint,
    (item->>'effectiveCooldownMs')::integer,
    item->>'cooldownExplanation',
    coalesce((item->>'prewarnSeconds')::integer, 5),
    coalesce(item->>'triggerType', 'bossmod'),
    nullif(item->>'bossmodSpellId', '')::bigint,
    nullif(item->>'bossmodCounter', '')::integer,
    coalesce((item->>'locked')::boolean, false)
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) item;

  return new_plan_id;
end;
$$;


ALTER FUNCTION "public"."replace_defensive_plan_v2"("p_run" "jsonb", "p_assignments" "jsonb") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."player_defensive_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "character_id" bigint,
    "player_name" "text" NOT NULL,
    "class" "text" NOT NULL,
    "spec" "text",
    "spell_id" bigint NOT NULL,
    "build_fingerprint" "text",
    "game_build" "text" NOT NULL,
    "effective_cooldown_ms" integer,
    "effective_duration_ms" integer,
    "charges" smallint,
    "targeting_mode" "text",
    "reason" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "player_defensive_overrides_charges_check" CHECK ((("charges" IS NULL) OR ("charges" > 0))),
    CONSTRAINT "player_defensive_overrides_check" CHECK ((("effective_cooldown_ms" IS NOT NULL) OR ("effective_duration_ms" IS NOT NULL) OR ("charges" IS NOT NULL) OR ("targeting_mode" IS NOT NULL))),
    CONSTRAINT "player_defensive_overrides_class_check" CHECK (("btrim"("class") <> ''::"text")),
    CONSTRAINT "player_defensive_overrides_effective_cooldown_ms_check" CHECK ((("effective_cooldown_ms" IS NULL) OR ("effective_cooldown_ms" >= 0))),
    CONSTRAINT "player_defensive_overrides_effective_duration_ms_check" CHECK ((("effective_duration_ms" IS NULL) OR ("effective_duration_ms" >= 0))),
    CONSTRAINT "player_defensive_overrides_game_build_check" CHECK (("btrim"("game_build") <> ''::"text")),
    CONSTRAINT "player_defensive_overrides_player_name_check" CHECK (("btrim"("player_name") <> ''::"text")),
    CONSTRAINT "player_defensive_overrides_reason_check" CHECK (("btrim"("reason") <> ''::"text")),
    CONSTRAINT "player_defensive_overrides_targeting_mode_check" CHECK ((("targeting_mode" IS NULL) OR ("targeting_mode" = ANY (ARRAY['self'::"text", 'ally'::"text", 'both'::"text", 'raid'::"text", 'unknown'::"text"]))))
);


ALTER TABLE "public"."player_defensive_overrides" OWNER TO "postgres";


COMMENT ON TABLE "public"."player_defensive_overrides" IS 'Correcciones manuales de valores efectivos por jugador y game build. build_fingerprint null significa scope global explícito para los builds de ese jugador dentro del mismo game_build.';



COMMENT ON COLUMN "public"."player_defensive_overrides"."build_fingerprint" IS 'Scope exacto del build de talentos. Las filas legacy con null se conservan para auditoría/rollback, pero el resolver v2 no las aplica.';



COMMENT ON COLUMN "public"."player_defensive_overrides"."reason" IS 'Motivo auditable obligatorio. El resolver conserva además el valor automático anterior en provenance.';



CREATE OR REPLACE FUNCTION "public"."save_exact_player_defensive_override"("p_character_id" bigint, "p_player_name" "text", "p_class" "text", "p_spec" "text", "p_spell_id" bigint, "p_game_build" "text", "p_build_fingerprint" "text", "p_effective_cooldown_ms" integer, "p_effective_duration_ms" integer, "p_automatic_cooldown_ms" integer, "p_automatic_duration_ms" integer, "p_reason" "text", "p_changed_by" "uuid", "p_active" boolean DEFAULT true) RETURNS "public"."player_defensive_overrides"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
declare
  v_existing player_defensive_overrides;
  v_result player_defensive_overrides;
  v_action text;
begin
  if p_character_id is null or p_character_id <= 0 then raise exception 'character_id exacto obligatorio.' using errcode = '23514'; end if;
  if nullif(btrim(p_player_name), '') is null then raise exception 'player_name obligatorio.' using errcode = '23514'; end if;
  if nullif(btrim(p_class), '') is null then raise exception 'class obligatoria.' using errcode = '23514'; end if;
  if p_spell_id is null or p_spell_id <= 0 then raise exception 'spell_id inválido.' using errcode = '23514'; end if;
  if nullif(btrim(p_game_build), '') is null then raise exception 'game_build exacto obligatorio.' using errcode = '23514'; end if;
  if p_build_fingerprint !~ '^sha256:[a-f0-9]{64}$' then raise exception 'build_fingerprint exacto obligatorio.' using errcode = '23514'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Motivo auditable obligatorio.' using errcode = '23514'; end if;
  if p_active and p_effective_cooldown_ms is null and p_effective_duration_ms is null then
    raise exception 'Debe corregirse cooldown o duración.' using errcode = '23514';
  end if;
  if p_effective_cooldown_ms is not null and p_effective_cooldown_ms < 0 then raise exception 'Cooldown inválido.' using errcode = '23514'; end if;
  if p_effective_duration_ms is not null and p_effective_duration_ms < 0 then raise exception 'Duración inválida.' using errcode = '23514'; end if;

  select * into v_existing
  from player_defensive_overrides
  where active
    and character_id = p_character_id
    and class = btrim(p_class)
    and spec is not distinct from nullif(btrim(p_spec), '')
    and spell_id = p_spell_id
    and game_build = btrim(p_game_build)
    and build_fingerprint = p_build_fingerprint
  for update;

  if not p_active then
    if v_existing.id is null then raise exception 'No existe override exacto activo.' using errcode = 'P0002'; end if;
    update player_defensive_overrides
    set active = false, reason = btrim(p_reason), updated_by = p_changed_by, updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    v_action := 'deactivated';
  elsif v_existing.id is null then
    insert into player_defensive_overrides (
      character_id, player_name, class, spec, spell_id, build_fingerprint, game_build,
      effective_cooldown_ms, effective_duration_ms, reason, active, created_by, updated_by
    ) values (
      p_character_id, btrim(p_player_name), btrim(p_class), nullif(btrim(p_spec), ''), p_spell_id,
      p_build_fingerprint, btrim(p_game_build), p_effective_cooldown_ms,
      p_effective_duration_ms, btrim(p_reason), true, p_changed_by, p_changed_by
    ) returning * into v_result;
    v_action := 'created';
  else
    update player_defensive_overrides
    set effective_cooldown_ms = p_effective_cooldown_ms,
        effective_duration_ms = p_effective_duration_ms,
        reason = btrim(p_reason),
        updated_by = p_changed_by,
        updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    v_action := 'updated';
  end if;

  insert into player_defensive_override_audit (
    override_id, action, automatic_effective_cooldown_ms, automatic_effective_duration_ms,
    previous_override, resulting_override, reason, changed_by
  ) values (
    v_result.id, v_action, p_automatic_cooldown_ms, p_automatic_duration_ms,
    case when v_existing.id is null then null else to_jsonb(v_existing) end,
    to_jsonb(v_result), btrim(p_reason), p_changed_by
  );
  return v_result;
end;
$_$;


ALTER FUNCTION "public"."save_exact_player_defensive_override"("p_character_id" bigint, "p_player_name" "text", "p_class" "text", "p_spec" "text", "p_spell_id" bigint, "p_game_build" "text", "p_build_fingerprint" "text", "p_effective_cooldown_ms" integer, "p_effective_duration_ms" integer, "p_automatic_cooldown_ms" integer, "p_automatic_duration_ms" integer, "p_reason" "text", "p_changed_by" "uuid", "p_active" boolean) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pull_evaluation_context" (
    "pull_id" "uuid" NOT NULL,
    "evaluation_eligible" boolean DEFAULT true NOT NULL,
    "evaluation_start_ms" integer DEFAULT 0 NOT NULL,
    "evaluation_end_ms" integer NOT NULL,
    "cutoff_reason" "text" NOT NULL,
    "wipe_call_at_ms" integer,
    "wipe_call_boss_hp_pct" numeric,
    "wipe_call_source" "text" DEFAULT 'none'::"text" NOT NULL,
    "wipe_call_confidence" numeric,
    "wipe_call_verified" boolean DEFAULT false NOT NULL,
    "ninja_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "ninja_source" "text" DEFAULT 'imported'::"text" NOT NULL,
    "ninja_confidence" numeric,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "resolver_version" "text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "review_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pull_evaluation_context_check" CHECK (("evaluation_end_ms" >= "evaluation_start_ms")),
    CONSTRAINT "pull_evaluation_context_check1" CHECK (((("wipe_call_at_ms" IS NULL) AND ("wipe_call_source" = 'none'::"text")) OR (("wipe_call_at_ms" IS NOT NULL) AND ("wipe_call_source" <> 'none'::"text")))),
    CONSTRAINT "pull_evaluation_context_check2" CHECK (((NOT "wipe_call_verified") OR ("wipe_call_source" = ANY (ARRAY['manual_rl'::"text", 'instrumented'::"text"])))),
    CONSTRAINT "pull_evaluation_context_check3" CHECK ((("cutoff_reason" = 'wipe_call'::"text") = ("evaluation_eligible" AND ("wipe_call_at_ms" IS NOT NULL)))),
    CONSTRAINT "pull_evaluation_context_check4" CHECK ((("cutoff_reason" = 'invalid_pull'::"text") = (NOT "evaluation_eligible"))),
    CONSTRAINT "pull_evaluation_context_check5" CHECK ((("ninja_status" <> 'confirmed'::"text") OR (NOT "evaluation_eligible"))),
    CONSTRAINT "pull_evaluation_context_check6" CHECK (((("reviewed_by" IS NULL) AND ("reviewed_at" IS NULL) AND ("review_reason" IS NULL)) OR (("reviewed_at" IS NOT NULL) AND (NULLIF("btrim"("review_reason"), ''::"text") IS NOT NULL)))),
    CONSTRAINT "pull_evaluation_context_cutoff_reason_check" CHECK (("cutoff_reason" = ANY (ARRAY['fight_end'::"text", 'wipe_call'::"text", 'invalid_pull'::"text"]))),
    CONSTRAINT "pull_evaluation_context_evaluation_start_ms_check" CHECK (("evaluation_start_ms" >= 0)),
    CONSTRAINT "pull_evaluation_context_evidence_check" CHECK (("jsonb_typeof"("evidence") = 'object'::"text")),
    CONSTRAINT "pull_evaluation_context_ninja_confidence_check" CHECK ((("ninja_confidence" IS NULL) OR (("ninja_confidence" >= (0)::numeric) AND ("ninja_confidence" <= (100)::numeric)))),
    CONSTRAINT "pull_evaluation_context_ninja_source_check" CHECK (("ninja_source" = ANY (ARRAY['manual'::"text", 'heuristic'::"text", 'imported'::"text"]))),
    CONSTRAINT "pull_evaluation_context_ninja_status_check" CHECK (("ninja_status" = ANY (ARRAY['valid'::"text", 'probable'::"text", 'confirmed'::"text", 'unknown'::"text"]))),
    CONSTRAINT "pull_evaluation_context_resolver_version_check" CHECK ((NULLIF("btrim"("resolver_version"), ''::"text") IS NOT NULL)),
    CONSTRAINT "pull_evaluation_context_wipe_call_at_ms_check" CHECK ((("wipe_call_at_ms" IS NULL) OR ("wipe_call_at_ms" >= 0))),
    CONSTRAINT "pull_evaluation_context_wipe_call_boss_hp_pct_check" CHECK ((("wipe_call_boss_hp_pct" IS NULL) OR (("wipe_call_boss_hp_pct" >= (0)::numeric) AND ("wipe_call_boss_hp_pct" <= (100)::numeric)))),
    CONSTRAINT "pull_evaluation_context_wipe_call_confidence_check" CHECK ((("wipe_call_confidence" IS NULL) OR (("wipe_call_confidence" >= (0)::numeric) AND ("wipe_call_confidence" <= (100)::numeric)))),
    CONSTRAINT "pull_evaluation_context_wipe_call_source_check" CHECK (("wipe_call_source" = ANY (ARRAY['none'::"text", 'manual_rl'::"text", 'instrumented'::"text", 'inferred'::"text"])))
);


ALTER TABLE "public"."pull_evaluation_context" OWNER TO "postgres";


COMMENT ON TABLE "public"."pull_evaluation_context" IS 'Autoridad v3 del intervalo evaluable. Flags off mantienen consumidores legacy; la RPC proyecta cada cambio a pulls atómicamente.';



CREATE OR REPLACE FUNCTION "public"."set_pull_evaluation_context_v2"("p_pull_id" "uuid", "p_evaluation_eligible" boolean, "p_evaluation_start_ms" integer, "p_evaluation_end_ms" integer, "p_cutoff_reason" "text", "p_wipe_call_at_ms" integer, "p_wipe_call_boss_hp_pct" numeric, "p_wipe_call_source" "text", "p_wipe_call_confidence" numeric, "p_wipe_call_verified" boolean, "p_ninja_status" "text", "p_ninja_source" "text", "p_ninja_confidence" numeric, "p_evidence" "jsonb", "p_resolver_version" "text", "p_reason" "text", "p_changed_by" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."pull_evaluation_context"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pull pulls;
  v_before jsonb;
  v_after jsonb;
  v_context pull_evaluation_context;
  v_change_source text;
begin
  select * into v_pull from pulls where id = p_pull_id for update;
  if not found then raise exception 'Pull no encontrado.' using errcode = 'P0002'; end if;
  if p_evaluation_end_ms > greatest(coalesce(v_pull.duration_ms, 0), 0) then
    raise exception 'evaluation_end_ms no puede superar la duración del pull.' using errcode = '23514';
  end if;

  select to_jsonb(c) into v_before from pull_evaluation_context c where c.pull_id = p_pull_id;

  insert into pull_evaluation_context (
    pull_id, evaluation_eligible, evaluation_start_ms, evaluation_end_ms, cutoff_reason,
    wipe_call_at_ms, wipe_call_boss_hp_pct, wipe_call_source, wipe_call_confidence,
    wipe_call_verified, ninja_status, ninja_source, ninja_confidence, evidence,
    resolver_version, reviewed_by, reviewed_at, review_reason
  ) values (
    p_pull_id, p_evaluation_eligible, p_evaluation_start_ms, p_evaluation_end_ms, p_cutoff_reason,
    p_wipe_call_at_ms, p_wipe_call_boss_hp_pct, p_wipe_call_source, p_wipe_call_confidence,
    p_wipe_call_verified, p_ninja_status, p_ninja_source, p_ninja_confidence, coalesce(p_evidence, '{}'::jsonb),
    p_resolver_version,
    case when p_wipe_call_source in ('manual_rl', 'instrumented') or p_ninja_source = 'manual' then p_changed_by else null end,
    case when p_wipe_call_source in ('manual_rl', 'instrumented') or p_ninja_source = 'manual' then now() else null end,
    case when p_wipe_call_source in ('manual_rl', 'instrumented') or p_ninja_source = 'manual' then btrim(p_reason) else null end
  )
  on conflict (pull_id) do update set
    evaluation_eligible = excluded.evaluation_eligible,
    evaluation_start_ms = excluded.evaluation_start_ms,
    evaluation_end_ms = excluded.evaluation_end_ms,
    cutoff_reason = excluded.cutoff_reason,
    wipe_call_at_ms = excluded.wipe_call_at_ms,
    wipe_call_boss_hp_pct = excluded.wipe_call_boss_hp_pct,
    wipe_call_source = excluded.wipe_call_source,
    wipe_call_confidence = excluded.wipe_call_confidence,
    wipe_call_verified = excluded.wipe_call_verified,
    ninja_status = excluded.ninja_status,
    ninja_source = excluded.ninja_source,
    ninja_confidence = excluded.ninja_confidence,
    evidence = excluded.evidence,
    resolver_version = excluded.resolver_version,
    reviewed_by = excluded.reviewed_by,
    reviewed_at = excluded.reviewed_at,
    review_reason = excluded.review_reason
  returning * into v_context;

  v_after := to_jsonb(v_context);
  if v_before is distinct from v_after then
    v_change_source := case
      when p_wipe_call_source in ('manual_rl', 'instrumented') then p_wipe_call_source
      when p_ninja_source = 'manual' then 'manual_rl'
      when p_wipe_call_source = 'inferred' then 'inferred'
      when p_ninja_source = 'heuristic' then 'heuristic'
      else 'imported'
    end;
    insert into pull_evaluation_context_audit (
      pull_id, before_state, after_state, change_source, reason, resolver_version, changed_by
    ) values (
      p_pull_id, v_before, v_after, v_change_source, btrim(p_reason), p_resolver_version, p_changed_by
    );
  end if;

  update pulls
  set wipe_call_excluded = p_wipe_call_at_ms is not null,
      wipe_call_confidence = p_wipe_call_confidence,
      wipe_call_signals = case
        when p_wipe_call_at_ms is null then coalesce(wipe_call_signals, '{}'::jsonb) - 'wipeCallStartMs'
        else jsonb_set(coalesce(wipe_call_signals, '{}'::jsonb), '{wipeCallStartMs}', to_jsonb(p_wipe_call_at_ms), true)
      end,
      is_ninja_pull = p_ninja_status in ('probable', 'confirmed'),
      ninja_pull_excluded = not p_evaluation_eligible or p_ninja_status = 'confirmed',
      ninja_pull_signals = coalesce(p_evidence->'ninjaPullSignals', ninja_pull_signals),
      updated_at = now()
  where id = p_pull_id;

  -- Proyección legacy del mismo intervalo: una muerte solo pertenece al
  -- cierre si su timestamp está en [wipe_call_at_ms, fight_end). Esto evita
  -- que un límite manual nuevo dependa del cluster que propuso el sensor.
  update player_pull_records
  set wipe_call_cluster = case
    when p_wipe_call_at_ms is null then false
    when not died or death_cause is null or jsonb_typeof(death_cause->'timeMs') <> 'number' then false
    else (death_cause->>'timeMs')::numeric >= p_wipe_call_at_ms
  end
  where pull_id = p_pull_id;

  return v_context;
end;
$$;


ALTER FUNCTION "public"."set_pull_evaluation_context_v2"("p_pull_id" "uuid", "p_evaluation_eligible" boolean, "p_evaluation_start_ms" integer, "p_evaluation_end_ms" integer, "p_cutoff_reason" "text", "p_wipe_call_at_ms" integer, "p_wipe_call_boss_hp_pct" numeric, "p_wipe_call_source" "text", "p_wipe_call_confidence" numeric, "p_wipe_call_verified" boolean, "p_ninja_status" "text", "p_ninja_source" "text", "p_ninja_confidence" numeric, "p_evidence" "jsonb", "p_resolver_version" "text", "p_reason" "text", "p_changed_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snapshot_boss_mechanic_policy_version"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into boss_mechanic_policy_versions (
    boss_id, difficulty, mechanic_key, policy_version, snapshot, confidence,
    published_by, published_at
  ) values (
    new.boss_id, new.difficulty, new.mechanic_key, new.policy_version,
    to_jsonb(new), new.confidence, new.reviewed_by, new.updated_at
  ) on conflict (boss_id, difficulty, mechanic_key, policy_version) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."snapshot_boss_mechanic_policy_version"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."boss_mechanics_candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "ability_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "icon_url" "text",
    "sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "observed_in_logs" boolean DEFAULT false NOT NULL,
    "journal_encounter_id" bigint,
    "db2_difficulty_id" integer,
    "difficulty_mapping_status" "text",
    "category" "text",
    "avoidable" boolean,
    "expected_response" "jsonb",
    "severity_threshold" numeric,
    "reviewed" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "observed_as_interrupt" boolean DEFAULT false NOT NULL,
    "inferred_category" "text",
    "inferred_category_reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "reference_avg_players_hit" numeric,
    "reference_occurrences" integer,
    "reference_source_report" "text",
    "ai_classification" "jsonb",
    "name_es" "text",
    "resolution" "text",
    "resolution_sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "resolution_verified_at" timestamp with time zone,
    "responsibility" "text",
    "observed_in_reference_logs" boolean DEFAULT false NOT NULL,
    "official_difficulty_applicable" boolean,
    "reference_hit_ratio_samples" "jsonb",
    "mechanic_key" "text",
    "policy_version" integer,
    CONSTRAINT "boss_mechanics_candidates_category_check" CHECK (("category" = ANY (ARRAY['tankbuster'::"text", 'raid-damage'::"text", 'avoidable-ground'::"text", 'debuff-stack'::"text", 'interrupt'::"text", 'soak'::"text", 'spread'::"text", 'healing-absorb'::"text", 'personal-target'::"text", 'enrage'::"text"]))),
    CONSTRAINT "boss_mechanics_candidates_inferred_category_check" CHECK (("inferred_category" = ANY (ARRAY['tankbuster'::"text", 'raid-damage'::"text", 'avoidable-ground'::"text", 'debuff-stack'::"text", 'interrupt'::"text", 'soak'::"text", 'spread'::"text", 'healing-absorb'::"text", 'personal-target'::"text", 'enrage'::"text"]))),
    CONSTRAINT "boss_mechanics_candidates_policy_version_check" CHECK ((("policy_version" IS NULL) OR ("policy_version" > 0))),
    CONSTRAINT "boss_mechanics_candidates_responsibility_check" CHECK (("responsibility" = ANY (ARRAY['tank'::"text", 'dps'::"text", 'healer'::"text", 'raid'::"text", 'personal'::"text"])))
);


ALTER TABLE "public"."boss_mechanics_candidates" OWNER TO "postgres";


COMMENT ON COLUMN "public"."boss_mechanics_candidates"."observed_as_interrupt" IS 'true si esta ability_id aparece como extraAbilityGameID en un evento Interrupts de un log público de referencia (fightRankings) para este boss+dificultad — evidencia real, no heurística. Sync-boss-mechanics lo recalcula cada vez; no es un campo editorial (no lo toca save-mechanic-edit).';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."inferred_category" IS 'Sugerencia automática de sync-boss-mechanics (texto del Journal + comportamiento en un log público de referencia — ver _shared/mechanic-category-inference.ts). Se recalcula en cada resync. NUNCA sustituye a `category`: el front la usa solo como valor por defecto del desplegable mientras `category` esté sin confirmar.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."inferred_category_reasons" IS 'Array de frases legibles explicando de dónde salió inferred_category — la evidencia real, para el botón/tooltip de provenance ("¿por qué esta categoría?").';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."reference_avg_players_hit" IS 'Media de objetivos golpeados por cast de esta mecánica en el log público de referencia (fightRankings), como cuenta absoluta de jugadores — no ratio.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."reference_source_report" IS 'Código del report público usado para el benchmark — trazabilidad/provenance, no es dato de la guild.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."ai_classification" IS '{confidence, sources, notes, classifiedAt} — solo presente en mecánicas clasificadas vía el flujo de prompt de IA (classify-mechanics, action=submit). null = clasificada a mano o nunca clasificada.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."resolution" IS 'Cómo resolver la mecánica en este boss+dificultad, investigado mediante el flujo manual de IA. Solo classify-mechanics lo guarda tras validar dos fuentes independientes.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."resolution_sources" IS 'Obsoleto desde prompt v4. Se conserva para compatibilidad histórica; las fuentes generales de ai_classification respaldan también resolution.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."resolution_verified_at" IS 'Momento en que classify-mechanics validó y guardó la resolución con sus fuentes.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."responsibility" IS 'Responsable principal de resolver la mecánica: tank, dps, healer, raid o personal.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."observed_in_reference_logs" IS 'True cuando la habilidad se observó en uno o más logs públicos de referencia de esta dificultad exacta (cast, daño o interrupt). Evidencia para evitar mezclar dificultades.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."official_difficulty_applicable" IS 'True/false cuando las restricciones oficiales DB2 permiten/excluyen la habilidad en esta dificultad; null cuando DB2 no pudo resolverlo. No se borran filas ni ediciones manuales al excluir.';



COMMENT ON COLUMN "public"."boss_mechanics_candidates"."reference_hit_ratio_samples" IS 'Array de ratios (jugadores_golpeados/raidSize) por log público de referencia donde apareció esta mecánica — la muestra cruda para comparación de severidad tipo Wipefest. NULL/vacío hasta el próximo re-sync.';



CREATE TABLE IF NOT EXISTS "public"."pull_mechanic_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "ability_id" bigint NOT NULL,
    "mechanic_name" "text" NOT NULL,
    "trigger_time_ms" integer NOT NULL,
    "outcome" "text" NOT NULL,
    "players_hit" integer DEFAULT 0 NOT NULL,
    "avoidable" boolean,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "description" "text",
    "category" "text",
    "players_hit_names" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "player_hit_details" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "responsibility" "text",
    "phase_id" integer,
    "comparison_source" "text",
    "comparison_percentile" numeric,
    "mechanic_key" "text",
    CONSTRAINT "pull_mechanic_events_comparison_source_check" CHECK ((("comparison_source" IS NULL) OR ("comparison_source" = ANY (ARRAY['own_history'::"text", 'world_reference'::"text", 'fixed_threshold'::"text"])))),
    CONSTRAINT "pull_mechanic_events_outcome_check" CHECK (("outcome" = ANY (ARRAY['clean'::"text", 'partial_fail'::"text", 'fail'::"text"]))),
    CONSTRAINT "pull_mechanic_events_responsibility_check" CHECK (("responsibility" = ANY (ARRAY['tank'::"text", 'dps'::"text", 'healer'::"text", 'raid'::"text", 'personal'::"text"])))
);


ALTER TABLE "public"."pull_mechanic_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."pull_mechanic_events"."description" IS 'Copiado de boss_mechanics_candidates.description en el momento de clasificar — así el pull queda autocontenido aunque el manifiesto cambie después.';



COMMENT ON COLUMN "public"."pull_mechanic_events"."category" IS 'Copiado de boss_mechanics_candidates.category en el momento de clasificar (igual que description) — para que el front sepa cómo leer players_hit/outcome sin tener que volver a consultar el manifiesto.';



COMMENT ON COLUMN "public"."pull_mechanic_events"."players_hit_names" IS 'Nombres de los jugadores golpeados por esta instancia de mecánica (mismo criterio que players_hit, pero con quién, no solo cuántos). Vacío en la categoría interrupt, donde players_hit se reutiliza como "¿se resolvió?" y no representa golpes reales.';



COMMENT ON COLUMN "public"."pull_mechanic_events"."player_hit_details" IS 'Array de {name, damage_taken, damage_hits, healing_received, used_defensive_spell_id, max_hit_points?}; max_hit_points está disponible en imports nuevos con WCL resources.';



COMMENT ON COLUMN "public"."pull_mechanic_events"."responsibility" IS 'Snapshot de la responsabilidad editorial vigente al analizar o reclasificar la mecánica.';



COMMENT ON COLUMN "public"."pull_mechanic_events"."phase_id" IS 'Fase (boss_encounter_phases.phase_id) activa en el momento de trigger_time_ms. Null si el boss no tiene fases o el pull no trajo phase_transitions.';



COMMENT ON COLUMN "public"."pull_mechanic_events"."comparison_source" IS 'De dónde salió el umbral usado para esta instancia: historial propio de Avoid (kills), logs públicos de referencia, o el umbral fijo de siempre como último recurso.';



COMMENT ON COLUMN "public"."pull_mechanic_events"."comparison_percentile" IS 'Percentil de este ratio dentro de la muestra de comparison_source (0-100). NULL si comparison_source=fixed_threshold (sin muestra, no hay percentil que dar).';



CREATE TABLE IF NOT EXISTS "public"."pulls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_code" "text" NOT NULL,
    "fight_id" integer NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "pull_number" integer NOT NULL,
    "wipe_pct" numeric,
    "duration_ms" integer,
    "closed_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "raid_damage_taken_series" "jsonb",
    "wipe_call_confidence" numeric,
    "wipe_call_signals" "jsonb",
    "wipe_call_excluded" boolean DEFAULT false NOT NULL,
    "is_ninja_pull" boolean DEFAULT false NOT NULL,
    "ninja_pull_excluded" boolean DEFAULT false NOT NULL,
    "ninja_pull_signals" "jsonb",
    "phase_transitions" "jsonb",
    "last_phase_absolute_index" integer,
    "last_phase_is_intermission" boolean,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "unassigned_mechanic_occurrences" "jsonb",
    "observed_at" timestamp with time zone
);


ALTER TABLE "public"."pulls" OWNER TO "postgres";


COMMENT ON COLUMN "public"."pulls"."raid_damage_taken_series" IS '{ pointIntervalMs: number, points: number[] } — daño recibido por TODA la raid, sumado por bucket de tiempo (WCL graph(dataType:DamageTaken, hostilityType:Friendlies)). Null si WCL no respondió (best-effort, no bloquea el resto del análisis).';



COMMENT ON COLUMN "public"."pulls"."wipe_call_excluded" IS 'Decisión real que consumen reliability (player_pull_reliability_inputs), las tarjetas de métricas y "a quién dirigir": excluir las muertes del cluster detectado (player_pull_records.wipe_call_cluster=true de este pull) de fiabilidad/racha/mecánicas falladas. Editable por el RL vía la función set-wipe-call-status — nunca se sobreescribe en un re-análisis del mismo pull salvo que cambie el propio wipe_call_confidence.';



COMMENT ON COLUMN "public"."pulls"."is_ninja_pull" IS 'Heurística en analyze-report: pull muy corto donde casi nadie de la raid llegó a entrar en combate -- probable enganche accidental, no un intento real.';



COMMENT ON COLUMN "public"."pulls"."ninja_pull_excluded" IS 'Puerta real usada por las vistas para excluir de estadísticas de intentos/wipes. Por defecto igual a is_ninja_pull; queda separada para permitir corregir un falso positivo sin recalcular la heurística.';



COMMENT ON COLUMN "public"."pulls"."ninja_pull_signals" IS 'Señales que motivaron el veredicto: durationMs, raidSize, engagedPlayerCount y engagedFraction (jugadores que murieron o recibieron daño durante el pull, sobre el total de la raid).';



COMMENT ON COLUMN "public"."pulls"."phase_transitions" IS 'Lista cronológica de transiciones de fase observadas EN ESTE pull: [{id, startTime}]. id referencia boss_encounter_phases(boss_id, phase_id). Null = boss sin fases definidas en WCL.';



COMMENT ON COLUMN "public"."pulls"."last_phase_absolute_index" IS 'Índice absoluto (0-based, cuenta fases normales + intermedios) de la fase en la que terminó el pull -- mejor proxy de progreso que wipe_pct en bosses donde el % de vida se reinicia por fase (ver boss_encounter_phases.separates_wipes).';



COMMENT ON COLUMN "public"."pulls"."last_phase_is_intermission" IS 'true si el pull terminó durante un intermedio (p.ej. fase de adds/transición), no durante una fase de daño normal al boss.';



COMMENT ON COLUMN "public"."pulls"."updated_at" IS 'Última vez que se corrigió algo de este pull DESPUÉS de la inserción inicial (reanalyze-wipe-call, set-wipe-call-status, set-ninja-pull-status) — no se toca en la inserción original (para eso ya está created_at/closed_at). Es la señal que consume roster-snapshot-cache.service.ts para saber si un snapshot cacheado sigue siendo válido tras una corrección retroactiva.';



COMMENT ON COLUMN "public"."pulls"."unassigned_mechanic_occurrences" IS 'Array de {catalogId, mechanicName, actorId, actorName, timestampMs} — quién resolvió cada mecánica sin asignar de este pull, calculado por analyze-report/reanalyze-unassigned-mechanics contra unassigned_mechanic_catalog.';



CREATE OR REPLACE VIEW "public"."applicable_boss_mechanics_candidates" WITH ("security_invoker"='true') AS
 SELECT "id",
    "boss_id",
    "difficulty",
    "ability_id",
    "name",
    "description",
    "icon_url",
    "sources",
    "observed_in_logs",
    "journal_encounter_id",
    "db2_difficulty_id",
    "difficulty_mapping_status",
    "category",
    "avoidable",
    "expected_response",
    "severity_threshold",
    "reviewed",
    "updated_at",
    "observed_as_interrupt",
    "inferred_category",
    "inferred_category_reasons",
    "reference_avg_players_hit",
    "reference_occurrences",
    "reference_source_report",
    "ai_classification",
    "name_es",
    "resolution",
    "resolution_sources",
    "resolution_verified_at",
    "responsibility",
    "observed_in_reference_logs",
    "official_difficulty_applicable",
    "reference_hit_ratio_samples",
    "mechanic_key",
    "policy_version"
   FROM "public"."boss_mechanics_candidates" "candidate"
  WHERE (("observed_in_logs" IS TRUE) OR ("observed_in_reference_logs" IS TRUE) OR ("observed_as_interrupt" IS TRUE) OR (COALESCE("reference_occurrences", 0) > 0) OR (EXISTS ( SELECT 1
           FROM ("public"."pull_mechanic_events" "event"
             JOIN "public"."pulls" "pull" ON (("pull"."id" = "event"."pull_id")))
          WHERE (("pull"."boss_id" = "candidate"."boss_id") AND ("pull"."difficulty" = "candidate"."difficulty") AND ("lower"(TRIM(BOTH FROM "event"."mechanic_name")) = "lower"(TRIM(BOTH FROM "candidate"."name")))))) OR (("official_difficulty_applicable" IS DISTINCT FROM false) AND (("reference_source_report" IS NULL) OR (NOT (EXISTS ( SELECT 1
           FROM "public"."boss_mechanics_candidates" "other"
          WHERE (("other"."boss_id" = "candidate"."boss_id") AND ("other"."ability_id" = "candidate"."ability_id") AND ("other"."difficulty" <> "candidate"."difficulty") AND (("other"."observed_in_logs" IS TRUE) OR ("other"."observed_in_reference_logs" IS TRUE) OR ("other"."observed_as_interrupt" IS TRUE) OR (COALESCE("other"."reference_occurrences", 0) > 0)) AND (
                CASE "other"."difficulty"
                    WHEN 'LFR'::"text" THEN 1
                    WHEN 'Normal'::"text" THEN 3
                    WHEN 'Heroic'::"text" THEN 4
                    WHEN 'Mythic'::"text" THEN 5
                    ELSE 0
                END >
                CASE "candidate"."difficulty"
                    WHEN 'LFR'::"text" THEN 1
                    WHEN 'Normal'::"text" THEN 3
                    WHEN 'Heroic'::"text" THEN 4
                    WHEN 'Mythic'::"text" THEN 5
                    ELSE 0
                END))))))));


ALTER VIEW "public"."applicable_boss_mechanics_candidates" OWNER TO "postgres";


COMMENT ON VIEW "public"."applicable_boss_mechanics_candidates" IS 'Mecánicas aplicables por boss+dificultad. Recreada tras M12 para exponer mechanic_key y policy_version sin cambiar el filtro de aplicabilidad.';



CREATE OR REPLACE VIEW "public"."applicable_pull_mechanic_events" WITH ("security_invoker"='true') AS
 SELECT "event"."id",
    "event"."pull_id",
    "event"."ability_id",
    "event"."mechanic_name",
    "event"."trigger_time_ms",
    "event"."outcome",
    "event"."players_hit",
    "event"."avoidable",
    "event"."created_at",
    "event"."description",
    "event"."category",
    "event"."players_hit_names",
    "event"."player_hit_details",
    "event"."responsibility",
    "event"."phase_id",
    "event"."comparison_source",
    "event"."comparison_percentile"
   FROM ("public"."pull_mechanic_events" "event"
     JOIN "public"."pulls" "pull" ON (("pull"."id" = "event"."pull_id")))
  WHERE ((NOT (EXISTS ( SELECT 1
           FROM "public"."boss_mechanics_candidates" "candidate"
          WHERE (("candidate"."boss_id" = "pull"."boss_id") AND ("candidate"."difficulty" = "pull"."difficulty") AND ("lower"(TRIM(BOTH FROM "candidate"."name")) = "lower"(TRIM(BOTH FROM "event"."mechanic_name"))))))) OR (EXISTS ( SELECT 1
           FROM "public"."applicable_boss_mechanics_candidates" "candidate"
          WHERE (("candidate"."boss_id" = "pull"."boss_id") AND ("candidate"."difficulty" = "pull"."difficulty") AND ("lower"(TRIM(BOTH FROM "candidate"."name")) = "lower"(TRIM(BOTH FROM "event"."mechanic_name")))))));


ALTER VIEW "public"."applicable_pull_mechanic_events" OWNER TO "postgres";


COMMENT ON VIEW "public"."applicable_pull_mechanic_events" IS 'Eventos históricos cuya mecánica sigue siendo aplicable al boss+dificultad. Las filas sin candidata asociada se conservan de forma conservadora. Recreada el 2026-08-27 para que event.* recoja comparison_source/comparison_percentile.';



CREATE TABLE IF NOT EXISTS "public"."boss_encounter_phases" (
    "boss_id" "text" NOT NULL,
    "phase_id" integer NOT NULL,
    "name" "text" NOT NULL,
    "is_intermission" boolean,
    "separates_wipes" boolean,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."boss_encounter_phases" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_encounter_phases" IS 'Nombre legible + metadata de cada fase de cada boss, sincronizado desde Report.phases de WCL en analyze-report. Referencia de solo lectura para la app; no depende de ningún pull concreto.';



CREATE TABLE IF NOT EXISTS "public"."boss_mechanic_aliases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "mechanic_key" "text" NOT NULL,
    "ability_id" bigint,
    "normalized_name" "text",
    "source" "text" NOT NULL,
    "confidence" "text" NOT NULL,
    "provenance" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "boss_mechanic_aliases_ability_id_check" CHECK ((("ability_id" IS NULL) OR ("ability_id" > 0))),
    CONSTRAINT "boss_mechanic_aliases_check" CHECK ((("ability_id" IS NOT NULL) OR ("normalized_name" IS NOT NULL))),
    CONSTRAINT "boss_mechanic_aliases_check1" CHECK ((("confidence" <> 'uncertain'::"text") OR (NOT "active"))),
    CONSTRAINT "boss_mechanic_aliases_confidence_check" CHECK (("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "boss_mechanic_aliases_normalized_name_check" CHECK ((("normalized_name" IS NULL) OR (NULLIF("btrim"("normalized_name"), ''::"text") IS NOT NULL))),
    CONSTRAINT "boss_mechanic_aliases_provenance_check" CHECK (("jsonb_typeof"("provenance") = 'object'::"text")),
    CONSTRAINT "boss_mechanic_aliases_source_check" CHECK (("source" = ANY (ARRAY['journal'::"text", 'wcl'::"text", 'manual'::"text", 'classifier'::"text", 'legacy'::"text"])))
);


ALTER TABLE "public"."boss_mechanic_aliases" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_mechanic_aliases" IS 'Convergencia versionable de IDs Journal/WCL y nombres normalizados hacia una mechanic_key estable.';



CREATE TABLE IF NOT EXISTS "public"."boss_mechanic_catalog_sync_state" (
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "last_synced_at" timestamp with time zone NOT NULL,
    "sync_mode" "text" NOT NULL,
    "candidate_count" integer DEFAULT 0 NOT NULL,
    "reference_bundle_count" integer DEFAULT 0 NOT NULL,
    "mapping_status" "text",
    "reference_fetch_error" "text",
    "snapshot_fetch_error" "text",
    CONSTRAINT "boss_mechanic_catalog_sync_state_candidate_count_check" CHECK (("candidate_count" >= 0)),
    CONSTRAINT "boss_mechanic_catalog_sync_state_reference_bundle_count_check" CHECK (("reference_bundle_count" >= 0)),
    CONSTRAINT "boss_mechanic_catalog_sync_state_sync_mode_check" CHECK (("sync_mode" = ANY (ARRAY['deep'::"text", 'quick'::"text"])))
);


ALTER TABLE "public"."boss_mechanic_catalog_sync_state" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_mechanic_catalog_sync_state" IS 'Último resultado persistido de sync-boss-mechanics por boss+dificultad; no representa el consumo incremental del perfil defensivo.';



CREATE TABLE IF NOT EXISTS "public"."boss_mechanic_defensive_local_profile" (
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "ability_id" bigint NOT NULL,
    "local_damage_samples" numeric[] DEFAULT '{}'::numeric[] NOT NULL,
    "local_unmitigated_estimate_samples" numeric[] DEFAULT '{}'::numeric[] NOT NULL,
    "local_max_health_pct_samples" numeric[] DEFAULT '{}'::numeric[] NOT NULL,
    "local_player_hit_count_samples" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "local_death_count" integer DEFAULT 0 NOT NULL,
    "local_near_death_count" integer DEFAULT 0 NOT NULL,
    "local_pressure_window_count" integer DEFAULT 0 NOT NULL,
    "local_sample_pull_count" integer DEFAULT 0 NOT NULL,
    "local_raid_impact_score" numeric,
    "local_individual_lethality_score" numeric,
    "local_priority" smallint,
    "local_last_observed_at" timestamp with time zone,
    "sync_revision" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "boss_mechanic_defensive_local_local_pressure_window_count_check" CHECK (("local_pressure_window_count" >= 0)),
    CONSTRAINT "boss_mechanic_defensive_local_pro_local_sample_pull_count_check" CHECK (("local_sample_pull_count" >= 0)),
    CONSTRAINT "boss_mechanic_defensive_local_prof_local_near_death_count_check" CHECK (("local_near_death_count" >= 0)),
    CONSTRAINT "boss_mechanic_defensive_local_profile_local_death_count_check" CHECK (("local_death_count" >= 0)),
    CONSTRAINT "boss_mechanic_defensive_local_profile_local_priority_check" CHECK ((("local_priority" >= 1) AND ("local_priority" <= 5)))
);


ALTER TABLE "public"."boss_mechanic_defensive_local_profile" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_mechanic_defensive_local_profile" IS 'Agregado idempotente de pulls propios. Nunca contiene ni sobrescribe muestras world.';



CREATE TABLE IF NOT EXISTS "public"."boss_mechanic_defensive_profile" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "ability_id" bigint NOT NULL,
    "reference_unmitigated_damage_samples" numeric[] DEFAULT '{}'::numeric[] NOT NULL,
    "reference_mitigated_damage_samples" numeric[] DEFAULT '{}'::numeric[] NOT NULL,
    "reference_role_hit_breakdown" "jsonb",
    "reference_cast_offset_ms_samples" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "reference_sample_fight_count" integer DEFAULT 0 NOT NULL,
    "requires_defensive" boolean,
    "requires_defensive_source" "text",
    "requires_group_split" boolean DEFAULT false NOT NULL,
    "group_split_notes" "text",
    "reviewed" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "priority" smallint,
    "reference_cast_offsets_by_fight" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "boss_mechanic_defensive_profile_priority_check" CHECK ((("priority" >= 1) AND ("priority" <= 5)))
);


ALTER TABLE "public"."boss_mechanic_defensive_profile" OWNER TO "postgres";


COMMENT ON COLUMN "public"."boss_mechanic_defensive_profile"."priority" IS '1-5, relativo a las demás mecánicas de este boss+dificultad (quintil por daño sin mitigar × jugadores golpeados) — null = sin evidencia todavía. Solo lo escribe sync-mechanic-defensive-profile.';



COMMENT ON COLUMN "public"."boss_mechanic_defensive_profile"."reference_cast_offsets_by_fight" IS 'Timings conservando el fight de origen: [{fightKey, offsetsMs[]}]. Permite alinear ocurrencias por ordinal sin inferirlas desde un array mezclado; reference_cast_offset_ms_samples queda como fallback histórico.';



CREATE OR REPLACE VIEW "public"."boss_mechanic_defensive_planning_view" WITH ("security_invoker"='true') AS
 WITH "joined" AS (
         SELECT COALESCE("world"."boss_id", "local"."boss_id") AS "boss_id",
            COALESCE("world"."difficulty", "local"."difficulty") AS "difficulty",
            COALESCE("world"."ability_id", "local"."ability_id") AS "ability_id",
            "world"."reference_sample_fight_count" AS "world_sample_fight_count",
            "world"."priority" AS "world_priority",
            "world"."requires_defensive" AS "world_requires_defensive",
            "world"."requires_defensive_source" AS "world_requires_defensive_source",
                CASE
                    WHEN ("cardinality"("world"."reference_unmitigated_damage_samples") > 0) THEN ( SELECT "percentile_cont"((0.5)::double precision) WITHIN GROUP (ORDER BY (("value"."value")::double precision)) AS "percentile_cont"
                       FROM "unnest"("world"."reference_unmitigated_damage_samples") "value"("value"))
                    ELSE NULL::double precision
                END AS "world_median_unmitigated_damage",
            "local"."local_sample_pull_count",
            "local"."local_damage_samples",
            "local"."local_unmitigated_estimate_samples",
            "local"."local_max_health_pct_samples",
            "local"."local_player_hit_count_samples",
            "local"."local_death_count",
            "local"."local_near_death_count",
            "local"."local_pressure_window_count",
            "local"."local_raid_impact_score",
            "local"."local_individual_lethality_score",
            "local"."local_priority",
            "local"."local_last_observed_at",
            GREATEST("world"."updated_at", "local"."updated_at") AS "updated_at"
           FROM ("public"."boss_mechanic_defensive_profile" "world"
             FULL JOIN "public"."boss_mechanic_defensive_local_profile" "local" ON ((("local"."boss_id" = "world"."boss_id") AND ("local"."difficulty" = "world"."difficulty") AND ("local"."ability_id" = "world"."ability_id"))))
        )
 SELECT "boss_id",
    "difficulty",
    "ability_id",
    "world_sample_fight_count",
    "world_priority",
    "world_requires_defensive",
    "world_requires_defensive_source",
    "world_median_unmitigated_damage",
    "local_sample_pull_count",
    "local_damage_samples",
    "local_unmitigated_estimate_samples",
    "local_max_health_pct_samples",
    "local_player_hit_count_samples",
    "local_death_count",
    "local_near_death_count",
    "local_pressure_window_count",
    "local_raid_impact_score",
    "local_individual_lethality_score",
    "local_priority",
    "local_last_observed_at",
    "updated_at",
        CASE
            WHEN ("world_requires_defensive_source" = 'manual_override'::"text") THEN "world_priority"
            ELSE GREATEST("world_priority", "local_priority")
        END AS "combined_planning_priority",
        CASE
            WHEN ("world_requires_defensive_source" = 'manual_override'::"text") THEN 'manual_override'::"text"
            WHEN (("world_priority" IS NOT NULL) AND ("local_priority" IS NOT NULL)) THEN 'world+local'::"text"
            WHEN ("local_priority" IS NOT NULL) THEN 'local'::"text"
            WHEN ("world_priority" IS NOT NULL) THEN 'world'::"text"
            ELSE 'none'::"text"
        END AS "combined_priority_source"
   FROM "joined";


ALTER VIEW "public"."boss_mechanic_defensive_planning_view" OWNER TO "postgres";


COMMENT ON VIEW "public"."boss_mechanic_defensive_planning_view" IS 'Lectura conjunta para planning que conserva columnas y provenance world/local separadas.';



CREATE TABLE IF NOT EXISTS "public"."mechanic_occurrence_evaluations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "mechanic_key" "text" NOT NULL,
    "occurrence_index" integer NOT NULL,
    "start_ms" integer NOT NULL,
    "resolve_ms" integer NOT NULL,
    "end_ms" integer NOT NULL,
    "phase_id" "text",
    "boss_hp_pct" numeric,
    "target_actor_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    "assignment_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "outcome" "text" NOT NULL,
    "failure_mode" "text",
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "confidence" "text" NOT NULL,
    "policy_version" integer NOT NULL,
    "context_resolver_version" "text" NOT NULL,
    "occurrence_resolver_version" "text" NOT NULL,
    "evaluated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "mechanic_occurrence_evaluatio_occurrence_resolver_version_check" CHECK ((NULLIF("btrim"("occurrence_resolver_version"), ''::"text") IS NOT NULL)),
    CONSTRAINT "mechanic_occurrence_evaluations_assignment_snapshot_check" CHECK (("jsonb_typeof"("assignment_snapshot") = 'object'::"text")),
    CONSTRAINT "mechanic_occurrence_evaluations_boss_hp_pct_check" CHECK ((("boss_hp_pct" IS NULL) OR (("boss_hp_pct" >= (0)::numeric) AND ("boss_hp_pct" <= (100)::numeric)))),
    CONSTRAINT "mechanic_occurrence_evaluations_check" CHECK (("resolve_ms" >= "start_ms")),
    CONSTRAINT "mechanic_occurrence_evaluations_check1" CHECK (("end_ms" >= "resolve_ms")),
    CONSTRAINT "mechanic_occurrence_evaluations_check2" CHECK ((("outcome" <> 'uncertain'::"text") OR ("confidence" = 'uncertain'::"text"))),
    CONSTRAINT "mechanic_occurrence_evaluations_check3" CHECK ((("outcome" <> 'fail'::"text") OR ("failure_mode" IS NOT NULL))),
    CONSTRAINT "mechanic_occurrence_evaluations_confidence_check" CHECK (("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "mechanic_occurrence_evaluations_context_resolver_version_check" CHECK ((NULLIF("btrim"("context_resolver_version"), ''::"text") IS NOT NULL)),
    CONSTRAINT "mechanic_occurrence_evaluations_evidence_check" CHECK (("jsonb_typeof"("evidence") = 'object'::"text")),
    CONSTRAINT "mechanic_occurrence_evaluations_failure_mode_check" CHECK ((("failure_mode" IS NULL) OR (NULLIF("btrim"("failure_mode"), ''::"text") IS NOT NULL))),
    CONSTRAINT "mechanic_occurrence_evaluations_occurrence_index_check" CHECK (("occurrence_index" > 0)),
    CONSTRAINT "mechanic_occurrence_evaluations_outcome_check" CHECK (("outcome" = ANY (ARRAY['success'::"text", 'partial_fail'::"text", 'fail'::"text", 'not_evaluable'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "mechanic_occurrence_evaluations_policy_version_check" CHECK (("policy_version" > 0)),
    CONSTRAINT "mechanic_occurrence_evaluations_start_ms_check" CHECK (("start_ms" >= 0)),
    CONSTRAINT "mechanic_occurrence_evaluations_target_actor_ids_check" CHECK ((("array_position"("target_actor_ids", NULL::bigint) IS NULL) AND ((0)::bigint < ALL ("target_actor_ids"))))
);


ALTER TABLE "public"."mechanic_occurrence_evaluations" OWNER TO "postgres";


COMMENT ON TABLE "public"."mechanic_occurrence_evaluations" IS 'Outcome reproducible por pull+mechanic_key+occurrence. Los impactos observados no determinan por sí solos ownership.';



CREATE OR REPLACE VIEW "public"."boss_mechanic_execution_stats_v3" WITH ("security_invoker"='true') AS
 SELECT "boss_id",
    "difficulty",
    "mechanic_key",
    "policy_version",
    "occurrence_resolver_version",
    ("count"(*))::integer AS "occurrence_count",
    ("count"(*) FILTER (WHERE ("outcome" = 'success'::"text")))::integer AS "success_count",
    ("count"(*) FILTER (WHERE ("outcome" = ANY (ARRAY['partial_fail'::"text", 'fail'::"text"]))))::integer AS "failure_count",
    ("count"(*) FILTER (WHERE ("outcome" = ANY (ARRAY['not_evaluable'::"text", 'uncertain'::"text"]))))::integer AS "non_evaluable_count",
    ("count"(DISTINCT "pull_id"))::integer AS "pull_count",
    "max"("evaluated_at") AS "evaluated_at"
   FROM "public"."mechanic_occurrence_evaluations" "o"
  GROUP BY "boss_id", "difficulty", "mechanic_key", "policy_version", "occurrence_resolver_version";


ALTER VIEW "public"."boss_mechanic_execution_stats_v3" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."boss_mechanic_occurrence_profile" (
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "ability_id" bigint NOT NULL,
    "occurrence_index" integer NOT NULL,
    "median_offset_ms" integer NOT NULL,
    "p10_offset_ms" integer NOT NULL,
    "p90_offset_ms" integer NOT NULL,
    "sample_offsets_ms" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "sample_fight_count" integer DEFAULT 0 NOT NULL,
    "phase_id" integer,
    "world_overlap_score" numeric,
    "local_overlap_score" numeric,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "boss_mechanic_occurrence_profile_check" CHECK ((("p10_offset_ms" <= "median_offset_ms") AND ("median_offset_ms" <= "p90_offset_ms"))),
    CONSTRAINT "boss_mechanic_occurrence_profile_median_offset_ms_check" CHECK (("median_offset_ms" >= 0)),
    CONSTRAINT "boss_mechanic_occurrence_profile_occurrence_index_check" CHECK (("occurrence_index" >= 1)),
    CONSTRAINT "boss_mechanic_occurrence_profile_p10_offset_ms_check" CHECK (("p10_offset_ms" >= 0)),
    CONSTRAINT "boss_mechanic_occurrence_profile_p90_offset_ms_check" CHECK (("p90_offset_ms" >= 0)),
    CONSTRAINT "boss_mechanic_occurrence_profile_sample_fight_count_check" CHECK (("sample_fight_count" >= 0))
);


ALTER TABLE "public"."boss_mechanic_occurrence_profile" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_mechanic_occurrence_profile" IS 'Timings world por ocurrencia repetida: #1 se agrega con #1 entre fights, nunca como una mediana única por ability.';



COMMENT ON COLUMN "public"."boss_mechanic_occurrence_profile"."sample_fight_count" IS 'Número de fights que observaron esta ocurrencia concreta; permite detectar una #N rara causada por distinta duración/fase.';



CREATE TABLE IF NOT EXISTS "public"."boss_mechanic_policy" (
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "mechanic_key" "text" NOT NULL,
    "policy_version" integer DEFAULT 1 NOT NULL,
    "display_name" "text" NOT NULL,
    "display_category" "text",
    "targeting_mode" "text" NOT NULL,
    "required_response" "text",
    "responsibility_mode" "text" NOT NULL,
    "damage_semantics" "text" NOT NULL,
    "failure_propagation" "text" NOT NULL,
    "assignment_mode" "text" NOT NULL,
    "defensive_expectation" "text" NOT NULL,
    "credit_scope" "text" NOT NULL,
    "penalty_scope" "text" NOT NULL,
    "causal_rule" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "confidence" "text" NOT NULL,
    "provenance" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "game_build" "text",
    "tier_revision" "text",
    "verified_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "boss_mechanic_policy_assignment_mode_check" CHECK (("assignment_mode" = ANY (ARRAY['none'::"text", 'target_derived'::"text", 'role_derived'::"text", 'plan_optional'::"text", 'plan_required'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_causal_rule_check" CHECK (("jsonb_typeof"("causal_rule") = 'object'::"text")),
    CONSTRAINT "boss_mechanic_policy_check" CHECK ((("confidence" <> 'verified'::"text") OR ("verified_at" IS NOT NULL))),
    CONSTRAINT "boss_mechanic_policy_check1" CHECK ((("penalty_scope" = 'none'::"text") OR ("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text"])))),
    CONSTRAINT "boss_mechanic_policy_confidence_check" CHECK (("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_credit_scope_check" CHECK (("credit_scope" = ANY (ARRAY['resolver'::"text", 'target'::"text", 'group'::"text", 'raid'::"text", 'none'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_damage_semantics_check" CHECK (("damage_semantics" = ANY (ARRAY['mandatory'::"text", 'avoidable'::"text", 'partly_avoidable'::"text", 'failure_consequence'::"text", 'none'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_defensive_expectation_check" CHECK (("defensive_expectation" = ANY (ARRAY['none'::"text", 'optional'::"text", 'recommended'::"text", 'required'::"text", 'contingency_only'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_display_category_check" CHECK (("display_category" = ANY (ARRAY['tankbuster'::"text", 'raid-damage'::"text", 'avoidable-ground'::"text", 'debuff-stack'::"text", 'interrupt'::"text", 'soak'::"text", 'spread'::"text", 'healing-absorb'::"text", 'personal-target'::"text", 'enrage'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_display_name_check" CHECK ((NULLIF("btrim"("display_name"), ''::"text") IS NOT NULL)),
    CONSTRAINT "boss_mechanic_policy_failure_propagation_check" CHECK (("failure_propagation" = ANY (ARRAY['self'::"text", 'nearby_players'::"text", 'group'::"text", 'raid'::"text", 'chained'::"text", 'none'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_mechanic_key_check" CHECK ((NULLIF("btrim"("mechanic_key"), ''::"text") IS NOT NULL)),
    CONSTRAINT "boss_mechanic_policy_penalty_scope_check" CHECK (("penalty_scope" = ANY (ARRAY['owner'::"text", 'assignee'::"text", 'role'::"text", 'raid_only'::"text", 'none'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_policy_version_check" CHECK (("policy_version" > 0)),
    CONSTRAINT "boss_mechanic_policy_provenance_check" CHECK (("jsonb_typeof"("provenance") = 'object'::"text")),
    CONSTRAINT "boss_mechanic_policy_required_response_check" CHECK ((("required_response" IS NULL) OR (NULLIF("btrim"("required_response"), ''::"text") IS NOT NULL))),
    CONSTRAINT "boss_mechanic_policy_responsibility_mode_check" CHECK (("responsibility_mode" = ANY (ARRAY['target'::"text", 'tank_role'::"text", 'healer_role'::"text", 'dps_role'::"text", 'assigned_player'::"text", 'assigned_group'::"text", 'volunteer'::"text", 'raid'::"text", 'none'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_targeting_mode_check" CHECK (("targeting_mode" = ANY (ARRAY['tank'::"text", 'selected_player'::"text", 'group'::"text", 'raid'::"text", 'ground'::"text", 'object'::"text", 'none'::"text", 'mixed'::"text"])))
);


ALTER TABLE "public"."boss_mechanic_policy" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_mechanic_policy" IS 'Policy causal canónica por boss+dificultad+mechanic_key. display_category es compatibilidad visual, nunca autoridad de culpabilidad.';



CREATE TABLE IF NOT EXISTS "public"."boss_mechanic_policy_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "mechanic_key" "text" NOT NULL,
    "previous_policy_version" integer,
    "new_policy_version" integer NOT NULL,
    "before_state" "jsonb",
    "after_state" "jsonb" NOT NULL,
    "reason" "text" NOT NULL,
    "changed_by" "uuid",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "boss_mechanic_policy_audit_after_state_check" CHECK (("jsonb_typeof"("after_state") = 'object'::"text")),
    CONSTRAINT "boss_mechanic_policy_audit_before_state_check" CHECK ((("before_state" IS NULL) OR ("jsonb_typeof"("before_state") = 'object'::"text"))),
    CONSTRAINT "boss_mechanic_policy_audit_new_policy_version_check" CHECK (("new_policy_version" > 0)),
    CONSTRAINT "boss_mechanic_policy_audit_previous_policy_version_check" CHECK ((("previous_policy_version" IS NULL) OR ("previous_policy_version" > 0))),
    CONSTRAINT "boss_mechanic_policy_audit_reason_check" CHECK ((NULLIF("btrim"("reason"), ''::"text") IS NOT NULL))
);


ALTER TABLE "public"."boss_mechanic_policy_audit" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_mechanic_policy_audit" IS 'Historial before/after de revisiones de policy; los consumidores persisten policy_version y no reinterpretan planes publicados.';



CREATE TABLE IF NOT EXISTS "public"."boss_mechanic_policy_versions" (
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "mechanic_key" "text" NOT NULL,
    "policy_version" integer NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "confidence" "text" NOT NULL,
    "published_by" "uuid",
    "published_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "boss_mechanic_policy_versions_confidence_check" CHECK (("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "boss_mechanic_policy_versions_mechanic_key_check" CHECK ((NULLIF("btrim"("mechanic_key"), ''::"text") IS NOT NULL)),
    CONSTRAINT "boss_mechanic_policy_versions_policy_version_check" CHECK (("policy_version" > 0)),
    CONSTRAINT "boss_mechanic_policy_versions_snapshot_check" CHECK (("jsonb_typeof"("snapshot") = 'object'::"text"))
);


ALTER TABLE "public"."boss_mechanic_policy_versions" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_mechanic_policy_versions" IS 'Snapshots inmutables de cada publicación de policy. La tabla boss_mechanic_policy conserva únicamente el estado vigente compatible con FKs legacy.';



CREATE TABLE IF NOT EXISTS "public"."boss_mechanics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "contract" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."boss_mechanics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."boss_reference_stats" (
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "reference_kill_duration_ms" integer NOT NULL,
    "reference_report_code" "text" NOT NULL,
    "reference_fight_id" integer NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reference_sample_size" integer,
    "reference_median_duration_ms" integer,
    "reference_p25_duration_ms" integer,
    "reference_zero_death_rate" numeric
);


ALTER TABLE "public"."boss_reference_stats" OWNER TO "postgres";


COMMENT ON TABLE "public"."boss_reference_stats" IS 'Duración del mejor kill público (worldData.fightRankings) por boss+dificultad — benchmark de ritmo, no dato editorial. Lo recalcula sync-boss-mechanics en cada sync.';



COMMENT ON COLUMN "public"."boss_reference_stats"."reference_sample_size" IS 'Cuántas kills públicas se usaron para la mediana/percentil (hasta 50, las que devuelva fightRankings).';



COMMENT ON COLUMN "public"."boss_reference_stats"."reference_median_duration_ms" IS 'Mediana de duración de esas kills — comparación más justa que "el mejor del mundo".';



COMMENT ON COLUMN "public"."boss_reference_stats"."reference_p25_duration_ms" IS 'Percentil 25 de duración (el cuartil más rápido) — "el ritmo de las guilds realmente rápidas", sin ser el máximo absoluto.';



COMMENT ON COLUMN "public"."boss_reference_stats"."reference_zero_death_rate" IS 'Fracción (0-1) de esas kills públicas que tuvieron 0 muertes registradas — para contextualizar si "0 muertes" es lo normal en un kill limpio o una rareza incluso para las mejores guilds.';



CREATE TABLE IF NOT EXISTS "public"."boss_reference_sync_state" (
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "reference_fights_consumed" integer DEFAULT 0 NOT NULL,
    "last_synced_at" timestamp with time zone
);


ALTER TABLE "public"."boss_reference_sync_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."combat_evaluation_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reason" "text" NOT NULL,
    "scope" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "total_jobs" integer DEFAULT 0 NOT NULL,
    "completed_jobs" integer DEFAULT 0 NOT NULL,
    "failed_jobs" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "combat_evaluation_batches_check" CHECK ((("completed_jobs" >= 0) AND ("completed_jobs" <= "total_jobs"))),
    CONSTRAINT "combat_evaluation_batches_check1" CHECK ((("failed_jobs" >= 0) AND ("failed_jobs" <= "total_jobs"))),
    CONSTRAINT "combat_evaluation_batches_reason_check" CHECK ((NULLIF("btrim"("reason"), ''::"text") IS NOT NULL)),
    CONSTRAINT "combat_evaluation_batches_scope_check" CHECK (("jsonb_typeof"("scope") = 'object'::"text")),
    CONSTRAINT "combat_evaluation_batches_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'completed'::"text", 'completed_with_errors'::"text"]))),
    CONSTRAINT "combat_evaluation_batches_total_jobs_check" CHECK (("total_jobs" >= 0))
);


ALTER TABLE "public"."combat_evaluation_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cooldown_catalog" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "class" "text" NOT NULL,
    "spec" "text",
    "spell_id" integer NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" DEFAULT 'personal_defensive'::"text" NOT NULL,
    "synced_from_commit" "text",
    "synced_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "base_cooldown_ms" integer,
    "base_duration_ms" integer,
    "survival_type" "text",
    "inferred_survival_type" "text",
    "ai_classification" "jsonb",
    "reviewed" boolean DEFAULT false NOT NULL,
    "spec_override" "text"[],
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "excluded" boolean DEFAULT false NOT NULL,
    "targeting_mode" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "activation_mode" "text" DEFAULT 'active'::"text" NOT NULL,
    "passive_conversion_spell_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    "activation_game_build" "text" DEFAULT 'legacy-current'::"text" NOT NULL,
    CONSTRAINT "cooldown_catalog_activation_game_build_check" CHECK (("btrim"("activation_game_build") <> ''::"text")),
    CONSTRAINT "cooldown_catalog_activation_mode_check" CHECK (("activation_mode" = ANY (ARRAY['active'::"text", 'passive'::"text"]))),
    CONSTRAINT "cooldown_catalog_category_check" CHECK (("category" = ANY (ARRAY['personal_defensive'::"text", 'semi_defensive'::"text", 'external_defensive'::"text", 'utility'::"text"]))),
    CONSTRAINT "cooldown_catalog_inferred_survival_type_check" CHECK (("inferred_survival_type" = ANY (ARRAY['mitigation'::"text", 'absorption'::"text", 'sustain'::"text", 'emergency'::"text"]))),
    CONSTRAINT "cooldown_catalog_passive_conversion_ids_check" CHECK ((("array_position"("passive_conversion_spell_ids", NULL::bigint) IS NULL) AND ((0)::bigint < ALL ("passive_conversion_spell_ids")))),
    CONSTRAINT "cooldown_catalog_survival_type_check" CHECK (("survival_type" = ANY (ARRAY['mitigation'::"text", 'absorption'::"text", 'sustain'::"text", 'emergency'::"text"]))),
    CONSTRAINT "cooldown_catalog_targeting_mode_check" CHECK (("targeting_mode" = ANY (ARRAY['self'::"text", 'ally'::"text", 'both'::"text", 'raid'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."cooldown_catalog" OWNER TO "postgres";


COMMENT ON COLUMN "public"."cooldown_catalog"."base_cooldown_ms" IS 'Cooldown base en ms, talentos/haste en 0 (el "peor caso" antes de reducciones). Null cuando el extractor no pudo resolver un número plano del código fuente — ver supabase/wowanalyzer-extractor/extract.mjs.';



COMMENT ON COLUMN "public"."cooldown_catalog"."base_duration_ms" IS 'Duración real del buff/efecto en ms (cuánto dura activo tras lanzarlo) — distinto de base_cooldown_ms (cuánto tarda en volver a estar disponible). Null = sin verificar; el cálculo de "activo al morir" cae de vuelta al snapshot de buffs de WCL.';



COMMENT ON COLUMN "public"."cooldown_catalog"."survival_type" IS 'Confirmado a mano (Ajustes > Defensivos) o aplicado desde una clasificación IA. Eje ortogonal a `category`: category = a quién protege (personal/semi/external/utility), survival_type = qué le hace al daño (mitigation = lo reduce, absorption = lo intercepta con un pool aparte, sustain = repara HP ya perdido, emergency = evita la muerte / dispara el margen de supervivencia).';



COMMENT ON COLUMN "public"."cooldown_catalog"."inferred_survival_type" IS 'Sugerencia automática (IA) sin confirmar todavía — nunca pisa survival_type una vez confirmado a mano.';



COMMENT ON COLUMN "public"."cooldown_catalog"."ai_classification" IS 'Razonamiento de la clasificación IA: {confidence, sources, notes, classifiedAt} — mismo contrato que boss_mechanics_candidates.ai_classification.';



COMMENT ON COLUMN "public"."cooldown_catalog"."reviewed" IS 'true = un humano ha revisado esta fila en la pantalla de Defensivos, confirmada o no. No implica que TODAS las specs de la clase tengan este defensivo — eso depende de spec/talentos, ver cooldown_catalog.spec y el cruce real en defensive-cooldowns.ts.';



COMMENT ON COLUMN "public"."cooldown_catalog"."spec_override" IS 'Corrección manual de qué specs tienen este defensivo de verdad — null = sin corregir, se deriva de `spec`. Nunca lo toca el extractor de WoWAnalyzer ni classify-defensives, solo save-defensive-edit.';



COMMENT ON COLUMN "public"."cooldown_catalog"."excluded" IS 'true = ya no es un defensivo real (rediseñado/quitado en un parche posterior) — corrección manual, nunca la toca el extractor de WoWAnalyzer ni un resync. Se filtra en defensivesForClass/defensivesForSpec.';



COMMENT ON COLUMN "public"."cooldown_catalog"."targeting_mode" IS 'A quién puede proteger realmente el spell. external/unknown no puede atribuirse como cobertura propia sin target o aura observada.';



COMMENT ON COLUMN "public"."cooldown_catalog"."activation_mode" IS 'Forma base actual de la habilidad: active puede asignarse; passive solo se muestra como contexto y nunca entra al solver/reminder.';



COMMENT ON COLUMN "public"."cooldown_catalog"."passive_conversion_spell_ids" IS 'Talentos/pasivas cuyo spellId seleccionado convierte esta habilidad activa en pasiva o elimina su botón asignable.';



COMMENT ON COLUMN "public"."cooldown_catalog"."activation_game_build" IS 'Build para el que se verificaron activation_mode y passive_conversion_spell_ids. legacy-current conserva filas anteriores sin fingir versionado exacto.';



CREATE TABLE IF NOT EXISTS "public"."defensive_modifier_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "class" "text" NOT NULL,
    "specs" "text"[],
    "modifier_spell_id" bigint NOT NULL,
    "target_spell_id" bigint NOT NULL,
    "operation" "text" NOT NULL,
    "value" numeric NOT NULL,
    "per_rank" boolean DEFAULT false NOT NULL,
    "condition" "text" DEFAULT 'always'::"text" NOT NULL,
    "description" "text" NOT NULL,
    "source" "text",
    "verified_at" timestamp with time zone,
    "active" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "game_build" "text" DEFAULT 'legacy-current'::"text" NOT NULL,
    "effect_field" "text" DEFAULT 'cooldown_ms'::"text" NOT NULL,
    "application_order" integer DEFAULT 100 NOT NULL,
    CONSTRAINT "defensive_modifier_rules_condition_check" CHECK (("condition" = ANY (ARRAY['always'::"text", 'conditional'::"text"]))),
    CONSTRAINT "defensive_modifier_rules_effect_field_check" CHECK (("effect_field" = ANY (ARRAY['cooldown_ms'::"text", 'duration_ms'::"text", 'charges'::"text", 'recharge_ms'::"text"]))),
    CONSTRAINT "defensive_modifier_rules_game_build_check" CHECK (("btrim"("game_build") <> ''::"text")),
    CONSTRAINT "defensive_modifier_rules_operation_check" CHECK (("operation" = ANY (ARRAY['subtract_ms'::"text", 'add_ms'::"text", 'multiply'::"text", 'set_ms'::"text", 'charges_add'::"text"]))),
    CONSTRAINT "defensive_modifier_rules_operation_field_check" CHECK (((("operation" = 'charges_add'::"text") AND ("effect_field" = 'charges'::"text")) OR (("operation" <> 'charges_add'::"text") AND ("effect_field" <> 'charges'::"text"))))
);


ALTER TABLE "public"."defensive_modifier_rules" OWNER TO "postgres";


COMMENT ON TABLE "public"."defensive_modifier_rules" IS 'Reglas declarativas de talentos/pasivas que cambian cooldown, duración o cargas del defensivo. Las conditional no deben asumirse como reducción garantizada.';



COMMENT ON COLUMN "public"."defensive_modifier_rules"."game_build" IS 'Build exacto X.Y.Z.build de la regla. legacy-current conserva research v5 previo al versionado y nunca equivale a una coincidencia histórica verificada.';



COMMENT ON COLUMN "public"."defensive_modifier_rules"."effect_field" IS 'Campo efectivo modificado: cooldown_ms, duration_ms, charges o recharge_ms.';



COMMENT ON COLUMN "public"."defensive_modifier_rules"."application_order" IS 'Orden declarativo dentro de un mismo defensivo/build. Empates se resuelven por precedencia de operación e id; sets incompatibles degradan confidence a uncertain.';



CREATE TABLE IF NOT EXISTS "public"."defensive_plan_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "window_key" "text" NOT NULL,
    "planned_time_ms" integer NOT NULL,
    "impact_score" numeric DEFAULT 0 NOT NULL,
    "priority" smallint,
    "ability_ids" bigint[] NOT NULL,
    "ability_names" "text"[] NOT NULL,
    "primary_ability_id" bigint NOT NULL,
    "occurrence_index" integer NOT NULL,
    "defensive_spell_id" bigint NOT NULL,
    "effective_cooldown_ms" integer NOT NULL,
    "cooldown_explanation" "text" NOT NULL,
    "prewarn_seconds" integer DEFAULT 5 NOT NULL,
    "trigger_type" "text" DEFAULT 'bossmod'::"text" NOT NULL,
    "bossmod_spell_id" bigint,
    "bossmod_counter" integer,
    "locked" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "defensive_plan_assignments_effective_cooldown_ms_check" CHECK (("effective_cooldown_ms" >= 0)),
    CONSTRAINT "defensive_plan_assignments_occurrence_index_check" CHECK (("occurrence_index" > 0)),
    CONSTRAINT "defensive_plan_assignments_planned_time_ms_check" CHECK (("planned_time_ms" >= 0)),
    CONSTRAINT "defensive_plan_assignments_priority_check" CHECK ((("priority" >= 1) AND ("priority" <= 5))),
    CONSTRAINT "defensive_plan_assignments_trigger_type_check" CHECK (("trigger_type" = ANY (ARRAY['bossmod'::"text", 'time'::"text"])))
);


ALTER TABLE "public"."defensive_plan_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."defensive_plan_members" (
    "plan_version_id" "uuid" NOT NULL,
    "player_key" "text" NOT NULL,
    "character_id" bigint,
    "player_name" "text" NOT NULL,
    "class" "text" NOT NULL,
    "spec" "text",
    "role" "text",
    "raid_group" smallint,
    "build_fingerprint" "text",
    "game_build" "text",
    "build_observed_at" timestamp with time zone,
    "build_confidence" "text" NOT NULL,
    "included" boolean DEFAULT true NOT NULL,
    "resolver_version" "text" NOT NULL,
    "effective_kit" "jsonb" NOT NULL,
    "provenance" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "defensive_plan_members_build_confidence_check" CHECK (("build_confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "defensive_plan_members_effective_kit_check" CHECK (("jsonb_typeof"("effective_kit") = 'array'::"text")),
    CONSTRAINT "defensive_plan_members_provenance_check" CHECK (("jsonb_typeof"("provenance") = 'object'::"text")),
    CONSTRAINT "defensive_plan_members_raid_group_check" CHECK ((("raid_group" >= 1) AND ("raid_group" <= 8))),
    CONSTRAINT "defensive_plan_members_role_check" CHECK (("role" = ANY (ARRAY['tank'::"text", 'healer'::"text", 'dps'::"text"])))
);


ALTER TABLE "public"."defensive_plan_members" OWNER TO "postgres";


COMMENT ON TABLE "public"."defensive_plan_members" IS 'Snapshot del roster y kit efectivo que el solver vio. Nunca se resuelve de nuevo dentro de un plan publicado.';



CREATE TABLE IF NOT EXISTS "public"."defensive_plan_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "character_id" bigint NOT NULL,
    "player_name" "text" NOT NULL,
    "class" "text" NOT NULL,
    "spec" "text" NOT NULL,
    "talent_spell_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    "loadout_hash" "text" NOT NULL,
    "loadout_observed_at" timestamp with time zone,
    "catalog_version" timestamp with time zone,
    "mechanic_profile_version" timestamp with time zone,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."defensive_plan_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."defensive_plan_slots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_version_id" "uuid" NOT NULL,
    "ability_id" bigint NOT NULL,
    "occurrence_index" integer NOT NULL,
    "slot_index" integer DEFAULT 1 NOT NULL,
    "occurrence_time_ms" integer NOT NULL,
    "window_start_ms" integer NOT NULL,
    "window_end_ms" integer NOT NULL,
    "priority" smallint,
    "requirement_level" "text" NOT NULL,
    "demand_type" "text" NOT NULL,
    "coverage_status" "text" NOT NULL,
    "assigned_player_key" "text",
    "target_player_key" "text",
    "defensive_spell_id" bigint,
    "planned_cast_at_ms" integer,
    "prewarn_ms" integer DEFAULT 5000 NOT NULL,
    "source" "text" NOT NULL,
    "locked" boolean DEFAULT false NOT NULL,
    "emergency_reserved" boolean DEFAULT false NOT NULL,
    "confidence" "text" NOT NULL,
    "trigger_mode" "text" DEFAULT 'time'::"text" NOT NULL,
    "bossmod_spell_id" bigint,
    "bossmod_counter" "text",
    "bossmod_counter_verified" boolean DEFAULT false NOT NULL,
    "assigned_groups" smallint[],
    "effective_cooldown_ms_snapshot" integer,
    "effective_duration_ms_snapshot" integer,
    "charges_snapshot" smallint,
    "build_fingerprint_snapshot" "text",
    "notes" "text",
    "rationale" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "mechanic_key" "text",
    "source_policy_version" integer,
    CONSTRAINT "defensive_plan_slots_ability_id_check" CHECK (("ability_id" > 0)),
    CONSTRAINT "defensive_plan_slots_assigned_groups_check" CHECK ((("assigned_groups" IS NULL) OR ("assigned_groups" <@ ARRAY[(1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint, (7)::smallint, (8)::smallint]))),
    CONSTRAINT "defensive_plan_slots_charges_snapshot_check" CHECK ((("charges_snapshot" IS NULL) OR ("charges_snapshot" > 0))),
    CONSTRAINT "defensive_plan_slots_check" CHECK (("window_end_ms" >= "window_start_ms")),
    CONSTRAINT "defensive_plan_slots_check1" CHECK (((("coverage_status" = ANY (ARRAY['covered'::"text", 'partial'::"text"])) AND ("assigned_player_key" IS NOT NULL) AND ("defensive_spell_id" IS NOT NULL) AND ("planned_cast_at_ms" IS NOT NULL) AND ("charges_snapshot" IS NOT NULL)) OR (("coverage_status" = ANY (ARRAY['uncovered'::"text", 'excluded'::"text"])) AND ("assigned_player_key" IS NULL) AND ("defensive_spell_id" IS NULL) AND ("planned_cast_at_ms" IS NULL) AND ("charges_snapshot" IS NULL)))),
    CONSTRAINT "defensive_plan_slots_check2" CHECK ((("trigger_mode" = 'time'::"text") OR ("bossmod_spell_id" IS NOT NULL))),
    CONSTRAINT "defensive_plan_slots_check3" CHECK (((NOT "bossmod_counter_verified") OR ("trigger_mode" = 'bossmod'::"text"))),
    CONSTRAINT "defensive_plan_slots_confidence_check" CHECK (("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "defensive_plan_slots_coverage_status_check" CHECK (("coverage_status" = ANY (ARRAY['covered'::"text", 'partial'::"text", 'uncovered'::"text", 'excluded'::"text"]))),
    CONSTRAINT "defensive_plan_slots_defensive_spell_id_check" CHECK (("defensive_spell_id" > 0)),
    CONSTRAINT "defensive_plan_slots_demand_type_check" CHECK (("demand_type" = ANY (ARRAY['raid'::"text", 'personal'::"text", 'tank'::"text", 'external'::"text", 'utility'::"text"]))),
    CONSTRAINT "defensive_plan_slots_effective_cooldown_ms_snapshot_check" CHECK ((("effective_cooldown_ms_snapshot" IS NULL) OR ("effective_cooldown_ms_snapshot" >= 0))),
    CONSTRAINT "defensive_plan_slots_effective_duration_ms_snapshot_check" CHECK ((("effective_duration_ms_snapshot" IS NULL) OR ("effective_duration_ms_snapshot" >= 0))),
    CONSTRAINT "defensive_plan_slots_occurrence_index_check" CHECK (("occurrence_index" > 0)),
    CONSTRAINT "defensive_plan_slots_occurrence_time_ms_check" CHECK (("occurrence_time_ms" >= 0)),
    CONSTRAINT "defensive_plan_slots_planned_cast_at_ms_check" CHECK (("planned_cast_at_ms" >= 0)),
    CONSTRAINT "defensive_plan_slots_prewarn_ms_check" CHECK (("prewarn_ms" >= 0)),
    CONSTRAINT "defensive_plan_slots_priority_check" CHECK ((("priority" >= 1) AND ("priority" <= 5))),
    CONSTRAINT "defensive_plan_slots_rationale_check" CHECK (("jsonb_typeof"("rationale") = 'object'::"text")),
    CONSTRAINT "defensive_plan_slots_requirement_level_check" CHECK (("requirement_level" = ANY (ARRAY['required'::"text", 'recommended'::"text", 'optional'::"text"]))),
    CONSTRAINT "defensive_plan_slots_slot_index_check" CHECK (("slot_index" > 0)),
    CONSTRAINT "defensive_plan_slots_source_check" CHECK (("source" = ANY (ARRAY['automatic'::"text", 'manual'::"text", 'locked'::"text", 'emergency'::"text", 'fallback'::"text"]))),
    CONSTRAINT "defensive_plan_slots_source_policy_version_check" CHECK ((("source_policy_version" IS NULL) OR ("source_policy_version" > 0))),
    CONSTRAINT "defensive_plan_slots_trigger_mode_check" CHECK (("trigger_mode" = ANY (ARRAY['time'::"text", 'bossmod'::"text"]))),
    CONSTRAINT "defensive_plan_slots_window_start_ms_check" CHECK (("window_start_ms" >= 0))
);


ALTER TABLE "public"."defensive_plan_slots" OWNER TO "postgres";


COMMENT ON TABLE "public"."defensive_plan_slots" IS 'Asignaciones desplegadas por occurrence. Es la única fuente válida para MRT v2 y evaluator v2.';



CREATE TABLE IF NOT EXISTS "public"."defensive_reanalysis_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reason" "text" NOT NULL,
    "scope" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "total_jobs" integer NOT NULL,
    "completed_jobs" integer DEFAULT 0 NOT NULL,
    "failed_jobs" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "defensive_reanalysis_batches_completed_jobs_check" CHECK (("completed_jobs" >= 0)),
    CONSTRAINT "defensive_reanalysis_batches_failed_jobs_check" CHECK (("failed_jobs" >= 0)),
    CONSTRAINT "defensive_reanalysis_batches_reason_check" CHECK (("btrim"("reason") <> ''::"text")),
    CONSTRAINT "defensive_reanalysis_batches_scope_check" CHECK (("jsonb_typeof"("scope") = 'object'::"text")),
    CONSTRAINT "defensive_reanalysis_batches_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'completed'::"text", 'completed_with_errors'::"text"]))),
    CONSTRAINT "defensive_reanalysis_batches_total_jobs_check" CHECK (("total_jobs" >= 0))
);


ALTER TABLE "public"."defensive_reanalysis_batches" OWNER TO "postgres";


COMMENT ON TABLE "public"."defensive_reanalysis_batches" IS 'Motivo y progreso durable de un backfill defensivo. No ejecuta trabajo dentro de SQL.';



CREATE TABLE IF NOT EXISTS "public"."defensive_reanalysis_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "attempts" smallint DEFAULT 0 NOT NULL,
    "last_error" "text",
    "claimed_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "defensive_reanalysis_jobs_attempts_check" CHECK (("attempts" >= 0)),
    CONSTRAINT "defensive_reanalysis_jobs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'done'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."defensive_reanalysis_jobs" OWNER TO "postgres";


COMMENT ON TABLE "public"."defensive_reanalysis_jobs" IS 'Una unidad reintentable por pull. El cliente/worker invoca una Edge Function por fila para respetar el límite de CPU.';



CREATE TABLE IF NOT EXISTS "public"."defensive_spec_profiles" (
    "class" "text" NOT NULL,
    "spec" "text" NOT NULL,
    "spell_id" bigint NOT NULL,
    "base_cooldown_ms" integer,
    "base_duration_ms" integer,
    "charges" smallint DEFAULT 1 NOT NULL,
    "source" "text",
    "source_note" "text",
    "synced_from_commit" "text",
    "verified_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "game_build" "text" DEFAULT 'legacy-current'::"text" NOT NULL,
    "recharge_ms" integer,
    CONSTRAINT "defensive_spec_profiles_charges_check" CHECK (("charges" > 0)),
    CONSTRAINT "defensive_spec_profiles_game_build_check" CHECK (("btrim"("game_build") <> ''::"text")),
    CONSTRAINT "defensive_spec_profiles_recharge_ms_check" CHECK ((("recharge_ms" IS NULL) OR ("recharge_ms" >= 0)))
);


ALTER TABLE "public"."defensive_spec_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."defensive_spec_profiles" IS 'Comportamiento base de un defensivo para una spec concreta. Gana sobre cooldown_catalog cuando una spec tenga un valor realmente distinto.';



COMMENT ON COLUMN "public"."defensive_spec_profiles"."game_build" IS 'Build exacto X.Y.Z.build al que pertenece el perfil. legacy-current = fila v5 anterior al versionado; solo puede consumirse como fallback con provenance.';



COMMENT ON COLUMN "public"."defensive_spec_profiles"."recharge_ms" IS 'Tiempo de recarga por carga cuando difiere del cooldown conceptual. Null = usar el cooldown efectivo como recharge.';



CREATE TABLE IF NOT EXISTS "public"."discord_roster_channels" (
    "character_id" bigint NOT NULL,
    "character_name" "text" NOT NULL,
    "discord_user_id" "text" NOT NULL,
    "discord_display_name" "text",
    "discord_channel_id" "text",
    "is_officer" boolean DEFAULT false NOT NULL,
    "linked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "channel_synced_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."discord_roster_channels" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."discord_roster_channels_settings" (
    "id" boolean DEFAULT true NOT NULL,
    "category_id" "text",
    "officers_role_id" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "discord_roster_channels_settings_id_check" CHECK ("id")
);


ALTER TABLE "public"."discord_roster_channels_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."known_raid_bosses" (
    "encounter_id" bigint NOT NULL,
    "boss_name" "text" NOT NULL,
    "zone_id" bigint NOT NULL,
    "zone_name" "text" NOT NULL,
    "journal_encounter_id" bigint,
    "order_index" integer,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."known_raid_bosses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."llm_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "purpose" "text" NOT NULL,
    "model" "text" NOT NULL,
    "input_tokens" integer DEFAULT 0 NOT NULL,
    "output_tokens" integer DEFAULT 0 NOT NULL,
    "cost_usd" numeric(10,6) DEFAULT 0 NOT NULL,
    "status" "text" NOT NULL,
    "block_reason" "text",
    CONSTRAINT "llm_calls_status_check" CHECK (("status" = ANY (ARRAY['ok'::"text", 'blocked'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."llm_calls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mechanic_defensive_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "ability_id" bigint NOT NULL,
    "class" "text" NOT NULL,
    "spec" "text" NOT NULL,
    "defensive_spell_id" bigint NOT NULL,
    "prewarn_seconds" integer DEFAULT 5 NOT NULL,
    "trigger_type" "text" DEFAULT 'bossmod'::"text" NOT NULL,
    "bossmod_spell_id" bigint,
    "notes" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assigned_groups" smallint[],
    CONSTRAINT "mechanic_defensive_assignments_trigger_type_check" CHECK (("trigger_type" = ANY (ARRAY['bossmod'::"text", 'time'::"text"])))
);


ALTER TABLE "public"."mechanic_defensive_assignments" OWNER TO "postgres";


COMMENT ON COLUMN "public"."mechanic_defensive_assignments"."assigned_groups" IS 'Grupos de raid (1-6) a los que aplica esta asignación — null = todos/sin restringir. Solo informativo (se refleja en el texto del reminder exportado), MRT no filtra por esto.';



CREATE TABLE IF NOT EXISTS "public"."mechanic_responsibility_edges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "occurrence_id" "uuid" NOT NULL,
    "player_name" "text" NOT NULL,
    "actor_id" bigint,
    "relationship" "text" NOT NULL,
    "damage_caused" bigint DEFAULT 0 NOT NULL,
    "damage_taken" bigint DEFAULT 0 NOT NULL,
    "victim_count" integer DEFAULT 0 NOT NULL,
    "credit_eligible" boolean DEFAULT false NOT NULL,
    "penalty_eligible" boolean DEFAULT false NOT NULL,
    "reason_code" "text" NOT NULL,
    "confidence" "text" NOT NULL,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "mechanic_responsibility_edges_actor_id_check" CHECK ((("actor_id" IS NULL) OR ("actor_id" > 0))),
    CONSTRAINT "mechanic_responsibility_edges_check" CHECK (((NOT "penalty_eligible") OR ("relationship" = ANY (ARRAY['primary_owner'::"text", 'co_owner'::"text", 'assigned_resolver'::"text"])))),
    CONSTRAINT "mechanic_responsibility_edges_check1" CHECK (((NOT "penalty_eligible") OR ("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text"])))),
    CONSTRAINT "mechanic_responsibility_edges_check2" CHECK ((("relationship" <> 'collateral_victim'::"text") OR (NOT "penalty_eligible"))),
    CONSTRAINT "mechanic_responsibility_edges_confidence_check" CHECK (("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "mechanic_responsibility_edges_damage_caused_check" CHECK (("damage_caused" >= 0)),
    CONSTRAINT "mechanic_responsibility_edges_damage_taken_check" CHECK (("damage_taken" >= 0)),
    CONSTRAINT "mechanic_responsibility_edges_evidence_check" CHECK (("jsonb_typeof"("evidence") = 'object'::"text")),
    CONSTRAINT "mechanic_responsibility_edges_player_name_check" CHECK ((NULLIF("btrim"("player_name"), ''::"text") IS NOT NULL)),
    CONSTRAINT "mechanic_responsibility_edges_reason_code_check" CHECK ((NULLIF("btrim"("reason_code"), ''::"text") IS NOT NULL)),
    CONSTRAINT "mechanic_responsibility_edges_relationship_check" CHECK (("relationship" = ANY (ARRAY['primary_owner'::"text", 'co_owner'::"text", 'assigned_resolver'::"text", 'successful_resolver'::"text", 'target'::"text", 'collateral_victim'::"text", 'beneficiary'::"text"]))),
    CONSTRAINT "mechanic_responsibility_edges_victim_count_check" CHECK (("victim_count" >= 0))
);


ALTER TABLE "public"."mechanic_responsibility_edges" OWNER TO "postgres";


COMMENT ON TABLE "public"."mechanic_responsibility_edges" IS 'Grafo materializado owner/assignee/resolver/target/víctima. credit_eligible y penalty_eligible son decisiones independientes.';



CREATE TABLE IF NOT EXISTS "public"."night_briefs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_code" "text" NOT NULL,
    "headline" "text" NOT NULL,
    "improved" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "regressed" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "next_pull_actions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "model" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."night_briefs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."night_full_reports" (
    "report_code" "text" NOT NULL,
    "report" "jsonb" NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."night_full_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."night_player_briefs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_code" "text" NOT NULL,
    "player_name" "text" NOT NULL,
    "headline" "text" NOT NULL,
    "improved" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "regressed" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "next_pull_actions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "model" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."night_player_briefs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."player_execution_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "player_name" "text" NOT NULL,
    "occurrence_id" "uuid",
    "causal_group_id" "uuid" NOT NULL,
    "timestamp_ms" integer NOT NULL,
    "domain" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "verdict" "text" NOT NULL,
    "reason_code" "text" NOT NULL,
    "credit_eligible" boolean DEFAULT false NOT NULL,
    "penalty_eligible" boolean DEFAULT false NOT NULL,
    "primary_penalty" boolean DEFAULT false NOT NULL,
    "severity" numeric,
    "priority" smallint,
    "confidence" "text" NOT NULL,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "policy_version" integer,
    "context_resolver_version" "text" NOT NULL,
    "occurrence_resolver_version" "text",
    "ledger_evaluator_version" "text" NOT NULL,
    "deduplication_key" "text" NOT NULL,
    "evaluated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "player_execution_events_check" CHECK (((NOT "primary_penalty") OR "penalty_eligible")),
    CONSTRAINT "player_execution_events_check1" CHECK (((NOT "penalty_eligible") OR ("verdict" = ANY (ARRAY['failure'::"text", 'missed'::"text"])))),
    CONSTRAINT "player_execution_events_check2" CHECK (((NOT "penalty_eligible") OR ("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text"])))),
    CONSTRAINT "player_execution_events_check3" CHECK ((("verdict" <> 'uncertain'::"text") OR ((NOT "credit_eligible") AND (NOT "penalty_eligible")))),
    CONSTRAINT "player_execution_events_check4" CHECK ((("verdict" <> ALL (ARRAY['context'::"text", 'not_applicable'::"text"])) OR (NOT "penalty_eligible"))),
    CONSTRAINT "player_execution_events_check5" CHECK ((("reason_code" <> 'AVAILABILITY_UNKNOWN'::"text") OR (NOT "penalty_eligible"))),
    CONSTRAINT "player_execution_events_check6" CHECK ((("occurrence_id" IS NULL) = ("occurrence_resolver_version" IS NULL))),
    CONSTRAINT "player_execution_events_confidence_check" CHECK (("confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "player_execution_events_context_resolver_version_check" CHECK ((NULLIF("btrim"("context_resolver_version"), ''::"text") IS NOT NULL)),
    CONSTRAINT "player_execution_events_deduplication_key_check" CHECK ((NULLIF("btrim"("deduplication_key"), ''::"text") IS NOT NULL)),
    CONSTRAINT "player_execution_events_domain_check" CHECK (("domain" = ANY (ARRAY['mechanic'::"text", 'defensive'::"text", 'external'::"text", 'consumable'::"text", 'interrupt'::"text", 'dispel'::"text", 'utility'::"text", 'death'::"text", 'preparation'::"text"]))),
    CONSTRAINT "player_execution_events_event_type_check" CHECK ((NULLIF("btrim"("event_type"), ''::"text") IS NOT NULL)),
    CONSTRAINT "player_execution_events_evidence_check" CHECK (("jsonb_typeof"("evidence") = 'object'::"text")),
    CONSTRAINT "player_execution_events_ledger_evaluator_version_check" CHECK ((NULLIF("btrim"("ledger_evaluator_version"), ''::"text") IS NOT NULL)),
    CONSTRAINT "player_execution_events_occurrence_resolver_version_check" CHECK ((("occurrence_resolver_version" IS NULL) OR (NULLIF("btrim"("occurrence_resolver_version"), ''::"text") IS NOT NULL))),
    CONSTRAINT "player_execution_events_player_name_check" CHECK ((NULLIF("btrim"("player_name"), ''::"text") IS NOT NULL)),
    CONSTRAINT "player_execution_events_policy_version_check" CHECK ((("policy_version" IS NULL) OR ("policy_version" > 0))),
    CONSTRAINT "player_execution_events_priority_check" CHECK ((("priority" IS NULL) OR (("priority" >= 1) AND ("priority" <= 5)))),
    CONSTRAINT "player_execution_events_reason_code_check" CHECK (("reason_code" = ANY (ARRAY['SPREAD_CARRIER_COLLATERAL'::"text", 'ASSIGNED_SOAK_MISSED'::"text", 'PERSONAL_GROUND_HIT'::"text", 'TANK_FRONTAL_HIT_RAID'::"text", 'TANK_SWAP_THRESHOLD_BREACH'::"text", 'ASSIGNED_INTERRUPT_MISSED'::"text", 'RAID_INTERRUPT_MISSED'::"text", 'VOLUNTEER_MECHANIC_RESOLVED'::"text", 'VOLUNTEER_MECHANIC_UNRESOLVED'::"text", 'SELF_FAILURE_DEATH'::"text", 'COLLATERAL_DEATH'::"text", 'UNAVOIDABLE_PRESSURE_DEATH'::"text", 'POST_WIPE_DEATH'::"text", 'UNCERTAIN_CAUSE'::"text", 'PLAN_COVERED'::"text", 'CORRECT_HOLD'::"text", 'REMINDER_MISSED'::"text", 'DEATH_VIABLE_CD'::"text", 'VIABLE_CD_NON_PUNITIVE'::"text", 'TARGET_MISMATCH'::"text", 'SAFE_EXTRA_USE'::"text", 'PREPOT_USED'::"text", 'PREPOT_MISSED_VERIFIED'::"text", 'HEALTHSTONE_REACTIVE'::"text", 'HEALTHSTONE_VIABLE_NOT_USED'::"text", 'HEALTH_POTION_REACTIVE'::"text", 'AVAILABILITY_UNKNOWN'::"text"]))),
    CONSTRAINT "player_execution_events_severity_check" CHECK ((("severity" IS NULL) OR (("severity" >= (0)::numeric) AND ("severity" <= (100)::numeric)))),
    CONSTRAINT "player_execution_events_timestamp_ms_check" CHECK (("timestamp_ms" >= 0)),
    CONSTRAINT "player_execution_events_verdict_check" CHECK (("verdict" = ANY (ARRAY['success'::"text", 'failure'::"text", 'correct_hold'::"text", 'missed'::"text", 'context'::"text", 'not_applicable'::"text", 'uncertain'::"text"])))
);


ALTER TABLE "public"."player_execution_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."player_execution_events" IS 'Ledger v3 idempotente de decisiones por jugador. Solo filas penalty_eligible con confidence trusted pueden alimentar scoring futuro.';



CREATE OR REPLACE VIEW "public"."night_player_execution_summary_v3" WITH ("security_invoker"='true') AS
 SELECT "p"."report_code",
    "e"."player_name",
    ("count"(DISTINCT "e"."pull_id"))::integer AS "pull_count",
    ("count"(*))::integer AS "event_count",
    ("count"(*) FILTER (WHERE "e"."credit_eligible"))::integer AS "credit_count",
    ("count"(*) FILTER (WHERE "e"."penalty_eligible"))::integer AS "penalty_count",
    ("count"(*) FILTER (WHERE "e"."primary_penalty"))::integer AS "primary_penalty_count",
    ("count"(*) FILTER (WHERE ("e"."verdict" = 'uncertain'::"text")))::integer AS "uncertain_count",
    "array_agg"(DISTINCT "e"."ledger_evaluator_version" ORDER BY "e"."ledger_evaluator_version") AS "ledger_evaluator_versions",
    "array_agg"(DISTINCT "e"."context_resolver_version" ORDER BY "e"."context_resolver_version") AS "context_resolver_versions",
    "array_agg"(DISTINCT "e"."occurrence_resolver_version" ORDER BY "e"."occurrence_resolver_version") FILTER (WHERE ("e"."occurrence_resolver_version" IS NOT NULL)) AS "occurrence_resolver_versions",
    "array_agg"(DISTINCT "e"."policy_version" ORDER BY "e"."policy_version") FILTER (WHERE ("e"."policy_version" IS NOT NULL)) AS "policy_versions",
    (("count"(DISTINCT "e"."ledger_evaluator_version") = 1) AND ("count"(DISTINCT "e"."context_resolver_version") = 1) AND ("count"(DISTINCT "e"."occurrence_resolver_version") FILTER (WHERE ("e"."occurrence_resolver_version" IS NOT NULL)) <= 1) AND ("count"(DISTINCT "e"."policy_version") FILTER (WHERE ("e"."policy_version" IS NOT NULL)) <= 1)) AS "versions_homogeneous",
    "max"("e"."evaluated_at") AS "evaluated_at"
   FROM ("public"."player_execution_events" "e"
     JOIN "public"."pulls" "p" ON (("p"."id" = "e"."pull_id")))
  GROUP BY "p"."report_code", "e"."player_name";


ALTER VIEW "public"."night_player_execution_summary_v3" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."night_player_infographics" (
    "report_code" "text" NOT NULL,
    "player_name" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."night_player_infographics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."player_pull_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "player_name" "text" NOT NULL,
    "died" boolean DEFAULT false NOT NULL,
    "death_cause" "jsonb",
    "defensive_events" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "avoidable_damage_taken" bigint DEFAULT 0 NOT NULL,
    "mechanic_damage" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dps" numeric,
    "hps" numeric,
    "absorbed_damage_taken" bigint DEFAULT 0 NOT NULL,
    "talent_build" "jsonb",
    "equipped_items" "jsonb",
    "class" "text",
    "spec" "text",
    "defensive_casts" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "consumables" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "world_rank_percent" numeric,
    "world_total_parses" integer,
    "wipe_call_cluster" boolean DEFAULT false NOT NULL,
    "defensive_pressure_windows" "jsonb",
    "talent_build_fingerprint" "text",
    "game_build" "text",
    "game_build_source" "text",
    "game_build_confidence" "text" DEFAULT 'uncertain'::"text" NOT NULL,
    "defensive_resolution_version" "text",
    "defensive_resolution_shadow" "jsonb",
    "death_defensive_options_v2" "jsonb",
    "defensive_pressure_windows_v2" "jsonb",
    "defensive_resolution_evaluated_at" timestamp with time zone,
    CONSTRAINT "player_pull_records_death_defensive_options_v2_check" CHECK ((("death_defensive_options_v2" IS NULL) OR ("jsonb_typeof"("death_defensive_options_v2") = 'array'::"text"))),
    CONSTRAINT "player_pull_records_defensive_pressure_windows_v2_check" CHECK ((("defensive_pressure_windows_v2" IS NULL) OR ("jsonb_typeof"("defensive_pressure_windows_v2") = 'object'::"text"))),
    CONSTRAINT "player_pull_records_game_build_confidence_check" CHECK (("game_build_confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"])))
);


ALTER TABLE "public"."player_pull_records" OWNER TO "postgres";


COMMENT ON COLUMN "public"."player_pull_records"."dps" IS 'DamageDone total del jugador / duración del pull en segundos. Simplificación conocida: usa duración total del pull, no "active time" (WCL descuenta huecos sin objetivo válido) — por eso puede quedar algo por debajo del DPS que enseña la propia web de WCL.';



COMMENT ON COLUMN "public"."player_pull_records"."hps" IS 'Healing total (incluye overheal) del jugador / duración del pull en segundos. Mismo matiz de active time que dps.';



COMMENT ON COLUMN "public"."player_pull_records"."absorbed_damage_taken" IS 'Suma del campo `absorbed` de los eventos DamageTaken de este jugador — daño que un escudo evitó, no daño recibido.';



COMMENT ON COLUMN "public"."player_pull_records"."talent_build" IS 'Array de talentos tal cual viene de events(dataType: CombatantInfo) de WCL para este jugador en este fight.';



COMMENT ON COLUMN "public"."player_pull_records"."equipped_items" IS 'Array de gear (incluye trinkets) tal cual viene de events(dataType: CombatantInfo) de WCL para este jugador en este fight.';



COMMENT ON COLUMN "public"."player_pull_records"."class" IS 'actor.subType de WCL para este jugador en este fight.';



COMMENT ON COLUMN "public"."player_pull_records"."spec" IS 'Nombre de spec resuelto contra Blizzard Game Data (/data/wow/playable-specialization/{specID}) a partir de combatantInfo.specID. Null si WCL no dio combatantInfo para este jugador.';



COMMENT ON COLUMN "public"."player_pull_records"."defensive_casts" IS '[{ spellId, name, timestampsMs: number[] }] — CADA cast de cada defensivo del catálogo de su clase durante el pull completo, no solo el que estaba activo al morir. timestampsMs relativo al inicio del pull (mismo espacio que trigger_time_ms).';



COMMENT ON COLUMN "public"."player_pull_records"."consumables" IS '{ healthstone: { available, used, count, timestampsMs }, healthPotion: { used, count, timestampsMs } }. `available` de healthstone = había algún Warlock en la raid de este pull (Blizzard permite que cualquiera lleve la suya si la crafteó, pero la señal fiable sin adivinar es esta: si NO hay warlock y el jugador no la usó, no se puede asegurar que la tuviera disponible, así que available queda false en ese caso en vez de asumir que sí la tenía).';



COMMENT ON COLUMN "public"."player_pull_records"."world_rank_percent" IS 'Percentil real (0-100) de WCL para este jugador en este pull concreto (Report.rankings) — comparado contra el resto del mundo con su misma clase/spec en este boss+dificultad. Null si WCL no pudo rankear el pull (ej. log privado sin permiso de ranking, o boss no rankeable todavía) — best-effort, nunca bloquea el resto del análisis.';



COMMENT ON COLUMN "public"."player_pull_records"."world_total_parses" IS 'Tamaño de la muestra sobre la que se calculó world_rank_percent — un percentil sobre 40 parses no pesa igual que uno sobre 15000.';



COMMENT ON COLUMN "public"."player_pull_records"."wipe_call_cluster" IS 'true = esta muerte formó parte del cluster de "posible wipe call" detectado para el pull. No implica que esté excluida de las estadísticas — eso lo decide pulls.wipe_call_excluded, editable aparte.';



COMMENT ON COLUMN "public"."player_pull_records"."defensive_pressure_windows" IS 'DEPRECATED como autoridad: contrato v1 de compatibilidad. Nuevos cálculos se proyectan desde defensive_pressure_windows_v2; coverable no puntúa.';



COMMENT ON COLUMN "public"."player_pull_records"."talent_build_fingerprint" IS 'SHA-256 determinista de class+spec+game_build+nodos normalizados. Null en histórico pendiente de backfill o cuando el build no es identificable.';



COMMENT ON COLUMN "public"."player_pull_records"."game_build" IS 'Build exacto X.Y.Z.build usado para resolver este snapshot. No confundir con WCL masterData.gameVersion, que solo distingue Retail/Classic.';



COMMENT ON COLUMN "public"."player_pull_records"."game_build_source" IS 'Provenance del game_build (por ejemplo Blizzard namespace observado al importar o backfill por timeline de patches).';



COMMENT ON COLUMN "public"."player_pull_records"."game_build_confidence" IS 'Confianza de la asociación pull→game_build. uncertain excluye decisiones dependientes de reglas del scoring estricto.';



COMMENT ON COLUMN "public"."player_pull_records"."defensive_resolution_version" IS 'Versión del resolver usada al materializar death_cause/pressure metadata. Null = pipeline legacy.';



COMMENT ON COLUMN "public"."player_pull_records"."defensive_resolution_shadow" IS 'Diagnóstico no autoritativo del resolver v2 (kit, provenance y diferencias). Nunca sustituye scoring legacy por sí solo.';



COMMENT ON COLUMN "public"."player_pull_records"."death_defensive_options_v2" IS 'Estado defensivo autoritativo por resolver/state engine v2; death_cause.defensiveOptions es solo proyección legacy.';



COMMENT ON COLUMN "public"."player_pull_records"."defensive_pressure_windows_v2" IS 'Sensor v2 resuelto por build/talentos/cargas. availableOpportunity es diagnóstico; solo player_pull_defensive_evaluations decide y puntúa.';



COMMENT ON COLUMN "public"."player_pull_records"."defensive_resolution_evaluated_at" IS 'Fecha de materialización v2; junto a defensive_resolution_version y game_build permite auditar/backfillear derivados.';



CREATE OR REPLACE VIEW "public"."own_mechanic_hit_ratios" WITH ("security_invoker"='true') AS
 SELECT "pme"."pull_id",
    "pme"."ability_id",
    "p"."boss_id",
    "p"."difficulty",
    "pme"."players_hit",
    "raid"."raid_size",
    (("pme"."players_hit")::numeric / (NULLIF("raid"."raid_size", 0))::numeric) AS "hit_ratio"
   FROM (("public"."pull_mechanic_events" "pme"
     JOIN "public"."pulls" "p" ON (("p"."id" = "pme"."pull_id")))
     JOIN LATERAL ( SELECT "count"(*) AS "raid_size"
           FROM "public"."player_pull_records" "ppr"
          WHERE ("ppr"."pull_id" = "pme"."pull_id")) "raid" ON (true))
  WHERE (("p"."wipe_pct" = (0)::numeric) AND ("pme"."category" IS DISTINCT FROM 'interrupt'::"text") AND ("raid"."raid_size" > 0));


ALTER VIEW "public"."own_mechanic_hit_ratios" OWNER TO "postgres";


COMMENT ON VIEW "public"."own_mechanic_hit_ratios" IS 'Ratio (players_hit/raidSize) de cada instancia histórica de mecánica, SOLO en pulls con kill (wipe_pct=0) — la muestra de nivel 1 (historial propio) para resolveSeverity en _shared/mechanic-severity.ts. raidSize derivado de player_pull_records porque pulls no guarda un tamaño de raid propio.';



CREATE TABLE IF NOT EXISTS "public"."player_defensive_override_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "override_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "automatic_effective_cooldown_ms" integer,
    "automatic_effective_duration_ms" integer,
    "previous_override" "jsonb",
    "resulting_override" "jsonb" NOT NULL,
    "reason" "text" NOT NULL,
    "changed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "player_defensive_override_au_automatic_effective_cooldown_check" CHECK ((("automatic_effective_cooldown_ms" IS NULL) OR ("automatic_effective_cooldown_ms" >= 0))),
    CONSTRAINT "player_defensive_override_au_automatic_effective_duration_check" CHECK ((("automatic_effective_duration_ms" IS NULL) OR ("automatic_effective_duration_ms" >= 0))),
    CONSTRAINT "player_defensive_override_audit_action_check" CHECK (("action" = ANY (ARRAY['created'::"text", 'updated'::"text", 'deactivated'::"text"]))),
    CONSTRAINT "player_defensive_override_audit_reason_check" CHECK (("btrim"("reason") <> ''::"text")),
    CONSTRAINT "player_defensive_override_audit_resulting_override_check" CHECK (("jsonb_typeof"("resulting_override") = 'object'::"text"))
);


ALTER TABLE "public"."player_defensive_override_audit" OWNER TO "postgres";


COMMENT ON TABLE "public"."player_defensive_override_audit" IS 'Historial inmutable de correcciones efectivas exactas, incluido valor automático anterior, manual resultante, autor y motivo.';



CREATE TABLE IF NOT EXISTS "public"."report_encounters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_code" "text" NOT NULL,
    "fight_id" integer NOT NULL,
    "encounter_id" bigint NOT NULL,
    "boss_name" "text" NOT NULL,
    "wcl_difficulty_id" integer,
    "kill" boolean,
    "start_time" bigint NOT NULL,
    "end_time" bigint NOT NULL
);


ALTER TABLE "public"."report_encounters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "title" "text" NOT NULL,
    "zone_id" integer,
    "zone_name" "text",
    "is_raid" boolean DEFAULT true NOT NULL,
    "start_time" bigint NOT NULL,
    "end_time" bigint,
    "last_processed_fight_id" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "possible_duplicate_of" "text"
);


ALTER TABLE "public"."reports" OWNER TO "postgres";


COMMENT ON COLUMN "public"."reports"."possible_duplicate_of" IS 'report_code de OTRO report ya importado que parece ser la misma sesión (inicio a ±6h, ≥2 bosses en común) — null = sin sospecha de duplicado. Puramente informativo, no impide nada.';



CREATE OR REPLACE VIEW "public"."player_latest_build" WITH ("security_invoker"='true') AS
 SELECT DISTINCT ON ("record"."player_name") "record"."player_name",
    "record"."class",
    "record"."spec",
    "record"."talent_build",
    "record"."talent_build_fingerprint",
    "record"."game_build",
    "record"."game_build_source",
    "record"."game_build_confidence",
    COALESCE("to_timestamp"((((("report"."start_time" + "encounter"."start_time"))::numeric / 1000.0))::double precision), "pull"."closed_at", "record"."created_at") AS "observed_at",
    "pull"."report_code",
    "record"."pull_id"
   FROM ((("public"."player_pull_records" "record"
     JOIN "public"."pulls" "pull" ON (("pull"."id" = "record"."pull_id")))
     LEFT JOIN "public"."reports" "report" ON (("report"."code" = "pull"."report_code")))
     LEFT JOIN "public"."report_encounters" "encounter" ON ((("encounter"."report_code" = "pull"."report_code") AND ("encounter"."fight_id" = "pull"."fight_id"))))
  WHERE (("record"."class" IS NOT NULL) AND ("record"."spec" IS NOT NULL))
  ORDER BY "record"."player_name", COALESCE("to_timestamp"((((("report"."start_time" + "encounter"."start_time"))::numeric / 1000.0))::double precision), "pull"."closed_at", "record"."created_at") DESC, "record"."created_at" DESC;


ALTER VIEW "public"."player_latest_build" OWNER TO "postgres";


COMMENT ON VIEW "public"."player_latest_build" IS 'Último build observado por jugador en WCL. Es la fuente de preparación futura; el build histórico de un pull sigue viviendo en player_pull_records.';



CREATE TABLE IF NOT EXISTS "public"."wowaudit_roster" (
    "character_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "realm" "text" NOT NULL,
    "class" "text" NOT NULL,
    "role" "text" NOT NULL,
    "rank" "text" NOT NULL,
    "status" "text" NOT NULL,
    "attended_amount_of_raids" integer DEFAULT 0 NOT NULL,
    "total_amount_of_raids" integer DEFAULT 0 NOT NULL,
    "attended_percentage" numeric,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "avatar_url" "text"
);


ALTER TABLE "public"."wowaudit_roster" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."player_latest_loadout" WITH ("security_invoker"='true') AS
 SELECT "r"."character_id",
    "r"."name" AS "player_name",
    "r"."realm",
    "r"."class" AS "roster_class",
    "latest"."class",
    "latest"."spec",
    "latest"."talent_build",
    "latest"."pull_id",
    "latest"."loadout_observed_at"
   FROM ("public"."wowaudit_roster" "r"
     LEFT JOIN LATERAL ( SELECT "p"."class",
            "p"."spec",
            "p"."talent_build",
            "p"."pull_id",
            "pulls"."closed_at" AS "loadout_observed_at"
           FROM ("public"."player_pull_records" "p"
             JOIN "public"."pulls" ON (("pulls"."id" = "p"."pull_id")))
          WHERE (("lower"("p"."player_name") = "lower"("r"."name")) AND ("p"."class" = "r"."class") AND ("p"."spec" IS NOT NULL) AND ("p"."talent_build" IS NOT NULL))
          ORDER BY "pulls"."closed_at" DESC, "p"."created_at" DESC
         LIMIT 1) "latest" ON (true));


ALTER VIEW "public"."player_latest_loadout" OWNER TO "postgres";


COMMENT ON VIEW "public"."player_latest_loadout" IS 'Roster canónico + spec/build de talentos más reciente observado en CombatantInfo. Fuente del Effective Defensive Resolver de Preparación.';



CREATE OR REPLACE VIEW "public"."player_latest_spec" WITH ("security_invoker"='true') AS
 SELECT DISTINCT ON ("player_name") "player_name",
    "class",
    "spec"
   FROM "public"."player_pull_records"
  WHERE (("spec" IS NOT NULL) AND ("class" IS NOT NULL))
  ORDER BY "player_name", "created_at" DESC;


ALTER VIEW "public"."player_latest_spec" OWNER TO "postgres";


COMMENT ON VIEW "public"."player_latest_spec" IS '§"cómo se clasifica la gente": una fila por jugador con su class/spec del pull MÁS RECIENTE que tenemos — wowaudit-roster.service.ts la usa para corregir el role de wowaudit cuando está desactualizado (ej. alguien que cambió a tank de main-spec y wowaudit no se actualizó).';



CREATE OR REPLACE VIEW "public"."player_mechanic_offenses" WITH ("security_invoker"='true') AS
 SELECT "p"."id" AS "pull_id",
    "p"."boss_id",
    "p"."difficulty",
    "p"."closed_at",
    "e"."category",
    "e"."ability_id",
    "e"."mechanic_name",
    "e"."outcome",
    "unnest"("e"."players_hit_names") AS "player_name"
   FROM ("public"."applicable_pull_mechanic_events" "e"
     JOIN "public"."pulls" "p" ON (("p"."id" = "e"."pull_id")))
  WHERE (("e"."category" = 'avoidable-ground'::"text") AND ("e"."avoidable" IS TRUE) AND ("e"."responsibility" = 'personal'::"text") AND ("e"."outcome" <> 'clean'::"text") AND ("array_length"("e"."players_hit_names", 1) > 0) AND (NOT "p"."ninja_pull_excluded") AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND (("e"."trigger_time_ms")::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric))));


ALTER VIEW "public"."player_mechanic_offenses" OWNER TO "postgres";


COMMENT ON VIEW "public"."player_mechanic_offenses" IS 'Una fila por jugador con un fallo individual atribuible y repetible: solo zonas de suelo confirmadas como evitables y de responsabilidad personal. Excluye daño de raid, tankbusters, responsabilidad compartida, ninja pulls y eventos posteriores a wipeCallStartMs.';



CREATE OR REPLACE VIEW "public"."player_mechanic_offenses_v3" WITH ("security_invoker"='true') AS
 SELECT "e"."id" AS "execution_event_id",
    "e"."pull_id",
    "e"."boss_id",
    "e"."difficulty",
    "e"."player_name",
    "e"."timestamp_ms",
    "e"."occurrence_id",
    "o"."mechanic_key",
    "o"."occurrence_index",
    "edge"."relationship",
    "e"."reason_code",
    "e"."severity",
    "e"."priority",
    "e"."confidence",
    "e"."evidence",
    "e"."policy_version",
    "e"."context_resolver_version",
    "e"."occurrence_resolver_version",
    "e"."ledger_evaluator_version"
   FROM (("public"."player_execution_events" "e"
     JOIN "public"."mechanic_occurrence_evaluations" "o" ON (("o"."id" = "e"."occurrence_id")))
     JOIN "public"."mechanic_responsibility_edges" "edge" ON ((("edge"."occurrence_id" = "e"."occurrence_id") AND ("edge"."player_name" = "e"."player_name") AND "edge"."penalty_eligible" AND ("edge"."relationship" = ANY (ARRAY['primary_owner'::"text", 'co_owner'::"text", 'assigned_resolver'::"text"])))))
  WHERE (("e"."domain" = 'mechanic'::"text") AND ("e"."verdict" = ANY (ARRAY['failure'::"text", 'missed'::"text"])) AND "e"."penalty_eligible");


ALTER VIEW "public"."player_mechanic_offenses_v3" OWNER TO "postgres";


COMMENT ON VIEW "public"."player_mechanic_offenses_v3" IS 'Failures mecánicos atribuibles desde ledger+responsibility graph; nunca deriva culpabilidad desde players_hit.';



CREATE TABLE IF NOT EXISTS "public"."player_pull_defensive_evaluations" (
    "pull_id" "uuid" NOT NULL,
    "player_name" "text" NOT NULL,
    "plan_version_id" "uuid",
    "mode" "text" NOT NULL,
    "game_build" "text",
    "build_fingerprint" "text",
    "resolver_version" "text" NOT NULL,
    "solver_version" "text" NOT NULL,
    "evaluator_version" "text" NOT NULL,
    "plan_required_count" integer DEFAULT 0 NOT NULL,
    "plan_executed_count" integer DEFAULT 0 NOT NULL,
    "critical_window_count" integer DEFAULT 0 NOT NULL,
    "critical_covered_count" integer DEFAULT 0 NOT NULL,
    "correct_hold_count" integer DEFAULT 0 NOT NULL,
    "broken_reservation_count" integer DEFAULT 0 NOT NULL,
    "reminder_missed_count" integer DEFAULT 0 NOT NULL,
    "viable_extra_count" integer DEFAULT 0 NOT NULL,
    "extra_used_count" integer DEFAULT 0 NOT NULL,
    "death_viable_cd_count" integer DEFAULT 0 NOT NULL,
    "management_score" numeric,
    "data_confidence" "text" NOT NULL,
    "events" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "evaluated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "player_pull_defensive_evaluation_broken_reservation_count_check" CHECK (("broken_reservation_count" >= 0)),
    CONSTRAINT "player_pull_defensive_evaluations_check" CHECK ((("plan_executed_count" >= 0) AND ("plan_executed_count" <= "plan_required_count"))),
    CONSTRAINT "player_pull_defensive_evaluations_check1" CHECK ((("critical_covered_count" >= 0) AND ("critical_covered_count" <= "critical_window_count"))),
    CONSTRAINT "player_pull_defensive_evaluations_correct_hold_count_check" CHECK (("correct_hold_count" >= 0)),
    CONSTRAINT "player_pull_defensive_evaluations_critical_window_count_check" CHECK (("critical_window_count" >= 0)),
    CONSTRAINT "player_pull_defensive_evaluations_data_confidence_check" CHECK (("data_confidence" = ANY (ARRAY['verified'::"text", 'inferred'::"text", 'fallback'::"text", 'uncertain'::"text"]))),
    CONSTRAINT "player_pull_defensive_evaluations_death_viable_cd_count_check" CHECK (("death_viable_cd_count" >= 0)),
    CONSTRAINT "player_pull_defensive_evaluations_events_check" CHECK (("jsonb_typeof"("events") = 'array'::"text")),
    CONSTRAINT "player_pull_defensive_evaluations_extra_used_count_check" CHECK (("extra_used_count" >= 0)),
    CONSTRAINT "player_pull_defensive_evaluations_management_score_check" CHECK ((("management_score" IS NULL) OR (("management_score" >= (0)::numeric) AND ("management_score" <= (100)::numeric)))),
    CONSTRAINT "player_pull_defensive_evaluations_mode_check" CHECK (("mode" = ANY (ARRAY['full'::"text", 'partial'::"text", 'no_plan'::"text"]))),
    CONSTRAINT "player_pull_defensive_evaluations_plan_required_count_check" CHECK (("plan_required_count" >= 0)),
    CONSTRAINT "player_pull_defensive_evaluations_reminder_missed_count_check" CHECK (("reminder_missed_count" >= 0)),
    CONSTRAINT "player_pull_defensive_evaluations_viable_extra_count_check" CHECK (("viable_extra_count" >= 0))
);


ALTER TABLE "public"."player_pull_defensive_evaluations" OWNER TO "postgres";


COMMENT ON TABLE "public"."player_pull_defensive_evaluations" IS 'Una fila autoritativa por jugador+pull. Conserva resultados y reason codes del replay global sin reinterpretar el plan ligado.';



COMMENT ON COLUMN "public"."player_pull_defensive_evaluations"."events" IS 'Eventos explicables con estado semántico, cobertura, adherencia, timeline y evidencia contrafactual.';



CREATE OR REPLACE VIEW "public"."player_pull_execution_summary_v3" WITH ("security_invoker"='true') AS
 SELECT "pull_id",
    "boss_id",
    "difficulty",
    "player_name",
    "ledger_evaluator_version",
    ("count"(*))::integer AS "event_count",
    ("count"(*) FILTER (WHERE "credit_eligible"))::integer AS "credit_count",
    ("count"(*) FILTER (WHERE "penalty_eligible"))::integer AS "penalty_count",
    ("count"(*) FILTER (WHERE "primary_penalty"))::integer AS "primary_penalty_count",
    ("count"(*) FILTER (WHERE ("verdict" = 'success'::"text")))::integer AS "success_count",
    ("count"(*) FILTER (WHERE ("verdict" = ANY (ARRAY['failure'::"text", 'missed'::"text"]))))::integer AS "failure_count",
    ("count"(*) FILTER (WHERE ("verdict" = 'correct_hold'::"text")))::integer AS "correct_hold_count",
    ("count"(*) FILTER (WHERE ("verdict" = 'uncertain'::"text")))::integer AS "uncertain_count",
    ("count"(*) FILTER (WHERE (("domain" = 'mechanic'::"text") AND "penalty_eligible")))::integer AS "mechanic_failure_count",
    ("count"(*) FILTER (WHERE (("domain" = ANY (ARRAY['defensive'::"text", 'external'::"text"])) AND "penalty_eligible")))::integer AS "defensive_failure_count",
    ("count"(*) FILTER (WHERE (("domain" = 'consumable'::"text") AND "penalty_eligible")))::integer AS "consumable_failure_count",
    "array_agg"(DISTINCT "context_resolver_version" ORDER BY "context_resolver_version") AS "context_resolver_versions",
    "array_agg"(DISTINCT "occurrence_resolver_version" ORDER BY "occurrence_resolver_version") FILTER (WHERE ("occurrence_resolver_version" IS NOT NULL)) AS "occurrence_resolver_versions",
    "array_agg"(DISTINCT "policy_version" ORDER BY "policy_version") FILTER (WHERE ("policy_version" IS NOT NULL)) AS "policy_versions",
    (("count"(DISTINCT "context_resolver_version") = 1) AND ("count"(DISTINCT "occurrence_resolver_version") FILTER (WHERE ("occurrence_resolver_version" IS NOT NULL)) <= 1) AND ("count"(DISTINCT "policy_version") FILTER (WHERE ("policy_version" IS NOT NULL)) <= 1)) AS "versions_homogeneous",
    "max"("evaluated_at") AS "evaluated_at"
   FROM "public"."player_execution_events" "e"
  GROUP BY "pull_id", "boss_id", "difficulty", "player_name", "ledger_evaluator_version";


ALTER VIEW "public"."player_pull_execution_summary_v3" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."player_pull_reliability_inputs_legacy_v1" WITH ("security_invoker"='true') AS
 SELECT "r"."player_name",
    "p"."id" AS "pull_id",
    "p"."boss_id",
    "p"."difficulty",
    "p"."closed_at",
    ("r"."died" AND (NOT (("r"."wipe_call_cluster" AND "p"."wipe_call_excluded") OR (COALESCE(("r"."death_cause" ->> 'statisticalExclusionReason'::"text"), ''::"text") = 'boss_melee_on_non_tank'::"text")))) AS "died",
    (EXISTS ( SELECT 1
           FROM ("public"."applicable_pull_mechanic_events" "e"
             CROSS JOIN LATERAL "jsonb_array_elements"(COALESCE("e"."player_hit_details", '[]'::"jsonb")) "detail"("value"))
          WHERE (("e"."pull_id" = "p"."id") AND ("e"."avoidable" IS TRUE) AND ("e"."outcome" <> 'clean'::"text") AND (("detail"."value" ->> 'name'::"text") = "r"."player_name") AND (COALESCE((("detail"."value" ->> 'damage_taken'::"text"))::numeric, (0)::numeric) > (0)::numeric) AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND (("e"."trigger_time_ms")::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric)))))) AS "had_avoidable_damage",
    ("r"."died" AND (NOT (("r"."wipe_call_cluster" AND "p"."wipe_call_excluded") OR (COALESCE(("r"."death_cause" ->> 'statisticalExclusionReason'::"text"), ''::"text") = 'boss_melee_on_non_tank'::"text"))) AND (("r"."death_cause" ->> 'rootCause'::"text") = 'self_positioning'::"text")) AS "self_positioning_death",
        CASE
            WHEN (("r"."wipe_call_cluster" AND "p"."wipe_call_excluded") OR (COALESCE(("r"."death_cause" ->> 'statisticalExclusionReason'::"text"), ''::"text") = 'boss_melee_on_non_tank'::"text")) THEN NULL::boolean
            WHEN ("r"."died" AND ("jsonb_array_length"(COALESCE(("r"."death_cause" -> 'defensiveOptions'::"text"), '[]'::"jsonb")) > 0)) THEN ( SELECT "bool_and"((("opt"."value" ->> 'status'::"text") <> 'available_unused'::"text")) AS "bool_and"
               FROM "jsonb_array_elements"(("r"."death_cause" -> 'defensiveOptions'::"text")) "opt"("value"))
            ELSE NULL::boolean
        END AS "used_defensive_when_died",
    (EXISTS ( SELECT 1
           FROM ("jsonb_array_elements"(COALESCE("r"."defensive_casts", '[]'::"jsonb")) "defensive"("value")
             CROSS JOIN LATERAL "jsonb_array_elements"(COALESCE(("defensive"."value" -> 'timestampsMs'::"text"), '[]'::"jsonb")) "cast_time"("value"))
          WHERE (("jsonb_typeof"("cast_time"."value") = 'number'::"text") AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND ((("cast_time"."value" #>> '{}'::"text"[]))::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric)))))) AS "used_defensive_in_pull",
    ((EXISTS ( SELECT 1
           FROM ("jsonb_array_elements"(COALESCE("r"."defensive_casts", '[]'::"jsonb")) "defensive"("value")
             CROSS JOIN LATERAL "jsonb_array_elements"(COALESCE(("defensive"."value" -> 'timestampsMs'::"text"), '[]'::"jsonb")) "cast_time"("value"))
          WHERE (("jsonb_typeof"("cast_time"."value") = 'number'::"text") AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND ((("cast_time"."value" #>> '{}'::"text"[]))::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric)))))) OR ("r"."died" AND (NOT (("r"."wipe_call_cluster" AND "p"."wipe_call_excluded") OR (COALESCE(("r"."death_cause" ->> 'statisticalExclusionReason'::"text"), ''::"text") = 'boss_melee_on_non_tank'::"text"))) AND ("jsonb_array_length"(COALESCE(("r"."death_cause" -> 'defensiveOptions'::"text"), '[]'::"jsonb")) > 0)) OR (EXISTS ( SELECT 1
           FROM ("public"."applicable_pull_mechanic_events" "e"
             CROSS JOIN LATERAL "jsonb_array_elements"(COALESCE("e"."player_hit_details", '[]'::"jsonb")) "detail"("value"))
          WHERE (("e"."pull_id" = "p"."id") AND ("e"."avoidable" IS TRUE) AND ("e"."outcome" <> 'clean'::"text") AND (("detail"."value" ->> 'name'::"text") = "r"."player_name") AND (COALESCE((("detail"."value" ->> 'damage_taken'::"text"))::numeric, (0)::numeric) > (0)::numeric) AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND (("e"."trigger_time_ms")::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric))))))) AS "defensive_use_opportunity",
    ( SELECT "count"(*) FILTER (WHERE ((COALESCE((("t"."item" ->> 'permanentEnchant'::"text"))::bigint, (0)::bigint) > 0) AND (COALESCE((("t"."item" ->> 'id'::"text"))::bigint, (0)::bigint) > 0))) AS "count"
           FROM "jsonb_array_elements"(COALESCE("r"."equipped_items", '[]'::"jsonb")) WITH ORDINALITY "t"("item", "slot")
          WHERE (("t"."slot" - 1) = ANY (ARRAY[(0)::bigint, (2)::bigint, (4)::bigint, (6)::bigint, (7)::bigint, (10)::bigint, (11)::bigint]))) AS "enchanted_slot_count",
    ( SELECT "count"(*) FILTER (WHERE (COALESCE((("t"."item" ->> 'id'::"text"))::bigint, (0)::bigint) > 0)) AS "count"
           FROM "jsonb_array_elements"(COALESCE("r"."equipped_items", '[]'::"jsonb")) WITH ORDINALITY "t"("item", "slot")
          WHERE (("t"."slot" - 1) = ANY (ARRAY[(0)::bigint, (2)::bigint, (4)::bigint, (6)::bigint, (7)::bigint, (10)::bigint, (11)::bigint]))) AS "enchantable_slot_count",
    ( SELECT COALESCE("sum"("jsonb_array_length"(COALESCE(("item"."value" -> 'gems'::"text"), '[]'::"jsonb"))), (0)::bigint) AS "coalesce"
           FROM "jsonb_array_elements"(COALESCE("r"."equipped_items", '[]'::"jsonb")) "item"("value")) AS "gem_count",
    ( SELECT "count"(*) FILTER (WHERE ((COALESCE((("t"."item" ->> 'id'::"text"))::bigint, (0)::bigint) > 0) AND ("jsonb_array_length"(COALESCE(("t"."item" -> 'gems'::"text"), '[]'::"jsonb")) > 0))) AS "count"
           FROM "jsonb_array_elements"(COALESCE("r"."equipped_items", '[]'::"jsonb")) WITH ORDINALITY "t"("item", "slot")
          WHERE (("t"."slot" - 1) = ANY (ARRAY[(1)::bigint, (10)::bigint, (11)::bigint]))) AS "gemmed_slot_count",
    ( SELECT "count"(*) FILTER (WHERE (COALESCE((("t"."item" ->> 'id'::"text"))::bigint, (0)::bigint) > 0)) AS "count"
           FROM "jsonb_array_elements"(COALESCE("r"."equipped_items", '[]'::"jsonb")) WITH ORDINALITY "t"("item", "slot")
          WHERE (("t"."slot" - 1) = ANY (ARRAY[(1)::bigint, (10)::bigint, (11)::bigint]))) AS "gemmable_slot_count",
    ( SELECT "count"(*) AS "count"
           FROM ("public"."applicable_pull_mechanic_events" "e"
             CROSS JOIN LATERAL "jsonb_array_elements"(COALESCE("e"."player_hit_details", '[]'::"jsonb")) "detail"("value"))
          WHERE (("e"."pull_id" = "p"."id") AND ("e"."category" = ANY (ARRAY['avoidable-ground'::"text", 'spread'::"text", 'soak'::"text", 'personal-target'::"text"])) AND ("e"."outcome" <> 'clean'::"text") AND (("detail"."value" ->> 'name'::"text") = "r"."player_name") AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND (("e"."trigger_time_ms")::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric))))) AS "personal_mechanic_fail_count",
    "p"."report_code",
    "p"."pull_number",
    ( SELECT "count"(*) AS "count"
           FROM "public"."applicable_pull_mechanic_events" "e"
          WHERE (("e"."pull_id" = "p"."id") AND ("e"."category" = ANY (ARRAY['avoidable-ground'::"text", 'spread'::"text"])) AND ("e"."outcome" <> 'clean'::"text") AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND (("e"."trigger_time_ms")::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric))) AND ((NOT "r"."died") OR (("jsonb_typeof"(("r"."death_cause" -> 'timeMs'::"text")) = 'number'::"text") AND ((("r"."death_cause" ->> 'timeMs'::"text"))::numeric > ("e"."trigger_time_ms")::numeric))))) AS "avoidable_mechanic_eligible_count",
    ( SELECT "count"(*) AS "count"
           FROM ("public"."applicable_pull_mechanic_events" "e"
             CROSS JOIN LATERAL "jsonb_array_elements"(COALESCE("e"."player_hit_details", '[]'::"jsonb")) "detail"("value"))
          WHERE (("e"."pull_id" = "p"."id") AND ("e"."category" = ANY (ARRAY['avoidable-ground'::"text", 'spread'::"text"])) AND ("e"."outcome" <> 'clean'::"text") AND (("detail"."value" ->> 'name'::"text") = "r"."player_name") AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND (("e"."trigger_time_ms")::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric))) AND ((NOT "r"."died") OR (("jsonb_typeof"(("r"."death_cause" -> 'timeMs'::"text")) = 'number'::"text") AND ((("r"."death_cause" ->> 'timeMs'::"text"))::numeric > ("e"."trigger_time_ms")::numeric))))) AS "avoidable_mechanic_fail_count",
    ( SELECT COALESCE("count"(*) FILTER (WHERE (("w"."value" ->> 'coverable'::"text"))::boolean), (0)::bigint) AS "coalesce"
           FROM "jsonb_array_elements"(COALESCE(("r"."defensive_pressure_windows" -> 'windows'::"text"), '[]'::"jsonb")) "w"("value")
          WHERE (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND ((("w"."value" ->> 'startMs'::"text"))::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric)))) AS "defensive_window_coverable_count",
    ( SELECT COALESCE("count"(*) FILTER (WHERE (("w"."value" ->> 'covered'::"text"))::boolean), (0)::bigint) AS "coalesce"
           FROM "jsonb_array_elements"(COALESCE(("r"."defensive_pressure_windows" -> 'windows'::"text"), '[]'::"jsonb")) "w"("value")
          WHERE (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND ((("w"."value" ->> 'startMs'::"text"))::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric)))) AS "defensive_window_covered_count",
    (EXISTS ( SELECT 1
           FROM ("jsonb_array_elements"(COALESCE("r"."defensive_casts", '[]'::"jsonb")) "defensive"("value")
             CROSS JOIN LATERAL "jsonb_array_elements"(COALESCE(("defensive"."value" -> 'timestampsMs'::"text"), '[]'::"jsonb")) "cast_time"("value"))
          WHERE (("jsonb_typeof"("cast_time"."value") = 'number'::"text") AND (NOT ("p"."wipe_call_excluded" AND ("p"."wipe_call_signals" IS NOT NULL) AND ("jsonb_typeof"(("p"."wipe_call_signals" -> 'wipeCallStartMs'::"text")) = 'number'::"text") AND ((("cast_time"."value" #>> '{}'::"text"[]))::numeric >= (("p"."wipe_call_signals" ->> 'wipeCallStartMs'::"text"))::numeric)))))) AS "defensive_window_used_anything",
    "r"."defensive_pressure_windows",
    ( SELECT "count"(*) AS "count"
           FROM "jsonb_array_elements"(COALESCE("p"."unassigned_mechanic_occurrences", '[]'::"jsonb")) "occ"("value")
          WHERE (("occ"."value" ->> 'actorName'::"text") = "r"."player_name")) AS "unassigned_mechanic_success_count"
   FROM ("public"."player_pull_records" "r"
     JOIN "public"."pulls" "p" ON (("p"."id" = "r"."pull_id")))
  WHERE (NOT "p"."ninja_pull_excluded");


ALTER VIEW "public"."player_pull_reliability_inputs_legacy_v1" OWNER TO "postgres";


COMMENT ON VIEW "public"."player_pull_reliability_inputs_legacy_v1" IS 'Compatibilidad temporal v1. No añadir consumidores nuevos; retirar después de backfill completo, calibración y activación estable de defensiveReliabilityV2.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs_legacy_v1"."had_avoidable_damage" IS 'true = recibió daño de una mecánica marcada avoidable Y esa instancia salió estadísticamente anómala (outcome<>clean, no un roce dentro de lo normal). Antes no exigía outcome<>clean -- inflaba el eje Defensiva contando rozes de mecánicas que salieron limpias como si fueran presión real (2026-08-28).';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs_legacy_v1"."defensive_use_opportunity" IS 'true = hubo presión verificable para usar un defensivo -- cast propio, muerte con catálogo, o daño de una mecánica avoidable EN UNA INSTANCIA QUE SALIÓ ANÓMALA (outcome<>clean). Mismo criterio que personal_mechanic_fail_count/avoidable_mechanic_eligible_count -- antes la tercera cláusula no exigía outcome<>clean (2026-08-28).';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs_legacy_v1"."defensive_window_coverable_count" IS 'Nº de ventanas de presión reales (ver defensive-pressure-windows.ts) donde había al menos un defensivo disponible (excluyendo "emergency" sin usar) y no se cubrió — el conteo real que sustituye al booleano defensive_use_opportunity para el eje Defensiva. 0 si el pull no tiene ventanas evaluables (backfill pendiente o sin presión real).';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs_legacy_v1"."defensive_window_covered_count" IS 'De esas mismas ventanas, cuántas SÍ tuvieron un defensivo activo o casteado dentro de la ventana. covered_count/coverable_count es el ratio real de cobertura de esta noche/pull — no un sí/no.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs_legacy_v1"."defensive_window_used_anything" IS '§"no es lo mismo usar 0 defensivos que usarlo a destiempo" (feedback real, 2026-08-29): true si lanzó CUALQUIER defensivo de su catálogo en algún momento del pull, sin mirar si acertó la ventana. Distingue "nunca lo intentó" (false, penaliza fuerte) de "lo intentó pero mal sincronizado" (true con covered_count=0, penaliza poco y debe guiar con las ventanas concretas).';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs_legacy_v1"."unassigned_mechanic_success_count" IS '§"vamos a decirlo y subir su porcentaje de mecanicas" (feedback real, 2026-08-29): cuántas mecánicas sin asignar (ver unassigned_mechanic_catalog) resolvió ESTE jugador en ESTE pull — mechanicScoreFor lo suma como bonus (UNASSIGNED_MECHANIC_BONUS_PER_OCCURRENCE, capado por pull) al ratio/conteo de fallos, nunca lo resta. 0 si el pull no tuvo ninguna (catálogo sin filas confirmadas para ese boss, o nadie la resolvió) — nunca null, a diferencia de avoidable_mechanic_*, porque esta columna no depende de un backfill de otra función, ya vive en pulls desde que se creó la tabla.';



CREATE OR REPLACE VIEW "public"."player_pull_reliability_inputs" WITH ("security_invoker"='true') AS
 SELECT "legacy"."player_name",
    "legacy"."pull_id",
    "legacy"."boss_id",
    "legacy"."difficulty",
    "legacy"."closed_at",
    "legacy"."died",
    "legacy"."had_avoidable_damage",
    "legacy"."self_positioning_death",
    "legacy"."used_defensive_when_died",
    "legacy"."used_defensive_in_pull",
    "legacy"."defensive_use_opportunity",
    "legacy"."enchanted_slot_count",
    "legacy"."enchantable_slot_count",
    "legacy"."gem_count",
    "legacy"."gemmed_slot_count",
    "legacy"."gemmable_slot_count",
    "legacy"."personal_mechanic_fail_count",
    "legacy"."report_code",
    "legacy"."pull_number",
    "legacy"."avoidable_mechanic_eligible_count",
    "legacy"."avoidable_mechanic_fail_count",
    "legacy"."defensive_window_coverable_count",
    "legacy"."defensive_window_covered_count",
    "legacy"."defensive_window_used_anything",
    "legacy"."defensive_pressure_windows",
    "legacy"."unassigned_mechanic_success_count",
    "evaluation"."management_score" AS "defensive_management_score_v2",
        CASE
            WHEN ("evaluation"."pull_id" IS NULL) THEN NULL::integer
            ELSE ( SELECT ("count"(*))::integer AS "count"
               FROM "jsonb_array_elements"("evaluation"."events") "event"("value")
              WHERE ((("event"."value" ->> 'state'::"text") = ANY (ARRAY['plan_broken'::"text", 'death_with_viable_cd'::"text", 'safe_extra_use'::"text", 'missed_extra_opportunity'::"text"])) OR ((("event"."value" ->> 'state'::"text") = ANY (ARRAY['plan_covered'::"text", 'covered_with_substitution'::"text", 'reminder_missed'::"text"])) AND (("event"."value" ->> 'requirementLevel'::"text") = ANY (ARRAY['required'::"text", 'recommended'::"text"])))))
        END AS "defensive_management_decision_count",
    "evaluation"."plan_required_count" AS "defensive_required_count",
        CASE
            WHEN ("evaluation"."pull_id" IS NULL) THEN NULL::integer
            ELSE ( SELECT ("count"(*))::integer AS "count"
               FROM "jsonb_array_elements"("evaluation"."events") "event"("value")
              WHERE ((("event"."value" ->> 'requirementLevel'::"text") = 'required'::"text") AND (("event"."value" ->> 'state'::"text") = ANY (ARRAY['plan_covered'::"text", 'covered_with_substitution'::"text"]))))
        END AS "defensive_required_success_count",
    "evaluation"."broken_reservation_count" AS "defensive_broken_reservation_count",
    "evaluation"."death_viable_cd_count" AS "defensive_death_viable_cd_count",
    "evaluation"."data_confidence" AS "defensive_evaluation_confidence",
    "evaluation"."evaluator_version" AS "defensive_evaluator_version",
    "evaluation"."resolver_version" AS "defensive_resolver_version"
   FROM ("public"."player_pull_reliability_inputs_legacy_v1" "legacy"
     LEFT JOIN "public"."player_pull_defensive_evaluations" "evaluation" ON ((("evaluation"."pull_id" = "legacy"."pull_id") AND ("evaluation"."player_name" = "legacy"."player_name"))));


ALTER VIEW "public"."player_pull_reliability_inputs" OWNER TO "postgres";


COMMENT ON VIEW "public"."player_pull_reliability_inputs" IS 'Fuente por pull de Fiabilidad: conserva señales legacy y añade evaluación defensiva v2. La elección v1/v2 se hace de forma atómica por fila en ReliabilityService.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs"."used_defensive_when_died" IS 'DEPRECATED para scoring v2: evidencia legacy conservada para fallback/shadow y UI histórica.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs"."used_defensive_in_pull" IS 'DEPRECATED para scoring v2: booleano legacy; usar defensive_management_score_v2 cuando la fila sea fiable.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs"."defensive_use_opportunity" IS 'DEPRECATED para scoring v2: oportunidad legacy; usar eventos semánticos de player_pull_defensive_evaluations.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs"."defensive_window_coverable_count" IS 'DEPRECATED para scoring: sensor v1 conservado solo para fallback/shadow de pulls sin evaluación v2 fiable.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs"."defensive_management_score_v2" IS 'Puntuación semántica 0-100 calculada solo con decisiones evaluables; null sin evaluación fiable/backfill.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs"."defensive_management_decision_count" IS 'Número de decisiones que participaron en la fórmula v2; optional/hold/no-feasible/uncertain quedan fuera.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs"."defensive_evaluation_confidence" IS 'Confianza de la evaluación autoritativa; ReliabilityService solo activa v2 con verified/inferred.';



COMMENT ON COLUMN "public"."player_pull_reliability_inputs"."defensive_resolver_version" IS 'Versión exacta del resolver con la que se materializó la evaluación; Fiabilidad v2 solo consume la versión vigente.';



CREATE TABLE IF NOT EXISTS "public"."pull_briefs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "headline" "text" NOT NULL,
    "improved" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "regressed" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "next_pull_actions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "model" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pull_briefs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pull_defensive_plan_binding_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "previous_plan_version_id" "uuid",
    "new_plan_version_id" "uuid",
    "previous_mode" "text" NOT NULL,
    "new_mode" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "changed_by" "uuid",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pull_defensive_plan_binding_audit_new_mode_check" CHECK (("new_mode" = ANY (ARRAY['full'::"text", 'partial'::"text", 'no_plan'::"text"]))),
    CONSTRAINT "pull_defensive_plan_binding_audit_previous_mode_check" CHECK (("previous_mode" = ANY (ARRAY['full'::"text", 'partial'::"text", 'no_plan'::"text"]))),
    CONSTRAINT "pull_defensive_plan_binding_audit_reason_check" CHECK ((NULLIF("btrim"("reason"), ''::"text") IS NOT NULL))
);


ALTER TABLE "public"."pull_defensive_plan_binding_audit" OWNER TO "postgres";


COMMENT ON TABLE "public"."pull_defensive_plan_binding_audit" IS 'Única excepción al binding inmutable: override manual de oficial, siempre con motivo y before/after.';



CREATE TABLE IF NOT EXISTS "public"."pull_dispel_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "source_actor_id" integer,
    "source_player_name" "text",
    "target_actor_id" integer,
    "target_player_name" "text",
    "dispelled_ability_id" bigint,
    "timestamp_ms" integer NOT NULL,
    "is_buff" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pull_dispel_events_timestamp_ms_check" CHECK (("timestamp_ms" >= 0))
);


ALTER TABLE "public"."pull_dispel_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."pull_dispel_events" IS 'Hechos WCL de dispel por pull. is_buff=true representa dispel ofensivo y no cuenta como limpieza aliada.';



CREATE TABLE IF NOT EXISTS "public"."pull_evaluation_context_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pull_id" "uuid" NOT NULL,
    "before_state" "jsonb",
    "after_state" "jsonb" NOT NULL,
    "change_source" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "resolver_version" "text" NOT NULL,
    "changed_by" "uuid",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pull_evaluation_context_audit_after_state_check" CHECK (("jsonb_typeof"("after_state") = 'object'::"text")),
    CONSTRAINT "pull_evaluation_context_audit_before_state_check" CHECK ((("before_state" IS NULL) OR ("jsonb_typeof"("before_state") = 'object'::"text"))),
    CONSTRAINT "pull_evaluation_context_audit_change_source_check" CHECK (("change_source" = ANY (ARRAY['manual_rl'::"text", 'instrumented'::"text", 'inferred'::"text", 'heuristic'::"text", 'imported'::"text", 'migration'::"text"]))),
    CONSTRAINT "pull_evaluation_context_audit_reason_check" CHECK ((NULLIF("btrim"("reason"), ''::"text") IS NOT NULL)),
    CONSTRAINT "pull_evaluation_context_audit_resolver_version_check" CHECK ((NULLIF("btrim"("resolver_version"), ''::"text") IS NOT NULL))
);


ALTER TABLE "public"."pull_evaluation_context_audit" OWNER TO "postgres";


COMMENT ON TABLE "public"."pull_evaluation_context_audit" IS 'Before/after auditable de toda corrección autoritativa de wipe/ninja/context.';



CREATE TABLE IF NOT EXISTS "public"."session_state" (
    "id" boolean DEFAULT true NOT NULL,
    "report_code" "text",
    "active" boolean DEFAULT false NOT NULL,
    "last_processed_fight_id" integer,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "session_state_id_check" CHECK ("id")
);


ALTER TABLE "public"."session_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."talent_spell_lookup" (
    "build" "text" NOT NULL,
    "entry_to_spell" "jsonb" NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."talent_spell_lookup" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."unassigned_mechanic_catalog" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "boss_id" "text" NOT NULL,
    "difficulty" "text" NOT NULL,
    "ability_id" bigint,
    "actor_name_pattern" "text",
    "name" "text" NOT NULL,
    "detection_type" "text" NOT NULL,
    "applied_by" "text",
    "eligible_roles" "text"[],
    "consequence_ability_id" bigint,
    "reviewed" boolean DEFAULT false NOT NULL,
    "ai_confidence" "text",
    "ai_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "has_confirmed_detection" boolean DEFAULT false NOT NULL,
    CONSTRAINT "unassigned_mechanic_catalog_applied_by_check" CHECK (("applied_by" = ANY (ARRAY['npc'::"text", 'self'::"text"]))),
    CONSTRAINT "unassigned_mechanic_catalog_detection_type_check" CHECK (("detection_type" = ANY (ARRAY['cast'::"text", 'debuff_applied'::"text", 'buff_applied'::"text", 'npc_interaction'::"text"]))),
    CONSTRAINT "unassigned_mechanic_has_target" CHECK ((("ability_id" IS NOT NULL) OR ("actor_name_pattern" IS NOT NULL)))
);


ALTER TABLE "public"."unassigned_mechanic_catalog" OWNER TO "postgres";


COMMENT ON TABLE "public"."unassigned_mechanic_catalog" IS 'Mecánicas de un boss donde cualquier jugador elegible puede actuar (sin asignación fija) y la raid sufre si nadie lo hace — coger/usar/depositar algo. Premia, nunca penaliza: no hay responsable individual claro a quien culpar si no se hace.';



COMMENT ON COLUMN "public"."unassigned_mechanic_catalog"."has_confirmed_detection" IS 'true solo si se ha visto al menos una ocurrencia real en datos de WCL de verdad (no solo "el NPC/ability existe en masterData") — analyze-report/reanalyze-unassigned-mechanics filtran por esto, para que una fila investigada-pero-sin-señal no aparente funcionar.';



CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "user_id" "uuid" NOT NULL,
    "discord_user_id" "text" NOT NULL,
    "discord_username" "text",
    "is_officer" boolean DEFAULT false NOT NULL,
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."wowaudit_season" (
    "id" boolean DEFAULT true NOT NULL,
    "start_date" "date" NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "wowaudit_season_single_row" CHECK ("id")
);


ALTER TABLE "public"."wowaudit_season" OWNER TO "postgres";


COMMENT ON TABLE "public"."wowaudit_season" IS 'Fila única (id=true) con el inicio de la season vigente según wowaudit (/v1/period) — usada para acotar "asistencia real" (attendance.service.ts) y cualquier otra métrica que deba mirar solo la season actual.';



ALTER TABLE ONLY "public"."boss_encounter_phases"
    ADD CONSTRAINT "boss_encounter_phases_pkey" PRIMARY KEY ("boss_id", "phase_id");



ALTER TABLE ONLY "public"."boss_mechanic_aliases"
    ADD CONSTRAINT "boss_mechanic_aliases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."boss_mechanic_catalog_sync_state"
    ADD CONSTRAINT "boss_mechanic_catalog_sync_state_pkey" PRIMARY KEY ("boss_id", "difficulty");



ALTER TABLE ONLY "public"."boss_mechanic_defensive_local_profile"
    ADD CONSTRAINT "boss_mechanic_defensive_local_profile_pkey" PRIMARY KEY ("boss_id", "difficulty", "ability_id");



ALTER TABLE ONLY "public"."boss_mechanic_defensive_profile"
    ADD CONSTRAINT "boss_mechanic_defensive_profi_boss_id_difficulty_ability_id_key" UNIQUE ("boss_id", "difficulty", "ability_id");



ALTER TABLE ONLY "public"."boss_mechanic_defensive_profile"
    ADD CONSTRAINT "boss_mechanic_defensive_profile_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."boss_mechanic_occurrence_profile"
    ADD CONSTRAINT "boss_mechanic_occurrence_profile_pkey" PRIMARY KEY ("boss_id", "difficulty", "ability_id", "occurrence_index");



ALTER TABLE ONLY "public"."boss_mechanic_policy_audit"
    ADD CONSTRAINT "boss_mechanic_policy_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."boss_mechanic_policy"
    ADD CONSTRAINT "boss_mechanic_policy_pkey" PRIMARY KEY ("boss_id", "difficulty", "mechanic_key");



ALTER TABLE ONLY "public"."boss_mechanic_policy_versions"
    ADD CONSTRAINT "boss_mechanic_policy_versions_pkey" PRIMARY KEY ("boss_id", "difficulty", "mechanic_key", "policy_version");



ALTER TABLE ONLY "public"."boss_mechanics"
    ADD CONSTRAINT "boss_mechanics_boss_id_difficulty_key" UNIQUE ("boss_id", "difficulty");



ALTER TABLE ONLY "public"."boss_mechanics_candidates"
    ADD CONSTRAINT "boss_mechanics_candidates_boss_id_difficulty_ability_id_key" UNIQUE ("boss_id", "difficulty", "ability_id");



ALTER TABLE ONLY "public"."boss_mechanics_candidates"
    ADD CONSTRAINT "boss_mechanics_candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."boss_mechanics"
    ADD CONSTRAINT "boss_mechanics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."boss_reference_stats"
    ADD CONSTRAINT "boss_reference_stats_pkey" PRIMARY KEY ("boss_id", "difficulty");



ALTER TABLE ONLY "public"."boss_reference_sync_state"
    ADD CONSTRAINT "boss_reference_sync_state_pkey" PRIMARY KEY ("boss_id", "difficulty");



ALTER TABLE ONLY "public"."combat_evaluation_batches"
    ADD CONSTRAINT "combat_evaluation_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."combat_evaluation_jobs"
    ADD CONSTRAINT "combat_evaluation_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."combat_evaluation_jobs"
    ADD CONSTRAINT "combat_evaluation_jobs_pull_id_job_type_key" UNIQUE ("pull_id", "job_type");



ALTER TABLE ONLY "public"."cooldown_catalog"
    ADD CONSTRAINT "cooldown_catalog_class_spell_id_key" UNIQUE ("class", "spell_id");



ALTER TABLE ONLY "public"."cooldown_catalog"
    ADD CONSTRAINT "cooldown_catalog_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."defensive_modifier_rules"
    ADD CONSTRAINT "defensive_modifier_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."defensive_modifier_rules"
    ADD CONSTRAINT "defensive_modifier_rules_version_key" UNIQUE ("class", "modifier_spell_id", "target_spell_id", "operation", "effect_field", "game_build");



ALTER TABLE ONLY "public"."defensive_plan_assignments"
    ADD CONSTRAINT "defensive_plan_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."defensive_plan_assignments"
    ADD CONSTRAINT "defensive_plan_assignments_plan_id_window_key_key" UNIQUE ("plan_id", "window_key");



ALTER TABLE ONLY "public"."defensive_plan_members"
    ADD CONSTRAINT "defensive_plan_members_pkey" PRIMARY KEY ("plan_version_id", "player_key");



ALTER TABLE ONLY "public"."defensive_plan_runs"
    ADD CONSTRAINT "defensive_plan_runs_boss_id_difficulty_character_id_key" UNIQUE ("boss_id", "difficulty", "character_id");



ALTER TABLE ONLY "public"."defensive_plan_runs"
    ADD CONSTRAINT "defensive_plan_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."defensive_plan_slots"
    ADD CONSTRAINT "defensive_plan_slots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."defensive_plan_slots"
    ADD CONSTRAINT "defensive_plan_slots_plan_version_id_ability_id_occurrence__key" UNIQUE ("plan_version_id", "ability_id", "occurrence_index", "slot_index");



ALTER TABLE ONLY "public"."defensive_plan_versions"
    ADD CONSTRAINT "defensive_plan_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."defensive_reanalysis_batches"
    ADD CONSTRAINT "defensive_reanalysis_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."defensive_reanalysis_jobs"
    ADD CONSTRAINT "defensive_reanalysis_jobs_batch_id_pull_id_key" UNIQUE ("batch_id", "pull_id");



ALTER TABLE ONLY "public"."defensive_reanalysis_jobs"
    ADD CONSTRAINT "defensive_reanalysis_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."defensive_spec_profiles"
    ADD CONSTRAINT "defensive_spec_profiles_pkey" PRIMARY KEY ("class", "spec", "spell_id", "game_build");



ALTER TABLE ONLY "public"."discord_roster_channels"
    ADD CONSTRAINT "discord_roster_channels_pkey" PRIMARY KEY ("character_id");



ALTER TABLE ONLY "public"."discord_roster_channels_settings"
    ADD CONSTRAINT "discord_roster_channels_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."known_raid_bosses"
    ADD CONSTRAINT "known_raid_bosses_pkey" PRIMARY KEY ("encounter_id");



ALTER TABLE ONLY "public"."llm_calls"
    ADD CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mechanic_defensive_assignments"
    ADD CONSTRAINT "mechanic_defensive_assignment_boss_id_difficulty_ability_id_key" UNIQUE ("boss_id", "difficulty", "ability_id", "class", "spec");



ALTER TABLE ONLY "public"."mechanic_defensive_assignments"
    ADD CONSTRAINT "mechanic_defensive_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mechanic_occurrence_evaluations"
    ADD CONSTRAINT "mechanic_occurrence_evaluatio_pull_id_mechanic_key_occurren_key" UNIQUE ("pull_id", "mechanic_key", "occurrence_index", "occurrence_resolver_version");



ALTER TABLE ONLY "public"."mechanic_occurrence_evaluations"
    ADD CONSTRAINT "mechanic_occurrence_evaluations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mechanic_responsibility_edges"
    ADD CONSTRAINT "mechanic_responsibility_edges_occurrence_id_player_name_rel_key" UNIQUE ("occurrence_id", "player_name", "relationship", "reason_code");



ALTER TABLE ONLY "public"."mechanic_responsibility_edges"
    ADD CONSTRAINT "mechanic_responsibility_edges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."night_briefs"
    ADD CONSTRAINT "night_briefs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."night_briefs"
    ADD CONSTRAINT "night_briefs_report_code_key" UNIQUE ("report_code");



ALTER TABLE ONLY "public"."night_full_reports"
    ADD CONSTRAINT "night_full_reports_pkey" PRIMARY KEY ("report_code");



ALTER TABLE ONLY "public"."night_player_briefs"
    ADD CONSTRAINT "night_player_briefs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."night_player_briefs"
    ADD CONSTRAINT "night_player_briefs_report_code_player_name_key" UNIQUE ("report_code", "player_name");



ALTER TABLE ONLY "public"."night_player_infographics"
    ADD CONSTRAINT "night_player_infographics_pkey" PRIMARY KEY ("report_code", "player_name");



ALTER TABLE ONLY "public"."player_defensive_override_audit"
    ADD CONSTRAINT "player_defensive_override_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."player_defensive_overrides"
    ADD CONSTRAINT "player_defensive_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."player_execution_events"
    ADD CONSTRAINT "player_execution_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."player_execution_events"
    ADD CONSTRAINT "player_execution_events_pull_id_ledger_evaluator_version_de_key" UNIQUE ("pull_id", "ledger_evaluator_version", "deduplication_key");



ALTER TABLE ONLY "public"."player_pull_defensive_evaluations"
    ADD CONSTRAINT "player_pull_defensive_evaluations_pkey" PRIMARY KEY ("pull_id", "player_name");



ALTER TABLE ONLY "public"."player_pull_records"
    ADD CONSTRAINT "player_pull_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pull_briefs"
    ADD CONSTRAINT "pull_briefs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pull_briefs"
    ADD CONSTRAINT "pull_briefs_pull_id_key" UNIQUE ("pull_id");



ALTER TABLE ONLY "public"."pull_defensive_plan_binding_audit"
    ADD CONSTRAINT "pull_defensive_plan_binding_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pull_defensive_plan_binding"
    ADD CONSTRAINT "pull_defensive_plan_binding_pkey" PRIMARY KEY ("pull_id");



ALTER TABLE ONLY "public"."pull_dispel_events"
    ADD CONSTRAINT "pull_dispel_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pull_dispel_events"
    ADD CONSTRAINT "pull_dispel_events_pull_id_source_actor_id_target_actor_id__key" UNIQUE ("pull_id", "source_actor_id", "target_actor_id", "dispelled_ability_id", "timestamp_ms", "is_buff");



ALTER TABLE ONLY "public"."pull_evaluation_context_audit"
    ADD CONSTRAINT "pull_evaluation_context_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pull_evaluation_context"
    ADD CONSTRAINT "pull_evaluation_context_pkey" PRIMARY KEY ("pull_id");



ALTER TABLE ONLY "public"."pull_mechanic_events"
    ADD CONSTRAINT "pull_mechanic_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pulls"
    ADD CONSTRAINT "pulls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pulls"
    ADD CONSTRAINT "pulls_report_code_fight_id_key" UNIQUE ("report_code", "fight_id");



ALTER TABLE ONLY "public"."report_encounters"
    ADD CONSTRAINT "report_encounters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."report_encounters"
    ADD CONSTRAINT "report_encounters_report_code_fight_id_key" UNIQUE ("report_code", "fight_id");



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."session_state"
    ADD CONSTRAINT "session_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."talent_spell_lookup"
    ADD CONSTRAINT "talent_spell_lookup_pkey" PRIMARY KEY ("build");



ALTER TABLE ONLY "public"."unassigned_mechanic_catalog"
    ADD CONSTRAINT "unassigned_mechanic_catalog_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."unassigned_mechanic_catalog"
    ADD CONSTRAINT "unassigned_mechanic_unique" UNIQUE NULLS NOT DISTINCT ("boss_id", "difficulty", "ability_id", "actor_name_pattern");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."wowaudit_roster"
    ADD CONSTRAINT "wowaudit_roster_pkey" PRIMARY KEY ("character_id");



ALTER TABLE ONLY "public"."wowaudit_season"
    ADD CONSTRAINT "wowaudit_season_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "boss_mechanic_aliases_ability_key" ON "public"."boss_mechanic_aliases" USING "btree" ("boss_id", "difficulty", "ability_id") WHERE (("ability_id" IS NOT NULL) AND "active");



CREATE INDEX "boss_mechanic_aliases_mechanic_idx" ON "public"."boss_mechanic_aliases" USING "btree" ("boss_id", "difficulty", "mechanic_key", "active");



CREATE UNIQUE INDEX "boss_mechanic_aliases_name_key" ON "public"."boss_mechanic_aliases" USING "btree" ("boss_id", "difficulty", "normalized_name") WHERE (("normalized_name" IS NOT NULL) AND "active");



CREATE INDEX "boss_mechanic_defensive_local_profile_priority_idx" ON "public"."boss_mechanic_defensive_local_profile" USING "btree" ("boss_id", "difficulty", "local_priority" DESC, "ability_id");



CREATE INDEX "boss_mechanic_defensive_profile_boss_idx" ON "public"."boss_mechanic_defensive_profile" USING "btree" ("boss_id", "difficulty");



CREATE INDEX "boss_mechanic_occurrence_profile_timeline_idx" ON "public"."boss_mechanic_occurrence_profile" USING "btree" ("boss_id", "difficulty", "median_offset_ms", "ability_id", "occurrence_index");



CREATE INDEX "boss_mechanic_policy_audit_scope_idx" ON "public"."boss_mechanic_policy_audit" USING "btree" ("boss_id", "difficulty", "mechanic_key", "changed_at" DESC);



CREATE INDEX "boss_mechanic_policy_review_idx" ON "public"."boss_mechanic_policy" USING "btree" ("boss_id", "difficulty", "confidence", "verified_at" DESC);



CREATE INDEX "boss_mechanic_policy_revision_idx" ON "public"."boss_mechanic_policy" USING "btree" ("boss_id", "difficulty", "mechanic_key", "policy_version" DESC);



CREATE INDEX "boss_mechanic_policy_versions_scope_idx" ON "public"."boss_mechanic_policy_versions" USING "btree" ("boss_id", "difficulty", "mechanic_key", "policy_version" DESC);



CREATE INDEX "boss_mechanics_candidates_boss_idx" ON "public"."boss_mechanics_candidates" USING "btree" ("boss_id", "difficulty");



CREATE INDEX "boss_mechanics_candidates_mechanic_key_idx" ON "public"."boss_mechanics_candidates" USING "btree" ("boss_id", "difficulty", "mechanic_key") WHERE ("mechanic_key" IS NOT NULL);



CREATE INDEX "combat_evaluation_jobs_batch_idx" ON "public"."combat_evaluation_jobs" USING "btree" ("batch_id", "status");



CREATE INDEX "combat_evaluation_jobs_claim_idx" ON "public"."combat_evaluation_jobs" USING "btree" ("status", "lease_expires_at", "created_at", "attempts");



CREATE INDEX "cooldown_catalog_class_idx" ON "public"."cooldown_catalog" USING "btree" ("class");



CREATE INDEX "defensive_modifier_rules_modifier_idx" ON "public"."defensive_modifier_rules" USING "btree" ("modifier_spell_id", "game_build") WHERE ("active" = true);



CREATE INDEX "defensive_modifier_rules_resolution_idx" ON "public"."defensive_modifier_rules" USING "btree" ("class", "target_spell_id", "game_build") WHERE ("active" = true);



CREATE INDEX "defensive_plan_assignments_plan_idx" ON "public"."defensive_plan_assignments" USING "btree" ("plan_id", "planned_time_ms");



CREATE INDEX "defensive_plan_runs_boss_idx" ON "public"."defensive_plan_runs" USING "btree" ("boss_id", "difficulty");



CREATE INDEX "defensive_plan_slots_mechanic_key_idx" ON "public"."defensive_plan_slots" USING "btree" ("plan_version_id", "mechanic_key", "occurrence_index") WHERE ("mechanic_key" IS NOT NULL);



CREATE INDEX "defensive_plan_slots_timeline_idx" ON "public"."defensive_plan_slots" USING "btree" ("plan_version_id", "occurrence_time_ms", "ability_id", "occurrence_index", "slot_index");



CREATE INDEX "defensive_plan_versions_scope_idx" ON "public"."defensive_plan_versions" USING "btree" ("boss_id", "difficulty", "status", "published_at" DESC);



CREATE INDEX "defensive_reanalysis_jobs_claim_idx" ON "public"."defensive_reanalysis_jobs" USING "btree" ("status", "created_at", "attempts");



CREATE INDEX "defensive_reanalysis_jobs_pull_idx" ON "public"."defensive_reanalysis_jobs" USING "btree" ("pull_id", "created_at" DESC);



CREATE INDEX "discord_roster_channels_channel_idx" ON "public"."discord_roster_channels" USING "btree" ("discord_channel_id");



CREATE INDEX "llm_calls_created_at_idx" ON "public"."llm_calls" USING "btree" ("created_at" DESC);



CREATE INDEX "llm_calls_status_idx" ON "public"."llm_calls" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "mechanic_defensive_assignments_boss_idx" ON "public"."mechanic_defensive_assignments" USING "btree" ("boss_id", "difficulty");



CREATE INDEX "mechanic_defensive_assignments_spec_idx" ON "public"."mechanic_defensive_assignments" USING "btree" ("class", "spec");



CREATE UNIQUE INDEX "mechanic_occurrence_evaluations_id_pull_key" ON "public"."mechanic_occurrence_evaluations" USING "btree" ("id", "pull_id");



CREATE INDEX "mechanic_occurrence_evaluations_mechanic_idx" ON "public"."mechanic_occurrence_evaluations" USING "btree" ("boss_id", "difficulty", "mechanic_key", "occurrence_index");



CREATE INDEX "mechanic_occurrence_evaluations_timeline_idx" ON "public"."mechanic_occurrence_evaluations" USING "btree" ("pull_id", "resolve_ms", "mechanic_key", "occurrence_index");



CREATE INDEX "mechanic_occurrence_evaluations_version_idx" ON "public"."mechanic_occurrence_evaluations" USING "btree" ("context_resolver_version", "occurrence_resolver_version", "evaluated_at" DESC);



CREATE INDEX "mechanic_responsibility_edges_occurrence_idx" ON "public"."mechanic_responsibility_edges" USING "btree" ("occurrence_id", "relationship");



CREATE INDEX "mechanic_responsibility_edges_player_credit_idx" ON "public"."mechanic_responsibility_edges" USING "btree" ("player_name", "credit_eligible", "occurrence_id");



CREATE INDEX "mechanic_responsibility_edges_player_penalty_idx" ON "public"."mechanic_responsibility_edges" USING "btree" ("player_name", "penalty_eligible", "occurrence_id");



CREATE INDEX "player_defensive_override_audit_scope_idx" ON "public"."player_defensive_override_audit" USING "btree" ("override_id", "created_at" DESC);



CREATE UNIQUE INDEX "player_defensive_overrides_active_scope_key" ON "public"."player_defensive_overrides" USING "btree" ((
CASE
    WHEN ("character_id" IS NOT NULL) THEN ('id:'::"text" || ("character_id")::"text")
    ELSE ('name:'::"text" || "lower"("player_name"))
END), "class", COALESCE("spec", ''::"text"), "spell_id", COALESCE("build_fingerprint", ''::"text"), "game_build") WHERE ("active" = true);



CREATE INDEX "player_defensive_overrides_resolution_idx" ON "public"."player_defensive_overrides" USING "btree" ("player_name", "build_fingerprint", "spell_id", "game_build") WHERE ("active" = true);



CREATE INDEX "player_execution_events_causal_group_idx" ON "public"."player_execution_events" USING "btree" ("causal_group_id", "primary_penalty");



CREATE INDEX "player_execution_events_occurrence_idx" ON "public"."player_execution_events" USING "btree" ("occurrence_id") WHERE ("occurrence_id" IS NOT NULL);



CREATE INDEX "player_execution_events_penalty_idx" ON "public"."player_execution_events" USING "btree" ("player_name", "penalty_eligible", "primary_penalty", "evaluated_at" DESC);



CREATE INDEX "player_execution_events_player_domain_idx" ON "public"."player_execution_events" USING "btree" ("player_name", "domain", "verdict", "evaluated_at" DESC);



CREATE INDEX "player_execution_events_pull_player_timeline_idx" ON "public"."player_execution_events" USING "btree" ("pull_id", "player_name", "timestamp_ms");



CREATE INDEX "player_pull_defensive_evaluations_plan_idx" ON "public"."player_pull_defensive_evaluations" USING "btree" ("plan_version_id", "evaluated_at" DESC);



CREATE INDEX "player_pull_defensive_evaluations_scoring_idx" ON "public"."player_pull_defensive_evaluations" USING "btree" ("evaluator_version", "data_confidence", "evaluated_at" DESC);



CREATE INDEX "player_pull_records_build_scope_idx" ON "public"."player_pull_records" USING "btree" ("class", "spec", "game_build") WHERE ("game_build" IS NOT NULL);



CREATE INDEX "player_pull_records_defensive_v2_pending_idx" ON "public"."player_pull_records" USING "btree" ("pull_id") WHERE ("defensive_resolution_version" IS NULL);



CREATE INDEX "player_pull_records_latest_build_idx" ON "public"."player_pull_records" USING "btree" ("player_name", "created_at" DESC) WHERE (("class" IS NOT NULL) AND ("spec" IS NOT NULL));



CREATE INDEX "player_pull_records_pull_idx" ON "public"."player_pull_records" USING "btree" ("pull_id");



CREATE INDEX "pull_defensive_plan_binding_plan_idx" ON "public"."pull_defensive_plan_binding" USING "btree" ("plan_version_id", "bound_at" DESC);



CREATE INDEX "pull_dispel_events_pull_target_idx" ON "public"."pull_dispel_events" USING "btree" ("pull_id", "target_actor_id", "dispelled_ability_id", "timestamp_ms");



CREATE INDEX "pull_dispel_events_pull_timeline_idx" ON "public"."pull_dispel_events" USING "btree" ("pull_id", "timestamp_ms");



CREATE INDEX "pull_evaluation_context_audit_pull_idx" ON "public"."pull_evaluation_context_audit" USING "btree" ("pull_id", "changed_at" DESC);



CREATE INDEX "pull_evaluation_context_diagnostics_idx" ON "public"."pull_evaluation_context" USING "btree" ("evaluation_eligible", "updated_at" DESC);



CREATE INDEX "pull_evaluation_context_version_idx" ON "public"."pull_evaluation_context" USING "btree" ("resolver_version", "updated_at" DESC);



CREATE INDEX "pull_mechanic_events_mechanic_key_idx" ON "public"."pull_mechanic_events" USING "btree" ("pull_id", "mechanic_key", "trigger_time_ms") WHERE ("mechanic_key" IS NOT NULL);



CREATE INDEX "pull_mechanic_events_pull_idx" ON "public"."pull_mechanic_events" USING "btree" ("pull_id", "trigger_time_ms");



CREATE UNIQUE INDEX "pulls_identity_scope_key" ON "public"."pulls" USING "btree" ("id", "boss_id", "difficulty");



CREATE INDEX "pulls_observed_at_idx" ON "public"."pulls" USING "btree" ("boss_id", "difficulty", "observed_at" DESC);



CREATE INDEX "pulls_report_code_idx" ON "public"."pulls" USING "btree" ("report_code", "pull_number" DESC);



CREATE INDEX "report_encounters_encounter_idx" ON "public"."report_encounters" USING "btree" ("encounter_id", "wcl_difficulty_id", "start_time" DESC);



CREATE INDEX "reports_start_time_idx" ON "public"."reports" USING "btree" ("start_time" DESC);



CREATE INDEX "wowaudit_roster_name_idx" ON "public"."wowaudit_roster" USING "btree" ("name");



CREATE OR REPLACE TRIGGER "boss_mechanic_aliases_touch_updated_at" BEFORE UPDATE ON "public"."boss_mechanic_aliases" FOR EACH ROW EXECUTE FUNCTION "public"."combat_evaluation_touch_updated_at"();



CREATE OR REPLACE TRIGGER "boss_mechanic_policy_snapshot_version" AFTER INSERT OR UPDATE ON "public"."boss_mechanic_policy" FOR EACH ROW EXECUTE FUNCTION "public"."snapshot_boss_mechanic_policy_version"();



CREATE OR REPLACE TRIGGER "boss_mechanic_policy_touch_updated_at" BEFORE UPDATE ON "public"."boss_mechanic_policy" FOR EACH ROW EXECUTE FUNCTION "public"."combat_evaluation_touch_updated_at"();



CREATE OR REPLACE TRIGGER "defensive_modifier_rules_material_timestamp" BEFORE UPDATE ON "public"."defensive_modifier_rules" FOR EACH ROW EXECUTE FUNCTION "public"."keep_defensive_reference_material_timestamp"();



CREATE OR REPLACE TRIGGER "defensive_plan_members_draft_only" BEFORE INSERT OR DELETE OR UPDATE ON "public"."defensive_plan_members" FOR EACH ROW EXECUTE FUNCTION "public"."defensive_plan_assert_draft"();



CREATE OR REPLACE TRIGGER "defensive_plan_slots_draft_only" BEFORE INSERT OR DELETE OR UPDATE ON "public"."defensive_plan_slots" FOR EACH ROW EXECUTE FUNCTION "public"."defensive_plan_assert_draft"();



CREATE OR REPLACE TRIGGER "defensive_plan_versions_immutable_published" BEFORE DELETE OR UPDATE ON "public"."defensive_plan_versions" FOR EACH ROW EXECUTE FUNCTION "public"."defensive_plan_assert_version_mutation"();



CREATE OR REPLACE TRIGGER "defensive_spec_profiles_material_timestamp" BEFORE UPDATE ON "public"."defensive_spec_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."keep_defensive_reference_material_timestamp"();



CREATE OR REPLACE TRIGGER "pull_evaluation_context_queue_reanalysis" AFTER INSERT OR UPDATE ON "public"."pull_evaluation_context" FOR EACH ROW EXECUTE FUNCTION "public"."queue_pull_context_reanalysis"();



CREATE OR REPLACE TRIGGER "pull_evaluation_context_touch_updated_at" BEFORE UPDATE ON "public"."pull_evaluation_context" FOR EACH ROW EXECUTE FUNCTION "public"."combat_evaluation_touch_updated_at"();



ALTER TABLE ONLY "public"."boss_mechanic_aliases"
    ADD CONSTRAINT "boss_mechanic_aliases_boss_id_difficulty_mechanic_key_fkey" FOREIGN KEY ("boss_id", "difficulty", "mechanic_key") REFERENCES "public"."boss_mechanic_policy"("boss_id", "difficulty", "mechanic_key") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."boss_mechanic_aliases"
    ADD CONSTRAINT "boss_mechanic_aliases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."boss_mechanic_policy_audit"
    ADD CONSTRAINT "boss_mechanic_policy_audit_boss_id_difficulty_mechanic_key_fkey" FOREIGN KEY ("boss_id", "difficulty", "mechanic_key") REFERENCES "public"."boss_mechanic_policy"("boss_id", "difficulty", "mechanic_key") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."boss_mechanic_policy_audit"
    ADD CONSTRAINT "boss_mechanic_policy_audit_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."boss_mechanic_policy"
    ADD CONSTRAINT "boss_mechanic_policy_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."boss_mechanic_policy"
    ADD CONSTRAINT "boss_mechanic_policy_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."boss_mechanic_policy_versions"
    ADD CONSTRAINT "boss_mechanic_policy_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."combat_evaluation_batches"
    ADD CONSTRAINT "combat_evaluation_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."combat_evaluation_jobs"
    ADD CONSTRAINT "combat_evaluation_jobs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."combat_evaluation_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."combat_evaluation_jobs"
    ADD CONSTRAINT "combat_evaluation_jobs_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."defensive_plan_assignments"
    ADD CONSTRAINT "defensive_plan_assignments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."defensive_plan_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."defensive_plan_members"
    ADD CONSTRAINT "defensive_plan_members_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "public"."defensive_plan_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."defensive_plan_slots"
    ADD CONSTRAINT "defensive_plan_slots_plan_version_id_assigned_player_key_fkey" FOREIGN KEY ("plan_version_id", "assigned_player_key") REFERENCES "public"."defensive_plan_members"("plan_version_id", "player_key");



ALTER TABLE ONLY "public"."defensive_plan_slots"
    ADD CONSTRAINT "defensive_plan_slots_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "public"."defensive_plan_versions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."defensive_plan_slots"
    ADD CONSTRAINT "defensive_plan_slots_plan_version_id_target_player_key_fkey" FOREIGN KEY ("plan_version_id", "target_player_key") REFERENCES "public"."defensive_plan_members"("plan_version_id", "player_key");



ALTER TABLE ONLY "public"."defensive_plan_versions"
    ADD CONSTRAINT "defensive_plan_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."defensive_plan_versions"
    ADD CONSTRAINT "defensive_plan_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."defensive_plan_versions"
    ADD CONSTRAINT "defensive_plan_versions_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "public"."defensive_plan_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."defensive_reanalysis_batches"
    ADD CONSTRAINT "defensive_reanalysis_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."defensive_reanalysis_jobs"
    ADD CONSTRAINT "defensive_reanalysis_jobs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."defensive_reanalysis_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."defensive_reanalysis_jobs"
    ADD CONSTRAINT "defensive_reanalysis_jobs_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mechanic_occurrence_evaluations"
    ADD CONSTRAINT "mechanic_occurrence_evaluatio_boss_id_difficulty_mechanic__fkey" FOREIGN KEY ("boss_id", "difficulty", "mechanic_key") REFERENCES "public"."boss_mechanic_policy"("boss_id", "difficulty", "mechanic_key") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."mechanic_occurrence_evaluations"
    ADD CONSTRAINT "mechanic_occurrence_evaluations_pull_id_boss_id_difficulty_fkey" FOREIGN KEY ("pull_id", "boss_id", "difficulty") REFERENCES "public"."pulls"("id", "boss_id", "difficulty") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mechanic_responsibility_edges"
    ADD CONSTRAINT "mechanic_responsibility_edges_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "public"."mechanic_occurrence_evaluations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."night_briefs"
    ADD CONSTRAINT "night_briefs_report_code_fkey" FOREIGN KEY ("report_code") REFERENCES "public"."reports"("code") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."night_full_reports"
    ADD CONSTRAINT "night_full_reports_report_code_fkey" FOREIGN KEY ("report_code") REFERENCES "public"."reports"("code") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."night_player_briefs"
    ADD CONSTRAINT "night_player_briefs_report_code_fkey" FOREIGN KEY ("report_code") REFERENCES "public"."reports"("code") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."night_player_infographics"
    ADD CONSTRAINT "night_player_infographics_report_code_fkey" FOREIGN KEY ("report_code") REFERENCES "public"."reports"("code") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."player_defensive_override_audit"
    ADD CONSTRAINT "player_defensive_override_audit_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."player_defensive_override_audit"
    ADD CONSTRAINT "player_defensive_override_audit_override_id_fkey" FOREIGN KEY ("override_id") REFERENCES "public"."player_defensive_overrides"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."player_defensive_overrides"
    ADD CONSTRAINT "player_defensive_overrides_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."player_defensive_overrides"
    ADD CONSTRAINT "player_defensive_overrides_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."player_execution_events"
    ADD CONSTRAINT "player_execution_events_occurrence_id_pull_id_fkey" FOREIGN KEY ("occurrence_id", "pull_id") REFERENCES "public"."mechanic_occurrence_evaluations"("id", "pull_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."player_execution_events"
    ADD CONSTRAINT "player_execution_events_pull_id_boss_id_difficulty_fkey" FOREIGN KEY ("pull_id", "boss_id", "difficulty") REFERENCES "public"."pulls"("id", "boss_id", "difficulty") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."player_pull_defensive_evaluations"
    ADD CONSTRAINT "player_pull_defensive_evaluations_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "public"."defensive_plan_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."player_pull_defensive_evaluations"
    ADD CONSTRAINT "player_pull_defensive_evaluations_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."player_pull_records"
    ADD CONSTRAINT "player_pull_records_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_briefs"
    ADD CONSTRAINT "pull_briefs_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_defensive_plan_binding_audit"
    ADD CONSTRAINT "pull_defensive_plan_binding_audit_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pull_defensive_plan_binding_audit"
    ADD CONSTRAINT "pull_defensive_plan_binding_audit_new_plan_version_id_fkey" FOREIGN KEY ("new_plan_version_id") REFERENCES "public"."defensive_plan_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pull_defensive_plan_binding_audit"
    ADD CONSTRAINT "pull_defensive_plan_binding_audit_previous_plan_version_id_fkey" FOREIGN KEY ("previous_plan_version_id") REFERENCES "public"."defensive_plan_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pull_defensive_plan_binding_audit"
    ADD CONSTRAINT "pull_defensive_plan_binding_audit_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_defensive_plan_binding"
    ADD CONSTRAINT "pull_defensive_plan_binding_bound_by_fkey" FOREIGN KEY ("bound_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pull_defensive_plan_binding"
    ADD CONSTRAINT "pull_defensive_plan_binding_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "public"."defensive_plan_versions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pull_defensive_plan_binding"
    ADD CONSTRAINT "pull_defensive_plan_binding_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_dispel_events"
    ADD CONSTRAINT "pull_dispel_events_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_evaluation_context_audit"
    ADD CONSTRAINT "pull_evaluation_context_audit_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pull_evaluation_context_audit"
    ADD CONSTRAINT "pull_evaluation_context_audit_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_evaluation_context"
    ADD CONSTRAINT "pull_evaluation_context_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_evaluation_context"
    ADD CONSTRAINT "pull_evaluation_context_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pull_mechanic_events"
    ADD CONSTRAINT "pull_mechanic_events_pull_id_fkey" FOREIGN KEY ("pull_id") REFERENCES "public"."pulls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."report_encounters"
    ADD CONSTRAINT "report_encounters_report_code_fkey" FOREIGN KEY ("report_code") REFERENCES "public"."reports"("code") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."boss_encounter_phases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."boss_mechanic_aliases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "boss_mechanic_aliases: officers read" ON "public"."boss_mechanic_aliases" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."boss_mechanic_catalog_sync_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "boss_mechanic_catalog_sync_state: officers read" ON "public"."boss_mechanic_catalog_sync_state" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."boss_mechanic_defensive_local_profile" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "boss_mechanic_defensive_local_profile: officers read" ON "public"."boss_mechanic_defensive_local_profile" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."boss_mechanic_defensive_profile" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."boss_mechanic_occurrence_profile" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "boss_mechanic_occurrence_profile: officers read" ON "public"."boss_mechanic_occurrence_profile" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."boss_mechanic_policy" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "boss_mechanic_policy: officers read" ON "public"."boss_mechanic_policy" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."boss_mechanic_policy_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "boss_mechanic_policy_audit: officers read" ON "public"."boss_mechanic_policy_audit" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."boss_mechanic_policy_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "boss_mechanic_policy_versions: officers read" ON "public"."boss_mechanic_policy_versions" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."boss_mechanics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."boss_mechanics_candidates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."boss_reference_stats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."boss_reference_sync_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."combat_evaluation_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "combat_evaluation_batches: officers read" ON "public"."combat_evaluation_batches" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."combat_evaluation_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "combat_evaluation_jobs: officers read" ON "public"."combat_evaluation_jobs" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."cooldown_catalog" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."defensive_modifier_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "defensive_modifier_rules: officers read" ON "public"."defensive_modifier_rules" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."defensive_plan_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."defensive_plan_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "defensive_plan_members: officers read" ON "public"."defensive_plan_members" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."defensive_plan_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."defensive_plan_slots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "defensive_plan_slots: officers read" ON "public"."defensive_plan_slots" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."defensive_plan_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "defensive_plan_versions: officers read" ON "public"."defensive_plan_versions" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."defensive_reanalysis_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "defensive_reanalysis_batches: officers read" ON "public"."defensive_reanalysis_batches" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."defensive_reanalysis_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "defensive_reanalysis_jobs: officers read" ON "public"."defensive_reanalysis_jobs" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."defensive_spec_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "defensive_spec_profiles: officers read" ON "public"."defensive_spec_profiles" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."discord_roster_channels" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "discord_roster_channels is publicly readable" ON "public"."discord_roster_channels" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."discord_roster_channels_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "discord_roster_channels_settings is publicly readable" ON "public"."discord_roster_channels_settings" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."known_raid_bosses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."llm_calls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mechanic_defensive_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mechanic_occurrence_evaluations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mechanic_occurrence_evaluations: officers read" ON "public"."mechanic_occurrence_evaluations" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."mechanic_responsibility_edges" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mechanic_responsibility_edges: officers read" ON "public"."mechanic_responsibility_edges" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."night_briefs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."night_full_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."night_player_briefs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."night_player_infographics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "officers read defensive modifier rules" ON "public"."defensive_modifier_rules" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "officers read defensive plan assignments" ON "public"."defensive_plan_assignments" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "officers read defensive plan runs" ON "public"."defensive_plan_runs" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "officers read defensive spec profiles" ON "public"."defensive_spec_profiles" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."player_defensive_override_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "player_defensive_override_audit: officers read" ON "public"."player_defensive_override_audit" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."player_defensive_overrides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "player_defensive_overrides: officers read" ON "public"."player_defensive_overrides" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."player_execution_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "player_execution_events: officers read" ON "public"."player_execution_events" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."player_pull_defensive_evaluations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "player_pull_defensive_evaluations: officers read" ON "public"."player_pull_defensive_evaluations" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."player_pull_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pull_briefs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pull_defensive_plan_binding" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pull_defensive_plan_binding: officers read" ON "public"."pull_defensive_plan_binding" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."pull_defensive_plan_binding_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pull_defensive_plan_binding_audit: officers read" ON "public"."pull_defensive_plan_binding_audit" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."pull_dispel_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pull_dispel_events: officers read" ON "public"."pull_dispel_events" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."pull_evaluation_context" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pull_evaluation_context: officers read" ON "public"."pull_evaluation_context" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."pull_evaluation_context_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pull_evaluation_context_audit: officers read" ON "public"."pull_evaluation_context_audit" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."pull_mechanic_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pulls" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "read all - boss_encounter_phases" ON "public"."boss_encounter_phases" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - boss_mechanic_defensive_profile" ON "public"."boss_mechanic_defensive_profile" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - boss_mechanics" ON "public"."boss_mechanics" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - boss_mechanics_candidates" ON "public"."boss_mechanics_candidates" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - boss_reference_stats" ON "public"."boss_reference_stats" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - boss_reference_sync_state" ON "public"."boss_reference_sync_state" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - cooldown_catalog" ON "public"."cooldown_catalog" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - known_raid_bosses" ON "public"."known_raid_bosses" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - llm_calls" ON "public"."llm_calls" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - mechanic_defensive_assignments" ON "public"."mechanic_defensive_assignments" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - night_briefs" ON "public"."night_briefs" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - night_full_reports" ON "public"."night_full_reports" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - night_player_briefs" ON "public"."night_player_briefs" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - night_player_infographics" ON "public"."night_player_infographics" FOR SELECT USING (true);



CREATE POLICY "read all - player_pull_records" ON "public"."player_pull_records" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - pull_briefs" ON "public"."pull_briefs" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - pull_mechanic_events" ON "public"."pull_mechanic_events" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - pulls" ON "public"."pulls" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - report_encounters" ON "public"."report_encounters" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - reports" ON "public"."reports" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - session_state" ON "public"."session_state" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - unassigned_mechanic_catalog" ON "public"."unassigned_mechanic_catalog" FOR SELECT USING ("public"."is_officer"());



CREATE POLICY "read all - wowaudit_season" ON "public"."wowaudit_season" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."report_encounters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."session_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."talent_spell_lookup" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "talent_spell_lookup is publicly readable" ON "public"."talent_spell_lookup" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."unassigned_mechanic_catalog" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_profiles: cada usuario lee su propia fila" ON "public"."user_profiles" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."wowaudit_roster" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "wowaudit_roster is publicly readable" ON "public"."wowaudit_roster" FOR SELECT USING ("public"."is_officer"());



ALTER TABLE "public"."wowaudit_season" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON TABLE "public"."pull_defensive_plan_binding" TO "service_role";
GRANT SELECT ON TABLE "public"."pull_defensive_plan_binding" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."bind_pull_to_current_defensive_plan"("p_pull_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bind_pull_to_current_defensive_plan"("p_pull_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."bind_pull_to_current_defensive_plan"("p_pull_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bind_pull_to_current_defensive_plan"("p_pull_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."bind_pull_to_defensive_plan"("p_pull_id" "uuid", "p_plan_version_id" "uuid", "p_binding_reason" "text", "p_bound_by" "uuid", "p_manual_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bind_pull_to_defensive_plan"("p_pull_id" "uuid", "p_plan_version_id" "uuid", "p_binding_reason" "text", "p_bound_by" "uuid", "p_manual_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."bind_pull_to_defensive_plan"("p_pull_id" "uuid", "p_plan_version_id" "uuid", "p_binding_reason" "text", "p_bound_by" "uuid", "p_manual_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."bind_pull_to_defensive_plan"("p_pull_id" "uuid", "p_plan_version_id" "uuid", "p_binding_reason" "text", "p_bound_by" "uuid", "p_manual_reason" "text") TO "service_role";



GRANT ALL ON TABLE "public"."combat_evaluation_jobs" TO "service_role";
GRANT SELECT ON TABLE "public"."combat_evaluation_jobs" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."claim_combat_evaluation_job"("p_job_type" "text", "p_lease_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_combat_evaluation_job"("p_job_type" "text", "p_lease_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."combat_evaluation_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."combat_evaluation_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."combat_evaluation_touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."defensive_plan_assert_draft"() TO "anon";
GRANT ALL ON FUNCTION "public"."defensive_plan_assert_draft"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."defensive_plan_assert_draft"() TO "service_role";



GRANT ALL ON FUNCTION "public"."defensive_plan_assert_version_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."defensive_plan_assert_version_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."defensive_plan_assert_version_mutation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_combat_evaluation_jobs"("p_pull_ids" "uuid"[], "p_job_type" "text", "p_reason" "text", "p_scope" "jsonb", "p_payload" "jsonb", "p_requested_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_combat_evaluation_jobs"("p_pull_ids" "uuid"[], "p_job_type" "text", "p_reason" "text", "p_scope" "jsonb", "p_payload" "jsonb", "p_requested_by" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_defensive_reanalysis_batch"("p_pull_ids" "uuid"[], "p_reason" "text", "p_scope" "jsonb", "p_requested_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_defensive_reanalysis_batch"("p_pull_ids" "uuid"[], "p_reason" "text", "p_scope" "jsonb", "p_requested_by" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."finish_combat_evaluation_job"("p_job_id" "uuid", "p_lease_token" "uuid", "p_succeeded" boolean, "p_stage_progress" "jsonb", "p_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finish_combat_evaluation_job"("p_job_id" "uuid", "p_lease_token" "uuid", "p_succeeded" boolean, "p_stage_progress" "jsonb", "p_error" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_officer"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_officer"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_officer"() TO "service_role";



GRANT ALL ON FUNCTION "public"."keep_defensive_reference_material_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."keep_defensive_reference_material_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."keep_defensive_reference_material_timestamp"() TO "service_role";



GRANT ALL ON TABLE "public"."defensive_plan_versions" TO "service_role";
GRANT SELECT ON TABLE "public"."defensive_plan_versions" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."publish_defensive_plan"("p_plan_version_id" "uuid", "p_published_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."publish_defensive_plan"("p_plan_version_id" "uuid", "p_published_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."publish_defensive_plan"("p_plan_version_id" "uuid", "p_published_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."publish_defensive_plan"("p_plan_version_id" "uuid", "p_published_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."queue_pull_context_reanalysis"() TO "anon";
GRANT ALL ON FUNCTION "public"."queue_pull_context_reanalysis"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."queue_pull_context_reanalysis"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_combat_evaluation_batch"("p_batch_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_combat_evaluation_batch"("p_batch_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_combat_evaluation_batch"("p_batch_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_defensive_plan_v2"("p_run" "jsonb", "p_assignments" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_defensive_plan_v2"("p_run" "jsonb", "p_assignments" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."player_defensive_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."player_defensive_overrides" TO "service_role";



REVOKE ALL ON FUNCTION "public"."save_exact_player_defensive_override"("p_character_id" bigint, "p_player_name" "text", "p_class" "text", "p_spec" "text", "p_spell_id" bigint, "p_game_build" "text", "p_build_fingerprint" "text", "p_effective_cooldown_ms" integer, "p_effective_duration_ms" integer, "p_automatic_cooldown_ms" integer, "p_automatic_duration_ms" integer, "p_reason" "text", "p_changed_by" "uuid", "p_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_exact_player_defensive_override"("p_character_id" bigint, "p_player_name" "text", "p_class" "text", "p_spec" "text", "p_spell_id" bigint, "p_game_build" "text", "p_build_fingerprint" "text", "p_effective_cooldown_ms" integer, "p_effective_duration_ms" integer, "p_automatic_cooldown_ms" integer, "p_automatic_duration_ms" integer, "p_reason" "text", "p_changed_by" "uuid", "p_active" boolean) TO "service_role";



GRANT ALL ON TABLE "public"."pull_evaluation_context" TO "service_role";
GRANT SELECT ON TABLE "public"."pull_evaluation_context" TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_pull_evaluation_context_v2"("p_pull_id" "uuid", "p_evaluation_eligible" boolean, "p_evaluation_start_ms" integer, "p_evaluation_end_ms" integer, "p_cutoff_reason" "text", "p_wipe_call_at_ms" integer, "p_wipe_call_boss_hp_pct" numeric, "p_wipe_call_source" "text", "p_wipe_call_confidence" numeric, "p_wipe_call_verified" boolean, "p_ninja_status" "text", "p_ninja_source" "text", "p_ninja_confidence" numeric, "p_evidence" "jsonb", "p_resolver_version" "text", "p_reason" "text", "p_changed_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_pull_evaluation_context_v2"("p_pull_id" "uuid", "p_evaluation_eligible" boolean, "p_evaluation_start_ms" integer, "p_evaluation_end_ms" integer, "p_cutoff_reason" "text", "p_wipe_call_at_ms" integer, "p_wipe_call_boss_hp_pct" numeric, "p_wipe_call_source" "text", "p_wipe_call_confidence" numeric, "p_wipe_call_verified" boolean, "p_ninja_status" "text", "p_ninja_source" "text", "p_ninja_confidence" numeric, "p_evidence" "jsonb", "p_resolver_version" "text", "p_reason" "text", "p_changed_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."snapshot_boss_mechanic_policy_version"() TO "anon";
GRANT ALL ON FUNCTION "public"."snapshot_boss_mechanic_policy_version"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."snapshot_boss_mechanic_policy_version"() TO "service_role";



GRANT ALL ON TABLE "public"."boss_mechanics_candidates" TO "anon";
GRANT ALL ON TABLE "public"."boss_mechanics_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_mechanics_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."pull_mechanic_events" TO "anon";
GRANT ALL ON TABLE "public"."pull_mechanic_events" TO "authenticated";
GRANT ALL ON TABLE "public"."pull_mechanic_events" TO "service_role";



GRANT ALL ON TABLE "public"."pulls" TO "anon";
GRANT ALL ON TABLE "public"."pulls" TO "authenticated";
GRANT ALL ON TABLE "public"."pulls" TO "service_role";



GRANT ALL ON TABLE "public"."applicable_boss_mechanics_candidates" TO "anon";
GRANT ALL ON TABLE "public"."applicable_boss_mechanics_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."applicable_boss_mechanics_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."applicable_pull_mechanic_events" TO "anon";
GRANT ALL ON TABLE "public"."applicable_pull_mechanic_events" TO "authenticated";
GRANT ALL ON TABLE "public"."applicable_pull_mechanic_events" TO "service_role";



GRANT ALL ON TABLE "public"."boss_encounter_phases" TO "anon";
GRANT ALL ON TABLE "public"."boss_encounter_phases" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_encounter_phases" TO "service_role";



GRANT ALL ON TABLE "public"."boss_mechanic_aliases" TO "service_role";
GRANT SELECT ON TABLE "public"."boss_mechanic_aliases" TO "authenticated";



GRANT ALL ON TABLE "public"."boss_mechanic_catalog_sync_state" TO "service_role";
GRANT SELECT ON TABLE "public"."boss_mechanic_catalog_sync_state" TO "authenticated";



GRANT ALL ON TABLE "public"."boss_mechanic_defensive_local_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_mechanic_defensive_local_profile" TO "service_role";



GRANT ALL ON TABLE "public"."boss_mechanic_defensive_profile" TO "anon";
GRANT ALL ON TABLE "public"."boss_mechanic_defensive_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_mechanic_defensive_profile" TO "service_role";



GRANT ALL ON TABLE "public"."boss_mechanic_defensive_planning_view" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_mechanic_defensive_planning_view" TO "service_role";



GRANT ALL ON TABLE "public"."mechanic_occurrence_evaluations" TO "service_role";
GRANT SELECT ON TABLE "public"."mechanic_occurrence_evaluations" TO "authenticated";



GRANT ALL ON TABLE "public"."boss_mechanic_execution_stats_v3" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_mechanic_execution_stats_v3" TO "service_role";



GRANT ALL ON TABLE "public"."boss_mechanic_occurrence_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_mechanic_occurrence_profile" TO "service_role";



GRANT ALL ON TABLE "public"."boss_mechanic_policy" TO "service_role";
GRANT SELECT ON TABLE "public"."boss_mechanic_policy" TO "authenticated";



GRANT ALL ON TABLE "public"."boss_mechanic_policy_audit" TO "service_role";
GRANT SELECT ON TABLE "public"."boss_mechanic_policy_audit" TO "authenticated";



GRANT ALL ON TABLE "public"."boss_mechanic_policy_versions" TO "service_role";
GRANT SELECT ON TABLE "public"."boss_mechanic_policy_versions" TO "authenticated";



GRANT ALL ON TABLE "public"."boss_mechanics" TO "anon";
GRANT ALL ON TABLE "public"."boss_mechanics" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_mechanics" TO "service_role";



GRANT ALL ON TABLE "public"."boss_reference_stats" TO "anon";
GRANT ALL ON TABLE "public"."boss_reference_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_reference_stats" TO "service_role";



GRANT ALL ON TABLE "public"."boss_reference_sync_state" TO "anon";
GRANT ALL ON TABLE "public"."boss_reference_sync_state" TO "authenticated";
GRANT ALL ON TABLE "public"."boss_reference_sync_state" TO "service_role";



GRANT ALL ON TABLE "public"."combat_evaluation_batches" TO "service_role";
GRANT SELECT ON TABLE "public"."combat_evaluation_batches" TO "authenticated";



GRANT ALL ON TABLE "public"."cooldown_catalog" TO "anon";
GRANT ALL ON TABLE "public"."cooldown_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."cooldown_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."defensive_modifier_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."defensive_modifier_rules" TO "service_role";



GRANT ALL ON TABLE "public"."defensive_plan_assignments" TO "anon";
GRANT ALL ON TABLE "public"."defensive_plan_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."defensive_plan_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."defensive_plan_members" TO "service_role";
GRANT SELECT ON TABLE "public"."defensive_plan_members" TO "authenticated";



GRANT ALL ON TABLE "public"."defensive_plan_runs" TO "anon";
GRANT ALL ON TABLE "public"."defensive_plan_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."defensive_plan_runs" TO "service_role";



GRANT ALL ON TABLE "public"."defensive_plan_slots" TO "service_role";
GRANT SELECT ON TABLE "public"."defensive_plan_slots" TO "authenticated";



GRANT ALL ON TABLE "public"."defensive_reanalysis_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."defensive_reanalysis_batches" TO "service_role";



GRANT ALL ON TABLE "public"."defensive_reanalysis_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."defensive_reanalysis_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."defensive_spec_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."defensive_spec_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."discord_roster_channels" TO "anon";
GRANT ALL ON TABLE "public"."discord_roster_channels" TO "authenticated";
GRANT ALL ON TABLE "public"."discord_roster_channels" TO "service_role";



GRANT ALL ON TABLE "public"."discord_roster_channels_settings" TO "anon";
GRANT ALL ON TABLE "public"."discord_roster_channels_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."discord_roster_channels_settings" TO "service_role";



GRANT ALL ON TABLE "public"."known_raid_bosses" TO "anon";
GRANT ALL ON TABLE "public"."known_raid_bosses" TO "authenticated";
GRANT ALL ON TABLE "public"."known_raid_bosses" TO "service_role";



GRANT ALL ON TABLE "public"."llm_calls" TO "anon";
GRANT ALL ON TABLE "public"."llm_calls" TO "authenticated";
GRANT ALL ON TABLE "public"."llm_calls" TO "service_role";



GRANT ALL ON TABLE "public"."mechanic_defensive_assignments" TO "anon";
GRANT ALL ON TABLE "public"."mechanic_defensive_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."mechanic_defensive_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."mechanic_responsibility_edges" TO "service_role";
GRANT SELECT ON TABLE "public"."mechanic_responsibility_edges" TO "authenticated";



GRANT ALL ON TABLE "public"."night_briefs" TO "anon";
GRANT ALL ON TABLE "public"."night_briefs" TO "authenticated";
GRANT ALL ON TABLE "public"."night_briefs" TO "service_role";



GRANT ALL ON TABLE "public"."night_full_reports" TO "anon";
GRANT ALL ON TABLE "public"."night_full_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."night_full_reports" TO "service_role";



GRANT ALL ON TABLE "public"."night_player_briefs" TO "anon";
GRANT ALL ON TABLE "public"."night_player_briefs" TO "authenticated";
GRANT ALL ON TABLE "public"."night_player_briefs" TO "service_role";



GRANT ALL ON TABLE "public"."player_execution_events" TO "service_role";
GRANT SELECT ON TABLE "public"."player_execution_events" TO "authenticated";



GRANT ALL ON TABLE "public"."night_player_execution_summary_v3" TO "authenticated";
GRANT ALL ON TABLE "public"."night_player_execution_summary_v3" TO "service_role";



GRANT ALL ON TABLE "public"."night_player_infographics" TO "anon";
GRANT ALL ON TABLE "public"."night_player_infographics" TO "authenticated";
GRANT ALL ON TABLE "public"."night_player_infographics" TO "service_role";



GRANT ALL ON TABLE "public"."player_pull_records" TO "anon";
GRANT ALL ON TABLE "public"."player_pull_records" TO "authenticated";
GRANT ALL ON TABLE "public"."player_pull_records" TO "service_role";



GRANT ALL ON TABLE "public"."own_mechanic_hit_ratios" TO "anon";
GRANT ALL ON TABLE "public"."own_mechanic_hit_ratios" TO "authenticated";
GRANT ALL ON TABLE "public"."own_mechanic_hit_ratios" TO "service_role";



GRANT ALL ON TABLE "public"."player_defensive_override_audit" TO "service_role";
GRANT SELECT ON TABLE "public"."player_defensive_override_audit" TO "authenticated";



GRANT ALL ON TABLE "public"."report_encounters" TO "anon";
GRANT ALL ON TABLE "public"."report_encounters" TO "authenticated";
GRANT ALL ON TABLE "public"."report_encounters" TO "service_role";



GRANT ALL ON TABLE "public"."reports" TO "anon";
GRANT ALL ON TABLE "public"."reports" TO "authenticated";
GRANT ALL ON TABLE "public"."reports" TO "service_role";



GRANT ALL ON TABLE "public"."player_latest_build" TO "authenticated";
GRANT ALL ON TABLE "public"."player_latest_build" TO "service_role";



GRANT ALL ON TABLE "public"."wowaudit_roster" TO "anon";
GRANT ALL ON TABLE "public"."wowaudit_roster" TO "authenticated";
GRANT ALL ON TABLE "public"."wowaudit_roster" TO "service_role";



GRANT ALL ON TABLE "public"."player_latest_loadout" TO "anon";
GRANT ALL ON TABLE "public"."player_latest_loadout" TO "authenticated";
GRANT ALL ON TABLE "public"."player_latest_loadout" TO "service_role";



GRANT ALL ON TABLE "public"."player_latest_spec" TO "anon";
GRANT ALL ON TABLE "public"."player_latest_spec" TO "authenticated";
GRANT ALL ON TABLE "public"."player_latest_spec" TO "service_role";



GRANT ALL ON TABLE "public"."player_mechanic_offenses" TO "anon";
GRANT ALL ON TABLE "public"."player_mechanic_offenses" TO "authenticated";
GRANT ALL ON TABLE "public"."player_mechanic_offenses" TO "service_role";



GRANT ALL ON TABLE "public"."player_mechanic_offenses_v3" TO "authenticated";
GRANT ALL ON TABLE "public"."player_mechanic_offenses_v3" TO "service_role";



GRANT ALL ON TABLE "public"."player_pull_defensive_evaluations" TO "service_role";
GRANT SELECT ON TABLE "public"."player_pull_defensive_evaluations" TO "authenticated";



GRANT ALL ON TABLE "public"."player_pull_execution_summary_v3" TO "authenticated";
GRANT ALL ON TABLE "public"."player_pull_execution_summary_v3" TO "service_role";



GRANT ALL ON TABLE "public"."player_pull_reliability_inputs_legacy_v1" TO "service_role";
GRANT SELECT ON TABLE "public"."player_pull_reliability_inputs_legacy_v1" TO "authenticated";



GRANT ALL ON TABLE "public"."player_pull_reliability_inputs" TO "service_role";
GRANT SELECT ON TABLE "public"."player_pull_reliability_inputs" TO "authenticated";



GRANT ALL ON TABLE "public"."pull_briefs" TO "anon";
GRANT ALL ON TABLE "public"."pull_briefs" TO "authenticated";
GRANT ALL ON TABLE "public"."pull_briefs" TO "service_role";



GRANT ALL ON TABLE "public"."pull_defensive_plan_binding_audit" TO "service_role";
GRANT SELECT ON TABLE "public"."pull_defensive_plan_binding_audit" TO "authenticated";



GRANT ALL ON TABLE "public"."pull_dispel_events" TO "service_role";
GRANT SELECT ON TABLE "public"."pull_dispel_events" TO "authenticated";



GRANT ALL ON TABLE "public"."pull_evaluation_context_audit" TO "service_role";
GRANT SELECT ON TABLE "public"."pull_evaluation_context_audit" TO "authenticated";



GRANT ALL ON TABLE "public"."session_state" TO "anon";
GRANT ALL ON TABLE "public"."session_state" TO "authenticated";
GRANT ALL ON TABLE "public"."session_state" TO "service_role";



GRANT ALL ON TABLE "public"."talent_spell_lookup" TO "anon";
GRANT ALL ON TABLE "public"."talent_spell_lookup" TO "authenticated";
GRANT ALL ON TABLE "public"."talent_spell_lookup" TO "service_role";



GRANT ALL ON TABLE "public"."unassigned_mechanic_catalog" TO "anon";
GRANT ALL ON TABLE "public"."unassigned_mechanic_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."unassigned_mechanic_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."wowaudit_season" TO "anon";
GRANT ALL ON TABLE "public"."wowaudit_season" TO "authenticated";
GRANT ALL ON TABLE "public"."wowaudit_season" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







