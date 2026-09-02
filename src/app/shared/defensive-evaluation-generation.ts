export interface DefensiveEvaluationGenerationFields {
  evaluatorVersion: string | null | undefined;
  resolverVersion: string | null | undefined;
  solverVersion: string | null | undefined;
  gameBuild: string | null | undefined;
  buildFingerprint: string | null | undefined;
}

export interface DefensiveEvaluationGenerationKey {
  evaluatorVersion: string;
  resolverVersion: string;
  solverVersion: string;
  gameBuild: string;
  buildFingerprint: string;
}

function requiredText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function defensiveEvaluationGenerationKey(
  fields: DefensiveEvaluationGenerationFields,
): DefensiveEvaluationGenerationKey | null {
  const evaluatorVersion = requiredText(fields.evaluatorVersion);
  const resolverVersion = requiredText(fields.resolverVersion);
  const solverVersion = requiredText(fields.solverVersion);
  const gameBuild = requiredText(fields.gameBuild);
  const buildFingerprint = requiredText(fields.buildFingerprint);
  if (!evaluatorVersion || !resolverVersion || !solverVersion || !gameBuild || !buildFingerprint) {
    return null;
  }
  return { evaluatorVersion, resolverVersion, solverVersion, gameBuild, buildFingerprint };
}

export function homogeneousDefensiveEvaluationGeneration(
  rows: readonly DefensiveEvaluationGenerationFields[],
): DefensiveEvaluationGenerationKey | null {
  if (!rows.length) return null;
  const keys = rows.map(defensiveEvaluationGenerationKey);
  if (keys.some((key) => key == null)) return null;
  const serialized = new Set(keys.map((key) => JSON.stringify(key)));
  return serialized.size === 1 ? keys[0]! : null;
}
