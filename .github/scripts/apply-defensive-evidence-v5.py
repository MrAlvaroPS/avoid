from pathlib import Path
import re

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text()

def write(path, text):
    (ROOT / path).write_text(text)

def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, got {n}')
    return text.replace(old, new, 1)

# -----------------------------------------------------------------------------
# effective-defensives.ts: field-scoped provenance/confidence + source priority
# + explicit baseline modifier presence.
# -----------------------------------------------------------------------------
p = 'supabase/functions/_shared/effective-defensives.ts'
s = read(p)
s = s.replace("export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION = 'effective-defensives@2.1.0';", "export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION = 'effective-defensives@2.2.0';")
s = s.replace("export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION = 'effective-defensive-semantics@1.3.2';", "export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION = 'effective-defensive-semantics@1.4.0';")

s = replace_once(s,
"  baseDurationMs: number | null;\n  excluded?: boolean;\n}",
"  baseDurationMs: number | null;\n  /** Exact-current reviewed catalog rows are authoritative over legacy spec profiles for the same field. Undefined keeps unit-test/backward compatibility; DB adapter always sets it explicitly. */\n  reviewed?: boolean;\n  excluded?: boolean;\n}", 'catalog reviewed field')

s = replace_once(s,
"  source?: string | null;\n  active: boolean;\n}",
"  source?: string | null;\n  active: boolean;\n  /** How the modifier itself is present in the build. talent_selected requires a selected node; spec_baseline is auto-granted by the resolved spec. */\n  presenceMode?: 'talent_selected' | 'spec_baseline';\n}", 'modifier presenceMode field')

s = replace_once(s,
"  effectiveDurationMs: number | null;\n  charges: number;\n  rechargeMs: number | null;\n  eligible: boolean;",
"  effectiveDurationMs: number | null;\n  charges: number;\n  rechargeMs: number | null;\n  /** Claim-scoped source confidence. These fields deliberately do not collapse unrelated uncertainty into one global confidence. */\n  cooldownConfidence?: DefensiveResolutionConfidence;\n  durationConfidence?: DefensiveResolutionConfidence;\n  chargesConfidence?: DefensiveResolutionConfidence;\n  rechargeConfidence?: DefensiveResolutionConfidence;\n  eligible: boolean;", 'resolved field confidences')

s = replace_once(s,
"      baseCooldownMs: nullableNumber(row['base_cooldown_ms']),\n      baseDurationMs: nullableNumber(row['base_duration_ms']),\n      excluded: row['excluded'] === true,",
"      baseCooldownMs: nullableNumber(row['base_cooldown_ms']),\n      baseDurationMs: nullableNumber(row['base_duration_ms']),\n      reviewed: row['reviewed'] === true,\n      excluded: row['excluded'] === true,", 'parse catalog reviewed')

s = replace_once(s,
"      source: nullableString(row['source']),\n      active: row['active'] !== false,\n    })),",
"      source: nullableString(row['source']),\n      active: row['active'] !== false,\n      presenceMode: row['presence_mode'] === 'spec_baseline' ? 'spec_baseline' : 'talent_selected',\n    })),", 'parse modifier presence mode')

s = replace_once(s,
"      let rechargeMs: number | null = null;\n      let targetingMode = TARGETING_MODES.has(entry.targetingMode) ? entry.targetingMode : 'unknown';",
"      let rechargeMs: number | null = null;\n      // §E8-v5: field-scoped authority. Exact-current + reviewed catalog facts are\n      // strong for cooldown/duration. A legacy spec profile may remain provenance,\n      // but it cannot downgrade or overwrite those stronger fields.\n      const catalogBuildConfidence: DefensiveResolutionConfidence =\n        input.gameBuild != null && entry.activationGameBuild === input.gameBuild\n          ? entry.reviewed === false\n            ? 'inferred'\n            : gameBuildConfidence\n          : 'fallback';\n      let cooldownConfidence: DefensiveResolutionConfidence = cooldownMs == null ? 'uncertain' : catalogBuildConfidence;\n      let durationConfidence: DefensiveResolutionConfidence = durationMs == null ? 'uncertain' : catalogBuildConfidence;\n      // cooldown_catalog does not carry a charge column. One charge is therefore\n      // an inferred baseline until an exact profile/modifier proves otherwise.\n      let chargesConfidence: DefensiveResolutionConfidence = input.gameBuild != null ? 'inferred' : 'fallback';\n      let rechargeConfidence: DefensiveResolutionConfidence = 'uncertain';\n      let targetingMode = TARGETING_MODES.has(entry.targetingMode) ? entry.targetingMode : 'unknown';", 'initialize field confidences')

