import { errorMessage } from './error-message.util';

interface FunctionResponseLike {
  status?: number;
  clone?: () => unknown;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function responseLike(value: unknown): value is FunctionResponseLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as FunctionResponseLike;
  return typeof candidate.json === 'function' || typeof candidate.text === 'function';
}

function detailFromBody(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    return errorMessage((body as { error?: unknown }).error, '').trim() || null;
  }
  if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
    const code = (body as { code: string }).code.trim();
    const message = errorMessage(body, '').trim();
    if (code && message) return `${code}: ${message}`;
  }
  const detail = errorMessage(body, '').trim();
  return detail || null;
}

/**
 * Supabase guarda el body real de un non-2xx en `FunctionsHttpError.context`.
 * No se usa `instanceof Response`: un Response creado en otro realm/bundle no
 * supera esa comprobación aunque implemente el contrato completo.
 */
export async function describeFunctionError(error: unknown, functionName?: string): Promise<Error> {
  const context = error && typeof error === 'object' ? (error as { context?: unknown }).context : null;
  let candidate: unknown = context;
  if (context && typeof context === 'object' && typeof (context as FunctionResponseLike).clone === 'function') {
    try {
      candidate = (context as FunctionResponseLike).clone!();
    } catch {
      candidate = context;
    }
  }

  if (responseLike(candidate)) {
    if (typeof candidate.json === 'function') {
      try {
        const detail = detailFromBody(await candidate.json());
        if (detail) return new Error(detail);
      } catch {
        // Puede ser una respuesta de infraestructura sin JSON.
      }
    }
    if (typeof candidate.text === 'function') {
      try {
        const detail = (await candidate.text()).trim();
        if (detail) return new Error(detail);
      } catch {
        // El body puede estar consumido; se conserva el fallback inferior.
      }
    }
  }

  const status = context && typeof context === 'object' && typeof (context as FunctionResponseLike).status === 'number'
    ? ` (HTTP ${(context as FunctionResponseLike).status})`
    : '';
  const prefix = functionName ? `${functionName}: ` : '';
  return new Error(`${prefix}${errorMessage(error)}${status}`);
}
