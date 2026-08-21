// Colocar en: src/app/shared/models/domain.ts
// Subconjunto del contrato técnico completo (sección 9 de la hoja de ruta)
// que hace falta para la Fase 1. El resto de interfaces (MechanicInstance,
// PullDeath, PullDiff, PullPlayerStats, LlmPullAnalysis...) se añaden cuando
// lleguen las fases que las usan.

export interface Encounter {
  id: string;
  wclEncounterId: number;
  name: string;
  raidZone: string;
}

export interface RaidNight {
  id: string;
  teamId: string;
  date: string;
  wclReportCode: string | null;
  status: 'live' | 'closed';
}

export interface Pull {
  id: string;
  raidNightId: string;
  encounterId: string;
  pullNumber: number;
  difficulty: 'normal' | 'heroic' | 'mythic' | null;
  isKill: boolean;
  pullDurationMs: number | null;
  bossHpPctFinal: number | null;
  startedAt: string;
  endedAt: string | null;
  analysisState: 'pending' | 'computing' | 'ready' | 'stale';
  encounter?: Encounter; // presente cuando se hace el join en la query
}
