// §Paso D (arranque real, iris-defensive-canonicalization-v1-plan.md §2.4/
// §2.6) — el orquestador puro que faltaba: une resolver de kit + agrupación
// de episodios + aplicabilidad real + disponibilidad causal/cargas +
// persistencia, para UN jugador/pull. Puro (sin Deno/Supabase/WCL) — el
// I/O (fetch a WCL, fetch de kit/semántica, upsert de staging) vive en el
// edge function que lo envuelve. Nada de esto reevalúa lo que ya está
// construido y testeado en los módulos que importa; solo los conecta en el
// orden correcto: RAW WCL FACTS → CANDIDATOS → EPISODIOS → APPLICABILITY →
// DISPONIBILIDAD CAUSAL/CARGAS → PersistedDefensiveEpisode[].

import type { EvaluationConfidence } from './combat-evaluation-contract.ts';
import type { DefensiveCooldown } from './defensive-cooldowns.ts';
import { attributeWindowAbility, detectDamageWindows, type DominantAbility } from './damage-pressure-windows.ts';
import { groupDamageWindowsIntoEpisodes, type DefensiveEpisodeCandidate } from './defensive-episode-grouping.ts';
import {
  buildDamageDescriptor,
  isSourceAffectedBySpellAt,
  type AbilityCombatTableCounts,
  type DebuffInterval,
  type DecodedSchoolMask,
} from './damage-descriptor-wcl.ts';
import { canDefensiveCover, type DamageApplicability } from './defensive-applicability.ts';
import {
  resolveEpisodeVerdictWithCausalAvailability,
  summarizeCandidateForEpisode,
  type CausallyAwareCandidate,
  type EpisodeWindow,
  type EpisodeVerdictResult,
} from './defensive-episode-verdict.ts';
import type { DefensiveMechanism } from './defensive-classification-semantics.ts';
import { buildPersistedDefensiveEpisode, type PersistedDefensiveEpisode } from './defensive-episode-persistence.ts';

const CONFIDENCE_RANK: Record<EvaluationConfidence, number> = { verified: 0, inferred: 1, fallback: 2, uncertain: 3 };
function weakestConfidence(...values: EvaluationConfidence[]): EvaluationConfidence {
  return values.reduce((weakest, value) => (CONFIDENCE_RANK[value] > CONFIDENCE_RANK[weakest] ? value : weakest), 'verified' as EvaluationConfidence);
}

/** UN defensivo del kit efectivo de este jugador, ya resuelto (kit + applicability) — el edge function los ensambla desde resolveEffectiveDefensiveKit() + defensive_ability_semantics.applicability. */
export interface EligibleDefensiveInput {
  spellId: number;
  isDefensiveKitMember: boolean;
  createsMissableOpportunity: boolean;
  mechanisms: DefensiveMechanism[];
  charges: number;
  rechargeMs: number | null;
  durationMs: number | null;
  cooldownMs: number | null;
  /** Confidence de la resolución de kit/timing para ESTE spell (ResolvedDefensive.confidence). */
  confidence: EvaluationConfidence;
  applicability: DamageApplicability | null;
  applicabilityConfidence: 'high' | 'medium' | 'low' | null;
}

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
  /** Episodios que empiezan después de este instante se marcan `excluded` (wipe call/cutoff de evaluación) — null = sin cutoff conocido, nada se excluye por esto. */
  evaluationEndMs: number | null;
  eligibleDefensives: EligibleDefensiveInput[];
  damageTakenGraphPoints: number[];
  graphPointStartMs: number;
  graphPointIntervalMs: number;
  /** DamageTaken crudo de ESTE jugador, todo el pull — mismo array para detectar ventanas (vía attributeWindowAbility) y construir el DamageDescriptor de cada episodio. */
  rawDamageHits: RawDamageHit[];
  /** Casts de ESTE jugador, por spellId — solo hace falta para los spellId del kit efectivo. */
  castsBySpellId: ReadonlyMap<number, number[]>;
  schoolByAbilityId: ReadonlyMap<number, DecodedSchoolMask>;
  combatTableObservations: ReadonlyMap<number, AbilityCombatTableCounts>;
  /** Vacío si no se pidieron Debuffs(Enemies) para este pull (fetch condicional — ver damage-descriptor-wcl.ts). */
  bossDebuffIntervals: readonly DebuffInterval[];
  /** Confidence base de la resolución de build/game_build para esta fila — techo de lo que puede afirmar cualquier episodio de este jugador/pull. */
  dataConfidence: EvaluationConfidence;
  continuityGapMs?: number;
  windowDetectionFactor?: number;
}

function toDefensiveCooldownAdapter(defensive: EligibleDefensiveInput): DefensiveCooldown {
  return {
    spellId: defensive.spellId,
    name: `spell:${defensive.spellId}`,
    class: '',
    spec: null,
    specOverride: null,
    category: 'personal_defensive',
    baseCooldownMs: defensive.cooldownMs,
    durationMs: defensive.durationMs,
    survivalType: null,
  };
}

