// §"proteger todos los datos y rutas salvo que esté logeado un oficial"
// (feedback real, 2026-08-29): hoy verify_jwt=true (default) en casi todas
// las funciones solo exige ALGÚN JWT bien formado del proyecto — la propia
// anon key pública ya cuela, así que ninguna función comprobaba de verdad
// QUIÉN llama. Este guard sí lo hace: exige una sesión de usuario real
// (Authorization: Bearer <access_token>, lo manda supabase-js solo cuando
// hay sesión) y, para requireOfficer, que user_profiles.is_officer sea
// true — la misma caché que escribe verify-officer/index.ts tras consultar
// el bot de Discord. Se llama al principio de cada Deno.serve; si devuelve
// un Response, el caller debe hacer `return` con él tal cual.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { jsonResponse } from './cors.ts';

function adminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

async function currentUser(req: Request): Promise<{ id: string } | null> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id };
}

/** Solo exige sesión válida (cualquier usuario logeado con Discord), sin exigir el rol de Oficial — uso exclusivo de verify-officer, que es justo quien decide ese rol. */
export async function requireUser(req: Request): Promise<{ userId: string } | Response> {
  const user = await currentUser(req);
  if (!user) return jsonResponse({ ok: false, error: 'No autenticado.' }, 401);
  return { userId: user.id };
}

/** Exige sesión válida Y user_profiles.is_officer = true. Para el resto de funciones (todas menos verify-officer y wowanalyzer-proxy). */
export async function requireOfficer(req: Request): Promise<{ userId: string } | Response> {
  const user = await currentUser(req);
  if (!user) return jsonResponse({ ok: false, error: 'No autenticado.' }, 401);

  const { data, error } = await adminClient().from('user_profiles').select('is_officer').eq('user_id', user.id).maybeSingle();
  if (error) return jsonResponse({ ok: false, error: 'No se pudo comprobar el rol de Oficial.' }, 500);
  if (!data?.is_officer) return jsonResponse({ ok: false, error: 'No autorizado: se requiere el rol de Oficial.' }, 403);

  return { userId: user.id };
}
