import { describe, expect, it } from 'vitest';
import {
  evaluateDefensiveEpisodesForPlayer,
  type DefensiveEpisodeEvaluatorInput,
} from '../../../supabase/functions/_shared/defensive-episode-evaluator';
import type { DamageApplicability } from '../../../supabase/functions/_shared/defensive-applicability';
import type { DecodedSchoolMask, AbilityCombatTableCounts } from '../../../supabase/functions/_shared/damage-descriptor-wcl';
import type { ResolvedDefensive } from '../../../supabase/functions/_shared/effective-defensives';

const BARKSKIN_SPELL_ID = 22812;
const FRENZIED_REGEN_SPELL_ID = 22842;

function unrestrictedApplicability(overrides: Partial<DamageApplicability> = {}): DamageApplicability {
  return {
    schoolScope: 'all',
    schools: null,
    deliveryScopes: ['all'],
    requiresDodgeable: null,
    requiresParryable: null,
    requiresBlockable: null,
    requiresSourceAffectedBySpell: null,
    timingRelation: 'before_or_during',
    ...overrides,
  };
}

function resolvedDefensive(overrides: Partial<ResolvedDefensive> = {}): ResolvedDefensive {
  return {
    spellId: BARKSKIN_SPELL_ID,
    name: 'Barkskin',
    className: 'Druid',
    specName: 'Guardian',
    category: 'personal_defensive',
    survivalType: 'mitigation',
    targetingMode: 'self',
    activationMode: 'active',
    effectiveCooldownMs: 60_000,
    effectiveDurationMs: 12_000,
    charges: 1,
    rechargeMs: null,
    eligible: true,
    buildFingerprint: 'fp-gusmi',
    gameBuild: 'build-1',
    resolverVersion: 'effective-defensives@2.1.0',
    confidence: 'verified',
    provenance: [],
    conditionalModifiers: [],
    semanticResolved: true,
    usageRole: 'personal_survival',
    activationScope: 'self',
    primaryBeneficiary: 'self',
    secondaryPropagation: 'none',
    mechanisms: ['mitigation'],
    opportunityMode: 'normal',
    defensiveIntent: 'primary',
    semanticStatus: 'verified',
    semanticVersion: 'defensive-semantics@10',
    semanticConfidence: 'verified',
    semanticResolverVersion: 'effective-defensive-semantics@1.3.1',
    semanticProvenance: [],
    buildPresence: 'present',
    buildPresenceReason: 'baseline',
    buildPresenceConfidence: 'verified',
    buildPresenceEvidence: 'baseline_kit',
    applicability: unrestrictedApplicability(),
    applicabilityConfidence: 'high',
    resolutionStatus: 'resolved',
    unresolvedRuntimeRules: [],
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    ...overrides,
  };
}

// Genera un graph con un único pico claro alrededor de peakAtMs (un bucket
// muy por encima de la línea base, exactamente el patrón que detectDamageWindows
// espera — mismo estilo que damage-pressure-windows ya usa en su propio módulo).
function singlePeakGraph(peakAtMs: number, pointIntervalMs = 1000, baseline = 1000, peak = baseline * 5) {
  const pointStart = 0;
  const peakIndex = Math.round((peakAtMs - pointStart) / pointIntervalMs);
  const points: number[] = [];
  for (let i = 0; i <= peakIndex + 5; i++) {
    points.push(i === peakIndex ? peak : baseline);
  }
  return { points, pointStart, pointIntervalMs };
}

// Como singlePeakGraph, pero el pico ocupa TRES buckets consecutivos por
// encima del umbral (en vez de uno solo) — produce una ventana con
// startMs < endMs (aquí [peakAtMs-1000, peakAtMs+1000]) en vez del caso
// degenerado de un único punto (startMs===endMs===peakMs), para poder situar
// varios hits/casts reales dentro del propio tramo del episodio.
function widePeakGraph(peakAtMs: number, pointIntervalMs = 1000, baseline = 1000, peak = baseline * 5) {
  const pointStart = 0;
  const peakIndex = Math.round((peakAtMs - pointStart) / pointIntervalMs);
  const points: number[] = [];
  for (let i = 0; i <= peakIndex + 5; i++) {
    if (i === peakIndex) points.push(peak);
    else if (i === peakIndex - 1 || i === peakIndex + 1) points.push(baseline * 3);
    else points.push(baseline);
  }
  return { points, pointStart, pointIntervalMs };
}

