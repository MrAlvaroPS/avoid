import type {
  CanonicalDefensiveEpisodeView,
  NightCanonicalDefensiveSummary,
  NightEvolutionMetric,
  NightPlayerSummary,
} from './night-player-summary.service';
// §Corrección de límite de dependencias (2026-09-05): ResponseVerdict se importa de defensive-episode-kpis.ts
// (hoja pura sin dependencias), nunca de defensive-episode-verdict.ts — ver el comentario de imports en
// canonical-defensive-summary.service.ts para el porqué exacto (rompe ng serve si se resuelve la otra vía).
import type { ResponseVerdict } from '../../../supabase/functions/_shared/defensive-episode-kpis';
import type {
  RaiderEvidenceDefensive,
  RaiderEvidenceItem,
  RaiderEvidenceProjection,
  RaiderEvidenceVerdict,
} from './raider-evidence-projection';
import { classDisplayName, formatDuration, safeSpellName } from '../shared/format.util';

export type RaiderInfographicTone =
  | 'positive'
  | 'danger'
  | 'warning'
  | 'information'
  | 'neutral';

export interface RaiderInfographicMetric {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: RaiderInfographicTone;
}

/** §Frontend cutover (2026-09-05): los tres KPI defensivos acordados — Usage/Response/Management, siempre
 * derivados de summary.canonicalDefensive, nunca de un cuarto "Calidad de evidencia" (eso se queda en el
 * footer). `progressPct` es geometría pura (0..100 o null) — nunca se recupera parseando `value` con regex. */
export interface RaiderInfographicDefensiveMetric {
  key: 'usage' | 'response' | 'management';
  label: string;
  value: string;
  fraction: string;
  detail: string;
  tone: RaiderInfographicTone;
  progressPct: number | null;
}

export interface RaiderCoachingCard {
  id: string;
  priority: number;
  title: string;
  bossId: string | null;
  bossName: string | null;
  iconSpellId: number | null;
  difficulty: string | null;
  pullLabel: string | null;
  timeLabel: string | null;
  verdict: RaiderEvidenceVerdict;
  verdictLabel: string;
  tone: RaiderInfographicTone;
  confidenceLabel: string;
  /** "Qué es la habilidad", bajo boss/pull/hora — null si no hay clasificación revisada. */
  mechanicDescription: string | null;
  whatHappened: string;
  evidence: string;
  correction: string | null;
  correctionSource: string;
  /** "Cómo resolver" en el pie — resolución de la mecánica (distinta de
   * `correction`, que en cards defensivas es la instrucción sobre el CD). */
  resolutionSummary: string | null;
  preventionKey: string | null;
  defensives: Array<RaiderEvidenceDefensive & { statusLabel: string }>;
}

export interface RaiderInfographicTimelineGroup {
  key: string;
  bossName: string;
  difficulty: string;
  /** Boss + dificultad abreviada (N/HC/M), para la etiqueta flotante de la
   * banda continua — con 8-10 bosses en una noche, un grupo puede ser un
   * único pull de ~40px y no cabe "Nombre largo · Heroic" sin solaparse con
   * el siguiente grupo. */
  bossLabel: string;
  cells: {
    pullId: string;
    pullNumber: number;
    scoreLabel: string;
    state: RaiderEvidenceProjection['timeline'][number]['state'];
    stateLabel: string;
  }[];
}

export interface RaiderMechanicDefensiveRow {
  spellId: number;
  name: string;
  coveredCount: number;
  freeUnusedCount: number;
  onCooldownCount: number;
  /** unavailable_legitimate donde este spellId fue decisivo — NUNCA "reserva correcta"/correct_hold, solo indisponibilidad legítima demostrada (§corrección de revisión: no confundir con evidencia de plan/hold). */
  notRequiredCount: number;
  unknownCount: number;
  totalCount: number;
}

/** covered/uncovered son los dos únicos estados con culpa/mérito real. not_required (unavailable_legitimate) y
 * context (uncertain/no_applicable_resource/excluded) son neutrales — nunca se pintan en rojo ni verde
 * (§39/§40 del cutover, corregido en revisión: not_required no es sinónimo de "reserva correcta"). */
export type RaiderMechanicOccurrenceState = 'covered' | 'uncovered' | 'not_required' | 'context';

export interface RaiderMechanicCard {
  key: string;
  mechanicId: number;
  mechanicName: string;
  bossId: string;
  bossName: string;
  difficulty: string;
  coveredCount: number;
  totalCount: number;
  coverageLabel: string;
  /** "Qué es la habilidad", entre el nombre y el ratio — null si no hay clasificación revisada. */
  description: string | null;
  /** "Cómo resolverla", debajo de description. */
  resolution: string | null;
  /** Una línea al pie: por qué esta mecánica aparece aquí (frecuencia esta noche). Siempre presente. */
  relevanceNote: string;
  timingLabel: string | null;
  occurrenceGroups: {
    pullNumber: number;
    cells: {
      key: string;
      state: RaiderMechanicOccurrenceState;
      label: string;
    }[];
  }[];
  defensives: RaiderMechanicDefensiveRow[];
}

export interface RaiderInfographicSignal {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: RaiderInfographicTone;
}

