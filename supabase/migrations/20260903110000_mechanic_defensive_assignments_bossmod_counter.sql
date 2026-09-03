-- §"el trigger... se puede anclar a una mecánica de bossmod o de bigwigs...
-- ten en cuenta todo esto" (feedback real, 2026-09-03). El plan automático
-- (generate-defensive-plan) convierte cada fila de mechanic_defensive_
-- assignments en una reserva blanda para cada ocurrencia de esa ability, pero
-- SIEMPRE mandaba bossmodCounterVerified=false al solver — no existía forma
-- de guardar el counter real de BigWigs/DBM, así que la asignación
-- automática degradaba en silencio a un trigger de tiempo fijo incluso
-- cuando el oficial ya había puesto bossmod_spell_id a mano. Mismo patrón de
-- verificación explícita que defensive_plan_slots (migración 20260901110000):
-- sin marcar verified, sigue degradando de forma segura, nunca se asume.

alter table mechanic_defensive_assignments
  add column if not exists bossmod_counter text,
  add column if not exists bossmod_counter_verified boolean not null default false;

alter table mechanic_defensive_assignments
  drop constraint if exists mechanic_defensive_assignments_bossmod_counter_check;
alter table mechanic_defensive_assignments
  add constraint mechanic_defensive_assignments_bossmod_counter_check
  check (not bossmod_counter_verified or (trigger_type = 'bossmod' and nullif(btrim(bossmod_counter), '') is not null));

comment on column mechanic_defensive_assignments.bossmod_counter is
  'Contador de la ocurrencia en el timer de BigWigs/DBM (p.ej. "2" para el 2º cast de esta ability). Ver mrt-reminder-codec.ts.';
comment on column mechanic_defensive_assignments.bossmod_counter_verified is
  'true = el oficial confirmó este counter contra un timer real en juego. Sin esto, generate-defensive-plan degrada a trigger de tiempo fijo aunque haya bossmod_spell_id — nunca se asume un counter sin verificar.';
