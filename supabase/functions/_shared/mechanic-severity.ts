// §"me gusta la idea de que no sea un 0.35 fijo y sea variable como
// wipefest" (feedback real, 2026-08-27): comparación de severidad en 3
// niveles, adaptada a nuestra escala (una sola guild) del percentil que usa
// Wipefest contra población mundial. Investigado y verificado esta sesión
// (ver plan guardado / historial de la conversación): su FAQ admite "not
// enough data" en contenido nuevo incluso a SU escala — no hay atajo
// mágico, solo tamaño de muestra. A la nuestra, con menos muestra
// disponible, hace falta un tercer nivel de último recurso.
//
// Orden de preferencia:
//   1. own_history  — historial propio de Avoid (kills, wipe_pct=0) para
//      ese boss+dificultad+mecánica. La señal más representativa: "¿esto
//      es peor que como sueles hacerlo TÚ?".
//   2. world_reference — logs públicos de referencia (ya se traen en
//      sync-boss-mechanics, ver reference_hit_ratio_samples). Disponible
//      desde el pull #1, pero sesgado hacia los mejores kills del mundo —
//      quien consuma `source: 'world_reference'` debe etiquetarlo así, no
//      como "lo típico".
//   3. fixed_threshold — el severity_threshold de siempre (0.35 por
//      defecto, editable a mano en Ajustes). Mismo comportamiento que
//      existía antes de este cambio; ningún regresión para bosses/mecánicas
//      sin muestra suficiente en los dos niveles de arriba.

export type SeveritySource = 'own_history' | 'world_reference' | 'fixed_threshold';

export interface SeverityResult {
  source: SeveritySource;
  /** Percentil (0-100) del ratio actual dentro de la muestra de `source`. null solo en fixed_threshold (no hay muestra que dé un percentil). */
  percentile: number | null;
  /** Sustituye el `ratio >= threshold` de siempre — mismo booleano, origen distinto. */
  isSevere: boolean;
}

/** Por debajo de esto, la distribución (propia o de referencia) es demasiado ruidosa para fiarse — cuenta de MUESTRAS (instancias de mecánica), no de kills, porque un kill puede aportar varias instancias de la misma mecánica. */
export const MIN_OWN_SAMPLE = 5;
export const MIN_REFERENCE_SAMPLE = 5;

/** Fracción (0-100) de `sortedSamples` que es <= value — "¿qué tan mal es este ratio comparado con la muestra?". Requiere `sortedSamples` ya ordenado ascendente (ambas fuentes ya se guardan/pasan así). */
function percentileRank(sortedSamples: number[], value: number): number {
  let count = 0;
  for (const sample of sortedSamples) {
    if (sample <= value) count++;
  }
  return Math.round((count / sortedSamples.length) * 1000) / 10;
}

export function resolveSeverity(params: {
  ratio: number;
  fixedThreshold: number;
  /** Ratios (players_hit/raidSize) de pulls PROPIOS con kill, de esta mecánica en este boss+dificultad — no hace falta que vengan ordenados. */
  ownHistoryRatios: number[];
  /** boss_mechanics_candidates.reference_hit_ratio_samples — ya se guarda ordenado ascendente en sync-boss-mechanics. null/vacío si el boss no se ha (re)clasificado desde que existe esta columna. */
  referenceRatiosSorted: number[] | null;
}): SeverityResult {
  const { ratio, fixedThreshold, ownHistoryRatios, referenceRatiosSorted } = params;

  if (ownHistoryRatios.length >= MIN_OWN_SAMPLE) {
    const sorted = [...ownHistoryRatios].sort((a, b) => a - b);
    const percentile = percentileRank(sorted, ratio);
    // Peor que la mediana de tu propio historial = severo. Mismo centro
    // (50) que usa Wipefest para "rendimiento medio" (ver plan) — aquí el
    // percentil es del RATIO (más alto = peor), no de una puntuación.
    return { source: 'own_history', percentile, isSevere: percentile > 50 };
  }

  if (referenceRatiosSorted && referenceRatiosSorted.length >= MIN_REFERENCE_SAMPLE) {
    const percentile = percentileRank(referenceRatiosSorted, ratio);
    return { source: 'world_reference', percentile, isSevere: percentile > 50 };
  }

  return { source: 'fixed_threshold', percentile: null, isSevere: ratio >= fixedThreshold };
}
