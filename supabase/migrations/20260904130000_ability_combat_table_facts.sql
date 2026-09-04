-- IRIS Defensive Canonicalization v1 · Paso C-1 — cache cross-pull de
-- observaciones POSITIVAS del combat table (dodge/parry/block) por
-- ability. Ver iris-defensive-canonicalization-v1-plan.md §2.4.1.
--
-- Decisión explícita del usuario (2026-09-04): dodge/parry/block-capacidad
-- es una propiedad ESTÁTICA de la ability (no cambia entre pulls) y block
-- solo aparece en ~0.4% de los hits reales — un solo pull rara vez lo
-- demuestra. Cache aditivo (contadores, no booleanos eternos), versionado
-- por ability_game_id + game_build, con provenance (primer/último pull y
-- boss donde se observó). Nunca se convierte en fuente de scoring
-- independiente — solo alimenta damage-descriptor-wcl.ts
-- (combatTableVerdictFor), que a su vez solo puede producir true/null
-- (nunca false) hacia canDefensiveCover().

create table if not exists ability_combat_table_facts (
  ability_game_id bigint not null,
  game_build text not null check (nullif(btrim(game_build), '') is not null),
  dodge_count integer not null default 0 check (dodge_count >= 0),
  parry_count integer not null default 0 check (parry_count >= 0),
  block_count integer not null default 0 check (block_count >= 0),
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  first_observed_pull_id uuid references pulls (id) on delete set null,
  last_observed_pull_id uuid references pulls (id) on delete set null,
  first_observed_boss_id text,
  last_observed_boss_id text,
  primary key (ability_game_id, game_build)
);

create index if not exists ability_combat_table_facts_last_observed_idx
  on ability_combat_table_facts (last_observed_at desc);

alter table ability_combat_table_facts enable row level security;
drop policy if exists "ability_combat_table_facts: officers read" on ability_combat_table_facts;
create policy "ability_combat_table_facts: officers read"
  on ability_combat_table_facts for select using (is_officer());

revoke all on ability_combat_table_facts from anon, authenticated;
grant select on ability_combat_table_facts to authenticated;

comment on table ability_combat_table_facts is
  'Cache cross-pull, puramente aditivo, de veces que se observó dodge/parry/block real (WCL hitType=7/8, o campo blocked>0) para una abilityGameID+game_build. Evidencia acumulada para DamageDescriptor (damage-descriptor-wcl.ts) — nunca una fuente de scoring independiente. Ausencia de fila = sin evidencia = unknown, nunca false.';
comment on column ability_combat_table_facts.dodge_count is 'Veces que WCL reportó hitType=7 (Dodge, verificado empíricamente vía filterExpression missType) para esta ability — solo cuenta, nunca decrementa.';
comment on column ability_combat_table_facts.parry_count is 'Veces que WCL reportó hitType=8 (Parry, verificado empíricamente) para esta ability.';
comment on column ability_combat_table_facts.block_count is 'Veces que el evento trajo blocked>0 (campo directo de WCL, sin ambigüedad de hitType) para esta ability.';

notify pgrst, 'reload schema';
