import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { ReportsService } from './reports.service';
import { SupabaseService } from './supabase.service';

/** Mismo patrón que roster-snapshot-cache.service.spec.ts: un stub thenable
 * de la query de Postgrest, sin necesidad de TestBed. Aquí `listNightPlayers`
 * hace dos consultas (pulls, luego player_pull_records) — el stub devuelve
 * la tabla que le pidan según `from(table)`. */
class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  constructor(private readonly result: unknown) {}
  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  order(): this {
    return this;
  }
  in(): this {
    return this;
  }
  then<T1, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve({ data: this.result, error: null }).then(onfulfilled, onrejected);
  }
}

function buildService(byTable: Record<string, unknown>): ReportsService {
  const fakeClient = { from: (table: string) => new FakeQuery(byTable[table] ?? null) };
  const injector = Injector.create({
    providers: [{ provide: SupabaseService, useValue: { client: fakeClient } }],
  });
  return runInInjectionContext(injector, () => new ReportsService());
}

describe('ReportsService.listNightPlayers · resolución report-scoped (PR1)', () => {
  it('sin pulls en el report devuelve una lista vacía sin consultar player_pull_records', async () => {
    const service = buildService({ pulls: [] });

    const result = await service.listNightPlayers('REPORT');

    expect(result).toEqual([]);
  });

  it('agrupa por jugador independientemente y ordena el resultado por nombre', async () => {
    const service = buildService({
      pulls: [
        { id: 'pull-1', fight_id: 1 },
        { id: 'pull-2', fight_id: 2 },
      ],
      player_pull_records: [
        { player_name: 'Zeta', class: 'Mage', spec: 'Frost', pull_id: 'pull-1' },
        { player_name: 'Zeta', class: 'Mage', spec: 'Frost', pull_id: 'pull-2' },
        { player_name: 'Alfa', class: 'Priest', spec: 'Holy', pull_id: 'pull-1' },
      ],
    });

    const result = await service.listNightPlayers('REPORT');

    expect(result.map((p) => p.name)).toEqual(['Alfa', 'Zeta']);
    expect(result.find((p) => p.name === 'Zeta')).toMatchObject({
      className: 'Mage',
      spec: 'Frost',
      role: 'Ranged',
    });
    expect(result.find((p) => p.name === 'Alfa')).toMatchObject({
      className: 'Priest',
      spec: 'Holy',
      role: 'Heal',
    });
  });

  it('usa el orden real de fight_id (no el de llegada de player_pull_records) para desempatar por "más reciente"', async () => {
    // pull-2 tiene fight_id menor (2) pero pull-3 (fight_id 3) es el más reciente de verdad,
    // aunque la fila de player_pull_records para pull-3 llegue ANTES en el array.
    const service = buildService({
      pulls: [
        { id: 'pull-2', fight_id: 2 },
        { id: 'pull-3', fight_id: 3 },
      ],
      player_pull_records: [
        { player_name: 'Mechavalec', class: 'Warrior', spec: 'Arms', pull_id: 'pull-3' },
        { player_name: 'Mechavalec', class: 'Warrior', spec: 'Protection', pull_id: 'pull-2' },
      ],
    });

    const result = await service.listNightPlayers('REPORT');

    expect(result).toEqual([
      { name: 'Mechavalec', className: 'Warrior', spec: 'Arms', role: 'Melee' },
    ]);
  });
});
