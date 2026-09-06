// §Feature "ENVIAR INFOGRAFÍA + EXPLICACIÓN" (encargo 2026-09-06): builder PURO y DETERMINISTA para el
// segundo mensaje de Discord que acompaña a la infografía individual — el desglose oculto tras spoiler que
// explica de dónde sale cada cifra. CERO IA/LLM: cada frase es una transformación mecánica de datos ya
// persistidos/evaluados por IRIS (NightPlayerSummary/RaiderEvidenceProjection/RaiderInfographicViewModel), los
// mismos tres objetos que ya renderizan la infografía — nunca una query nueva, nunca un recálculo de
// score/KPI (Execution/Usage/Response/Management se REUTILIZAN tal cual los publica la infografía, ver
// night-player-infographic.component.ts / raider-infographic-view-model.ts).
//
// Invariantes de producto (no negociables, ver el encargo completo):
// - un fact que no esté ya sostenido por la superficie visible actual (post Attribution Safety v1, post cutover
//   v3/canonical) nunca se fabrica aquí — este módulo solo LEE `projection.items`/`projection.coaching`
//   (verdicts ya decididos) y campos ya materializados de `summary`/`viewModel`;
// - `mechanic_attribution_shadow_evaluations`/`mechanic_occurrence_evaluations` (shadow no punitivo) NUNCA se
//   consultan aquí — no hay import de ese pipeline en este archivo;
// - una muerte nunca afirma disponibilidad defensiva (no existe linkage canónico episodio↔muerte en v7, ver
//   raider-evidence-projection.ts §45) — los facts de muerte de este módulo nunca leen `defensivesAvailable`;
// - responsibility=tank/healer/dps/raid nunca se convierte en fallo individual — los facts de mecánica personal
//   se leen exclusivamente de `projection.items` con `kind:'mechanic'`, que ya aplica esa gate en
//   raider-evidence-projection.ts (groupMechanicFails), nunca de summary.mechanicFails en crudo.
import type { NightDeathRow, NightPlayerSummary, NightPullSummary } from './night-player-summary.service';
import type { RaiderEvidenceItem, RaiderEvidenceProjection } from './raider-evidence-projection';
import type { RaiderInfographicViewModel } from './raider-infographic-view-model';
import { formatDuration } from '../shared/format.util';

// §5 del encargo: presupuesto conservador — Discord corta en 2000, este bot no depende de Nitro. El body real
// que se construye se acota a DISCORD_EXPLANATION_BODY_BUDGET; el límite absoluto de 2000 es solo la red de
// seguridad final (ver clampToHardLimit), nunca el objetivo de diseño.
export const DISCORD_MESSAGE_MAX_LENGTH = 2000;
export const DISCORD_EXPLANATION_BODY_BUDGET = 1850;
/** Hueco reservado para el footer "+N hechos adicionales permanecen en el dosier." — generoso a propósito
 * (un contador de tres cifras + plural más largo cabe de sobra) para que ese aviso case-general nunca se pierda
 * justo en la noche más recortada, que es precisamente cuando más importa avisar de que hay más. */
const FOOTER_RESERVE = 70;

export type RaiderDiscordExplanationSourceKind =
  | 'summary_metric'
  | 'canonical_defensive_episode'
  | 'personal_mechanic_failure'
  | 'death'
  | 'interrupt'
  | 'pull';

export interface RaiderDiscordExplanationSource {
  kind: RaiderDiscordExplanationSourceKind;
  key: string;
  pullId?: string;
  fightId?: number;
  episodeId?: string;
  mechanicId?: number;
}

export type RaiderDiscordExplanationSection =
  | 'metrics'
  | 'coaching'
  | 'mechanics'
  | 'deaths'
  | 'interrupts'
  | 'context';

export interface RaiderDiscordExplanationFact {
  id: string;
  /** Menor = más importante. Determina qué se retira primero al recortar por presupuesto (§17 del encargo). */
  priority: number;
  section: RaiderDiscordExplanationSection;
  text: string;
  sources: RaiderDiscordExplanationSource[];
}

export interface RaiderDiscordExplanation {
  /** Contenido entre los marcadores de spoiler, YA saneado — sin envolver. */
  body: string;
  /** `||${body}||` — lo que de verdad se envía como `content` a send-discord-message. */
  spoilerContent: string;
  /** Longitud de spoilerContent — lo que de verdad cuenta contra el límite de Discord. */
  characterCount: number;
  omittedFactCount: number;
  /** Para test/debug/provenance (§28 del encargo): qué se publicó y por qué se sostiene. */
  includedFacts: RaiderDiscordExplanationFact[];
  omittedFacts: RaiderDiscordExplanationFact[];
}

