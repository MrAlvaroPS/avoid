// Colocar en: src/app/shared/models/mappers.ts
// Supabase devuelve las columnas tal cual están en Postgres (snake_case).
// Este es el único punto donde se traduce a los tipos camelCase del
// contrato — así el resto de la app nunca toca snake_case directamente.
import { Encounter, Pull } from './domain';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapEncounter(row: any): Encounter {
  return {
    id: row.id,
    wclEncounterId: row.wcl_encounter_id,
    name: row.name,
    raidZone: row.raid_zone,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapPull(row: any): Pull {
  return {
    id: row.id,
    raidNightId: row.raid_night_id,
    encounterId: row.encounter_id,
    pullNumber: row.pull_number,
    difficulty: row.difficulty,
    isKill: row.is_kill,
    pullDurationMs: row.pull_duration_ms,
    bossHpPctFinal: row.boss_hp_pct_final,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    analysisState: row.analysis_state,
    encounter: row.encounter ? mapEncounter(row.encounter) : undefined,
  };
}
