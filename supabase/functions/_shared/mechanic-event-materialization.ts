import {
  attributeDamageToMechanicCasts,
  ownerOccurrenceIndexForDeath,
  type AttributedMechanicOccurrence,
  type MechanicCastLike,
  type MechanicDamageAttribution,
  type MechanicDamageLike,
  type MechanicDeathLike,
} from './mechanic-event-attribution.ts';
import { resolveSeverity, type SeveritySource } from './mechanic-severity.ts';

export interface MechanicDefinition {
  name: string;
  description: string | null;
  category: string | null;
  responsibility: string | null;
  inferred_category: string | null;
  observed_as_interrupt: boolean;
  avoidable: boolean | null;
  severity_threshold: number | null;
  reference_hit_ratio_samples: number[] | null;
}

export interface MechanicDamageEventLike extends MechanicDamageLike {
  amount?: number;
  maxHitPoints?: number;
  resources?: { maxHitPoints?: number } | null;
}

export interface MechanicInterruptEventLike {
  timestamp?: number;
  sourceID?: number;
  extraAbilityGameID?: number;
}

export interface MechanicPlayerHitDetail {
  name: string;
  damage_taken: number;
  damage_hits: number;
  healing_received: number;
  used_defensive_spell_id: number | null;
  max_hit_points: number | null;
}

export interface MechanicHitAggregate {
  total: number;
  hits: number;
  maxHitPoints: number | null;
}

export type MechanicHitTargets = Map<number, MechanicHitAggregate>;

export interface MaterializedMechanicEventRow {
  ability_id: number;
  mechanic_name: string;
  description: string | null;
  category: string | null;
  responsibility: string | null;
  trigger_time_ms: number;
  outcome: 'clean' | 'partial_fail' | 'fail';
  players_hit: number;
  players_hit_names: string[];
  avoidable: boolean | null;
  player_hit_details: MechanicPlayerHitDetail[];
  phase_id: number | null;
  comparison_source: SeveritySource | null;
  comparison_percentile: number | null;
}

export interface BuildMechanicEventRowsInput<
  C extends MechanicCastLike,
  D extends MechanicDamageEventLike,
  X extends MechanicDeathLike,
  I extends MechanicInterruptEventLike,
