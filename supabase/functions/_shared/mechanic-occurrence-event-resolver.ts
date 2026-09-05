// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import type {
  EvaluationConfidence,
  MechanicPolicyContract,
  OccurrenceOutcome,
  PullEvaluationContextContract,
} from './combat-evaluation-contract.ts';
// @ts-ignore Angular's test compiler rejects explicit .ts extensions; Deno requires them at runtime.
import { isEventEvaluable } from './combat-evaluation-contract.ts';

/**
 * First real occurrence resolver. v1 was intentionally a placeholder that
 * materialised one not_evaluable row per policy. v2 is backed by the already
 * persisted WCL-derived pull_mechanic_events facts and is still SHADOW ONLY.
 */
export const EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION =
  'mechanic-occurrence-resolver@2.0.0' as const;

/** Same evidence window used by analyze-report to build player_hit_details. */
export const MECHANIC_EVENT_REACTION_WINDOW_MS = 4_000;

export interface EventBackedMechanicEvent {
  id: string;
  pullId: string;
  abilityId: number;
  mechanicName: string;
  mechanicKey?: string | null;
  category: string | null;
  responsibility: string | null;
  triggerTimeMs: number;
  outcome: 'clean' | 'partial_fail' | 'fail';
  playersHitNames: string[];
  playerHitDetails: Array<Record<string, unknown>>;
  comparisonSource?: string | null;
  comparisonPercentile?: number | null;
  phaseId?: number | null;
}

export interface MechanicAliasForOccurrence {
  abilityId: number;
  mechanicKey: string;
  confidence: EvaluationConfidence;
}

export interface EventBackedOccurrenceSeed {
  pullId: string;
  bossId: string;
  difficulty: string;
  mechanicKey: string;
  occurrenceIndex: number;
  startMs: number;
  resolveMs: number;
  endMs: number;
  phaseId: string | null;
  targetActorIds: number[];
  outcome: OccurrenceOutcome;
  failureMode: string | null;
  evidence: Record<string, unknown>;
  confidence: EvaluationConfidence;
  policyVersion: number;
  contextResolverVersion: string;
  occurrenceResolverVersion: typeof EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION;
}

export interface EventBackedOccurrenceResolution {
  occurrences: EventBackedOccurrenceSeed[];
  sourceEventCount: number;
  mappedEventCount: number;
  outOfScopeEventIds: string[];
  unmappedEventIds: string[];
  missingPolicyEventIds: string[];
}

function occurrenceOutcome(outcome: EventBackedMechanicEvent['outcome']): OccurrenceOutcome {
  if (outcome === 'clean') return 'success';
  return outcome;
}

function failureMode(outcome: EventBackedMechanicEvent['outcome']): string | null {
  if (outcome === 'fail') return 'observed_event_fail';
  if (outcome === 'partial_fail') return 'observed_event_partial_fail';
  return null;
}

function trustedIdentityConfidence(
  aliasConfidence: EvaluationConfidence | null,
  policyConfidence: EvaluationConfidence,
): EvaluationConfidence {
  // The source event outcome is still derived by analyze-report. Even when the
  // alias/policy are verified, v2 deliberately caps occurrence confidence at
  // inferred until each mechanic family has a dedicated causal evaluator.
  if (
    aliasConfidence === 'uncertain' ||
    aliasConfidence === 'fallback' ||
    policyConfidence === 'uncertain' ||
    policyConfidence === 'fallback'
  ) {
    return 'uncertain';
  }
  return 'inferred';
}

function validNameList(value: string[] | null | undefined): string[] {
  return [...new Set((value ?? []).filter((name) => typeof name === 'string' && name.trim().length > 0))];
}

/**
 * Turns real pull mechanic events into stable, versioned occurrence seeds.
 *
 * Important boundaries:
 * - it does NOT decide who is guilty;
 * - it does NOT infer missing mechanic identity;
 * - unmapped identity/policy is reported, never silently converted to a
 *   different mechanic;
 * - events outside canonical PullEvaluationContext are excluded.
 */
