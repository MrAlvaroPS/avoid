// Colocar en: src/app/core/canonical-defensive-summary.service.ts
// §Frontend cutover de la infografía de raider hacia la fuente defensiva canónica (AGENTS.md §22/§80,
// iris-defensive-canonicalization-v1-plan.md §2.5/§2.6): única puerta de entrada frontend a la generación
// defensiva PUBLICADA. Resuelve pointer → generation → filas de player_pull_defensive_episode_evaluations →
// KPIs canónicos, reutilizando VERBATIM el agregador puro de Usage/Response (defensive-episode-kpis.ts) — este
// archivo nunca reimplementa esa fórmula, solo la orquesta contra Supabase y añade la agregación de Gestión
// (que no tiene evaluator compartido todavía) más las comprobaciones de completitud/identidad de versión.
//
// Contrato de fail-closed (revisado en la aprobación del plan, 2026-09-05):
// - `incompatible` / `unavailable` / `error`: no existe ningún subconjunto de filas semánticamente seguro (o no
//   hay generación publicada, o hubo un error real). Los tres KPI se fuerzan a null/insufficient_evidence.
// - `partial`: SÍ hay un subconjunto seguro, pero no cubre todos los pulls jugados por el jugador esta noche.
//   Los KPI se calculan de verdad sobre ese subconjunto — nunca N/D solo por incompletitud — y `coverage` dice
//   exactamente cuántos pulls entran en el número.
// - `available`: cobertura completa.
// La identidad de versión usa la propia generación publicada como autoridad (nunca una "mayoría" entre las
// filas devueltas) — una fila cuyas versiones no coincidan con defensive_generations se excluye y se registra en
// integrityIssues, sin tumbar el resto del cálculo.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { errorMessage } from '../shared/error-message.util';
// §Corrección de límite de dependencias (2026-09-05): aggregateDefensiveEpisodeKpis/ResponseVerdict se
// reutilizan tal cual desde defensive-episode-kpis.ts — una hoja pura sin dependencias (ver el comentario en
// ese archivo). NUNCA se importa nada de defensive-episode-persistence.ts ni defensive-episode-verdict.ts:
// ambos arrastran imports de valor con extensión .ts estilo Deno (identity.ts/temporal-coverage.ts) que rompen
// la compilación incremental de Angular (ng serve) si se intenta resolverlos vía allowImportingTsExtensions.
// ApplicabilityVerdict/DefensiveCooldownStatus/EvaluationConfidence SÍ son hojas limpias (cero imports) y se
// reutilizan igual. RawPersistedDefensiveEpisode/CanonicalEpisodeVerdictCandidate/PlanVerdict de abajo son
// contratos de forma (el JSON tal como lo persiste el backend, nunca reimplementado) — no lógica ni fórmula.
import {
  aggregateDefensiveEpisodeKpis,
  type DefensiveEpisodeKpiAggregate,
  type ResponseVerdict,
} from '../../../supabase/functions/_shared/defensive-episode-kpis';
import type { ApplicabilityVerdict } from '../../../supabase/functions/_shared/defensive-applicability';
import type { DefensiveCooldownStatus } from '../../../supabase/functions/_shared/defensive-cooldowns';
import type { EvaluationConfidence } from '../../../supabase/functions/_shared/combat-evaluation-contract';

export type CanonicalDefensiveState = 'available' | 'partial' | 'incompatible' | 'unavailable' | 'error';

/** Mismos 2 valores que PlanVerdict en defensive-episode-persistence.ts — no se importa desde allí (ver
 * comentario de imports arriba); es un contrato de forma trivial, no una segunda implementación. */
export type PlanVerdict = 'covered' | 'missed';

/** Espejo estructural de EpisodeVerdictCandidate (defensive-episode-verdict.ts) — mismo shape exacto, nunca
 * importado desde allí (ver comentario de imports arriba). Solo describe la forma del JSON ya persistido. */
