// §Paso D (arranque real, iris-defensive-canonicalization-v1-plan.md §2.4/
// §2.6) — el orquestador puro que faltaba: une resolver de kit + agrupación
// de episodios + aplicabilidad real + disponibilidad causal/cargas +
// persistencia, para UN jugador/pull. Puro (sin Deno/Supabase/WCL) — el
// I/O (fetch a WCL, fetch de kit/semántica, upsert de staging) vive en el
// edge function que lo envuelve. Nada de esto reevalúa lo que ya está
// construido y testeado en los módulos que importa; solo los conecta en el
// orden correcto: RAW WCL FACTS → CANDIDATOS → EPISODIOS → APPLICABILITY →
// DISPONIBILIDAD CAUSAL/CARGAS → PersistedDefensiveEpisode[].
//
// §E4 (continuación del plan, 2026-09-04) REESCRIBE este orquestador:
//
// 1) Input único canónico: `ResolvedDefensive[]` (de
//    resolveEffectiveDefensiveKit()) en vez del `EligibleDefensiveInput[]`
//    paralelo que este fichero definía por su cuenta — ver §1 del plan de
//    continuación. Nunca se reconstruye membership/applicability/semántica
//    aquí; solo se leen los campos finales ya resueltos.
//
// 2) Un episodio de presión real YA NO desaparece cuando el kit conocido
//    está vacío (§2) — el daño crea el episodio, no la existencia de un
//    defensivo. resolveEpisodeVerdict() ya produce `no_applicable_resource`
//    con candidates=[].
//
// 3) La aplicabilidad de daño combina TODOS los hits relevantes del
//    episodio (§4), no un único "hit representativo" arbitrario.
//
// 4) El timing ya no usa el heurístico de `mechanisms` — usa
//    ResolvedDefensive.applicability.timingRelation vía el evaluador
//    temporal puro de defensive-temporal-coverage.ts (§5).
//
// 5) La confidence de cada episodio es decision-scoped (§11): el veredicto
//    ya trae su propia confidence desde la evidencia decisiva; aquí solo se
//    aplica el techo de `dataConfidence` de la fila.

import type { EvaluationConfidence } from './combat-evaluation-contract.ts';
import { attributeWindowAbility, detectDamageWindows, type DominantAbility } from './damage-pressure-windows.ts';
import { groupDamageWindowsIntoEpisodes, type DefensiveEpisodeCandidate } from './defensive-episode-grouping.ts';
import {
  buildDamageDescriptor,
  isSourceAffectedBySpellAt,
  type AbilityCombatTableCounts,
  type DamageDescriptorContext,
  type DebuffInterval,
  type DecodedSchoolMask,
} from './damage-descriptor-wcl.ts';
import { canDefensiveCover, combineHitApplicability, type ApplicabilityVerdict } from './defensive-applicability.ts';
import {
  resolveEpisodeVerdictWithCausalAvailability,
  weakestConfidence,
  type CausallyAwareCandidate,
  type EpisodeVerdictResult,
  type EpisodeWindow,
} from './defensive-episode-verdict.ts';
import { chargeAvailabilityAt, type DefensiveCooldown } from './defensive-cooldowns.ts';
import { evaluateTemporalCoverage, normalizeCastTimestamps } from './defensive-temporal-coverage.ts';
import { buildPersistedDefensiveEpisode, type PersistedDefensiveEpisode } from './defensive-episode-persistence.ts';
import type { ResolvedDefensive } from './effective-defensives.ts';

/** §5.2 — política explícita del Episode Evaluator, persistida como evidencia; nunca seleccionada por inspeccionar `mechanisms`. */
export const DEFAULT_AFTER_DAMAGE_RESPONSE_WINDOW_MS = 3000;

export interface RawDamageHit {
  timestamp?: number;
  abilityGameID?: number;
  amount?: number;
  isAoE?: boolean;
  tick?: boolean;
  hitType?: number;
  blocked?: number;
}

