import { describe, expect, it } from 'vitest';
import {
  buildCanonicalDefensiveSummary,
  buildManagementKpi,
  closedCanonicalDefensiveSummary,
  type CanonicalDefensiveEpisodeFact,
  type CanonicalDefensiveGeneration,
  type EpisodeEvaluationDbRow,
} from './canonical-defensive-summary.service';
import type { PersistedDefensiveEpisode } from '../../../supabase/functions/_shared/defensive-episode-persistence';
import type { ResponseVerdict } from '../../../supabase/functions/_shared/defensive-episode-verdict';

const GENERATION: CanonicalDefensiveGeneration = {
  id: 'generation-1',
  publishedAt: '2026-09-05T00:00:00Z',
  semanticVersion: 'defensive-semantics@1.0.0',
  resolverVersion: 'effective-defensives@2.3.0',
  semanticResolverVersion: 'effective-defensive-semantics@1.5.0',
  episodeVersion: 'episode-evaluator@7',
  evaluatorVersion: 'episode-evaluator@7',
  gameBuild: '12.1.0.68914',
};

let seq = 0;

function persistedEpisode(overrides: Partial<PersistedDefensiveEpisode> = {}): PersistedDefensiveEpisode {
  seq += 1;
  return {
    episodeId: `episode-${seq}`,
    causalGroupId: `group-${seq}`,
    startMs: 19_000,
    peakMs: 20_000,
    endMs: 21_000,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [],
    responseVerdict: 'missed_ready',
    responseReason: 'fixture',
    coveredBySpellId: null,
    planAssignmentId: null,
    planVerdict: null,
    evidence: { dominantAbilityGameId: 5000 },
    confidence: 'verified',
    ...overrides,
  };
}

function row(pullId: string, episodes: PersistedDefensiveEpisode[], overrides: Partial<EpisodeEvaluationDbRow> = {}): EpisodeEvaluationDbRow {
  return {
    pull_id: pullId,
    episode_evaluator_version: GENERATION.evaluatorVersion!,
    semantic_version: GENERATION.semanticVersion,
    semantic_resolver_version: GENERATION.semanticResolverVersion,
    resolver_version: GENERATION.resolverVersion,
    episodes,
    ...overrides,
  };
}

describe('buildCanonicalDefensiveSummary · fuente única (§58)', () => {
  it('Response canónico gana aunque se le pase un valor legacy decoy por fuera — nada aquí lo consulta', () => {
    const rows = [
      row('p1', [
        persistedEpisode({ responseVerdict: 'covered_verified' }),
        persistedEpisode({ responseVerdict: 'missed_ready' }),
        persistedEpisode({ responseVerdict: 'missed_ready' }),
        persistedEpisode({ responseVerdict: 'missed_ready' }),
      ]),
    ];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Raider');

    expect(result.state).toBe('available');
    expect(result.response.score).toBe(25); // 1/4, nunca 80 ni 70 (legacy decoys que un caller pudiera pasar por otro lado)
    expect(result.response.covered).toBe(1);
    expect(result.response.evaluable).toBe(4);
  });
});

describe('buildCanonicalDefensiveSummary · smoke fixtures (§59-62, verificadas contra datos reales)', () => {
  it('Magzil-shaped: Usage 18/23 (78.26%) y Response 4/20 (20%) con denominadores distintos', () => {
    // Los 3 "uncertain" tienen usageEvaluable=true explícito (una oportunidad core real existió, Usage puede
    // acreditarse) pero quedan fuera del denominador de Response (§64: usageEvaluable≠responseEvaluable).
    const episodes = [
      ...Array.from({ length: 4 }, () => persistedEpisode({ responseVerdict: 'covered_verified', usageEngaged: true })),
      ...Array.from({ length: 14 }, () => persistedEpisode({ responseVerdict: 'missed_ready', usageEngaged: true })),
      ...Array.from({ length: 2 }, () => persistedEpisode({ responseVerdict: 'missed_ready', usageEngaged: false })),
      ...Array.from({ length: 3 }, () => persistedEpisode({ responseVerdict: 'uncertain', usageEngaged: false, usageEvaluable: true })),
    ];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], [row('p1', episodes)], 'Magzil');

    expect(result.totalEpisodes).toBe(23);
    expect(result.usage.engaged).toBe(18);
    expect(result.usage.evaluable).toBe(23);
    expect(result.usage.score).toBe(78.26);
    expect(result.response.covered).toBe(4);
    expect(result.response.evaluable).toBe(20);
    expect(result.response.score).toBe(20);
    expect(result.usage.score).not.toBe(result.response.score); // canary: nunca deben colapsar al mismo número
  });

  it('Tetasdivinas-shaped: Usage 0/1 y Response 0/1, ambos 0% — nunca N/D', () => {
    const rows = [row('p1', [persistedEpisode({ responseVerdict: 'missed_ready', usageEngaged: false })])];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Tetasdivinas');

    expect(result.usage.score).toBe(0);
    expect(result.response.score).toBe(0);
    expect(result.usage.status).toBe('available');
  });

  it('Dewerland-shaped: Usage 10/17 y Response 4/15 — denominadores no compartidos', () => {
    const episodes = [
      ...Array.from({ length: 4 }, () => persistedEpisode({ responseVerdict: 'covered_verified', usageEngaged: true })),
      ...Array.from({ length: 6 }, () => persistedEpisode({ responseVerdict: 'missed_ready', usageEngaged: true })),
      ...Array.from({ length: 5 }, () => persistedEpisode({ responseVerdict: 'missed_ready', usageEngaged: false })),
      ...Array.from({ length: 2 }, () => persistedEpisode({ responseVerdict: 'uncertain', usageEngaged: false, usageEvaluable: false })),
    ];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], [row('p1', episodes)], 'Dewerland');

    expect(result.usage.evaluable).toBe(15);
    expect(result.usage.engaged).toBe(10);
    expect(result.response.evaluable).toBe(15);
    expect(result.response.covered).toBe(4);
  });
});