export interface CanonicalEpisodeVerdictCandidate {
  spellId: number;
  isDefensiveKitMember: boolean;
  createsMissableOpportunity: boolean;
  materiallyUnresolved: boolean;
  damageApplicability: ApplicabilityVerdict;
  temporalOpportunity: ApplicabilityVerdict;
  temporalCastCoverage: ApplicabilityVerdict;
  engagement: boolean;
  statusAtPeak: DefensiveCooldownStatus;
  confidence: EvaluationConfidence;
  membershipConfidence?: EvaluationConfidence;
  applicabilityClaimConfidence?: EvaluationConfidence;
  availabilityConfidence?: EvaluationConfidence;
  coverageConfidence?: EvaluationConfidence;
  evidence: Record<string, unknown>;
}

/** Espejo estructural de PersistedDefensiveEpisode (defensive-episode-persistence.ts) — la forma exacta de UN
 * elemento del jsonb `episodes` tal como lo persiste el backend. Nunca importado desde allí (ver arriba). */
export interface RawPersistedDefensiveEpisode {
  episodeId: string;
  causalGroupId: string;
  startMs: number;
  peakMs: number;
  endMs: number;
  /** WCL DamageTaken graph bucket magnitude selected by the canonical detector — mirrors PersistedDefensiveEpisode.peakValue. */
  peakValue?: number;
  usageEngaged: boolean;
  usageEvaluable: boolean;
  usedSpellIds: number[];
  applicableCandidates: CanonicalEpisodeVerdictCandidate[];
  responseVerdict: ResponseVerdict;
  responseReason: string;
  coveredBySpellId: number | null;
  planAssignmentId: string | null;
  planVerdict: PlanVerdict | null;
  evidence: Record<string, unknown>;
  confidence: EvaluationConfidence;
}

export interface CanonicalDefensiveEpisodeFact {
  episodeId: string;
  causalGroupId: string;
  pullId: string;
  startMs: number;
  peakMs: number;
  endMs: number;
  /** Magnitud del bucket del gráfico DamageTaken de WCL que el detector canónico marcó como pico — mismas
   * unidades sin re-etiquetar (ver PersistedDefensiveEpisode.peakValue). Solo verificable/existe desde que el
   * detector persiste este campo; null en episodios más antiguos o si el detector no lo calculó. */
  peakValue: number | null;
  /** De episode.evidence.dominantAbilityGameId (v7 no lo expone en la raíz del episodio) — null si el episodio no está atado a una habilidad identificable. */
  dominantAbilityGameId: number | null;
  usageEngaged: boolean;
  usageEvaluable: boolean;
  usedSpellIds: number[];
  applicableCandidates: CanonicalEpisodeVerdictCandidate[];
  responseVerdict: ResponseVerdict;
  responseReason: string;
  coveredBySpellId: number | null;
  decisiveSpellIds: number[];
  planAssignmentId: string | null;
  planVerdict: PlanVerdict | null;
  confidence: EvaluationConfidence;
}

export interface CanonicalUsageKpi {
  status: 'available' | 'insufficient_evidence';
  score: number | null;
  engaged: number;
  evaluable: number;
}

export interface CanonicalResponseKpi {
  status: 'available' | 'insufficient_evidence';
  score: number | null;
  covered: number;
  evaluable: number;
  missedReady: number;
  missedMistimed: number;
}

export interface CanonicalManagementKpi {
  status: 'available' | 'no_plan' | 'insufficient_evidence';
  score: number | null;
  fulfilled: number;
  evaluable: number;
  /** §generic-usage-fallback (2026-09-10): 'plan' = adherencia real a un plan asignado (fulfilled/evaluable =
   *  asignaciones cumplidas/totales). 'generic_usage' = sin plan publicado (defensiveDeployedPlans apagado o
   *  sin asignación esta noche): fulfilled/evaluable pasan a significar casts reales/máximo teórico de
   *  cooldown — eficiencia de uso de TODO el kit core, no solo si acertó el pico. Nunca se mezclan ambos
   *  significados en la misma fila; el modo determina cuál aplica. */
  mode: 'plan' | 'generic_usage';
}

