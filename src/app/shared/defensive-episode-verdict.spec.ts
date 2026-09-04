import { describe, expect, it } from 'vitest';
import {
  reconstructCausalAvailability,
  resolveEpisodeVerdict,
  resolveEpisodeVerdictWithCausalAvailability,
  summarizeCandidateForEpisode,
  type CausallyAwareCandidate,
  type EpisodeVerdictCandidate,
  type EpisodeWindow,
} from '../../../supabase/functions/_shared/defensive-episode-verdict';
import type { DefensiveCooldown } from '../../../supabase/functions/_shared/defensive-cooldowns';

const episode: EpisodeWindow = { startMs: 10_000, endMs: 12_000, peakMs: 11_000 };

function barkskin(overrides: Partial<DefensiveCooldown> = {}): DefensiveCooldown {
  return {
    spellId: 22812,
    name: 'Barkskin',
    class: 'Druid',
    spec: null,
    specOverride: null,
    category: 'personal_defensive',
    baseCooldownMs: 60_000,
    durationMs: 12_000,
    survivalType: 'mitigation',
    ...overrides,
  };
}

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

describe('summarizeCandidateForEpisode', () => {
  it('mitigation-style: a cast strictly inside the episode window counts as used', () => {
    const result = summarizeCandidateForEpisode(barkskin(), ['mitigation'], [10_500], episode);
    expect(result.usedDuringEpisode).toBe(true);
    expect(result.statusAtPeak).toBe('active');
  });

  it('mitigation-style: a cast AFTER the episode ends does not count', () => {
    const result = summarizeCandidateForEpisode(barkskin(), ['mitigation'], [13_000], episode);
    expect(result.usedDuringEpisode).toBe(false);
  });

  it('sustain-style: a cast shortly AFTER the episode still counts (recovery window, §30 of the plan)', () => {
    const frenziedRegen = barkskin({ spellId: 22842, baseCooldownMs: 36_000, durationMs: null });
    const result = summarizeCandidateForEpisode(frenziedRegen, ['sustain'], [12_500], episode);
    expect(result.usedDuringEpisode).toBe(true);
  });

  it('statusAtPeak reflects on_cooldown once the buff duration has lapsed but the cooldown has not', () => {
    const result = summarizeCandidateForEpisode(barkskin(), ['mitigation'], [-3_000], episode);
    expect(result.statusAtPeak).toBe('on_cooldown');
  });

  it('fail-closed for charges>1: on_cooldown degrades to unknown instead of a confident (possibly false) on_cooldown — revision 2026-09-04 point 5', () => {
    const twoChargeAbility = barkskin({ spellId: 61336, baseCooldownMs: 90_000, durationMs: 8_000 }); // Survival Instincts-style
    const naive = summarizeCandidateForEpisode(twoChargeAbility, ['mitigation'], [-20_000], episode, 1);
    expect(naive.statusAtPeak).toBe('on_cooldown');
    const withCharges = summarizeCandidateForEpisode(twoChargeAbility, ['mitigation'], [-20_000], episode, 2);
    expect(withCharges.statusAtPeak).toBe('unknown');
  });

  it('charges>1 does not mask a genuinely available_unused status (no prior cast at all)', () => {
    const result = summarizeCandidateForEpisode(barkskin(), ['mitigation'], [], episode, 2);
    expect(result.statusAtPeak).toBe('available_unused');
  });

  // §Paso C-1 (2026-09-04): con rechargeMs real (defensive_spec_profiles.recharge_ms,
  // ya resuelto por resolveEffectiveDefensiveKit) el fail-closed de arriba
  // deja de ser el único desenlace posible — se reconstruye disponibilidad
  // real por cargas en vez de degradar siempre a unknown.
  it('with a real rechargeMs, charges>1 reconstructs genuine availability instead of always degrading to unknown', () => {
    const shieldBlockStyle = barkskin({ spellId: 2565, baseCooldownMs: 16_000, durationMs: 6_000 });
    // Una sola carga gastada hace tiempo, ya recargada del todo — sigue habiendo 2 libres.
    const bothFree = summarizeCandidateForEpisode(shieldBlockStyle, ['mitigation'], [-20_000], episode, 2, undefined, 16_000);
    expect(bothFree.statusAtPeak).toBe('available_unused');

    // Dos cargas gastadas al inicio (t=1000, t=2000), pasado el duration del
    // efecto pero ninguna ha tenido tiempo de recargar (16s) para el pico
    // del episodio (11000) — de verdad on_cooldown, no unknown.
    const bothSpent = summarizeCandidateForEpisode(shieldBlockStyle, ['mitigation'], [1_000, 2_000], episode, 2, undefined, 16_000);
    expect(bothSpent.statusAtPeak).toBe('on_cooldown');
  });
});

