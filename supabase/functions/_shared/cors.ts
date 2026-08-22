// CORS: Deno/Supabase Edge Functions NO añaden cabeceras CORS por defecto.
// Da igual que la función funcione perfecto por curl (CORS es un concepto de
// navegador, curl nunca lo comprueba) — sin esto, cada `supabase.functions.invoke(...)`
// desde Angular falla en el preflight OPTIONS con "blocked by CORS policy" y
// ni siquiera llega a ejecutarse el handler. Detectado probando la app real
// en un navegador headless, no con curl.

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Llamar al principio de cada Deno.serve: si es el preflight, corta aquí devolviendo la respuesta. */
export function handlePreflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: CORS_HEADERS }) : null;
}

/** JSON.stringify + Content-Type + CORS, para no tener que repetirlo en cada `return new Response(...)`. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