export interface DefensiveEpisodeEvaluatorInput {
  pullId: string;
  playerName: string;
  /** actorID del boss/enemigo cuyos debuffs importan para requiresSourceAffectedBySpell — null si no se resolvió. */
  bossActorId: number | null;
  /** Episodios cuyo pico está en/después de este instante se marcan `excluded` (wipe call/cutoff de evaluación) — null = sin cutoff conocido, nada se excluye por esto. */
  evaluationEndMs: number | null;
  /**
   * §E4 §1 — ÚNICO input semántico/de kit admitido: la salida completa de
   * resolveEffectiveDefensiveKit() para este jugador/build. El evaluator
   * nunca reconstruye ni reinterpreta buildPresence/semanticStatus/
   * applicability/membership — solo lee los campos finales.
   */
  resolvedDefensives: ResolvedDefensive[];
  damageTakenGraphPoints: number[];
  graphPointStartMs: number;
  graphPointIntervalMs: number;
  /** DamageTaken crudo de ESTE jugador, todo el pull — mismo array para detectar ventanas (vía attributeWindowAbility) y construir el DamageDescriptor de cada episodio. */
  rawDamageHits: RawDamageHit[];
  /** Casts de ESTE jugador, por spellId — solo hace falta para los spellId del kit resuelto. */
  castsBySpellId: ReadonlyMap<number, number[]>;
  schoolByAbilityId: ReadonlyMap<number, DecodedSchoolMask>;
  combatTableObservations: ReadonlyMap<number, AbilityCombatTableCounts>;
  /** Vacío si no se pidieron Debuffs(Enemies) para este pull (fetch condicional — ver damage-descriptor-wcl.ts). */
  bossDebuffIntervals: readonly DebuffInterval[];
  /** Confidence base de la resolución de build/game_build para esta fila — techo de lo que puede afirmar cualquier episodio de este jugador/pull. */
  dataConfidence: EvaluationConfidence;
  continuityGapMs?: number;
  windowDetectionFactor?: number;
  /** §5.2 — override de test/política; por defecto DEFAULT_AFTER_DAMAGE_RESPONSE_WINDOW_MS. */
  afterDamageResponseWindowMs?: number;
}

/**
 * Adaptador MECÁNICO puro hacia el shape que exige chargeAvailabilityAt()/
 * defensiveStatusAt() (defensive-cooldowns.ts) — esas funciones solo leen
 * `durationMs`/`baseCooldownMs`, nunca `class`/`spec`/`category`/
 * `survivalType`; esos cuatro campos se rellenan con valores neutros
 * únicamente para satisfacer el shape, nunca como fuente de verdad de
 * scoring (§1: prohibido usar cooldown_catalog.category/survivalType como
 * fallback).
 */
function toChargeAvailabilityAdapter(r: ResolvedDefensive): DefensiveCooldown {
  return {
    spellId: r.spellId,
    name: `spell:${r.spellId}`,
    class: '',
    spec: null,
    specOverride: null,
    category: 'personal_defensive',
    baseCooldownMs: r.effectiveCooldownMs,
    durationMs: r.effectiveDurationMs,
    survivalType: null,
  };
}

const PERSONAL_SURVIVAL_USAGE_ROLES = new Set(['personal_survival', 'survival_state', 'hybrid_survival']);

/**
 * §3 del plan de continuación (B: "potentially relevant unresolved
 * resource") — usageRole ya es uno de los campos finales permitidos (§1), a
 * diferencia de category/targetingMode. Nunca marca materiallyUnresolved a
 * un candidato que YA es isDefensiveKitMember (evita solapar los dos
 * conjuntos — un miembro del kit resuelto nunca necesita este bloqueo).
 *
 * §Pre-E6 fix #1 (2026-09-04, "pending + unknown role must fail closed"):
 * `semanticStatus==='pending'` se comprueba ANTES del gate por usageRole,
 * no después. Con el orden anterior, una fila futura todavía sin
 * clasificar (`pending`, `usageRole` en su default `'unknown'`) no entraba
 * en `PERSONAL_SURVIVAL_USAGE_ROLES` y por tanto NUNCA bloqueaba
 * `no_applicable_resource` — exactamente el caso que este predicado existe
 * para bloquear (podría resultar ser personal_survival tras clasificarse).
 * El resto de motivos (buildPresence unknown/resolutionStatus conflict o
 * unresolved/unresolvedRuntimeRules) siguen exigiendo el gate de usageRole
 * — no hay razón para que un unresolvedRuntimeRule de una utility/
 * healer_throughput/external etc. genere incertidumbre en un episodio que
 * no tiene nada que ver con ella.
 */
function isMateriallyUnresolved(r: ResolvedDefensive): boolean {
  if (r.isDefensiveKitMember) return false;
  if (r.semanticStatus === 'pending') return true;
  if (!PERSONAL_SURVIVAL_USAGE_ROLES.has(r.usageRole)) return false;
  return (
    r.buildPresence === 'unknown' ||
    r.resolutionStatus === 'conflict' ||
    r.resolutionStatus === 'unresolved' ||
    r.unresolvedRuntimeRules.length > 0
  );
}

/** §11 — mapeo conservador de applicabilityConfidence a la escala de EvaluationConfidence: high→verified, medium→inferred, low/null→uncertain. */
function mapApplicabilityConfidence(confidence: 'high' | 'medium' | 'low' | null): EvaluationConfidence {
  if (confidence === 'high') return 'verified';
  if (confidence === 'medium') return 'inferred';
  return 'uncertain';
}

