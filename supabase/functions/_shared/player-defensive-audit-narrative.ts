import {
  DEFENSIVE_NIGHT_AUDIT_VERSION,
  type DefensiveAuditAbilitySummary,
  type DefensiveAuditNarrative,
  type DefensiveCastAudit,
  type DefensiveCastEpisodeAssociation,
  type DefensiveEpisodeAudit,
  type DefensiveNarrativeBlock,
  type DefensiveNarrativeInline,
  type DefensiveNightAudit,
} from './player-defensive-audit-contract.ts';

export const DISCORD_MESSAGE_LIMIT = 2000;

export function formatFightTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function formatDelta(ms: number): string {
  const sign = ms < 0 ? '−' : '+';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(2).replace('.', ',')} s`;
}

export function wclFightUrl(reportCode: string, fightId: number): string {
  return `https://www.warcraftlogs.com/reports/${encodeURIComponent(reportCode)}#fight=${fightId}`;
}

const text = (value: string): DefensiveNarrativeInline => ({ kind: 'text', value });
const player = (value: string): DefensiveNarrativeInline => ({ kind: 'player', value });
const spell = (value: string, spellId: number): DefensiveNarrativeInline => ({ kind: 'spell', value, spellId });
const emphasis = (value: string): DefensiveNarrativeInline => ({ kind: 'emphasis', value });
const time = (ms: number): DefensiveNarrativeInline => ({ kind: 'time', value: formatFightTime(ms), ms });
const delta = (ms: number): DefensiveNarrativeInline => ({ kind: 'delta', value: formatDelta(ms), ms });

function pullLink(audit: DefensiveNightAudit, episode: DefensiveEpisodeAudit): DefensiveNarrativeInline {
  return {
    kind: 'pull_link',
    value: `Pull #${episode.pullNumber}`,
    reportCode: audit.reportCode,
    pullId: episode.pullId,
    pullNumber: episode.pullNumber,
    fightId: episode.fightId,
    url: wclFightUrl(audit.reportCode, episode.fightId),
  };
}

function pct(value: number | null): string {
  return value == null ? 'N/D' : `${value.toFixed(1).replace('.', ',')} %`;
}