function baseInput(overrides: Partial<DefensiveEpisodeEvaluatorInput> = {}): DefensiveEpisodeEvaluatorInput {
  const { points, pointStart, pointIntervalMs } = singlePeakGraph(11_000);
  return {
    pullId: 'pull-1',
    playerName: 'Gusmï',
    bossActorId: null,
    evaluationEndMs: null,
    resolvedDefensives: [resolvedDefensive()],
    damageTakenGraphPoints: points,
    graphPointStartMs: pointStart,
    graphPointIntervalMs: pointIntervalMs,
    rawDamageHits: [{ timestamp: 11_000, abilityGameID: 999, amount: 5000, isAoE: false, tick: false }],
    castsBySpellId: new Map(),
    schoolByAbilityId: new Map<number, DecodedSchoolMask>([[999, { schoolMask: 4, schools: ['Fire'] }]]),
    combatTableObservations: new Map<number, AbilityCombatTableCounts>(),
    bossDebuffIntervals: [],
    dataConfidence: 'verified',
    ...overrides,
  };
}

describe('evaluateDefensiveEpisodesForPlayer — pressure always creates the episode (§2)', () => {
  it('an empty resolvedDefensives kit does NOT drop the episode — it persists no_applicable_resource (test 5)', () => {
    const result = evaluateDefensiveEpisodesForPlayer(baseInput({ resolvedDefensives: [] }));
    expect(result).toHaveLength(1);
    expect(result[0].responseVerdict).toBe('no_applicable_resource');
  });

  it('sin picos de daño detectables, no genera episodios (nada que agrupar)', () => {
    const result = evaluateDefensiveEpisodesForPlayer(baseInput({ damageTakenGraphPoints: [0, 0, 0] }));
    expect(result).toEqual([]);
  });

  it('a positively-known-irrelevant resource (utility, not personal_survival) does not block no_applicable_resource', () => {
    const utility = resolvedDefensive({
      spellId: 5000,
      usageRole: 'utility',
      opportunityMode: 'none',
      isDefensiveKitMember: false,
      createsMissableOpportunity: false,
    });
    const result = evaluateDefensiveEpisodesForPlayer(baseInput({ resolvedDefensives: [utility] }));
    expect(result[0].responseVerdict).toBe('no_applicable_resource');
  });

  it('a potentially relevant unresolved resource (pending semantics) blocks no_applicable_resource → uncertain (test 6)', () => {
    const pending = resolvedDefensive({
      spellId: 6000,
      semanticStatus: 'pending',
      isDefensiveKitMember: false,
      createsMissableOpportunity: false,
      resolutionStatus: 'unresolved',
    });
    const result = evaluateDefensiveEpisodesForPlayer(baseInput({ resolvedDefensives: [pending] }));
    expect(result[0].responseVerdict).toBe('uncertain');
  });
});

