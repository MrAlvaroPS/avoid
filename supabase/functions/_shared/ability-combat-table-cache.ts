// §Paso C-1 — cache cross-pull de observaciones POSITIVAS del combat table
// (dodge/parry/block) por ability. Decisión explícita del usuario
// (2026-09-04): "sí al cache persistente cross-pull, porque dodge/parry/
// block son facts de comportamiento reutilizables y perder evidencia
// positiva en cada pull degradaría artificialmente coverage. Pero hazlo
// como cache/corpus de observaciones versionado al menos por
// ability_game_id + game_build, con provenance y contadores, no como tres
// booleanos eternos sin contexto." — y: "La tabla/cache es evidencia
// acumulada para DamageDescriptor; no debe convertirse en otra fuente de
// scoring independiente. canDefensiveCover() sigue siendo la única puerta
// de applicability."
//
// Por eso esta tabla NUNCA se lee directamente por un evaluator de
// veredictos — solo alimenta `combatTableObservations` en
// damage-descriptor-wcl.ts, que a su vez solo puede producir `true`/`null`
// (nunca `false`) para dodgeable/parryable/blockable.

import type { AbilityCombatTableCounts } from './damage-descriptor-wcl.ts';

export interface AbilityCombatTableCacheRow {
  abilityGameId: number;
  gameBuild: string;
  dodgeCount: number;
  parryCount: number;
  blockCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  firstObservedPullId: string | null;
  lastObservedPullId: string | null;
  firstObservedBossId: string | null;
  lastObservedBossId: string | null;
}

export interface AbilityCombatTableCacheDbRecord {
  ability_game_id: number;
  game_build: string;
  dodge_count: number;
  parry_count: number;
  block_count: number;
  first_observed_at: string;
  last_observed_at: string;
  first_observed_pull_id: string | null;
  last_observed_pull_id: string | null;
  first_observed_boss_id: string | null;
  last_observed_boss_id: string | null;
}

export function cacheRowToDbRecord(row: AbilityCombatTableCacheRow): AbilityCombatTableCacheDbRecord {
  return {
    ability_game_id: row.abilityGameId,
    game_build: row.gameBuild,
    dodge_count: row.dodgeCount,
    parry_count: row.parryCount,
    block_count: row.blockCount,
    first_observed_at: row.firstObservedAt,
    last_observed_at: row.lastObservedAt,
    first_observed_pull_id: row.firstObservedPullId,
    last_observed_pull_id: row.lastObservedPullId,
    first_observed_boss_id: row.firstObservedBossId,
    last_observed_boss_id: row.lastObservedBossId,
  };
}

export function dbRecordToCacheRow(record: AbilityCombatTableCacheDbRecord): AbilityCombatTableCacheRow {
  return {
    abilityGameId: record.ability_game_id,
    gameBuild: record.game_build,
    dodgeCount: record.dodge_count,
    parryCount: record.parry_count,
    blockCount: record.block_count,
    firstObservedAt: record.first_observed_at,
    lastObservedAt: record.last_observed_at,
    firstObservedPullId: record.first_observed_pull_id,
    lastObservedPullId: record.last_observed_pull_id,
    firstObservedBossId: record.first_observed_boss_id,
    lastObservedBossId: record.last_observed_boss_id,
  };
}

export interface MergeObservationParams {
  abilityGameId: number;
  gameBuild: string;
  counts: AbilityCombatTableCounts;
  pullId: string | null;
  bossId: string | null;
  observedAt: string;
}

/**
 * Fusiona una observación de UN pull dentro de la fila de cache existente
 * (o crea una nueva) — puramente aditivo, nunca resta ni sobrescribe
 * provenance ya registrada salvo "last_observed_*" (que avanza con el
 * tiempo). No hace I/O: el UPSERT real lo hace el caller (edge function),
 * esto solo calcula el valor final de la fila.
 */
export function mergeObservationIntoCacheRow(
  existing: AbilityCombatTableCacheRow | null,
  params: MergeObservationParams,
): AbilityCombatTableCacheRow {
  if (!existing) {
    return {
      abilityGameId: params.abilityGameId,
      gameBuild: params.gameBuild,
      dodgeCount: params.counts.dodgeCount,
      parryCount: params.counts.parryCount,
      blockCount: params.counts.blockCount,
      firstObservedAt: params.observedAt,
      lastObservedAt: params.observedAt,
      firstObservedPullId: params.pullId,
      lastObservedPullId: params.pullId,
      firstObservedBossId: params.bossId,
      lastObservedBossId: params.bossId,
    };
  }
  return {
    ...existing,
    dodgeCount: existing.dodgeCount + params.counts.dodgeCount,
    parryCount: existing.parryCount + params.counts.parryCount,
    blockCount: existing.blockCount + params.counts.blockCount,
    lastObservedAt: params.observedAt,
    lastObservedPullId: params.pullId ?? existing.lastObservedPullId,
    lastObservedBossId: params.bossId ?? existing.lastObservedBossId,
  };
}
