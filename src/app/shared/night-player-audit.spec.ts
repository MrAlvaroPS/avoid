import { NIGHT_PLAYER_CLAIM_REGISTRY, nightPlayerClaimOwner, type NightPlayerClaimId } from './night-player-claim-registry';
import { pullEvidenceKey, pullEvidenceLabel, pullWclLabel } from './pull-evidence.util';
import type { AuditClaim, PullEvidenceRef } from './models/night-player-audit';

describe('night player audit contracts', () => {
  const pull: PullEvidenceRef = {
    reportCode: '7GbANtw1J2pjZzH9',
    pullId: 'pull-uuid',
    fightId: 34,
    bossId: '3129',
    bossName: "Nek'zali",
    difficulty: 'Mythic',
    bossPullNumber: 4,
    timeMs: 151_400,
  };

  it('usa siempre Boss · Pull #N como identidad humana del intento', () => {
    expect(pullEvidenceLabel(pull)).toBe("Nek'zali · Pull #4");
    expect(pullWclLabel(pull)).toBe("Nek'zali · Pull #4 · WCL");
    expect(pullEvidenceLabel(pull)).not.toContain(String(pull.fightId));
  });

  it('usa reportCode+pullId como identidad estable y no fightId', () => {
    expect(pullEvidenceKey(pull)).toBe('7GbANtw1J2pjZzH9:pull-uuid');
    expect(pullEvidenceKey({ ...pull, fightId: 999 })).toBe('7GbANtw1J2pjZzH9:pull-uuid');
  });

  it('rechaza ordinales boss-local inválidos en vez de fabricar una etiqueta', () => {
    expect(() => pullEvidenceLabel({ bossName: "Nek'zali", bossPullNumber: 0 })).toThrow(RangeError);
    expect(() => pullEvidenceLabel({ bossName: "Nek'zali", bossPullNumber: 1.5 })).toThrow(RangeError);
  });

  it('mantiene owner explícito para todos los claims iniciales del plan', () => {
    const ids = Object.keys(NIGHT_PLAYER_CLAIM_REGISTRY) as NightPlayerClaimId[];
    expect(ids).toContain('defensive.usage');
    expect(ids).toContain('defensive.response');
    expect(ids).toContain('defensive.management');
    expect(ids).toContain('wcl.parse');
    expect(ids).toContain('gear.build');
    for (const id of ids) {
      expect(nightPlayerClaimOwner(id).owner.length).toBeGreaterThan(0);
    }
  });

  it('no confunde ownership con estado de canonicalidad del claim', () => {
    const claim: AuditClaim<number> = {
      id: 'execution.night',
      label: 'Ejecución de la noche',
      value: null,
      status: 'incompatible',
      scope: {
        reportCode: pull.reportCode,
        playerName: 'Magzil',
        pullIds: [pull.pullId],
      },
      definition: 'Proyección del owner compartido; esta capa no recalcula el score.',
      evidence: [],
      integrityIssues: ['La definición actual conserva una dependencia defensiva legacy.'],
    };

    expect(nightPlayerClaimOwner('execution.night').owner).toBe('night-player-summary.execution');
    expect(claim.status).toBe('incompatible');
    expect(claim.value).toBeNull();
  });
});