# Replace the entire spec profile application block up to targetRules.
start = s.index("      const profileCandidates = data.specProfiles.filter(")
end = s.index("      const targetRules = data.modifierRules.filter(", start)
old_block = s[start:end]
new_block = """      const profileCandidates = data.specProfiles.filter(
        (profile) => profile.className === input.className && profile.specName === input.specName && profile.spellId === entry.spellId,
      );
      const selectedProfile = profileForBuild(profileCandidates, input.gameBuild);
      if (selectedProfile) {
        const { profile, buildConfidence } = selectedProfile;
        const profileConfidence = buildConfidence === 'verified' ? gameBuildConfidence : buildConfidence;
        const exactReviewedCatalog =
          input.gameBuild != null && entry.activationGameBuild === input.gameBuild && entry.reviewed !== false;
        const legacyBlockedByCatalog = buildConfidence === 'fallback' && exactReviewedCatalog;

        const applyProfileTimingField = (
          field: 'cooldown_ms' | 'duration_ms',
          value: number | null,
        ): void => {
          if (value == null) return;
          const before = field === 'cooldown_ms' ? cooldownMs : durationMs;
          if (legacyBlockedByCatalog && before != null) {
            provenance.push({
              kind: 'validation',
              field,
              before,
              after: before,
              source: profile.source,
              description:
                value === before
                  ? 'Perfil legacy redundante: coincide con el catálogo exact-current revisado y se conserva solo como provenance; no degrada confidence.'
                  : `Perfil legacy ignorado por menor autoridad: propone ${value}, pero el catálogo exact-current revisado demuestra ${before}.`,
              gameBuild: profile.gameBuild,
            });
            return;
          }
          provenance.push({
            kind: 'spec_profile',
            field,
            before,
            after: value,
            source: profile.source,
            description: profile.sourceNote ?? `El perfil de spec sustituye ${field}.`,
            gameBuild: profile.gameBuild,
          });
          if (field === 'cooldown_ms') {
            cooldownMs = value;
            cooldownConfidence = profileConfidence;
          } else {
            durationMs = value;
            durationConfidence = profileConfidence;
          }
          confidence = weakerConfidence(confidence, profileConfidence);
        };

        applyProfileTimingField('cooldown_ms', profile.baseCooldownMs);
        applyProfileTimingField('duration_ms', profile.baseDurationMs);

        // Charges/recharge have no catalog-base columns. A legacy profile may
        // still provide them, but the availability claim remains fallback until
        // an exact profile or exact modifier proves the value.
        if (!(legacyBlockedByCatalog && profile.charges === charges)) {
          provenance.push({
            kind: 'spec_profile',
            field: 'charges',
            before: charges,
            after: profile.charges,
            source: profile.source,
            description: profile.sourceNote ?? 'Cargas base del perfil de spec.',
            gameBuild: profile.gameBuild,
          });
          charges = profile.charges;
          chargesConfidence = profileConfidence;
          confidence = weakerConfidence(confidence, profileConfidence);
        } else {
          provenance.push({
            kind: 'validation',
            field: 'charges',
            before: charges,
            after: charges,
            source: profile.source,
            description: 'Perfil legacy redundante de una carga: no degrada la confidence de otros campos.',
            gameBuild: profile.gameBuild,
          });
        }
        if (profile.rechargeMs != null) {
          provenance.push({
            kind: 'spec_profile',
            field: 'recharge_ms',
            before: rechargeMs,
            after: profile.rechargeMs,
            source: profile.source,
            description: profile.sourceNote ?? 'Recarga base del perfil de spec.',
            gameBuild: profile.gameBuild,
          });
          rechargeMs = profile.rechargeMs;
          rechargeConfidence = profileConfidence;
          confidence = weakerConfidence(confidence, profileConfidence);
        }
      }

"""
s = s[:start] + new_block + s[end:]

# Only talent-selected modifiers need build-node evidence. Baseline spec passives apply from the spec itself.
s = replace_once(s,
"      const candidateRules = targetRules.filter(\n        (rule) => rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName)),\n      );\n      if (input.specName == null && targetRules.some((rule) => rule.specNames != null)) {",
"      const candidateRules = targetRules.filter(\n        (rule) => rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName)),\n      );\n      const talentSelectedCandidateRules = candidateRules.filter((rule) => (rule.presenceMode ?? 'talent_selected') === 'talent_selected');\n      if (input.specName == null && targetRules.some((rule) => rule.specNames != null)) {", 'split modifier presence')
s = s.replace("      if (candidateRules.length && normalizedBuild == null) {", "      if (talentSelectedCandidateRules.length && normalizedBuild == null) {", 1)
s = s.replace("      } else if (candidateRules.length && unresolvedSelectedNodes) {", "      } else if (talentSelectedCandidateRules.length && unresolvedSelectedNodes) {", 1)
s = replace_once(s,
"        .filter(({ rule }) => rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName)))\n        .filter(({ rule }) => ranks.has(rule.modifierSpellId))",
"        .filter(({ rule }) => rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName)))\n        .filter(({ rule }) => (rule.presenceMode ?? 'talent_selected') === 'spec_baseline' || ranks.has(rule.modifierSpellId))", 'baseline modifier applicability')

s = replace_once(s,
"        const rank = ranks.get(rule.modifierSpellId) ?? 0;\n        const amount = ruleValue(rule, rank);",
"        const rank = (rule.presenceMode ?? 'talent_selected') === 'spec_baseline' ? 1 : (ranks.get(rule.modifierSpellId) ?? 0);\n        const amount = ruleValue(rule, rank);", 'baseline modifier rank')

# Update field confidence after a successful modifier write.
s = replace_once(s,
"        writeField(rule.effectField, after);\n        provenance.push({ ...stepBase, kind: 'modifier', after });",
"        writeField(rule.effectField, after);\n        const modifierConfidence = buildConfidence === 'verified' ? gameBuildConfidence : buildConfidence;\n        const combineFieldConfidence = (current: DefensiveResolutionConfidence): DefensiveResolutionConfidence =>\n          rule.operation === 'set_ms' ? modifierConfidence : weakerConfidence(current, modifierConfidence);\n        if (rule.effectField === 'cooldown_ms') cooldownConfidence = combineFieldConfidence(cooldownConfidence);\n        else if (rule.effectField === 'duration_ms') durationConfidence = combineFieldConfidence(durationConfidence);\n        else if (rule.effectField === 'charges') chargesConfidence = combineFieldConfidence(chargesConfidence);\n        else rechargeConfidence = combineFieldConfidence(rechargeConfidence);\n        provenance.push({ ...stepBase, kind: 'modifier', after });", 'modifier field confidence')