export interface RaiderInfographicDeathCard {
  id: string;
  title: string;
  bossName: string | null;
  when: string;
  verdictLabel: string;
  tone: RaiderInfographicTone;
  observation: string;
  evidence: string | null;
  /** Cifra de daño destacada (serif grande), separada de `evidence` para
   * poder tratarla tipográficamente aparte; null cuando no hay daño medido. */
  damageLabel: string | null;
  defensives: Array<RaiderEvidenceDefensive & { statusLabel: string }>;
}

export interface RaiderInfographicPattern {
  key: string;
  mechanicId: number | null;
  mechanicName: string;
  bossNames: string;
  /** Etiqueta de dificultad solo si el patrón no cruza dificultades esta noche. */
  difficultyLabel: string | null;
  instanceLabel: string;
  /** "Qué es" — null cuando el patrón cruza dificultades o no hay clasificación revisada. */
  description: string | null;
  /** "Cómo resolverla" — mismo criterio que description. */
  resolution: string | null;
}

export interface RaiderInfographicEvolutionCard {
  key: NightEvolutionMetric['key'];
  label: string;
  current: string;
  previous: string;
  delta: string;
  evidence: string;
  direction: NightEvolutionMetric['direction'];
}

export interface RaiderInfographicViewModel {
  identity: {
    playerName: string;
    reportCode: string;
    reportTitle: string;
    reportDateLabel: string;
    avatarUrl: string | null;
    className: string | null;
    specName: string | null;
    role: string | null;
    evaluatedPullCount: number;
    evaluatedBossCount: number;
    bossKillCount: number;
  };
  /** §Frontend cutover (2026-09-05): 1 dimensión general existente (execution, sin cambios de fórmula) + 3 KPI
   * defensivos canónicos — nunca un cuarto "Calidad de evidencia" aquí (§12). Ya no es una lista de métricas
   * equivalentes: response es siempre el KPI defensivo principal (jerarquía visual del triángulo). */
  hero: {
    execution: RaiderInfographicMetric;
    defensive: {
      usage: RaiderInfographicDefensiveMetric;
      response: RaiderInfographicDefensiveMetric;
      management: RaiderInfographicDefensiveMetric;
    };
  };
  nightMetrics: RaiderInfographicMetric[];
  coachingCards: RaiderCoachingCard[];
  additionalCoachingCount: number;
  timelineGroups: RaiderInfographicTimelineGroup[];
  positiveSignals: RaiderInfographicSignal[];
  defensiveMetrics: RaiderInfographicMetric[];
  mechanics: RaiderMechanicCard[];
  additionalMechanicCount: number;
  deaths: RaiderInfographicDeathCard[];
  additionalDeathCount: number;
  patterns: RaiderInfographicPattern[];
  additionalPatternCount: number;
  evolution: {
    previousNightLabel: string | null;
    cards: RaiderInfographicEvolutionCard[];
  };
  evidenceNote: string;
  generationLabel: string | null;
  layout: {
    pullDensity: 'normal' | 'compact' | 'dense';
    mechanicColumns: 2 | 3;
    defensiveDensity: 'normal' | 'compact';
    coachingDensity: 'normal' | 'compact';
  };
}

const VERDICT_LABEL: Record<RaiderEvidenceVerdict, string> = {
  success: 'Éxito',
  confirmed_error: 'Error confirmado',
  coaching: 'Coaching',
  correct_hold: 'Reserva correcta',
  context: 'Contexto',
  no_verdict: 'Sin veredicto',
};

const TIMELINE_LABEL: Record<RaiderEvidenceProjection['timeline'][number]['state'], string> = {
  confirmed_error: 'Error confirmado',
  coaching: 'Coaching',
  correct_hold: 'Reserva correcta',
  clean: 'Sin fallo personal ni muerte evaluable',
  no_data: 'Sin veredicto suficiente',
};

const DEFENSIVE_STATUS_LABEL: Record<RaiderEvidenceDefensive['status'], string> = {
  planned: 'Planificado',
  used: 'Usado',
  available_unused: 'Libre sin usar',
  candidate: 'Alternativa factible',
};

