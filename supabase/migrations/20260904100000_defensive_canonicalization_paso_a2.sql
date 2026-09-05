-- IRIS Defensive Canonicalization v1 · Paso A-2
-- Ver iris-defensive-canonicalization-v1-plan.md §2.3/§2.8/§5.
--
-- Dos piezas independientes, ambas puramente aditivas:
--
-- 1) canonical_scored_pulls — única población de pulls que CUALQUIER
--    evaluator defensivo (actual o de Paso C) debe usar. Bug real ya
--    encontrado durante la auditoría: un consumer veía 16 pulls, otro 13,
--    porque cada uno construía su propio WHERE contra `pulls` (algunos
--    olvidaban ingestion_status, otros ninja_pull_excluded). M23
--    (20260903070000) ya resolvió esto puntualmente para
--    player_pull_reliability_inputs con un JOIN inline — esta vista
--    generaliza el mismo filtro para que nadie más tenga que repetirlo.
--    security_invoker=true hereda la misma postura de RLS que `pulls` ya
--    tiene hoy (ver "read complete - pulls"); no se inventa una política
--    más estricta aquí, eso es un cambio de seguridad aparte, no de esta
--    migración.
--
--    wipe_call_excluded/wipe_call_signals se conservan sin filtrar aquí a
--    propósito: un wipe call recorta EVENTOS dentro de un pull evaluable,
--    nunca invalida el pull entero (ver auditoría Pitpally,
--    iris-mechanics-audit-remediation-progress.md) — esa lógica vive en
--    cada evaluator, no en la población base.
--
-- 2) defensive_generations + defensive_generation_pointer — esqueleto del
--    ciclo BUILDING → READY → PUBLISHED (§2.8). Se crea la tabla y el
--    puntero singleton ahora, sin escribir en ellos todavía: no hay nada
--    que publicar hasta que Paso C (episodios/ledger) produzca una
--    generación real. Puntero singleton (una fila, boolean PK) en vez de
--    una columna en `reports`: una noche puede abarcar varios reports que
--    deben mostrar la MISMA generación simultáneamente — "una operación"
--    (§2.8) se cumple literalmente con un único UPDATE de una fila, no con
--    un UPDATE masivo de todos los reports cada vez que se hace cutover.

create or replace view canonical_scored_pulls
with (security_invoker = true) as
select
  p.id,
  p.report_code,
  p.fight_id,
  p.boss_id,
  p.difficulty,
  p.pull_number,
  p.wipe_pct,
  p.duration_ms,
  p.closed_at,
  p.wipe_call_excluded,
  p.wipe_call_signals,
  p.wipe_call_confidence,
  p.is_ninja_pull,
  p.ninja_pull_signals
from pulls p
where p.ingestion_status = 'complete'
  and p.ninja_pull_excluded = false;

comment on view canonical_scored_pulls is
  'Única población de pulls para evaluators defensivos (invariante 2 del plan: ningún consumer construye su propio WHERE). ingestion_status=complete + ninja_pull_excluded=false. wipe_call_* se conserva sin filtrar — recorta eventos dentro del pull, no lo excluye entero; eso lo decide cada evaluator.';

revoke all on canonical_scored_pulls from anon;
grant select on canonical_scored_pulls to authenticated;

create table if not exists defensive_generations (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'building' check (status in ('building', 'ready', 'published', 'superseded', 'failed')),
  semantic_version text not null,
  resolver_version text not null,
  semantic_resolver_version text not null,
  episode_version text,
  evaluator_version text,
  game_build text not null,
  notes text,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  published_at timestamptz,
  superseded_at timestamptz
);

comment on table defensive_generations is
  'Ciclo BUILDING→READY→PUBLISHED de una generación defensiva completa (§2.8 del plan). Vacía hasta que Paso C produzca una generación real — esqueleto aditivo, no se escribe todavía.';
comment on column defensive_generations.status is
  'building = reanálisis en curso. ready = todos los pulls a conservar pasaron invariantes, todavía no visible. published = la que sirve el front hoy. superseded = fue published y ya no lo es. failed = se abortó.';

create index if not exists defensive_generations_status_idx on defensive_generations (status);

create table if not exists defensive_generation_pointer (
  id boolean primary key default true check (id),
  published_generation_id uuid references defensive_generations (id),
  updated_at timestamptz not null default now()
);
insert into defensive_generation_pointer (id) values (true) on conflict (id) do nothing;

comment on table defensive_generation_pointer is
  'Puntero singleton (siempre una fila) a la generación defensiva PUBLICADA vigente. El cutover atómico de Paso F es un único UPDATE de esta fila, no un UPDATE masivo de reports — todas las noches ven la misma generación a la vez, incluidas las que abarcan varios reports. NULL = sin generación v3 publicada todavía, todo el front sigue sirviendo el pipeline legacy.';

alter table defensive_generations enable row level security;
alter table defensive_generation_pointer enable row level security;

drop policy if exists "defensive_generations: officers read" on defensive_generations;
create policy "defensive_generations: officers read"
  on defensive_generations for select
  using (is_officer());

drop policy if exists "defensive_generation_pointer: officers read" on defensive_generation_pointer;
create policy "defensive_generation_pointer: officers read"
  on defensive_generation_pointer for select
  using (is_officer());

revoke all on defensive_generations from anon;
revoke all on defensive_generation_pointer from anon;
grant select on defensive_generations to authenticated;
grant select on defensive_generation_pointer to authenticated;

notify pgrst, 'reload schema';
