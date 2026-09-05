// §Paso C — iris-defensive-canonicalization-v1-plan.md §2.6, corrección de
// infraestructura #2: la identidad de un DefensiveEpisode tiene que ser
// estable y NO depender del veredicto/evidencia (eso es justo el bug real
// ya encontrado en `materialize-execution-ledger/index.ts`: el
// `deduplicationKey` legacy incluye un hash de `evidence`, así que una
// reevaluación con la MISMA decisión pero evidencia nueva inserta una fila
// en vez de actualizar la existente).
//
// Regla exacta del plan: `episodeId` prioriza `occurrenceId` cuando existe
// (ya es un UUID globalmente único de `mechanic_occurrence_evaluations`);
// si es heurístico (groupingBasis='heuristic' en
// `defensive-episode-grouping.ts`), `hash(pullId + player + índices de
// ventana ordenados + dominantAbility + start/end)` — identifica QUÉ
// episodio es, no CUÁNDO ocurrió (dos mecánicas distintas pueden compartir
// milisegundo).

export interface EpisodeIdentitySource {
  /** DefensiveEpisode.occurrenceId — manda siempre que exista, ver cabecera. */
  occurrenceId: string | null;
  dominantAbilityGameId: number | null;
  /** DefensiveEpisode.memberIndexes — el orden de entrada NO importa para la identidad, se ordenan aquí. */
  memberIndexes: number[];
  startMs: number;
  endMs: number;
}

/**
 * Hash determinista de 16 caracteres hex (FNV-1a de doble carril, mismo
 * estilo que `stableCausalGroupId` de `materialize-execution-ledger` — no
 * se reimporta desde ahí porque ese fichero es un edge function con
 * Deno.serve, no un módulo puro; este SÍ debe serlo para ser testeable
 * desde vitest sin Deno).
 */
function stableHash32(seed: string): string {
  let a = 2_166_136_261;
  let b = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    a = Math.imul(a ^ code, 16_777_619);
    b = Math.imul(b ^ seed.charCodeAt(seed.length - index - 1), 16_777_619);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Identidad estable de UN episodio: `occurrenceId` real cuando existe (§2.6
 * — "manda siempre, sin importar el gap"); si no, un hash heurístico
 * prefijado `heuristic:` para que quede trazable en auditoría cuál de los
 * dos caminos produjo el id (nunca se confunde por accidente con un UUID de
 * occurrence real).
 */
export function resolveDefensiveEpisodeId(
  pullId: string,
  playerName: string,
  episode: EpisodeIdentitySource,
): string {
  if (episode.occurrenceId) return episode.occurrenceId;
  const sortedIndexes = [...episode.memberIndexes].sort((a, b) => a - b);
  const seed = [
    pullId,
    playerName,
    sortedIndexes.join(','),
    episode.dominantAbilityGameId ?? 'null',
    episode.startMs,
    episode.endMs,
  ].join('|');
  return `heuristic:${stableHash32(seed)}`;
}

/**
 * Proyección UUID-shaped de un `episodeId` (que en el caso heurístico no lo
 * es) para `player_execution_events.causal_group_id` (columna `uuid not
 * null`, invariante 7: una mecánica causal genera como máximo una
 * oportunidad por decisión). Determinista: el mismo episodeId siempre
 * produce el mismo causalGroupId, reevaluación tras reevaluación.
 */
export function deriveEpisodeCausalGroupId(episodeId: string): string {
  const hex = stableHash32(`defensive-episode-causal-group:${episodeId}`) + stableHash32(episodeId);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
