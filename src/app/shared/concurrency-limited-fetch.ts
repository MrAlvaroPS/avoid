export interface ConcurrencyLimitedFetchOptions {
  maxConcurrent: number;
  shouldLimit: (url: string) => boolean;
}

interface Waiter {
  resolve: () => void;
  reject: (reason?: unknown) => void;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null {
  if (init?.signal) return init.signal;
  return typeof Request !== 'undefined' && input instanceof Request ? input.signal : null;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Wraps fetch with a small FIFO semaphore for the requests selected by
 * shouldLimit. Requests outside that predicate bypass the queue completely.
 *
 * This lives below the Supabase query builders on purpose: every `.from(...)`
 * call keeps its exact semantics, while a single page can no longer open an
 * unbounded burst of PostgREST connections. Queued aborts are removed before
 * they consume a slot.
 */
export function createConcurrencyLimitedFetch(
  fetchImpl: typeof fetch,
  options: ConcurrencyLimitedFetchOptions,
): typeof fetch {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  const queue: Waiter[] = [];
  let active = 0;

  const removeAbortListener = (waiter: Waiter): void => {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.onAbort = null;
    }
  };

  const drain = (): void => {
    while (active < maxConcurrent && queue.length) {
      const waiter = queue.shift()!;
      removeAbortListener(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      active++;
      waiter.resolve();
    }
  };

  const acquire = (signal: AbortSignal | null): Promise<void> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          removeAbortListener(waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      queue.push(waiter);
    });
  };

  const release = (): void => {
    active = Math.max(0, active - 1);
    drain();
  };

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!options.shouldLimit(requestUrl(input))) return fetchImpl(input, init);

    const signal = requestSignal(input, init);
    await acquire(signal);
    try {
      return await fetchImpl(input, init);
    } finally {
      release();
    }
  }) as typeof fetch;
}