# Override gives exact player/build evidence for the field it replaces.
s = replace_once(s,
"          writeField(field, value);\n          provenance.push({",
"          writeField(field, value);\n          const overrideConfidence: DefensiveResolutionConfidence = override.buildFingerprint == null ? 'inferred' : 'verified';\n          if (field === 'cooldown_ms') cooldownConfidence = overrideConfidence;\n          else if (field === 'duration_ms') durationConfidence = overrideConfidence;\n          else if (field === 'charges') chargesConfidence = overrideConfidence;\n          else rechargeConfidence = overrideConfidence;\n          provenance.push({", 'override field confidence')

s = replace_once(s,
"      if (charges > 1 && rechargeMs == null && cooldownMs != null) {\n        rechargeMs = cooldownMs;",
"      if (charges > 1 && rechargeMs == null && cooldownMs != null) {\n        rechargeMs = cooldownMs;\n        rechargeConfidence = weakerConfidence(cooldownConfidence, chargesConfidence);", 'derived recharge confidence')

s = replace_once(s,
"        charges,\n        rechargeMs,\n        eligible,",
"        charges,\n        rechargeMs,\n        cooldownConfidence,\n        durationConfidence,\n        chargesConfidence,\n        rechargeConfidence,\n        eligible,", 'return field confidences')
write(p, s)

# -----------------------------------------------------------------------------
# defensive-temporal-coverage.ts: reactive timing anchored to actual damage hits.
# -----------------------------------------------------------------------------
p = 'supabase/functions/_shared/defensive-temporal-coverage.ts'
s = read(p)
s = replace_once(s,
"  episode: TemporalEpisodeWindow;\n  /** Política explícita del Episode Evaluator",
"  episode: TemporalEpisodeWindow;\n  /** Timestamps de daño crudo que realmente pertenecen al episodio. after_damage se ancla a estos hits, no al borde agregado del episodio. */\n  damageTimestampsMs?: readonly number[];\n  /** Política explícita del Episode Evaluator", 'temporal damage timestamps')
old = """function afterDamage(input: TemporalCoverageInput): CoreResult {
  const windowEndMs = Math.min(
    input.episode.endMs + input.afterDamageResponseWindowMs,
    input.evaluationEndMs ?? Number.POSITIVE_INFINITY,
  );
  const relevantCasts = input.castsForSpellMs.filter((t) => t >= input.episode.startMs && t <= windowEndMs);
  const engagement = relevantCasts.length > 0;
  return {
    engagement,
    castCoverage: engagement ? 'yes' : 'no',
    reason: engagement
      ? `Cast reactivo dentro de la ventana de respuesta explícita (${input.afterDamageResponseWindowMs}ms tras el episodio).`
      : `Ningún cast dentro de la ventana de respuesta reactiva (${input.afterDamageResponseWindowMs}ms tras el episodio).`,
    evidence: { windowEndMs },
  };
}
"""
new = """function afterDamage(input: TemporalCoverageInput): CoreResult {
  const cutoff = input.evaluationEndMs ?? Number.POSITIVE_INFINITY;
  const damageTimestamps = normalizeCastTimestamps(input.damageTimestampsMs ?? []);
  if (damageTimestamps.length) {
    const windows = damageTimestamps.map((hitMs) => ({
      hitMs,
      endMs: Math.min(hitMs + input.afterDamageResponseWindowMs, cutoff),
    }));
    const relevantCasts = input.castsForSpellMs.filter((castMs) =>
      windows.some((window) => castMs >= window.hitMs && castMs <= window.endMs),
    );
    const engagement = relevantCasts.length > 0;
    return {
      engagement,
      castCoverage: engagement ? 'yes' : 'no',
      reason: engagement
        ? `Cast reactivo dentro de ${input.afterDamageResponseWindowMs}ms de un hit real del episodio.`
        : `Ningún cast dentro de ${input.afterDamageResponseWindowMs}ms de los hits reales del episodio.`,
      evidence: { anchor: 'raw_damage_hits', windows, relevantCasts },
    };
  }

  // Compatibility fallback for pure callers/tests that do not have raw hits.
  // Canonical E6 callers pass damageTimestampsMs and therefore never depend on
  // this aggregate-window approximation.
  const windowEndMs = Math.min(
    input.episode.endMs + input.afterDamageResponseWindowMs,
    cutoff,
  );
  const relevantCasts = input.castsForSpellMs.filter((t) => t >= input.episode.startMs && t <= windowEndMs);
  const engagement = relevantCasts.length > 0;
  return {
    engagement,
    castCoverage: engagement ? 'yes' : 'no',
    reason: engagement
      ? `Cast reactivo dentro de la ventana agregada de compatibilidad (${input.afterDamageResponseWindowMs}ms).`
      : `Ningún cast dentro de la ventana reactiva agregada de compatibilidad (${input.afterDamageResponseWindowMs}ms).`,
    evidence: { anchor: 'episode_fallback', windowEndMs },
  };
}
"""
s = replace_once(s, old, new, 'after_damage raw-hit anchoring')
write(p, s)

# -----------------------------------------------------------------------------
# defensive-episode-verdict.ts: claim-scoped confidence, core opportunities,
# bonus credit, Usage evaluability independent from Response verdict.
# -----------------------------------------------------------------------------
p = 'supabase/functions/_shared/defensive-episode-verdict.ts'
s = read(p)
s = replace_once(s,
"  confidence: EvaluationConfidence;\n  evidence: Record<string, unknown>;\n}",
"  confidence: EvaluationConfidence;\n  /** Claim-scoped confidence. Optional for backward-compatible fixtures; when absent, confidence is used. */\n  membershipConfidence?: EvaluationConfidence;\n  applicabilityClaimConfidence?: EvaluationConfidence;\n  availabilityConfidence?: EvaluationConfidence;\n  coverageConfidence?: EvaluationConfidence;\n  evidence: Record<string, unknown>;\n}", 'candidate claim confidence')
s = replace_once(s,
"export interface EpisodeVerdictResult {\n  usageEngaged: boolean;\n  usedSpellIds: number[];",
"export interface EpisodeVerdictResult {\n  usageEngaged: boolean;\n  /** True when a real core opportunity was actionable, even if Response itself must remain uncertain. */\n  usageEvaluable: boolean;\n  usedSpellIds: number[];\n  /** Positive non-core defensive actions are preserved without inflating either KPI. */\n  bonusCreditSpellIds: number[];", 'verdict usage and bonus')

