from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}\n--- needle ---\n{old}")
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# E7-GAP-01 — acquisition confidence: positive cast proof must replace ONLY
# the uncertainty introduced by the unproven direct-acquisition gate.
# ---------------------------------------------------------------------------
effective = "supabase/functions/_shared/effective-defensives.ts"
replace_once(
    effective,
    "export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION = 'effective-defensive-semantics@1.3.1';",
    "export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION = 'effective-defensive-semantics@1.3.2';",
)
replace_once(
    effective,
    "let eligibleBeforeUnprovenDirectAcquisitionGate: boolean | null = null;",
    "let eligibleBeforeUnprovenDirectAcquisitionGate: boolean | null = null;\n  // §E7-GAP-01: snapshot the confidence that existed BEFORE the legacy\n  // direct-acquisition gate injected uncertainty. Positive cast evidence may\n  // remove exactly that uncertainty, but must never erase an unrelated one.\n  let confidenceBeforeUnprovenDirectAcquisitionGate: DefensiveResolutionConfidence | null = null;",
)
replace_once(
    effective,
    """    if (eligibleBeforeUnprovenDirectAcquisitionGate == null) {
      eligibleBeforeUnprovenDirectAcquisitionGate = eligible;
    }
    eligible = false;
    confidence = weakerConfidence(confidence, 'uncertain');""",
    """    if (eligibleBeforeUnprovenDirectAcquisitionGate == null) {
      eligibleBeforeUnprovenDirectAcquisitionGate = eligible;
    }
    if (confidenceBeforeUnprovenDirectAcquisitionGate == null) {
      confidenceBeforeUnprovenDirectAcquisitionGate = confidence;
    }
    eligible = false;
    confidence = weakerConfidence(confidence, 'uncertain');""",
)
replace_once(
    effective,
    """const castEvidence = input.demonstratedPersistentCastSpellIds?.get(entry.spellId) ?? null;
  if (buildPresence !== 'present' && castEvidence) {
    buildPresence = 'present';
    buildPresenceConfidence = weakerConfidence(
      buildPresenceConfidence,
      castEvidence === 'observed_cast_same_pull' ? 'verified' : 'inferred',
    );
    buildPresenceEvidence = castEvidence;
    if (eligibleBeforeUnprovenDirectAcquisitionGate != null) {
      eligible = eligibleBeforeUnprovenDirectAcquisitionGate;
    }
    provenance = [""",
    """const castEvidence = input.demonstratedPersistentCastSpellIds?.get(entry.spellId) ?? null;
  if (buildPresence !== 'present' && castEvidence) {
    const castEvidenceConfidence: DefensiveResolutionConfidence =
      castEvidence === 'observed_cast_same_pull' ? 'verified' : 'inferred';
    buildPresence = 'present';
    // A positive observation is stronger than the previous UNKNOWN acquisition
    // state: do not combine it with the uncertainty it has just disproved.
    buildPresenceConfidence = castEvidenceConfidence;
    buildPresenceEvidence = castEvidence;
    if (eligibleBeforeUnprovenDirectAcquisitionGate != null) {
      eligible = eligibleBeforeUnprovenDirectAcquisitionGate;
    }
    if (confidenceBeforeUnprovenDirectAcquisitionGate != null) {
      confidence = weakerConfidence(
        confidenceBeforeUnprovenDirectAcquisitionGate,
        castEvidenceConfidence,
      );
    }
    provenance = [""",
)

# Targeted regression assertions for both proof strengths + unrelated
# uncertainty preservation.
effective_spec = "src/app/shared/effective-defensives.spec.ts"
replace_once(
    effective_spec,
    """    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_pull');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);""",
    """    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_pull');
    expect(resolved.buildPresenceConfidence).toBe('verified');
    expect(resolved.confidence).toBe('verified');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);""",
)
replace_once(
    effective_spec,
    """    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_build_fingerprint');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);""",
    """    expect(resolved.buildPresenceEvidence).toBe('observed_cast_same_build_fingerprint');
    expect(resolved.buildPresenceConfidence).toBe('inferred');
    expect(resolved.confidence).toBe('inferred');
    expect(resolved.eligible).toBe(true);
    expect(resolved.isDefensiveKitMember).toBe(true);""",
)
replace_once(
    effective_spec,
    """  it('pre-existing legitimate eligible=false blocker (talent-selected passive conversion) + cast evidence: remains eligible=false', () => {""",
    """  it('cast proof does not erase unrelated confidence uncertainty that existed before the acquisition gate', () => {
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

# ---------------------------------------------------------------------------
# E7-GAP-02 — damage-window geometry: attribution and evaluator must share the
# exact same event-membership predicate (including the established +/-2s pad).
# ---------------------------------------------------------------------------
windows = "supabase/functions/_shared/damage-pressure-windows.ts"
replace_once(
    windows,
    "const ATTRIBUTION_PAD_MS = 2000; // una ventana de 1 solo bucket (startMs===endMs) puede no dejar ningún evento exacto dentro del rango sin este margen",
    """export const DAMAGE_WINDOW_EVENT_PADDING_MS = 2000; // una ventana de 1 solo bucket (startMs===endMs) puede no dejar ningún evento exacto dentro del rango sin este margen

/**
 * Geometría canónica de pertenencia de un evento crudo a una ventana de
 * presión. Attribution y Episode Evaluator DEBEN usar este mismo predicado:
 * de otro modo una habilidad puede ser dominante gracias al padding y luego
 * quedarse sin hits evaluables en la misma ventana.
 */
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

# Integration regression: the same padded hit that can establish the dominant
# ability must be visible to applicability. Beyond the shared pad remains
# fail-closed/unknown.
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
        // Graph window is the single point at 11_000ms. The raw hit is 1.5s
        // after it: attribution has always accepted it via padding, and the
        // evaluator must now accept exactly the same event as well.
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

print('E7 remediation codemod applied successfully')
