-- §"proteger todos los datos y rutas salvo que esté logeado un oficial, el
-- resto no debería de poder ver nada" (feedback real, 2026-08-29): hasta
-- ahora casi todas las tablas v2 tenían `for select using (true)` — lectura
-- pública total con solo la anon key (que va en el bundle desplegado). Se
-- reemplaza cada una de esas políticas por `using (is_officer())`
-- (ver 20260829090000_officer_auth.sql). No se toca insert/update/delete:
-- ninguna de estas tablas concede esas operaciones a anon/authenticated
-- hoy — las escrituras siguen siendo exclusivas de service_role (Edge
-- Functions), sin cambios de comportamiento ahí.
--
-- Se despliega DELIBERADAMENTE después de validar login + verify-officer +
-- el guard de las Edge Functions: si algo de esas piezas fallase, prefiero
-- que la app se quede en su estado actual (sin login) en vez de sin datos
-- para todo el mundo, oficiales incluidos.
do $$
declare
  t text;
  policy_name text;
  tables text[] := array[
    'boss_mechanics', 'boss_mechanics_candidates', 'report_encounters', 'reports',
    'pulls', 'player_pull_records', 'pull_briefs', 'llm_calls', 'session_state',
    'pull_mechanic_events', 'cooldown_catalog', 'boss_reference_stats',
    'known_raid_bosses', 'wowaudit_season', 'night_player_briefs', 'night_briefs',
    'night_full_reports', 'boss_encounter_phases', 'unassigned_mechanic_catalog'
  ];
begin
  foreach t in array tables loop
    policy_name := 'read all - ' || t;
    -- §bug real encontrado en despliegue (2026-08-30): un nombre de
    -- política no es un literal de texto, es un identificador — %L lo
    -- entrecomillaba como cadena ('read all - boss_mechanics'), sintaxis
    -- inválida en la posición de nombre de política. %I es el formato
    -- correcto para identificadores (entrecomilla solo si hace falta, p.ej.
    -- por el espacio/guion del nombre). Esta migración nunca había llegado
    -- a aplicarse en remoto por este error — bloqueaba cualquier `db push`
    -- posterior.
    execute format('drop policy if exists %I on %I', policy_name, t);
    execute format('create policy %I on %I for select using (is_officer())', policy_name, t);
  end loop;
end $$;

-- Estas tres tienen un nombre de política distinto ("... is publicly readable"), mismo tratamiento.
drop policy if exists "talent_spell_lookup is publicly readable" on talent_spell_lookup;
create policy "talent_spell_lookup is publicly readable" on talent_spell_lookup for select using (is_officer());

drop policy if exists "wowaudit_roster is publicly readable" on wowaudit_roster;
create policy "wowaudit_roster is publicly readable" on wowaudit_roster for select using (is_officer());

drop policy if exists "discord_roster_channels_settings is publicly readable" on discord_roster_channels_settings;
create policy "discord_roster_channels_settings is publicly readable" on discord_roster_channels_settings for select using (is_officer());

drop policy if exists "discord_roster_channels is publicly readable" on discord_roster_channels;
create policy "discord_roster_channels is publicly readable" on discord_roster_channels for select using (is_officer());

-- §hallazgo real de esta auditoría: por defecto una vista NO invocadora
-- (sin `security_invoker = true`) evalúa RLS con los privilegios del OWNER
-- de la vista (el rol de las migraciones, con BYPASSRLS) — así que estas
-- tres seguirían devolviendo TODAS las filas a cualquiera aunque las tablas
-- base ya estén cerradas arriba. applicable_pull_mechanic_events,
-- applicable_boss_mechanics_candidates y own_mechanic_hit_ratios YA tenían
-- security_invoker=true (comprobado en sus migraciones) — no hace falta
-- tocarlas.
alter view player_pull_reliability_inputs set (security_invoker = true);
alter view player_mechanic_offenses set (security_invoker = true);
alter view player_latest_spec set (security_invoker = true);