start = s.index('export function resolveEpisodeVerdict(candidates: EpisodeVerdictCandidate[]): EpisodeVerdictResult {')
end = s.index('\nexport interface CausalTimingContext', start)
new_func = r'''export function resolveEpisodeVerdict(candidates: EpisodeVerdictCandidate[]): EpisodeVerdictResult {
  const sorted = [...candidates].sort(bySpellId);
  const claim = (c: EpisodeVerdictCandidate, key: 'membershipConfidence' | 'applicabilityClaimConfidence' | 'availabilityConfidence' | 'coverageConfidence') =>
    c[key] ?? c.confidence;
  const strong = (c: EpisodeVerdictCandidate, key: 'membershipConfidence' | 'applicabilityClaimConfidence' | 'availabilityConfidence' | 'coverageConfidence') =>
    isPunitiveConfidence(claim(c, key));

  const engagedKitMembers = sorted.filter((c) => c.isDefensiveKitMember && c.engagement);
  const usageEngaged = engagedKitMembers.length > 0;
  const usedSpellIds = [...new Set(engagedKitMembers.map((c) => c.spellId))].sort((a, b) => a - b);

  // A core opportunity can ONLY be created by normal/missable personal resources
  // with strong membership+applicability evidence. credit_only may resolve this
  // opportunity but can never manufacture its denominator.
  const coreApplicable = sorted.filter(
    (c) =>
      c.createsMissableOpportunity &&
      c.damageApplicability === 'yes' &&
      c.temporalOpportunity === 'yes' &&
      strong(c, 'membershipConfidence') &&
      strong(c, 'applicabilityClaimConfidence'),
  );
  const strongReadyCore = coreApplicable.filter(
    (c) => c.statusAtPeak === 'available_unused' && strong(c, 'availabilityConfidence'),
  );
  const strongActiveCore = coreApplicable.filter(
    (c) => c.statusAtPeak === 'active' && strong(c, 'availabilityConfidence'),
  );
  const usageEvaluableNow = strongReadyCore.length > 0 || strongActiveCore.length > 0;

  const strongCovers = sorted.filter(
    (c) =>
      c.isDefensiveKitMember &&
      c.engagement &&
      c.damageApplicability === 'yes' &&
      c.temporalCastCoverage === 'yes' &&
      strong(c, 'membershipConfidence') &&
      strong(c, 'applicabilityClaimConfidence') &&
      strong(c, 'coverageConfidence'),
  );
  const bonusOnlyCovers = strongCovers.filter((c) => !c.createsMissableOpportunity).map((c) => c.spellId);

  if (coreApplicable.length && strongCovers.length) {
    const winner = strongCovers[0];
    return {
      usageEngaged: true,
      usageEvaluable: true,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'covered_verified',
      reason: `Había una oportunidad defensiva core y spellId ${winner.spellId} la cubrió con evidencia suficiente de membership, aplicabilidad y cobertura.`,
      coveredBySpellId: winner.spellId,
      confidence: claim(winner, 'coverageConfidence'),
      decisiveSpellIds: [winner.spellId],
      uncertaintyBlockers: [],
    };
  }

  // A valid credit_only action outside any core opportunity is useful evidence,
  // but it is bonus context, never a synthetic 100% denominator.
  if (!coreApplicable.length && strongCovers.length) {
    return {
      usageEngaged,
      usageEvaluable: false,
      usedSpellIds,
      bonusCreditSpellIds: [...new Set(bonusOnlyCovers)].sort((a, b) => a - b),
      responseVerdict: 'no_applicable_resource',
      reason: 'Se observó una acción defensiva válida, pero no existía una oportunidad core normal que pudiera crear denominador; se conserva como crédito adicional.',
      coveredBySpellId: null,
      confidence: weakestConfidence(...strongCovers.map((c) => claim(c, 'coverageConfidence'))),
      decisiveSpellIds: [],
      uncertaintyBlockers: [],
    };
  }

  const lowConfidenceCovers = sorted.filter(
    (c) =>
      c.isDefensiveKitMember &&
      c.engagement &&
      c.damageApplicability === 'yes' &&
      c.temporalCastCoverage === 'yes' &&
      (!strong(c, 'membershipConfidence') || !strong(c, 'applicabilityClaimConfidence') || !strong(c, 'coverageConfidence')),
  );
  if (coreApplicable.length && lowConfidenceCovers.length) {
    return {
      usageEngaged,
      usageEvaluable: usageEvaluableNow,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'uncertain',
      reason: 'Hubo una respuesta defensiva candidata, pero la evidencia de cobertura no alcanza el umbral simétrico para dar éxito ni para acusar fallo.',
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: [],
      uncertaintyBlockers: lowConfidenceCovers.map((c) => c.spellId).sort((a, b) => a - b),
    };
  }

  const usedUnknown = sorted.filter(
    (c) =>
      c.isDefensiveKitMember &&
      c.engagement &&
      c.damageApplicability !== 'no' &&
      c.temporalCastCoverage !== 'no' &&
      (c.damageApplicability === 'unknown' || c.temporalCastCoverage === 'unknown'),
  );
  if (coreApplicable.length && usedUnknown.length) {
    return {
      usageEngaged,
      usageEvaluable: usageEvaluableNow,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'uncertain',
      reason: `spellId ${usedUnknown.map((c) => c.spellId).join(', ')} se usó durante una oportunidad core, pero su cobertura de daño/timing no puede demostrarse; Uso puede quedar acreditado sin convertir Response en culpa ni éxito.`,
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: [],
      uncertaintyBlockers: usedUnknown.map((c) => c.spellId),
    };
  }

  if (strongReadyCore.length) {
    const winner = strongReadyCore[0];
    return {
      usageEngaged,
      usageEvaluable: true,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'missed_ready',
      reason: usageEngaged
        ? `Había al menos una respuesta core disponible (spellId ${winner.spellId}); hubo uso defensivo, pero ninguna acción cubrió esta ventana.`
        : `spellId ${winner.spellId} estaba disponible con evidencia suficiente de membership, aplicabilidad y disponibilidad; no hubo respuesta defensiva.`,
      coveredBySpellId: null,
      confidence: weakestConfidence(
        claim(winner, 'membershipConfidence'),
        claim(winner, 'applicabilityClaimConfidence'),
        claim(winner, 'availabilityConfidence'),
      ),
      decisiveSpellIds: [winner.spellId],
      uncertaintyBlockers: [],
    };
  }

  const apparentlyReady = coreApplicable.filter((c) => c.statusAtPeak === 'available_unused');
  if (apparentlyReady.length) {
    return {
      usageEngaged,
      usageEvaluable: false,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'uncertain',
      reason: 'Hay recursos core aparentemente disponibles, pero la evidencia específica de disponibilidad no permite convertirlos en missed_ready.',
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: apparentlyReady.map((c) => c.spellId).sort((a, b) => a - b),
      uncertaintyBlockers: apparentlyReady.map((c) => c.spellId).sort((a, b) => a - b),
      causalUpgradeEligible: false,
    };
  }

  const strategic = sorted.filter((c) => c.createsMissableOpportunity || c.materiallyUnresolved);
  if (!strategic.length) {
    return {
      usageEngaged,
      usageEvaluable: false,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'no_applicable_resource',
      reason: 'El build no tiene ningún recurso personal estratégico normal, resuelto o pendiente de resolver, aplicable a este episodio.',
      coveredBySpellId: null,
      confidence: 'verified',
      decisiveSpellIds: [],
      uncertaintyBlockers: [],
    };
  }

  const relevantStrategic = strategic.filter((c) => c.damageApplicability !== 'no' && c.temporalOpportunity !== 'no');
  if (!relevantStrategic.length) {
    return {
      usageEngaged,
      usageEvaluable: false,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'no_applicable_resource',
      reason: 'El build tenía recursos estratégicos, pero ninguno demuestra aplicabilidad de daño/timing a este episodio.',
      coveredBySpellId: null,
      confidence: weakestConfidence(...strategic.map((c) => c.confidence)),
      decisiveSpellIds: strategic.map((c) => c.spellId).sort((a, b) => a - b),
      uncertaintyBlockers: [],
    };
  }

  const unresolvedBlockers = relevantStrategic.filter(
    (c) =>
      c.materiallyUnresolved ||
      c.damageApplicability === 'unknown' ||
      c.temporalOpportunity === 'unknown' ||
      c.statusAtPeak === 'unknown' ||
      !strong(c, 'membershipConfidence') ||
      !strong(c, 'applicabilityClaimConfidence'),
  );
  if (unresolvedBlockers.length) {
    return {
      usageEngaged,
      usageEvaluable: usageEvaluableNow,
      usedSpellIds,
      bonusCreditSpellIds: [],
      responseVerdict: 'uncertain',
      reason: `spellId ${unresolvedBlockers.map((c) => c.spellId).join(', ')} podría cambiar la evaluación, pero alguna afirmación necesaria todavía no está suficientemente resuelta.`,
      coveredBySpellId: null,
      confidence: 'uncertain',
      decisiveSpellIds: [],
      uncertaintyBlockers: unresolvedBlockers.map((c) => c.spellId).sort((a, b) => a - b),
      causalUpgradeEligible: false,
    };
  }

  return {
    usageEngaged,
    usageEvaluable: false,
    usedSpellIds,
    bonusCreditSpellIds: [],
    responseVerdict: 'uncertain',
    reason: 'Todo lo estratégico y aplicable estaba en cooldown o activo en el pico; se necesita reconstrucción causal para distinguir indisponibilidad legítima.',
    coveredBySpellId: null,
    confidence: 'uncertain',
    decisiveSpellIds: relevantStrategic.map((c) => c.spellId).sort((a, b) => a - b),
    uncertaintyBlockers: relevantStrategic.map((c) => c.spellId).sort((a, b) => a - b),
    causalUpgradeEligible: true,
  };
}
'''
s = s[:start] + new_func + s[end:]

