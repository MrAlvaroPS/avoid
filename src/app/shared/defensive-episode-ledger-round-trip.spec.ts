// Test de circuito completo §2.6: evaluate (resolveEpisodeVerdict, ya
// testeado en defensive-episode-verdict.spec.ts) → persist (staging row) →
// materialize (ledger events), y la reconstrucción inversa
// staging→ledger que pide la tarea — "demostrar que podemos coger
// cualquier DefensiveEpisode, persistir exactamente su verdad/evidencia y
// materializarla de forma reproducible e independiente de legacy".
//
// También cubre, a nivel de identidad (sin necesitar Postgres), la
// coexistencia V2/canonical: la forma de deduplication_key de los eventos
// canónicos es estructuralmente incompatible con la forma legacy V2
// (generateDeduplicationKey en materialize-execution-ledger/index.ts),
// así que nunca podrían colisionar en la misma fila aunque compartieran
// pull_id + ledger_evaluator_version.

import { describe, expect, it } from 'vitest';
import { resolveEpisodeVerdict, type EpisodeVerdictCandidate } from '../../../supabase/functions/_shared/defensive-episode-verdict';
import { buildPersistedDefensiveEpisode } from '../../../supabase/functions/_shared/defensive-episode-persistence';
import {
  buildDefensiveEpisodeEvaluationRow,
  dbRecordToEpisodeEvaluationRow,
  episodeEvaluationRowToDbRecord,
} from '../../../supabase/functions/_shared/defensive-episode-staging';
import { buildDefensiveEpisodeLedgerEvents, DEFENSIVE_EPISODE_EVALUATOR_VERSION } from '../../../supabase/functions/_shared/defensive-episode-ledger-events';

const PULL = { id: 'pull-1', bossId: 'boss-1', difficulty: 'mythic' };

function candidate(overrides: Partial<EpisodeVerdictCandidate> = {}): EpisodeVerdictCandidate {
  return {
    spellId: 22812,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    applicability: 'yes',
    usedDuringEpisode: false,
    statusAtPeak: 'available_unused',
    ...overrides,
  };
}