function percent(value: number | null, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits).replace('.', ',')}%`;
}

function metricNumber(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace(/\.0$/, '').replace('.', ',');
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('es-ES', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/** Formato de los tres KPI defensivos — 1 decimal, sin ceros de sobra (78,26→78,3 · 60→60 · 20→20), nunca "—"
 * para null: el hero usa 'N/D' explícito para distinguirlo de un 0% real (§30). */
function defensivePercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'N/D';
  return `${value.toFixed(1).replace(/\.0$/, '').replace('.', ',')}%`;
}

/** Misma escala <50 danger / <75 warning / >=75 positive que el resto de la infografía (§33) — null explícito
 * (`== null`, nunca `score ? … : …`) para que un 0% real siga entrando en 'danger', no en 'neutral'. */
function defensiveTone(score: number | null): RaiderInfographicTone {
  if (score == null) return 'neutral';
  if (score < 50) return 'danger';
  if (score < 75) return 'warning';
  return 'positive';
}

function usageDefensiveMetric(canonical: NightCanonicalDefensiveSummary): RaiderInfographicDefensiveMetric {
  const { usage } = canonical;
  return {
    key: 'usage',
    label: 'Uso',
    value: defensivePercent(usage.score),
    fraction: usage.evaluable === 0 ? 'Sin oportunidades evaluables' : `${usage.engaged}/${usage.evaluable}`,
    detail: '¿Estoy reaccionando defensivamente cuando tengo una oportunidad real?',
    tone: defensiveTone(usage.score),
    progressPct: usage.score,
  };
}

function responseDefensiveMetric(canonical: NightCanonicalDefensiveSummary): RaiderInfographicDefensiveMetric {
  const { response } = canonical;
  return {
    key: 'response',
    label: 'Respuesta',
    value: defensivePercent(response.score),
    fraction: response.evaluable === 0 ? 'Sin oportunidades evaluables' : `${response.covered}/${response.evaluable}`,
    detail: '¿Mi respuesta cubrió realmente la presión?',
    tone: defensiveTone(response.score),
    progressPct: response.score,
  };
}

function managementDefensiveMetric(canonical: NightCanonicalDefensiveSummary): RaiderInfographicDefensiveMetric {
  const { management } = canonical;
  if (management.status === 'no_plan') {
    return {
      key: 'management',
      label: 'Gestión',
      value: 'N/D',
      fraction: 'Sin plan',
      detail: '¿Cumplí el plan defensivo que tenía asignado?',
      tone: 'neutral',
      progressPct: null,
    };
  }
  return {
    key: 'management',
    label: 'Gestión',
    value: defensivePercent(management.score),
    fraction: management.evaluable === 0 ? 'Sin datos suficientes' : `${management.fulfilled}/${management.evaluable}`,
    detail: '¿Cumplí el plan defensivo que tenía asignado?',
    tone: defensiveTone(management.score),
    progressPct: management.score,
  };
}

function verdictTone(verdict: RaiderEvidenceVerdict): RaiderInfographicTone {
  if (verdict === 'confirmed_error') return 'danger';
  if (verdict === 'coaching') return 'warning';
  if (verdict === 'success' || verdict === 'correct_hold') return 'positive';
  if (verdict === 'no_verdict') return 'neutral';
  return 'information';
}

function evidenceSource(item: RaiderEvidenceItem): string {
  const labels = new Set(
    item.provenance.map((ref) => {
      switch (ref.source) {
        case 'pull_mechanic_events':
          return 'eventos WCL + manifiesto revisado';
        case 'player_pull_records.death_cause':
          return 'muerte y ventana temporal WCL';
        case 'player_pull_defensive_evaluations':
          return 'replay defensivo versionado';
        case 'player_pull_defensive_episode_evaluations':
          return 'generación defensiva canónica publicada';
        case 'player_pull_records.gear':
          return 'equipo observado en el primer pull';
      }
    }),
  );
  return [...labels].join(' · ');
}

function defensiveView(defensive: RaiderEvidenceDefensive) {
  return { ...defensive, statusLabel: DEFENSIVE_STATUS_LABEL[defensive.status] };
}

function coachingCard(item: RaiderEvidenceItem, index: number): RaiderCoachingCard {
  return {
    id: item.id,
    priority: index + 1,
    title: item.title,
    bossId: item.bossId,
    bossName: item.bossName,
    iconSpellId: item.mechanicId ?? item.defensives[0]?.spellId ?? null,
    difficulty: item.difficulty,
    pullLabel: item.pullNumber == null ? null : `Pull ${item.pullNumber}`,
    timeLabel: item.atMs == null ? null : formatDuration(item.atMs),
    verdict: item.verdict,
    verdictLabel: VERDICT_LABEL[item.verdict],
    tone: verdictTone(item.verdict),
    confidenceLabel:
      item.confidence === 'verified'
        ? 'Evidencia verificada'
        : item.confidence === 'inferred'
          ? 'Evidencia parcial'
          : 'Sin veredicto fuerte',
    mechanicDescription: item.mechanicDescription,
    whatHappened: item.observation,
    evidence: item.whyItMatters ?? 'No hay una inferencia adicional publicable.',
    correction: item.action,
    correctionSource: evidenceSource(item),
    resolutionSummary: item.resolutionText,
    preventionKey: item.preventionKey,
    defensives: item.defensives.map(defensiveView),
  };
}

function shortDifficulty(difficulty: string): string {
  const normalized = difficulty.trim().toLowerCase();
  if (normalized.startsWith('mythic')) return 'M';
  if (normalized.startsWith('heroic')) return 'HC';
  if (normalized.startsWith('normal')) return 'N';
  if (normalized.startsWith('lfr')) return 'LFR';
  return difficulty;
}

function groupTimeline(projection: RaiderEvidenceProjection): RaiderInfographicTimelineGroup[] {
  const groups = new Map<string, RaiderInfographicTimelineGroup>();
  for (const cell of projection.timeline) {
    const key = `${cell.bossId}|${cell.difficulty}`;
    const group = groups.get(key) ?? {
      key,
      bossName: cell.bossName,
      difficulty: cell.difficulty,
      bossLabel: `${cell.bossName} · ${shortDifficulty(cell.difficulty)}`,
      cells: [],
    };
    group.cells.push({
      pullId: cell.pullId,
      pullNumber: cell.pullNumber,
      scoreLabel: percent(cell.score * 100),
      state: cell.state,
      stateLabel: TIMELINE_LABEL[cell.state],
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

// §"el literal de 'Buena ejecución' podemos quitarlo porque se entiende bien
// viendo el resto de colores... en su lugar un texto muy breve de por qué
// esa mecánica es relevante (para que aparezca ahí)" (feedback real,
// 2026-09-03): ya no es un veredicto de cobertura (eso lo dicen los colores
// de la tabla) — es la razón cuantitativa de inclusión en esta lista.
function mechanicRelevanceNote(totalCount: number): string {
  return totalCount === 1
    ? 'Ventana defensiva única esta noche.'
    : `Se repitió ${totalCount} veces esta noche.`;
}

/** covered_verified es el único estado con mérito real; missed_* es el único con fallo real. unavailable_legitimate
 * y el resto de estados de contexto son neutrales — §39/§40, corregido en revisión: unavailable_legitimate no
 * equivale a "reserva correcta"/correct_hold, solo a indisponibilidad legítima demostrada. */
function occurrenceStateFor(verdict: ResponseVerdict): RaiderMechanicOccurrenceState {
  if (verdict === 'covered_verified') return 'covered';
  if (verdict === 'missed_ready' || verdict === 'missed_due_to_mistime') return 'uncovered';
  if (verdict === 'unavailable_legitimate') return 'not_required';
  return 'context'; // uncertain | no_applicable_resource | excluded
}

const OCCURRENCE_STATE_LABEL: Record<RaiderMechanicOccurrenceState, string> = {
  covered: 'cubierta',
  uncovered: 'sin cobertura',
  not_required: 'no exigible (indisponibilidad legítima)',
  context: 'sin dato suficiente',
};

function occurrenceCellLabel(episode: CanonicalDefensiveEpisodeView, spellNameById: ReadonlyMap<number, string>): string {
  const state = occurrenceStateFor(episode.responseVerdict);
  if (state === 'covered' && episode.coveredBySpellId != null) {
    const name = safeSpellName(spellNameById.get(episode.coveredBySpellId) ?? `#${episode.coveredBySpellId}`);
    return `Pull ${episode.pullNumber} · ${formatDuration(episode.peakMs)} · cubierta con ${name}`;
  }
  if (state === 'uncovered' && episode.responseVerdict === 'missed_due_to_mistime') {
    return `Pull ${episode.pullNumber} · ${formatDuration(episode.peakMs)} · sin cobertura (mal timing demostrado)`;
  }
  return `Pull ${episode.pullNumber} · ${formatDuration(episode.peakMs)} · ${OCCURRENCE_STATE_LABEL[state]}`;
}

