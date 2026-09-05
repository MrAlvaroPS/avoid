// §Paso C (iris-defensive-canonicalization-v1-plan.md §2.4/§9): la unidad
// puntuable no es "un bucket de damage-pressure-windows superó el umbral" —
// eso es un DETECTOR DE CANDIDATOS (damage-pressure-windows.ts, que se
// conserva tal cual). La unidad puntuable es un DefensiveEpisode: una
// decisión defensiva causal, que puede contener 1 hit, varios ticks o
// varias ventanas de DamageWindowDetection si en realidad son la misma
// mecánica (caso real de la auditoría: Gusmï, varios picos consecutivos de
// una sola mecánica no pueden convertirse en tres oportunidades perdidas).
//
// §"la agrupación debe venir de la mecánica/occurrence siempre que exista"
// (plan §2.4): la causalidad v3 (mechanic_occurrences,
// combat-evaluation-contract.ts) TODAVÍA está en shadow, no autoritativa
// (ver iris-mechanics-audit-remediation-progress.md, gate "Causalidad v3
// autoritativa: BLOQUEADA") — así que este módulo acepta un occurrenceId
// OPCIONAL por candidato: cuando existe y es consistente entre candidatos,
// manda sobre la heurística. Cuando no existe (el caso real hoy para todo
// el histórico), agrupa por habilidad dominante + continuidad temporal —
// exactamente el criterio ya validado empíricamente durante la auditoría
// (§8 del plan: "los 6 segundos... fueron un diagnóstico"; se mantiene como
// default explícito y sustituible, no una regla mágica escondida).

import type { DamageWindow } from './damage-pressure-windows.ts';

export interface DefensiveEpisodeCandidate {
  window: DamageWindow;
  /** attributeWindowAbility(...).abilityGameID, o null si no se pudo atribuir. */
  dominantAbilityGameId: number | null;
  /**
   * mechanic_occurrences.id cuando la causalidad v3 ya lo resolvió con
   * confianza para este candidato. undefined/null = sin evidencia causal
   * real todavía — el grupo resultante se marca 'heuristic', nunca
   * 'occurrence' por error.
   */
  occurrenceId?: string | null;
}

export interface DefensiveEpisode {
  startMs: number;
  endMs: number;
  peakMs: number;
  peakValue: number;
  dominantAbilityGameId: number | null;
  /** Solo no-null si TODOS los miembros comparten el mismo occurrenceId real. */
  occurrenceId: string | null;
  /**
   * 'occurrence' = todos los candidatos agrupados comparten una mechanic
   * occurrence real — autoritativo cuando exista. 'heuristic' = agrupado por
   * habilidad dominante + continuidad temporal (diagnóstico, ver cabecera de
   * este fichero) — la mayoría de los episodios hoy, mientras v3 siga en
   * shadow.
   */
  groupingBasis: 'occurrence' | 'heuristic';
  /** Índices (en el array de candidatos de entrada) que forman este episodio, en orden. */
  memberIndexes: number[];
}

const DEFAULT_CONTINUITY_GAP_MS = 6000;

/**
 * Agrupa candidatos YA ordenables por tiempo (se ordenan internamente por
 * window.startMs, el orden de entrada no importa) en episodios causales.
 *
 * Regla de fusión candidato→grupo abierto:
 *  - Ambos tienen el MISMO occurrenceId no-nulo → se fusionan siempre,
 *    ignorando el gap (la causalidad real manda sobre cualquier heurística
 *    temporal).
 *  - Si no (falta occurrenceId en alguno de los dos, o difieren):
 *    dominantAbilityGameId no-nulo e IGUAL en ambos, y el hueco entre el
 *    fin del grupo y el inicio del candidato es <= continuityGapMs → se
 *    fusionan (heurística).
 *  - En cualquier otro caso, el candidato abre un episodio nuevo.
 *
 * No se inventa una fusión por habilidad desconocida (dominantAbilityGameId
 * null en cualquiera de los dos lados nunca fusiona por heurística) — más
 * episodios de la cuenta es un problema menor (se resuelve en el evaluator
 * de disponibilidad) que fusionar dos decisiones reales distintas en una.
 */
export function groupDamageWindowsIntoEpisodes(
  candidates: DefensiveEpisodeCandidate[],
  continuityGapMs = DEFAULT_CONTINUITY_GAP_MS,
): DefensiveEpisode[] {
  const order = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.window.startMs - b.candidate.window.startMs);

  interface OpenGroup {
    memberIndexes: number[];
    startMs: number;
    endMs: number;
    peakMs: number;
    peakValue: number;
    dominantAbilityGameId: number | null;
    occurrenceIds: Set<string>;
    hasMemberWithoutOccurrence: boolean;
  }

  const groups: OpenGroup[] = [];
  let current: OpenGroup | null = null;

  for (const { candidate, index } of order) {
    const occurrenceId = candidate.occurrenceId ?? null;
    const sameOccurrence = current && occurrenceId != null && current.occurrenceIds.size === 1 && current.occurrenceIds.has(occurrenceId);
    const sameAbilityWithinGap =
      current &&
      candidate.dominantAbilityGameId != null &&
      current.dominantAbilityGameId === candidate.dominantAbilityGameId &&
      candidate.window.startMs - current.endMs <= continuityGapMs;

    if (current && (sameOccurrence || sameAbilityWithinGap)) {
      current.memberIndexes.push(index);
      current.endMs = Math.max(current.endMs, candidate.window.endMs);
      if (candidate.window.peakValue > current.peakValue) {
        current.peakMs = candidate.window.peakMs;
        current.peakValue = candidate.window.peakValue;
      }
      if (occurrenceId != null) current.occurrenceIds.add(occurrenceId);
      else current.hasMemberWithoutOccurrence = true;
      continue;
    }

    current = {
      memberIndexes: [index],
      startMs: candidate.window.startMs,
      endMs: candidate.window.endMs,
      peakMs: candidate.window.peakMs,
      peakValue: candidate.window.peakValue,
      dominantAbilityGameId: candidate.dominantAbilityGameId,
      occurrenceIds: new Set(occurrenceId != null ? [occurrenceId] : []),
      hasMemberWithoutOccurrence: occurrenceId == null,
    };
    groups.push(current);
  }

  return groups.map((group) => ({
    startMs: group.startMs,
    endMs: group.endMs,
    peakMs: group.peakMs,
    peakValue: group.peakValue,
    dominantAbilityGameId: group.dominantAbilityGameId,
    occurrenceId: !group.hasMemberWithoutOccurrence && group.occurrenceIds.size === 1 ? [...group.occurrenceIds][0] : null,
    groupingBasis: !group.hasMemberWithoutOccurrence && group.occurrenceIds.size === 1 ? 'occurrence' : 'heuristic',
    memberIndexes: group.memberIndexes,
  }));
}