function joinNatural(values: string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} y ${values.at(-1)}`;
}

function abilityCastLine(ability: DefensiveAuditAbilitySummary): DefensiveNarrativeInline[] {
  return [
    spell(ability.spellName, ability.spellId),
    text(`: ${ability.totalCasts} casts; ${ability.effectiveCasts} efectivos, ${ability.relevantIneffectiveCasts} relacionados sin cobertura, ${ability.relevantUncertainCasts} inciertos, ${ability.outsidePressureCasts} fuera de presión y ${ability.excludedCasts} excluidos.`),
  ];
}

function representativeAssociation(
  castsById: ReadonlyMap<string, DefensiveCastAudit>,
  episode: DefensiveEpisodeAudit,
  predicate: (association: DefensiveCastEpisodeAssociation) => boolean,
): { cast: DefensiveCastAudit; association: DefensiveCastEpisodeAssociation } | null {
  const options = episode.castIds.flatMap((castId) => {
    const cast = castsById.get(castId);
    if (!cast) return [];
    return cast.associations
      .filter((association) => association.episodeId === episode.episodeId && predicate(association))
      .map((association) => ({ cast, association }));
  });
  return options.sort((a, b) => Math.abs(a.association.deltaFromPeakMs) - Math.abs(b.association.deltaFromPeakMs))[0] ?? null;
}

function occurrenceInlines(
  audit: DefensiveNightAudit,
  episode: DefensiveEpisodeAudit,
  related?: { cast: DefensiveCastAudit; association: DefensiveCastEpisodeAssociation } | null,
): DefensiveNarrativeInline[] {
  const out: DefensiveNarrativeInline[] = [pullLink(audit, episode), text(' a '), time(episode.peakMs)];
  if (related) {
    out.push(
      text(' · '),
      spell(related.cast.spellName, related.cast.spellId),
      text(' a '),
      time(related.cast.castMs),
      text(' ('),
      delta(related.association.deltaFromPeakMs),
      text(')'),
    );
  }
  return out;
}

function reasonLabel(code: DefensiveCastEpisodeAssociation['reasonCode']): string {
  const labels: Record<DefensiveCastEpisodeAssociation['reasonCode'], string> = {
    covered_by_canonical_verdict: 'cobertura verificada',
    late_after_peak: 'cast posterior al pico',
    effect_expired_before_peak: 'efecto expirado antes del pico',
    relevant_but_not_covering: 'cast relacionado sin cobertura',
    reactive_window_missed: 'fuera de la ventana reactiva',
    applicability_unknown: 'aplicabilidad incierta',
    coverage_unknown: 'cobertura incierta',
    observed_aura_contradiction: 'el aura observada terminó antes del pico',
    continuous_state_unobserved: 'estado continuo no observado',
    timing_unknown: 'relación temporal desconocida',
    no_cast_with_ready_resource: 'sin cast con un recurso disponible',
    outside_evaluable_pressure: 'fuera de presión evaluable',
    post_cutoff: 'posterior al cutoff',
    excluded_pull: 'pull excluido',
    candidate_missing: 'sin candidato canónico compatible',
  };
  return labels[code];
}

function buildGoodBlocks(audit: DefensiveNightAudit, castsById: ReadonlyMap<string, DefensiveCastAudit>): DefensiveNarrativeBlock[] {
  const covered = audit.episodes.filter((episode) => episode.responseVerdict === 'covered_verified');
  if (!covered.length) {
    return [{ kind: 'paragraph', inlines: [text('No hubo episodios con cobertura canónica verificada en esta noche.')] }];
  }
  const groups = new Map<string, { label: string; spellId: number; occurrences: DefensiveNarrativeInline[][] }>();
  for (const episode of covered) {
    const related = representativeAssociation(castsById, episode, (association) => association.gaveResponseCredit);
    const spellId = episode.coveredBySpellId ?? related?.cast.spellId ?? 0;
    const label = episode.coveredBySpellName ?? related?.cast.spellName ?? `habilidad ${spellId}`;
    const key = `${episode.bossId}|${episode.dominantAbilityGameId ?? 'unknown'}|${spellId}`;
    const group = groups.get(key) ?? { label, spellId, occurrences: [] };
    group.occurrences.push(occurrenceInlines(audit, episode, related));
    groups.set(key, group);
  }
  return [{
    kind: 'list',
    items: [...groups.values()].map((group) => [
      spell(group.label, group.spellId),
      text(` cubrió ${group.occurrences.length} episodio${group.occurrences.length === 1 ? '' : 's'}: `),
      ...group.occurrences.flatMap((occurrence, index) => [...(index ? [text('; ')] : []), ...occurrence]),
      text('.'),
    ]),
  }];
}

function buildImprovementBlocks(audit: DefensiveNightAudit, castsById: ReadonlyMap<string, DefensiveCastAudit>): DefensiveNarrativeBlock[] {
  const missed = audit.episodes.filter((episode) =>
    episode.responseVerdict === 'missed_ready' || episode.responseVerdict === 'missed_due_to_mistime'
  );
  if (!missed.length) {
    return [{ kind: 'paragraph', inlines: [text('No hubo oportunidades canónicas punitivas sin cubrir.')] }];
  }
  const groups = new Map<string, { reason: string; occurrences: DefensiveNarrativeInline[][] }>();
  for (const episode of missed) {
    const related = representativeAssociation(castsById, episode, (association) =>
      !association.gaveResponseCredit && association.castCoverage !== 'unknown'
    );
    const reasonCode = related?.association.reasonCode ?? 'no_cast_with_ready_resource';
    const alternative = episode.alternatives[0];
    const ability = related?.cast.spellName ?? alternative?.spellName ?? 'un recurso personal aplicable';
    const spellId = related?.cast.spellId ?? alternative?.spellId ?? 0;
    const mechanic = episode.mechanicName ?? (episode.dominantAbilityGameId != null ? `habilidad ${episode.dominantAbilityGameId}` : 'presión sin habilidad resuelta');
    const key = `${episode.bossId}|${episode.dominantAbilityGameId ?? 'unknown'}|${spellId}|${reasonCode}`;
    const group = groups.get(key) ?? {
      reason: `${mechanic} · ${ability} · ${reasonLabel(reasonCode)}`,
      occurrences: [],
    };
    group.occurrences.push(occurrenceInlines(audit, episode, related));
    groups.set(key, group);
  }
  return [{
    kind: 'list',
    items: [...groups.values()].map((group) => [
      emphasis(group.reason),
      text(': '),
      ...group.occurrences.flatMap((occurrence, index) => [...(index ? [text('; ')] : []), ...occurrence]),
      text('.'),
    ]),
  }];
}

function buildAlternativeBlocks(audit: DefensiveNightAudit): DefensiveNarrativeBlock[] {
  const episodes = audit.episodes.filter((episode) => episode.alternatives.length > 0);
  if (!episodes.length) {
    return [{ kind: 'paragraph', inlines: [text('IRIS no conserva ninguna alternativa adicional con membership, aplicabilidad y disponibilidad suficientemente fuertes para recomendarla.')] }];
  }
  return [{
    kind: 'list',
    items: episodes.map((episode) => {
      const names = episode.alternatives.map((item) => item.spellName);
      const verifiedWindows = episode.alternatives.filter((item) =>
        item.actionableWindow.status === 'verified' || item.actionableWindow.status === 'inferred'
      );
      const out: DefensiveNarrativeInline[] = [
        pullLink(audit, episode),
        text(' a '),
        time(episode.peakMs),
        text(`: ${joinNatural(names)} ${names.length === 1 ? 'estaba' : 'estaban'} disponible${names.length === 1 ? '' : 's'} y era${names.length === 1 ? '' : 'n'} aplicable${names.length === 1 ? '' : 's'}.`),
      ];
      if (verifiedWindows.length === 1) {
        const window = verifiedWindows[0].actionableWindow;
        out.push(
          text(' La ventana demostrable para '),
          spell(verifiedWindows[0].spellName, verifiedWindows[0].spellId),
          text(' era '),
          time(window.earliestMs!),
          text('–'),
          time(window.latestMs!),
          text('.'),
        );
      }
      return out;
    }),
  }];
}

function buildTopPressureBlock(audit: DefensiveNightAudit): DefensiveNarrativeBlock {
  const top = [...audit.episodes]
    .filter((episode) => episode.responseVerdict !== 'excluded')
    .sort((a, b) => b.peakValue - a.peakValue || a.pullNumber - b.pullNumber || a.peakMs - b.peakMs)
    .slice(0, 5);
  if (!top.length) {
    return { kind: 'paragraph', inlines: [text('No se detectaron episodios defensivos evaluables.')] };
  }
  const covered = top.filter((episode) => episode.responseVerdict === 'covered_verified').length;
  return {
    kind: 'paragraph',
    inlines: [
      text('Los episodios con mayor valor de presión registrado por WCL fueron '),
      ...top.flatMap((episode, index) => [
        ...(index ? [text(index === top.length - 1 ? ' y ' : ', ')] : []),
        pullLink(audit, episode),
        text(' a '),
        time(episode.peakMs),
      ]),
      text(`. De estos ${top.length}, ${covered} ${covered === 1 ? 'quedó cubierto' : 'quedaron cubiertos'}.`),
    ],
  };
}

export function buildDefensiveAuditNarrative(audit: DefensiveNightAudit): DefensiveAuditNarrative {
  if (audit.state !== 'available' || audit.integrityIssues.length) {
    return { version: DEFENSIVE_NIGHT_AUDIT_VERSION, blocks: [] };
  }
  const castsById = new Map(audit.casts.map((cast) => [cast.castId, cast]));
  const core = audit.abilities.filter((ability) => ability.resourceUniverse === 'core');
  const coreNames = core.map((ability) => `${ability.totalCasts} de ${ability.spellName}`);
  const primary = audit.universe.coreByPrimary;
  const blocks: DefensiveNarrativeBlock[] = [
    { kind: 'heading', level: 2, text: 'Auditoría defensiva' },
    { kind: 'heading', level: 3, text: 'Universo analizado' },
    {
      kind: 'paragraph',
      inlines: [
        text(`Durante ${audit.universe.canonicalPulls} pulls canónicos evaluables de ${audit.universe.participatedPulls} participados, IRIS detectó ${audit.universe.totalEpisodes} episodios de presión. `),
        text(`${audit.metadata.evaluatedPulls}/${audit.metadata.expectedPulls} pulls tienen evidencia de la generación publicada.`),
        ...(audit.universe.excludedPulls
          ? [text(` ${audit.universe.excludedPulls} pull${audit.universe.excludedPulls === 1 ? '' : 's'} participado${audit.universe.excludedPulls === 1 ? '' : 's'} quedó fuera de la población canónica.`)]
          : []),
      ],
    },
    { kind: 'heading', level: 3, text: 'Relación entre casts y KPI' },
    {
      kind: 'paragraph',
      inlines: [
        text(`Se registraron ${audit.universe.totalCoreCasts} casts de recursos personales core${coreNames.length ? ` (${joinNatural(coreNames)})` : ''}. `),
        text('Uso y Response no cuentan casts: cuentan episodios, y cada episodio aporta como máximo una unidad a cada numerador y denominador. '),
        text(`${primary.effective} casts fueron efectivos en al menos un episodio, ${primary.relevant_ineffective} estuvieron relacionados sin cubrirlo, ${primary.relevant_uncertain} quedaron inciertos, ${primary.outside_evaluable_pressure} no se asociaron a presión evaluable y ${primary.excluded} quedaron excluidos por pull o cutoff. Los casts fuera de presión no se consideran errores ni aumentan ningún KPI.`),
      ],
    },
    ...(audit.abilities.some((ability) => ability.resourceUniverse !== 'non_personal_or_unresolved')
      ? [{
          kind: 'list',
          items: audit.abilities
            .filter((ability) => ability.resourceUniverse !== 'non_personal_or_unresolved')
            .map(abilityCastLine),
        } satisfies DefensiveNarrativeBlock]
      : []),
    { kind: 'heading', level: 3, text: 'Uso' },
    {
      kind: 'paragraph',
      inlines: [
        player(audit.playerName),
        text(` reaccionó defensivamente en ${audit.usage.engaged} de ${audit.usage.evaluable} oportunidades evaluables de Uso: `),
        emphasis(pct(audit.usage.score)),
        text('. Este numerador acredita engagement en episodios; no aumenta por repetir casts dentro de la misma oportunidad.'),
      ],
    },
    { kind: 'heading', level: 3, text: 'Response' },
    {
      kind: 'paragraph',
      inlines: [
        text(`De ${audit.response.evaluable} oportunidades evaluables de Response, ${audit.response.covered} quedaron cubiertas: `),
        emphasis(pct(audit.response.score)),
        text(`. Las ${audit.response.missedReady} missed_ready y ${audit.response.missedMistimed} missed_due_to_mistime restantes del denominador no reciben crédito parcial ni pesos ocultos. Responder no implica necesariamente cubrir el daño.`),
      ],
    },
    { kind: 'heading', level: 3, text: 'Qué hiciste bien' },
    ...buildGoodBlocks(audit, castsById),
    { kind: 'heading', level: 3, text: 'Dónde puedes mejorar' },
    ...buildImprovementBlocks(audit, castsById),
    { kind: 'heading', level: 3, text: 'Alternativas reales' },
    ...buildAlternativeBlocks(audit),
    { kind: 'heading', level: 3, text: 'Mayores episodios de presión' },
    buildTopPressureBlock(audit),
    { kind: 'heading', level: 3, text: 'Limitaciones e incertidumbre' },
    {
      kind: 'paragraph',
      inlines: [
        text(`${audit.context.uncertain} episodios quedaron inciertos, ${audit.context.unavailableLegitimate} se explican por indisponibilidad legítima, ${audit.context.noApplicableResource} no tenían un recurso aplicable y ${audit.context.excluded} quedaron excluidos. `),
        text('Los casos inciertos o sin evidencia suficiente no se convierten en fallos del jugador. '),
        text(`${audit.universe.totalNonPersonalOrUnresolvedCasts} casts observados quedaron fuera del universo de defensivos personales por clasificación no personal o resolución insuficiente; no se presentan como cooldowns personales ni generan culpa.`),
      ],
    },
    {
      kind: 'paragraph',
      inlines: [
        text(`${audit.metadata.evaluatedPulls}/${audit.metadata.expectedPulls} pulls evaluados · generación defensiva publicada ${audit.metadata.generationPublishedAt ?? 'sin fecha disponible'} · ${audit.metadata.auditVersion}.`),
      ],
    },
  ];
  return { version: DEFENSIVE_NIGHT_AUDIT_VERSION, blocks };
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_\[\]])/g, '\\$1');
}

export function renderDefensiveNarrativeInlineMarkdown(inline: DefensiveNarrativeInline): string {
  if (inline.kind === 'pull_link') return `[${escapeMarkdown(inline.value)}](${inline.url})`;
  if (inline.kind === 'emphasis') return `**${escapeMarkdown(inline.value)}**`;
  return escapeMarkdown(inline.value);
}

export function renderDefensiveNarrativePlainText(narrative: DefensiveAuditNarrative): string {
  return narrative.blocks.map((block) => {
    if (block.kind === 'spacer') return '';
    if (block.kind === 'heading') return block.text;
    if (block.kind === 'paragraph') return block.inlines.map((inline) => inline.value).join('');
    return block.items.map((item) => `- ${item.map((inline) => inline.value).join('')}`).join('\n');
  }).join('\n\n');
}

function markdownBlock(block: DefensiveNarrativeBlock): string {
  if (block.kind === 'spacer') return '';
  if (block.kind === 'heading') return `${'#'.repeat(block.level)} ${escapeMarkdown(block.text)}`;
  if (block.kind === 'paragraph') return block.inlines.map(renderDefensiveNarrativeInlineMarkdown).join('');
  return block.items.map((item) => `- ${item.map(renderDefensiveNarrativeInlineMarkdown).join('')}`).join('\n');
}

function splitPlainMarkdownSafely(value: string, limit: number): string[] {
  if (value.length <= limit) return [value];
  const protectedLinks = /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/g;
  const tokens: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(protectedLinks)) {
    if (match.index! > cursor) tokens.push(value.slice(cursor, match.index));
    tokens.push(match[0]);
    cursor = match.index! + match[0].length;
  }
  if (cursor < value.length) tokens.push(value.slice(cursor));

  const atomic: string[] = [];
  for (const token of tokens) {
    if (protectedLinks.test(token)) {
      atomic.push(token);
      protectedLinks.lastIndex = 0;
      continue;
    }
    protectedLinks.lastIndex = 0;
    const sentences = token.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (sentence.length <= limit) atomic.push(sentence);
      else {
        const words = sentence.split(/(\s+)/);
        let current = '';
        for (const word of words) {
          if (current && current.length + word.length > limit) {
            atomic.push(current);
            current = '';
          }
          if (word.length > limit) {
            if (current) atomic.push(current);
            for (let i = 0; i < word.length; i += limit) atomic.push(word.slice(i, i + limit));
            current = '';
          } else current += word;
        }
        if (current) atomic.push(current);
      }
    }
  }

  const parts: string[] = [];
  let current = '';
  for (const token of atomic.filter(Boolean)) {
    const separator = current && !current.endsWith(' ') && !token.startsWith(' ') ? ' ' : '';
    if (current && current.length + separator.length + token.length > limit) {
      parts.push(current.trim());
      current = token;
    } else current += separator + token;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function chunkDefensiveNarrativeForDiscord(
  narrative: DefensiveAuditNarrative,
  limit = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 100) throw new Error('Discord chunk limit must be an integer >= 100.');
  const semanticSegments = narrative.blocks.flatMap((block) => splitPlainMarkdownSafely(markdownBlock(block), limit)).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const segment of semanticSegments) {
    const separator = current ? '\n\n' : '';
    if (current && current.length + separator.length + segment.length > limit) {
      chunks.push(current);
      current = segment;
    } else current += separator + segment;
  }
  if (current) chunks.push(current);
  if (chunks.some((chunk) => chunk.length > limit)) throw new Error('Discord narrative chunk exceeds the configured limit.');
  return chunks;
}