# Causal result confidence uses availability claim where present.
s = s.replace("    confidence: c.confidence,\n    ...reconstructCausalAvailability", "    confidence: c.availabilityConfidence ?? c.confidence,\n    ...reconstructCausalAvailability", 1)
write(p, s)

# -----------------------------------------------------------------------------
# defensive-episode-evaluator.ts: pass raw hit anchors + observed active intervals
# and materialize claim-scoped confidence.
# -----------------------------------------------------------------------------
p = 'supabase/functions/_shared/defensive-episode-evaluator.ts'
s = read(p)
s = s.replace("import { evaluateTemporalCoverage, normalizeCastTimestamps } from './defensive-temporal-coverage.ts';", "import { evaluateTemporalCoverage, normalizeCastTimestamps, type ObservedEffectInterval } from './defensive-temporal-coverage.ts';")
s = replace_once(s,
"  castsBySpellId: ReadonlyMap<number, number[]>;\n  schoolByAbilityId:",
"  castsBySpellId: ReadonlyMap<number, number[]>;\n  /** Buff/aura intervals observed directly in WCL, keyed by defensive spellId. Optional for callers that cannot fetch Buffs yet. */\n  observedActiveIntervalsBySpellId?: ReadonlyMap<number, readonly ObservedEffectInterval[]>;\n  schoolByAbilityId:", 'evaluator observed intervals input')

