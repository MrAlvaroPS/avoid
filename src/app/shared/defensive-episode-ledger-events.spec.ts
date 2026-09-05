import { describe, expect, it } from 'vitest';
import {
  DEFENSIVE_EPISODE_EVALUATOR_VERSION,
  buildDefensiveEpisodeLedgerEvents,
  buildDefensiveEpisodePlanLedgerEvent,
  buildDefensiveEpisodeResponseLedgerEvent,
  buildPlanDeduplicationKey,
  buildResponseDeduplicationKey,
  RESPONSE_VERDICT_TO_EXECUTION_VERDICT,
  RESPONSE_VERDICT_TO_REASON_CODE,
  type DefensiveEpisodeLedgerEventContext,
} from '../../../supabase/functions/_shared/defensive-episode-ledger-events';
import type { PersistedDefensiveEpisode } from '../../../supabase/functions/_shared/defensive-episode-persistence';
import type { ResponseVerdict } from '../../../supabase/functions/_shared/defensive-episode-verdict';
import type { DefensiveEpisodeEvaluationRow } from '../../../supabase/functions/_shared/defensive-episode-staging';

const PULL = { id: 'pull-1', bossId: 'boss-1', difficulty: 'mythic' };

function episode(overrides: Partial<PersistedDefensiveEpisode> = {}): PersistedDefensiveEpisode {
  return {
    episodeId: 'heuristic:abc123',
    causalGroupId: '11111111-2222-4333-8444-555555555555',
    startMs: 10_000,
    peakMs: 11_000,
    endMs: 12_000,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [],
    responseVerdict: 'missed_ready',
    responseReason: 'reason',
    coveredBySpellId: null,
    planAssignmentId: null,
    planVerdict: null,
    evidence: {},
    confidence: 'verified',
    ...overrides,
  };
}

function ctx(overrides: Partial<DefensiveEpisodeLedgerEventContext> = {}): DefensiveEpisodeLedgerEventContext {
  return {
    pull: PULL,
    playerName: 'Gusmï',
    defensiveGenerationId: 'gen-1',
    episode: episode(),
    episodeEvaluatorVersion: DEFENSIVE_EPISODE_EVALUATOR_VERSION,
    semanticVersion: 'defensive-semantics@10',
    semanticResolverVersion: 'effective-defensive-semantics@1.0.0',
    resolverVersion: 'effective-defensives@2.1.0',
    contextResolverVersion: 'pull-evaluation-context@1.0.0',
    ...overrides,
  };
}

