import { describe, expect, it, vi } from 'vitest';
import type { EffectiveDefensiveAuditFact } from './defensive-audit-facts.ts';
import type { PersistedDefensiveEpisode, PersistedEpisodeVerdictCandidate } from './defensive-episode-persistence.ts';
import { sendDiscordParts } from './discord-multipart-send.ts';
import {
  actionableTimingWindow,
  buildDefensiveNightAudit,
  type BuildDefensiveNightAuditInput,
  type DefensiveAuditEvaluationRowInput,
  type DefensiveAuditPullInput,
} from './player-defensive-audit.ts';
import {
  chunkDefensiveNarrativeForDiscord,
  formatDelta,
  formatFightTime,
  renderDefensiveNarrativePlainText,
  wclFightUrl,
} from './player-defensive-audit-narrative.ts';
import {
  DEFENSIVE_NIGHT_AUDIT_VERSION,
  defensiveAuditDiscordSendDisabled,
  type DefensiveAuditNarrative,
} from './player-defensive-audit-contract.ts';

const CORE: EffectiveDefensiveAuditFact = {
  spellId: 100,
  name: 'Guardia de prueba',
  isDefensiveKitMember: true,
  createsMissableOpportunity: true,
  usageRole: 'personal_survival',
  opportunityMode: 'normal',
  timingRelation: 'before_or_during',
  effectiveCooldownMs: 1000,
  effectiveDurationMs: 500,
  charges: 1,
  rechargeMs: null,
  cooldownConfidence: 'verified',
  durationConfidence: 'verified',
  chargesConfidence: 'verified',
  rechargeConfidence: 'verified',
  membershipConfidence: 'verified',
  applicabilityConfidence: 'high',
  buildPresence: 'present',
  resolutionStatus: 'resolved',
  unresolvedRuntimeRuleCount: 0,
};

function candidate(overrides: Partial<PersistedEpisodeVerdictCandidate> = {}): PersistedEpisodeVerdictCandidate {
  return {
    spellId: 100,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    materiallyUnresolved: false,
    damageApplicability: 'yes',
    temporalOpportunity: 'yes',
    temporalCastCoverage: 'yes',
    engagement: true,
    statusAtPeak: 'active',
    confidence: 'verified',
    membershipConfidence: 'verified',
    applicabilityClaimConfidence: 'verified',
    availabilityConfidence: 'verified',
    coverageConfidence: 'verified',
    evidence: {
      temporal: {
        timingRelation: 'before_or_during',
        relevantCasts: [900],
        prePeakCasts: [900],
        theoreticallyCoveringCasts: [900],
      },
    },
    castsForSpellMs: [900],
    timing: { timingRelation: 'before_or_during', effectiveDurationMs: 500, afterDamageResponseWindowMs: 300, evaluationEndMs: null },
    availabilityAtPeak: { status: 'active', chargesAvailable: null },
    ...overrides,
  };
}

function episode(id = 'ep-1', overrides: Partial<PersistedDefensiveEpisode> = {}): PersistedDefensiveEpisode {
  return {
    episodeId: id,
    causalGroupId: `group-${id}`,
    startMs: 800,
    peakMs: 1000,
    endMs: 1200,
    peakValue: 5000,
    usageEngaged: true,
    usageEvaluable: true,
    usedSpellIds: [100],
    applicableCandidates: [candidate()],
    responseVerdict: 'covered_verified',
    responseReason: 'Human text is never parsed.',
    coveredBySpellId: 100,
    planAssignmentId: null,
    planVerdict: null,
    evidence: { dominantAbilityGameId: 999, decisiveSpellIds: [100] },
    confidence: 'verified',
    ...overrides,
  };
}

function pull(overrides: Partial<DefensiveAuditPullInput> = {}): DefensiveAuditPullInput {
  return {
    pullId: 'pull-1',
    reportCode: 'Report123',
    fightId: 7,
    bossId: 'boss-1',
    bossName: 'Boss de prueba',
    difficulty: 'Mythic',
    pullNumber: 3,
    canonical: true,
    evaluationEndMs: null,
    playerParticipated: true,
    buildFingerprint: 'build-a',
    defensiveCasts: [{ spellId: 100, name: 'Guardia de prueba', timestampsMs: [900] }],
    mechanicNamesByAbilityId: { '999': 'Golpe de prueba' },
    ...overrides,
  };
}

