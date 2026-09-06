export interface ReplayPlayerHitDetail {
  name: string;
  damage_taken: number;
  damage_hits: number;
}

export interface ReplayMechanicEventRow {
  ability_id: number;
  mechanic_name: string;
  trigger_time_ms: number;
  player_hit_details?: ReplayPlayerHitDetail[] | null;
}

interface DamageClaimSummary {
  abilityId: number;
  mechanicName: string;
  playerName: string;
  materializedDamage: number;
  damageHits: number;
  occurrencesWithClaim: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function damageClaims(rows: readonly ReplayMechanicEventRow[]): Map<string, DamageClaimSummary> {
  const out = new Map<string, DamageClaimSummary>();
  for (const row of rows) {
    for (const detail of row.player_hit_details ?? []) {
      if (!detail?.name) continue;
      const key = `${row.ability_id}\u0000${detail.name}`;
      const current = out.get(key) ?? {
        abilityId: row.ability_id,
        mechanicName: row.mechanic_name,
        playerName: detail.name,
        materializedDamage: 0,
        damageHits: 0,
        occurrencesWithClaim: 0,
      };
      current.materializedDamage += finite(detail.damage_taken) ? detail.damage_taken : 0;
      current.damageHits += finite(detail.damage_hits) ? detail.damage_hits : 0;
      current.occurrencesWithClaim += 1;
      out.set(key, current);
    }
  }
  return out;
}

function duplicateOccurrenceKeys(rows: readonly ReplayMechanicEventRow[]) {
  const counts = new Map<string, { abilityId: number; mechanicName: string; triggerTimeMs: number; count: number }>();
  for (const row of rows) {
    const key = `${row.ability_id}\u0000${row.trigger_time_ms}`;
    const current = counts.get(key) ?? {
      abilityId: row.ability_id,
      mechanicName: row.mechanic_name,
      triggerTimeMs: row.trigger_time_ms,
      count: 0,
    };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()]
    .filter((entry) => entry.count > 1)
    .sort((a, b) => a.triggerTimeMs - b.triggerTimeMs || a.abilityId - b.abilityId);
}

function totalMaterializedDamage(rows: readonly ReplayMechanicEventRow[]): number {
  return rows.reduce(
    (sum, row) =>
      sum +
      (row.player_hit_details ?? []).reduce(
        (detailSum, detail) => detailSum + (finite(detail?.damage_taken) ? detail.damage_taken : 0),
        0,
      ),
    0,
  );
}

export function summarizeMechanicEventReplay(
  beforeRows: readonly ReplayMechanicEventRow[],
  afterRows: readonly ReplayMechanicEventRow[],
) {
  const beforeClaims = damageClaims(beforeRows);
  const afterClaims = damageClaims(afterRows);
  const keys = new Set([...beforeClaims.keys(), ...afterClaims.keys()]);

  const playerDamageDeltas = [...keys]
    .map((key) => {
      const before = beforeClaims.get(key);
      const after = afterClaims.get(key);
      return {
        abilityId: before?.abilityId ?? after!.abilityId,
        mechanicName: before?.mechanicName ?? after!.mechanicName,
        playerName: before?.playerName ?? after!.playerName,
        beforeDamage: before?.materializedDamage ?? 0,
        afterDamage: after?.materializedDamage ?? 0,
        beforeDamageHits: before?.damageHits ?? 0,
        afterDamageHits: after?.damageHits ?? 0,
        beforeOccurrencesWithClaim: before?.occurrencesWithClaim ?? 0,
        afterOccurrencesWithClaim: after?.occurrencesWithClaim ?? 0,
      };
    })
    .filter(
      (entry) =>
        entry.beforeDamage !== entry.afterDamage ||
        entry.beforeDamageHits !== entry.afterDamageHits ||
        entry.beforeOccurrencesWithClaim !== entry.afterOccurrencesWithClaim,
    )
    .sort(
      (a, b) =>
        Math.abs(b.beforeDamage - b.afterDamage) - Math.abs(a.beforeDamage - a.afterDamage) ||
        a.abilityId - b.abilityId ||
        a.playerName.localeCompare(b.playerName),
    );

  return {
    beforeRowCount: beforeRows.length,
    afterRowCount: afterRows.length,
    beforeMaterializedDamage: totalMaterializedDamage(beforeRows),
    afterMaterializedDamage: totalMaterializedDamage(afterRows),
    duplicateOccurrenceKeysBefore: duplicateOccurrenceKeys(beforeRows),
    duplicateOccurrenceKeysAfter: duplicateOccurrenceKeys(afterRows),
    changedPlayerClaims: playerDamageDeltas.length,
    playerDamageDeltas,
  };
}
