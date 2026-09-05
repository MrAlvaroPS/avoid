import { describe, expect, it } from 'vitest';
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

  // §"es normal que una persona cambie de talentos según el boss" (feedback
  // real, 2026-09-03): un respec entre pulls solo debe romper la generación
  // cuando alguien pide explícitamente exigir fingerprint único.
  it('with requireBuildFingerprint:false, tolerates a fingerprint mixture but still requires the rest to match', () => {
    const relaxed = { requireBuildFingerprint: false };
    const mixed = homogeneousDefensiveEvaluationGeneration(
      [generation(), generation({ buildFingerprint: 'sha256:def' })],
      relaxed,
    );
    expect(mixed).toMatchObject({ evaluatorVersion: 'evaluator@1', buildFingerprint: 'mixed' });

    const single = homogeneousDefensiveEvaluationGeneration([generation(), generation()], relaxed);
    expect(single).toEqual(defensiveEvaluationGenerationKey(generation()));

    for (const changed of [
      generation({ resolverVersion: 'resolver@2' }),
      generation({ solverVersion: 'solver@2' }),
      generation({ gameBuild: '12.0.0.2' }),
    ]) {
      expect(homogeneousDefensiveEvaluationGeneration([generation(), changed], relaxed)).toBeNull();
    }
  });
});