function excludedVerdict(reason: string): EpisodeVerdictResult {
  return {
    usageEngaged: false,
    usedSpellIds: [],
    responseVerdict: 'excluded',
    reason,
    coveredBySpellId: null,
    confidence: 'verified',
    decisiveSpellIds: [],
    uncertaintyBlockers: [],
  };
}

/** Todos los hits crudos relevantes de un episodio (§4): si se conoce la ability dominante, sus hits dentro de la ventana; si no, TODOS los hits dentro de la ventana (conservador). */
function relevantHitsForEpisode(
  window: EpisodeWindow,
  dominantAbilityGameId: number | null,
  hitsByAbility: ReadonlyMap<number, RawDamageHit[]>,
  allHits: readonly RawDamageHit[],
): RawDamageHit[] {
  const inWindow = (hit: RawDamageHit): boolean =>
    typeof hit.timestamp === 'number' && hit.timestamp >= window.startMs && hit.timestamp <= window.endMs;
  const pool = dominantAbilityGameId != null ? hitsByAbility.get(dominantAbilityGameId) ?? [] : allHits;
  return pool.filter(inWindow);
}

/** §4 — combina canDefensiveCover() sobre TODOS los hits relevantes, nunca un único "hit representativo". */
function computeDamageApplicability(
  r: ResolvedDefensive,
  hits: readonly RawDamageHit[],
  ctx: DamageDescriptorContext,
  bossActorId: number | null,
  bossDebuffIntervals: readonly DebuffInterval[],
): { verdict: ApplicabilityVerdict; evidence: Record<string, unknown> } {
  if (!hits.length) {
    return { verdict: 'unknown', evidence: { hitCount: 0, reason: 'Cero hits de daño evaluables en este episodio.' } };
  }
  const perHit = hits.map((hit) => {
    const sourceAffectedBySpell =
      r.applicability?.requiresSourceAffectedBySpell === true && bossActorId != null && typeof hit.timestamp === 'number'
        ? isSourceAffectedBySpellAt(bossDebuffIntervals, bossActorId, r.spellId, hit.timestamp)
        : null;
    const descriptor = { ...buildDamageDescriptor(hit, ctx), sourceAffectedBySpell };
    const result = canDefensiveCover(r.applicability, r.applicabilityConfidence, descriptor);
    return { verdict: result.verdict, reason: result.reason, timestamp: hit.timestamp ?? null };
  });
  return { verdict: combineHitApplicability(perHit.map((p) => p.verdict)), evidence: { hitCount: hits.length, perHit } };
}

function buildCandidate(
  r: ResolvedDefensive,
  window: EpisodeWindow,
  hits: readonly RawDamageHit[],
  rawCastsForSpellMs: readonly number[],
  ctx: DamageDescriptorContext,
  bossActorId: number | null,
  bossDebuffIntervals: readonly DebuffInterval[],
  afterDamageResponseWindowMs: number,
  evaluationEndMs: number | null,
): CausallyAwareCandidate {
  const castsForSpellMs = normalizeCastTimestamps(rawCastsForSpellMs);
  const timingRelation = r.applicability?.timingRelation ?? null;
  const damage = computeDamageApplicability(r, hits, ctx, bossActorId, bossDebuffIntervals);
  const temporal = evaluateTemporalCoverage({
    timingRelation,
    effectiveDurationMs: r.effectiveDurationMs,
    castsForSpellMs,
    episode: window,
    afterDamageResponseWindowMs,
    evaluationEndMs,
  });
  const statusAtPeak = chargeAvailabilityAt(
    toChargeAvailabilityAdapter(r),
    r.charges,
    r.rechargeMs,
    castsForSpellMs,
    window.peakMs,
  ).status;
  const confidence = weakestConfidence(
    r.confidence,
    r.semanticConfidence,
    r.buildPresenceConfidence,
    mapApplicabilityConfidence(r.applicabilityConfidence),
  );

  return {
    spellId: r.spellId,
    isDefensiveKitMember: r.isDefensiveKitMember,
    createsMissableOpportunity: r.createsMissableOpportunity,
    materiallyUnresolved: isMateriallyUnresolved(r),
    damageApplicability: damage.verdict,
    temporalOpportunity: temporal.opportunity,
    temporalCastCoverage: temporal.castCoverage,
    engagement: temporal.engagement,
    statusAtPeak,
    confidence,
    evidence: { damage: damage.evidence, temporal: temporal.evidence },
    castsForSpellMs,
    timing: { timingRelation, effectiveDurationMs: r.effectiveDurationMs, afterDamageResponseWindowMs, evaluationEndMs },
  };
}