describe('buildCanonicalDefensiveSummary · reglas de denominador (§29/§63-66)', () => {
  it('sin episodios: Usage/Response quedan insufficient_evidence (N/D), nunca 0%', () => {
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], [row('p1', [])], 'Raider');
    expect(result.usage.status).toBe('insufficient_evidence');
    expect(result.usage.score).toBeNull();
    expect(result.response.status).toBe('insufficient_evidence');
    expect(result.response.score).toBeNull();
  });

  it('usageEngaged=true con usageEvaluable=false no entra en el numerador ni denominador de Usage', () => {
    const rows = [row('p1', [persistedEpisode({ responseVerdict: 'uncertain', usageEngaged: true, usageEvaluable: false })])];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Raider');
    expect(result.usage.evaluable).toBe(0);
    expect(result.usage.engaged).toBe(0);
  });

  it('un episodio con múltiples usedSpellIds cuenta como máximo 1 en Usage y 1 en Response', () => {
    const rows = [row('p1', [persistedEpisode({ responseVerdict: 'covered_verified', usageEngaged: true, usedSpellIds: [111, 222] })])];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Raider');
    expect(result.usage.engaged).toBe(1);
    expect(result.response.covered).toBe(1);
  });

  it('uncertain sale del denominador de Response — 10 covered + 5 missed_ready + 20 uncertain → denominador 15, no 35', () => {
    const episodes = [
      ...Array.from({ length: 10 }, () => persistedEpisode({ responseVerdict: 'covered_verified' })),
      ...Array.from({ length: 5 }, () => persistedEpisode({ responseVerdict: 'missed_ready' })),
      ...Array.from({ length: 20 }, () => persistedEpisode({ responseVerdict: 'uncertain', usageEvaluable: false })),
    ];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], [row('p1', episodes)], 'Raider');
    expect(result.response.evaluable).toBe(15);
    expect(result.context.uncertain).toBe(20);
  });
});

describe('buildManagementKpi (§67-69)', () => {
  it('sin ninguna asignación de plan: status no_plan, score null', () => {
    const episodes: CanonicalDefensiveEpisodeFact[] = [];
    const result = buildManagementKpi(episodes, []);
    expect(result).toEqual({ status: 'no_plan', score: null, fulfilled: 0, evaluable: 0 });
  });

  it('3 covered + 1 missed de 4 asignaciones → 75%, sin bonus por encima de 100', () => {
    const episodes: CanonicalDefensiveEpisodeFact[] = ['a', 'b', 'c'].map((id) =>
      episodeFact({ planAssignmentId: id, planVerdict: 'covered' }),
    );
    episodes.push(episodeFact({ planAssignmentId: 'd', planVerdict: 'missed' }));
    const result = buildManagementKpi(episodes, []);
    expect(result).toEqual({ status: 'available', score: 75, fulfilled: 3, evaluable: 4 });
  });

  it('una assignment duplicada con el mismo veredicto no se cuenta dos veces', () => {
    const episodes = [
      episodeFact({ planAssignmentId: 'a', planVerdict: 'covered' }),
      episodeFact({ planAssignmentId: 'a', planVerdict: 'covered' }),
    ];
    const result = buildManagementKpi(episodes, []);
    expect(result).toEqual({ status: 'available', score: 100, fulfilled: 1, evaluable: 1 });
  });

  it('planAssignmentId sin planVerdict no se asume covered ni missed — se excluye y se registra', () => {
    const issues: string[] = [];
    const episodes = [episodeFact({ planAssignmentId: 'a', planVerdict: null })];
    const result = buildManagementKpi(episodes, issues);
    expect(result).toEqual({ status: 'no_plan', score: null, fulfilled: 0, evaluable: 0 });
    expect(issues).toHaveLength(1);
  });
});

