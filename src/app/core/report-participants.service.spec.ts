import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ReportParticipantsService } from './report-participants.service';
import { ReportsService, type NightPlayerListItem } from './reports.service';
import { WowauditRosterService, type WowauditRosterEntry } from './wowaudit-roster.service';

function rosterEntry(overrides: Partial<WowauditRosterEntry> = {}): WowauditRosterEntry {
  return {
    characterId: 1,
    name: 'Dewerland',
    realm: 'Sanguino',
    class: 'Warlock',
    role: 'Ranged',
    rank: 'Main',
    attendedAmountOfRaids: 10,
    totalAmountOfRaids: 10,
    attendedPercentage: 100,
    roleOverriddenFromObservedSpec: false,
    avatarUrl: 'https://example.test/avatar.png',
    ...overrides,
  };
}

function buildService(
  observed: NightPlayerListItem[],
  roster: WowauditRosterEntry[],
): ReportParticipantsService {
  const injector = Injector.create({
    providers: [
      {
        provide: ReportsService,
        useValue: { listNightPlayers: vi.fn().mockResolvedValue(observed) },
      },
      {
        provide: WowauditRosterService,
        useValue: { listRoster: vi.fn().mockResolvedValue(roster) },
      },
    ],
  });
  return runInInjectionContext(injector, () => new ReportParticipantsService());
}

describe('ReportParticipantsService · fusión con wowaudit_roster (PR1)', () => {
  it('el rol/clase observados esta noche pasan sin tocar cuando ya están resueltos, aunque wowaudit diga otra cosa', async () => {
    const service = buildService(
      [{ name: 'Dewerland', className: 'Warlock', spec: 'Destruction', role: 'Ranged' }],
      [rosterEntry({ name: 'Dewerland', role: 'Melee' })], // wowaudit desactualizado a propósito para este test
    );

    const [participant] = await service.list('REPORT');

    expect(participant).toMatchObject({
      name: 'Dewerland',
      className: 'Warlock',
      spec: 'Destruction',
      role: 'Ranged',
    });
  });

  it('cuando la noche no resuelve rol/clase, hace fallback a wowaudit_roster', async () => {
    const service = buildService(
      [{ name: 'PlayerX', className: null, spec: null, role: null }],
      [rosterEntry({ name: 'PlayerX', class: 'Paladin', role: 'Tank' })],
    );

    const [participant] = await service.list('REPORT');

    expect(participant).toMatchObject({ name: 'PlayerX', className: 'Paladin', role: 'Tank' });
  });

  it('sin resolución de ninguna fuente, role/className quedan null — nunca se inventan', async () => {
    const service = buildService(
      [{ name: 'PlayerY', className: null, spec: null, role: null }],
      [],
    );

    const [participant] = await service.list('REPORT');

    expect(participant).toMatchObject({
      name: 'PlayerY',
      className: null,
      role: null,
      rank: null,
      avatarUrl: null,
    });
  });

  it('rank/avatar siempre vienen del roster cuando existe entrada, sin importar de dónde salió el rol', async () => {
    const service = buildService(
      [{ name: 'Gusmï', className: 'Warlock', spec: 'Affliction', role: 'Ranged' }],
      [rosterEntry({ name: 'Gusmï', rank: 'Trial', avatarUrl: 'https://example.test/gusmi.png' })],
    );

    const [participant] = await service.list('REPORT');

    expect(participant.rank).toBe('Trial');
    expect(participant.avatarUrl).toBe('https://example.test/gusmi.png');
  });
});