s = replace_once(s,
"    confidence: 'verified',\n    decisiveSpellIds: [],",
"    confidence: 'verified',\n    usageEvaluable: false,\n    bonusCreditSpellIds: [],\n    decisiveSpellIds: [],", 'excluded verdict new fields')

# apply runtime safety result needs preserve fields via spread, no edit.

s = replace_once(s,
"  afterDamageResponseWindowMs: number,\n  evaluationEndMs: number | null,\n): CausallyAwareCandidate {",
"  afterDamageResponseWindowMs: number,\n  evaluationEndMs: number | null,\n  observedActiveIntervals: readonly ObservedEffectInterval[],\n): CausallyAwareCandidate {", 'buildCandidate intervals arg')

s = replace_once(s,
"    castsForSpellMs,\n    episode: window,\n    afterDamageResponseWindowMs,\n    evaluationEndMs,\n  });",
"    castsForSpellMs,\n    episode: window,\n    damageTimestampsMs: hits.flatMap((hit) => typeof hit.timestamp === 'number' ? [hit.timestamp] : []),\n    afterDamageResponseWindowMs,\n    evaluationEndMs,\n    observedActiveIntervals,\n  });", 'pass damage and intervals')

old_conf = """  const confidence = weakestConfidence(
    r.confidence,
    r.semanticConfidence,
    r.buildPresenceConfidence,
    mapApplicabilityConfidence(r.applicabilityConfidence),
  );

  return {
"""
new_conf = """  const membershipConfidence = weakestConfidence(r.semanticConfidence, r.buildPresenceConfidence);
  const applicabilityClaimConfidence = weakestConfidence(
    membershipConfidence,
    mapApplicabilityConfidence(r.applicabilityConfidence),
  );
  const availabilityConfidence = weakestConfidence(
    membershipConfidence,
    r.cooldownConfidence ?? r.confidence,
    r.chargesConfidence ?? r.confidence,
    r.charges > 1 ? (r.rechargeConfidence ?? r.confidence) : 'verified',
  );
  const intervalCoversPeak = observedActiveIntervals.some(
    (interval) => window.peakMs >= interval.startMs && (interval.endMs == null || window.peakMs <= interval.endMs),
  );
  let temporalCoverageConfidence: EvaluationConfidence = 'verified';
  if (temporal.castCoverage === 'unknown') temporalCoverageConfidence = 'uncertain';
  else if (temporal.castCoverage === 'yes' && !intervalCoversPeak) {
    if (timingRelation === 'before_or_during') temporalCoverageConfidence = r.durationConfidence ?? r.confidence;
    else if (timingRelation === 'either') {
      const reactive = (temporal.evidence as any)?.reactive;
      temporalCoverageConfidence = reactive?.castCoverage === 'yes' ? 'verified' : (r.durationConfidence ?? r.confidence);
    }
  }
  const coverageConfidence = weakestConfidence(applicabilityClaimConfidence, temporalCoverageConfidence);
  const confidence = weakestConfidence(membershipConfidence, applicabilityClaimConfidence, availabilityConfidence, coverageConfidence);

  return {
"""
s = replace_once(s, old_conf, new_conf, 'claim confidence computation')
s = replace_once(s,
"    statusAtPeak,\n    confidence,\n    evidence: { damage: damage.evidence, temporal: temporal.evidence },",
"    statusAtPeak,\n    confidence,\n    membershipConfidence,\n    applicabilityClaimConfidence,\n    availabilityConfidence,\n    coverageConfidence,\n    evidence: {\n      damage: damage.evidence,\n      temporal: temporal.evidence,\n      claimConfidence: { membershipConfidence, applicabilityClaimConfidence, availabilityConfidence, coverageConfidence },\n    },", 'return claim confidence')

s = replace_once(s,
"          afterDamageResponseWindowMs,\n          input.evaluationEndMs,\n        ),",
"          afterDamageResponseWindowMs,\n          input.evaluationEndMs,\n          input.observedActiveIntervalsBySpellId?.get(r.spellId) ?? [],\n        ),", 'buildCandidate observed intervals caller')
write(p, s)

# -----------------------------------------------------------------------------
# Persistence/KPI: Usage denominator is explicit from the verdict, not reverse
# engineered from Response state. Preserve bonus credit in structured evidence.
# -----------------------------------------------------------------------------
p = 'supabase/functions/_shared/defensive-episode-persistence.ts'
s = read(p)
s = s.replace("import { deriveUsageEvaluable as deriveUsageEvaluableFromKpis } from './defensive-episode-kpis.ts';\n", "")
# Keep compatibility export but make it clearly legacy and non-canonical for v5.
s = re.sub(r"/\*\*\n \* §E5 \(iris-defensive-canonicalization-v1-plan\.md §13\.1\).*?export const deriveUsageEvaluable = deriveUsageEvaluableFromKpis;\n", "", s, flags=re.S)
s = replace_once(s,
"  const usageEvaluable = deriveUsageEvaluable(params.verdict.responseVerdict);",
"  const usageEvaluable = params.verdict.usageEvaluable;", 'persist explicit usage evaluable')
s = replace_once(s,
"      uncertaintyBlockers: [...params.verdict.uncertaintyBlockers].sort((a, b) => a - b),\n      ...params.evidence,",
"      uncertaintyBlockers: [...params.verdict.uncertaintyBlockers].sort((a, b) => a - b),\n      bonusCreditSpellIds: [...params.verdict.bonusCreditSpellIds].sort((a, b) => a - b),\n      ...params.evidence,", 'persist bonus credits')
write(p, s)

