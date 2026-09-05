-- Gestión defensiva v2 · M2
--
-- Amplía el snapshot histórico ya existente. No duplica talent_build: añade
-- identidad determinista, build de reglas y versión del resolver que produjo
-- los derivados defensivos.

alter table player_pull_records
  add column if not exists talent_build_fingerprint text,
  add column if not exists game_build text,
  add column if not exists game_build_source text,
  add column if not exists game_build_confidence text not null default 'uncertain',
  add column if not exists defensive_resolution_version text,
  add column if not exists defensive_resolution_shadow jsonb;

alter table player_pull_records
  drop constraint if exists player_pull_records_game_build_confidence_check;
alter table player_pull_records
  add constraint player_pull_records_game_build_confidence_check
  check (game_build_confidence in ('verified', 'inferred', 'fallback', 'uncertain'));

comment on column player_pull_records.talent_build_fingerprint is
  'SHA-256 determinista de class+spec+game_build+nodos normalizados. Null en histórico pendiente de backfill o cuando el build no es identificable.';
comment on column player_pull_records.game_build is
  'Build exacto X.Y.Z.build usado para resolver este snapshot. No confundir con WCL masterData.gameVersion, que solo distingue Retail/Classic.';
comment on column player_pull_records.game_build_source is
  'Provenance del game_build (por ejemplo Blizzard namespace observado al importar o backfill por timeline de patches).';
comment on column player_pull_records.game_build_confidence is
  'Confianza de la asociación pull→game_build. uncertain excluye decisiones dependientes de reglas del scoring estricto.';
comment on column player_pull_records.defensive_resolution_version is
  'Versión del resolver usada al materializar death_cause/pressure metadata. Null = pipeline legacy.';
comment on column player_pull_records.defensive_resolution_shadow is
  'Diagnóstico no autoritativo del resolver v2 (kit, provenance y diferencias). Nunca sustituye scoring legacy por sí solo.';

create index if not exists player_pull_records_latest_build_idx
  on player_pull_records (player_name, created_at desc)
  where class is not null and spec is not null;
create index if not exists player_pull_records_build_scope_idx
  on player_pull_records (class, spec, game_build)
  where game_build is not null;

drop view if exists player_latest_build;
create view player_latest_build
with (security_invoker = true) as
select distinct on (record.player_name)
  record.player_name,
  record.class,
  record.spec,
  record.talent_build,
  record.talent_build_fingerprint,
  record.game_build,
  record.game_build_source,
  record.game_build_confidence,
  coalesce(
    to_timestamp((report.start_time + encounter.start_time) / 1000.0),
    pull.closed_at,
    record.created_at
  ) as observed_at,
  pull.report_code,
  record.pull_id
from player_pull_records record
join pulls pull on pull.id = record.pull_id
left join reports report on report.code = pull.report_code
left join report_encounters encounter
  on encounter.report_code = pull.report_code
 and encounter.fight_id = pull.fight_id
where record.class is not null
  and record.spec is not null
order by
  record.player_name,
  coalesce(
    to_timestamp((report.start_time + encounter.start_time) / 1000.0),
    pull.closed_at,
    record.created_at
  ) desc,
  record.created_at desc;

comment on view player_latest_build is
  'Último build observado por jugador en WCL. Es la fuente de preparación futura; el build histórico de un pull sigue viviendo en player_pull_records.';

revoke all on player_latest_build from anon;
grant select on player_latest_build to authenticated;
