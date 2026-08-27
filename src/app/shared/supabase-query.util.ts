import { isMissingSupabaseRelation } from './error-message.util';

interface SupabaseResultLike {
  error: unknown;
}

/**
 * Permite desplegar frontend y migraciones en momentos distintos sin dejar
 * pantallas vacías. Sólo reintenta si PostgREST confirma que falta la relación
 * preferida; cualquier otro error se conserva para que el caller lo gestione.
 */
export async function withSupabaseRelationFallback<T extends SupabaseResultLike>(
  relation: string,
  preferredQuery: () => PromiseLike<T>,
  fallbackQuery: () => PromiseLike<T>,
): Promise<T> {
  const preferred = await preferredQuery();
  return isMissingSupabaseRelation(preferred.error, relation) ? await fallbackQuery() : preferred;
}
