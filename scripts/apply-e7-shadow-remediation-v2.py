from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}\n--- needle ---\n{old}")
    p.write_text(text.replace(old, new, 1))


# E7-GAP-01 — positive acquisition evidence removes ONLY the uncertainty
# introduced by the unproven-direct-acquisition gate.
effective = "supabase/functions/_shared/effective-defensives.ts"
replace_once(
    effective,
    "export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION = 'effective-defensive-semantics@1.3.1';",
    "export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION = 'effective-defensive-semantics@1.3.2';",
)
replace_once(
    effective,
    "      let eligibleBeforeUnprovenDirectAcquisitionGate: boolean | null = null;\n      const provenance: ResolutionStep[] = [",
    """      let eligibleBeforeUnprovenDirectAcquisitionGate: boolean | null = null;
      // §E7-GAP-01: confidence immediately before the same acquisition gate.
      // A positive cast may remove uncertainty introduced by that gate, but
      // must preserve any unrelated uncertainty that already existed.
      let confidenceBeforeUnprovenDirectAcquisitionGate: DefensiveResolutionConfidence | null = null;
      const provenance: ResolutionStep[] = [""",
)
replace_once(
    effective,
    """          eligibleBeforeUnprovenDirectAcquisitionGate = eligible;
          eligible = false;
          confidence = weakerConfidence(confidence, 'uncertain');
          buildPresence = 'unknown';""",
    """          eligibleBeforeUnprovenDirectAcquisitionGate = eligible;
          confidenceBeforeUnprovenDirectAcquisitionGate = confidence;
          eligible = false;
          confidence = weakerConfidence(confidence, 'uncertain');
          buildPresence = 'unknown';""",
)
replace_once(
    effective,
    """      const castEvidence = input.demonstratedPersistentCastSpellIds?.get(entry.spellId);
      if (buildPresence !== 'present' && castEvidence != null) {
        // §E2.6 (Acquisition Safety Closure — false-negative fix): la puerta""",
    """      const castEvidence = input.demonstratedPersistentCastSpellIds?.get(entry.spellId);
      if (buildPresence !== 'present' && castEvidence != null) {
        const castEvidenceConfidence: DefensiveResolutionConfidence =
          castEvidence === 'observed_cast_same_pull' ? 'verified' : 'inferred';
        // §E2.6 (Acquisition Safety Closure — false-negative fix): la puerta""",
)
replace_once(
    effective,
    """        if (eligibleBeforeUnprovenDirectAcquisitionGate != null) {
          eligible = eligibleBeforeUnprovenDirectAcquisitionGate;
        }
        buildPresence = 'present';
        buildPresenceConfidence = weakerConfidence(buildPresenceConfidence, 'inferred');
        buildPresenceEvidence = castEvidence;""",
    """        if (eligibleBeforeUnprovenDirectAcquisitionGate != null) {
          eligible = eligibleBeforeUnprovenDirectAcquisitionGate;
        }
        if (confidenceBeforeUnprovenDirectAcquisitionGate != null) {
          confidence = weakerConfidence(
            confidenceBeforeUnprovenDirectAcquisitionGate,
            castEvidenceConfidence,
          );
        }
        buildPresence = 'present';
        // The positive observation disproves the acquisition UNKNOWN itself:
        // same-pull is verified; exact same-build fingerprint is inferred.
        buildPresenceConfidence = castEvidenceConfidence;
        buildPresenceEvidence = castEvidence;""",
)

# E7-GAP-01 regressions.
effective_spec = "src/app/shared/effective-defensives.spec.ts"
replace_once(
    effective_spec,
    """    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_pull');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);""",
    """    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_pull');
    expect(resolved.buildPresenceConfidence).toBe('verified');
    expect(resolved.confidence).toBe('verified');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);""",
)
replace_once(
    effective_spec,
    """    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_build_fingerprint');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);""",
    """    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_build_fingerprint');
    expect(resolved.buildPresenceConfidence).toBe('inferred');
    expect(resolved.confidence).toBe('inferred');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);
    expect(resolved.createsMissableOpportunity).toBe(true);""",
)
replace_once(
    effective_spec,
    """  it('pre-existing legitimate eligible=false blocker (talent-selected passive conversion) + cast evidence: remains eligible=false', () => {""",
    """  it('cast proof preserves unrelated confidence uncertainty that existed before the acquisition gate', () => {
    const talentDefensive: EffectiveDefensiveCatalogEntry = { ...fade, spellId: 19236, name: 'Desperate Prayer' };
    const [resolved] = resolveEffectiveDefensiveKit(
      input({
        gameBuild: null,
        gameBuildConfidence: 'uncertain',
        talentBuild: [],
        allTalentSpellIds: new Set([talentDefensive.spellId]),
        talentLookupComplete: true,
        demonstratedPersistentCastSpellIds: new Map([[talentDefensive.spellId, 'observed_cast_same_pull']]),
      }),
      data({ catalog: [talentDefensive], semantics: [semanticEntry({ spellId: talentDefensive.spellId })] }),
    );
    expect(resolved.buildPresence).toBe('present');
    expect(resolved.buildPresenceConfidence).toBe('verified');
    expect(resolved.confidence).toBe('uncertain');
  });

  it('pre-existing legitimate eligible=false blocker (talent-selected passive conversion) + cast evidence: remains eligible=false', () => {""",
)