describe('resolveEpisodeVerdict — three independent KPIs (usageEngaged vs responseVerdict)', () => {
  it('covered_verified: used + applicability demonstrated yes → usageEngaged=true, responseVerdict=covered_verified', () => {
    const result = resolveEpisodeVerdict([candidate({ usedDuringEpisode: true, applicability: 'yes' })]);
    expect(result.usageEngaged).toBe(true);
    expect(result.responseVerdict).toBe('covered_verified');
    expect(result.coveredBySpellId).toBe(22812);
  });

  it('BUG FIX (2026-09-04): applicability unknown + available + not used must NEVER produce missed_ready', () => {
    const result = resolveEpisodeVerdict([candidate({ applicability: 'unknown', statusAtPeak: 'available_unused', usedDuringEpisode: false })]);
    expect(result.responseVerdict).not.toBe('missed_ready');
    expect(result.responseVerdict).toBe('no_applicable_resource');
  });

  it('used + applicability unknown: usageEngaged=true (credited) but responseVerdict=uncertain (never covered, never penalized) — the corrected asymmetry', () => {
    const result = resolveEpisodeVerdict([candidate({ usedDuringEpisode: true, applicability: 'unknown' })]);
    expect(result.usageEngaged).toBe(true);
    expect(result.responseVerdict).toBe('uncertain');
    expect(result.coveredBySpellId).toBeNull();
  });

  it('used the wrong tool (applicability confirmed no): usageEngaged=true, responseVerdict is NOT covered', () => {
    const result = resolveEpisodeVerdict([
      candidate({ usedDuringEpisode: true, applicability: 'no', createsMissableOpportunity: false }),
    ]);
    expect(result.usageEngaged).toBe(true);
    expect(result.responseVerdict).not.toBe('covered_verified');
  });

  it('missed_ready only when applicability is strictly yes and it was truly available', () => {
    const result = resolveEpisodeVerdict([candidate({ applicability: 'yes', statusAtPeak: 'available_unused' })]);
    expect(result.responseVerdict).toBe('missed_ready');
    expect(result.usageEngaged).toBe(false);
  });

  it('never misses when applicability is confirmed no (invariant 5)', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'available_unused', applicability: 'no' })]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
  });

  it('no_applicable_resource when the kit has nothing strategic at all (e.g. only survival_state members)', () => {
    const bearForm = candidate({ createsMissableOpportunity: false, statusAtPeak: 'available_unused' });
    const result = resolveEpisodeVerdict([bearForm]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
    expect(result.reason).toContain('no tiene ningún recurso personal estratégico');
  });

  it('whole-kit precedence (point 4 of the review): a second ready ability wins over a first one being on cooldown — the episode is missed_ready, not resolved per-spell', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 1, statusAtPeak: 'on_cooldown' }), // Barkskin, legitimately spent
      candidate({ spellId: 2, statusAtPeak: 'available_unused' }), // Frenzied Regeneration, ready
    ]);
    expect(result.responseVerdict).toBe('missed_ready');
  });

  it('base uncertain (never a penalty) when everything strategic-applicable is on cooldown or undetermined', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'on_cooldown' })]);
    expect(result.responseVerdict).toBe('uncertain');
  });
});

describe('reconstructCausalAvailability', () => {
  const episodes: EpisodeWindow[] = [
    { startMs: 0, endMs: 2000, peakMs: 1000 }, // episode #0: real prior threat
    { startMs: 10_000, endMs: 12_000, peakMs: 11_000 }, // episode #1: the one being evaluated
  ];

  it('unavailable_legitimate when the prior cast demonstrably covered an earlier episode', () => {
    const result = reconstructCausalAvailability(barkskin(), ['mitigation'], [500], episodes, 1);
    expect(result.classification).toBe('unavailable_legitimate');
    expect(result.justifyingEpisodeIndex).toBe(0);
  });

  it('POINT 3 OF THE REVIEW: a prior cast with NO matching earlier episode never becomes missed_due_to_mistime — degrades to uncertain (Mythic sustained-damage case)', () => {
    // Casteado a las 5000ms, sin relación con ningún episodio conocido —
    // podría haber protegido contra daño sostenido que el detector nunca
    // convirtió en DefensiveEpisode.
    const result = reconstructCausalAvailability(barkskin(), ['mitigation'], [5_000], episodes, 1);
    expect(result.classification).toBe('uncertain');
    expect(result.classification).not.toBe('missed_due_to_mistime' as never);
  });

  it('uncertain when there is no prior cast at all to explain the cooldown', () => {
    const result = reconstructCausalAvailability(barkskin(), ['mitigation'], [], episodes, 1);
    expect(result.classification).toBe('uncertain');
  });
});

describe('resolveEpisodeVerdictWithCausalAvailability', () => {
  const episodes: EpisodeWindow[] = [
    { startMs: 0, endMs: 2000, peakMs: 1000 },
    { startMs: 10_000, endMs: 12_000, peakMs: 11_000 },
  ];

  function causalCandidate(overrides: Partial<CausallyAwareCandidate> = {}): CausallyAwareCandidate {
    return {
      ...candidate({ statusAtPeak: 'on_cooldown' }),
      cd: barkskin(),
      mechanisms: ['mitigation'],
      castsForSpellMs: [500], // covered episode #0
      ...overrides,
    };
  }

  it('promotes uncertain to unavailable_legitimate when the on-cooldown ability was legitimately spent on a prior episode', () => {
    const result = resolveEpisodeVerdictWithCausalAvailability([causalCandidate()], episodes, 1);
    expect(result.responseVerdict).toBe('unavailable_legitimate');
  });

  it('stays uncertain when the prior cast has no justifying episode (never fabricates missed_due_to_mistime)', () => {
    const result = resolveEpisodeVerdictWithCausalAvailability([causalCandidate({ castsForSpellMs: [5_000] })], episodes, 1);
    expect(result.responseVerdict).toBe('uncertain');
  });

  it('does not touch a base verdict that was already final (e.g. missed_ready)', () => {
    const result = resolveEpisodeVerdictWithCausalAvailability(
      [causalCandidate({ statusAtPeak: 'available_unused' })],
      episodes,
      1,
    );
    expect(result.responseVerdict).toBe('missed_ready');
  });

  it('mixed kit: one legitimate + one with no justification stays uncertain — not all could be demonstrated', () => {
    const result = resolveEpisodeVerdictWithCausalAvailability(
      [
        causalCandidate({ spellId: 1, castsForSpellMs: [500] }), // legitimate
        causalCandidate({ spellId: 2, cd: barkskin({ spellId: 2 }), castsForSpellMs: [5_000] }), // no justification
      ],
      episodes,
      1,
    );
    expect(result.responseVerdict).toBe('uncertain');
  });
});