function row(episodes: PersistedDefensiveEpisode[] = [episode()], overrides: Partial<DefensiveAuditEvaluationRowInput> = {}): DefensiveAuditEvaluationRowInput {
  return {
    pullId: 'pull-1',
    playerName: 'Jugador',
    episodeEvaluatorVersion: 'episode-evaluator@8',
    semanticVersion: 'defensive-semantics@1.0.0',
    semanticResolverVersion: 'effective-defensive-semantics@1.5.0',
    resolverVersion: 'effective-defensives@2.1.0',
    buildFingerprint: 'build-a',
    effectiveKit: [CORE],
    episodes,
    evaluatedAt: '2026-09-08T08:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<BuildDefensiveNightAuditInput> = {}): BuildDefensiveNightAuditInput {
  return {
    reportCode: 'Report123',
    playerName: 'Jugador',
    generatedAt: '2026-09-08T09:00:00.000Z',
    pointerStable: true,
    generation: {
      id: 'generation-8',
      status: 'published',
      publishedAt: '2026-09-08T08:30:00.000Z',
      evaluatorVersion: 'episode-evaluator@8',
      episodeVersion: 'episode-evaluator@8',
      resolverVersion: 'effective-defensives@2.1.0',
      semanticResolverVersion: 'effective-defensive-semantics@1.5.0',
      semanticVersion: 'defensive-semantics@1.0.0',
      gameBuild: '12.1.0.68914',
    },
    pulls: [pull()],
    rows: [row()],
    ...overrides,
  };
}

function auditWith(
  castTimes: number[],
  persistedEpisode: PersistedDefensiveEpisode,
  kit: EffectiveDefensiveAuditFact[] = [CORE],
  pullOverrides: Partial<DefensiveAuditPullInput> = {},
) {
  return buildDefensiveNightAudit(input({
    pulls: [pull({ defensiveCasts: [{ spellId: 100, name: CORE.name, timestampsMs: castTimes }], ...pullOverrides })],
    rows: [row([persistedEpisode], { effectiveKit: kit })],
  }));
}

describe('player defensive audit — timing and cast projection', () => {
  it('1. before_or_during cubierto', () => {
    const audit = auditWith([900], episode());
    expect(audit.casts[0].primaryClassification).toBe('effective');
    expect(audit.casts[0].associations[0].gaveResponseCredit).toBe(true);
  });

  it('2. cast después del pico', () => {
    const late = candidate({
      temporalCastCoverage: 'no', statusAtPeak: 'available_unused',
      evidence: { temporal: { timingRelation: 'before_or_during', relevantCasts: [1100], prePeakCasts: [], theoreticallyCoveringCasts: [] } },
      castsForSpellMs: [1100],
    });
    const audit = auditWith([1100], episode('late', { responseVerdict: 'missed_ready', coveredBySpellId: null, applicableCandidates: [late] }));
    expect(audit.casts[0].associations[0].reasonCode).toBe('late_after_peak');
    expect(audit.casts[0].associations[0].deltaFromPeakMs).toBe(100);
  });

  it('3. cast demasiado temprano y expirado', () => {
    const early = candidate({
      temporalCastCoverage: 'no', statusAtPeak: 'available_unused',
      evidence: { temporal: { timingRelation: 'before_or_during', relevantCasts: [700], prePeakCasts: [700], theoreticallyCoveringCasts: [] } },
      castsForSpellMs: [700],
    });
    const audit = auditWith([700], episode('early', { responseVerdict: 'missed_ready', coveredBySpellId: null, applicableCandidates: [early] }));
    expect(audit.casts[0].associations[0].reasonCode).toBe('effect_expired_before_peak');
  });

  it('4. cast fuera de presión', () => {
    const outside = candidate({ castsForSpellMs: [100] });
    const audit = auditWith([100], episode('outside', { applicableCandidates: [outside] }));
    expect(audit.casts[0].primaryClassification).toBe('outside_evaluable_pressure');
    expect(audit.casts[0].associations).toEqual([]);
  });

  it('5. after_damage correcto', () => {
    const reactive = candidate({
      evidence: { temporal: { timingRelation: 'after_damage', windows: [{ hitMs: 1000, endMs: 1300 }], relevantCasts: [1100] } },
      castsForSpellMs: [1100],
      timing: { timingRelation: 'after_damage', effectiveDurationMs: 0, afterDamageResponseWindowMs: 300, evaluationEndMs: null },
    });
    const audit = auditWith([1100], episode('reactive', { applicableCandidates: [reactive] }));
    expect(audit.casts[0].primaryClassification).toBe('effective');
  });

  it('6. after_damage fuera de respuesta', () => {
    const reactive = candidate({
      temporalCastCoverage: 'no', statusAtPeak: 'available_unused',
      evidence: { temporal: { timingRelation: 'after_damage', windows: [{ hitMs: 800, endMs: 900 }], relevantCasts: [] } },
      castsForSpellMs: [1100],
      timing: { timingRelation: 'after_damage', effectiveDurationMs: 0, afterDamageResponseWindowMs: 100, evaluationEndMs: null },
    });
    const audit = auditWith([1100], episode('reactive-late', { responseVerdict: 'missed_ready', coveredBySpellId: null, applicableCandidates: [reactive] }));
    expect(audit.casts[0].associations[0].reasonCode).toBe('reactive_window_missed');
  });

  it('7. either acepta la vía proactiva persistida', () => {
    const either = candidate({
      evidence: { temporal: { timingRelation: 'either', proactive: { castCoverage: 'yes', evidence: { relevantCasts: [900], prePeakCasts: [900], theoreticallyCoveringCasts: [900] } }, reactive: { castCoverage: 'no', evidence: { windows: [], relevantCasts: [] } } } },
      timing: { timingRelation: 'either', effectiveDurationMs: 500, afterDamageResponseWindowMs: 300, evaluationEndMs: null },
    });
    expect(auditWith([900], episode('either-pro', { applicableCandidates: [either] })).casts[0].primaryClassification).toBe('effective');
  });

  it('8. either acepta la vía reactiva persistida', () => {
    const either = candidate({
      evidence: { temporal: { timingRelation: 'either', proactive: { castCoverage: 'no', evidence: { relevantCasts: [] } }, reactive: { castCoverage: 'yes', evidence: { windows: [{ hitMs: 1000, endMs: 1300 }], relevantCasts: [1100] } } } },
      castsForSpellMs: [1100],
      timing: { timingRelation: 'either', effectiveDurationMs: 500, afterDamageResponseWindowMs: 300, evaluationEndMs: null },
    });
    expect(auditWith([1100], episode('either-react', { applicableCandidates: [either] })).casts[0].primaryClassification).toBe('effective');
  });

  it('9. continuous_state con aura observada', () => {
    const continuous = candidate({
      evidence: { temporal: { timingRelation: 'continuous_state', observedInterval: { startMs: 850, endMs: 1100 }, establishingCasts: [850] } },
      castsForSpellMs: [850],
      timing: { timingRelation: 'continuous_state', effectiveDurationMs: 500, afterDamageResponseWindowMs: 300, evaluationEndMs: null },
    });
    expect(auditWith([850], episode('continuous', { applicableCandidates: [continuous] })).casts[0].primaryClassification).toBe('effective');
  });

  it('10. continuous_state sin aura permanece incierto', () => {
    const continuous = candidate({
      temporalCastCoverage: 'unknown', coverageConfidence: 'uncertain', confidence: 'uncertain',
      evidence: { temporal: { timingRelation: 'continuous_state', relevantCasts: [900] } },
      timing: { timingRelation: 'continuous_state', effectiveDurationMs: 500, afterDamageResponseWindowMs: 300, evaluationEndMs: null },
    });
    const audit = auditWith([900], episode('continuous-unknown', { responseVerdict: 'uncertain', coveredBySpellId: null, applicableCandidates: [continuous], confidence: 'uncertain' }));
    expect(audit.casts[0].primaryClassification).toBe('relevant_uncertain');
  });

  it('11. timingRelation unknown nunca inventa cobertura', () => {
    const unknown = candidate({
      temporalOpportunity: 'unknown', temporalCastCoverage: 'unknown', confidence: 'uncertain',
      evidence: { temporal: { timingRelation: null, relevantCasts: [900] } },
      timing: { timingRelation: null, effectiveDurationMs: 500, afterDamageResponseWindowMs: 300, evaluationEndMs: null },
    });
    const audit = auditWith([900], episode('unknown', { responseVerdict: 'uncertain', coveredBySpellId: null, applicableCandidates: [unknown], confidence: 'uncertain' }));
    expect(audit.casts[0].associations[0].reasonCode).toBe('timing_unknown');
  });
});

describe('player defensive audit — actionable windows and alternatives', () => {
  const missed = (c: PersistedEpisodeVerdictCandidate) => episode('missed', {
    responseVerdict: 'missed_ready', coveredBySpellId: null, usageEngaged: false, usedSpellIds: [], applicableCandidates: [c],
  });

  it('12. cooldown disponible produce ventana proactiva', () => {
    const ready = candidate({ engagement: false, temporalCastCoverage: 'no', statusAtPeak: 'available_unused', castsForSpellMs: [] });
    expect(actionableTimingWindow(CORE, ready, missed(ready))).toMatchObject({ status: 'verified', earliestMs: 500, latestMs: 1000 });
  });

  it('13. cooldown no disponible no produce recomendación', () => {
    const unavailable = candidate({ statusAtPeak: 'on_cooldown', castsForSpellMs: [600] });
    expect(actionableTimingWindow(CORE, unavailable, missed(unavailable)).status).toBe('unavailable');
  });

  it('14. múltiples charges usan el modelo de cargas', () => {
    const fact = { ...CORE, charges: 2, rechargeMs: 500 };
    const ready = candidate({ statusAtPeak: 'available_unused', castsForSpellMs: [0] });
    expect(actionableTimingWindow(fact, ready, missed(ready)).status).toBe('verified');
  });

  it('15. recharge recupera una carga dentro de la ventana', () => {
    const fact = { ...CORE, charges: 2, rechargeMs: 500 };
    const ready = candidate({ statusAtPeak: 'available_unused', castsForSpellMs: [0, 100] });
    const result = actionableTimingWindow(fact, ready, missed(ready));
    expect(result.latestMs).toBe(1000);
    expect(result.earliestMs).toBeGreaterThanOrEqual(500);
  });

  it('16. talento/CDR usa el cooldown efectivo persistido', () => {
    const fact = { ...CORE, effectiveCooldownMs: 400, effectiveDurationMs: 200 };
    const ready = candidate({ statusAtPeak: 'available_unused', castsForSpellMs: [300] });
    const result = actionableTimingWindow(fact, ready, missed(ready));
    expect(result).toMatchObject({ status: 'verified', earliestMs: 800, latestMs: 1000 });
  });

  it('17. otro defensivo disponible se conserva como alternativa real', () => {
    const ready = candidate({ engagement: false, temporalCastCoverage: 'no', statusAtPeak: 'available_unused', castsForSpellMs: [] });
    const audit = auditWith([], missed(ready));
    expect(audit.episodes[0].alternatives.map((item) => item.spellId)).toEqual([100]);
  });

  it('18. disponibilidad con confidence insuficiente no se recomienda', () => {
    const weak = candidate({ engagement: false, temporalCastCoverage: 'no', statusAtPeak: 'available_unused', availabilityConfidence: 'fallback', castsForSpellMs: [] });
    expect(auditWith([], missed(weak)).episodes[0].alternatives).toEqual([]);
  });

  it('19. credit_only no crea universo core ni alternativa punitiva', () => {
    const creditFact = { ...CORE, createsMissableOpportunity: false, opportunityMode: 'credit_only' as const };
    const creditCandidate = candidate({ createsMissableOpportunity: false });
    const audit = auditWith([900], episode('credit', { applicableCandidates: [creditCandidate] }), [creditFact]);
    expect(audit.universe.totalCoreCasts).toBe(0);
    expect(audit.universe.totalCreditOnlyCasts).toBe(1);
  });

  it('20. dos defensivos usados en un episodio preservan ambas asociaciones', () => {
    const secondFact = { ...CORE, spellId: 200, name: 'Segunda guardia' };
    const second = candidate({ spellId: 200 });
    const audit = buildDefensiveNightAudit(input({
      pulls: [pull({ defensiveCasts: [{ spellId: 100, name: CORE.name, timestampsMs: [900] }, { spellId: 200, name: secondFact.name, timestampsMs: [900] }] })],
      rows: [row([episode('two-spells', { usedSpellIds: [100, 200], applicableCandidates: [candidate(), second] })], { effectiveKit: [CORE, secondFact] })],
    }));
    expect(audit.casts).toHaveLength(2);
    expect(audit.casts.every((cast) => cast.associations.length === 1)).toBe(true);
  });

  it('21. dos casts de la misma habilidad mantienen IDs distintos', () => {
    const two = candidate({ evidence: { temporal: { timingRelation: 'before_or_during', relevantCasts: [850, 900], prePeakCasts: [850, 900], theoreticallyCoveringCasts: [850, 900] } }, castsForSpellMs: [850, 900] });
    const audit = auditWith([850, 900], episode('two-casts', { applicableCandidates: [two] }));
    expect(new Set(audit.casts.map((cast) => cast.castId)).size).toBe(2);
  });

  it('22. un cast puede cubrir dos episodios', () => {
    const second = episode('ep-2', { peakMs: 1100, endMs: 1300, applicableCandidates: [candidate()] });
    const audit = buildDefensiveNightAudit(input({ rows: [row([episode(), second])] }));
    expect(audit.casts[0].associations).toHaveLength(2);
    expect(audit.casts[0].associations.every((association) => association.gaveResponseCredit)).toBe(true);
  });

  it('23. un cast puede cubrir un episodio y no otro', () => {
    const notCovering = candidate({ temporalCastCoverage: 'no', evidence: { temporal: { timingRelation: 'before_or_during', relevantCasts: [900], prePeakCasts: [900], theoreticallyCoveringCasts: [] } } });
    const second = episode('ep-2', { peakMs: 1600, endMs: 1700, responseVerdict: 'missed_ready', coveredBySpellId: null, applicableCandidates: [notCovering] });
    const audit = buildDefensiveNightAudit(input({ rows: [row([episode(), second])] }));
    expect(audit.casts[0].associations.map((association) => association.gaveResponseCredit)).toEqual([true, false]);
  });
});

describe('player defensive audit — population, integrity and renderers', () => {
  it('24. episode excluded no genera asociación punitiva', () => {
    const excluded = episode('excluded', { responseVerdict: 'excluded', coveredBySpellId: null, applicableCandidates: [] });
    const audit = auditWith([900], excluded);
    expect(audit.casts[0].primaryClassification).toBe('excluded');
  });

  it('25. wipe cutoff excluye casts posteriores', () => {
    const audit = auditWith([1100], episode(), [CORE], { evaluationEndMs: 1000 });
    expect(audit.casts[0]).toMatchObject({ scope: 'canonical_post_cutoff', primaryClassification: 'excluded' });
  });

  it('26. cero casts reconcilia exactamente', () => {
    const audit = auditWith([], episode('no-casts', { responseVerdict: 'missed_ready', coveredBySpellId: null, usageEngaged: false, usedSpellIds: [], applicableCandidates: [candidate({ engagement: false, temporalCastCoverage: 'no', statusAtPeak: 'available_unused', castsForSpellMs: [] })] }));
    expect(audit.universe.totalCoreCasts).toBe(0);
    expect(Object.values(audit.universe.coreByPrimary).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('27. cero episodios con fila segura es available real', () => {
    const audit = buildDefensiveNightAudit(input({ pulls: [pull({ defensiveCasts: [] })], rows: [row([])] }));
    expect(audit.state).toBe('available');
    expect(audit.universe.totalEpisodes).toBe(0);
    expect(renderDefensiveNarrativePlainText(audit.narrative!)).toContain('No se detectaron episodios defensivos evaluables');
  });

  it('28. generación parcial no produce narrativa ni Discord', () => {
    const audit = buildDefensiveNightAudit(input({
      pulls: [pull(), pull({ pullId: 'pull-2', fightId: 8, pullNumber: 4 })],
      rows: [row()],
    }));
    expect(audit).toMatchObject({ state: 'partial', narrative: null, discordParts: [] });
    expect(audit.statusMessage).toContain('1/2');
  });

  it('29. generación incompatible no explica hechos', () => {
    const audit = buildDefensiveNightAudit(input({ generation: { ...input().generation!, evaluatorVersion: 'episode-evaluator@7', episodeVersion: 'episode-evaluator@7' } }));
    expect(audit).toMatchObject({ state: 'incompatible', narrative: null });
  });

  it('30. cambio de pointer durante lectura falla cerrado', () => {
    expect(buildDefensiveNightAudit(input({ pointerStable: false })).state).toBe('incompatible');
  });

  it('31. pullId conserva su fightId y ordinal visual', () => {
    const audit = buildDefensiveNightAudit(input());
    expect(audit.episodes[0]).toMatchObject({ pullId: 'pull-1', pullNumber: 3, fightId: 7 });
  });

  it('32. WCL URL usa fightId, nunca pullNumber', () => {
    expect(wclFightUrl('Report123', 7)).toBe('https://www.warcraftlogs.com/reports/Report123#fight=7');
  });

  it('33. Discord Markdown contiene el link WCL íntegro', () => {
    const audit = buildDefensiveNightAudit(input());
    expect(audit.discordParts.join('\n')).toContain('[Pull #3](https://www.warcraftlogs.com/reports/Report123#fight=7)');
  });

  it('34. Discord chunking nunca supera 2000', () => {
    const narrative: DefensiveAuditNarrative = { version: DEFENSIVE_NIGHT_AUDIT_VERSION, blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', value: `${'frase corta. '.repeat(500)}` }] }] };
    const parts = chunkDefensiveNarrativeForDiscord(narrative);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 2000)).toBe(true);
  });

  it('35. un link cerca del límite no se corta', () => {
    const url = wclFightUrl('Report123', 7);
    const link = `[Pull #3](${url})`;
    const narrative: DefensiveAuditNarrative = {
      version: DEFENSIVE_NIGHT_AUDIT_VERSION,
      blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', value: `${'x'.repeat(1940)}. ` }, { kind: 'pull_link', value: 'Pull #3', reportCode: 'Report123', pullId: 'pull-1', pullNumber: 3, fightId: 7, url }] }],
    };
    const parts = chunkDefensiveNarrativeForDiscord(narrative);
    expect(parts.some((part) => part.includes(link))).toBe(true);
    expect(parts.every((part) => !part.includes('[Pull #3]') || part.includes(link))).toBe(true);
  });

  it('36. envío parcial informa índice y progreso exactos', async () => {
    const sender = vi.fn(async (_content: string, index: number) => {
      if (index === 2) throw new Error('fallo de red');
      return `message-${index}`;
    });
    await expect(sendDiscordParts(['a', 'b', 'c', 'd'], 0, sender)).resolves.toEqual({
      ok: false,
      messageIds: ['message-0', 'message-1'],
      parts: 4,
      sentParts: 2,
      failedPartIndex: 2,
      error: 'fallo de red',
    });
  });

  it('37. ausencia de canal vinculado deshabilita envío', () => {
    const audit = buildDefensiveNightAudit(input());
    expect(defensiveAuditDiscordSendDisabled(audit, 123, false, 'idle')).toBe(true);
  });

  it('38. estado sending evita doble click', () => {
    const audit = buildDefensiveNightAudit(input());
    expect(defensiveAuditDiscordSendDisabled(audit, 123, true, 'sending')).toBe(true);
  });

  it('39. mismatch de integridad por cast duplicado falla cerrado', () => {
    const audit = buildDefensiveNightAudit(input({ pulls: [pull({ defensiveCasts: [{ spellId: 100, name: CORE.name, timestampsMs: [900, 900] }] })] }));
    expect(audit.state).toBe('incompatible');
    expect(audit.integrityIssues.some((issue) => issue.startsWith('duplicate_cast_id:'))).toBe(true);
  });

  it('40. mismo input produce auditoría y narrativa deterministas', () => {
    const first = buildDefensiveNightAudit(input());
    const second = buildDefensiveNightAudit(input());
    expect(second).toEqual(first);
  });

  it('rechaza coveredBySpellId que no existe como candidato', () => {
    const audit = buildDefensiveNightAudit(input({ rows: [row([episode('bad-covered', { applicableCandidates: [] })])] }));
    expect(audit.state).toBe('incompatible');
    expect(audit.integrityIssues).toContain('covered_spell_not_candidate:bad-covered:100');
  });

  it('reconcilia numerador/denominador con el agregador canónico', () => {
    const missedEpisode = episode('missed-2', { responseVerdict: 'missed_ready', coveredBySpellId: null, usageEngaged: false, usedSpellIds: [], applicableCandidates: [candidate({ engagement: false, temporalCastCoverage: 'no', statusAtPeak: 'available_unused' })] });
    const audit = buildDefensiveNightAudit(input({ rows: [row([episode(), missedEpisode])] }));
    expect(audit.usage).toMatchObject({ engaged: 1, evaluable: 2, score: 50 });
    expect(audit.response).toMatchObject({ covered: 1, evaluable: 2, score: 50, missedReady: 1 });
  });

  it('formatea tiempos relativos sin redondear antes de clasificar', () => {
    expect(formatFightTime(137_400)).toBe('02:17.400');
    expect(formatDelta(-2780)).toBe('−2,78 s');
    expect(formatDelta(1450)).toBe('+1,45 s');
  });

  it('un cast fuera de presión no se denomina error en la narrativa', () => {
    const outside = candidate({ castsForSpellMs: [100] });
    const audit = auditWith([100], episode('outside-copy', { applicableCandidates: [outside] }));
    const narrative = renderDefensiveNarrativePlainText(audit.narrative!);
    expect(narrative).toContain('no se asociaron a presión evaluable');
    expect(narrative).toContain('no se consideran errores');
    expect(narrative).not.toContain('desperdiciaste');
  });

  it('evidencia runtime incompleta bajo v8 falla cerrada', () => {
    const incomplete = candidate({ timing: undefined, availabilityAtPeak: undefined });
    const audit = auditWith([900], episode('missing-v8', { applicableCandidates: [incomplete] }));
    expect(audit.state).toBe('incompatible');
    expect(audit.integrityIssues).toContain('candidate_missing_v8_evidence:missing-v8:100');
  });

  it('fingerprint de staging distinto al pull falla cerrado', () => {
    const audit = buildDefensiveNightAudit(input({ rows: [row([episode()], { buildFingerprint: 'build-b' })] }));
    expect(audit.state).toBe('incompatible');
    expect(audit.integrityIssues).toContain('build_fingerprint_mismatch:pull-1');
  });

  it('un pull excluido sin fingerprint no hereda un kit ajeno', () => {
    const audit = buildDefensiveNightAudit(input({
      pulls: [
        pull(),
        pull({
          pullId: 'pull-excluded',
          fightId: 8,
          pullNumber: null,
          canonical: false,
          buildFingerprint: null,
          defensiveCasts: [{ spellId: 100, name: CORE.name, timestampsMs: [400] }],
        }),
      ],
    }));
    expect(audit.state).toBe('available');
    expect(audit.casts.find((cast) => cast.pullId === 'pull-excluded')?.resourceUniverse).toBe('non_personal_or_unresolved');
    expect(renderDefensiveNarrativePlainText(audit.narrative!)).toContain('no se presentan como cooldowns personales');
  });
});
