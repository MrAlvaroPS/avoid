import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { WowauditRosterService, type WowauditRosterEntry } from './wowaudit-roster.service';
import { AttendanceService, type RealAttendanceEntry } from './attendance.service';
import { mechanicScoreFor } from './pull-analysis.service';
import { gearPreparationDetails } from '../shared/gear-preparation.util';
import type { DeathCause, WclGearItem } from '../shared/models/domain';
import { DefensiveFeatureFlagsService } from './defensive-feature-flags.service';
import {
  ExecutionLedgerService,
  type ExecutionLedgerPullSummary,
} from './execution-ledger.service';
import { homogeneousDefensiveEvaluationGeneration } from '../shared/defensive-evaluation-generation';

const REQUIRED_DEFENSIVE_EVALUATOR_VERSION = 'defensive-execution-evaluator@2.4.0';
const REQUIRED_DEFENSIVE_RESOLVER_VERSION = 'effective-defensives@2.1.0';
const REQUIRED_EXECUTION_LEDGER_VERSION = 'execution-ledger@1.0.0';

const WINDOW_DAYS = 60;
const HALF_LIFE_DAYS = 10;
const AXIS_WEIGHTS = { mecanica: 0.4, defensiva: 0.3, preparacion: 0.2 } as const;
const DEFENSIVE_MISTIMED_CREDIT = 0.3;

export interface PlayerReliability {
  playerName: string;
  overall: number;
  breakdown: {
    mecanica: number | null;
    defensiva: number | null;
    preparacion: number | null;
  };
  consistency: PlayerConsistency | null;
  defensiveShadowComparison: DefensiveReliabilityShadowComparison | null;
  executionLedgerShadowComparison: ExecutionLedgerShadowComparison | null;
  latestGemCount: number | null;
  latestGemmedSlotCount: number | null;
  latestGemmableSlotCount: number | null;
  latestEnchantedSlotCount: number | null;
  latestEnchantableSlotCount: number | null;
  latestMissingEnchantSlots: string[];
  latestMissingGemSlots: string[];
  latestPreparationObservedAt: string | null;
  sampleSize: number;
  sampleNightCount: number;
  lastObservedAt: string | null;
  defensiveOpportunityCount: number;
  defensiveUseCount: number;
  defensiveDeathOpportunityCount: number;
  defensiveDeathUseCount: number;
  defensiveSpellUsage: DefensiveSpellUsage[];
  defensiveDeathEvidence: DefensiveDeathEvidence[];
  observedAxisCount: number;
  attendanceNightsAttended: number | null;
  attendanceNightsTotal: number | null;
  trend: 'up' | 'down' | 'flat' | null;
  role: 'Tank' | 'Heal' | 'Melee' | 'Ranged' | null;
  rank: 'Main' | 'Trial' | null;
}

export interface DefensiveSpellUsage {
  spellId: number;
  name: string;
  castCount: number;
  pullCount: number;
}

export interface DefensiveDeathEvidence {
  pullId: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  reportCode: string;
  fightId: number;
  pullNumber: number;
  closedAt: string;
  mechanicId: number | null;
  mechanicName: string;
  usedDefensive: boolean;
  availableUnused: { spellId: number; name: string }[];
  active: { spellId: number; name: string }[];
  onCooldown: { spellId: number; name: string; cooldownRemainingMs: number | null }[];
}

export interface ReliabilityInputRow {
  pull_id: string;
  boss_id: string;
  difficulty: string;
  player_name: string;
  closed_at: string;
  had_avoidable_damage: boolean;
  self_positioning_death: boolean;
  used_defensive_when_died: boolean | null;
  used_defensive_in_pull: boolean;
  defensive_use_opportunity: boolean;
  enchanted_slot_count: number;
  enchantable_slot_count: number;
  gem_count: number;
  gemmed_slot_count: number;
  gemmable_slot_count: number;
  personal_mechanic_fail_count: number | null;
  report_code: string | null;
  pull_number: number | null;
  avoidable_mechanic_eligible_count: number | null;
  avoidable_mechanic_fail_count: number | null;
  defensive_window_coverable_count: number | null;
  defensive_window_covered_count: number | null;
  defensive_window_used_anything: boolean | null;
  unassigned_mechanic_success_count: number | null;
  defensive_management_score_v2: number | null;
  defensive_management_decision_count: number | null;
  defensive_required_count: number | null;
  defensive_required_success_count: number | null;
  defensive_required_exact_adherence_count: number | null;
  defensive_broken_reservation_count: number | null;
  defensive_death_viable_cd_count: number | null;
  defensive_evaluation_confidence: string | null;
  defensive_evaluator_version: string | null;
  defensive_resolver_version: string | null;
  defensive_solver_version: string | null;
  defensive_game_build: string | null;
  defensive_build_fingerprint: string | null;
  defensive_evaluated_at: string | null;
  /**
   * Canonical defensive Response counters from the currently published
   * defensive generation. Optional so older schema/test fixtures remain
   * source-compatible during the rolling deployment.
   */
  canonical_response_evaluable_count?: number | null;
  canonical_response_success_count?: number | null;
  canonical_response_failure_count?: number | null;
  canonical_defensive_generation_id?: string | null;
  canonical_defensive_evaluated_at?: string | null;
}

function recencyWeight(closedAtIso: string, now: number): number {
  const daysAgo = (now - new Date(closedAtIso).getTime()) / 86_400_000;
  return Math.pow(0.5, Math.max(0, daysAgo) / HALF_LIFE_DAYS);
}

export interface ReliabilityBreakdown {
  overall: number;
  breakdown: {
    mecanica: number | null;
    defensiva: number | null;
    preparacion: number | null;
  };
  consistency: PlayerConsistency | null;
  defensiveShadowComparison: DefensiveReliabilityShadowComparison | null;
}

export interface DefensiveReliabilityShadowComparison {
  legacyScore: number | null;
  v2Score: number;
  delta: number | null;
  comparablePullCount: number;
  evaluatorVersions: string[];
}

export interface ExecutionLedgerShadowComparison {
  legacyMechanicFailureCount: number;
  ledgerMechanicFailureCount: number;
  ledgerDefensiveFailureCount: number;
  ledgerConsumableFailureCount: number;
  primaryPenaltyCount: number;
  mechanicFailureDelta: number;
  comparablePullCount: number;
  evaluatorVersions: string[];
  versionsCompatible: boolean;
}

