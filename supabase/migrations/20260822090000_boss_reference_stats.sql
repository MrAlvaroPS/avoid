-- §"a qué estamos llegando tarde": ritmo del pull propio comparado contra el
-- mejor kill público del mismo boss+dificultad (mismo log de referencia que
-- ya usa sync-boss-mechanics para inferir categorías — se guarda aquí una
-- vez por boss+dificultad en vez de recalcularlo en cada pull).
create table if not exists boss_reference_stats (
  boss_id text not null,
  difficulty text not null,
  reference_kill_duration_ms integer not null,
  reference_report_code text not null,
  reference_fight_id integer not null,
  updated_at timestamptz not null default now(),
  primary key (boss_id, difficulty)
);

alter table boss_reference_stats enable row level security;
create policy "read all - boss_reference_stats" on boss_reference_stats for select using (true);

comment on table boss_reference_stats is 'Duración del mejor kill público (worldData.fightRankings) por boss+dificultad — benchmark de ritmo, no dato editorial. Lo recalcula sync-boss-mechanics en cada sync.';
