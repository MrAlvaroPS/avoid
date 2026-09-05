export interface MechanicPolicyIdentityCandidate {
  difficulty: string;
  mechanic_key: string | null;
}

export interface SkippedMechanicPolicyDifficulty {
  difficulty: string;
  totalCandidates: number;
  missingIdentities: number;
}

/**
 * Un prompt causal solo puede prometer una dificultad si todas sus filas
 * aplicables tienen identidad. Una dificultad incompleta se informa y se
 * omite completa, pero no impide trabajar con las demás.
 */
export function partitionReadyMechanicPolicyDifficulties<
  T extends MechanicPolicyIdentityCandidate,
>(candidates: T[]): {
  readyCandidates: T[];
  skippedDifficulties: SkippedMechanicPolicyDifficulty[];
} {
  const byDifficulty = new Map<string, T[]>();
  for (const candidate of candidates) {
    const group = byDifficulty.get(candidate.difficulty) ?? [];
    group.push(candidate);
    byDifficulty.set(candidate.difficulty, group);
  }

  const readyCandidates: T[] = [];
  const skippedDifficulties: SkippedMechanicPolicyDifficulty[] = [];
  for (const [difficulty, group] of byDifficulty) {
    const missingIdentities = group.filter((candidate) => !candidate.mechanic_key?.trim()).length;
    if (missingIdentities > 0) {
      skippedDifficulties.push({
        difficulty,
        totalCandidates: group.length,
        missingIdentities,
      });
      continue;
    }
    readyCandidates.push(...group);
  }

  return { readyCandidates, skippedDifficulties };
}
