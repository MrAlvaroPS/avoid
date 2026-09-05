import type { AuditSourceKind } from './models/night-player-audit';

export type NightPlayerClaimId =
  | 'pull.population'
  | 'pull.identity'
  | 'pull.result'
  | 'pull.duration'
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
  'pull.population': {
    owner: 'pulls + player_pull_records',
    source: 'iris_derived',
    note: 'Participación = existe player_pull_records; los ninja pulls se preservan como exclusión contextual y no entran en el ledger evaluable.',
  },
  'pull.identity': {
    owner: 'pull-consistency.validAttemptOrdinal',
    source: 'iris_derived',
    note: 'Ordinal boss+dificultad 1..N sobre todos los intentos válidos del report, no numeración global ni numeración solo de los pulls jugados por el raider.',
  },
  'pull.result': {
    owner: 'pulls.wipe_pct',
    source: 'wcl',
    note: 'Si wipe_pct falta, el resultado es N/D; no se asume wipe por defecto.',
  },
  'pull.duration': {
    owner: 'pulls.duration_ms',
    source: 'wcl',
  },
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
    owner: 'player_mechanic_offenses_v3 + full_execution_backfill',
    source: 'iris_canonical',
    note: 'Solo es un total canónico cuando todos los pulls válidos participados tienen full_execution_backfill=done. La vista contiene únicamente fallos atribuibles mediante occurrence + responsibility graph.',
  },
  'mechanics.avoidableSuccess': {
    owner: 'mechanic_occurrence_evaluations + mechanic_responsibility_edges',
    source: 'iris_canonical',
    note: 'El contrato player-level de éxitos evitables todavía no publica un numerador/denominador homogéneo. Hasta entonces el claim correcto es N/D; nunca se deriva desde una vista de ofensas.',
  },
  'deaths.total': {
    owner: "player_execution_events(domain='death') + full_execution_backfill",
    source: 'iris_canonical',
    note: 'El total solo puede afirmarse tras backfill completo de todos los pulls válidos participados. reasonCode/confidence se muestran como clasificación del ledger y el dosier no reinterpreta la causa.',
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