describe('buildDefensiveEpisodeResponseLedgerEvent — mapeo §2.6 (7 estados)', () => {
  const cases: Array<{
    verdict: ResponseVerdict;
    executionVerdict: string;
    reasonCode: string;
    credit: boolean;
    penalty: boolean;
  }> = [
    { verdict: 'covered_verified', executionVerdict: 'success', reasonCode: 'DEFENSIVE_EPISODE_COVERED', credit: true, penalty: false },
    { verdict: 'missed_ready', executionVerdict: 'missed', reasonCode: 'DEFENSIVE_READY_NOT_USED', credit: false, penalty: true },
    { verdict: 'missed_due_to_mistime', executionVerdict: 'missed', reasonCode: 'DEFENSIVE_MISTIMED', credit: false, penalty: true },
    { verdict: 'unavailable_legitimate', executionVerdict: 'correct_hold', reasonCode: 'DEFENSIVE_UNAVAILABLE_LEGITIMATE', credit: false, penalty: false },
    { verdict: 'no_applicable_resource', executionVerdict: 'not_applicable', reasonCode: 'DEFENSIVE_NO_APPLICABLE_RESOURCE', credit: false, penalty: false },
    { verdict: 'uncertain', executionVerdict: 'uncertain', reasonCode: 'DEFENSIVE_EPISODE_UNCERTAIN', credit: false, penalty: false },
    { verdict: 'excluded', executionVerdict: 'context', reasonCode: 'DEFENSIVE_EPISODE_EXCLUDED', credit: false, penalty: false },
  ];

  for (const testCase of cases) {
    it(`${testCase.verdict} → verdict=${testCase.executionVerdict}, reasonCode=${testCase.reasonCode}, credit=${testCase.credit}, penalty=${testCase.penalty}`, () => {
      const event = buildDefensiveEpisodeResponseLedgerEvent(
        ctx({ episode: episode({ responseVerdict: testCase.verdict, confidence: 'verified' }) }),
      );
      expect(event.eventType).toBe(`defensive_episode_${testCase.verdict}`);
      expect(event.verdict).toBe(testCase.executionVerdict);
      expect(event.reasonCode).toBe(testCase.reasonCode);
      expect(event.creditEligible).toBe(testCase.credit);
      expect(event.penaltyEligible).toBe(testCase.penalty);
      expect(RESPONSE_VERDICT_TO_EXECUTION_VERDICT[testCase.verdict]).toBe(testCase.executionVerdict);
      expect(RESPONSE_VERDICT_TO_REASON_CODE[testCase.verdict]).toBe(testCase.reasonCode);
    });
  }

  it('nunca reutiliza los reason codes legacy de Gestión (PLAN_COVERED/REMINDER_MISSED/SAFE_EXTRA_USE) para Respuesta', () => {
    const legacyGestionCodes = new Set(['PLAN_COVERED', 'REMINDER_MISSED', 'SAFE_EXTRA_USE']);
    for (const testCase of cases) {
      expect(legacyGestionCodes.has(testCase.reasonCode)).toBe(false);
    }
  });

  it('fail-closed: missed_ready con confidence uncertain/fallback NUNCA es penalty_eligible (invariante 4 del plan, refleja el CHECK de la DB)', () => {
    const uncertainConfidence = buildDefensiveEpisodeResponseLedgerEvent(
      ctx({ episode: episode({ responseVerdict: 'missed_ready', confidence: 'uncertain' }) }),
    );
    expect(uncertainConfidence.penaltyEligible).toBe(false);

    const fallbackConfidence = buildDefensiveEpisodeResponseLedgerEvent(
      ctx({ episode: episode({ responseVerdict: 'missed_due_to_mistime', confidence: 'fallback' }) }),
    );
    expect(fallbackConfidence.penaltyEligible).toBe(false);
  });

  it('evidence incluye usageEngaged/usedSpellIds — Uso se reconstruye desde el mismo evento, sin tabla aparte', () => {
    const event = buildDefensiveEpisodeResponseLedgerEvent(
      ctx({ episode: episode({ usageEngaged: true, usedSpellIds: [22812, 22842], responseVerdict: 'covered_verified' }) }),
    );
    expect(event.evidence['usage_engaged']).toBe(true);
    expect(event.evidence['used_spell_ids']).toEqual([22812, 22842]);
  });

  it('occurrenceId nunca se enlaza sin occurrenceResolverVersion emparejado (invariante FK de player_execution_events)', () => {
    const withoutResolverVersion = buildDefensiveEpisodeResponseLedgerEvent(
      ctx({ episode: episode({ episodeId: 'occ-real-1' }), occurrenceResolverVersion: null }),
    );
    expect(withoutResolverVersion.occurrenceId).toBeNull();
    expect(withoutResolverVersion.occurrenceResolverVersion).toBeNull();

    const withResolverVersion = buildDefensiveEpisodeResponseLedgerEvent(
      ctx({ episode: episode({ episodeId: 'occ-real-1' }), occurrenceResolverVersion: 'mechanic-occurrence-resolver@1.0.0' }),
    );
    expect(withResolverVersion.occurrenceId).toBe('occ-real-1');
    expect(withResolverVersion.occurrenceResolverVersion).toBe('mechanic-occurrence-resolver@1.0.0');
  });

  it('un episodeId heurístico nunca se enlaza como occurrenceId, aunque se aporte occurrenceResolverVersion', () => {
    const event = buildDefensiveEpisodeResponseLedgerEvent(
      ctx({ episode: episode({ episodeId: 'heuristic:xyz' }), occurrenceResolverVersion: 'mechanic-occurrence-resolver@1.0.0' }),
    );
    expect(event.occurrenceId).toBeNull();
    expect(event.occurrenceResolverVersion).toBeNull();
  });
});