function excludedVerdict(reason: string): EpisodeVerdictResult {
  return { usageEngaged: false, usedSpellIds: [], responseVerdict: 'excluded', reason, coveredBySpellId: null };
}

/**
 * Todo el pipeline puro para UN jugador/pull: candidatos de daño →
 * episodios → aplicabilidad+disponibilidad+cargas por candidato →
 * veredicto con reconstrucción causal → episodios persistibles completos.
 */
export function evaluateDefensiveEpisodesForPlayer(input: DefensiveEpisodeEvaluatorInput): PersistedDefensiveEpisode[] {
  const kitMembers = input.eligibleDefensives.filter((d) => d.isDefensiveKitMember);
  if (!kitMembers.length) return [];

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

  const results: PersistedDefensiveEpisode[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i];
    const window = episodeWindows[i];

    if (input.evaluationEndMs != null && window.startMs > input.evaluationEndMs) {
      results.push(
        buildPersistedDefensiveEpisode({
          pullId: input.pullId,
          playerName: input.playerName,
          window: {
            occurrenceId: episode.occurrenceId,
            dominantAbilityGameId: episode.dominantAbilityGameId,
            memberIndexes: episode.memberIndexes,
            startMs: episode.startMs,
            endMs: episode.endMs,
            peakMs: episode.peakMs,
          },
          candidates: [],
          verdict: excludedVerdict('Episodio posterior al cutoff de evaluación (wipe call) — no se evalúa.'),
          confidence: input.dataConfidence,
          evidence: { groupingBasis: episode.groupingBasis },
        }),
      );
      continue;
    }

    // El hit representativo del episodio para el DamageDescriptor: el más
    // cercano al pico entre los que comparten la abilityGameID dominante
    // (mismo criterio de "evidencia real más próxima al momento evaluado"
    // que ya usa attributeWindowAbility para atribuir la ventana).
    const candidateHits = episode.dominantAbilityGameId != null ? hitsByAbility.get(episode.dominantAbilityGameId) ?? [] : [];
    const representativeHit =
      candidateHits
        .filter((h) => typeof h.timestamp === 'number')
        .sort((a, b) => Math.abs((a.timestamp as number) - episode.peakMs) - Math.abs((b.timestamp as number) - episode.peakMs))[0] ??
      { abilityGameID: episode.dominantAbilityGameId ?? undefined };

    const baseDescriptor = buildDamageDescriptor(representativeHit, {
      schoolByAbilityId: input.schoolByAbilityId,
      combatTableObservations: input.combatTableObservations,
    });

    const causalCandidates: CausallyAwareCandidate[] = [];
    const confidences: EvaluationConfidence[] = [input.dataConfidence];

    for (const defensive of kitMembers) {
      const sourceAffectedBySpell =
        defensive.applicability?.requiresSourceAffectedBySpell === true && input.bossActorId != null
          ? isSourceAffectedBySpellAt(input.bossDebuffIntervals, input.bossActorId, defensive.spellId, episode.peakMs)
          : null;
      const descriptor = { ...baseDescriptor, sourceAffectedBySpell };
      const applicabilityResult = canDefensiveCover(defensive.applicability, defensive.applicabilityConfidence, descriptor);

      const cd = toDefensiveCooldownAdapter(defensive);
      const castsForSpellMs = input.castsBySpellId.get(defensive.spellId) ?? [];
      const { usedDuringEpisode, statusAtPeak } = summarizeCandidateForEpisode(
        cd,
        defensive.mechanisms,
        castsForSpellMs,
        window,
        defensive.charges,
        undefined,
        defensive.rechargeMs,
      );

      causalCandidates.push({
        spellId: defensive.spellId,
        isDefensiveKitMember: defensive.isDefensiveKitMember,
        createsMissableOpportunity: defensive.createsMissableOpportunity,
        applicability: applicabilityResult.verdict,
        usedDuringEpisode,
        statusAtPeak,
        cd,
        mechanisms: defensive.mechanisms,
        castsForSpellMs,
      });
      confidences.push(defensive.confidence);
    }

    const verdict = resolveEpisodeVerdictWithCausalAvailability(causalCandidates, episodeWindows, i);

    results.push(
      buildPersistedDefensiveEpisode({
        pullId: input.pullId,
        playerName: input.playerName,
        window: {
          occurrenceId: episode.occurrenceId,
          dominantAbilityGameId: episode.dominantAbilityGameId,
          memberIndexes: episode.memberIndexes,
          startMs: episode.startMs,
          endMs: episode.endMs,
          peakMs: episode.peakMs,
        },
        candidates: causalCandidates,
        verdict,
        confidence: weakestConfidence(...confidences),
        evidence: { groupingBasis: episode.groupingBasis, dominantAbilityGameId: episode.dominantAbilityGameId },
      }),
    );
  }

  return results;
}
