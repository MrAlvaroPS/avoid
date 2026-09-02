import {
  defensiveEvaluationGenerationKey,
  homogeneousDefensiveEvaluationGeneration,
} from './defensive-evaluation-generation';

const generation = (overrides: Partial<Parameters<typeof defensiveEvaluationGenerationKey>[0]> = {}) => ({
  evaluatorVersion: 'evaluator@1',
  resolverVersion: 'resolver@1',
  solverVersion: 'solver@1',
  gameBuild: '12.0.0.1',
  buildFingerprint: 'sha256:abc',
  ...overrides,
});

describe('defensive evaluation generation', () => {
  it('accepts a complete homogeneous generation', () => {
    expect(homogeneousDefensiveEvaluationGeneration([generation(), generation()])).toEqual(
      defensiveEvaluationGenerationKey(generation()),
    );
  });

  it('rejects a resolver, solver, build or fingerprint mixture', () => {
    for (const changed of [
      generation({ resolverVersion: 'resolver@2' }),
      generation({ solverVersion: 'solver@2' }),
      generation({ gameBuild: '12.0.0.2' }),
      generation({ buildFingerprint: 'sha256:def' }),
    ]) {
      expect(homogeneousDefensiveEvaluationGeneration([generation(), changed])).toBeNull();
    }
  });

  it('does not manufacture a generation from incomplete provenance', () => {
    expect(homogeneousDefensiveEvaluationGeneration([generation({ gameBuild: null })])).toBeNull();
  });
});