describe('identidad estable / idempotencia (§2.6 corrección #2)', () => {
  it('la deduplicationKey NUNCA depende de evidence/reason/confidence — solo generation+episode+player', () => {
    const first = buildDefensiveEpisodeResponseLedgerEvent(
      ctx({ episode: episode({ responseReason: 'razón A', evidence: { foo: 1 }, confidence: 'verified' }) }),
    );
    const second = buildDefensiveEpisodeResponseLedgerEvent(
      ctx({ episode: episode({ responseReason: 'razón B (reevaluado)', evidence: { foo: 2, bar: 'nuevo' }, confidence: 'inferred' }) }),
    );
    expect(first.deduplicationKey).toBe(second.deduplicationKey);
    expect(first.deduplicationKey).toBe(buildResponseDeduplicationKey('gen-1', 'heuristic:abc123', 'Gusmï'));
  });

  it('reevaluar con un responseVerdict DISTINTO dentro de la misma generación sigue produciendo la misma key (upsert pisa la fila, no la duplica)', () => {
    const missed = buildDefensiveEpisodeResponseLedgerEvent(ctx({ episode: episode({ responseVerdict: 'missed_ready' }) }));
    const covered = buildDefensiveEpisodeResponseLedgerEvent(ctx({ episode: episode({ responseVerdict: 'covered_verified' }) }));
    expect(missed.deduplicationKey).toBe(covered.deduplicationKey);
  });

  it('distinto episodio (episodeId distinto) del mismo jugador/generación → key distinta', () => {
    const a = buildDefensiveEpisodeResponseLedgerEvent(ctx({ episode: episode({ episodeId: 'heuristic:aaa' }) }));
    const b = buildDefensiveEpisodeResponseLedgerEvent(ctx({ episode: episode({ episodeId: 'heuristic:bbb' }) }));
    expect(a.deduplicationKey).not.toBe(b.deduplicationKey);
  });

  it('distinto jugador, mismo episodeId → key distinta (la identidad incluye playerName)', () => {
    const a = buildDefensiveEpisodeResponseLedgerEvent(ctx({ playerName: 'Gusmï' }));
    const b = buildDefensiveEpisodeResponseLedgerEvent(ctx({ playerName: 'Magzil' }));
    expect(a.deduplicationKey).not.toBe(b.deduplicationKey);
  });
});

describe('aislamiento entre generaciones', () => {
  it('mismo episodio/jugador, generationId distinto → deduplicationKey distinta (una corrida shadow nueva no pisa la generación anterior)', () => {
    const genA = buildDefensiveEpisodeResponseLedgerEvent(ctx({ defensiveGenerationId: 'gen-A' }));
    const genB = buildDefensiveEpisodeResponseLedgerEvent(ctx({ defensiveGenerationId: 'gen-B' }));
    expect(genA.deduplicationKey).not.toBe(genB.deduplicationKey);
    expect(genA.defensiveGenerationId).toBe('gen-A');
    expect(genB.defensiveGenerationId).toBe('gen-B');
  });

  it('el evento siempre lleva defensiveGenerationId poblado (nunca null) — solo los eventos legacy V2 tienen null, y esos no los produce este módulo', () => {
    const event = buildDefensiveEpisodeResponseLedgerEvent(ctx());
    expect(event.defensiveGenerationId).toBe('gen-1');
  });
});