export function compareExecutionLedgerShadow(
  rows: ReliabilityInputRow[],
  summaries: ExecutionLedgerPullSummary[],
): ExecutionLedgerShadowComparison | null {
  const summaryByPullId = new Map(
    summaries
      .filter((summary) => summary.versions_homogeneous)
      .map((summary) => [summary.pull_id, summary]),
  );
  const comparableRows = rows.filter((row) => summaryByPullId.has(row.pull_id));
  if (!comparableRows.length) return null;

  let legacyMechanicFailureCount = 0;
  let ledgerMechanicFailureCount = 0;
  let ledgerDefensiveFailureCount = 0;
  let ledgerConsumableFailureCount = 0;
  let primaryPenaltyCount = 0;
  const evaluatorVersions = new Set<string>();
  for (const row of comparableRows) {
    const summary = summaryByPullId.get(row.pull_id)!;
    legacyMechanicFailureCount +=
      row.personal_mechanic_fail_count ??
      Number(row.had_avoidable_damage || row.self_positioning_death);
    ledgerMechanicFailureCount += summary.mechanic_failure_count;
    ledgerDefensiveFailureCount += summary.defensive_failure_count;
    ledgerConsumableFailureCount += summary.consumable_failure_count;
    primaryPenaltyCount += summary.primary_penalty_count;
    evaluatorVersions.add(summary.ledger_evaluator_version);
  }
  return {
    legacyMechanicFailureCount,
    ledgerMechanicFailureCount,
    ledgerDefensiveFailureCount,
    ledgerConsumableFailureCount,
    primaryPenaltyCount,
    mechanicFailureDelta: ledgerMechanicFailureCount - legacyMechanicFailureCount,
    comparablePullCount: comparableRows.length,
    evaluatorVersions: [...evaluatorVersions].sort(),
    versionsCompatible:
      evaluatorVersions.size === 1 && evaluatorVersions.has(REQUIRED_EXECUTION_LEDGER_VERSION),
  };
}

export interface ReliabilityComputationOptions {
  defensiveV2Enabled?: boolean;
}

function v2DefensiveRowIsCompatible(row: ReliabilityInputRow): boolean {
  const score = row.defensive_management_score_v2;
  const decisionCount = row.defensive_management_decision_count;
  const requiredCount = row.defensive_required_count;
  const requiredSuccessCount = row.defensive_required_success_count;
  const requiredExactAdherenceCount = row.defensive_required_exact_adherence_count;
  const brokenCount = row.defensive_broken_reservation_count;
  const deathCount = row.defensive_death_viable_cd_count;
  if (
    decisionCount == null ||
    decisionCount < 0 ||
    (decisionCount === 0 ? score != null : score == null) ||
    (score != null && (!Number.isFinite(score) || score < 0 || score > 100)) ||
    requiredCount == null ||
    requiredCount < 0 ||
    requiredSuccessCount == null ||
    requiredSuccessCount < 0 ||
    requiredSuccessCount > requiredCount ||
    requiredExactAdherenceCount == null ||
    requiredExactAdherenceCount < 0 ||
    requiredExactAdherenceCount > requiredSuccessCount ||
    requiredExactAdherenceCount > requiredCount ||
    brokenCount == null ||
    brokenCount < 0 ||
    deathCount == null ||
    deathCount < 0 ||
    row.defensive_evaluator_version !== REQUIRED_DEFENSIVE_EVALUATOR_VERSION ||
    row.defensive_resolver_version !== REQUIRED_DEFENSIVE_RESOLVER_VERSION ||
    (row.defensive_evaluation_confidence !== 'verified' &&
      row.defensive_evaluation_confidence !== 'inferred')
  ) {
    return false;
  }
  return true;
}

function reliableV2DefensiveScore(row: ReliabilityInputRow): number | null {
  return v2DefensiveRowIsCompatible(row) && row.defensive_management_score_v2 != null
    ? row.defensive_management_score_v2 / 100
    : null;
}

function hasAnyCanonicalDefensiveValue(row: ReliabilityInputRow): boolean {
  return (
    row.canonical_response_evaluable_count != null ||
    row.canonical_response_success_count != null ||
    row.canonical_response_failure_count != null ||
    row.canonical_defensive_generation_id != null ||
    row.canonical_defensive_evaluated_at != null
  );
}

function canonicalDefensiveRowIsCompatible(row: ReliabilityInputRow): boolean {
  const evaluable = row.canonical_response_evaluable_count;
  const success = row.canonical_response_success_count;
  const failure = row.canonical_response_failure_count;
  return (
    typeof row.canonical_defensive_generation_id === 'string' &&
    row.canonical_defensive_generation_id.length > 0 &&
    evaluable != null &&
    success != null &&
    failure != null &&
    Number.isInteger(evaluable) &&
    Number.isInteger(success) &&
    Number.isInteger(failure) &&
    evaluable >= 0 &&
    success >= 0 &&
    failure >= 0 &&
    success <= evaluable &&
    failure <= evaluable &&
    success + failure === evaluable
  );
}

function canonicalDefensiveGenerationForRows(rows: readonly ReliabilityInputRow[]): string | null {
  const canonicalRows = rows.filter(hasAnyCanonicalDefensiveValue);
  if (!canonicalRows.length || !canonicalRows.every(canonicalDefensiveRowIsCompatible)) return null;
  const generationIds = new Set(canonicalRows.map((row) => row.canonical_defensive_generation_id!));
  return generationIds.size === 1 ? [...generationIds][0] : null;
}

function canonicalDefensiveScore(row: ReliabilityInputRow): number | null {
  if (!canonicalDefensiveRowIsCompatible(row)) return null;
  const evaluable = row.canonical_response_evaluable_count!;
  return evaluable > 0 ? row.canonical_response_success_count! / evaluable : null;
}

export interface PlayerConsistency {
  score: number;
  averageExecution: number;
  volatility: number;
  cleanPullRate: number;
  sampleSize: number;
}