p = 'supabase/functions/_shared/defensive-episode-kpis.ts'
s = read(p)
s = replace_once(s,
"export function deriveDefensiveEpisodeKpiContribution(\n  episode: Pick<PersistedDefensiveEpisode, 'episodeId' | 'usageEngaged' | 'responseVerdict'>,\n): DefensiveEpisodeKpiContribution {\n  const usageEvaluable = deriveUsageEvaluable(episode.responseVerdict);",
"export function deriveDefensiveEpisodeKpiContribution(\n  episode: Pick<PersistedDefensiveEpisode, 'episodeId' | 'usageEngaged' | 'usageEvaluable' | 'responseVerdict'>,\n): DefensiveEpisodeKpiContribution {\n  const usageEvaluable = episode.usageEvaluable;", 'kpi explicit usage evaluable')
s = replace_once(s,
"  episodes: readonly Pick<PersistedDefensiveEpisode, 'episodeId' | 'usageEngaged' | 'responseVerdict'>[],",
"  episodes: readonly Pick<PersistedDefensiveEpisode, 'episodeId' | 'usageEngaged' | 'usageEvaluable' | 'responseVerdict'>[],", 'aggregate usage evaluable type')
# Retain legacy helper for old callers/tests but document it is no longer used by canonical persistence.
s = s.replace("/**\n * Denominador canónico de Uso", "/**\n * Compatibility helper for pre-v5 callers. Canonical v5 persistence receives usageEvaluable directly from the verdict because Usage can be evaluable while Response is uncertain.\n *\n * Denominador legacy de Uso", 1)
write(p, s)

# -----------------------------------------------------------------------------
# Version bump.
# -----------------------------------------------------------------------------
p = 'supabase/functions/_shared/defensive-episode-ledger-events.ts'
s = read(p)
s = s.replace("export const DEFENSIVE_EPISODE_EVALUATOR_VERSION = 'episode-evaluator@4';", "export const DEFENSIVE_EPISODE_EVALUATOR_VERSION = 'episode-evaluator@5';")
s = s.replace("// @4: `missed_ready` exige además confidence punitiva (verified/inferred).", "// @5: core-opportunity scoring + claim-scoped confidence + raw-hit reactive timing/observed-state support.\n// @4: `missed_ready` exige además confidence punitiva (verified/inferred).")
write(p, s)

# -----------------------------------------------------------------------------
# Migration: generic modifier presence mode, verified exact-current rules, and
# Fade+Translucent Image as a normal personal mitigation opportunity.
# -----------------------------------------------------------------------------
migration = ROOT / 'supabase/migrations/20260905114500_defensive_evidence_claims_v5.sql'
migration.write_text(r'''-- Defensive evidence v5: source/claim normalization discovered by the E7 fixture battery.
-- No player-specific rules. All changes are build/spec/ability semantic facts.

alter table public.defensive_modifier_rules
  add column if not exists presence_mode text not null default 'talent_selected';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'defensive_modifier_rules_presence_mode_check'
  ) then
    alter table public.defensive_modifier_rules
      add constraint defensive_modifier_rules_presence_mode_check
      check (presence_mode in ('talent_selected','spec_baseline'));
  end if;
end $$;

-- Spec passives are auto-granted by the spec and do not appear as selectable
-- WCL talent nodes. Their modifiers must be applied from class/spec/build.
update public.defensive_modifier_rules
set presence_mode = 'spec_baseline'
where game_build = '12.1.0.68914'
  and class = 'Monk'
  and target_spell_id = 115203
  and modifier_spell_id in (1258138, 1258122);

-- Exact-current charge modifiers verified against current spell data.
update public.defensive_modifier_rules
set active = true
where game_build = '12.1.0.68914'
  and (
    (class = 'DemonHunter' and modifier_spell_id = 1266307 and target_spell_id in (198589,203720))
    or
    (class = 'Paladin' and modifier_spell_id = 1246481 and target_spell_id = 86659)
  );

-- Fade with Translucent Image is a real, finite-CD, self 10% DR. Base Fade
-- remains utility; only the verified talent-selected augment creates a normal
-- personal mitigation opportunity. This is intentionally NOT a code hardcode.
update public.defensive_semantic_rules
set payload = jsonb_set(payload, '{setOpportunityMode}', '"normal"'::jsonb, true)
where game_build = '12.1.0.68914'
  and verified = true
  and rule_type = 'augment'
  and modifier_spell_id = 373446
  and target_spell_id = 586
  and payload->>'condition' = 'talent_selected';
''')

# -----------------------------------------------------------------------------
# Regression tests.
# -----------------------------------------------------------------------------
p = 'src/app/shared/defensive-temporal-coverage.spec.ts'
s = read(p)
insert = r'''

  it('anchors reactive coverage to the real damage hit even when cast occurs before the aggregated episode start', () => {
    const result = evaluateTemporalCoverage(
      input({
        timingRelation: 'after_damage',
        episode: { startMs: 10_000, endMs: 12_000, peakMs: 11_000 },
        damageTimestampsMs: [9_500],
        castsForSpellMs: [9_800],
        afterDamageResponseWindowMs: 3000,
      }),
    );
    expect(result.engagement).toBe(true);
    expect(result.castCoverage).toBe('yes');
    expect(result.evidence['anchor']).toBe('raw_damage_hits');
  });
'''
needle = "describe('evaluateTemporalCoverage — either (test 16-17)', () => {"
s = replace_once(s, needle, insert + "\n" + needle, 'temporal regression test')
write(p, s)