export function resolveEventBackedMechanicOccurrences(input: {
  pullId: string;
  bossId: string;
  difficulty: string;
  context: PullEvaluationContextContract;
  events: EventBackedMechanicEvent[];
  aliases: MechanicAliasForOccurrence[];
  policies: MechanicPolicyContract[];
}): EventBackedOccurrenceResolution {
  const aliasByAbility = new Map<number, MechanicAliasForOccurrence>();
  for (const alias of input.aliases) {
    if (!Number.isInteger(alias.abilityId) || alias.abilityId <= 0) continue;
    const existing = aliasByAbility.get(alias.abilityId);
    if (!existing) aliasByAbility.set(alias.abilityId, alias);
  }

  const policyByKey = new Map(input.policies.map((policy) => [policy.mechanicKey, policy]));
  const outOfScopeEventIds: string[] = [];
  const unmappedEventIds: string[] = [];
  const missingPolicyEventIds: string[] = [];

  const mapped = input.events
    .filter((event) => {
      const evaluable = isEventEvaluable(input.context, event.triggerTimeMs);
      if (!evaluable) outOfScopeEventIds.push(event.id);
      return evaluable;
    })
    .map((event) => {
      const directKey = event.mechanicKey?.trim() || null;
      const alias = directKey ? null : aliasByAbility.get(event.abilityId) ?? null;
      const mechanicKey = directKey ?? alias?.mechanicKey ?? null;
      if (!mechanicKey) {
        unmappedEventIds.push(event.id);
        return null;
      }
      const policy = policyByKey.get(mechanicKey) ?? null;
      if (!policy) {
        missingPolicyEventIds.push(event.id);
        return null;
      }
      return { event, mechanicKey, alias, policy };
    })
    .filter(
      (row): row is {
        event: EventBackedMechanicEvent;
        mechanicKey: string;
        alias: MechanicAliasForOccurrence | null;
        policy: MechanicPolicyContract;
      } => row != null,
    )
    .sort(
      (a, b) =>
        a.event.triggerTimeMs - b.event.triggerTimeMs ||
        a.mechanicKey.localeCompare(b.mechanicKey) ||
        a.event.id.localeCompare(b.event.id),
    );

  const indexByMechanic = new Map<string, number>();
  const occurrences: EventBackedOccurrenceSeed[] = [];

  for (const row of mapped) {
    const occurrenceIndex = (indexByMechanic.get(row.mechanicKey) ?? 0) + 1;
    indexByMechanic.set(row.mechanicKey, occurrenceIndex);

    const resolveMs = row.event.triggerTimeMs;
    const endMs = Math.max(
      resolveMs,
      Math.min(input.context.evaluationEndMs, resolveMs + MECHANIC_EVENT_REACTION_WINDOW_MS),
    );

    occurrences.push({
      pullId: input.pullId,
      bossId: input.bossId,
      difficulty: input.difficulty,
      mechanicKey: row.mechanicKey,
      occurrenceIndex,
      startMs: resolveMs,
      resolveMs,
      endMs,
      phaseId: row.event.phaseId == null ? null : String(row.event.phaseId),
      targetActorIds: [],
      outcome: occurrenceOutcome(row.event.outcome),
      failureMode: failureMode(row.event.outcome),
      evidence: {
        source: 'pull_mechanic_events',
        source_event_id: row.event.id,
        ability_id: row.event.abilityId,
        mechanic_name: row.event.mechanicName,
        category: row.event.category,
        responsibility: row.event.responsibility,
        players_hit_names: validNameList(row.event.playersHitNames),
        player_hit_details: row.event.playerHitDetails ?? [],
        comparison_source: row.event.comparisonSource ?? null,
        comparison_percentile: row.event.comparisonPercentile ?? null,
        phase_id: row.event.phaseId ?? null,
        reaction_window_ms: MECHANIC_EVENT_REACTION_WINDOW_MS,
        identity_source: row.event.mechanicKey ? 'event_mechanic_key' : 'active_alias',
        identity_alias_confidence: row.alias?.confidence ?? null,
      },
      confidence: trustedIdentityConfidence(row.alias?.confidence ?? null, row.policy.confidence),
      policyVersion: row.policy.policyVersion,
      contextResolverVersion: input.context.resolverVersion,
      occurrenceResolverVersion: EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION,
    });
  }

  return {
    occurrences,
    sourceEventCount: input.events.length,
    mappedEventCount: occurrences.length,
    outOfScopeEventIds,
    unmappedEventIds,
    missingPolicyEventIds,
  };
}
