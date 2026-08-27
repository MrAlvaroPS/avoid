-- §"WCL tiene fases de encuentro, importarlas e implementarlas en todos
-- los sitios donde corresponda" (feedback real). Verificado por
-- introspección real contra la API de WCL (2026-08-27): ReportFight expone
-- `phaseTransitions { id startTime }`, `lastPhaseAsAbsoluteIndex` y
-- `lastPhaseIsIntermission`; Report expone `phases { encounterID
-- separatesWipes phases { id name isIntermission } }` con el nombre legible
-- de cada fase. No todos los bosses tienen fases (bosses de un solo golpe
-- devuelven null en los cuatro campos) -- eso es una fase única implícita,
-- no un fallo de ingesta.
alter table pulls
  add column if not exists phase_transitions jsonb,
  add column if not exists last_phase_absolute_index integer,
  add column if not exists last_phase_is_intermission boolean;

comment on column pulls.phase_transitions is
  'Lista cronológica de transiciones de fase observadas EN ESTE pull: [{id, startTime}]. id referencia boss_encounter_phases(boss_id, phase_id). Null = boss sin fases definidas en WCL.';
comment on column pulls.last_phase_absolute_index is
  'Índice absoluto (0-based, cuenta fases normales + intermedios) de la fase en la que terminó el pull -- mejor proxy de progreso que wipe_pct en bosses donde el % de vida se reinicia por fase (ver boss_encounter_phases.separates_wipes).';
comment on column pulls.last_phase_is_intermission is
  'true si el pull terminó durante un intermedio (p.ej. fase de adds/transición), no durante una fase de daño normal al boss.';

-- Metadata ESTÁTICA de fases por boss -- igual para todos los pulls de ese
-- encuentro, se sincroniza best-effort desde analyze-report (mismo patrón
-- que boss_reference_stats: nunca bloquea el análisis si WCL no la trae).
create table if not exists boss_encounter_phases (
  boss_id text not null,
  phase_id integer not null,
  name text not null,
  is_intermission boolean,
  -- "Si las fases pueden usarse para separar wipes en la UI del report"
  -- (descripción oficial de WCL) -- señal de que bossPercentage/fightPercentage
  -- pueden no ser comparables directamente entre fases de este boss.
  separates_wipes boolean,
  updated_at timestamptz not null default now(),
  primary key (boss_id, phase_id)
);
alter table boss_encounter_phases enable row level security;
drop policy if exists "read all - boss_encounter_phases" on boss_encounter_phases;
create policy "read all - boss_encounter_phases" on boss_encounter_phases for select using (true);

comment on table boss_encounter_phases is
  'Nombre legible + metadata de cada fase de cada boss, sincronizado desde Report.phases de WCL en analyze-report. Referencia de solo lectura para la app; no depende de ningún pull concreto.';

-- Igual que pull_mechanic_events ya guarda trigger_time_ms del pull, guarda
-- en qué fase ocurrió -- permite filtrar/mostrar "esto pasó en fase 2" sin
-- recalcular phase_transitions cada vez que se lee.
alter table pull_mechanic_events
  add column if not exists phase_id integer;

comment on column pull_mechanic_events.phase_id is
  'Fase (boss_encounter_phases.phase_id) activa en el momento de trigger_time_ms. Null si el boss no tiene fases o el pull no trajo phase_transitions.';