# E7-GAP-02 — one canonical geometry for raw damage event membership.
windows = "supabase/functions/_shared/damage-pressure-windows.ts"
replace_once(
    windows,
    "const ATTRIBUTION_PAD_MS = 2000; // una ventana de 1 solo bucket (startMs===endMs) puede no dejar ningún evento exacto dentro del rango sin este margen",
    """export const DAMAGE_WINDOW_EVENT_PADDING_MS = 2000; // una ventana de 1 solo bucket (startMs===endMs) puede no dejar ningún evento exacto dentro del rango sin este margen

/** Geometría canónica compartida por attribution y Episode Evaluator. */
export function isDamageEventWithinPressureWindow(
  timestamp: number,
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  const from = Math.min(windowStartMs, windowEndMs) - DAMAGE_WINDOW_EVENT_PADDING_MS;
  const to = Math.max(windowStartMs, windowEndMs) + DAMAGE_WINDOW_EVENT_PADDING_MS;
  return timestamp >= from && timestamp <= to;
}""",
)
replace_once(
    windows,
    """  const from = windowStartMs - ATTRIBUTION_PAD_MS;
  const to = windowEndMs + ATTRIBUTION_PAD_MS;
  const byAbility = new Map<number, number>();""",
    """  const byAbility = new Map<number, number>();""",
)
replace_once(
    windows,
    "if (typeof e.timestamp !== 'number' || e.timestamp < from || e.timestamp > to) continue;",
    "if (typeof e.timestamp !== 'number' || !isDamageEventWithinPressureWindow(e.timestamp, windowStartMs, windowEndMs)) continue;",
)

evaluator = "supabase/functions/_shared/defensive-episode-evaluator.ts"
replace_once(
    evaluator,
    "import { attributeWindowAbility, detectDamageWindows, type DominantAbility } from './damage-pressure-windows.ts';",
    "import { attributeWindowAbility, detectDamageWindows, isDamageEventWithinPressureWindow, type DominantAbility } from './damage-pressure-windows.ts';",
)
replace_once(
    evaluator,
    """  const inWindow = (hit: RawDamageHit): boolean =>
    typeof hit.timestamp === 'number' && hit.timestamp >= window.startMs && hit.timestamp <= window.endMs;""",
    """  const inWindow = (hit: RawDamageHit): boolean =>
    typeof hit.timestamp === 'number' && isDamageEventWithinPressureWindow(hit.timestamp, window.startMs, window.endMs);""",
)

ledger = "supabase/functions/_shared/defensive-episode-ledger-events.ts"
replace_once(
    ledger,
    "export const DEFENSIVE_EPISODE_EVALUATOR_VERSION = 'episode-evaluator@2';",
    "export const DEFENSIVE_EPISODE_EVALUATOR_VERSION = 'episode-evaluator@3';",
)

# E7-GAP-02 regressions on the integration boundary.
evaluator_spec = "src/app/shared/defensive-episode-evaluator.spec.ts"
p = Path(evaluator_spec)
text = p.read_text()
marker = "\ndescribe('evaluateDefensiveEpisodesForPlayer — un episodio, un candidato', () => {"
if text.count(marker) != 1:
    raise SystemExit(f"{evaluator_spec}: expected one insertion marker, found {text.count(marker)}")
regression = r'''

describe('evaluateDefensiveEpisodesForPlayer — E7 shared damage-window geometry', () => {
  it('a hit inside the canonical +2s padding is both attributable and applicability-evaluable', () => {
    const [episode] = evaluateDefensiveEpisodesForPlayer(
      baseInput({
        rawDamageHits: [{ timestamp: 12_500, abilityGameID: 999, amount: 5000, isAoE: false, tick: false }],
      }),
    );
    expect(episode.evidence.dominantAbilityGameId).toBe(999);
    expect(episode.applicableCandidates[0].damageApplicability).toBe('yes');
    expect(episode.applicableCandidates[0].evidence.damage).toMatchObject({ hitCount: 1 });
    expect(episode.responseVerdict).toBe('missed_ready');
  });

  it('a hit beyond the canonical +2s padding remains unavailable to both stages and fails closed', () => {
    const [episode] = evaluateDefensiveEpisodesForPlayer(
      baseInput({
        rawDamageHits: [{ timestamp: 13_100, abilityGameID: 999, amount: 5000, isAoE: false, tick: false }],
      }),
    );
    expect(episode.evidence.dominantAbilityGameId).toBeNull();
    expect(episode.applicableCandidates[0].damageApplicability).toBe('unknown');
    expect(episode.responseVerdict).toBe('uncertain');
  });
});
'''
p.write_text(text.replace(marker, regression + marker, 1))

print('E7 remediation v2 codemod applied successfully')