function timingLabelFor(pattern: { kind: 'fixed' | 'periodic'; ms: number; sampleSize: number } | null): string | null {
  if (!pattern) return null;
  return pattern.kind === 'fixed'
    ? `Suele ocurrir sobre ${formatDuration(pattern.ms)} · ${pattern.sampleSize} pulls históricos`
    : `Se repite cada ~${formatDuration(pattern.ms)} · ${pattern.sampleSize} repeticiones históricas`;
}

/** Tabla de defensivos por mecánica (§41): pura cuenta sobre applicableCandidates ya persistidos — nunca
 * reproduce un verdict nuevo. on_cooldown NUNCA se etiqueta como mistime (solo missed_due_to_mistime lo
 * demuestra); notRequiredCount NUNCA se muestra como "reserva correcta" (eso exigiría evidencia de plan/hold
 * que este dato no tiene). */
function canonicalDefensiveRows(
  episodes: CanonicalDefensiveEpisodeView[],
  spellNameById: ReadonlyMap<number, string>,
): RaiderMechanicDefensiveRow[] {
  const stats = new Map<
    number,
    { covered: number; freeUnused: number; onCooldown: number; notRequired: number; unknown: number }
  >();
  for (const episode of episodes) {
    for (const candidate of episode.applicableCandidates) {
      if (!candidate.isDefensiveKitMember) continue;
      const stat = stats.get(candidate.spellId) ?? { covered: 0, freeUnused: 0, onCooldown: 0, notRequired: 0, unknown: 0 };
      if (episode.responseVerdict === 'covered_verified' && episode.usedSpellIds.includes(candidate.spellId)) stat.covered++;
      if (candidate.statusAtPeak === 'available_unused') stat.freeUnused++;
      if (candidate.statusAtPeak === 'on_cooldown') stat.onCooldown++;
      if (episode.responseVerdict === 'unavailable_legitimate' && episode.decisiveSpellIds.includes(candidate.spellId)) {
        stat.notRequired++;
      }
      if (candidate.statusAtPeak === 'unknown') stat.unknown++;
      stats.set(candidate.spellId, stat);
    }
  }
  return [...stats.entries()]
    .map(([spellId, stat]) => ({
      spellId,
      name: safeSpellName(spellNameById.get(spellId) ?? `#${spellId}`),
      coveredCount: stat.covered,
      freeUnusedCount: stat.freeUnused,
      onCooldownCount: stat.onCooldown,
      notRequiredCount: stat.notRequired,
      unknownCount: stat.unknown,
      totalCount: stat.covered + stat.freeUnused + stat.onCooldown + stat.notRequired + stat.unknown,
    }))
    .sort((a, b) => b.coveredCount - a.coveredCount || b.freeUnusedCount - a.freeUnusedCount);
}