export function computeReliabilityBreakdown(
  rows: ReliabilityInputRow[],
  now: number,
  options: ReliabilityComputationOptions = {},
): ReliabilityBreakdown | null {
  if (!rows.length) return null;

  // Canonical Response is now the authoritative defensive axis whenever the
  // scope contains a coherent published generation. Rows outside that
  // generation simply do not contribute defensive evidence; they are never
  // mixed with legacy/window/management semantics inside the same score.
  const canonicalGenerationId = canonicalDefensiveGenerationForRows(rows);
  const useCanonicalDefensiveGeneration = canonicalGenerationId != null;

  const visibleV2Generation =
    !useCanonicalDefensiveGeneration &&
    options.defensiveV2Enabled === true &&
    rows.every(v2DefensiveRowIsCompatible)
      ? homogeneousDefensiveEvaluationGeneration(
          rows.map((row) => ({
            evaluatorVersion: row.defensive_evaluator_version,
            resolverVersion: row.defensive_resolver_version,
            solverVersion: row.defensive_solver_version,
            gameBuild: row.defensive_game_build,
            buildFingerprint: row.defensive_build_fingerprint,
          })),
        )
      : null;
  const useVisibleV2Generation = visibleV2Generation != null;

  const minPullNumberByReport = new Map<string, number>();
  for (const r of rows) {
    if (r.report_code == null || r.pull_number == null) continue;
    const current = minPullNumberByReport.get(r.report_code);
    if (current == null || r.pull_number < current)
      minPullNumberByReport.set(r.report_code, r.pull_number);
  }
  const isFirstPullOfNight = (r: ReliabilityInputRow): boolean =>
    r.report_code == null ||
    r.pull_number == null ||
    r.pull_number === minPullNumberByReport.get(r.report_code);

  let mecWeight = 0;
  let mecSum = 0;
  let defWeight = 0;
  let defSum = 0;
  let shadowLegacyWeight = 0;
  let shadowLegacySum = 0;
  let shadowV2Weight = 0;
  let shadowV2Sum = 0;
  const shadowEvaluatorVersions = new Set<string>();
  let prepWeight = 0;
  let prepSum = 0;
  const pullExecution: { value: number; weight: number }[] = [];

  for (const r of rows) {
    const w = recencyWeight(r.closed_at, now);
    const mecScore = mechanicScoreFor({
      personalMechanicFailCount: r.personal_mechanic_fail_count,
      avoidableMechanicEligibleCount: r.avoidable_mechanic_eligible_count,
      avoidableMechanicFailCount: r.avoidable_mechanic_fail_count,
      hadAvoidableDamage: r.had_avoidable_damage,
      selfPositioningDeath: r.self_positioning_death,
      unassignedMechanicSuccessCount: r.unassigned_mechanic_success_count,
    });
    mecSum += mecScore * w;
    mecWeight += w;

    let pullDefensiveSum = 0;
    let pullDefensiveWeight = 0;
    if (r.used_defensive_when_died != null) {
      pullDefensiveSum += (r.used_defensive_when_died ? 1 : 0) * 2;
      pullDefensiveWeight += 2;
    }
    if (r.defensive_window_coverable_count != null) {
      const windowTotal = (r.defensive_window_covered_count ?? 0) + r.defensive_window_coverable_count;
      if (windowTotal > 0) {
        const covered = r.defensive_window_covered_count ?? 0;
        const executionValue =
          covered > 0
            ? covered / windowTotal
            : r.defensive_window_used_anything
              ? DEFENSIVE_MISTIMED_CREDIT
              : 0;
        pullDefensiveSum += executionValue;
        pullDefensiveWeight += 1;
      }
    } else if (r.defensive_use_opportunity) {
      pullDefensiveSum += r.used_defensive_in_pull ? 1 : 0;
      pullDefensiveWeight += 1;
    }

    const legacyDefensiveExecution =
      pullDefensiveWeight > 0 ? pullDefensiveSum / pullDefensiveWeight : null;
    const v2DefensiveExecution = reliableV2DefensiveScore(r);
    const canonicalExecution = canonicalDefensiveScore(r);
    const useV2ForPull = useVisibleV2Generation && v2DefensiveExecution != null;

    if (useCanonicalDefensiveGeneration) {
      if (canonicalDefensiveRowIsCompatible(r)) {
        const evaluable = r.canonical_response_evaluable_count!;
        if (evaluable > 0) {
          // Episode-level Response KPI: covered / evaluable. Recency is
          // applied per pull, so a pull with N episodes contributes N
          // samples instead of being flattened to a single pull average.
          defSum += r.canonical_response_success_count! * w;
          defWeight += evaluable * w;
        }
      }
    } else if (useV2ForPull) {
      defSum += v2DefensiveExecution * w;
      defWeight += w;
    } else if (!useVisibleV2Generation && legacyDefensiveExecution != null) {
      defSum += pullDefensiveSum * w;
      defWeight += pullDefensiveWeight * w;
    }

    if (v2DefensiveExecution != null && legacyDefensiveExecution != null) {
      shadowV2Sum += v2DefensiveExecution * w;
      shadowV2Weight += w;
      if (r.defensive_evaluator_version) shadowEvaluatorVersions.add(r.defensive_evaluator_version);
      shadowLegacySum += legacyDefensiveExecution * w;
      shadowLegacyWeight += w;
    }

    const preparationSlots = r.enchantable_slot_count + r.gemmable_slot_count;
    if (preparationSlots > 0 && isFirstPullOfNight(r)) {
      prepSum += ((r.enchanted_slot_count + r.gemmed_slot_count) / preparationSlots) * w;
      prepWeight += w;
    }

    const mechanicExecution = mecScore * 100;
    const selectedDefensiveExecution = useCanonicalDefensiveGeneration
      ? canonicalExecution
      : useVisibleV2Generation
        ? v2DefensiveExecution
        : legacyDefensiveExecution;
    const defensiveExecution =
      selectedDefensiveExecution == null ? null : selectedDefensiveExecution * 100;
    pullExecution.push({
      value:
        defensiveExecution == null
          ? mechanicExecution
          : mechanicExecution * 0.7 + defensiveExecution * 0.3,
      weight: w,
    });
  }

  const mecanica = mecWeight > 0 ? (mecSum / mecWeight) * 100 : null;
  const defensiva = defWeight > 0 ? (defSum / defWeight) * 100 : null;
  const preparacion = prepWeight > 0 ? (prepSum / prepWeight) * 100 : null;

  const axes: { key: keyof typeof AXIS_WEIGHTS; value: number }[] = [];
  if (mecanica != null) axes.push({ key: 'mecanica', value: mecanica });
  if (defensiva != null) axes.push({ key: 'defensiva', value: defensiva });
  if (preparacion != null && preparacion < 100) axes.push({ key: 'preparacion', value: preparacion });
  const weightSum = axes.reduce((s, a) => s + AXIS_WEIGHTS[a.key], 0);
  const overall =
    weightSum > 0
      ? Math.round(axes.reduce((s, a) => s + a.value * AXIS_WEIGHTS[a.key], 0) / weightSum)
      : 0;

  let consistency: PlayerConsistency | null = null;
  if (pullExecution.length >= 5) {
    const totalWeight = pullExecution.reduce((sum, sample) => sum + sample.weight, 0);
    const averageExecution =
      pullExecution.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / totalWeight;
    const variance =
      pullExecution.reduce(
        (sum, sample) => sum + (sample.value - averageExecution) ** 2 * sample.weight,
        0,
      ) / totalWeight;
    const volatility = Math.sqrt(variance);
    consistency = {
      score: Math.round(Math.max(0, Math.min(100, averageExecution - volatility * 0.5))),
      averageExecution: Math.round(averageExecution),
      volatility: Math.round(volatility),
      cleanPullRate: Math.round(
        (pullExecution.filter((sample) => sample.value >= 80).length / pullExecution.length) * 100,
      ),
      sampleSize: pullExecution.length,
    };
  }

  const v2ShadowScore = shadowV2Weight > 0 ? (shadowV2Sum / shadowV2Weight) * 100 : null;
  const legacyShadowScore = shadowLegacyWeight > 0 ? (shadowLegacySum / shadowLegacyWeight) * 100 : null;
  const defensiveShadowComparison: DefensiveReliabilityShadowComparison | null =
    v2ShadowScore == null
      ? null
      : {
          legacyScore: legacyShadowScore,
          v2Score: Math.round(v2ShadowScore * 100) / 100,
          delta:
            legacyShadowScore == null
              ? null
              : Math.round((v2ShadowScore - legacyShadowScore) * 100) / 100,
          comparablePullCount: rows.filter((row) => {
            if (reliableV2DefensiveScore(row) == null) return false;
            return (
              row.used_defensive_when_died != null ||
              ((row.defensive_window_coverable_count ?? 0) +
                (row.defensive_window_covered_count ?? 0) >
                0) ||
              (row.defensive_window_coverable_count == null && row.defensive_use_opportunity)
            );
          }).length,
          evaluatorVersions: [...shadowEvaluatorVersions].sort(),
        };

  return {
    overall,
    breakdown: { mecanica, defensiva, preparacion },
    consistency,
    defensiveShadowComparison,
  };
}