/**
 * Todo el pipeline puro para UN jugador/pull: candidatos de daño →
 * episodios → aplicabilidad+timing+disponibilidad+cargas por candidato →
 * veredicto con reconstrucción causal → episodios persistibles completos.
 *
 * §E4 §2 — el daño crea el episodio, no la existencia de un defensivo: un
 * `resolvedDefensives` vacío (o sin ningún candidato relevante) NUNCA hace
 * desaparecer un episodio de presión real; produce `no_applicable_resource`
 * (o `uncertain`, si algo sin resolver podría cambiar la respuesta) con
 * `candidates: []`/sin candidatos decisivos, nunca `[]` en el array de
 * episodios devuelto.
 */
export function evaluateDefensiveEpisodesForPlayer(input: DefensiveEpisodeEvaluatorInput): PersistedDefensiveEpisode[] {
  const detection = detectDamageWindows(
    input.damageTakenGraphPoints,
    input.graphPointStartMs,
    input.graphPointIntervalMs,
    input.windowDetectionFactor,
  );
  if (!detection.windows.length) return [];

  const candidates: DefensiveEpisodeCandidate[] = detection.windows.map((window) => {
    const attribution: DominantAbility | null = attributeWindowAbility(input.rawDamageHits, window.startMs, window.endMs);
    return { window, dominantAbilityGameId: attribution?.abilityGameID ?? null, occurrenceId: undefined };
  });

  const episodes = groupDamageWindowsIntoEpisodes(candidates, input.continuityGapMs);
  const episodeWindows: EpisodeWindow[] = episodes.map((e) => ({ startMs: e.startMs, endMs: e.endMs, peakMs: e.peakMs }));

  // Índice de hits por abilityGameID, para no recorrer TODO el array por cada episodio×defensivo.
  const hitsByAbility = new Map<number, RawDamageHit[]>();
  for (const hit of input.rawDamageHits) {
    if (typeof hit.abilityGameID !== 'number') continue;
    (hitsByAbility.get(hit.abilityGameID) ?? hitsByAbility.set(hit.abilityGameID, []).get(hit.abilityGameID)!).push(hit);
  }

  const afterDamageResponseWindowMs = input.afterDamageResponseWindowMs ?? DEFAULT_AFTER_DAMAGE_RESPONSE_WINDOW_MS;
  const ctx: DamageDescriptorContext = { schoolByAbilityId: input.schoolByAbilityId, combatTableObservations: input.combatTableObservations };

  const results: PersistedDefensiveEpisode[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i];
    const window = episodeWindows[i];
    const windowIdentity = {
      occurrenceId: episode.occurrenceId,
      dominantAbilityGameId: episode.dominantAbilityGameId,
      memberIndexes: episode.memberIndexes,
      startMs: episode.startMs,
      endMs: episode.endMs,
      peakMs: episode.peakMs,
    };

    // §10 — cutoff/wipe safety: un pico EN o después del cutoff nunca se evalúa (conservador: >= , no solo >).
    if (input.evaluationEndMs != null && window.peakMs >= input.evaluationEndMs) {
      results.push(
        buildPersistedDefensiveEpisode({
          pullId: input.pullId,
          playerName: input.playerName,
          window: windowIdentity,
          candidates: [],
          verdict: excludedVerdict('Episodio con pico en o después del cutoff de evaluación (wipe call) — no se evalúa.'),
          confidence: input.dataConfidence,
          evidence: { groupingBasis: episode.groupingBasis },
        }),
      );
      continue;
    }

    const hits = relevantHitsForEpisode(window, episode.dominantAbilityGameId, hitsByAbility, input.rawDamageHits);

    const causalCandidates: CausallyAwareCandidate[] = input.resolvedDefensives
      .map((r) =>
        buildCandidate(
          r,
          window,
          hits,
          input.castsBySpellId.get(r.spellId) ?? [],
          ctx,
          input.bossActorId,
          input.bossDebuffIntervals,
          afterDamageResponseWindowMs,
          input.evaluationEndMs,
        ),
      )
      .sort((a, b) => a.spellId - b.spellId);

    const verdict = resolveEpisodeVerdictWithCausalAvailability(causalCandidates, episodeWindows, i);
    // §11 — techo de dataConfidence sobre la confidence decision-scoped del veredicto; nunca la más débil de TODO el kit.
    const confidence = weakestConfidence(input.dataConfidence, verdict.confidence);

    results.push(
      buildPersistedDefensiveEpisode({
        pullId: input.pullId,
        playerName: input.playerName,
        window: windowIdentity,
        candidates: causalCandidates,
        verdict,
        confidence,
        evidence: { groupingBasis: episode.groupingBasis, dominantAbilityGameId: episode.dominantAbilityGameId },
      }),
    );
  }

  return results;
}
