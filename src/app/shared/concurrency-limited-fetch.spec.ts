import { describe, expect, it } from 'vitest';
import { createConcurrencyLimitedFetch } from './concurrency-limited-fetch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createConcurrencyLimitedFetch', () => {
  it('caps matching requests while preserving their FIFO start order', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<Response>());
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;

    const rawFetch = (async (input: RequestInfo | URL) => {
      const index = Number(new URL(typeof input === 'string' ? input : input.toString()).searchParams.get('i'));
      started.push(index);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await gates[index].promise;
      } finally {
        active--;
      }
    }) as typeof fetch;

    const limitedFetch = createConcurrencyLimitedFetch(rawFetch, {
      maxConcurrent: 2,
      shouldLimit: (url) => url.includes('/rest/v1/'),
    });

    const requests = Array.from({ length: 5 }, (_, i) =>
      limitedFetch(`https://example.supabase.co/rest/v1/pulls?i=${i}`),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(maxActive).toBe(2);

    gates[0].resolve(new Response(null, { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve(new Response(null, { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2].resolve(new Response(null, { status: 200 }));
    gates[3].resolve(new Response(null, { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    gates[4].resolve(new Response(null, { status: 200 }));
    await Promise.all(requests);
    expect(maxActive).toBe(2);
  });

  it('does not queue requests outside the selected REST path', async () => {
    const gate = deferred<Response>();
    const started: string[] = [];
    const rawFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      started.push(url);
      if (url.includes('/rest/v1/')) return gate.promise;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const limitedFetch = createConcurrencyLimitedFetch(rawFetch, {
      maxConcurrent: 1,
      shouldLimit: (url) => url.includes('/rest/v1/'),
    });

    const rest = limitedFetch('https://example.supabase.co/rest/v1/pulls');
    // acquire() resolves asynchronously even when a slot is immediately
    // available; let the matching request enter rawFetch before exercising
    // the bypass path so the assertion checks only the intended behaviour.
    await Promise.resolve();
    const functions = limitedFetch('https://example.supabase.co/functions/v1/analyze-report');

    await functions;
    expect(started).toEqual([
      'https://example.supabase.co/rest/v1/pulls',
      'https://example.supabase.co/functions/v1/analyze-report',
    ]);

    gate.resolve(new Response(null, { status: 200 }));
    await rest;
  });

  it('removes an aborted queued request without consuming a slot', async () => {
    const firstGate = deferred<Response>();
    const started: string[] = [];
    const rawFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      started.push(url);
      if (url.endsWith('/first')) return firstGate.promise;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const limitedFetch = createConcurrencyLimitedFetch(rawFetch, {
      maxConcurrent: 1,
      shouldLimit: () => true,
    });

    const first = limitedFetch('https://example.test/first');
    const controller = new AbortController();
    const aborted = limitedFetch('https://example.test/aborted', { signal: controller.signal });
    const third = limitedFetch('https://example.test/third');

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toEqual(['https://example.test/first']);

    firstGate.resolve(new Response(null, { status: 200 }));
    await first;
    await third;
    expect(started).toEqual(['https://example.test/first', 'https://example.test/third']);
  });
});