/** §38-41 del cutover: agrupa episodios canónicos por boss+dificultad+dominantAbilityGameId — misma anatomía de
 * card que antes, fuente completamente distinta. Nombre/descripción/resolución ya vienen resueltos por
 * night-player-summary.service.ts (applicable_boss_mechanics_candidates por ability_id, nunca pull_mechanic_events
 * ni pressure-window legacy). timingLabel reutiliza el patrón histórico ya calculado para el mismo ability_id
 * en mechanicPressureBreakdown — es una observación de frecuencia, no un veredicto defensivo, así que no cuenta
 * como fuente legacy de KPI (§14).
 */
function mechanicCards(canonical: NightCanonicalDefensiveSummary, summary: NightPlayerSummary): RaiderMechanicCard[] {
  const spellNameById = new Map(summary.defensiveSummary.spells.map((spell) => [spell.spellId, spell.spellName]));
  const timingByKey = new Map(
    summary.defensiveSummary.mechanicPressureBreakdown.map((m) => [
      `${m.bossId}|${m.difficulty}|${m.mechanicId}`,
      m.timingPattern,
    ]),
  );

  interface Group {
    bossId: string;
    bossName: string;
    difficulty: string;
    mechanicId: number;
    mechanicName: string;
    description: string | null;
    resolution: string | null;
    episodes: CanonicalDefensiveEpisodeView[];
  }
  const groups = new Map<string, Group>();
  for (const episode of canonical.episodes) {
    if (episode.dominantAbilityGameId == null) continue;
    const key = `${episode.bossId}|${episode.difficulty}|${episode.dominantAbilityGameId}`;
    const group = groups.get(key) ?? {
      bossId: episode.bossId,
      bossName: episode.bossName,
      difficulty: episode.difficulty,
      mechanicId: episode.dominantAbilityGameId,
      mechanicName: episode.mechanicName ?? `#${episode.dominantAbilityGameId}`,
      description: episode.mechanicDescription,
      resolution: episode.mechanicResolution,
      episodes: [],
    };
    group.episodes.push(episode);
    groups.set(key, group);
  }

  const cards = [...groups.values()].map((group): RaiderMechanicCard => {
    const sortedEpisodes = [...group.episodes].sort((a, b) => a.pullNumber - b.pullNumber || a.peakMs - b.peakMs);
    const occurrenceGroups = new Map<number, RaiderMechanicCard['occurrenceGroups'][number]>();
    for (const episode of sortedEpisodes) {
      const bucket = occurrenceGroups.get(episode.pullNumber) ?? { pullNumber: episode.pullNumber, cells: [] };
      bucket.cells.push({
        key: `${episode.pullId}|${episode.peakMs}`,
        state: occurrenceStateFor(episode.responseVerdict),
        label: occurrenceCellLabel(episode, spellNameById),
      });
      occurrenceGroups.set(episode.pullNumber, bucket);
    }
    const coveredCount = group.episodes.filter((e) => e.responseVerdict === 'covered_verified').length;
    const totalCount = group.episodes.length;
    return {
      key: `${group.bossId}|${group.difficulty}|${group.mechanicId}`,
      mechanicId: group.mechanicId,
      mechanicName: group.mechanicName,
      bossId: group.bossId,
      bossName: group.bossName,
      difficulty: group.difficulty,
      coveredCount,
      totalCount,
      coverageLabel: percent(totalCount > 0 ? (coveredCount / totalCount) * 100 : null),
      description: group.description,
      resolution: group.resolution,
      relevanceNote: mechanicRelevanceNote(totalCount),
      timingLabel: timingLabelFor(timingByKey.get(`${group.bossId}|${group.difficulty}|${group.mechanicId}`) ?? null),
      occurrenceGroups: [...occurrenceGroups.values()],
      defensives: canonicalDefensiveRows(group.episodes, spellNameById),
    };
  });

  // Mismo criterio de orden que antes (§"ponerlos en orden de bosses... si
  // hay 3 mecánicas de un mismo boss, poner las 3 seguidas", 2026-08-30):
  // boss en el orden en que se pulleó esa noche, dentro de un boss más fallos primero.
  const missCount = (card: RaiderMechanicCard) => card.totalCount - card.coveredCount;
  const firstPullNumberByBoss = new Map<string, number>();
  for (const card of cards) {
    const earliest = Math.min(...card.occurrenceGroups.map((g) => g.pullNumber));
    const current = firstPullNumberByBoss.get(card.bossId);
    if (current == null || earliest < current) firstPullNumberByBoss.set(card.bossId, earliest);
  }
  return cards.sort((a, b) => {
    if (a.bossId !== b.bossId) {
      return (firstPullNumberByBoss.get(a.bossId) ?? 0) - (firstPullNumberByBoss.get(b.bossId) ?? 0);
    }
    return missCount(b) - missCount(a);
  });
}