# New focused test file for v5 semantics without disturbing large existing suites.
(ROOT / 'src/app/shared/defensive-evidence-v5.spec.ts').write_text(r'''import { describe, expect, it } from 'vitest';
import { resolveEpisodeVerdict, type EpisodeVerdictCandidate } from '../../../supabase/functions/_shared/defensive-episode-verdict';
import { resolveEffectiveDefensiveKit, type EffectiveDefensiveData, type ResolveDefensiveKitInput } from '../../../supabase/functions/_shared/effective-defensives';

function candidate(overrides: Partial<EpisodeVerdictCandidate> = {}): EpisodeVerdictCandidate {
  return {
    spellId: 1,
    isDefensiveKitMember: true,
    createsMissableOpportunity: true,
    materiallyUnresolved: false,
    damageApplicability: 'yes',
    temporalOpportunity: 'yes',
    temporalCastCoverage: 'no',
    engagement: false,
    statusAtPeak: 'available_unused',
    confidence: 'verified',
    membershipConfidence: 'verified',
    applicabilityClaimConfidence: 'verified',
    availabilityConfidence: 'verified',
    coverageConfidence: 'verified',
    evidence: {},
    ...overrides,
  };
}

describe('defensive evidence v5 — core opportunity scoring', () => {
  it('credit_only can cover an existing core opportunity', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 10 }),
      candidate({ spellId: 20, createsMissableOpportunity: false, engagement: true, temporalCastCoverage: 'yes', statusAtPeak: 'active' }),
    ]);
    expect(result.responseVerdict).toBe('covered_verified');
    expect(result.coveredBySpellId).toBe(20);
    expect(result.usageEvaluable).toBe(true);
  });

  it('credit_only used outside any core opportunity is bonus, not a synthetic Response denominator', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 20, createsMissableOpportunity: false, engagement: true, temporalCastCoverage: 'yes', statusAtPeak: 'active' }),
    ]);
    expect(result.responseVerdict).toBe('no_applicable_resource');
    expect(result.usageEvaluable).toBe(false);
    expect(result.bonusCreditSpellIds).toEqual([20]);
  });

  it('availability fallback blocks a miss but does not invalidate an independently strong positive cover', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 10, availabilityConfidence: 'fallback' }),
      candidate({ spellId: 20, createsMissableOpportunity: false, engagement: true, temporalCastCoverage: 'yes', statusAtPeak: 'active' }),
    ]);
    expect(result.responseVerdict).toBe('covered_verified');
  });

  it('a late/ineffective defensive is Usage yes and Response miss when a strong core option was available', () => {
    const result = resolveEpisodeVerdict([
      candidate({ spellId: 10 }),
      candidate({ spellId: 20, createsMissableOpportunity: false, engagement: true, temporalCastCoverage: 'no', statusAtPeak: 'on_cooldown' }),
    ]);
    expect(result.usageEngaged).toBe(true);
    expect(result.usageEvaluable).toBe(true);
    expect(result.responseVerdict).toBe('missed_ready');
    expect(result.reason).toContain('hubo uso defensivo');
  });
});

describe('defensive evidence v5 — source precedence and baseline modifiers', () => {
  const baseInput: ResolveDefensiveKitInput = {
    className: 'Monk', specName: 'Mistweaver', talentBuild: [], buildFingerprint: 'x',
    gameBuild: '12.1.0.68914', gameBuildConfidence: 'verified', playerIdentity: { playerName: 'Fixture' },
  };
  const catalog: any = {
    spellId: 115203, name: 'Fortifying Brew', className: 'Monk', specName: null, specOverride: null,
    category: 'personal_defensive', survivalType: 'mitigation', targetingMode: 'self', activationMode: 'active',
    passiveConversionSpellIds: [], activationGameBuild: '12.1.0.68914', baseCooldownMs: 360000, baseDurationMs: 15000,
    reviewed: true,
  };
  const semantic: any = {
    spellId: 115203, className: 'Monk', usageRole: 'personal_survival', activationScope: 'self', primaryBeneficiary: 'self',
    secondaryPropagation: 'none', mechanisms: ['mitigation'], opportunityMode: 'normal', defensiveIntent: 'primary',
    semanticStatus: 'verified', semanticVersion: 'defensive-semantics@1.0.0', semanticConfidence: 'verified', locked: true,
    applicability: { schoolScope: 'all', schools: [], deliveryScopes: ['all'], requiresDodgeable: false, requiresParryable: false, requiresBlockable: false, requiresSourceAffectedBySpell: false, timingRelation: 'before_or_during' },
    applicabilityConfidence: 'high', applicabilityError: null, specSemanticProfiles: [], invalidSpecSemanticProfiles: [],
  };
  const data: EffectiveDefensiveData = {
    catalog: [catalog],
    specProfiles: [{ className: 'Monk', specName: 'Mistweaver', spellId: 115203, gameBuild: 'legacy-current', baseCooldownMs: 120000, baseDurationMs: 15000, charges: 1, rechargeMs: null }],
    modifierRules: [{ id: 'mw-core', className: 'Monk', specNames: ['Mistweaver'], modifierSpellId: 1258138, targetSpellId: 115203, operation: 'subtract_ms', effectField: 'cooldown_ms', value: 240000, perRank: false, condition: 'always', gameBuild: '12.1.0.68914', applicationOrder: 100, description: 'core passive', active: true, presenceMode: 'spec_baseline' }],
    semantics: [semantic], semanticRules: [], overrides: [],
  };

  it('ignores conflicting legacy timing when exact-current reviewed catalog exists, then applies spec baseline rule', () => {
    const [resolved] = resolveEffectiveDefensiveKit(baseInput, data);
    expect(resolved.effectiveCooldownMs).toBe(120000);
    expect(resolved.cooldownConfidence).toBe('verified');
    expect(resolved.provenance.some((p) => p.kind === 'validation' && p.field === 'cooldown_ms')).toBe(true);
  });
});
''')

print('defensive evidence v5 codemod applied')
