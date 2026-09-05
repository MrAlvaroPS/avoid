export type AuditClaimStatus =
  | 'canonical'
  | 'direct'
  | 'derived'
  | 'partial'
  | 'not_evaluable'
  | 'incompatible';

export type AuditSourceKind =
  | 'wcl'
  | 'iris_canonical'
  | 'iris_derived'
  | 'catalog'
  | 'ai_interpretation';

/**
 * Scope explícito de un claim del dosier. El contrato identifica el universo
 * observado; no decide por sí mismo qué filas son evaluables ni recalcula una
 * métrica.
 */
export interface AuditScope {
  reportCode: string;
  playerName: string;
  pullIds?: readonly string[];
  bossIds?: readonly string[];
  difficulty?: string | null;
  windowStartIso?: string | null;
  windowEndIso?: string | null;
}

export interface AuditCoverage {
  expected: number;
  observed: number;
}

/**
 * Identidad humana/técnica común para cualquier evidencia asociada a un pull.
 * bossPullNumber es SIEMPRE el ordinal dentro de boss+difficulty; fightId solo
 * existe para localizar el fight exacto en WCL.
 */
export interface PullEvidenceRef {
  reportCode: string;
  pullId: string;
  fightId: number;
  bossId: string;
  bossName: string;
  difficulty: string;
  bossPullNumber: number;
  timeMs?: number | null;
}

interface EvidenceBase {
  id: string;
  source: AuditSourceKind;
  locator: string;
  sourceVersion?: string | null;
  observedAt?: string | null;
}

export interface WclPullEvidence extends EvidenceBase {
  kind: 'wcl_pull';
  source: 'wcl';
  pull: PullEvidenceRef;
}

export interface WclEventEvidence extends EvidenceBase {
  kind: 'wcl_event';
  source: 'wcl';
  pull: PullEvidenceRef;
  eventType: string;
  abilityGameId?: number | null;
}

export interface PlayerPullRecordEvidence extends EvidenceBase {
  kind: 'player_pull_record';
  pull: PullEvidenceRef;
  field: string;
}

export interface DefensiveEpisodeEvidence extends EvidenceBase {
  kind: 'defensive_episode';
  source: 'iris_canonical';
  pull: PullEvidenceRef;
  episodeId: string;
  defensiveGenerationId: string;
}

export interface ExecutionLedgerEvidence extends EvidenceBase {
  kind: 'execution_ledger';
  source: 'iris_canonical';
  pull: PullEvidenceRef;
  eventId: string;
}

export interface MechanicEventEvidence extends EvidenceBase {
  kind: 'mechanic_event';
  pull: PullEvidenceRef;
  mechanicKey: string;
  occurrenceIndex?: number | null;
}

export interface ReliabilityEvidence extends EvidenceBase {
  kind: 'reliability';
  source: 'iris_derived';
  contributingPullIds: readonly string[];
}

export interface CatalogEvidence extends EvidenceBase {
  kind: 'catalog';
  source: 'catalog';
  catalogKey: string;
}

export interface GearEvidence extends EvidenceBase {
  kind: 'gear';
  source: 'wcl';
  pull: PullEvidenceRef;
  buildFingerprint?: string | null;
}

export type EvidenceRef =
  | WclPullEvidence
  | WclEventEvidence
  | PlayerPullRecordEvidence
  | DefensiveEpisodeEvidence
  | ExecutionLedgerEvidence
  | MechanicEventEvidence
  | ReliabilityEvidence
  | CatalogEvidence
  | GearEvidence;

/**
 * Cada número relevante que IRIS expone para jugador×noche debe poder viajar
 * como un claim auditable. Este tipo NO contiene lógica de scoring: value,
 * numerador, denominador, fórmula y evidencia deben venir del owner canónico.
 */
export interface AuditClaim<T> {
  id: string;
  label: string;
  value: T | null;
  status: AuditClaimStatus;
  scope: AuditScope;
  definition: string;
  numerator?: number;
  denominator?: number;
  formula?: string;
  evidence: readonly EvidenceRef[];
  sourceVersion?: string | null;
  computedAt?: string | null;
  coverage?: AuditCoverage;
  integrityIssues: readonly string[];
}
