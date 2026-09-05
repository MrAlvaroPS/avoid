// §E5 (iris-defensive-canonicalization-v1-plan.md, continuación E4/E5) —
// FUENTE ÚNICA de la regla "¿este episodio cuenta para Uso? ¿para
// Response?" y de los agregados de esos dos KPI. Puro (sin Deno/Supabase),
// para que evaluator/persistencia/ledger/frontend futuro nunca reimplementen
// esta regla por su cuenta ni diverjan entre sí — ver §14 del plan
// ("implementar UNA fuente de verdad pura de KPI").
//
// Uso y Response son DOS KPI independientes sobre el MISMO episodio (nunca
// se infiere Uso desde Response — un Barkskin tarde puede ser Uso=✅/
// Response=❌ simultáneamente, ver defensive-episode-verdict.ts).

// §Corrección de límite de dependencias (2026-09-05, cutover frontend hacia esta fuente): este módulo debe
// seguir siendo una hoja pura sin dependencias — ni siquiera de tipos — hacia el resto del árbol defensivo.
// defensive-episode-persistence.ts/defensive-episode-verdict.ts arrastran imports de VALOR con extensión .ts
// estilo Deno (identity.ts/temporal-coverage.ts) que un consumidor TypeScript en modo "bundler" — como la app
// Angular, que reutiliza este módulo tal cual desde el frontend — no puede resolver sin activar
// allowImportingTsExtensions a nivel de proyecto; esa opción exige noEmit/emitDeclarationOnly, y ambas rompen
// el compilador incremental de Angular (ng serve) en esta versión — confirmado empíricamente. ResponseVerdict
// se define AQUÍ (defensive-episode-verdict.ts lo reimporta y reexporta más abajo, así que ningún otro
// consumidor backend — defensive-episode-persistence.ts, defensive-episode-ledger-events.ts — cambia una sola
// línea). El contrato de episodio que este módulo necesita es un subconjunto estructural mínimo (4 campos),
// nunca PersistedDefensiveEpisode completo — un PersistedDefensiveEpisode real lo sigue satisfaciendo sin
// ningún cambio en las llamadas existentes (tipado estructural, no nominal).

/**
 * Los 7 estados canónicos de respuesta defensiva — misma fuente que antes vivía en
 * defensive-episode-verdict.ts (§10/§11 del plan de canonicalización); el nombre y los valores no cambian.
 */
export type ResponseVerdict =
  | 'covered_verified'
  | 'missed_ready'
  | 'missed_due_to_mistime'
  | 'unavailable_legitimate'
  | 'no_applicable_resource'
  | 'uncertain'
  | 'excluded';

/** Contrato estructural mínimo que este módulo necesita de un episodio — nunca el shape completo de
 * PersistedDefensiveEpisode (ver comentario de arriba). */
export interface DefensiveEpisodeKpiEpisodeInput {
  episodeId: string;
  usageEngaged: boolean;
  usageEvaluable: boolean;
  responseVerdict: ResponseVerdict;
}

/**
 * Los TRES responseVerdict "evaluables" — idénticos para Uso y para
 * Response (§13.1/§13.2 del plan): son los únicos estados donde el episodio
 * realmente presentaba una decisión evaluable (ni excluido, ni una
 * indisponibilidad/ausencia/incertidumbre legítima que no le pertenece a
 * ninguno de los dos KPI).
 */
export const KPI_EVALUABLE_RESPONSE_VERDICTS: ReadonlySet<ResponseVerdict> = new Set([
  'covered_verified',
  'missed_ready',
  'missed_due_to_mistime',
]);

/**
 * Compatibility helper for pre-v5 callers. Canonical v5 persistence receives usageEvaluable directly from the verdict because Usage can be evaluable while Response is uncertain.
 *
 * Denominador legacy de Uso (§13.1): NUNCA "no excluded + algún kit
 * member" (regla vieja, incorrecta — contaba unavailable_legitimate/
 * no_applicable_resource/uncertain como si el jugador "pudiera actuar").
 * Solo estos tres responseVerdict son evaluables para Uso.
 */
export function deriveUsageEvaluable(responseVerdict: ResponseVerdict): boolean {
  return KPI_EVALUABLE_RESPONSE_VERDICTS.has(responseVerdict);
}

/** Denominador canónico de Response (§13.2) — el mismo conjunto que Uso. */
export function deriveResponseEvaluable(responseVerdict: ResponseVerdict): boolean {
  return KPI_EVALUABLE_RESPONSE_VERDICTS.has(responseVerdict);
}

