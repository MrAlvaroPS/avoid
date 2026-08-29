-- §"vamos a preparar el login en este proyecto con discord, y que solo
-- puedan continuar el login los que tengan el rol de Oficial en mi
-- servidor" (feedback real, 2026-08-29): Postgres no puede llamar a la API
-- de Discord desde una policy RLS, así que el resultado de "es Oficial de
-- verdad ahora mismo" se cachea aquí — lo escribe la Edge Function
-- verify-officer (service_role, tras consultar el bot de Discord contra
-- discord_roster_channels_settings.officers_role_id, MISMA fuente que ya
-- decide el badge de oficial del roster) justo después de cada login.
-- is_officer() es lo que consultará la migración de cierre de RLS
-- (20260829100000_lock_down_rls_to_officers.sql) en cada tabla.
create table if not exists user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  discord_user_id text not null,
  discord_username text,
  is_officer boolean not null default false,
  checked_at timestamptz not null default now()
);

alter table user_profiles enable row level security;

-- El propio usuario puede leer SU fila (para que el frontend sepa si ya se
-- le denegó el acceso y por qué) — nunca la de otro, y sin insert/update
-- para authenticated: solo service_role (verify-officer) escribe aquí.
create policy "user_profiles: cada usuario lee su propia fila"
  on user_profiles for select
  using (auth.uid() = user_id);

create or replace function public.is_officer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_officer from user_profiles where user_id = auth.uid()),
    false
  );
$$;
