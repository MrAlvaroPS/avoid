-- Estado operativo del catálogo de mecánicas. Es distinto del estado de
-- consumo del perfil defensivo: sync-boss-mechanics es quien mantiene esto.
create table if not exists boss_mechanic_catalog_sync_state (
  boss_id text not null,
  difficulty text not null,
  last_synced_at timestamptz not null,
  sync_mode text not null check (sync_mode in ('deep', 'quick')),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  reference_bundle_count integer not null default 0 check (reference_bundle_count >= 0),
  mapping_status text,
  reference_fetch_error text,
  snapshot_fetch_error text,
  primary key (boss_id, difficulty)
);

alter table boss_mechanic_catalog_sync_state enable row level security;
drop policy if exists "boss_mechanic_catalog_sync_state: officers read" on boss_mechanic_catalog_sync_state;
create policy "boss_mechanic_catalog_sync_state: officers read"
  on boss_mechanic_catalog_sync_state for select using (is_officer());

revoke all on boss_mechanic_catalog_sync_state from anon, authenticated;
grant select on boss_mechanic_catalog_sync_state to authenticated;

comment on table boss_mechanic_catalog_sync_state is
  'Último resultado persistido de sync-boss-mechanics por boss+dificultad; no representa el consumo incremental del perfil defensivo.';