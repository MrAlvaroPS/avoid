-- §causal-fix trigger gap (2026-09-10, hallazgo empírico real): tras
-- desplegar episode-evaluator@9 (defensive-episode-verdict.ts —
-- reconstructCausalAvailability ahora también acepta daño crudo real, no
-- solo episodios agrupados, como evidencia de disponibilidad legítima),
-- ningún mecanismo existente disparaba la regeneración canónica.
--
-- canonical_defensive_report_needs_refresh() SOLO compara COBERTURA de
-- datos (¿está todo ingerido? ¿el recuento de filas elegibles coincide con
-- lo publicado?) — nunca compara la IDENTIDAD de versión del evaluador
-- desplegado contra la generación publicada. Un informe cuyos datos ya
-- estaban 100% cubiertos bajo v8 siempre devolvía false, así que ni
-- "Actualizar infografías" (ensureNightInfographicReadiness →
-- canonical-defensive-auto-refresh action=start) ni el wake-up automático
-- por trigger de reports/report_encounters llamaban jamás a
-- canonical-defensive-refresh con los parámetros v9 reales — el único sitio
-- donde SÍ se compara la versión desplegada contra la publicada
-- (begin_or_resume_canonical_defensive_refresh) nunca llegaba a invocarse.
--
-- El incidente del 2026-09-10 anterior (20260910001000) no sufrió esto
-- porque en ese caso SÍ existía una generación `building` con contrato
-- distinto al que pedía el nuevo worker — eso es detectable sin ayuda
-- porque compara dos filas de defensive_generations entre sí. Aquí no hay
-- ninguna `building`: solo una `published` que, por cobertura de datos, ya
-- parece completa. La única forma de saber "el código cambió" es que algo
-- recuerde qué contrato se ESPERA en este momento, independiente de lo que
-- ya esté publicado.
--
-- canonical_defensive_expected_contract es esa memoria: una fila única
-- (mismo patrón que defensive_generation_pointer/
-- canonical_defensive_refresh_dispatch_runtime) que cada despliegue de una
-- nueva EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V{N}/
-- DEFENSIVE_EPISODE_EVALUATOR_VERSION_V{N} debe actualizar (vía una
-- migración pequeña como esta, junto al bump de versión en TypeScript) —
-- exactamente igual que hoy ya hay que tocar defensive-evidence-v{N}.ts.
-- needs_refresh() la consulta; si la generación publicada no coincide,
-- devuelve true sin importar si la cobertura de datos "parece" completa.

create table if not exists canonical_defensive_expected_contract (
  id boolean primary key default true check (id),
  game_build text not null,
  semantic_version text not null,
  resolver_version text not null,
  semantic_resolver_version text not null,
  episode_version text not null,
  evaluator_version text not null,
  updated_at timestamptz not null default now()
);

alter table canonical_defensive_expected_contract enable row level security;
revoke all on canonical_defensive_expected_contract from anon, authenticated;
grant select on canonical_defensive_expected_contract to service_role;

insert into canonical_defensive_expected_contract (
  id, game_build, semantic_version, resolver_version,
  semantic_resolver_version, episode_version, evaluator_version, updated_at
) values (
  true, '12.1.0.68914', 'defensive-semantics@1.0.0', 'effective-defensives@2.4.0',
  'effective-defensive-semantics@1.5.0', 'episode-evaluator@9', 'episode-evaluator@9', now()
)
on conflict (id) do update
set game_build = excluded.game_build,
    semantic_version = excluded.semantic_version,
    resolver_version = excluded.resolver_version,
    semantic_resolver_version = excluded.semantic_resolver_version,
    episode_version = excluded.episode_version,
    evaluator_version = excluded.evaluator_version,
    updated_at = now();

create or replace function canonical_defensive_report_needs_refresh(p_report_code text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  eligible_rows integer := 0;
  published_expected_rows integer := 0;
  published_generation_id uuid;
  expected canonical_defensive_expected_contract%rowtype;
  published defensive_generations%rowtype;
begin
  if not canonical_defensive_report_ingestion_complete(p_report_code) then
    return false;
  end if;

  select count(*) into eligible_rows
  from canonical_defensive_eligible_player_pulls e
  where e.report_code = p_report_code;

  if eligible_rows = 0 then
    return false;
  end if;

  select ptr.published_generation_id into published_generation_id
  from defensive_generation_pointer ptr
  where ptr.id = true;

  if published_generation_id is null then
    return true;
  end if;

  -- §causal-fix trigger gap — un cambio de CÓDIGO (versión de evaluador
  -- desplegada) es tan "necesita refresh" como un dato ausente. Se comprueba
  -- antes de la cuenta de filas: si la generación publicada ya no coincide
  -- con el contrato esperado, no importa que su cobertura "parezca" completa.
  select * into expected from canonical_defensive_expected_contract where id = true;
  if found then
    select * into published from defensive_generations where id = published_generation_id;
    if found and (
      published.game_build is distinct from expected.game_build
      or published.semantic_version is distinct from expected.semantic_version
      or published.resolver_version is distinct from expected.resolver_version
      or published.semantic_resolver_version is distinct from expected.semantic_resolver_version
      or published.episode_version is distinct from expected.episode_version
      or published.evaluator_version is distinct from expected.evaluator_version
    ) then
      return true;
    end if;
  end if;

  select count(*) into published_expected_rows
  from published_defensive_expected_player_pulls e
  where e.report_code = p_report_code;

  -- A build/eligibility mismatch is not "0 opportunities". It is work (or an
  -- explicit blocked state if the deployed worker cannot support that build).
  if published_expected_rows <> eligible_rows then
    return true;
  end if;

  return exists (
    select 1
    from published_defensive_expected_player_pulls e
    join defensive_generations g on g.id = e.defensive_generation_id
    left join player_pull_defensive_episode_evaluations s
      on s.defensive_generation_id = e.defensive_generation_id
     and s.pull_id = e.pull_id
     and s.player_name = e.player_name
     and s.episode_evaluator_version = g.evaluator_version
     and s.semantic_version = g.semantic_version
     and s.semantic_resolver_version = g.semantic_resolver_version
     and s.resolver_version = g.resolver_version
    where e.report_code = p_report_code
      and s.pull_id is null
  );
end;
$$;
revoke all on function canonical_defensive_report_needs_refresh(text) from public, anon, authenticated;
grant execute on function canonical_defensive_report_needs_refresh(text) to service_role;