export interface CanonicalDefensiveGeneration {
  id: string;
  publishedAt: string | null;
  semanticVersion: string;
  resolverVersion: string;
  semanticResolverVersion: string;
  episodeVersion: string | null;
  evaluatorVersion: string | null;
  gameBuild: string;
}

export interface CanonicalDefensiveSummary {
  state: CanonicalDefensiveState;
  /** expectedPulls = pulls jugados por el jugador esta noche Y presentes en canonical_scored_pulls (población
   *  canónica real usada por el evaluator — nunca los pulls crudos sin filtrar). evaluatedPulls = de esos,
   *  cuántos aportan realmente a los números de abajo (fila segura encontrada, episodes:[] cuenta como segura). */
  coverage: { evaluatedPulls: number; expectedPulls: number };
  usage: CanonicalUsageKpi;
  response: CanonicalResponseKpi;
  management: CanonicalManagementKpi;
  context: { unavailableLegitimate: number; noApplicableResource: number; uncertain: number; excluded: number };
  totalEpisodes: number;
  episodes: CanonicalDefensiveEpisodeFact[];
  /** §defensive-kit-panel (2026-09-11) — un elemento por spellId distinto visto en effective_kit a lo largo
   * de la noche (deduplicado; el cooldown de un spell no cambia pull a pull salvo respec real, así que se
   * conserva la primera aparición). Nunca el catálogo completo — solo lo que el evaluator resolvió como
   * parte del kit real de este jugador/build esta noche. */
  kit: EffectiveKitEntry[];
  generation: CanonicalDefensiveGeneration | null;
  integrityIssues: string[];
  /** Nunca se muestra como KPI — agregado crudo (incluida cualquier fila excluida) para trazabilidad/futura pantalla de origen. */
  diagnostics: {
    usage: DefensiveEpisodeKpiAggregate['usage'];
    response: DefensiveEpisodeKpiAggregate['response'];
    rowsExpected: number;
    rowsFound: number;
  };
}

interface EpisodeEvidenceShape {
  dominantAbilityGameId?: number | null;
  decisiveSpellIds?: number[];
}

/** §generic-usage-fallback — espejo estructural de UN elemento de effective_kit tal como lo persiste el
 * backend (ver resolveEffectiveDefensiveKit/ResolvedDefensive en effective-defensives.ts); solo los campos que
 * necesita el cálculo de eficiencia de cooldown, nunca reimportado desde el módulo Deno (mismo criterio que el
 * resto de este archivo). */
export interface EffectiveKitEntry {
  spellId: number;
  isDefensiveKitMember: boolean;
  opportunityMode: 'normal' | 'credit_only' | 'none';
  effectiveCooldownMs: number | null;
  charges: number | null;
  rechargeMs: number | null;
}

/** Exportada — es exactamente la forma de fila que devuelve Supabase (snake_case), para poder construir
 * fixtures de test sin mockear el cliente (§ decisión de test: probar la lógica pura, no la orquestación). */
export interface EpisodeEvaluationDbRow {
  pull_id: string;
  episode_evaluator_version: string;
  semantic_version: string;
  semantic_resolver_version: string;
  resolver_version: string;
  episodes: RawPersistedDefensiveEpisode[];
  /** Opcional — filas de generaciones anteriores a §generic-usage-fallback, o fixtures de test que no
   * ejercitan la eficiencia de cooldown, no lo tienen. buildGenericUsageKpi trata ausente/null como kit vacío. */
  effective_kit?: EffectiveKitEntry[] | null;
}

/** §generic-usage-fallback — forma de fila de player_pull_records para leer casts reales, independiente de
 * episodios/generación (un cast real cuenta aunque no haya generado ningún episodio evaluable). */
export interface PullDefensiveCastsRow {
  pull_id: string;
  defensive_casts: { spellId?: number; timestampsMs?: number[] }[] | null;
}

