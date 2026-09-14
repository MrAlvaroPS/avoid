import { describe, expect, it } from 'vitest';
import { buildDefensiveKitBreakdown } from './defensive-kit-breakdown';
import type { CanonicalDefensiveEpisodeFact, CanonicalEpisodeVerdictCandidate, EffectiveKitEntry } from './canonical-defensive-summary.service';

function kitEntry(overrides: Partial<EffectiveKitEntry> = {}): EffectiveKitEntry {
  return {
    spellId: 22812,
    isDefensiveKitMember: true,
    opportunityMode: 'normal',
    effectiveCooldownMs: 60_000,
    charges: 1,
    rechargeMs: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<CanonicalEpisodeVerdictCandidate> = {}): CanonicalEpisodeVerdictCandidate {
  return {
    spellId: 22812,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    materiallyUnresolved: false,
    damageApplicability: 'yes',
    temporalOpportunity: 'yes',
    temporalCastCoverage: 'yes',
    engagement: false,
    statusAtPeak: 'available_unused',
    confidence: 'verified',
    evidence: {},
    ...overrides,
  };
}

function episode(overrides: Partial<CanonicalDefensiveEpisodeFact> = {}): CanonicalDefensiveEpisodeFact {
  return {
    episodeId: 'ep-1',
    causalGroupId: 'group-1',
    pullId: 'p1',
    startMs: 0,
    peakMs: 1000,
    endMs: 2000,
    dominantAbilityGameId: null,
    usageEngaged: false,
    usageEvaluable: true,
    usedSpellIds: [],
    applicableCandidates: [candidate()],
    responseVerdict: 'missed_ready',
    responseReason: 'fixture',
    coveredBySpellId: null,
    decisiveSpellIds: [22812],
    planAssignmentId: null,
    planVerdict: null,
    confidence: 'verified',
    ...overrides,
  };
}

const NAMES = new Map([[22812, 'Barkskin'], [5487, 'Bear Form'], [22842, 'Frenzied Regeneration']]);

describe('buildDefensiveKitBreakdown (§defensive-kit-panel, caso real Gusmï)', () => {
  it('un spell "normal" cuenta en contra; uno "credit_only" no, aunque ambos vengan del mismo kit real', () => {
    const kit = [kitEntry({ spellId: 22812, opportunityMode: 'normal' }), kitEntry({ spellId: 5487, opportunityMode: 'credit_only', effectiveCooldownMs: null })];
    const result = buildDefensiveKitBreakdown(kit, [], NAMES);

    const barkskin = result.find((e) => e.spellId === 22812)!;
    const bearForm = result.find((e) => e.spellId === 5487)!;
    expect(barkskin.countsAgainstKpi).toBe(true);
    expect(bearForm.countsAgainstKpi).toBe(false);
    expect(barkskin.name).toBe('Barkskin');
  });

  it('conserva el cooldown/cargas reales de effective_kit para mostrarlos, sin inventar nada si faltan', () => {
    const kit = [kitEntry({ spellId: 22812, effectiveCooldownMs: 120_000, charges: 2 })];
    const result = buildDefensiveKitBreakdown(kit, [], NAMES);
    expect(result[0].effectiveCooldownMs).toBe(120_000);
    expect(result[0].charges).toBe(2);
  });

  it('un spell del kit sin ningún episodio esta noche sigue apareciendo, con contadores en 0 — nunca desaparece por falta de ocasión', () => {
    const kit = [kitEntry({ spellId: 22812 })];
    const result = buildDefensiveKitBreakdown(kit, [], NAMES);
    expect(result).toHaveLength(1);
    expect(result[0].timesDecisive).toBe(0);
    expect(result[0].timesUsed).toBe(0);
  });

  it('un candidato de un spell que el kit no resolvió como miembro no fabrica una fila nueva', () => {
    const kit = [kitEntry({ spellId: 22812 })];
    const episodes = [episode({ applicableCandidates: [candidate({ spellId: 999 })] })];
    const result = buildDefensiveKitBreakdown(kit, episodes, NAMES);
    expect(result).toHaveLength(1);
    expect(result[0].spellId).toBe(22812);
  });

  it('acumula timesDecisive/timesCovering/timesUsed a través de varios episodios reales', () => {
    const kit = [kitEntry({ spellId: 22812 })];
    const episodes = [
      episode({ episodeId: 'ep-1' }),
      episode({
        episodeId: 'ep-2',
        responseVerdict: 'covered_verified',
        coveredBySpellId: 22812,
        usedSpellIds: [22812],
        applicableCandidates: [candidate({ engagement: true })],
      }),
    ];
    const result = buildDefensiveKitBreakdown(kit, episodes, NAMES);
    expect(result[0].timesDecisive).toBe(2);
    expect(result[0].timesCovering).toBe(1);
    expect(result[0].timesUsed).toBe(1);
  });

  it('un spellId sin nombre conocido cae en el fallback "Spell {id}", nunca se oculta', () => {
    const kit = [kitEntry({ spellId: 999999 })];
    const result = buildDefensiveKitBreakdown(kit, [], NAMES);
    expect(result[0].name).toBe('Spell 999999');
  });
});
