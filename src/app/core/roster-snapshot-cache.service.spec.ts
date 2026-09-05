import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { RosterSnapshotCacheService } from './roster-snapshot-cache.service';
import { SupabaseService } from './supabase.service';

/** Fake Postgrest query builder — cada método de cadena devuelve `this` y el objeto es "thenable" en
 * cualquier punto (igual que el SDK real), así que sirve para las formas de cadena distintas que usa
 * fingerprint() (…maybeSingle() vs. select() a secas para wowaudit_roster) sin tener que replicarlas todas. */
class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  constructor(private readonly result: unknown) {}
  select(): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }
  eq(): this { return this; }
  maybeSingle(): this { return this; }
  then<T1, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve({ data: this.result, error: null }).then(onfulfilled, onrejected);
  }
}

function buildService(pointer: { published_generation_id: string | null; updated_at: string } | null): RosterSnapshotCacheService {
  const byTable: Record<string, unknown> = {
    pulls: { id: 'pull-1', closed_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z' },
    reports: { code: 'REPORT', start_time: 1, last_processed_fight_id: 1 },
    wowaudit_roster: [],
    player_pull_defensive_evaluations: null,
    player_execution_events: null,
    defensive_generation_pointer: pointer,
  };
  const fakeClient = { from: (table: string) => new FakeQuery(byTable[table] ?? null) };
  // §Sin TestBed a propósito: no hace falta zone.js/plataforma para una clase con un único
  // `inject()` — Injector.create + runInInjectionContext es la forma mínima documentada de Angular
  // para instanciar un servicio inyectable en un test sin el harness completo.
  const injector = Injector.create({ providers: [{ provide: SupabaseService, useValue: { client: fakeClient } }] });
  return runInInjectionContext(injector, () => new RosterSnapshotCacheService());
}

describe('RosterSnapshotCacheService.fingerprint · generation pointer (§51/§70 del cutover)', () => {
  it('cambia cuando cambia published_generation_id, con todo lo demás idéntico', async () => {
    const a = await buildService({ published_generation_id: 'generation-A', updated_at: '2026-09-05T00:00:00Z' }).fingerprint();
    const b = await buildService({ published_generation_id: 'generation-B', updated_at: '2026-09-05T00:00:00Z' }).fingerprint();

    expect(a).not.toBe(b);
  });

  it('es estable cuando nada cambia, incluido el pointer', async () => {
    const pointer = { published_generation_id: 'generation-A', updated_at: '2026-09-05T00:00:00Z' };
    const a = await buildService(pointer).fingerprint();
    const b = await buildService({ ...pointer }).fingerprint();

    expect(a).toBe(b);
  });

  it('sin generación publicada (pointer null) sigue produciendo un fingerprint distinto al de una publicada', async () => {
    const withPointer = await buildService({ published_generation_id: 'generation-A', updated_at: '2026-09-05T00:00:00Z' }).fingerprint();
    const withoutPointer = await buildService({ published_generation_id: null, updated_at: '2026-09-05T00:00:00Z' }).fingerprint();

    expect(withPointer).not.toBe(withoutPointer);
  });
});
