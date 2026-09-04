import { describe, expect, it } from 'vitest';
import {
  cacheRowToDbRecord,
  dbRecordToCacheRow,
  mergeObservationIntoCacheRow,
  type AbilityCombatTableCacheRow,
} from '../../../supabase/functions/_shared/ability-combat-table-cache';

describe('mergeObservationIntoCacheRow', () => {
  it('crea una fila nueva con provenance cuando no existía (primer/último = el mismo pull)', () => {
    const row = mergeObservationIntoCacheRow(null, {
      abilityGameId: 1,
      gameBuild: '11.2.0.60000',
      counts: { dodgeCount: 1, parryCount: 0, blockCount: 0 },
      pullId: 'pull-1',
      bossId: '3470',
      observedAt: '2026-09-04T00:00:00.000Z',
    });
    expect(row).toEqual({
      abilityGameId: 1,
      gameBuild: '11.2.0.60000',
      dodgeCount: 1,
      parryCount: 0,
      blockCount: 0,
      firstObservedAt: '2026-09-04T00:00:00.000Z',
      lastObservedAt: '2026-09-04T00:00:00.000Z',
      firstObservedPullId: 'pull-1',
      lastObservedPullId: 'pull-1',
      firstObservedBossId: '3470',
      lastObservedBossId: '3470',
    });
  });

  it('acumula contadores de forma aditiva sobre una fila existente, nunca resta', () => {
    const existing: AbilityCombatTableCacheRow = {
      abilityGameId: 1,
      gameBuild: '11.2.0.60000',
      dodgeCount: 2,
      parryCount: 1,
      blockCount: 0,
      firstObservedAt: '2026-09-01T00:00:00.000Z',
      lastObservedAt: '2026-09-01T00:00:00.000Z',
      firstObservedPullId: 'pull-old',
      lastObservedPullId: 'pull-old',
      firstObservedBossId: '3470',
      lastObservedBossId: '3470',
    };
    const merged = mergeObservationIntoCacheRow(existing, {
      abilityGameId: 1,
      gameBuild: '11.2.0.60000',
      counts: { dodgeCount: 1, parryCount: 0, blockCount: 3 },
      pullId: 'pull-new',
      bossId: '3492',
      observedAt: '2026-09-04T00:00:00.000Z',
    });
    expect(merged.dodgeCount).toBe(3);
    expect(merged.parryCount).toBe(1);
    expect(merged.blockCount).toBe(3);
    // provenance del PRIMER avistamiento se conserva; solo "last" avanza.
    expect(merged.firstObservedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(merged.firstObservedPullId).toBe('pull-old');
    expect(merged.firstObservedBossId).toBe('3470');
    expect(merged.lastObservedAt).toBe('2026-09-04T00:00:00.000Z');
    expect(merged.lastObservedPullId).toBe('pull-new');
    expect(merged.lastObservedBossId).toBe('3492');
  });
});

describe('cacheRowToDbRecord / dbRecordToCacheRow — round-trip sin pérdida', () => {
  it('conversión snake_case exacta y reversible', () => {
    const row: AbilityCombatTableCacheRow = {
      abilityGameId: 42,
      gameBuild: '11.2.0.60000',
      dodgeCount: 5,
      parryCount: 2,
      blockCount: 1,
      firstObservedAt: '2026-09-01T00:00:00.000Z',
      lastObservedAt: '2026-09-04T00:00:00.000Z',
      firstObservedPullId: 'pull-a',
      lastObservedPullId: 'pull-b',
      firstObservedBossId: '3470',
      lastObservedBossId: '3492',
    };
    const record = cacheRowToDbRecord(row);
    expect(record).toEqual({
      ability_game_id: 42,
      game_build: '11.2.0.60000',
      dodge_count: 5,
      parry_count: 2,
      block_count: 1,
      first_observed_at: '2026-09-01T00:00:00.000Z',
      last_observed_at: '2026-09-04T00:00:00.000Z',
      first_observed_pull_id: 'pull-a',
      last_observed_pull_id: 'pull-b',
      first_observed_boss_id: '3470',
      last_observed_boss_id: '3492',
    });
    expect(dbRecordToCacheRow(record)).toEqual(row);
  });
});