export function effectiveAxisWeights(breakdown: {
  mecanica: number | null;
  defensiva: number | null;
  preparacion: number | null;
}): { mecanica: number | null; defensiva: number | null; preparacion: number | null } {
  const included = new Set<keyof typeof AXIS_WEIGHTS>();
  if (breakdown.mecanica != null) included.add('mecanica');
  if (breakdown.defensiva != null) included.add('defensiva');
  if (breakdown.preparacion != null && breakdown.preparacion < 100) included.add('preparacion');
  const weightSum = [...included].reduce((s, key) => s + AXIS_WEIGHTS[key], 0);
  const pctFor = (key: keyof typeof AXIS_WEIGHTS): number | null =>
    weightSum > 0 && included.has(key) ? Math.round((AXIS_WEIGHTS[key] / weightSum) * 100) : null;
  return {
    mecanica: pctFor('mecanica'),
    defensiva: pctFor('defensiva'),
    preparacion: pctFor('preparacion'),
  };
}

export function computeOverall(
  rows: ReliabilityInputRow[],
  now: number,
  options: ReliabilityComputationOptions = {},
): number | null {
  return computeReliabilityBreakdown(rows, now, options)?.overall ?? null;
}

const TREND_THRESHOLD = 4;
const ROLE_SORT_ORDER: Record<'Tank' | 'Heal' | 'Melee' | 'Ranged' | 'unknown', number> = {
  Tank: 0,
  Heal: 1,
  Melee: 2,
  Ranged: 2,
  unknown: 3,
};

const V2_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count, gemmed_slot_count, gemmable_slot_count, personal_mechanic_fail_count, report_code, pull_number, avoidable_mechanic_eligible_count, avoidable_mechanic_fail_count, defensive_window_coverable_count, defensive_window_covered_count, defensive_window_used_anything, unassigned_mechanic_success_count, defensive_management_score_v2, defensive_management_decision_count, defensive_required_count, defensive_required_success_count, defensive_required_exact_adherence_count, defensive_broken_reservation_count, defensive_death_viable_cd_count, defensive_evaluation_confidence, defensive_evaluator_version, defensive_resolver_version, defensive_solver_version, defensive_game_build, defensive_build_fingerprint, defensive_evaluated_at';
const UNASSIGNED_MECHANIC_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count, gemmed_slot_count, gemmable_slot_count, personal_mechanic_fail_count, report_code, pull_number, avoidable_mechanic_eligible_count, avoidable_mechanic_fail_count, defensive_window_coverable_count, defensive_window_covered_count, defensive_window_used_anything, unassigned_mechanic_success_count';
const WINDOW_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count, gemmed_slot_count, gemmable_slot_count, personal_mechanic_fail_count, report_code, pull_number, avoidable_mechanic_eligible_count, avoidable_mechanic_fail_count, defensive_window_coverable_count, defensive_window_covered_count, defensive_window_used_anything';
const RATIO_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count, gemmed_slot_count, gemmable_slot_count, personal_mechanic_fail_count, report_code, pull_number, avoidable_mechanic_eligible_count, avoidable_mechanic_fail_count';
const RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count, gemmed_slot_count, gemmable_slot_count, personal_mechanic_fail_count, report_code, pull_number';
const DEFENSIVE_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, used_defensive_in_pull, defensive_use_opportunity, enchanted_slot_count, enchantable_slot_count, gem_count';
const LEGACY_RELIABILITY_COLUMNS =
  'player_name, pull_id, boss_id, difficulty, closed_at, had_avoidable_damage, self_positioning_death, used_defensive_when_died, enchanted_slot_count, enchantable_slot_count, gem_count';

interface RawReliabilityEvidenceRecord {
  pull_id: string;
  player_name: string;
  death_cause: DeathCause | null;
  defensive_casts: { spellId: number; name: string; timestampsMs: number[] }[] | null;
  equipped_items: WclGearItem[] | null;
}

interface ReliabilityEvidencePull {
  id: string;
  report_code: string;
  fight_id: number;
  boss_id: string;
  difficulty: string;
  pull_number: number;
  closed_at: string;
  wipe_call_excluded: boolean;
  wipe_call_signals: { wipeCallStartMs?: number | null } | null;
}

interface ReliabilityInputFilters {
  scope?: { bossId: string; difficulty: string };
  since?: string;
  playerName?: string;
  pullIds?: string[];
}

function isReliabilitySchemaTransitionError(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    /used_defensive_in_pull|defensive_use_opportunity|gemmed_slot_count|gemmable_slot_count|personal_mechanic_fail_count|report_code|pull_number|avoidable_mechanic_eligible_count|avoidable_mechanic_fail_count|defensive_window_coverable_count|defensive_window_covered_count|defensive_window_used_anything|unassigned_mechanic_success_count|defensive_management_score_v2|defensive_management_decision_count|defensive_required_count|defensive_required_success_count|defensive_required_exact_adherence_count|defensive_broken_reservation_count|defensive_death_viable_cd_count|defensive_evaluation_confidence|defensive_evaluator_version|defensive_resolver_version|defensive_solver_version|defensive_game_build|defensive_build_fingerprint|defensive_evaluated_at/i.test(
      message,
    )
  );
}

function isReliabilityRpcUnavailable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /get_player_pull_reliability_inputs_v2/i.test(error.message ?? '')
  );
}

@Injectable({ providedIn: 'root' })
export class ReliabilityService {
  private supabase = inject(SupabaseService);
  private wowauditRoster = inject(WowauditRosterService);
  private attendanceService = inject(AttendanceService);
  private defensiveFlags = inject(DefensiveFeatureFlagsService);
  private executionLedger = inject(ExecutionLedgerService);

  private async loadExecutionLedgerShadow(pullIds: string[]): Promise<ExecutionLedgerPullSummary[]> {
    try {
      return await this.executionLedger.listPullSummaries(pullIds);
    } catch {
      return [];
    }
  }

  private reliabilityComputationOptions(): ReliabilityComputationOptions {
    return {
      defensiveV2Enabled: this.defensiveFlags.enabled('defensiveReliabilityV2'),
    };
  }

