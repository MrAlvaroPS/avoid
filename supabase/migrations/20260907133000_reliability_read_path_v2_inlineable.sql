-- Keep the player-scoped reliability RPC inlineable by PostgreSQL.
--
-- The previous function definition carried SET search_path / SET
-- plan_cache_mode clauses. Those clauses make SQL-language functions
-- non-inlineable, so Postgres executed the whole RPC behind an opaque
-- Function Scan. On the production Dewerland/60d case that turned the
-- otherwise set-based read path into ~2.4s of work.
--
-- Every relation referenced by get_player_pull_reliability_inputs_v2 is
-- already schema-qualified where needed, and the function is SECURITY
-- INVOKER, so no per-function GUC is required here. RESET ALL restores the
-- default function proconfig and lets the planner inline the SQL body.

alter function public.get_player_pull_reliability_inputs_v2(
  text,
  timestamptz,
  text,
  text,
  uuid[]
) reset all;

notify pgrst, 'reload schema';