describe('buildDefensiveEpisodePlanLedgerEvent — Gestión, solo cuando hay plan linkage', () => {
  it('null cuando el episodio no lleva planAssignmentId/planVerdict (ningún evaluator de Gestión lo puebla todavía)', () => {
    expect(buildDefensiveEpisodePlanLedgerEvent(ctx())).toBeNull();
  });

  it('covered → success/PLAN_COVERED/credit; missed → missed/REMINDER_MISSED/penalty (con confidence verified/inferred)', () => {
    const covered = buildDefensiveEpisodePlanLedgerEvent(
      ctx({ episode: episode({ planAssignmentId: 'assign-1', planVerdict: 'covered' }) }),
    );
    expect(covered).not.toBeNull();
    expect(covered!.eventType).toBe('defensive_plan_covered');
    expect(covered!.verdict).toBe('success');
    expect(covered!.reasonCode).toBe('PLAN_COVERED');
    expect(covered!.creditEligible).toBe(true);
    expect(covered!.penaltyEligible).toBe(false);

    const missed = buildDefensiveEpisodePlanLedgerEvent(
      ctx({ episode: episode({ planAssignmentId: 'assign-1', planVerdict: 'missed', confidence: 'verified' }) }),
    );
    expect(missed!.eventType).toBe('defensive_plan_missed');
    expect(missed!.verdict).toBe('missed');
    expect(missed!.reasonCode).toBe('REMINDER_MISSED');
    expect(missed!.penaltyEligible).toBe(true);
  });

  it('fail-closed: plan missed con confidence uncertain nunca penaliza', () => {
    const missed = buildDefensiveEpisodePlanLedgerEvent(
      ctx({ episode: episode({ planAssignmentId: 'assign-1', planVerdict: 'missed', confidence: 'uncertain' }) }),
    );
    expect(missed!.penaltyEligible).toBe(false);
  });

  it('deduplicationKey de Gestión es estable e incluye el planAssignmentId (distinto de la key de Respuesta del mismo episodio)', () => {
    const responseEvent = buildDefensiveEpisodeResponseLedgerEvent(ctx());
    const planEvent = buildDefensiveEpisodePlanLedgerEvent(
      ctx({ episode: episode({ planAssignmentId: 'assign-1', planVerdict: 'covered' }) }),
    );
    expect(planEvent!.deduplicationKey).not.toBe(responseEvent.deduplicationKey);
    expect(planEvent!.deduplicationKey).toBe(buildPlanDeduplicationKey('gen-1', 'heuristic:abc123', 'Gusmï', 'assign-1'));
  });

  it('nunca comparte contador con Respuesta: eventType con namespace propio (defensive_plan_ vs defensive_episode_)', () => {
    const planEvent = buildDefensiveEpisodePlanLedgerEvent(
      ctx({ episode: episode({ planAssignmentId: 'assign-1', planVerdict: 'covered' }) }),
    );
    expect(planEvent!.eventType.startsWith('defensive_plan_')).toBe(true);
    const responseEvent = buildDefensiveEpisodeResponseLedgerEvent(ctx());
    expect(responseEvent.eventType.startsWith('defensive_episode_')).toBe(true);
  });
});

describe('buildDefensiveEpisodeLedgerEvents — fila de staging completa → todos los eventos', () => {
  function row(episodes: PersistedDefensiveEpisode[]): Pick<
    DefensiveEpisodeEvaluationRow,
    'defensiveGenerationId' | 'playerName' | 'episodeEvaluatorVersion' | 'semanticVersion' | 'semanticResolverVersion' | 'resolverVersion' | 'episodes'
  > {
    return {
      defensiveGenerationId: 'gen-1',
      playerName: 'Gusmï',
      episodeEvaluatorVersion: DEFENSIVE_EPISODE_EVALUATOR_VERSION,
      semanticVersion: 'defensive-semantics@10',
      semanticResolverVersion: 'effective-defensive-semantics@1.0.0',
      resolverVersion: 'effective-defensives@2.1.0',
      episodes,
    };
  }

  it('un episodio sin plan linkage produce exactamente 1 evento (solo Respuesta)', () => {
    const events = buildDefensiveEpisodeLedgerEvents({
      pull: PULL,
      row: row([episode()]),
      contextResolverVersion: 'pull-evaluation-context@1.0.0',
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('defensive_episode_missed_ready');
  });

  it('un episodio CON plan linkage produce 2 eventos (Respuesta + Gestión)', () => {
    const events = buildDefensiveEpisodeLedgerEvents({
      pull: PULL,
      row: row([episode({ planAssignmentId: 'assign-1', planVerdict: 'covered' })]),
      contextResolverVersion: 'pull-evaluation-context@1.0.0',
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventType).sort()).toEqual(['defensive_episode_missed_ready', 'defensive_plan_covered']);
  });

  it('varios episodios se materializan todos, cada uno con su propia deduplicationKey', () => {
    const events = buildDefensiveEpisodeLedgerEvents({
      pull: PULL,
      row: row([
        episode({ episodeId: 'heuristic:aaa', responseVerdict: 'covered_verified', usageEngaged: true, usedSpellIds: [22812] }),
        episode({ episodeId: 'heuristic:bbb', responseVerdict: 'unavailable_legitimate' }),
        episode({ episodeId: 'heuristic:ccc', responseVerdict: 'uncertain', confidence: 'uncertain' }),
      ]),
      contextResolverVersion: 'pull-evaluation-context@1.0.0',
    });
    expect(events).toHaveLength(3);
    const keys = new Set(events.map((e) => e.deduplicationKey));
    expect(keys.size).toBe(3);
  });
});
