export interface MechanicPolicySubmissionBatch {
  difficulty: string;
  entries: Record<string, unknown>[];
}

export interface MechanicPolicyExpectedIdentity {
  abilityId: number;
  mechanicKey: string;
  difficulty: string;
}

export function parseMechanicPolicySubmission(
  rawResponseText: string,
  maxBatchSize: number,
  expectedIdentities?: MechanicPolicyExpectedIdentity[],
): { submittedCount: number; entries: Record<string, unknown>[]; batches: MechanicPolicySubmissionBatch[] } {
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new Error('El tamaño máximo del lote causal no es válido.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponseText);
  } catch {
    throw new Error('La respuesta pegada no es JSON válido.');
  }
  if (!Array.isArray(parsed)) throw new Error('Se esperaba un array JSON de policies.');

  const entries: Record<string, unknown>[] = [];
  const byDifficulty = new Map<string, Record<string, unknown>[]>();
  const submittedKeys = new Set<string>();
  const expectedByKey = expectedIdentities
    ? new Map(expectedIdentities.map((identity) => [`${identity.difficulty}::${identity.mechanicKey}`, identity.abilityId]))
    : null;
  for (const [index, raw] of parsed.entries()) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`La fila ${index + 1} no es un objeto JSON.`);
    }
    const entry = raw as Record<string, unknown>;
    const difficulty = typeof entry['difficulty'] === 'string' ? entry['difficulty'].trim() : '';
    if (!difficulty) throw new Error(`La fila ${index + 1} no contiene difficulty; no se puede dirigir a un worker seguro.`);
    if (difficulty === 'LFR') throw new Error('LFR está fuera del alcance causal.');
    const mechanicKey = typeof entry['mechanicKey'] === 'string' ? entry['mechanicKey'].trim() : '';
    if (!mechanicKey) throw new Error(`La fila ${index + 1} no contiene mechanicKey.`);
    if (typeof entry['abilityId'] !== 'number' || !Number.isFinite(entry['abilityId']) || entry['abilityId'] <= 0) {
      throw new Error(`La fila ${index + 1} no contiene un abilityId positivo.`);
    }
    const submittedKey = `${difficulty}::${mechanicKey}`;
    if (submittedKeys.has(submittedKey)) {
      throw new Error(`La respuesta repite ${mechanicKey} en ${difficulty}; no se ha publicado nada.`);
    }
    if (expectedByKey && expectedByKey.get(submittedKey) !== entry['abilityId']) {
      throw new Error(`La fila ${mechanicKey} [${difficulty}] no pertenece al prompt; no se ha publicado nada.`);
    }
    submittedKeys.add(submittedKey);
    entries.push(entry);
    const group = byDifficulty.get(difficulty) ?? [];
    group.push(entry);
    byDifficulty.set(difficulty, group);
  }
  if (expectedByKey) {
    const missing = [...expectedByKey.keys()].filter((key) => !submittedKeys.has(key));
    if (missing.length) {
      throw new Error(`La respuesta omite ${missing.length} policies del prompt; no se ha publicado nada.`);
    }
  }

  const batches: MechanicPolicySubmissionBatch[] = [];
  for (const [difficulty, group] of byDifficulty) {
    for (let offset = 0; offset < group.length; offset += maxBatchSize) {
      batches.push({ difficulty, entries: group.slice(offset, offset + maxBatchSize) });
    }
  }
  return { submittedCount: entries.length, entries, batches };
}
