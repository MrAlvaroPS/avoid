-- §Item 4 de "Preparación" (auto-asignación en cascada, ver plan guardado):
-- dos piezas de soporte.

-- 1) cooldown_catalog no llevaba updated_at — necesario para el aviso "se
-- recomienda re-sincronizar/regenerar" cuando un defensivo se edita
-- DESPUÉS de haber generado asignaciones automáticas para una spec.
alter table cooldown_catalog add column if not exists updated_at timestamptz not null default now();

-- 2) §"muchos muchos muchos logs... si solo valoramos unos pocos, lo
-- trampeamos" (feedback real, 2026-08-31): fetchPublicRankings paginado
-- barato (solo metadata de ranking, no fights completos) permite crecer la
-- muestra SIN límite práctico, pero procesar cada fight (DamageTaken+Casts+
-- roles) sí tiene un techo real de CPU por invocación — ya visto esta
-- sesión. La solución es acumular ENTRE sincronizaciones, no traer todo de
-- golpe: esta tabla recuerda cuántos logs de referencia ya se consumieron
-- por boss+dificultad, para que cada sync pida la SIGUIENTE tanda (no
-- repetir los mismos) y boss_mechanic_defensive_profile.reference_*
-- acumule (concatene) en vez de reemplazar.
create table if not exists boss_reference_sync_state (
  boss_id text not null,
  difficulty text not null,
  reference_fights_consumed integer not null default 0,
  last_synced_at timestamptz,
  primary key (boss_id, difficulty)
);

alter table boss_reference_sync_state enable row level security;
create policy "read all - boss_reference_sync_state" on boss_reference_sync_state for select using (is_officer());