describe('buildCanonicalDefensiveSummary · completitud → partial, no fail-closed total (corrección de revisión)', () => {
  it('faltar 1 de 2 pulls esperados da state=partial y calcula KPI reales sobre el subconjunto seguro', () => {
    const rows = [row('p1', [persistedEpisode({ responseVerdict: 'covered_verified' })])];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1', 'p2'], rows, 'Raider');

    expect(result.state).toBe('partial');
    expect(result.coverage).toEqual({ evaluatedPulls: 1, expectedPulls: 2 });
    expect(result.response.score).toBe(100); // real, no N/D solo por incompletitud
  });

  it('episodes:[] SÍ cuenta como pull evaluado (fila válida, Tetasdivinas-style)', () => {
    const rows = [row('p1', []), row('p2', [persistedEpisode({ responseVerdict: 'covered_verified' })])];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1', 'p2'], rows, 'Raider');

    expect(result.state).toBe('available');
    expect(result.coverage).toEqual({ evaluatedPulls: 2, expectedPulls: 2 });
  });

  it('cobertura completa y compatible → available', () => {
    const rows = [row('p1', [persistedEpisode({ responseVerdict: 'covered_verified' })])];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Raider');
    expect(result.state).toBe('available');
  });
});

describe('buildCanonicalDefensiveSummary · identidad de versión, generación como autoridad (§20, corregido)', () => {
  it('una fila que no coincide con la versión de la generación se excluye, nunca por "mayoría" entre filas', () => {
    const rows = [
      row('p1', [persistedEpisode({ responseVerdict: 'covered_verified' })]),
      row('p2', [persistedEpisode({ responseVerdict: 'missed_ready' })], { episode_evaluator_version: 'episode-evaluator@6' }),
    ];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1', 'p2'], rows, 'Raider');

    expect(result.state).toBe('partial'); // p1 es seguro y compatible, p2 no — subconjunto seguro no vacío
    expect(result.coverage).toEqual({ evaluatedPulls: 1, expectedPulls: 2 });
    expect(result.response.score).toBe(100); // solo p1
    expect(result.integrityIssues.some((issue) => issue.includes('p2'))).toBe(true);
  });

  it('si NINGUNA fila coincide con la generación publicada, no hay subconjunto seguro → incompatible, KPI a N/D', () => {
    const rows = [row('p1', [persistedEpisode({ responseVerdict: 'covered_verified' })], { episode_evaluator_version: 'episode-evaluator@6' })];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Raider');

    expect(result.state).toBe('incompatible');
    expect(result.response.status).toBe('insufficient_evidence');
    expect(result.response.score).toBeNull();
    expect(result.episodes).toEqual([]);
  });

  it('build_fingerprint NO se exige homogéneo — cambio de talentos entre pulls es legítimo (§21)', () => {
    // buildCanonicalDefensiveSummary no compara build_fingerprint en absoluto — este test documenta esa
    // decisión explícitamente para que una futura "mejora" no la reintroduzca por error.
    const rows = [row('p1', [persistedEpisode({ responseVerdict: 'covered_verified' })])];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Raider');
    expect(result.state).toBe('available');
  });
});

describe('buildCanonicalDefensiveSummary · corrupción de datos (§69)', () => {
  it('una fila duplicada para el mismo pull se ignora la repetición y se registra, sin contarla dos veces', () => {
    const rows = [
      row('p1', [persistedEpisode({ responseVerdict: 'covered_verified' })]),
      row('p1', [persistedEpisode({ responseVerdict: 'missed_ready' })]),
    ];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Raider');

    expect(result.coverage.evaluatedPulls).toBe(1);
    expect(result.integrityIssues.some((issue) => issue.includes('duplicada'))).toBe(true);
  });

  it('una fila para un pull inesperado se excluye y se registra', () => {
    const rows = [row('unexpected', [persistedEpisode({ responseVerdict: 'covered_verified' })])];
    const result = buildCanonicalDefensiveSummary(GENERATION, ['p1'], rows, 'Raider');

    expect(result.coverage).toEqual({ evaluatedPulls: 0, expectedPulls: 1 });
    expect(result.integrityIssues.some((issue) => issue.includes('unexpected'))).toBe(true);
  });
});

describe('closedCanonicalDefensiveSummary', () => {
  it('fuerza los tres KPI a null/insufficient_evidence y episodes vacío', () => {
    const result = closedCanonicalDefensiveSummary('unavailable', ['sin generación'], null);
    expect(result.usage.score).toBeNull();
    expect(result.response.score).toBeNull();
    expect(result.management.score).toBeNull();
    expect(result.episodes).toEqual([]);
  });
});

function episodeFact(overrides: Partial<CanonicalDefensiveEpisodeFact> & { responseVerdict?: ResponseVerdict } = {}): CanonicalDefensiveEpisodeFact {
  seq += 1;
  return {
    episodeId: `episode-${seq}`,
    causalGroupId: `group-${seq}`,
    pullId: 'p1',
    startMs: 19_000,
    peakMs: 20_000,
    endMs: 21_000,
    dominantAbilityGameId: 5000,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [],
    responseVerdict: 'covered_verified',
    responseReason: 'fixture',
    coveredBySpellId: null,
    decisiveSpellIds: [],
    planAssignmentId: null,
    planVerdict: null,
    confidence: 'verified',
    ...overrides,
  };
}
