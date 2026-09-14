import { describe, expect, it } from 'vitest';
import { buildDefensiveKpiExplainer } from './defensive-kpi-explainer';
import type { CanonicalDefensiveEpisodeView, NightCanonicalDefensiveSummary } from '../../core/night-player-summary.service';
import type { CanonicalEpisodeVerdictCandidate, EffectiveKitEntry } from '../../core/canonical-defensive-summary.service';

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

function episode(overrides: Partial<CanonicalDefensiveEpisodeView> = {}): CanonicalDefensiveEpisodeView {
  return {
    episodeId: 'ep-1',
    causalGroupId: 'group-1',
    pullId: 'p1',
    startMs: 100_000,
    peakMs: 112_280,
    endMs: 114_000,
    peakValue: null,
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
    bossId: 'boss-1',
    bossName: 'Testboss',
    difficulty: 'Heroic',
    pullNumber: 20,
    mechanicName: null,
    mechanicDescription: null,
    mechanicResolution: null,
    ...overrides,
  };
}

function summary(episodes: CanonicalDefensiveEpisodeView[], overrides: Partial<NightCanonicalDefensiveSummary> = {}): NightCanonicalDefensiveSummary {
  return {
    state: 'available',
    coverage: { evaluatedPulls: 1, expectedPulls: 1 },
    usage: { status: 'available', score: 0, engaged: 0, evaluable: episodes.length || 1 },
    response: { status: 'available', score: 0, covered: 0, evaluable: episodes.length || 1, missedReady: episodes.length, missedMistimed: 0 },
    management: { status: 'available', score: 74.4, fulfilled: 29, evaluable: 39, mode: 'generic_usage' },
    context: { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 0, excluded: 0 },
    totalEpisodes: episodes.length,
    episodes,
    kit: [kitEntry()],
    generation: null,
    integrityIssues: [],
    diagnostics: { usage: { status: 'available', engaged: 0, evaluable: 0, score: null }, response: { status: 'available', covered: 0, evaluable: 0, score: null, missedReady: 0, missedMistimed: 0 }, rowsExpected: 1, rowsFound: 1 },
    ...overrides,
  };
}

const FIGHT_IDS = new Map([['p1', 27]]);
const SPELL_NAMES = new Map([[22812, 'Barkskin'], [22842, 'Frenzied Regeneration'], [5487, 'Bear Form']]);

describe('buildDefensiveKpiExplainer (§detailed-kpi-explainer, caso real Gusmï/Txerokee)', () => {
  it('un missed_ready real aparece en criticalWindows con nombre de spell, boss/pull reales y link de WCL verificable', () => {
    const view = buildDefensiveKpiExplainer(summary([episode()]), FIGHT_IDS, 'VNvX3MqWxZ9jhT6d', SPELL_NAMES);

    expect(view.criticalWindows).toHaveLength(1);
    const window = view.criticalWindows[0];
    expect(window.bossName).toBe('Testboss');
    expect(window.pullNumber).toBe(20);
    expect(window.peakLabel).toBe('1:52'); // 112280ms → 1min52s
    expect(window.verdict).toBe('missed_ready');
    expect(window.decisiveSpellNames).toEqual(['Barkskin']);
    expect(window.wclUrl).toBe('https://www.warcraftlogs.com/reports/VNvX3MqWxZ9jhT6d#fight=27&type=damage-taken');
  });

  it('un episodio sin fightId conocido se excluye de la lista en vez de fabricar un link roto', () => {
    const view = buildDefensiveKpiExplainer(summary([episode({ pullId: 'unknown-pull' })]), FIGHT_IDS, 'VNvX3MqWxZ9jhT6d', SPELL_NAMES);
    expect(view.criticalWindows).toHaveLength(0);
  });

  it('un episodio uncertain/no_applicable_resource nunca entra en criticalWindows (solo los 3 veredictos evaluables)', () => {
    const view = buildDefensiveKpiExplainer(
      summary([episode({ responseVerdict: 'uncertain' }), episode({ episodeId: 'ep-2', responseVerdict: 'no_applicable_resource' })]),
      FIGHT_IDS,
      'VNvX3MqWxZ9jhT6d',
      SPELL_NAMES,
    );
    expect(view.criticalWindows).toHaveLength(0);
  });

  it('caso real Gusmï: el kit real (effective_kit) decide countsAgainstKpi/cooldown, y llega intacto hasta view.kit — Barkskin cuenta, Bear Form (credit_only) no', () => {
    const ep = episode({
      applicableCandidates: [
        candidate({ spellId: 22812 }),
        candidate({ spellId: 5487, engagement: true }),
      ],
      decisiveSpellIds: [22812],
    });
    const kit = [kitEntry({ spellId: 22812, opportunityMode: 'normal' }), kitEntry({ spellId: 5487, opportunityMode: 'credit_only', effectiveCooldownMs: null })];
    const view = buildDefensiveKpiExplainer(summary([ep], { kit }), FIGHT_IDS, 'VNvX3MqWxZ9jhT6d', SPELL_NAMES);

    const barkskin = view.kit.find((k) => k.spellId === 22812)!;
    const bearForm = view.kit.find((k) => k.spellId === 5487)!;
    expect(barkskin.countsAgainstKpi).toBe(true);
    expect(bearForm.countsAgainstKpi).toBe(false);
    expect(bearForm.timesUsed).toBe(1); // se usó, pero nunca resta si no se usa
  });

  it('el bloque usage refleja el modo generic_usage con la etiqueta y los conteos reales, sin inventar nada', () => {
    const view = buildDefensiveKpiExplainer(summary([episode()]), FIGHT_IDS, 'VNvX3MqWxZ9jhT6d', SPELL_NAMES);
    expect(view.usage.label).toBe('Uso');
    expect(view.usage.actualCasts).toBe(29);
    expect(view.usage.theoreticalMax).toBe(39);
  });
});