describe('evaluateDefensiveEpisodesForPlayer — un episodio, un candidato', () => {
  it('listo y no usado → missed_ready', () => {
    const [episode] = evaluateDefensiveEpisodesForPlayer(baseInput());
    expect(episode.responseVerdict).toBe('missed_ready');
    expect(episode.usageEngaged).toBe(false);
  });

  it('usado dentro del episodio, aplicabilidad demostrada → covered_verified', () => {
    const input = baseInput({ castsBySpellId: new Map([[BARKSKIN_SPELL_ID, [11_000]]]) });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('covered_verified');
    expect(episode.usageEngaged).toBe(true);
    expect(episode.usedSpellIds).toEqual([BARKSKIN_SPELL_ID]);
  });

  it('used credit_only member with verified damage/timing coverage → covered_verified (test 9)', () => {
    const bearForm = resolvedDefensive({
      spellId: 5487,
      usageRole: 'survival_state',
      opportunityMode: 'credit_only',
      createsMissableOpportunity: false,
      applicability: unrestrictedApplicability({ timingRelation: 'after_damage' }),
    });
    const input = baseInput({
      resolvedDefensives: [bearForm],
      castsBySpellId: new Map([[5487, [11_500]]]), // reactivo, dentro de la ventana de 3000ms tras el episodio
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('covered_verified');
    expect(episode.usageEngaged).toBe(true);
  });

  it('a credit_only member without an observed active interval (continuous_state) never fabricates coverage from a mere cast', () => {
    const bearForm = resolvedDefensive({
      spellId: 5487,
      usageRole: 'survival_state',
      opportunityMode: 'credit_only',
      createsMissableOpportunity: false,
      applicability: unrestrictedApplicability({ timingRelation: 'continuous_state' }),
    });
    const { points, pointStart, pointIntervalMs } = widePeakGraph(11_000);
    const input = baseInput({
      resolvedDefensives: [bearForm],
      damageTakenGraphPoints: points,
      graphPointStartMs: pointStart,
      graphPointIntervalMs: pointIntervalMs,
      castsBySpellId: new Map([[5487, [10_000]]]), // dentro del propio tramo del episodio ([10000,12000])
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.usageEngaged).toBe(true);
    expect(episode.responseVerdict).not.toBe('covered_verified');
    expect(episode.responseVerdict).not.toBe('missed_ready');
  });

  it('unused credit_only resource alone never creates missed_ready (test 10)', () => {
    const bearForm = resolvedDefensive({
      spellId: 5487,
      usageRole: 'survival_state',
      opportunityMode: 'credit_only',
      createsMissableOpportunity: false,
    });
    const input = baseInput({ resolvedDefensives: [bearForm] });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).not.toBe('missed_ready');
  });

  it('school mismatch real (AMS-style solo magia, hit físico real) → no_applicable_resource, nunca missed_ready (test 20)', () => {
    const ams = resolvedDefensive({
      spellId: 48707,
      applicability: unrestrictedApplicability({ schoolScope: 'magic' }),
    });
    const input = baseInput({
      resolvedDefensives: [ams],
      schoolByAbilityId: new Map<number, DecodedSchoolMask>([[999, { schoolMask: 1, schools: ['Physical'] }]]),
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('no_applicable_resource');
  });

  it('Evasion-style requiresDodgeable with dodgeability unknown → no missed_ready (test 21)', () => {
    const evasion = resolvedDefensive({
      spellId: 5277,
      applicability: unrestrictedApplicability({ requiresDodgeable: true }),
    });
    const input = baseInput({ resolvedDefensives: [evasion] });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).not.toBe('missed_ready');
  });

  it('Feint-style delivery mismatch → no missed_ready (test 22)', () => {
    const feint = resolvedDefensive({
      spellId: 1966,
      applicability: unrestrictedApplicability({ deliveryScopes: ['aoe'] }),
    });
    const input = baseInput({
      resolvedDefensives: [feint],
      rawDamageHits: [{ timestamp: 11_000, abilityGameID: 999, amount: 5000, isAoE: false, tick: false }],
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).not.toBe('missed_ready');
  });

  it('multi-hit episode where hit applicability is mixed yes/no combines to unknown, never confident yes (test 23)', () => {
    // Misma ability dominante (999), pero dos hits reales con deliveryScope
    // distinto (single_target vs aoe) dentro de la misma ventana — un
    // defensivo restringido a single_target cubre uno y no el otro.
    const singleTargetOnly = resolvedDefensive({
      spellId: 61336,
      applicability: unrestrictedApplicability({ deliveryScopes: ['single_target'] }),
    });
    const { points, pointStart, pointIntervalMs } = widePeakGraph(11_000);
    const mixedInput = baseInput({
      resolvedDefensives: [singleTargetOnly],
      damageTakenGraphPoints: points,
      graphPointStartMs: pointStart,
      graphPointIntervalMs: pointIntervalMs,
      rawDamageHits: [
        { timestamp: 10_500, abilityGameID: 999, amount: 5000, isAoE: false, tick: false },
        { timestamp: 11_000, abilityGameID: 999, amount: 5000, isAoE: true, tick: false },
      ],
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(mixedInput);
    const candidate = episode.applicableCandidates[0] as { damageApplicability?: string } | undefined;
    expect(candidate?.damageApplicability).toBe('unknown');
    expect(episode.responseVerdict).not.toBe('missed_ready');
  });
});

describe('evaluateDefensiveEpisodesForPlayer — kit completo considerado (no spell aislado)', () => {
  it('Barkskin en cooldown legítimo pero Frenzied Regeneration listo → missed_ready, no unavailable_legitimate (test 24)', () => {
    const frenziedRegen = resolvedDefensive({
      spellId: FRENZIED_REGEN_SPELL_ID,
      mechanisms: ['sustain'],
      effectiveCooldownMs: 36_000,
      effectiveDurationMs: null,
      applicability: unrestrictedApplicability({ timingRelation: 'after_damage' }),
    });
    const input = baseInput({
      resolvedDefensives: [resolvedDefensive({ effectiveCooldownMs: 60_000 }), frenziedRegen],
      // Gastado hace mucho: el buff (12s) ya expiró bien antes del pico (t=11000) y el cooldown (60s) no se ha recuperado.
      castsBySpellId: new Map([[BARKSKIN_SPELL_ID, [-40_000]]]),
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('missed_ready');
  });
});

describe('evaluateDefensiveEpisodesForPlayer — disponibilidad causal a través de episodios reales', () => {
  it('dos episodios: Barkskin cubre el primero, queda on_cooldown legítimo en el segundo → unavailable_legitimate, no missed_ready (test 25)', () => {
    const g1 = singlePeakGraph(11_000);
    const points = [...g1.points];
    const secondPeakIndex = 30;
    while (points.length <= secondPeakIndex + 2) points.push(1000);
    points[secondPeakIndex] = 5000;

    const input = baseInput({
      damageTakenGraphPoints: points,
      rawDamageHits: [
        { timestamp: 11_000, abilityGameID: 999, amount: 5000, isAoE: false, tick: false },
        { timestamp: 30_000, abilityGameID: 999, amount: 5000, isAoE: false, tick: false },
      ],
      castsBySpellId: new Map([[BARKSKIN_SPELL_ID, [11_000]]]),
      resolvedDefensives: [resolvedDefensive({ effectiveCooldownMs: 60_000 })],
    });

    const episodes = evaluateDefensiveEpisodesForPlayer(input);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].responseVerdict).toBe('covered_verified');
    expect(episodes[1].responseVerdict).toBe('unavailable_legitimate');
  });

  it('a prior cast with no demonstrated prior episode never becomes missed_due_to_mistime (test 26)', () => {
    const g1 = singlePeakGraph(11_000);
    const points = [...g1.points];
    const secondPeakIndex = 30;
    while (points.length <= secondPeakIndex + 2) points.push(1000);
    points[secondPeakIndex] = 5000;

    const input = baseInput({
      damageTakenGraphPoints: points,
      rawDamageHits: [{ timestamp: 30_000, abilityGameID: 999, amount: 5000, isAoE: false, tick: false }],
      // Cast sin relación con ningún episodio conocido: duración corta (2s) para que
      // no llegue a cubrir el pico del primer episodio (~11000) por casualidad de rango.
      castsBySpellId: new Map([[BARKSKIN_SPELL_ID, [5_000]]]),
      resolvedDefensives: [resolvedDefensive({ effectiveCooldownMs: 60_000, effectiveDurationMs: 2_000 })],
    });
    const episodes = evaluateDefensiveEpisodesForPlayer(input);
    const last = episodes.at(-1)!;
    expect(last.responseVerdict).toBe('uncertain');
    expect(last.responseVerdict).not.toBe('missed_due_to_mistime');
  });
});

describe('evaluateDefensiveEpisodesForPlayer — cargas reales (Shield Block-style, 2 cargas)', () => {
  it('con rechargeMs real, una carga gastada y recargada dentro del pull sigue dejando 1 libre → missed_ready, no unknown (test 28)', () => {
    const shieldBlock = resolvedDefensive({
      spellId: 2565,
      charges: 2,
      rechargeMs: 16_000,
      effectiveCooldownMs: 16_000,
      effectiveDurationMs: 6_000,
    });
    const input = baseInput({
      resolvedDefensives: [shieldBlock],
      castsBySpellId: new Map([[2565, [-20_000]]]),
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('missed_ready');
  });

  it('missing reliable recharge for multiple charges fails closed — never a false miss (test 29)', () => {
    const twoCharges = resolvedDefensive({
      spellId: 61336,
      charges: 2,
      rechargeMs: null,
      effectiveCooldownMs: 90_000,
      effectiveDurationMs: 8_000,
    });
    const input = baseInput({
      resolvedDefensives: [twoCharges],
      castsBySpellId: new Map([[61336, [-20_000]]]),
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).not.toBe('missed_ready');
  });
});

describe('evaluateDefensiveEpisodesForPlayer — cutoff/wipe safety (§10, test 30-31)', () => {
  it('30: an episode whose peak is at/after evaluationEndMs is excluded', () => {
    const input = baseInput({ evaluationEndMs: 11_000 });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('excluded');
    expect(episode.applicableCandidates).toEqual([]);
  });

  it('31: the reactive post-damage grace window never crosses the wipe cutoff', () => {
    const reactive = resolvedDefensive({
      spellId: FRENZIED_REGEN_SPELL_ID,
      effectiveDurationMs: null,
      applicability: unrestrictedApplicability({ timingRelation: 'after_damage' }),
    });
    const input = baseInput({
      resolvedDefensives: [reactive],
      evaluationEndMs: 12_500, // episodio termina en ~11500-ish, cutoff justo tras el episodio pero antes de que termine la gracia de 3000ms
      castsBySpellId: new Map([[FRENZIED_REGEN_SPELL_ID, [12_800]]]), // cast después del cutoff
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.usageEngaged).toBe(false);
  });
});

describe('evaluateDefensiveEpisodesForPlayer — sourceAffectedBySpell lazy real (Fiery-Brand-style)', () => {
  it('solo se consulta bossDebuffIntervals cuando applicability.requiresSourceAffectedBySpell=true; resuelve yes/unknown con datos reales', () => {
    const fieryBrandStyle = resolvedDefensive({
      spellId: 204021,
      applicability: unrestrictedApplicability({ requiresSourceAffectedBySpell: true }),
    });
    const inside = baseInput({
      resolvedDefensives: [fieryBrandStyle],
      bossActorId: 33,
      bossDebuffIntervals: [{ targetID: 33, spellId: 204021, startMs: 10_000, endMs: 12_000 }],
      castsBySpellId: new Map([[204021, [11_000]]]),
    });
    const [covered] = evaluateDefensiveEpisodesForPlayer(inside);
    expect(covered.responseVerdict).toBe('covered_verified');

    const outside = baseInput({
      resolvedDefensives: [fieryBrandStyle],
      bossActorId: 33,
      bossDebuffIntervals: [{ targetID: 33, spellId: 204021, startMs: 500_000, endMs: 502_000 }],
      castsBySpellId: new Map([[204021, [11_000]]]),
    });
    const [uncertain] = evaluateDefensiveEpisodesForPlayer(outside);
    expect(uncertain.responseVerdict).toBe('uncertain');
    expect(uncertain.usageEngaged).toBe(true);
  });
});
