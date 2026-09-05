import { describe, expect, it } from 'vitest';
import {
  buildNightPlayerPullLedger,
  type PullLedgerEncounterFact,
  type PullLedgerPlayerFact,
  type PullLedgerPullFact,
} from './night-player-pull-ledger.service';

function pull(
  overrides: Partial<PullLedgerPullFact> & Pick<PullLedgerPullFact, 'id' | 'fight_id' | 'boss_id' | 'pull_number'>,
): PullLedgerPullFact {
  return {
    report_code: 'REPORT1',
    difficulty: 'Mythic',
    wipe_pct: 50,
    duration_ms: 180_000,
    closed_at: '2026-09-05T20:00:00.000Z',
    ninja_pull_excluded: false,
    ...overrides,
  };
}

function record(
  id: string,
  pullId: string,
  overrides: Partial<PullLedgerPlayerFact> = {},
): PullLedgerPlayerFact {
  return {
    id,
    pull_id: pullId,
    player_name: 'Raider',
    world_rank_percent: 80,
    world_total_parses: 1234,
    ...overrides,
  };
}

const encounters: PullLedgerEncounterFact[] = [
  { fight_id: 1, boss_name: 'Boss Alpha' },
  { fight_id: 2, boss_name: 'Boss Alpha' },
  { fight_id: 3, boss_name: 'Boss Alpha' },
  { fight_id: 4, boss_name: 'Boss Alpha' },
  { fight_id: 5, boss_name: 'Boss Beta' },
];

describe('NightPlayerPullLedger', () => {
  it('solo proyecta pulls donde existe participación real del jugador', () => {
    const ledger = buildNightPlayerPullLedger({
      reportCode: 'REPORT1',
      playerName: 'Raider',
      pulls: [
        pull({ id: 'p1', fight_id: 1, boss_id: 'alpha', pull_number: 1 }),
        pull({ id: 'p2', fight_id: 2, boss_id: 'alpha', pull_number: 2 }),
        pull({ id: 'p3', fight_id: 3, boss_id: 'alpha', pull_number: 3 }),
      ],
      encounters,
      records: [record('r1', 'p1'), record('r3', 'p3')],
    });

    expect(ledger.rows.map((row) => row.pull.pullId)).toEqual(['p1', 'p3']);
    expect(ledger.rows.map((row) => row.label)).toEqual([
      'Boss Alpha · Pull #1',
      'Boss Alpha · Pull #3',
    ]);
  });

  it('numera por boss+dificultad sobre todos los intentos válidos, aunque el jugador estuviera bench en uno', () => {
    const ledger = buildNightPlayerPullLedger({
      reportCode: 'REPORT1',
      playerName: 'Raider',
      pulls: [
        pull({ id: 'p1', fight_id: 1, boss_id: 'alpha', pull_number: 1 }),
        pull({ id: 'p2', fight_id: 2, boss_id: 'alpha', pull_number: 2 }),
        pull({ id: 'p3', fight_id: 3, boss_id: 'alpha', pull_number: 3 }),
        pull({ id: 'b1', fight_id: 5, boss_id: 'beta', pull_number: 4 }),
      ],
      encounters,
      records: [record('r3', 'p3'), record('rb1', 'b1')],
    });

    expect(ledger.rows[0].pull.bossPullNumber).toBe(3);
    expect(ledger.rows[1].pull.bossPullNumber).toBe(1);
  });

  it('mantiene un ninja pull participado como exclusión contextual sin inventarle ordinal', () => {
    const ledger = buildNightPlayerPullLedger({
      reportCode: 'REPORT1',
      playerName: 'Raider',
      pulls: [
        pull({ id: 'p1', fight_id: 1, boss_id: 'alpha', pull_number: 1 }),
        pull({
          id: 'ninja',
          fight_id: 2,
          boss_id: 'alpha',
          pull_number: 2,
          ninja_pull_excluded: true,
        }),
        pull({ id: 'p2', fight_id: 3, boss_id: 'alpha', pull_number: 3 }),
      ],
      encounters,
      records: [record('r1', 'p1'), record('rn', 'ninja'), record('r2', 'p2')],
    });

    expect(ledger.rows.map((row) => row.pull.bossPullNumber)).toEqual([1, 2]);
    expect(ledger.excludedParticipatedPulls).toMatchObject([
      {
        pullId: 'ninja',
        fightId: 2,
        reason: 'ninja_pull',
      },
    ]);
  });

  it('trata parse ausente como N/D y nunca como cero', () => {
    const ledger = buildNightPlayerPullLedger({
      reportCode: 'REPORT1',
      playerName: 'Raider',
      pulls: [pull({ id: 'p1', fight_id: 1, boss_id: 'alpha', pull_number: 1 })],
      encounters,
      records: [record('r1', 'p1', { world_rank_percent: null, world_total_parses: null })],
    });

    expect(ledger.rows[0].parse.value).toBeNull();
    expect(ledger.rows[0].parse.status).toBe('not_evaluable');
    expect(ledger.rows[0].integrity).toBe('partial');
  });

  it('usa deep-link exacto al fight y evidencia reconstruible por fila', () => {
    const ledger = buildNightPlayerPullLedger({
      reportCode: 'REPORT1',
      playerName: 'Raider',
      pulls: [
        pull({
          id: 'p1',
          fight_id: 4,
          boss_id: 'alpha',
          pull_number: 1,
          wipe_pct: 0,
          duration_ms: 92_000,
        }),
      ],
      encounters,
      records: [record('r1', 'p1')],
    });

    const row = ledger.rows[0];
    expect(row.wclUrl).toBe('https://www.warcraftlogs.com/reports/REPORT1#fight=4');
    expect(row.result.value).toBe('kill');
    expect(row.duration.value).toBe(92_000);
    expect(row.participation.evidence[0]).toMatchObject({
      kind: 'player_pull_record',
      field: 'player_name',
    });
    expect(row.parse.evidence.map((evidence) => evidence.kind)).toEqual([
      'wcl_pull',
      'player_pull_record',
    ]);
  });
});