  private normalizeReliabilityRows(
    data: unknown[],
    schemaLevel: 'rpc-v2' | 'v2' | 'unassigned' | 'window' | 'ratio' | 'current' | 'defensive' | 'legacy',
  ): ReliabilityInputRow[] {
    return (data as Partial<ReliabilityInputRow>[]).map((row) => {
      const hasCurrentSchema = ['rpc-v2', 'v2', 'unassigned', 'window', 'ratio', 'current'].includes(schemaLevel);
      const hasRatioSchema = ['rpc-v2', 'v2', 'unassigned', 'window', 'ratio'].includes(schemaLevel);
      const hasWindowSchema = ['rpc-v2', 'v2', 'unassigned', 'window'].includes(schemaLevel);
      const hasV2Schema = schemaLevel === 'rpc-v2' || schemaLevel === 'v2';
      const hasCanonicalSchema = schemaLevel === 'rpc-v2';
      return {
        ...(row as ReliabilityInputRow),
        used_defensive_in_pull:
          schemaLevel === 'legacy' ? false : row.used_defensive_in_pull === true,
        defensive_use_opportunity:
          schemaLevel === 'legacy' ? false : row.defensive_use_opportunity === true,
        gemmed_slot_count: hasCurrentSchema ? Number(row.gemmed_slot_count ?? 0) : 0,
        gemmable_slot_count: hasCurrentSchema ? Number(row.gemmable_slot_count ?? 0) : 0,
        personal_mechanic_fail_count:
          hasCurrentSchema ? Number(row.personal_mechanic_fail_count ?? 0) : null,
        report_code: hasCurrentSchema ? (row.report_code ?? null) : null,
        pull_number: hasCurrentSchema ? (row.pull_number ?? null) : null,
        avoidable_mechanic_eligible_count:
          hasRatioSchema ? Number(row.avoidable_mechanic_eligible_count ?? 0) : null,
        avoidable_mechanic_fail_count:
          hasRatioSchema ? Number(row.avoidable_mechanic_fail_count ?? 0) : null,
        defensive_window_coverable_count:
          hasWindowSchema ? Number(row.defensive_window_coverable_count ?? 0) : null,
        defensive_window_covered_count:
          hasWindowSchema ? Number(row.defensive_window_covered_count ?? 0) : null,
        defensive_window_used_anything:
          hasWindowSchema ? row.defensive_window_used_anything === true : null,
        unassigned_mechanic_success_count:
          ['rpc-v2', 'v2', 'unassigned'].includes(schemaLevel)
            ? Number(row.unassigned_mechanic_success_count ?? 0)
            : null,
        defensive_management_score_v2:
          hasV2Schema && row.defensive_management_score_v2 != null
            ? Number(row.defensive_management_score_v2)
            : null,
        defensive_management_decision_count:
          hasV2Schema && row.defensive_management_decision_count != null
            ? Number(row.defensive_management_decision_count)
            : null,
        defensive_required_count:
          hasV2Schema && row.defensive_required_count != null
            ? Number(row.defensive_required_count)
            : null,
        defensive_required_success_count:
          hasV2Schema && row.defensive_required_success_count != null
            ? Number(row.defensive_required_success_count)
            : null,
        defensive_required_exact_adherence_count:
          hasV2Schema && row.defensive_required_exact_adherence_count != null
            ? Number(row.defensive_required_exact_adherence_count)
            : null,
        defensive_broken_reservation_count:
          hasV2Schema && row.defensive_broken_reservation_count != null
            ? Number(row.defensive_broken_reservation_count)
            : null,
        defensive_death_viable_cd_count:
          hasV2Schema && row.defensive_death_viable_cd_count != null
            ? Number(row.defensive_death_viable_cd_count)
            : null,
        defensive_evaluation_confidence:
          hasV2Schema ? (row.defensive_evaluation_confidence ?? null) : null,
        defensive_evaluator_version:
          hasV2Schema ? (row.defensive_evaluator_version ?? null) : null,
        defensive_resolver_version:
          hasV2Schema ? (row.defensive_resolver_version ?? null) : null,
        defensive_solver_version:
          hasV2Schema ? (row.defensive_solver_version ?? null) : null,
        defensive_game_build:
          hasV2Schema ? (row.defensive_game_build ?? null) : null,
        defensive_build_fingerprint:
          hasV2Schema ? (row.defensive_build_fingerprint ?? null) : null,
        defensive_evaluated_at:
          hasV2Schema ? (row.defensive_evaluated_at ?? null) : null,
        canonical_response_evaluable_count:
          hasCanonicalSchema && row.canonical_response_evaluable_count != null
            ? Number(row.canonical_response_evaluable_count)
            : null,
        canonical_response_success_count:
          hasCanonicalSchema && row.canonical_response_success_count != null
            ? Number(row.canonical_response_success_count)
            : null,
        canonical_response_failure_count:
          hasCanonicalSchema && row.canonical_response_failure_count != null
            ? Number(row.canonical_response_failure_count)
            : null,
        canonical_defensive_generation_id:
          hasCanonicalSchema ? (row.canonical_defensive_generation_id ?? null) : null,
        canonical_defensive_evaluated_at:
          hasCanonicalSchema ? (row.canonical_defensive_evaluated_at ?? null) : null,
      };
    });
  }