// §"no quiero que se genere una nueva página... 2 columnas, 3 columnas, y
// únicamente las que quepan en ese espacio... esas otras mecánicas se
// tienen en cuenta para las métricas y valores pero no se enseñan en la
// infografía porque no caben" (feedback real, 2026-09-03): reemplaza la
// paginación por láminas adicionales — nunca crece verticalmente, solo
// cambia de 2 a 3 columnas (misma altura de 3 filas) cuando hay más de 6.
const MECHANIC_TWO_COLUMN_CAPACITY = 6;
const MECHANIC_THREE_COLUMN_CAPACITY = 9;

function selectMechanics(rows: RaiderMechanicCard[]): {
  visible: RaiderMechanicCard[];
  additionalCount: number;
  columns: 2 | 3;
} {
  if (rows.length <= MECHANIC_TWO_COLUMN_CAPACITY) {
    return { visible: rows, additionalCount: 0, columns: 2 };
  }
  return {
    visible: rows.slice(0, MECHANIC_THREE_COLUMN_CAPACITY),
    additionalCount: Math.max(0, rows.length - MECHANIC_THREE_COLUMN_CAPACITY),
    columns: 3,
  };
}

function positiveSignals(
  summary: NightPlayerSummary,
  canonical: NightCanonicalDefensiveSummary,
): RaiderInfographicSignal[] {
  const rows: RaiderInfographicSignal[] = [];
  if (summary.execution.avoidableEligible > 0) {
    rows.push({
      key: 'avoidance',
      label: 'Esquivas verificadas',
      value: `${summary.execution.avoidableSucceeded}/${summary.execution.avoidableEligible}`,
      detail: `${percent(summary.execution.avoidableSuccessRate)} de oportunidades mientras seguía vivo.`,
      tone: 'positive',
    });
  }
  if (summary.interrupts.length > 0) {
    rows.push({
      key: 'interrupts',
      label: 'Interrupciones atribuidas',
      value: String(summary.interrupts.length),
      detail: summary.interrupts
        .slice(0, 4)
        .map((row) => `${row.mechanicName} · Pull ${row.pullNumber}`)
        .join(' · '),
      tone: 'positive',
    });
  }
  // §Frontend cutover (2026-09-05, corregido en revisión): covered_verified es el único hecho canónico
  // positivo inequívoco disponible hoy. unavailable_legitimate NUNCA alimenta esto — indisponibilidad legítima
  // no es lo mismo que una decisión correcta de reserva/plan, y afirmarlo requeriría evidencia de plan/hold que
  // esta generación todavía no expone. Sin covered_verified, no se inventa un signal.
  if (canonical.response.covered > 0) {
    rows.push({
      key: 'defensive',
      label: 'Coberturas defensivas confirmadas',
      value: String(canonical.response.covered),
      detail: `${canonical.response.covered}/${canonical.response.evaluable} oportunidades evaluables cubiertas con evidencia verificada.`,
      tone: 'positive',
    });
  }
  if (summary.unassignedMechanicCredits.length > 0) {
    const unique = new Map<string, string>();
    for (const credit of summary.unassignedMechanicCredits) {
      const key = `${credit.mechanicName}|${credit.bossName}`;
      if (!unique.has(key)) unique.set(key, `${credit.mechanicName} (${credit.bossName})`);
    }
    rows.push({
      key: 'voluntary',
      label: 'Mecánicas voluntarias resueltas',
      value: String(summary.unassignedMechanicCredits.length),
      detail: [...unique.values()].join(' · '),
      tone: 'positive',
    });
  }
  return rows;
}

function evolutionValue(value: number, unit: NightEvolutionMetric['unit']): string {
  return unit === 'percent' ? percent(value) : metricNumber(value);
}

function evolutionDelta(metric: NightEvolutionMetric): string {
  const sign = metric.delta > 0 ? '+' : metric.delta < 0 ? '−' : '';
  return `${sign}${evolutionValue(Math.abs(metric.delta), metric.unit)}`;
}

