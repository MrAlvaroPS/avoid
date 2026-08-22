// Ningún cliente compartido (wcl-client, blizzard-client, wago-db2-client)
// ponía timeout a sus fetch() — verificado en real el 2026-08-22: wago.tools
// se queda colgado sin responder (ni siquiera completa el handshake TLS) al
// menos desde algunas redes, y sin timeout eso cuelga sync-boss-mechanics
// entero hasta el límite de ejecución de la Edge Function, en vez de caer
// al fallback ya previsto (`difficulty-metadata-unavailable`). Con esto, un
// origen externo lento o caído se convierte en un error rápido y controlado.
export async function fetchWithTimeout(url: string | URL, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timeout tras ${timeoutMs}ms esperando ${typeof url === 'string' ? url : url.toString()}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