interface GenerationDbRow {
  id: string;
  status: string;
  semantic_version: string;
  resolver_version: string;
  semantic_resolver_version: string;
  episode_version: string | null;
  evaluator_version: string | null;
  game_build: string;
  published_at: string | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const EMPTY_MANAGEMENT: CanonicalManagementKpi = {
  status: 'insufficient_evidence',
  score: null,
  fulfilled: 0,
  evaluable: 0,
  mode: 'generic_usage',
};

const EMPTY_USAGE: CanonicalUsageKpi = { status: 'insufficient_evidence', score: null, engaged: 0, evaluable: 0 };
const EMPTY_RESPONSE: CanonicalResponseKpi = {
  status: 'insufficient_evidence',
  score: null,
  covered: 0,
  evaluable: 0,
  missedReady: 0,
  missedMistimed: 0,
};
const EMPTY_CONTEXT = { unavailableLegitimate: 0, noApplicableResource: 0, uncertain: 0, excluded: 0 };
const EMPTY_KPI_AGGREGATE_SLICE: Pick<DefensiveEpisodeKpiAggregate, 'usage' | 'response'> = {
  usage: { status: 'insufficient_evidence', engaged: 0, evaluable: 0, score: null },
  response: { status: 'insufficient_evidence', covered: 0, evaluable: 0, score: null, missedReady: 0, missedMistimed: 0 },
};

export function closedCanonicalDefensiveSummary(
  state: 'unavailable' | 'incompatible' | 'error',
  integrityIssues: string[],
  generation: CanonicalDefensiveGeneration | null,
  coverage: { evaluatedPulls: number; expectedPulls: number } = { evaluatedPulls: 0, expectedPulls: 0 },
): CanonicalDefensiveSummary {
  return {
    state,
    coverage,
    usage: EMPTY_USAGE,
    response: EMPTY_RESPONSE,
    management: EMPTY_MANAGEMENT,
    context: EMPTY_CONTEXT,
    totalEpisodes: 0,
    episodes: [],
    kit: [],
    generation,
    integrityIssues,
    diagnostics: { ...EMPTY_KPI_AGGREGATE_SLICE, rowsExpected: coverage.expectedPulls, rowsFound: 0 },
  };
}

@Injectable({ providedIn: 'root' })
export class CanonicalDefensiveSummaryService {
  private supabase = inject(SupabaseService);

  /**
   * @param participatedPullIds Pulls donde el jugador tiene fila en player_pull_records para este report — el
   *   caller (night-player-summary.service.ts) ya tiene esta lista de participación; este servicio no la
   *   recalcula, pero SÍ la cruza contra canonical_scored_pulls (población real que usó el evaluator) antes de
   *   tratarla como "esperado".
   */
  async getSummary(
    reportCode: string,
    playerName: string,
    participatedPullIds: string[],
  ): Promise<CanonicalDefensiveSummary> {
    try {
      return await this.resolve(reportCode, playerName, participatedPullIds, false);
    } catch (e) {
      return closedCanonicalDefensiveSummary(
        'error',
        [`Error resolviendo la generación defensiva canónica: ${errorMessage(e)}`],
        null,
      );
    }
  }

  private async readPublishedGenerationId(): Promise<string | null> {
    const { data, error } = await this.supabase.client
      .from('defensive_generation_pointer')
      .select('published_generation_id')
      .eq('id', true)
      .maybeSingle();
    if (error) throw error;
    return (data as { published_generation_id: string | null } | null)?.published_generation_id ?? null;
  }

