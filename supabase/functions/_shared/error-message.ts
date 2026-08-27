// §bug real reproducido en real (2026-08-27, al probar classify-defensives
// recién desplegada): el catch final de las Edge Functions usa
// `err instanceof Error ? err.message : String(err)` — un PostgrestError es
// un objeto plano, así que String(err) da literalmente "[object Object]",
// que el frontend enseña tal cual (llega como string, no como objeto, así
// que error-message.util.ts del lado Angular ya no puede rescatarlo). Mismo
// fallo que motivó ese util en el frontend — aquí no existía su
// equivalente del lado Deno. Copia deliberada, no import cruzado: Deno y el
// bundle de Angular son runtimes distintos, no comparten módulos.
export function errorMessage(error: unknown, fallback = 'Ha ocurrido un error inesperado.'): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const parts = [record['message'], record['details'], record['hint']]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .filter((value, index, values) => values.indexOf(value) === index);
    if (parts.length) return parts.join(' · ');

    if (typeof record['error'] === 'string' && record['error'].trim()) return record['error'];

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // El fallback de abajo también cubre objetos circulares.
    }
  }

  return fallback;
}
