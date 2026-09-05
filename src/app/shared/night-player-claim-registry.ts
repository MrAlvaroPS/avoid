import type { AuditSourceKind } from './models/night-player-audit';

export type NightPlayerClaimId =
  | 'execution.night'
  | 'defensive.usage'
  | 'defensive.response'
  | 'defensive.management'
  | 'mechanics.actionableIncidents'
  | 'mechanics.avoidableSuccess'
  | 'deaths.total'
  | 'consumables.reactiveUse'
  | 'wcl.parse'
  | 'reliability.night'
  | 'reliability.60d'
  | 'progression.previousNight'
  | 'preparation.enchants'
  | 'preparation.gems'
  | 'gear.build';

export interface NightPlayerClaimOwner {
  owner: string;
  source: AuditSourceKind;
  note?: string;
}

/**
 * Registry de ownership, no registry de fórmulas. Su única responsabilidad es
 * hacer explícito qué read-model/fact es dueño de cada claim y evitar que el
 * nuevo dosier cree una segunda implementación local.
 *
 * Que un owner sea legacy/transitorio NO convierte el claim en canónico: el
 * status real viaja en AuditClaim y debe ser honesto sobre partial,
 * incompatible o not_evaluable.
 */
export const NIGHT_PLAYER_CLAIM_REGISTRY = {
  'execution.night': {
    owner: 'night-player-summary.execution',
    source: 'iris_derived',
    note: 'Owner actual; Fase 6 debe retirar la dependencia defensiva legacy antes del estado autoritario final.',
  },
  'defensive.usage': {
    owner: 'canonical-defensive-summary',
    source: 'iris_canonical',
  },
  'defensive.response': {
    owner: 'canonical-defensive-summary',
    source: 'iris_canonical',
  },
  'defensive.management': {
    owner: 'canonical-defensive-summary',
    source: 'iris_canonical',
    note: 'Sin plan publicado el valor correcto es N/D; nunca 0 por ausencia de plan.',
  },
  'mechanics.actionableIncidents': {
    owner: 'night-player-summary.execution',
    source: 'iris_derived',
  },
  'mechanics.avoidableSuccess': {
    owner: 'night-player-summary.execution',
    source: 'iris_derived',
  },
  'deaths.total': {
    owner: 'night-player-summary.deaths',
    source: 'iris_derived',
  },
  'consumables.reactiveUse': {
    owner: 'player_pull_records.consumables',
    source: 'wcl',
  },
  'wcl.parse': {
    owner: 'player_pull_records.world_rank_percent',
    source: 'wcl',
  },
  'reliability.night': {
    owner: 'reliability-service.night',
    source: 'iris_derived',
  },
  'reliability.60d': {
    owner: 'reliability-service.60d',
    source: 'iris_derived',
    note: 'Fase 7 debe cortar el eje defensivo a canonical Response antes del estado autoritario final.',
  },
  'progression.previousNight': {
    owner: 'night-player-summary.evolution',
    source: 'iris_derived',
  },
  'preparation.enchants': {
    owner: 'player_pull_records.CombatantInfo',
    source: 'wcl',
  },
  'preparation.gems': {
    owner: 'player_pull_records.CombatantInfo',
    source: 'wcl',
  },
  'gear.build': {
    owner: 'player_pull_records.CombatantInfo',
    source: 'wcl',
  },
} as const satisfies Record<NightPlayerClaimId, NightPlayerClaimOwner>;

export function nightPlayerClaimOwner(id: NightPlayerClaimId): NightPlayerClaimOwner {
  return NIGHT_PLAYER_CLAIM_REGISTRY[id];
}