// ---------------------------------------------------------------------------------------------------------
// Saneado de markdown de Discord (§4/§19 del encargo)
// ---------------------------------------------------------------------------------------------------------

/**
 * Aplica el escape estándar de Discord (backslash) a cualquier carácter que pudiera romper el spoiler exterior
 * o colarse como bloque de código, y rompe menciones accidentales de @everyone/@here/rol/usuario. Se aplica a
 * cada fragmento de texto INTERPOLADO (nombres, notas, resoluciones) antes de insertarlo en una plantilla —
 * nunca a la plantilla completa, para no escapar el markdown propio (`**`, `•`) que sí queremos renderizado.
 */
export function sanitizeDiscordText(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<@[!&]?(\d+)>/g, '<@​$1>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compacta un texto ya revisado a un límite visual sin cortar palabras — mismo criterio que
 * compactCoachingText en raider-evidence-projection.ts, reimplementado aquí porque ese módulo no lo exporta
 * (es una utilidad de formato trivial, no una segunda regla de evaluación). */
function condense(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const candidate = normalized.slice(0, maxLength + 1);
  const wordBoundary = candidate.lastIndexOf(' ');
  const cutAt = wordBoundary >= Math.floor(maxLength * 0.6) ? wordBoundary : maxLength;
  return `${candidate.slice(0, cutAt).replace(/[,:;\s]+$/, '')}…`;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

// ---------------------------------------------------------------------------------------------------------
// Helpers de identidad (pull → fight, verificabilidad de mecánica) — mismos criterios ya usados en el resto
// de la infografía, reimplementados aquí porque no se exportan desde sus módulos originales.
// ---------------------------------------------------------------------------------------------------------

function buildPullMap(summary: NightPlayerSummary): ReadonlyMap<string, NightPullSummary> {
  return new Map(summary.pulls.map((pull) => [pull.pullId, pull]));
}

/** "P{n} (fight {fightId})" cuando se conoce el fight real de WCL (§12 del encargo) — nunca inventa un fight. */
function pullLabel(pullNumber: number | null, pullId: string | null, pulls: ReadonlyMap<string, NightPullSummary>): string {
  if (pullNumber == null) return '';
  const fightId = pullId ? pulls.get(pullId)?.fightId : undefined;
  return fightId == null ? `P${pullNumber}` : `P${pullNumber} (fight ${fightId})`;
}

/** Mismo criterio que isVerifiableName()/verifiableMechanic() en el resto de la app — nunca publica "Unknown
 * Ability"/mechanicId<=0 como si fuera una causa real. */
function isVerifiableMechanicName(id: number | null | undefined, name: string | null | undefined): name is string {
  if (id == null || id <= 0 || !name) return false;
  return !/^unknown(?: ability| cause)?$/i.test(name.trim());
}

// ---------------------------------------------------------------------------------------------------------
// P0 — Métricas (nunca se retiran, §17)
// ---------------------------------------------------------------------------------------------------------

function metricFacts(summary: NightPlayerSummary, viewModel: RaiderInfographicViewModel): RaiderDiscordExplanationFact[] {
  const facts: RaiderDiscordExplanationFact[] = [];
  const canonical = summary.canonicalDefensive;
  const execution = summary.execution;

  // Ejecución: valor YA publicado por la infografía (viewModel.hero.execution.value) — nunca una fórmula nueva.
  facts.push({
    id: 'metric|execution',
    priority: 0,
    section: 'metrics',
    text: `Ejecución **${viewModel.hero.execution.value}** — ${execution.cleanPulls}/${execution.evaluatedPulls} pulls limpios; ${execution.actionableIncidents} ${pluralize(execution.actionableIncidents, 'incidencia personal', 'incidencias personales')}; ${summary.totalDeaths} ${pluralize(summary.totalDeaths, 'muerte evaluable', 'muertes evaluables')}.`,
    sources: [{ kind: 'summary_metric', key: 'execution' }],
  });

  // §27 del encargo: incompatible/unavailable/error no tienen ningún subconjunto seguro — un único N/D combinado,
  // nunca tres KPI individuales que parecerían "cero oportunidades" en vez de "dato no disponible".
  const closedStates = new Set(['incompatible', 'unavailable', 'error']);
  if (closedStates.has(canonical.state)) {
    facts.push({
      id: 'metric|defensive-unavailable',
      priority: 1,
      section: 'metrics',
      text: 'Defensivos: **N/D** — datos canónicos no disponibles de forma segura esta noche.',
      sources: [{ kind: 'summary_metric', key: 'canonical_defensive_state' }],
    });
  } else {
    const usage = canonical.usage;
    facts.push({
      id: 'metric|usage',
      priority: 1,
      section: 'metrics',
      text:
        usage.evaluable === 0
          ? 'Uso **N/D** — sin oportunidades defensivas evaluables esta noche.'
          : `Uso **${viewModel.hero.defensive.usage.value}** — ${usage.engaged}/${usage.evaluable}: hubo participación defensiva en ${usage.engaged} de ${usage.evaluable} oportunidades canónicamente evaluables.`,
      sources: [{ kind: 'summary_metric', key: 'usage' }],
    });

    const response = canonical.response;
    const uncertain = canonical.context.uncertain;
    facts.push({
      id: 'metric|response',
      priority: 1,
      section: 'metrics',
      text:
        response.evaluable === 0
          ? 'Respuesta **N/D** — sin oportunidades defensivas evaluables esta noche.'
          : `Respuesta **${viewModel.hero.defensive.response.value}** — ${response.covered}/${response.evaluable}: ${response.covered} ${pluralize(response.covered, 'cubierta', 'cubiertas')}, ${response.missedReady} \`CD disponible sin cubrir\`, ${response.missedMistimed} con mal timing demostrado${uncertain > 0 ? `; ${uncertain} ${pluralize(uncertain, 'episodio uncertain quedó', 'episodios uncertain quedaron')} fuera del KPI` : ''}.`,
      sources: [{ kind: 'summary_metric', key: 'response' }],
    });

    const management = canonical.management;
    facts.push({
      id: 'metric|management',
      priority: 1,
      section: 'metrics',
      text:
        management.status === 'no_plan'
          ? 'Gestión: **N/D** — no existe plan defensivo canónico evaluable para esta noche.'
          : management.evaluable === 0
            ? 'Gestión: **N/D** — datos insuficientes para evaluar el plan esta noche.'
            : `Gestión **${viewModel.hero.defensive.management.value}** — ${management.fulfilled}/${management.evaluable} oportunidades de plan cumplidas.`,
      sources: [{ kind: 'summary_metric', key: 'management' }],
    });

    // §27: cobertura parcial se dice explícitamente — nunca se presenta como si fuera el corpus completo.
    if (canonical.state === 'partial') {
      facts.push({
        id: 'metric|coverage-partial',
        priority: 1,
        section: 'metrics',
        text: `Cobertura defensiva parcial: datos canónicos completos en ${canonical.coverage.evaluatedPulls}/${canonical.coverage.expectedPulls} pulls de la noche.`,
        sources: [{ kind: 'summary_metric', key: 'coverage_partial' }],
      });
    }
  }

  return facts;
}

// ---------------------------------------------------------------------------------------------------------
// P1/P2 — "Qué corregir": coaching defensivo/mecánica personal, siempre desde projection.items/coaching ya
// evaluados (nunca raw events, nunca shadow attribution — ver cabecera del archivo).
// ---------------------------------------------------------------------------------------------------------

/** Mismo predicado "accionable" que usa buildRaiderEvidenceProjection internamente para elegir coaching — no
 * decide un veredicto nuevo, solo filtra por el veredicto que el evaluator YA asignó a `projection.items`. */
function isActionableItem(item: RaiderEvidenceItem): boolean {
  return (
    item.verdict === 'confirmed_error' ||
    item.verdict === 'coaching' ||
    (item.verdict === 'no_verdict' && item.kind === 'defensive')
  );
}

function correctionFacts(
  projection: RaiderEvidenceProjection,
  pulls: ReadonlyMap<string, NightPullSummary>,
): RaiderDiscordExplanationFact[] {
  const facts: RaiderDiscordExplanationFact[] = [];
  const seen = new Set<string>();

  // §17 P1: hasta 3 hallazgos de projection.coaching (excluyendo muertes — esas van en su propia sección P3).
  const p1 = projection.coaching.filter((item) => item.kind !== 'death').slice(0, 3);
  for (const item of p1) {
    seen.add(item.id);
    facts.push(buildCorrectionFact(item, pulls, 10 + facts.length));
  }

  // §17 P2: hallazgos accionables adicionales (mecánica/defensivo) que no entraron en el top 3 visual —
  // mismo orden ya decidido por buildRaiderEvidenceProjection (compareEvidence), solo se continúa la lista.
  const p2 = projection.items.filter(
    (item) => (item.kind === 'mechanic' || item.kind === 'defensive') && !seen.has(item.id) && isActionableItem(item),
  );
  // Generosamente por encima de lo que el presupuesto normalmente admite (el relleno de §17 ya recorta lo que
  // no quepa) — así el footer "+N hechos..." refleja el verdadero volumen de hallazgos accionables, no un tope
  // artificial de generación. Un tope existe solo para no construir un candidato por cada fallo de una noche
  // extrema; additionalCoachingCount (fact de contexto, más abajo) sigue siendo la cifra completa del dosier.
  for (const item of p2.slice(0, 20)) {
    facts.push(buildCorrectionFact(item, pulls, 20 + facts.length));
  }

  return facts;
}

function buildCorrectionFact(
  item: RaiderEvidenceItem,
  pulls: ReadonlyMap<string, NightPullSummary>,
  priority: number,
): RaiderDiscordExplanationFact {
  const boss = item.bossName ? sanitizeDiscordText(item.bossName) : null;
  const pull = pullLabel(item.pullNumber, item.pullId, pulls);
  const time = item.atMs == null ? null : formatDuration(item.atMs);
  const mechanicSegment = item.mechanicName ? sanitizeDiscordText(item.mechanicName) : null;
  const head = [boss, pull, time, mechanicSegment].filter((part): part is string => !!part && part.length > 0).join(' · ');
  const mainClauseRaw = item.kind === 'mechanic' ? (item.whyItMatters ?? item.observation) : item.observation;
  const mainClause = condense(sanitizeDiscordText(mainClauseRaw), 200);
  const resolutionRaw =
    item.resolutionText && item.resolutionText !== item.action && item.resolutionText !== mainClauseRaw
      ? item.resolutionText
      : null;
  // La resolución revisada casi siempre ya termina en punto propio — quitarlo antes de añadir el nuestro
  // evita un "..” al concatenar (el punto final del bullet es responsabilidad de esta plantilla, no del dato).
  const resolveClause = resolutionRaw
    ? ` Resolver: ${condense(sanitizeDiscordText(resolutionRaw), 140).replace(/\.+$/, '')}.`
    : '';
  const fightId = item.pullId ? pulls.get(item.pullId)?.fightId : undefined;
  return {
    id: `correction|${item.id}`,
    priority,
    section: item.kind === 'mechanic' ? 'mechanics' : 'coaching',
    text: `${head ? `${head} — ` : ''}${mainClause}${resolveClause}`,
    sources: [
      {
        kind: item.kind === 'mechanic' ? 'personal_mechanic_failure' : 'canonical_defensive_episode',
        key: item.id,
        pullId: item.pullId ?? undefined,
        fightId,
        mechanicId: item.mechanicId ?? undefined,
        episodeId: item.kind === 'defensive' ? item.id : undefined,
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------
// P3 — Muertes evaluables e interrupciones. §13 del encargo: NUNCA afirmar disponibilidad defensiva en una
// muerte — solo boss/pull/tiempo/causa cuando es verificable, jamás death.defensivesAvailable.
// ---------------------------------------------------------------------------------------------------------

function evaluableDeaths(summary: NightPlayerSummary): NightDeathRow[] {
  return summary.deaths.filter(
    (death) => !death.isWipeCall && !death.isNinjaPull && !death.statisticalExclusionReason,
  );
}

function deathFacts(summary: NightPlayerSummary, pulls: ReadonlyMap<string, NightPullSummary>): RaiderDiscordExplanationFact[] {
  const deaths = evaluableDeaths(summary);
  const interrupts = summary.interrupts;
  const facts: RaiderDiscordExplanationFact[] = [];
  if (deaths.length === 0 && interrupts.length === 0) return facts;

  facts.push({
    id: 'context|death-interrupt-summary',
    priority: 30,
    section: 'deaths',
    text: `${deaths.length} ${pluralize(deaths.length, 'muerte evaluable', 'muertes evaluables')}${
      interrupts.length > 0 ? ` · ${interrupts.length} ${pluralize(interrupts.length, 'kick atribuido', 'kicks atribuidos')}` : ''
    }.`,
    sources: [
      ...deaths.map((death): RaiderDiscordExplanationSource => ({ kind: 'death', key: `${death.pullId}|${death.timeMs}`, pullId: death.pullId })),
      ...interrupts.map((row): RaiderDiscordExplanationSource => ({ kind: 'interrupt', key: `${row.pullId}|${row.timeMs}`, pullId: row.pullId })),
    ],
  });

  // Hasta 2 muertes concretas — boss/pull/hora/causa cuando IRIS la verificó, nunca un defensivo asociado.
  for (const [index, death] of deaths.slice(0, 2).entries()) {
    const boss = sanitizeDiscordText(death.bossName);
    const pull = pullLabel(death.pullNumber, death.pullId, pulls);
    const time = formatDuration(death.timeMs);
    const causeClause = isVerifiableMechanicName(death.mechanicId, death.mechanicName)
      ? `muerte asociada a ${sanitizeDiscordText(death.mechanicName!)}`
      : 'muerte evaluable sin causa mitigable identificada';
    facts.push({
      id: `death|${death.pullId}|${death.timeMs}`,
      priority: 31 + index,
      section: 'deaths',
      text: `${boss} · ${pull} · ${time} — ${causeClause}.`,
      sources: [{ kind: 'death', key: `${death.pullId}|${death.timeMs}`, pullId: death.pullId, fightId: pulls.get(death.pullId)?.fightId, mechanicId: death.mechanicId ?? undefined }],
    });
  }

  if (interrupts.length > 0) {
    const names = interrupts
      .slice(0, 3)
      .map((row) => `${sanitizeDiscordText(row.mechanicName)} · ${sanitizeDiscordText(row.bossName)} · ${pullLabel(row.pullNumber, row.pullId, pulls)} ${formatDuration(row.timeMs)}`)
      .join(' · ');
    facts.push({
      id: 'interrupt|summary',
      priority: 33,
      section: 'interrupts',
      text: `${interrupts.length} ${pluralize(interrupts.length, 'kick atribuido', 'kicks atribuidos')}: ${names}.`,
      sources: interrupts.slice(0, 3).map((row): RaiderDiscordExplanationSource => ({
        kind: 'interrupt',
        key: `${row.pullId}|${row.timeMs}`,
        pullId: row.pullId,
        fightId: pulls.get(row.pullId)?.fightId,
        mechanicId: row.mechanicId,
      })),
    });
  }

  return facts;
}

// ---------------------------------------------------------------------------------------------------------
// P4 — Contexto adicional (primero en retirarse bajo presión de presupuesto, §17).
// ---------------------------------------------------------------------------------------------------------

function contextFacts(summary: NightPlayerSummary, projection: RaiderEvidenceProjection): RaiderDiscordExplanationFact[] {
  const facts: RaiderDiscordExplanationFact[] = [];
  const canonical = summary.canonicalDefensive;
  const { unavailableLegitimate, noApplicableResource } = canonical.context;
  if (unavailableLegitimate > 0 || noApplicableResource > 0) {
    const clauses = [
      unavailableLegitimate > 0 ? `${unavailableLegitimate} por indisponibilidad legítima` : null,
      noApplicableResource > 0 ? `${noApplicableResource} sin recurso defensivo aplicable` : null,
    ].filter((value): value is string => !!value);
    facts.push({
      id: 'context|kpi-excluded',
      priority: 40,
      section: 'context',
      text: `Fuera del KPI de Respuesta por contexto (nunca fallo): ${clauses.join('; ')}.`,
      sources: [{ kind: 'summary_metric', key: 'kpi_context' }],
    });
  }
  if (projection.additionalCoachingCount > 0) {
    facts.push({
      id: 'context|additional-coaching',
      priority: 41,
      section: 'context',
      text: `+${projection.additionalCoachingCount} ${pluralize(projection.additionalCoachingCount, 'hallazgo de coaching adicional visible', 'hallazgos de coaching adicionales visibles')} en el dosier.`,
      sources: [{ kind: 'summary_metric', key: 'additional_coaching' }],
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------------------
// Relleno determinista por presupuesto (§5/§17 del encargo)
// ---------------------------------------------------------------------------------------------------------

interface FillResult {
  body: string;
  included: RaiderDiscordExplanationFact[];
  omitted: RaiderDiscordExplanationFact[];
}

/** Añade una cabecera de sección + sus facts, en orden de prioridad, deteniéndose fact a fact (nunca a mitad
 * de línea) en cuanto el presupuesto no alcanza. La cabecera solo se imprime si al menos un fact de ese grupo
 * entra — una sección vacía no aparece. */
function fillGroup(body: string, heading: string, facts: RaiderDiscordExplanationFact[], budget: number): FillResult {
  let current = body;
  let headingAdded = false;
  const included: RaiderDiscordExplanationFact[] = [];
  const omitted: RaiderDiscordExplanationFact[] = [];
  for (const fact of facts) {
    const prefix = headingAdded ? '' : `\n**${heading}**\n`;
    const addition = `${prefix}• ${fact.text}\n`;
    const attempt = current + addition;
    if (attempt.length <= budget) {
      current = attempt;
      headingAdded = true;
      included.push(fact);
    } else {
      omitted.push(fact);
    }
  }
  return { body: current, included, omitted };
}

/** Red de seguridad final e independiente del presupuesto de diseño: garantiza el invariant duro
 * `finalMessage.length <= 2000` incluso en un caso patológico no previsto por el presupuesto de 1850. Recorta
 * por LÍNEA completa desde el final (nunca a mitad de frase/palabra), nunca toca la cabecera ni las métricas
 * P0 (primeras líneas del body). */
function clampToHardLimit(body: string, header: string): string {
  let content = body;
  while (`||${content}||`.length > DISCORD_MESSAGE_MAX_LENGTH) {
    const lines = content.split('\n');
    if (lines.length <= header.split('\n').length + 1) break; // no queda nada seguro que recortar
    lines.pop();
    content = lines.join('\n');
  }
  return content;
}

export function buildRaiderDiscordExplanation(
  summary: NightPlayerSummary,
  projection: RaiderEvidenceProjection,
  viewModel: RaiderInfographicViewModel,
): RaiderDiscordExplanation {
  const pulls = buildPullMap(summary);
  const evaluatedPullCount = viewModel.identity.evaluatedPullCount;
  const header =
    `**IRIS · explicación de ${sanitizeDiscordText(viewModel.identity.playerName)}**\n` +
    `Log \`${sanitizeDiscordText(viewModel.identity.reportCode)}\` · ${evaluatedPullCount} ${pluralize(evaluatedPullCount, 'pull evaluado', 'pulls evaluados')}\n`;

  const metrics = metricFacts(summary, viewModel);
  const corrections = correctionFacts(projection, pulls);
  const deaths = deathFacts(summary, pulls);
  const context = contextFacts(summary, projection);

  // §17: reservar hueco para el footer "+N hechos..." — sin esta reserva, un relleno que agota el
  // presupuesto justo hasta el límite dejaría el footer sin sitio exactamente en el caso (más común) donde SÍ
  // hay algo que reportar. La reserva solo aplica durante el relleno; el footer en sí se comprueba contra el
  // presupuesto COMPLETO más abajo, así que una noche sin omisiones aprovecha el presupuesto entero.
  const fillBudget = DISCORD_EXPLANATION_BODY_BUDGET - FOOTER_RESERVE;

  let body = header;
  const metricsResult = fillGroup(body, 'Métricas', metrics, fillBudget);
  body = metricsResult.body;
  const correctionsResult = fillGroup(body, 'Qué corregir', corrections, fillBudget);
  body = correctionsResult.body;
  const contextResult = fillGroup(body, 'Contexto', [...deaths, ...context], fillBudget);
  body = contextResult.body;

  const included = [...metricsResult.included, ...correctionsResult.included, ...contextResult.included];
  const omitted = [...metricsResult.omitted, ...correctionsResult.omitted, ...contextResult.omitted];

  // §17: si algo se omitió por presupuesto y aún cabe, decirlo explícitamente — nunca llamarlo "errores", son
  // hechos de cualquier tipo (métrica de contexto, muerte, hallazgo…) que sí viven en el dosier completo.
  if (omitted.length > 0) {
    const footer = `\n• +${omitted.length} ${pluralize(omitted.length, 'hecho adicional permanece', 'hechos adicionales permanecen')} en el dosier.\n`;
    if ((body + footer).length <= DISCORD_EXPLANATION_BODY_BUDGET) body += footer;
  }

  body = clampToHardLimit(body.trimEnd(), header);
  const spoilerContent = `||${body}||`;

  return {
    body,
    spoilerContent,
    characterCount: spoilerContent.length,
    omittedFactCount: omitted.length,
    includedFacts: included,
    omittedFacts: omitted,
  };
}
