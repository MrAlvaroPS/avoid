/**
 * Convierte errores nativos y respuestas de Supabase/PostgREST en texto útil.
 * `PostgrestError` es un objeto plano, por lo que String(error) produciría
 * literalmente "[object Object]".
 */
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

/** Detecta una vista/tabla aún no presente en la caché de esquema de PostgREST. */
export function isMissingSupabaseRelation(error: unknown, relation: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as Record<string, unknown>)['code'];
  if (code !== 'PGRST205' && code !== '42P01') return false;
  return errorMessage(error).toLocaleLowerCase().includes(relation.toLocaleLowerCase());
}