  private async fetchReliabilityInputs(
    filters: ReliabilityInputFilters,
  ): Promise<ReliabilityInputRow[]> {
    if (filters.pullIds && !filters.pullIds.length) return [];

    // The expensive dossier/night path is always player-scoped. Use the
    // set-based RPC there so PostgREST never expands the global reliability
    // view and its correlated mechanic subqueries before applying the actor
    // filter. If the RPC is not deployed yet, only the explicit
    // function-not-found rollout case falls back to the old view. Timeouts
    // and pool errors are surfaced instead of silently re-entering the heavy
    // path that caused the original incident.
    if (filters.playerName) {
      const rpc = await this.supabase.client.rpc('get_player_pull_reliability_inputs_v2', {
        p_player_name: filters.playerName,
        p_since: filters.since ?? null,
        p_boss_id: filters.scope?.bossId ?? null,
        p_difficulty: filters.scope?.difficulty ?? null,
        p_pull_ids: filters.pullIds ?? null,
      });
      if (!rpc.error) {
        return this.normalizeReliabilityRows((rpc.data ?? []) as unknown[], 'rpc-v2');
      }
      if (!isReliabilityRpcUnavailable(rpc.error)) throw rpc.error;
    }

    const run = async (columns: string) => {
      let query = this.supabase.client.from('player_pull_reliability_inputs').select(columns);
      if (filters.scope)
        query = query
          .eq('boss_id', filters.scope.bossId)
          .eq('difficulty', filters.scope.difficulty);
      if (filters.since) query = query.gte('closed_at', filters.since);
      if (filters.playerName) query = query.eq('player_name', filters.playerName);
      if (filters.pullIds) query = query.in('pull_id', filters.pullIds);
      return await query;
    };

    let response = await run(V2_RELIABILITY_COLUMNS);
    let schemaLevel: 'v2' | 'unassigned' | 'window' | 'ratio' | 'current' | 'defensive' | 'legacy' =
      'v2';
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(UNASSIGNED_MECHANIC_RELIABILITY_COLUMNS);
      schemaLevel = 'unassigned';
    }
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(WINDOW_RELIABILITY_COLUMNS);
      schemaLevel = 'window';
    }
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(RATIO_RELIABILITY_COLUMNS);
      schemaLevel = 'ratio';
    }
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(RELIABILITY_COLUMNS);
      schemaLevel = 'current';
    }
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(DEFENSIVE_RELIABILITY_COLUMNS);
      schemaLevel = 'defensive';
    }
    if (response.error && isReliabilitySchemaTransitionError(response.error)) {
      response = await run(LEGACY_RELIABILITY_COLUMNS);
      schemaLevel = 'legacy';
    }
    if (response.error) throw response.error;
    return this.normalizeReliabilityRows((response.data ?? []) as unknown[], schemaLevel);
  }

  async getPlayerReliabilityInputs(
    playerName: string,
    since: string,
  ): Promise<ReliabilityInputRow[]> {
    return this.fetchReliabilityInputs({ playerName, since });
  }

  async listPlayerReliability(scope?: {
    bossId: string;
    difficulty: string;
  }): Promise<PlayerReliability[]> {
    const [data, roster, realAttendance] = await Promise.all([
      this.fetchReliabilityInputs(
        scope
          ? { scope }
          : { since: new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString() },
      ),
      this.wowauditRoster.listRoster().catch(() => []),
      this.attendanceService
        .listRealAttendance()
        .catch(() => new Map<string, { attended: number; total: number; pct: number | null }>()),
    ]);
    const rosterByName = new Map(roster.map((r) => [r.name, r]));
    const ledgerSummaries = await this.loadExecutionLedgerShadow(
      [...new Set(data.map((row) => row.pull_id))],
    );

    let evidenceRecords: RawReliabilityEvidenceRecord[] = [];
    let evidencePulls: ReliabilityEvidencePull[] = [];
    let bossNames = new Map<string, string>();
    if (!scope && data.length) {
      const pullIds = [...new Set(data.map((row) => row.pull_id))];
      const bossIds = [...new Set(data.map((row) => row.boss_id))];
      const [recordsResponse, pullsResponse, bossesResponse] = await Promise.all([
        this.supabase.client
          .from('player_pull_records')
          .select('pull_id, player_name, death_cause, defensive_casts, equipped_items')
          .in('pull_id', pullIds),
        this.supabase.client
          .from('pulls')
          .select(
            'id, report_code, fight_id, boss_id, difficulty, pull_number, closed_at, wipe_call_excluded, wipe_call_signals',
          )
          .in('id', pullIds),
        this.supabase.client
          .from('known_raid_bosses')
          .select('encounter_id, boss_name')
          .in('encounter_id', bossIds.map(Number).filter(Number.isFinite)),
      ]);
      if (!recordsResponse.error)
        evidenceRecords = (recordsResponse.data ?? []) as RawReliabilityEvidenceRecord[];
      if (!pullsResponse.error)
        evidencePulls = (pullsResponse.data ?? []) as ReliabilityEvidencePull[];
      if (!bossesResponse.error) {
        bossNames = new Map(
          (
            (bossesResponse.data ?? []) as { encounter_id: number | string; boss_name: string }[]
          ).map((boss) => [String(boss.encounter_id), boss.boss_name]),
        );
      }
    }
    const evidenceRecordByPlayerPull = new Map(
      evidenceRecords.map((record) => [`${record.player_name}|${record.pull_id}`, record]),
    );
    const evidencePullById = new Map(evidencePulls.map((pull) => [pull.id, pull]));

    const byPlayer = new Map<string, ReliabilityInputRow[]>();
    for (const row of data) {
      if (!byPlayer.has(row.player_name)) byPlayer.set(row.player_name, []);
      byPlayer.get(row.player_name)!.push(row);
    }
    if (roster.length) {
      byPlayer.forEach((_, name) => {
        if (!rosterByName.has(name)) byPlayer.delete(name);
      });
      if (!scope) {
        for (const entry of roster) {
          if (!byPlayer.has(entry.name)) byPlayer.set(entry.name, []);
        }
      }
    }

    const now = Date.now();
    const midpoint = now - (WINDOW_DAYS / 2) * 86_400_000;
    const results: PlayerReliability[] = [];
    for (const [playerName, rows] of byPlayer) {
      results.push(
        this.buildReliabilityEntry(
          playerName,
          rows,
          rosterByName.get(playerName),
          realAttendance.get(playerName) ?? null,
          evidenceRecordByPlayerPull,
          evidencePullById,
          bossNames,
          now,
          midpoint,
          ledgerSummaries.filter((summary) => summary.player_name === playerName),
        ),
      );
    }

    return results.sort((a, b) => {
      const roleDelta = ROLE_SORT_ORDER[a.role ?? 'unknown'] - ROLE_SORT_ORDER[b.role ?? 'unknown'];
      return roleDelta !== 0 ? roleDelta : b.overall - a.overall;
    });
  }

  async getPlayerReliability(playerName: string): Promise<PlayerReliability | null> {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const [rows, roster, attendance] = await Promise.all([
      this.fetchReliabilityInputs({ playerName, since }),
      this.wowauditRoster.listRoster().catch(() => []),
      this.attendanceService.getPlayerRealAttendance(playerName).catch(() => null),
    ]);
    const rosterEntry = roster.find((r) => r.name === playerName);
    if (roster.length && !rosterEntry) return null;

    let evidenceRecords: RawReliabilityEvidenceRecord[] = [];
    let evidencePulls: ReliabilityEvidencePull[] = [];
    let bossNames = new Map<string, string>();
    if (rows.length) {
      const pullIds = [...new Set(rows.map((row) => row.pull_id))];
      const bossIds = [...new Set(rows.map((row) => row.boss_id))];
      const [recordsResponse, pullsResponse, bossesResponse] = await Promise.all([
        this.supabase.client
          .from('player_pull_records')
          .select('pull_id, player_name, death_cause, defensive_casts, equipped_items')
          .eq('player_name', playerName)
          .in('pull_id', pullIds),
        this.supabase.client
          .from('pulls')
          .select(
            'id, report_code, fight_id, boss_id, difficulty, pull_number, closed_at, wipe_call_excluded, wipe_call_signals',
          )
          .in('id', pullIds),
        this.supabase.client
          .from('known_raid_bosses')
          .select('encounter_id, boss_name')
          .in('encounter_id', bossIds.map(Number).filter(Number.isFinite)),
      ]);
      if (!recordsResponse.error)
        evidenceRecords = (recordsResponse.data ?? []) as RawReliabilityEvidenceRecord[];
      if (!pullsResponse.error)
        evidencePulls = (pullsResponse.data ?? []) as ReliabilityEvidencePull[];
      if (!bossesResponse.error) {
        bossNames = new Map(
          (
            (bossesResponse.data ?? []) as { encounter_id: number | string; boss_name: string }[]
          ).map((boss) => [String(boss.encounter_id), boss.boss_name]),
        );
      }
    }
    const evidenceRecordByPlayerPull = new Map(
      evidenceRecords.map((record) => [`${record.player_name}|${record.pull_id}`, record]),
    );
    const evidencePullById = new Map(evidencePulls.map((pull) => [pull.id, pull]));
    const ledgerSummaries = await this.loadExecutionLedgerShadow(
      [...new Set(rows.map((row) => row.pull_id))],
    );

    const now = Date.now();
    const midpoint = now - (WINDOW_DAYS / 2) * 86_400_000;
    return this.buildReliabilityEntry(
      playerName,
      rows,
      rosterEntry,
      attendance,
      evidenceRecordByPlayerPull,
      evidencePullById,
      bossNames,
      now,
      midpoint,
      ledgerSummaries.filter((summary) => summary.player_name === playerName),
    );
  }

  private buildReliabilityEntry(
    playerName: string,
    rows: ReliabilityInputRow[],
    rosterEntry: WowauditRosterEntry | undefined,
    attendance: RealAttendanceEntry | null,
    evidenceRecordByPlayerPull: Map<string, RawReliabilityEvidenceRecord>,
    evidencePullById: Map<string, ReliabilityEvidencePull>,
    bossNames: Map<string, string>,
    now: number,
    midpoint: number,
    ledgerSummaries: ExecutionLedgerPullSummary[] = [],
  ): PlayerReliability {
    let latestGemCount: number | null = null;
    let latestGemmedSlotCount: number | null = null;
    let latestGemmableSlotCount: number | null = null;
    let latestEnchantedSlotCount: number | null = null;
    let latestEnchantableSlotCount: number | null = null;
    let latestMissingEnchantSlots: string[] = [];
    let latestMissingGemSlots: string[] = [];
    let latestPreparationObservedAt: string | null = null;
    let lastObservedAt: string | null = null;
    const firstRowByNight = new Map<string, ReliabilityInputRow>();
    for (const r of rows) {
      if (lastObservedAt == null || r.closed_at > lastObservedAt) lastObservedAt = r.closed_at;
      const nightKey = r.closed_at.slice(0, 10);
      const first = firstRowByNight.get(nightKey);
      if (!first || r.closed_at < first.closed_at) firstRowByNight.set(nightKey, r);
    }
    let latestPreparationRow: ReliabilityInputRow | null = null;
    for (const row of firstRowByNight.values()) {
      if (!latestPreparationRow || row.closed_at > latestPreparationRow.closed_at)
        latestPreparationRow = row;
    }
    if (latestPreparationRow) {
      latestGemCount = latestPreparationRow.gem_count;
      latestGemmedSlotCount = latestPreparationRow.gemmed_slot_count;
      latestGemmableSlotCount = latestPreparationRow.gemmable_slot_count;
      latestEnchantedSlotCount = latestPreparationRow.enchanted_slot_count;
      latestEnchantableSlotCount = latestPreparationRow.enchantable_slot_count;
      latestPreparationObservedAt = latestPreparationRow.closed_at;
      const preparationRecord = evidenceRecordByPlayerPull.get(
        `${playerName}|${latestPreparationRow.pull_id}`,
      );
      if (preparationRecord?.equipped_items) {
        const preparation = gearPreparationDetails(preparationRecord.equipped_items);
        latestMissingEnchantSlots = preparation.missingEnchantSlots;
        latestMissingGemSlots = preparation.missingGemSlots;
      }
    }

    const computationOptions = this.reliabilityComputationOptions();
    const result = computeReliabilityBreakdown(rows, now, computationOptions);
    const overall = result?.overall ?? 0;
    const { mecanica, defensiva, preparacion } = result?.breakdown ?? {
      mecanica: null,
      defensiva: null,
      preparacion: null,
    };
    const observedAxisCount = result
      ? Object.values(result.breakdown).filter((value) => value != null).length
      : 0;
    const defensiveOpportunityCount = rows.filter((row) => row.defensive_use_opportunity).length;
    const defensiveUseCount = rows.filter(
      (row) => row.defensive_use_opportunity && row.used_defensive_in_pull,
    ).length;
    const defensiveDeathOpportunityCount = rows.filter(
      (row) => row.used_defensive_when_died != null,
    ).length;
    const defensiveDeathUseCount = rows.filter(
      (row) => row.used_defensive_when_died === true,
    ).length;

    const spellUsage = new Map<
      string,
      { spellId: number; name: string; castCount: number; pullIds: Set<string> }
    >();
    const defensiveDeathEvidence: DefensiveDeathEvidence[] = [];
    for (const row of rows) {
      const record = evidenceRecordByPlayerPull.get(`${playerName}|${row.pull_id}`);
      const pull = evidencePullById.get(row.pull_id);
      if (!record || !pull) continue;
      const wipeCallStartMs =
        pull.wipe_call_excluded && typeof pull.wipe_call_signals?.wipeCallStartMs === 'number'
          ? pull.wipe_call_signals.wipeCallStartMs
          : null;
      for (const defensive of record.defensive_casts ?? []) {
        const castCount = (defensive.timestampsMs ?? []).filter(
          (timestamp) => wipeCallStartMs == null || timestamp < wipeCallStartMs,
        ).length;
        if (!castCount) continue;
        const key = `${defensive.spellId}|${defensive.name}`;
        const current = spellUsage.get(key) ?? {
          spellId: defensive.spellId,
          name: defensive.name,
          castCount: 0,
          pullIds: new Set<string>(),
        };
        current.castCount += castCount;
        current.pullIds.add(row.pull_id);
        spellUsage.set(key, current);
      }

      if (row.used_defensive_when_died == null) continue;
      const cause = record.death_cause;
      const options = cause?.defensiveOptions ?? [];
      defensiveDeathEvidence.push({
        pullId: row.pull_id,
        bossId: row.boss_id,
        bossName: bossNames.get(row.boss_id) ?? `Boss ${row.boss_id}`,
        difficulty: row.difficulty,
        reportCode: pull.report_code,
        fightId: pull.fight_id,
        pullNumber: pull.pull_number,
        closedAt: pull.closed_at,
        mechanicId: cause?.mechanicId ?? null,
        mechanicName: cause?.mechanicName ?? 'Causa sin identificar',
        usedDefensive: row.used_defensive_when_died === true,
        availableUnused: options
          .filter((option) => option.status === 'available_unused')
          .map((option) => ({ spellId: option.spellId, name: option.name })),
        active: options
          .filter((option) => option.status === 'active')
          .map((option) => ({ spellId: option.spellId, name: option.name })),
        onCooldown: options
          .filter((option) => option.status === 'on_cooldown')
          .map((option) => ({
            spellId: option.spellId,
            name: option.name,
            cooldownRemainingMs: option.cooldownRemainingMs ?? null,
          })),
      });
    }
    const defensiveSpellUsage: DefensiveSpellUsage[] = [...spellUsage.values()]
      .map((usage) => ({
        spellId: usage.spellId,
        name: usage.name,
        castCount: usage.castCount,
        pullCount: usage.pullIds.size,
      }))
      .sort((a, b) => b.castCount - a.castCount || a.name.localeCompare(b.name, 'es'));
    defensiveDeathEvidence.sort((a, b) => b.closedAt.localeCompare(a.closedAt));

    const olderScore = computeOverall(
      rows.filter((r) => new Date(r.closed_at).getTime() < midpoint),
      now,
      computationOptions,
    );
    const newerScore = computeOverall(
      rows.filter((r) => new Date(r.closed_at).getTime() >= midpoint),
      now,
      computationOptions,
    );
    let trend: PlayerReliability['trend'] = null;
    if (olderScore != null && newerScore != null) {
      const delta = newerScore - olderScore;
      trend = delta >= TREND_THRESHOLD ? 'up' : delta <= -TREND_THRESHOLD ? 'down' : 'flat';
    }

    return {
      playerName,
      overall,
      breakdown: { mecanica, defensiva, preparacion },
      consistency: result?.consistency ?? null,
      defensiveShadowComparison: result?.defensiveShadowComparison ?? null,
      executionLedgerShadowComparison: compareExecutionLedgerShadow(rows, ledgerSummaries),
      latestGemCount,
      latestGemmedSlotCount,
      latestGemmableSlotCount,
      latestEnchantedSlotCount,
      latestEnchantableSlotCount,
      latestMissingEnchantSlots,
      latestMissingGemSlots,
      latestPreparationObservedAt,
      sampleSize: rows.length,
      sampleNightCount: firstRowByNight.size,
      lastObservedAt,
      defensiveOpportunityCount,
      defensiveUseCount,
      defensiveDeathOpportunityCount,
      defensiveDeathUseCount,
      defensiveSpellUsage,
      defensiveDeathEvidence,
      observedAxisCount,
      attendanceNightsAttended: attendance?.attended ?? null,
      attendanceNightsTotal: attendance?.total ?? null,
      trend,
      role: rosterEntry?.role ?? null,
      rank: rosterEntry?.rank ?? null,
    };
  }

  async getPlayerPullReliabilityInputsForReport(
    reportCode: string,
    playerName: string,
  ): Promise<ReliabilityInputRow[]> {
    const { data: pulls } = await this.supabase.client.from('pulls').select('id').eq('report_code', reportCode);
    const pullIds = ((pulls ?? []) as { id: string }[]).map((p) => p.id);
    if (!pullIds.length) return [];
    return this.fetchReliabilityInputs({ playerName, pullIds });
  }

  async getNightReliability(
    reportCode: string,
    playerName: string,
  ): Promise<ReliabilityBreakdown & { sampleSize: number }> {
    const rows = await this.getPlayerPullReliabilityInputsForReport(reportCode, playerName);
    if (!rows.length)
      return {
        overall: 0,
        breakdown: { mecanica: null, defensiva: null, preparacion: null },
        consistency: null,
        defensiveShadowComparison: null,
        sampleSize: 0,
      };

    const result = computeReliabilityBreakdown(
      rows,
      Date.now(),
      this.reliabilityComputationOptions(),
    );
    return result
      ? { ...result, sampleSize: rows.length }
      : {
          overall: 0,
          breakdown: { mecanica: null, defensiva: null, preparacion: null },
          consistency: null,
          defensiveShadowComparison: null,
          sampleSize: 0,
        };
  }

  async getBossDifficultyEvolution(
    bossId: string,
    difficulty: string,
  ): Promise<Map<string, BossDifficultyEvolutionPoint[]>> {
    const client = this.supabase.client;
    const [inputRows, pullsResponse] = await Promise.all([
      this.fetchReliabilityInputs({ scope: { bossId, difficulty } }),
      client
        .from('pulls')
        .select('id, report_code, wipe_pct')
        .eq('boss_id', bossId)
        .eq('difficulty', difficulty)
        .eq('ninja_pull_excluded', false),
    ]);
    if (pullsResponse.error) throw pullsResponse.error;
    const pullRows = (pullsResponse.data ?? []) as {
      id: string;
      report_code: string;
      wipe_pct: number | null;
    }[];
    const pullIds = pullRows.map((p) => p.id);
    const wipePctByPullId = new Map(pullRows.map((p) => [p.id, p.wipe_pct]));
    const reportCodeByPullId = new Map(pullRows.map((p) => [p.id, p.report_code]));
    const reportCodes = [...new Set(pullRows.map((p) => p.report_code))];

    const [recordsResponse, reportsResponse] = await Promise.all([
      pullIds.length
        ? client
            .from('player_pull_records')
            .select('pull_id, player_name, world_rank_percent')
            .in('pull_id', pullIds)
        : Promise.resolve({
            data: [] as {
              pull_id: string;
              player_name: string;
              world_rank_percent: number | null;
            }[],
            error: null,
          }),
      reportCodes.length
        ? client.from('reports').select('code, title, start_time').in('code', reportCodes)
        : Promise.resolve({
            data: [] as { code: string; title: string | null; start_time: string | null }[],
            error: null,
          }),
    ]);
    if (recordsResponse.error) throw recordsResponse.error;
    if (reportsResponse.error) throw reportsResponse.error;
    const reportByCode = new Map(
      (
        (reportsResponse.data ?? []) as {
          code: string;
          title: string | null;
          start_time: string | null;
        }[]
      ).map((r) => [r.code, r]),
    );

    const byPlayerReport = new Map<string, Map<string, ReliabilityInputRow[]>>();
    for (const row of inputRows) {
      if (!row.report_code) continue;
      let byReport = byPlayerReport.get(row.player_name);
      if (!byReport) {
        byReport = new Map();
        byPlayerReport.set(row.player_name, byReport);
      }
      const list = byReport.get(row.report_code) ?? [];
      list.push(row);
      byReport.set(row.report_code, list);
    }

    const parseByPlayerReport = new Map<string, Map<string, number[]>>();
    for (const record of (recordsResponse.data ?? []) as {
      pull_id: string;
      player_name: string;
      world_rank_percent: number | null;
    }[]) {
      if (record.world_rank_percent == null) continue;
      const reportCode = reportCodeByPullId.get(record.pull_id);
      if (!reportCode) continue;
      let byReport = parseByPlayerReport.get(record.player_name);
      if (!byReport) {
        byReport = new Map();
        parseByPlayerReport.set(record.player_name, byReport);
      }
      const list = byReport.get(reportCode) ?? [];
      list.push(record.world_rank_percent);
      byReport.set(reportCode, list);
    }

    const now = Date.now();
    const result = new Map<string, BossDifficultyEvolutionPoint[]>();
    for (const [playerName, byReport] of byPlayerReport) {
      const points: BossDifficultyEvolutionPoint[] = [];
      for (const [reportCode, rows] of byReport) {
        const breakdown = computeReliabilityBreakdown(
          rows,
          now,
          this.reliabilityComputationOptions(),
        );
        if (!breakdown) continue;
        const wipePcts = rows
          .map((r) => wipePctByPullId.get(r.pull_id))
          .filter((v): v is number => v != null);
        const kill = wipePcts.some((v) => v === 0);
        const bestWipePct = wipePcts.length ? Math.min(...wipePcts) : null;
        const parses = parseByPlayerReport.get(playerName)?.get(reportCode) ?? [];
        const parseAvg = parses.length
          ? Math.round((parses.reduce((sum, v) => sum + v, 0) / parses.length) * 10) / 10
          : null;
        const report = reportByCode.get(reportCode);
        const closedAt = rows.reduce(
          (max, r) => (r.closed_at > max ? r.closed_at : max),
          rows[0].closed_at,
        );
        points.push({
          reportCode,
          reportTitle: report?.title ?? null,
          closedAt,
          kill,
          bestWipePct: kill ? null : bestWipePct,
          overall: breakdown.overall,
          breakdown: breakdown.breakdown,
          parseAvg,
          sampleSize: rows.length,
        });
      }
      points.sort((a, b) => a.closedAt.localeCompare(b.closedAt));
      result.set(playerName, points);
    }
    return result;
  }
}

export interface BossDifficultyEvolutionPoint {
  reportCode: string;
  reportTitle: string | null;
  closedAt: string;
  kill: boolean;
  bestWipePct: number | null;
  overall: number;
  breakdown: { mecanica: number | null; defensiva: number | null; preparacion: number | null };
  parseAvg: number | null;
  sampleSize: number;
}
