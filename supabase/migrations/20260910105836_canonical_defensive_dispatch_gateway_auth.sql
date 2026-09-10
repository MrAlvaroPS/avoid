-- Mantiene el dispatcher interno detrás de verify_jwt=true. El JWT anónimo
-- solo satisface el gateway; el handler sigue exigiendo además el token UUID
-- privado de canonical_defensive_refresh_dispatch_runtime. La credencial se
-- configura fuera de la migración y permanece cifrada en Vault.

create or replace function public.dispatch_canonical_defensive_refresh_async()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, net, pg_temp
as $$
declare
  target_url text;
  token uuid;
  gateway_jwt text;
begin
  target_url := remember_canonical_defensive_dispatch_url_from_request();
  select r.dispatch_token into token
  from canonical_defensive_refresh_dispatch_runtime r
  where r.id = true;

  select s.decrypted_secret into gateway_jwt
  from vault.decrypted_secrets s
  where s.name = 'canonical_defensive_dispatch_gateway_jwt'
  order by s.updated_at desc
  limit 1;

  if target_url is null or token is null or nullif(gateway_jwt, '') is null then
    return false;
  end if;

  perform net.http_post(
    url := target_url,
    body := jsonb_build_object('action', 'drain'),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || gateway_jwt,
      'apikey', gateway_jwt,
      'x-iris-dispatch-token', token::text
    ),
    timeout_milliseconds := 5000
  );
  return true;
exception when others then
  -- El estado durable de cola permite reintentar desde el siguiente wake-up.
  return false;
end;
$$;

revoke all on function public.dispatch_canonical_defensive_refresh_async()
  from public, anon, authenticated;
grant execute on function public.dispatch_canonical_defensive_refresh_async()
  to service_role;

comment on function public.dispatch_canonical_defensive_refresh_async() is
  'Wake-up asíncrono con doble autenticación: JWT de gateway cifrado en Vault y token interno privado.';
