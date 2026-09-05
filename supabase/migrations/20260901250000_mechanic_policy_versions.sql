-- Causalidad v3 · Historial inmutable de MechanicPolicy.
-- boss_mechanic_policy conserva la versión vigente para no romper FKs existentes.
-- Esta tabla conserva cada snapshot publicado y permite reproducir una versión.

create table if not exists boss_mechanic_policy_versions (
  boss_id text not null,
  difficulty text not null,
  mechanic_key text not null check (nullif(btrim(mechanic_key), '') is not null),
  policy_version integer not null check (policy_version > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  confidence text not null check (confidence in ('verified', 'inferred', 'fallback', 'uncertain')),
  published_by uuid references auth.users (id) on delete set null,
  published_at timestamptz not null default now(),
  primary key (boss_id, difficulty, mechanic_key, policy_version)
);

create index if not exists boss_mechanic_policy_versions_scope_idx
  on boss_mechanic_policy_versions (boss_id, difficulty, mechanic_key, policy_version desc);

create or replace function snapshot_boss_mechanic_policy_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

drop trigger if exists boss_mechanic_policy_snapshot_version on boss_mechanic_policy;
create trigger boss_mechanic_policy_snapshot_version
after insert or update on boss_mechanic_policy
for each row execute function snapshot_boss_mechanic_policy_version();

insert into boss_mechanic_policy_versions (
  boss_id, difficulty, mechanic_key, policy_version, snapshot, confidence,
  published_by, published_at
)
select
  boss_id, difficulty, mechanic_key, policy_version, to_jsonb(boss_mechanic_policy),
  confidence, reviewed_by, updated_at
from boss_mechanic_policy
on conflict (boss_id, difficulty, mechanic_key, policy_version) do nothing;

alter table boss_mechanic_policy_versions enable row level security;
drop policy if exists "boss_mechanic_policy_versions: officers read" on boss_mechanic_policy_versions;
create policy "boss_mechanic_policy_versions: officers read"
  on boss_mechanic_policy_versions for select using (is_officer());
revoke all on boss_mechanic_policy_versions from anon, authenticated;
grant select on boss_mechanic_policy_versions to authenticated;

comment on table boss_mechanic_policy_versions is
  'Snapshots inmutables de cada publicación de policy. La tabla boss_mechanic_policy conserva únicamente el estado vigente compatible con FKs legacy.';
