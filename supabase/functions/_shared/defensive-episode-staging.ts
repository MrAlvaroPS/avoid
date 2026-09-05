// §Paso C — iris-defensive-canonicalization-v1-plan.md §2.6: forma exacta
// (y conversión ↔ fila de Supabase) de
// `player_pull_defensive_episode_evaluations` — la tabla de staging
// versionada por generación. Puro: no importa Deno/Supabase, para que el
// round-trip staging→ledger sea testeable desde vitest sin mock de red.

import type { EvaluationConfidence } from './combat-evaluation-contract.ts';
import type { PersistedDefensiveEpisode } from './defensive-episode-persistence.ts';

export interface DefensiveEpisodeEvaluationRow {
  defensiveGenerationId: string;
  pullId: string;
  playerName: string;
  episodeEvaluatorVersion: string;
  semanticVersion: string;
  semanticResolverVersion: string;
  resolverVersion: string;
  buildFingerprint: string | null;
  /** Rollup de fila — el confidence más débil entre sus episodios (ver rollupDataConfidence). Cada episodio conserva el suyo propio en episodes[]. */
  dataConfidence: EvaluationConfidence;
  episodes: PersistedDefensiveEpisode[];
  evaluatedAt: string;
}

const CONFIDENCE_RANK: Record<EvaluationConfidence, number> = { verified: 0, inferred: 1, fallback: 2, uncertain: 3 };

/**
 * data_confidence de la fila = el confidence más débil entre sus episodios
 * — mismo criterio (`weakestConfidence`) que ya usa
 * `materialize-execution-ledger` para V2. Una fila sin episodios (pull sin
 * ninguna ventana de presión detectada para este jugador) no puede afirmar
 * más que 'uncertain': no hay evidencia de nada.
 */
export function rollupDataConfidence(
  episodes: readonly { confidence: EvaluationConfidence }[],
): EvaluationConfidence {
  if (!episodes.length) return 'uncertain';
  return episodes.reduce<EvaluationConfidence>(
    (weakest, episode) => (CONFIDENCE_RANK[episode.confidence] > CONFIDENCE_RANK[weakest] ? episode.confidence : weakest),
    'verified',
  );
}

export interface BuildDefensiveEpisodeEvaluationRowParams {
  defensiveGenerationId: string;
  pullId: string;
  playerName: string;
  episodeEvaluatorVersion: string;
  semanticVersion: string;
  semanticResolverVersion: string;
  resolverVersion: string;
  buildFingerprint?: string | null;
  episodes: PersistedDefensiveEpisode[];
  evaluatedAt?: string;
}

export function buildDefensiveEpisodeEvaluationRow(
  params: BuildDefensiveEpisodeEvaluationRowParams,
): DefensiveEpisodeEvaluationRow {
  return {
    defensiveGenerationId: params.defensiveGenerationId,
    pullId: params.pullId,
    playerName: params.playerName,
    episodeEvaluatorVersion: params.episodeEvaluatorVersion,
    semanticVersion: params.semanticVersion,
    semanticResolverVersion: params.semanticResolverVersion,
    resolverVersion: params.resolverVersion,
    buildFingerprint: params.buildFingerprint ?? null,
    dataConfidence: rollupDataConfidence(params.episodes),
    episodes: params.episodes,
    evaluatedAt: params.evaluatedAt ?? new Date().toISOString(),
  };
}

/** Forma snake_case exacta de la fila en Postgres (ver migración §2.6). */
export interface DefensiveEpisodeEvaluationDbRecord {
  defensive_generation_id: string;
  pull_id: string;
  player_name: string;
  episode_evaluator_version: string;
  semantic_version: string;
  semantic_resolver_version: string;
  resolver_version: string;
  build_fingerprint: string | null;
  data_confidence: EvaluationConfidence;
  episodes: PersistedDefensiveEpisode[];
  evaluated_at: string;
}

export function episodeEvaluationRowToDbRecord(
  row: DefensiveEpisodeEvaluationRow,
): DefensiveEpisodeEvaluationDbRecord {
  return {
    defensive_generation_id: row.defensiveGenerationId,
    pull_id: row.pullId,
    player_name: row.playerName,
    episode_evaluator_version: row.episodeEvaluatorVersion,
    semantic_version: row.semanticVersion,
    semantic_resolver_version: row.semanticResolverVersion,
    resolver_version: row.resolverVersion,
    build_fingerprint: row.buildFingerprint,
    data_confidence: row.dataConfidence,
    episodes: row.episodes,
    evaluated_at: row.evaluatedAt,
  };
}

/** Inversa exacta de episodeEvaluationRowToDbRecord — usada para el test de reconstrucción staging→ledger (leer lo que se acaba de escribir, sin pérdida). */
export function dbRecordToEpisodeEvaluationRow(
  record: DefensiveEpisodeEvaluationDbRecord,
): DefensiveEpisodeEvaluationRow {
  return {
    defensiveGenerationId: record.defensive_generation_id,
    pullId: record.pull_id,
    playerName: record.player_name,
    episodeEvaluatorVersion: record.episode_evaluator_version,
    semanticVersion: record.semantic_version,
    semanticResolverVersion: record.semantic_resolver_version,
    resolverVersion: record.resolver_version,
    buildFingerprint: record.build_fingerprint,
    dataConfidence: record.data_confidence,
    episodes: record.episodes,
    evaluatedAt: record.evaluated_at,
  };
}