describe('circuito completo: evaluate → persist → materialize (staging→ledger)', () => {
  it('un DefensiveEpisode real (Barkskin missed_ready, caso Gusmï) sobrevive el circuito completo sin perder verdad ni evidencia', () => {
    // 1) evaluate — misma función pura ya testeada en defensive-episode-verdict.spec.ts
    const candidates = [candidate({ statusAtPeak: 'available_unused' })];
    const verdict = resolveEpisodeVerdict(candidates);
    expect(verdict.responseVerdict).toBe('missed_ready');

    // 2) persist — ensambla el episodio completo persistible
    const window = { occurrenceId: null, dominantAbilityGameId: 22812, memberIndexes: [0], startMs: 10_000, peakMs: 11_000, endMs: 12_000 };
    const persisted = buildPersistedDefensiveEpisode({
      pullId: PULL.id,
      playerName: 'Gusmï',
      window,
      candidates,
      verdict,
      confidence: 'verified',
      evidence: { groupingBasis: 'heuristic' },
    });

    const row = buildDefensiveEpisodeEvaluationRow({
      defensiveGenerationId: 'gen-shadow-1',
      pullId: PULL.id,
      playerName: 'Gusmï',
      episodeEvaluatorVersion: DEFENSIVE_EPISODE_EVALUATOR_VERSION,
      semanticVersion: 'defensive-semantics@10',
      semanticResolverVersion: 'effective-defensive-semantics@1.0.0',
      resolverVersion: 'effective-defensives@2.1.0',
      buildFingerprint: 'fp-gusmi',
      episodes: [persisted],
    });

    // Simula lo que Supabase realmente guarda/devuelve (jsonb round-trip vía JSON, no solo objeto en memoria).
    const dbRecord = JSON.parse(JSON.stringify(episodeEvaluationRowToDbRecord(row)));
    const reloadedRow = dbRecordToEpisodeEvaluationRow(dbRecord);
    expect(reloadedRow.episodes[0].responseVerdict).toBe('missed_ready');
    expect(reloadedRow.episodes[0].usageEngaged).toBe(false);

    // 3) materialize — desde la fila RELOADED (no desde el objeto original en memoria)
    const events = buildDefensiveEpisodeLedgerEvents({
      pull: PULL,
      row: reloadedRow,
      contextResolverVersion: 'pull-evaluation-context@1.0.0',
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.eventType).toBe('defensive_episode_missed_ready');
    expect(event.verdict).toBe('missed');
    expect(event.penaltyEligible).toBe(true);
    expect(event.creditEligible).toBe(false);
    // Uso reconstruible desde el evento, sin volver a leer staging (§2.6).
    expect(event.evidence['usage_engaged']).toBe(verdict.usageEngaged);
    expect(event.evidence['used_spell_ids']).toEqual(verdict.usedSpellIds);
    expect(event.evidence['response_reason']).toBe(verdict.reason);
    // Evidencia de grouping también sobrevive el round-trip completo.
    expect(event.evidence['groupingBasis']).toBe('heuristic');
    expect(event.defensiveGenerationId).toBe('gen-shadow-1');
  });

  it('reevaluar el MISMO episodio (misma generación) con un veredicto distinto produce la MISMA deduplicationKey — upsert idempotente de extremo a extremo', () => {
    const window = { occurrenceId: null, dominantAbilityGameId: 22812, memberIndexes: [0], startMs: 10_000, peakMs: 11_000, endMs: 12_000 };

    function materializeOnce(candidates: EpisodeVerdictCandidate[]) {
      const verdict = resolveEpisodeVerdict(candidates);
      const persisted = buildPersistedDefensiveEpisode({
        pullId: PULL.id,
        playerName: 'Gusmï',
        window,
        candidates,
        verdict,
        confidence: 'verified',
      });
      const row = buildDefensiveEpisodeEvaluationRow({
        defensiveGenerationId: 'gen-shadow-1',
        pullId: PULL.id,
        playerName: 'Gusmï',
        episodeEvaluatorVersion: DEFENSIVE_EPISODE_EVALUATOR_VERSION,
        semanticVersion: 'defensive-semantics@10',
        semanticResolverVersion: 'effective-defensive-semantics@1.0.0',
        resolverVersion: 'effective-defensives@2.1.0',
        episodes: [persisted],
      });
      return buildDefensiveEpisodeLedgerEvents({ pull: PULL, row, contextResolverVersion: 'ctx@1' })[0];
    }

    // Primera pasada: no usado, listo → missed_ready.
    const first = materializeOnce([candidate({ statusAtPeak: 'available_unused', usedDuringEpisode: false })]);
    // Segunda pasada (reevaluación, p. ej. tras corregir un dato upstream): SÍ usado y aplicable → covered_verified.
    const second = materializeOnce([candidate({ statusAtPeak: 'active', usedDuringEpisode: true, applicability: 'yes' })]);

    expect(first.verdict).not.toBe(second.verdict); // veredictos genuinamente distintos (missed vs success)...
    expect(first.eventType).not.toBe(second.eventType);
    expect(first.deduplicationKey).toBe(second.deduplicationKey); // ...pero la misma fila (UPSERT la pisa, no la duplica)
  });

  it('coexistencia V2/canonical: la forma del deduplicationKey canónico es estructuralmente incompatible con la forma legacy V2, nunca colisionan', () => {
    const window = { occurrenceId: null, dominantAbilityGameId: 22812, memberIndexes: [0], startMs: 10_000, peakMs: 11_000, endMs: 12_000 };
    const candidates = [candidate({ statusAtPeak: 'available_unused' })];
    const verdict = resolveEpisodeVerdict(candidates);
    const persisted = buildPersistedDefensiveEpisode({
      pullId: PULL.id,
      playerName: 'Gusmï',
      window,
      candidates,
      verdict,
      confidence: 'verified',
    });
    const row = buildDefensiveEpisodeEvaluationRow({
      defensiveGenerationId: 'gen-shadow-1',
      pullId: PULL.id,
      playerName: 'Gusmï',
      episodeEvaluatorVersion: DEFENSIVE_EPISODE_EVALUATOR_VERSION,
      semanticVersion: 'defensive-semantics@10',
      semanticResolverVersion: 'effective-defensive-semantics@1.0.0',
      resolverVersion: 'effective-defensives@2.1.0',
      episodes: [persisted],
    });
    const [canonicalEvent] = buildDefensiveEpisodeLedgerEvents({ pull: PULL, row, contextResolverVersion: 'ctx@1' });

    // Forma legacy V2 real: `${pullId}:${domain}:${playerName}:${occurrenceId}:${timestampMs}:${evidenceHash}`
    // (generateDeduplicationKey, materialize-execution-ledger/index.ts) — 6 segmentos, domain='defensive' fijo en la 2ª posición.
    const legacyStyleKey = `${PULL.id}:defensive:Gusmï:null:11000:a1b2c3d4`;
    expect(canonicalEvent.deduplicationKey).not.toBe(legacyStyleKey);

    // La key canónica tiene 4 segmentos y termina en :response — nunca produce
    // por azar la forma legacy de 6 segmentos con 'defensive' en 2ª posición.
    const canonicalSegments = canonicalEvent.deduplicationKey.split(':');
    expect(canonicalSegments.at(-1)).toBe('response');
    expect(canonicalSegments[1]).not.toBe('defensive');

    // eventType también namespaced sin ambigüedad: nunca colisiona con
    // `defensive_${state}` legacy (p. ej. defensive_plan_broken, defensive_correct_hold).
    expect(canonicalEvent.eventType.startsWith('defensive_episode_')).toBe(true);
    expect(canonicalEvent.eventType).not.toMatch(/^defensive_(plan_broken|reminder_missed|correct_hold|safe_extra_use)$/);
  });
});
