import { describe, expect, it } from 'vitest';
import {
  evaluateDefensiveEpisodesForPlayer,
  type DefensiveEpisodeEvaluatorInput,
  type EligibleDefensiveInput,
  type RawDamageHit,
} from '../../../supabase/functions/_shared/defensive-episode-evaluator';
import type { DamageApplicability } from '../../../supabase/functions/_shared/defensive-applicability';
import type { DecodedSchoolMask, AbilityCombatTableCounts } from '../../../supabase/functions/_shared/damage-descriptor-wcl';

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
    ...overrides,
  };
}

function barkskin(overrides: Partial<EligibleDefensiveInput> = {}): EligibleDefensiveInput {
  return {
    spellId: BARKSKIN_SPELL_ID,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    mechanisms: ['mitigation'],
    charges: 1,
    rechargeMs: null,
    durationMs: 12_000,
    cooldownMs: 60_000,
    confidence: 'verified',
    applicability: unrestrictedApplicability(),
    applicabilityConfidence: 'high',
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

function baseInput(overrides: Partial<DefensiveEpisodeEvaluatorInput> = {}): DefensiveEpisodeEvaluatorInput {
  const { points, pointStart, pointIntervalMs } = singlePeakGraph(11_000);
  return {
    pullId: 'pull-1',
    playerName: 'Gusmï',
    bossActorId: null,
    evaluationEndMs: null,
    eligibleDefensives: [barkskin()],
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

describe('evaluateDefensiveEpisodesForPlayer — circuito completo, sin kit', () => {
  it('sin ningún miembro del kit, no genera episodios (nada que evaluar)', () => {
    const result = evaluateDefensiveEpisodesForPlayer(baseInput({ eligibleDefensives: [] }));
    expect(result).toEqual([]);
  });

  it('sin picos de daño detectables, no genera episodios', () => {
    const result = evaluateDefensiveEpisodesForPlayer(baseInput({ damageTakenGraphPoints: [0, 0, 0] }));
    expect(result).toEqual([]);
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

  it('school mismatch real (AMS-style solo magia, hit físico real) → no_applicable_resource, nunca missed_ready', () => {
    const ams = barkskin({
      spellId: 48707,
      applicability: unrestrictedApplicability({ schoolScope: 'magic' }),
    });
    const input = baseInput({
      eligibleDefensives: [ams],
      schoolByAbilityId: new Map<number, DecodedSchoolMask>([[999, { schoolMask: 1, schools: ['Physical'] }]]),
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('no_applicable_resource');
  });
});

describe('evaluateDefensiveEpisodesForPlayer — kit completo considerado (no spell aislado)', () => {
  it('Barkskin en cooldown legítimo pero Frenzied Regeneration listo → missed_ready, no unavailable_legitimate (precedencia de kit completo)', () => {
    const frenziedRegen = barkskin({
      spellId: FRENZIED_REGEN_SPELL_ID,
      mechanisms: ['sustain'],
      cooldownMs: 36_000,
      durationMs: null,
    });
    const input = baseInput({
      eligibleDefensives: [
        barkskin({ cooldownMs: 60_000 }), // Barkskin, en cooldown por un uso previo legítimo
        frenziedRegen, // listo
      ],
      castsBySpellId: new Map([[BARKSKIN_SPELL_ID, [1000]]]), // gastado hace tiempo, sigue "on cooldown" a los 11000ms (60000ms de cd)
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('missed_ready');
  });
});

describe('evaluateDefensiveEpisodesForPlayer — disponibilidad causal a través de episodios reales', () => {
  it('dos episodios: Barkskin cubre el primero, queda on_cooldown legítimo en el segundo → unavailable_legitimate, no missed_ready', () => {
    // Dos picos: uno en 11000, otro en 30000 (bien separados, dos episodios distintos).
    const g1 = singlePeakGraph(11_000);
    const points = [...g1.points];
    const secondPeakIndex = 30; // ms 30000 con pointIntervalMs=1000
    while (points.length <= secondPeakIndex + 2) points.push(1000);
    points[secondPeakIndex] = 5000;

    const input = baseInput({
      damageTakenGraphPoints: points,
      rawDamageHits: [
        { timestamp: 11_000, abilityGameID: 999, amount: 5000, isAoE: false, tick: false },
        { timestamp: 30_000, abilityGameID: 999, amount: 5000, isAoE: false, tick: false },
      ],
      castsBySpellId: new Map([[BARKSKIN_SPELL_ID, [11_000]]]), // usado en el primer episodio real
      eligibleDefensives: [barkskin({ cooldownMs: 60_000 })], // 60s de cooldown: sigue en CD en el segundo episodio (t=30000)
    });

    const episodes = evaluateDefensiveEpisodesForPlayer(input);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].responseVerdict).toBe('covered_verified'); // el propio cast cubrió el primer episodio
    expect(episodes[1].responseVerdict).toBe('unavailable_legitimate'); // el cast que lo dejó en CD ya demostrablemente cubrió el episodio #0
  });
});

describe('evaluateDefensiveEpisodesForPlayer — cargas reales (Shield Block-style, 2 cargas)', () => {
  it('con rechargeMs real, una carga gastada y recargada dentro del pull sigue dejando 1 libre → missed_ready, no unknown', () => {
    const shieldBlock = barkskin({
      spellId: 2565,
      charges: 2,
      rechargeMs: 16_000,
      cooldownMs: 16_000,
      durationMs: 6_000,
    });
    const input = baseInput({
      eligibleDefensives: [shieldBlock],
      castsBySpellId: new Map([[2565, [-20_000]]]), // gastada hace mucho, ya recargada del todo
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('missed_ready');
  });
});

describe('evaluateDefensiveEpisodesForPlayer — excluded por cutoff de evaluación', () => {
  it('un episodio posterior a evaluationEndMs se marca excluded sin evaluar candidatos', () => {
    const input = baseInput({ evaluationEndMs: 5000 }); // el pico está en 11000, después del cutoff
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('excluded');
    expect(episode.applicableCandidates).toEqual([]);
  });
});

describe('evaluateDefensiveEpisodesForPlayer — sourceAffectedBySpell lazy real (Fiery-Brand-style)', () => {
  it('solo se consulta bossDebuffIntervals cuando applicability.requiresSourceAffectedBySpell=true; resuelve yes/unknown con datos reales', () => {
    const fieryBrandStyle = barkskin({
      spellId: 204021,
      applicability: unrestrictedApplicability({ requiresSourceAffectedBySpell: true }),
    });
    const inside = baseInput({
      eligibleDefensives: [fieryBrandStyle],
      bossActorId: 33,
      bossDebuffIntervals: [{ targetID: 33, spellId: 204021, startMs: 10_000, endMs: 12_000 }],
      castsBySpellId: new Map([[204021, [11_000]]]), // usado en el episodio
    });
    const [covered] = evaluateDefensiveEpisodesForPlayer(inside);
    expect(covered.responseVerdict).toBe('covered_verified');

    const outside = baseInput({
      eligibleDefensives: [fieryBrandStyle],
      bossActorId: 33,
      bossDebuffIntervals: [{ targetID: 33, spellId: 204021, startMs: 500_000, endMs: 502_000 }], // nunca activo cerca del episodio
      castsBySpellId: new Map([[204021, [11_000]]]),
    });
    const [uncertain] = evaluateDefensiveEpisodesForPlayer(outside);
    expect(uncertain.responseVerdict).toBe('uncertain'); // usó algo pero applicability no se puede demostrar — nunca covered_verified falso
    expect(uncertain.usageEngaged).toBe(true);
  });
});
