// Resuelve, para un boss+dificultad WCL concreto, qué dificultad de la tabla
// DB2 de Blizzard le corresponde, y con eso, qué mecánicas (secciones del
// Journal) aplican realmente a esa dificultad. Adaptado de
// server/knowledge/official-encounter-difficulty-v1.mjs del repo original,
// sin el envoltorio de "evidenceContract"/fingerprints (aquí no aporta nada,
// solo ruido) pero conservando el algoritmo de scoring, que es la parte que
// de verdad cuesta acertar.

import type { JournalDifficultySnapshot } from './wago-db2-client.ts';
import type { FlattenedJournalAbility } from './blizzard-client.ts';

const normalizeName = (v: string) =>
  v.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const canonicalName = (v: string) => {
  const t = normalizeName(v);
  // La tabla Difficulty de Blizzard nombra LFR "Looking For Raid" (verificado en real,
  // build 12.1.0.68914) — no "Raid Finder", que es el único alias que reconocía el
  // algoritmo original y por el que LFR habría quedado siempre sin mapear.
  if (t === 'lfr' || t === 'raid finder' || t === 'looking for raid' || /\b(raid finder|looking for raid)\b/.test(t)) return 'lfr';
  if (t === 'mythic' || t === 'heroic' || t === 'normal') return t;
  return t;
};

export type DifficultyMappingStatus =
  | 'mapped-by-journal-encounter-restriction'
  | 'mapped-by-boss-section-restriction'
  | 'mapped-by-name-and-raid-size'
  | 'mapped-by-unique-name'
  | 'difficulty-mapping-unresolved'
  | 'difficulty-mapping-ambiguous'
  | 'difficulty-metadata-unavailable';

export interface DifficultyMappingResult {
  status: DifficultyMappingStatus;
  db2DifficultyId: number | null;
  db2DifficultyName: string | null;
}

function candidateScore(
  row: { difficultyId: number; minPlayers: number | null; maxPlayers: number | null },
  opts: { exactName: boolean; encounterRestrictions: Set<number>; sectionRestrictionIds: Set<number>; sizes: number[] },
): number {
  let score = opts.exactName ? 100 : 50;
  if (opts.encounterRestrictions.has(row.difficultyId)) score += 80;
  if (opts.sectionRestrictionIds.has(row.difficultyId)) score += 50;
  const { minPlayers: min, maxPlayers: max } = row;
  if (opts.sizes.length && min && max) {
    const overlaps = opts.sizes.some((size) => size >= min && size <= max);
    score += overlaps ? 60 : -80;
    if (min === max && opts.sizes.includes(min)) score += 20;
  }
  if (opts.sizes.some((size) => size > 5) && max) score += max > 5 ? 25 : -100;
  return score;
}

/** WCL difficultyId -> db2 difficultyId, usando nombre + tamaño de raid + restricciones de encounter/sección como desempate. */
export function resolveDb2Difficulty(
  snapshot: JournalDifficultySnapshot | null,
  journalEncounterId: number,
  wclDifficulty: { name: string; sizes: number[] },
  abilities: FlattenedJournalAbility[],
): DifficultyMappingResult {
  if (!snapshot) return { status: 'difficulty-metadata-unavailable', db2DifficultyId: null, db2DifficultyName: null };

  const wantedExact = normalizeName(wclDifficulty.name);
  const wantedCanonical = canonicalName(wclDifficulty.name);
  const all = snapshot.difficulties;
  const exact = all.filter((row) => normalizeName(row.name) === wantedExact);
  const pool = exact.length ? exact : all.filter((row) => canonicalName(row.name) === wantedCanonical);
  if (!pool.length) return { status: 'difficulty-mapping-unresolved', db2DifficultyId: null, db2DifficultyName: null };

  const encounterRestrictions = snapshot.encounterDifficultyIds.get(journalEncounterId) ?? new Set<number>();
  const sectionIds = new Set(abilities.flatMap((a) => a.sectionIds));
  const sectionRestrictionIds = new Set<number>();
  for (const sectionId of sectionIds) {
    const ids = snapshot.sectionDifficultyIds.get(sectionId);
    if (ids) for (const id of ids) sectionRestrictionIds.add(id);
  }

  const scored = pool
    .map((row) => ({
      ...row,
      score: candidateScore(row, { exactName: exact.includes(row), encounterRestrictions, sectionRestrictionIds, sizes: wclDifficulty.sizes }),
    }))
    .sort((a, b) => b.score - a.score || a.difficultyId - b.difficultyId);

  const best = scored[0];
  const tied = scored.filter((row) => row.score === best.score);
  if (tied.length !== 1) return { status: 'difficulty-mapping-ambiguous', db2DifficultyId: null, db2DifficultyName: null };

  const status: DifficultyMappingStatus = encounterRestrictions.has(best.difficultyId)
    ? 'mapped-by-journal-encounter-restriction'
    : sectionRestrictionIds.has(best.difficultyId)
      ? 'mapped-by-boss-section-restriction'
      : wclDifficulty.sizes.length
        ? 'mapped-by-name-and-raid-size'
        : 'mapped-by-unique-name';
  return { status, db2DifficultyId: best.difficultyId, db2DifficultyName: best.name };
}

/**
 * Filtra las habilidades del Journal a las que de verdad aplican a esta dificultad.
 * Si la sección de una habilidad tiene restricciones DB2 explícitas y el db2DifficultyId
 * resuelto NO está entre ellas, la habilidad se excluye para esa dificultad.
 * Si no hay restricción explícita (mecánica compartida entre dificultades) o el mapeo
 * de dificultad no se pudo resolver, se incluye por defecto (mejor un falso positivo
 * ocasional que perder una mecánica real).
 */
export function filterAbilitiesForDifficulty(
  abilities: FlattenedJournalAbility[],
  snapshot: JournalDifficultySnapshot | null,
  mapping: DifficultyMappingResult,
): FlattenedJournalAbility[] {
  if (!snapshot || mapping.db2DifficultyId == null) return abilities;
  return abilities.filter((ability) => {
    const restrictionSets = ability.sectionIds.map((id) => snapshot.sectionDifficultyIds.get(id)).filter((s): s is Set<number> => !!s);
    if (!restrictionSets.length) return true; // sin restricción explícita -> se asume compartida
    // Intersección: solo excluimos si TODAS las secciones que mencionan esta habilidad coinciden en excluir la dificultad.
    return restrictionSets.some((set) => set.has(mapping.db2DifficultyId!));
  });
}