> {
  /** abilityGameID REAL de WCL -> definición curada. Puede contener aliases por nombre. */
  mechanicByAbilityId: ReadonlyMap<number, MechanicDefinition>;
  enemyCastEvents: readonly C[];
  damageEvents: readonly D[];
  deathEvents: readonly X[];
  interruptEvents: readonly I[];
  raidSize: number;
  ownHistoryRatiosByAbilityId: ReadonlyMap<number, readonly number[]>;
  reactionWindowMs: number;
  fightStartTime: number;
  resolvePlayerName: (actorId: number) => string | null | undefined;
  buildPlayerHitDetails: (
    hitTargets: MechanicHitTargets,
    t0: number,
    windowEnd: number,
  ) => MechanicPlayerHitDetail[];
  resolvePhaseId: (timestampAbsolute: number) => number | null;
  instanceGapMs?: number;
  maxInstanceMs?: number;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function effectiveMechanicCategory(
  mechanic: MechanicDefinition,
  observedInCurrentReport = false,
): string | null {
  const category = mechanic.category ?? mechanic.inferred_category;
  if (category === 'interrupt' && !mechanic.observed_as_interrupt && !observedInCurrentReport) return null;
  return category;
}

function aggregateHitTargets<D extends MechanicDamageEventLike>(events: readonly D[]): MechanicHitTargets {
  const hitTargets: MechanicHitTargets = new Map();
  for (const event of events) {
    if (!finiteNumber(event.targetID)) continue;
    const current = hitTargets.get(event.targetID) ?? { total: 0, hits: 0, maxHitPoints: null };
    current.total += finiteNumber(event.amount) ? event.amount : 0;
    current.hits += 1;
    const observedMaxHitPoints = event.maxHitPoints ?? event.resources?.maxHitPoints;
    if (finiteNumber(observedMaxHitPoints) && observedMaxHitPoints > 0) {
      current.maxHitPoints = Math.max(current.maxHitPoints ?? 0, observedMaxHitPoints);
    }
    hitTargets.set(event.targetID, current);
  }
  return hitTargets;
}

/**
 * Un Interrupts crudo también debe tener un único cast propietario. El bug
 * original se descubrió con DamageTaken, pero reutilizar el mismo kick en
 * varias ventanas solapadas produciría exactamente la misma clase de falso
 * positivo (varios casts "clean" por un único interrupt real).
 */
function interruptOwnerByOccurrence<
  C extends MechanicCastLike,
  D extends MechanicDamageLike,
  I extends MechanicInterruptEventLike,
>(
  occurrences: readonly AttributedMechanicOccurrence<C, D>[],
  interruptEvents: readonly I[],
  abilityId: number,
  reactionWindowMs: number,
): Map<number, I> {
  const owner = new Map<number, I>();
  for (const event of interruptEvents) {
    if (event.extraAbilityGameID !== abilityId || !finiteNumber(event.timestamp)) continue;
    const candidates = occurrences.filter(
      (occurrence) =>
        event.timestamp! >= occurrence.timestamp &&
        event.timestamp! <= occurrence.timestamp + reactionWindowMs,
    );
    if (!candidates.length) continue;
    const chosen = [...candidates].sort(
      (a, b) => b.timestamp - a.timestamp || b.occurrenceIndex - a.occurrenceIndex,
    )[0];
    const existing = owner.get(chosen.occurrenceIndex);
    if (!existing || (existing.timestamp ?? Infinity) > event.timestamp) {
      owner.set(chosen.occurrenceIndex, event);
    }
  }
  return owner;
}

/**
 * Las instancias damage-only no tienen casts a los que heredar ownership.
 * Aun así una muerte solo puede pertenecer a UNA: se elige el hit terminal
 * más reciente del mismo target, evitando que dos clusters separados por
 * 3-4s marquen ambos `fail` por una sola muerte.
 */
function fallbackDeathOwnerIndexes<D extends MechanicDamageEventLike, X extends MechanicDeathLike>(
  instances: readonly (readonly D[])[],
  deathEvents: readonly X[],
  abilityId: number,
  reactionWindowMs: number,
): Set<number> {
  const owners = new Set<number>();
  for (const death of deathEvents) {
    if (
      death.killingAbilityGameID !== abilityId ||
      !finiteNumber(death.timestamp) ||
      !finiteNumber(death.targetID)
    ) {
      continue;
    }
    const candidates: { instanceIndex: number; hitTimestamp: number }[] = [];
    instances.forEach((instance, instanceIndex) => {
      for (const hit of instance) {
        if (!finiteNumber(hit.timestamp) || hit.targetID !== death.targetID) continue;
        if (hit.timestamp > death.timestamp! || death.timestamp! - hit.timestamp > reactionWindowMs) continue;
        candidates.push({ instanceIndex, hitTimestamp: hit.timestamp });
      }
    });
    if (!candidates.length) continue;
    const chosen = candidates.sort(
      (a, b) => b.hitTimestamp - a.hitTimestamp || b.instanceIndex - a.instanceIndex,
    )[0];
    owners.add(chosen.instanceIndex);
  }
  return owners;
}

/**
 * Autoridad única para materializar `pull_mechanic_events` tanto al ingerir
 * un fight nuevo como al reanalizar un pull histórico.
 *
 * Contratos de integridad:
 * - un DamageTaken crudo pertenece como máximo a una occurrence;
 * - un Interrupts crudo limpia como máximo un cast;
 * - una muerte marca como máximo una occurrence/cluster por ability;
 * - daño que no cabe en ninguna ventana de cast NO se pierde: pasa al
 *   clustering damage-only aunque la misma ability sí tenga otros casts;
 * - dos hits reales idénticos no se deduplican por amount/timestamp.
 */
export function buildMechanicEventRows<
  C extends MechanicCastLike,
  D extends MechanicDamageEventLike,
  X extends MechanicDeathLike,
  I extends MechanicInterruptEventLike,
>(input: BuildMechanicEventRowsInput<C, D, X, I>): MaterializedMechanicEventRow[] {
  if (!Number.isFinite(input.reactionWindowMs) || input.reactionWindowMs < 0) {
    throw new Error('reactionWindowMs debe ser un número finito >= 0');
  }
  const raidSize = Math.max(1, Math.trunc(input.raidSize || 0));
  const instanceGapMs = input.instanceGapMs ?? 3_000;
  const maxInstanceMs = input.maxInstanceMs ?? 20_000;
  const rows: MaterializedMechanicEventRow[] = [];

  const castAttributionByAbilityId = new Map<number, MechanicDamageAttribution<C, D>>();
  const mechanicCastAbilityIds = new Set(
    input.enemyCastEvents
      .map((cast) => cast.abilityGameID)
      .filter(
        (abilityId): abilityId is number =>
          finiteNumber(abilityId) && input.mechanicByAbilityId.has(abilityId),
      ),
  );

  for (const abilityId of mechanicCastAbilityIds) {
    castAttributionByAbilityId.set(
      abilityId,
      attributeDamageToMechanicCasts(
        input.enemyCastEvents,
        input.damageEvents,
        [abilityId],
        input.reactionWindowMs,
      ),
    );
  }

  for (const [abilityId, attribution] of castAttributionByAbilityId) {
    const mechanic = input.mechanicByAbilityId.get(abilityId);
    if (!mechanic) continue;

    const observedInterrupt = input.interruptEvents.some(
      (event) => event.extraAbilityGameID === abilityId,
    );
    const effectiveCategory = effectiveMechanicCategory(mechanic, observedInterrupt);
    const interruptOwners =
      effectiveCategory === 'interrupt'
        ? interruptOwnerByOccurrence(
            attribution.occurrences,
            input.interruptEvents,
            abilityId,
            input.reactionWindowMs,
          )
        : new Map<number, I>();

    const deathOwnerIndexes = new Set<number>();
    if (effectiveCategory !== 'interrupt') {
      for (const death of input.deathEvents) {
        if (death.killingAbilityGameID !== abilityId) continue;
        const owner = ownerOccurrenceIndexForDeath(
          death,
          attribution.occurrences,
          input.reactionWindowMs,
        );
        if (owner != null) deathOwnerIndexes.add(owner);
      }
    }

    for (const occurrence of attribution.occurrences) {
      const t0 = occurrence.timestamp;
      const windowEnd = t0 + input.reactionWindowMs;

      if (effectiveCategory === 'interrupt') {
        const interrupter = interruptOwners.get(occurrence.occurrenceIndex);
        const interrupterName = finiteNumber(interrupter?.sourceID)
          ? input.resolvePlayerName(interrupter!.sourceID!) ?? undefined
          : undefined;
        rows.push({
          ability_id: abilityId,
          mechanic_name: mechanic.name,
          description: mechanic.description,
          category: effectiveCategory,
          responsibility: mechanic.responsibility,
          trigger_time_ms: t0 - input.fightStartTime,
          phase_id: input.resolvePhaseId(t0),
          outcome: interrupter ? 'clean' : 'fail',
          players_hit: interrupter ? 1 : 0,
          players_hit_names: interrupterName ? [interrupterName] : [],
          avoidable: mechanic.avoidable,
          player_hit_details: [],
          comparison_source: null,
          comparison_percentile: null,
        });
        continue;
      }

      const hitTargets = aggregateHitTargets(occurrence.damageEvents);
      const ratio = hitTargets.size / raidSize;
      const severity = resolveSeverity({
        ratio,
        fixedThreshold: mechanic.severity_threshold ?? 0.35,
        ownHistoryRatios: [...(input.ownHistoryRatiosByAbilityId.get(abilityId) ?? [])],
        referenceRatiosSorted: mechanic.reference_hit_ratio_samples
          ? [...mechanic.reference_hit_ratio_samples]
          : null,
      });
      const outcome: 'clean' | 'partial_fail' | 'fail' = deathOwnerIndexes.has(
        occurrence.occurrenceIndex,
      )
        ? 'fail'
        : mechanic.avoidable && severity.isSevere
          ? 'partial_fail'
          : 'clean';
      const hitNames = [...hitTargets.keys()]
        .map((id) => input.resolvePlayerName(id))
        .filter((name): name is string => typeof name === 'string' && name.length > 0);

      rows.push({
        ability_id: abilityId,
        mechanic_name: mechanic.name,
        description: mechanic.description,
        category: effectiveCategory,
        responsibility: mechanic.responsibility,
        trigger_time_ms: t0 - input.fightStartTime,
        phase_id: input.resolvePhaseId(t0),
        outcome,
        players_hit: hitTargets.size,
        players_hit_names: hitNames,
        avoidable: mechanic.avoidable,
        player_hit_details: input.buildPlayerHitDetails(hitTargets, t0, windowEnd),
        comparison_source: severity.source,
        comparison_percentile: severity.percentile,
      });
    }
  }

  for (const [abilityId, mechanic] of input.mechanicByAbilityId) {
    const effectiveCategory = effectiveMechanicCategory(mechanic);
    if (effectiveCategory === 'interrupt') continue;

    const attribution = castAttributionByAbilityId.get(abilityId);
    const events = (
      attribution
        ? [...attribution.unassignedDamageEvents]
        : input.damageEvents.filter((event) => event.abilityGameID === abilityId)
    )
      .filter((event) => finiteNumber(event.targetID) && finiteNumber(event.timestamp))
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    if (!events.length) continue;

    const instances: D[][] = [];
    for (const event of events) {
      const last = instances.at(-1);
      const withinGap =
        last != null &&
        event.timestamp! - last.at(-1)!.timestamp! <= instanceGapMs;
      const withinMaxSpan =
        last != null && event.timestamp! - last[0].timestamp! <= maxInstanceMs;
      if (last && withinGap && withinMaxSpan) last.push(event);
      else instances.push([event]);
    }

    const deathOwnerIndexes = fallbackDeathOwnerIndexes(
      instances,
      input.deathEvents,
      abilityId,
      input.reactionWindowMs,
    );

    instances.forEach((instance, instanceIndex) => {
      const t0 = instance[0].timestamp!;
      const windowEnd = instance.at(-1)!.timestamp!;
      const hitTargets = aggregateHitTargets(instance);
      const ratio = hitTargets.size / raidSize;
      const severity = resolveSeverity({
        ratio,
        fixedThreshold: mechanic.severity_threshold ?? 0.35,
        ownHistoryRatios: [...(input.ownHistoryRatiosByAbilityId.get(abilityId) ?? [])],
        referenceRatiosSorted: mechanic.reference_hit_ratio_samples
          ? [...mechanic.reference_hit_ratio_samples]
          : null,
      });
      const outcome: 'clean' | 'partial_fail' | 'fail' = deathOwnerIndexes.has(instanceIndex)
        ? 'fail'
        : mechanic.avoidable && severity.isSevere
          ? 'partial_fail'
          : 'clean';
      const hitNames = [...hitTargets.keys()]
        .map((id) => input.resolvePlayerName(id))
        .filter((name): name is string => typeof name === 'string' && name.length > 0);

      rows.push({
        ability_id: abilityId,
        mechanic_name: mechanic.name,
        description: mechanic.description,
        category: effectiveCategory,
        responsibility: mechanic.responsibility,
        trigger_time_ms: t0 - input.fightStartTime,
        phase_id: input.resolvePhaseId(t0),
        outcome,
        players_hit: hitTargets.size,
        players_hit_names: hitNames,
        avoidable: mechanic.avoidable,
        player_hit_details: input.buildPlayerHitDetails(hitTargets, t0, windowEnd),
        comparison_source: severity.source,
        comparison_percentile: severity.percentile,
      });
    });
  }

  return rows.sort(
    (a, b) => a.trigger_time_ms - b.trigger_time_ms || a.ability_id - b.ability_id,
  );
}