export function buildRaiderInfographicViewModel(
  summary: NightPlayerSummary,
  projection: RaiderEvidenceProjection,
): RaiderInfographicViewModel {
  const canonical = summary.canonicalDefensive;
  const evaluatedPulls = summary.pulls.filter((pull) => pull.pullScore != null);
  const evaluatedBosses = new Set(
    evaluatedPulls.map((pull) => `${pull.bossId}|${pull.difficulty}`),
  );
  const bossKills = evaluatedPulls.filter((pull) => pull.kill).length;
  const mechanics = mechanicCards(canonical, summary);
  const mechanicSelection = selectMechanics(mechanics);
  const maxDefensiveRows = Math.max(0, ...mechanics.map((mechanic) => mechanic.defensives.length));
  const className = summary.gearSnapshot?.class ?? summary.roster?.class ?? null;
  const executionScore = summary.nightScore == null ? null : summary.nightScore * 100;
  // §Hallazgo 4 (2026-09-03): antes este contador leía v2.deathViableCdCount
  // (o el agregado legacy) mientras las cards de muerte de abajo se
  // construyen mezclando episodios v2 y legacy pull a pull — un episodio de
  // muerte concreto puede no tener decisión v2 aunque v2 exista para la
  // noche, y ese contador global no lo veía. El resumen y las cards podían
  // contradecirse en la misma lámina ("0 muertes con respuesta viable"
  // arriba, dos cards de muerte con CD libre debajo). Ahora el contador
  // cuenta exactamente las mismas cards que se van a pintar.
  const deathItems = projection.items.filter(
    (item) => item.kind === 'death' || item.reasonCode.startsWith('DEATH_'),
  );
  const deaths = deathItems.map(
    (item): RaiderInfographicDeathCard => ({
      id: item.id,
      title: item.title,
      bossName: item.bossName,
      when: [
        item.pullNumber == null ? null : `Pull ${item.pullNumber}`,
        item.atMs == null ? null : formatDuration(item.atMs),
      ]
        .filter(Boolean)
        .join(' · '),
      verdictLabel: VERDICT_LABEL[item.verdict],
      tone: verdictTone(item.verdict),
      observation: item.observation,
      evidence: item.whyItMatters,
      damageLabel: item.damageTotal > 0 ? compactNumber(item.damageTotal) : null,
      defensives: item.defensives.map(defensiveView),
    }),
  );
  return {
    identity: {
      playerName: summary.playerName,
      reportCode: summary.reportCode,
      reportTitle: summary.reportTitle,
      reportDateLabel: summary.reportDate
        ? new Intl.DateTimeFormat('es-ES', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }).format(new Date(summary.reportDate))
        : summary.reportTitle,
      avatarUrl: summary.roster?.avatarUrl ?? null,
      className: className ? classDisplayName(className) : null,
      specName: summary.gearSnapshot?.spec ?? null,
      role: summary.roster?.role ?? null,
      evaluatedPullCount: evaluatedPulls.length,
      evaluatedBossCount: evaluatedBosses.size,
      bossKillCount: bossKills,
    },
    hero: {
      // §"'6/13 pulls sin fallo personal ni muerte evaluable' porque ya
      // está en la card de abajo" (feedback real, 2026-09-03): ese mismo
      // par ya es el KPI "Pulls limpios" del stat-strip; aquí describe qué
      // pesa el % en vez de repetir la fracción.
      execution: {
        key: 'execution',
        label: 'Ejecución de la noche',
        value: percent(executionScore),
        detail: 'Combina fallos personales, muertes evaluables y consistencia por pull.',
        tone:
          executionScore == null
            ? 'neutral'
            : executionScore < 50
              ? 'danger'
              : executionScore < 75
                ? 'warning'
                : 'positive',
      },
      defensive: {
        usage: usageDefensiveMetric(canonical),
        response: responseDefensiveMetric(canonical),
        management: managementDefensiveMetric(canonical),
      },
    },
    nightMetrics: [
      {
        key: 'clean-pulls',
        label: 'Pulls limpios',
        value: `${summary.execution.cleanPulls}/${summary.execution.evaluatedPulls}`,
        detail: percent(summary.execution.cleanPullRate),
        tone:
          summary.execution.cleanPullRate == null
            ? 'neutral'
            : summary.execution.cleanPullRate < 50
              ? 'danger'
              : summary.execution.cleanPullRate < 75
                ? 'warning'
                : 'positive',
      },
      {
        key: 'personal-errors',
        label: 'Fallos personales',
        value: String(summary.execution.actionableIncidents),
        detail: `${metricNumber(summary.execution.actionableIncidentRatePer10)} por 10 pulls`,
        tone: summary.execution.actionableIncidents > 0 ? 'danger' : 'positive',
      },
      {
        key: 'deaths',
        label: 'Muertes evaluables',
        value: String(summary.totalDeaths),
        detail: `${metricNumber(summary.execution.deathRatePer10)} por 10 pulls`,
        tone: summary.totalDeaths > 0 ? 'danger' : 'positive',
      },
      {
        key: 'interrupts',
        label: 'Kicks atribuidos',
        value: String(summary.interrupts.length),
        detail: 'solo casts atribuidos al jugador',
        tone: summary.interrupts.length > 0 ? 'positive' : 'neutral',
      },
      {
        // §Spec visual sección 6 (corregido en el cutover, 2026-09-05):
        // "Ventanas de presión" era pressure-window legacy — sustituida por
        // Respuesta canónica (misma fuente que el hero y el strip
        // defensivo, nunca un segundo cálculo).
        key: 'defensive-opportunities',
        label: 'Oportunidades defensivas',
        value: `${canonical.response.covered}/${canonical.response.evaluable}`,
        detail: canonical.response.score == null ? 'sin oportunidades evaluables' : `${defensivePercent(canonical.response.score)} cubiertas`,
        tone:
          canonical.response.score == null
            ? 'neutral'
            : canonical.response.evaluable > 0 && canonical.response.covered === canonical.response.evaluable
              ? 'positive'
              : 'warning',
      },
      {
        key: 'bosses',
        label: 'Bosses evaluados',
        value: String(evaluatedBosses.size),
        detail: `${bossKills} kills de boss`,
        tone: 'information',
      },
    ],
    coachingCards: projection.coaching.map(coachingCard),
    additionalCoachingCount: projection.additionalCoachingCount,
    timelineGroups: groupTimeline(projection),
    positiveSignals: positiveSignals(summary, canonical),
    defensiveMetrics: [
      {
        key: 'usage',
        label: 'Uso defensivo',
        value: `${canonical.usage.engaged}/${canonical.usage.evaluable}`,
        detail: canonical.usage.score == null ? 'sin oportunidades evaluables' : `${defensivePercent(canonical.usage.score)} · episodios con uso`,
        tone: canonical.usage.score == null ? 'neutral' : defensiveTone(canonical.usage.score),
      },
      {
        key: 'response',
        label: 'Respuesta correcta',
        value: `${canonical.response.covered}/${canonical.response.evaluable}`,
        detail: canonical.response.score == null ? 'sin oportunidades evaluables' : `${defensivePercent(canonical.response.score)} · oportunidades cubiertas`,
        tone: canonical.response.score == null ? 'neutral' : defensiveTone(canonical.response.score),
      },
      {
        key: 'missed-ready',
        label: 'CD disponible sin cubrir',
        value: String(canonical.response.missedReady),
        detail: 'cooldown listo, oportunidad real, sin usar',
        tone: canonical.response.missedReady > 0 ? 'warning' : 'positive',
      },
      {
        key: 'missed-mistimed',
        label: 'Mal timing demostrado',
        value: String(canonical.response.missedMistimed),
        detail: 'uso anterior probadamente causó la falta de cobertura',
        tone: canonical.response.missedMistimed > 0 ? 'danger' : 'positive',
      },
      {
        key: 'management',
        label: 'Gestión',
        value:
          canonical.management.status === 'no_plan'
            ? 'N/D'
            : `${canonical.management.fulfilled}/${canonical.management.evaluable}`,
        detail: canonical.management.status === 'no_plan' ? 'Sin plan defensivo asignado' : 'plan cumplido',
        tone: canonical.management.status === 'no_plan' ? 'neutral' : defensiveTone(canonical.management.score),
      },
      // §36 del cutover: exactamente 5 cards canónicas (Uso/Respuesta/CD sin
      // cubrir/Mal timing/Gestión) — "Muertes con respuesta disponible" salía
      // de death.defensivesAvailable (legacy, sin vínculo canónico con el
      // episodio); retirada junto con esa afirmación (§45).
    ],
    mechanics: mechanicSelection.visible,
    additionalMechanicCount: mechanicSelection.additionalCount,
    deaths,
    additionalDeathCount: Math.max(0, deaths.length - 3),
    patterns: summary.repeatedPatterns
      .filter((pattern) => pattern.instanceCount >= 2)
      .map((pattern) => ({
        key: `${pattern.mechanicId ?? pattern.mechanicName}|${pattern.bossNames.join('|')}`,
        mechanicId: pattern.mechanicId,
        mechanicName: pattern.mechanicName,
        bossNames: pattern.bossNames.join(' · '),
        difficultyLabel: pattern.difficulty,
        instanceLabel: `${pattern.instanceCount} incidencias en ${pattern.distinctBossCount} boss${pattern.distinctBossCount === 1 ? '' : 'es'}`,
        description: pattern.aiNote,
        resolution: pattern.resolution,
      })),
    additionalPatternCount: Math.max(
      0,
      summary.repeatedPatterns.filter((pattern) => pattern.instanceCount >= 2).length - 3,
    ),
    evolution: {
      previousNightLabel: summary.evolution
        ? `${summary.evolution.previousReportTitle} · ${new Intl.DateTimeFormat('es-ES', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }).format(new Date(summary.evolution.previousReportDate))}`
        : null,
      cards: (summary.evolution?.metrics ?? []).map((metric) => ({
        key: metric.key,
        label: metric.label,
        current: evolutionValue(metric.current, metric.unit),
        previous: evolutionValue(metric.previous, metric.unit),
        delta: evolutionDelta(metric),
        evidence: metric.evidence,
        direction: metric.direction,
      })),
    },
    evidenceNote: projection.qualityReason,
    // §Frontend cutover: v3 nunca pasa v2 a buildRaiderEvidenceProjection, así que
    // projection.defensiveGeneration (v2-only) siempre sería null aquí — la generación real es
    // summary.canonicalDefensive.generation (id/versión de la publicada, nunca inventada).
    generationLabel: canonical.generation
      ? `${canonical.generation.evaluatorVersion ?? canonical.generation.episodeVersion ?? '—'} · ${canonical.generation.resolverVersion} · ${canonical.generation.semanticResolverVersion}`
      : null,
    layout: {
      pullDensity:
        evaluatedPulls.length > 22 ? 'dense' : evaluatedPulls.length > 12 ? 'compact' : 'normal',
      mechanicColumns: mechanicSelection.columns,
      defensiveDensity: maxDefensiveRows > 3 ? 'compact' : 'normal',
      // §"solo aparecen 3 cards y creo que caben 4 (o 5)" (feedback real,
      // 2026-09-03): el tope editorial subió de 3 a 4 (raider-evidence-
      // projection.ts); la página es de altura fija con recorte, así que la
      // 4ª card usa una variante compacta en vez de asumir que el hueco
      // libre siempre alcanza a tamaño normal.
      coachingDensity: projection.coaching.length > 3 ? 'compact' : 'normal',
    },
  };
}