  private async readGeneration(id: string): Promise<CanonicalDefensiveGeneration | null> {
    const { data, error } = await this.supabase.client
      .from('defensive_generations')
      .select('id, status, semantic_version, resolver_version, semantic_resolver_version, episode_version, evaluator_version, game_build, published_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    const row = data as GenerationDbRow | null;
    if (!row || row.status !== 'published') return null;
    return {
      id: row.id,
      publishedAt: row.published_at,
      semanticVersion: row.semantic_version,
      resolverVersion: row.resolver_version,
      semanticResolverVersion: row.semantic_resolver_version,
      episodeVersion: row.episode_version,
      evaluatorVersion: row.evaluator_version,
      gameBuild: row.game_build,
    };
  }

  /** Población canónica real (§invariante 2 de AGENTS.md: nunca un WHERE ad hoc) — solo los pulls de este report que de verdad pudo evaluar el pipeline defensivo. */
  private async readCanonicalScoredPullIds(reportCode: string): Promise<Set<string>> {
    const { data, error } = await this.supabase.client
      .from('canonical_scored_pulls')
      .select('id')
      .eq('report_code', reportCode);
    if (error) throw error;
    return new Set(((data ?? []) as { id: string }[]).map((row) => row.id));
  }

  private async readEpisodeRows(
    generationId: string,
    pullIds: string[],
    playerName: string,
  ): Promise<EpisodeEvaluationDbRow[]> {
    if (!pullIds.length) return [];
    const { data, error } = await this.supabase.client
      .from('player_pull_defensive_episode_evaluations')
      .select(
        'pull_id, episode_evaluator_version, semantic_version, semantic_resolver_version, resolver_version, episodes, effective_kit',
      )
      .eq('defensive_generation_id', generationId)
      .eq('player_name', playerName)
      .in('pull_id', pullIds);
    if (error) throw error;
    return (data ?? []) as EpisodeEvaluationDbRow[];
  }

  /** §generic-usage-fallback — duración real de cada pull, para el denominador teórico de eficiencia de
   * cooldown. Independiente de la generación defensiva (viene de `pulls`, nunca de staging). */
  private async readPullDurations(pullIds: string[]): Promise<Map<string, number>> {
    if (!pullIds.length) return new Map();
    const { data, error } = await this.supabase.client
      .from('pulls')
      .select('id, duration_ms')
      .in('id', pullIds);
    if (error) throw error;
    return new Map(
      ((data ?? []) as { id: string; duration_ms: number | null }[]).map((row) => [row.id, row.duration_ms ?? 0]),
    );
  }

  /** §generic-usage-fallback — casts reales del jugador, independientes de si generaron algún episodio
   * evaluable (un cast cuenta para el numerador de eficiencia aunque el detector no lo agrupara en pico). */
  private async readDefensiveCasts(pullIds: string[], playerName: string): Promise<PullDefensiveCastsRow[]> {
    if (!pullIds.length) return [];
    const { data, error } = await this.supabase.client
      .from('player_pull_records')
      .select('pull_id, defensive_casts')
      .eq('player_name', playerName)
      .in('pull_id', pullIds);
    if (error) throw error;
    return (data ?? []) as PullDefensiveCastsRow[];
  }

  private async resolve(
    reportCode: string,
    playerName: string,
    participatedPullIds: string[],
    isRetry: boolean,
  ): Promise<CanonicalDefensiveSummary> {
    const pointerBefore = await this.readPublishedGenerationId();
    if (!pointerBefore) {
      return closedCanonicalDefensiveSummary('unavailable', ['No hay ninguna generación defensiva publicada todavía.'], null);
    }
    const generation = await this.readGeneration(pointerBefore);
    if (!generation) {
      return closedCanonicalDefensiveSummary(
        'unavailable',
        [`El puntero apunta a la generación ${pointerBefore}, pero no existe o no está publicada.`],
        null,
      );
    }

    const scoredPullIds = await this.readCanonicalScoredPullIds(reportCode);
    const expectedPullIds = [...new Set(participatedPullIds)].filter((id) => scoredPullIds.has(id));

    const [rows, pullDurations, castRows] = await Promise.all([
      this.readEpisodeRows(generation.id, expectedPullIds, playerName),
      this.readPullDurations(expectedPullIds),
      this.readDefensiveCasts(expectedPullIds, playerName),
    ]);

    const pointerAfter = await this.readPublishedGenerationId();
    if (pointerAfter !== pointerBefore) {
      if (isRetry) {
        return closedCanonicalDefensiveSummary(
          'incompatible',
          ['El puntero de generación publicada cambió dos veces mientras se leía; no se pudo obtener una lectura consistente.'],
          generation,
          { evaluatedPulls: 0, expectedPulls: expectedPullIds.length },
        );
      }
      return this.resolve(reportCode, playerName, participatedPullIds, true);
    }

    return buildCanonicalDefensiveSummary(generation, expectedPullIds, rows, playerName, pullDurations, castRows);
  }
}

/**
 * Núcleo puro (sin Angular/Supabase) de la construcción del resumen — separado de la clase para poder probar
 * la lógica de completitud/identidad de versión/KPI/Gestión con fixtures planas, sin mockear el cliente
 * (mismo criterio que ya sigue el resto del repo: probar funciones puras, no orquestación de red).
 */
export function buildCanonicalDefensiveSummary(
  generation: CanonicalDefensiveGeneration,
  expectedPullIds: string[],
  rows: EpisodeEvaluationDbRow[],
  playerName: string,
  /** §generic-usage-fallback — opcionales con default vacío: los tests existentes que no ejercitan la
   * eficiencia de cooldown siguen pasando sin tocarlos (mismo criterio que el resto del contrato: aditivo). */
  pullDurations: Map<string, number> = new Map(),
  castRows: PullDefensiveCastsRow[] = [],
): CanonicalDefensiveSummary {
  const integrityIssues: string[] = [];
  const expectedSet = new Set(expectedPullIds);
  const seenPullIds = new Set<string>();
  const safeRows: EpisodeEvaluationDbRow[] = [];

  for (const row of rows) {
    if (!expectedSet.has(row.pull_id)) {
      integrityIssues.push(
        `Fila de ${playerName} para el pull ${row.pull_id} no corresponde a un pull esperado esta noche; excluida.`,
      );
      continue;
    }
    if (seenPullIds.has(row.pull_id)) {
      integrityIssues.push(`Fila duplicada de ${playerName} para el pull ${row.pull_id}; se ignora la repetición.`);
      continue;
    }
    const versionMatches =
      row.episode_evaluator_version === generation.evaluatorVersion &&
      row.semantic_version === generation.semanticVersion &&
      row.semantic_resolver_version === generation.semanticResolverVersion &&
      row.resolver_version === generation.resolverVersion;
    if (!versionMatches) {
      integrityIssues.push(
        `Fila de ${playerName} para el pull ${row.pull_id} no coincide con las versiones de la generación publicada (${generation.id}); excluida.`,
      );
      continue;
    }
    seenPullIds.add(row.pull_id);
    safeRows.push(row);
  }

  const evaluatedPulls = seenPullIds.size;
  const expectedPulls = expectedSet.size;
  const coverage = { evaluatedPulls, expectedPulls };

  const rawEpisodes = rows.flatMap((row) => row.episodes);
  const safeEpisodes = safeRows.flatMap((row) => toEpisodeFacts(row));

  const rawAgg = aggregateDefensiveEpisodeKpis(rawEpisodes);

  let state: CanonicalDefensiveState;
  if (evaluatedPulls === 0 && expectedPulls > 0) {
    state = 'incompatible';
    integrityIssues.push('Ninguna fila superó la comprobación de identidad de versión frente a la generación publicada.');
  } else if (evaluatedPulls < expectedPulls) {
    state = 'partial';
  } else {
    state = 'available';
  }

  const showKpis = state === 'available' || state === 'partial';
  const safeAgg = showKpis ? aggregateDefensiveEpisodeKpis(safeEpisodes) : null;

  let management: CanonicalManagementKpi = EMPTY_MANAGEMENT;
  if (showKpis) {
    const planManagement = buildManagementKpi(safeEpisodes, integrityIssues);
    management =
      planManagement.status === 'no_plan'
        ? buildGenericUsageKpi(safeRows, pullDurations, castRows)
        : planManagement;
  }

  return {
    state,
    coverage,
    usage: safeAgg
      ? { status: safeAgg.usage.status, score: safeAgg.usage.score, engaged: safeAgg.usage.engaged, evaluable: safeAgg.usage.evaluable }
      : EMPTY_USAGE,
    response: safeAgg
      ? {
          status: safeAgg.response.status,
          score: safeAgg.response.score,
          covered: safeAgg.response.covered,
          evaluable: safeAgg.response.evaluable,
          missedReady: safeAgg.response.missedReady,
          missedMistimed: safeAgg.response.missedMistimed,
        }
      : EMPTY_RESPONSE,
    management,
    context: safeAgg
      ? {
          unavailableLegitimate: safeAgg.unavailableLegitimate,
          noApplicableResource: safeAgg.noApplicableResource,
          uncertain: safeAgg.uncertain,
          excluded: safeAgg.excluded,
        }
      : EMPTY_CONTEXT,
    totalEpisodes: showKpis ? safeEpisodes.length : 0,
    episodes: showKpis ? safeEpisodes : [],
    kit: showKpis ? dedupeKit(safeRows) : [],
    generation,
    integrityIssues,
    diagnostics: {
      usage: rawAgg.usage,
      response: rawAgg.response,
      rowsExpected: expectedPulls,
      rowsFound: rows.length,
    },
  };
}

/** §defensive-kit-panel — un elemento por spellId de kit real (isDefensiveKitMember), primera aparición
 * conservada (el cooldown de un spell no cambia pull a pull salvo respec real). */
function dedupeKit(rows: EpisodeEvaluationDbRow[]): EffectiveKitEntry[] {
  const bySpell = new Map<number, EffectiveKitEntry>();
  for (const row of rows) {
    for (const entry of row.effective_kit ?? []) {
      if (!entry.isDefensiveKitMember) continue;
      if (!bySpell.has(entry.spellId)) bySpell.set(entry.spellId, entry);
    }
  }
  return [...bySpell.values()];
}

function toEpisodeFacts(row: EpisodeEvaluationDbRow): CanonicalDefensiveEpisodeFact[] {
  return row.episodes.map((episode) => {
    const evidence = episode.evidence as EpisodeEvidenceShape | undefined;
    return {
      episodeId: episode.episodeId,
      causalGroupId: episode.causalGroupId,
      pullId: row.pull_id,
      startMs: episode.startMs,
      peakMs: episode.peakMs,
      endMs: episode.endMs,
      peakValue: episode.peakValue ?? null,
      dominantAbilityGameId: evidence?.dominantAbilityGameId ?? null,
      usageEngaged: episode.usageEngaged,
      usageEvaluable: episode.usageEvaluable,
      usedSpellIds: episode.usedSpellIds,
      applicableCandidates: episode.applicableCandidates,
      responseVerdict: episode.responseVerdict,
      responseReason: episode.responseReason,
      coveredBySpellId: episode.coveredBySpellId,
      decisiveSpellIds: evidence?.decisiveSpellIds ?? [],
      planAssignmentId: episode.planAssignmentId,
      planVerdict: episode.planVerdict,
      confidence: episode.confidence,
    };
  });
}

/**
 * Gestión (§2.5.3 del plan / §23 de AGENTS.md) — agregación propia, pequeña y explícita, nunca reutiliza
 * management_score de player_pull_defensive_evaluations (otra generación conceptual, otros pesos).
 */
export function buildManagementKpi(
  episodes: CanonicalDefensiveEpisodeFact[],
  integrityIssues: string[],
): CanonicalManagementKpi {
  const byAssignment = new Map<string, PlanVerdict>();
  for (const episode of episodes) {
    if (episode.planAssignmentId == null) continue;
    if (episode.planVerdict == null) {
      integrityIssues.push(
        `Episodio ${episode.episodeId} referencia planAssignmentId ${episode.planAssignmentId} sin planVerdict; excluido de Gestión.`,
      );
      continue;
    }
    const existing = byAssignment.get(episode.planAssignmentId);
    if (existing != null && existing !== episode.planVerdict) {
      integrityIssues.push(
        `La asignación de plan ${episode.planAssignmentId} tiene veredictos distintos entre episodios (${existing} vs ${episode.planVerdict}); se conserva el primero visto.`,
      );
      continue;
    }
    byAssignment.set(episode.planAssignmentId, episode.planVerdict);
  }
  const evaluable = byAssignment.size;
  if (evaluable === 0) return { status: 'no_plan', score: null, fulfilled: 0, evaluable: 0, mode: 'plan' };
  const fulfilled = [...byAssignment.values()].filter((verdict) => verdict === 'covered').length;
  return { status: 'available', score: round2((fulfilled / evaluable) * 100), fulfilled, evaluable, mode: 'plan' };
}

/**
 * §generic-usage-fallback (2026-09-10, hallazgo empírico real: Txerokee lanzó Astral Shift 30 veces esa
 * noche pero Uso/Response solo "veían" un puñado — ambos KPI están deliberadamente acotados a episodios
 * evaluables concretos, nunca a la actividad general del kit). Ocupa el hueco de Gestión SOLO cuando no hay
 * plan asignado (buildManagementKpi devolvió 'no_plan') — si algún día se publica un plan real, ese branch
 * sigue ganando siempre, este es puramente el fallback.
 *
 * Eficiencia de cooldown = Σ(casts reales de cada defensivo core) / Σ(casts teóricos máximos de ese mismo
 * defensivo dado su propio cooldown/cargas y el tiempo de combate real jugado esa noche) — SUMA de cupos, no
 * promedio de porcentajes, para que una clase con varios defensivos core (ej. DK: Anti-Magic Shell + Death
 * Pact + Icebound Fortitude + Lichborne) no necesite ponderación manual: cada spell aporta su propio cupo al
 * total, proporcional a cuántas veces cabe de verdad en el tiempo jugado. Solapar el uso de dos defensivos
 * distintos en el mismo pico no penaliza nada — cada cupo es independiente.
 */
export function buildGenericUsageKpi(
  safeRows: EpisodeEvaluationDbRow[],
  pullDurations: Map<string, number>,
  castRows: PullDefensiveCastsRow[],
): CanonicalManagementKpi {
  const castsByPull = new Map<string, Map<number, number>>();
  for (const row of castRows) {
    const perSpell = new Map<number, number>();
    for (const cast of row.defensive_casts ?? []) {
      if (!Number.isInteger(cast?.spellId) || !Array.isArray(cast?.timestampsMs)) continue;
      perSpell.set(cast.spellId!, (perSpell.get(cast.spellId!) ?? 0) + cast.timestampsMs.length);
    }
    castsByPull.set(row.pull_id, perSpell);
  }

  let theoreticalMax = 0;
  let actualCasts = 0;
  for (const row of safeRows) {
    const durationMs = pullDurations.get(row.pull_id) ?? 0;
    if (durationMs <= 0) continue;
    const castsForPull = castsByPull.get(row.pull_id) ?? new Map<number, number>();
    for (const entry of row.effective_kit ?? []) {
      if (!entry.isDefensiveKitMember || entry.opportunityMode !== 'normal') continue;
      const rechargeMs = entry.rechargeMs ?? entry.effectiveCooldownMs;
      if (rechargeMs == null || rechargeMs <= 0) continue; // sin cadencia conocida — no se puede fijar un máximo real, se excluye en vez de inventarlo
      const startingCharges = entry.charges ?? 1;
      theoreticalMax += startingCharges + Math.floor(durationMs / rechargeMs);
      actualCasts += castsForPull.get(entry.spellId) ?? 0;
    }
  }

  if (theoreticalMax === 0) return { status: 'insufficient_evidence', score: null, fulfilled: 0, evaluable: 0, mode: 'generic_usage' };
  return {
    status: 'available',
    score: Math.min(100, round2((actualCasts / theoreticalMax) * 100)),
    fulfilled: actualCasts,
    evaluable: theoreticalMax,
    mode: 'generic_usage',
  };
}
