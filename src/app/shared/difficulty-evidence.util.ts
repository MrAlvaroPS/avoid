import type { BossMechanicCandidateRow } from './models/domain';

export interface OtherDifficultyEvidence {
  difficulty: string;
  hasEvidence: boolean;
}

// §bug real reportado (2026-08-27, "es raro que en mítico no haya mecánicas
// que sí hay en normal o hc, por lo que es raro que haya algunas ocultas"):
// mismos valores que los wcl_difficulty_id reales (LFR=1, Normal=3,
// Heroic=4, Mythic=5) — ya vienen ordenados de fácil a difícil, así que
// sirven directamente como rango sin inventar una escala nueva.
const DIFFICULTY_RANK: Record<string, number> = { LFR: 1, Normal: 3, Heroic: 4, Mythic: 5 };

/** Rango de dificultad (mayor = más difícil), o 0 si no se reconoce. */
export function difficultyRank(difficulty: string): number {
  return DIFFICULTY_RANK[difficulty] ?? 0;
}

export function hasExactDifficultyEvidence(candidate: Pick<BossMechanicCandidateRow, 'observed_in_logs' | 'observed_in_reference_logs' | 'observed_as_interrupt' | 'reference_occurrences'>): boolean {
  return candidate.observed_in_logs
    || candidate.observed_in_reference_logs
    || candidate.observed_as_interrupt
    || (candidate.reference_occurrences ?? 0) > 0;
}

/**
 * Una ausencia solo contradice otra dificultad si la dificultad actual se
 * llegó a contrastar con un report público. Si esa consulta falló o nunca se
 * ejecutó, conservar la candidata como no verificada es más honesto que
 * asumir que es exclusiva.
 *
 * §bug real contrastado en real (boss 3445 "Entombed Sentinels", 2026-08-27):
 * esto excluía candidatas de Mítica solo porque Normal/Heroico sí tenían
 * evidencia y Mítica (todavía) no — al revés de cómo funciona el diseño de
 * WoW de verdad: las dificultades más duras casi nunca QUITAN mecánicas que
 * ya existían en las más fáciles, normalmente las mantienen o las
 * intensifican. Que la muestra de logs públicos de Mítica no haya disparado
 * una mecánica no prueba que sea exclusiva de Normal/Heroico — lo más
 * probable es que la muestra sea pequeña o la mecánica no deje un evento
 * fácil de contar. Al revés sí es señal real: si una dificultad FÁCIL no
 * tiene evidencia pero una MÁS DURA sí, es el patrón clásico de mecánica
 * exclusiva de dificultades altas — por eso el contraste por evidencia solo
 * cuenta cuando la otra dificultad es más difícil que esta, nunca al revés.
 * (official_difficulty_applicable===false sigue funcionando en ambas
 * direcciones — es un dato oficial de Blizzard, no una inferencia.)
 */
export function isContradictedByOtherDifficulty(
  candidate: Pick<BossMechanicCandidateRow, 'observed_in_logs' | 'observed_in_reference_logs' | 'observed_as_interrupt' | 'reference_occurrences' | 'reference_source_report' | 'official_difficulty_applicable' | 'difficulty'>,
  otherDifficulties: OtherDifficultyEvidence[],
): boolean {
  if (hasExactDifficultyEvidence(candidate)) return false;
  if (candidate.official_difficulty_applicable === false) return true;
  if (!candidate.reference_source_report) return false;
  const ownRank = difficultyRank(candidate.difficulty);
  return otherDifficulties.some((other) => other.hasEvidence && difficultyRank(other.difficulty) > ownRank);
}
