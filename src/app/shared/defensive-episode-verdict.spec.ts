import { describe, expect, it } from 'vitest';
import {
  resolveEpisodeVerdict,
  summarizeCandidateForEpisode,
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
    applicability: 'unknown',
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

  it('mitigation-style: a cast AFTER the episode ends does not count (it did not protect anything)', () => {
    const result = summarizeCandidateForEpisode(barkskin(), ['mitigation'], [13_000], episode);
    expect(result.usedDuringEpisode).toBe(false);
  });

  it('sustain-style: a cast shortly AFTER the episode still counts (recovery window, §30 of the plan)', () => {
    const frenziedRegen = barkskin({ spellId: 22842, name: 'Frenzied Regeneration', baseCooldownMs: 36_000, durationMs: null });
    const result = summarizeCandidateForEpisode(frenziedRegen, ['sustain'], [12_500], episode);
    expect(result.usedDuringEpisode).toBe(true);
  });

  it('sustain-style: a cast well beyond the grace window does not count', () => {
    const frenziedRegen = barkskin({ spellId: 22842, durationMs: null });
    const result = summarizeCandidateForEpisode(frenziedRegen, ['sustain'], [20_000], episode);
    expect(result.usedDuringEpisode).toBe(false);
  });

  it('statusAtPeak reflects available_unused when never cast', () => {
    const result = summarizeCandidateForEpisode(barkskin(), ['mitigation'], [], episode);
    expect(result.statusAtPeak).toBe('available_unused');
  });

  it('statusAtPeak reflects on_cooldown once the buff duration has lapsed but the cooldown has not', () => {
    // Barkskin: duración 12s, cooldown 60s. Casteado 14s antes del pico
    // (14000 > 12000 duración, < 60000 cooldown) → ya no está activo, pero
    // tampoco disponible todavía.
    const result = summarizeCandidateForEpisode(barkskin(), ['mitigation'], [-3_000], episode);
    expect(result.statusAtPeak).toBe('on_cooldown');
  });
});

describe('resolveEpisodeVerdict', () => {
  it('covered_verified when a kit member was used and applicability is yes', () => {
    const result = resolveEpisodeVerdict([candidate({ usedDuringEpisode: true, applicability: 'yes' })]);
    expect(result.verdict).toBe('covered_verified');
    expect(result.coveredBySpellId).toBe(22812);
  });

  it('covered_verified when applicability is unknown (no real DamageDescriptor yet) — a real cast is assumed correct, per explicit decision 2026-09-04', () => {
    const result = resolveEpisodeVerdict([candidate({ usedDuringEpisode: true, applicability: 'unknown' })]);
    expect(result.verdict).toBe('covered_verified');
    expect(result.reason).toContain('asumida correcta');
  });

  it('NOT covered when applicability is confirmed no, even if it was cast (a real-data "no" always outranks the cast)', () => {
    const result = resolveEpisodeVerdict([
      candidate({ usedDuringEpisode: true, applicability: 'no', createsMissableOpportunity: false, isDefensiveKitMember: true }),
    ]);
    expect(result.verdict).not.toBe('covered_verified');
  });

  it('missed_ready when a strategic candidate was ready and applicable but not used', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'available_unused' })]);
    expect(result.verdict).toBe('missed_ready');
  });

  it('never misses when applicability is confirmed no (invariant 5: a non-applicable defensive never generates missed_ready)', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'available_unused', applicability: 'no' })]);
    expect(result.verdict).toBe('no_applicable_resource');
  });

  it('no_applicable_resource when the build has nothing strategic at all (e.g. only survival_state members)', () => {
    const bearForm = candidate({ isDefensiveKitMember: true, createsMissableOpportunity: false, statusAtPeak: 'available_unused' });
    const result = resolveEpisodeVerdict([bearForm]);
    expect(result.verdict).toBe('no_applicable_resource');
    expect(result.reason).toContain('no tiene ningún recurso personal estratégico');
  });

  it('uncertain (never a penalty) when everything strategic is on cooldown — causal legitimate-vs-mistimed reconstruction is not built yet', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'on_cooldown' })]);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toContain('no se reconstruye');
  });

  it('uncertain when status itself could not be determined (missing cooldown data)', () => {
    const result = resolveEpisodeVerdict([candidate({ statusAtPeak: 'unknown' })]);
    expect(result.verdict).toBe('uncertain');
  });

  it('picks the first genuinely covering candidate among several, ignoring ones that did not cover', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 1, usedDuringEpisode: false }),
      candidate({ spellId: 2, usedDuringEpisode: true, applicability: 'yes' }),
    ]);
    expect(result.coveredBySpellId).toBe(2);
  });
});