export interface DefensiveEpisodeKpiContribution {
  episodeId: string;
  /** Hecho observado independiente — puede ser true incluso cuando usageEvaluable es false (se conserva en evidencia para auditoría, nunca cuenta para el KPI). */
  usageEngaged: boolean;
  usageEvaluable: boolean;
  responseVerdict: ResponseVerdict;
  responseEvaluable: boolean;
  covered: boolean;
  missedReady: boolean;
  missedMistimed: boolean;
}

/**
 * UN episodio → su contribución a los dos KPI. Nunca cuenta casts — un
 * episodio contribuye como máximo 1 al numerador y 1 al denominador de cada
 * KPI (§13.1 "Do not count casts").
 */
export function deriveDefensiveEpisodeKpiContribution(
  episode: DefensiveEpisodeKpiEpisodeInput,
): DefensiveEpisodeKpiContribution {
  const usageEvaluable = episode.usageEvaluable ?? deriveUsageEvaluable(episode.responseVerdict);
  const responseEvaluable = deriveResponseEvaluable(episode.responseVerdict);
  return {
    episodeId: episode.episodeId,
    usageEngaged: episode.usageEngaged,
    usageEvaluable,
    responseVerdict: episode.responseVerdict,
    responseEvaluable,
    covered: episode.responseVerdict === 'covered_verified',
    missedReady: episode.responseVerdict === 'missed_ready',
    missedMistimed: episode.responseVerdict === 'missed_due_to_mistime',
  };
}

export type DefensiveKpiStatus = 'available' | 'insufficient_evidence';

export interface DefensiveEpisodeKpiAggregate {
  totalEpisodes: number;
  usage: {
    status: DefensiveKpiStatus;
    engaged: number;
    evaluable: number;
    /** 0..100, o null cuando el denominador es cero (§13.3 — nunca 0% fabricado). */
    score: number | null;
  };
  response: {
    status: DefensiveKpiStatus;
    covered: number;
    evaluable: number;
    /** Fórmula EXACTA (§13.2): covered / (covered + missedReady + missedMistimed). Sin pesos, sin multiplicador de severidad/muerte, sin crédito parcial. */
    score: number | null;
    missedReady: number;
    missedMistimed: number;
  };
  unavailableLegitimate: number;
  noApplicableResource: number;
  uncertain: number;
  excluded: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Agregador canónico único (§14). No reimplementa la regla de
 * usageEvaluable/responseEvaluable — reutiliza deriveDefensiveEpisodeKpiContribution
 * episodio a episodio.
 */
export function aggregateDefensiveEpisodeKpis(
  episodes: readonly DefensiveEpisodeKpiEpisodeInput[],
): DefensiveEpisodeKpiAggregate {
  const contributions = episodes.map((episode) => deriveDefensiveEpisodeKpiContribution(episode));

  const usageEvaluable = contributions.filter((c) => c.usageEvaluable);
  const usageEngaged = usageEvaluable.filter((c) => c.usageEngaged);
  const responseEvaluable = contributions.filter((c) => c.responseEvaluable);
  const covered = responseEvaluable.filter((c) => c.covered);
  const missedReady = contributions.filter((c) => c.missedReady).length;
  const missedMistimed = contributions.filter((c) => c.missedMistimed).length;

  return {
    totalEpisodes: episodes.length,
    usage: {
      status: usageEvaluable.length ? 'available' : 'insufficient_evidence',
      engaged: usageEngaged.length,
      evaluable: usageEvaluable.length,
      score: usageEvaluable.length ? round2((usageEngaged.length / usageEvaluable.length) * 100) : null,
    },
    response: {
      status: responseEvaluable.length ? 'available' : 'insufficient_evidence',
      covered: covered.length,
      evaluable: responseEvaluable.length,
      score: responseEvaluable.length ? round2((covered.length / responseEvaluable.length) * 100) : null,
      missedReady,
      missedMistimed,
    },
    unavailableLegitimate: contributions.filter((c) => c.responseVerdict === 'unavailable_legitimate').length,
    noApplicableResource: contributions.filter((c) => c.responseVerdict === 'no_applicable_resource').length,
    uncertain: contributions.filter((c) => c.responseVerdict === 'uncertain').length,
    excluded: contributions.filter((c) => c.responseVerdict === 'excluded').length,
  };
}
