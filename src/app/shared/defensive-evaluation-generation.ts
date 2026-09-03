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

export interface HomogeneousGenerationOptions {
  /** §"es normal que una persona cambie de talentos según el boss al que se
   * enfrenta" (feedback real, 2026-09-03): un respec entre pulls cambia
   * buildFingerprint (hash de talentos) sin que evaluator/resolver/solver/
   * build dejen de ser exactamente los mismos — la lógica de evaluación de
   * cada pull individual sigue siendo correcta, solo cambian los valores de
   * CD resueltos para ESE pull. Por defecto sigue exigiendo fingerprint
   * único (Fiabilidad no cambia su gate); solo quien pase `false`
   * explícitamente acepta una noche con varios builds. */
  requireBuildFingerprint?: boolean;
}

export function homogeneousDefensiveEvaluationGeneration(
  rows: readonly DefensiveEvaluationGenerationFields[],
  options: HomogeneousGenerationOptions = {},
): DefensiveEvaluationGenerationKey | null {
  if (!rows.length) return null;
  const keys = rows.map(defensiveEvaluationGenerationKey);
  if (keys.some((key) => key == null)) return null;
  const resolvedKeys = keys as DefensiveEvaluationGenerationKey[];

  if (options.requireBuildFingerprint ?? true) {
    const serialized = new Set(resolvedKeys.map((key) => JSON.stringify(key)));
    return serialized.size === 1 ? resolvedKeys[0] : null;
  }

  // Misma comprobación, pero sin exigir que buildFingerprint coincida: el
  // resto de la generación (lo que de verdad determina si la lógica de
  // evaluación es comparable) sigue teniendo que ser idéntico en todas las
  // filas. Si hubo más de un fingerprint real, se devuelve 'mixed' en vez de
  // fingir que uno solo representa a toda la noche.
  const withoutFingerprint = new Set(
    resolvedKeys.map((key) => JSON.stringify({ ...key, buildFingerprint: undefined })),
  );
  if (withoutFingerprint.size !== 1) return null;
  const distinctFingerprints = new Set(resolvedKeys.map((key) => key.buildFingerprint));
  return {
    ...resolvedKeys[0],
    buildFingerprint: distinctFingerprints.size === 1 ? resolvedKeys[0].buildFingerprint : 'mixed',
  };
}
