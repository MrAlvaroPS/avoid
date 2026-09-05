import type { NightFullReport, NightReportTrend } from '../../shared/models/night-full-report';

const numberFormatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });

function formatNumber(value: number | null): string {
  return value == null ? 'Sin dato' : numberFormatter.format(value);
}

function formatCompact(value: number | null): string {
  if (value == null) return 'Sin dato';
  if (Math.abs(value) >= 1_000_000) return `${numberFormatter.format(value / 1_000_000)} M`;
  if (Math.abs(value) >= 1_000) return `${numberFormatter.format(value / 1_000)} k`;
  return numberFormatter.format(value);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours} h ${minutes} min` : minutes ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

/** "2:35" — offsetMs es relativo al inicio del pull, ver defensiveUsage. */
export function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]#+!|>~])/g, '\\$1');
}

function plainNote(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// §"fusionar informe 1 e informe 2... asegurando que no se duplican datos"
// (feedback real, 2026-08-27): asistencia vivía SOLO en NightReportService
// (informe 1, comparación contra el roster de wowaudit) — no tiene sentido
// duplicar esa consulta aquí dentro de night-full-report.ts (deterministe,
// sin wowaudit), así que el componente la sigue trayendo de ahí y la pasa
// como extra opcional para que el texto copiado/Discord también la lleve.
export interface NightReportAttendanceExtras {
  attendingMain: string[];
  attendingTrial: string[];
  /** Jugó esta noche sin tener fila en wowaudit_roster — ver NightReport.attendingUnlisted. */
  attendingUnlisted: string[];
  absentMain: string[];
}

export function bilingualName(english: string, spanish: string | null): string {
  return spanish && spanish.localeCompare(english, undefined, { sensitivity: 'accent' }) !== 0 ? `${english} (${spanish})` : english;
}

function mechanicLink(name: string, nameEs: string | null, spellId: number | null): string {
  const label = escapeMarkdown(bilingualName(name, nameEs));
  return spellId ? `[${label}](https://www.wowhead.com/spell=${spellId})` : label;
}

function trendLabel(trend: NightReportTrend): string {
  return {
    improving: 'mejora',
    worsening: 'empeora',
    flat: 'estable',
    insufficient_data: 'muestra insuficiente',
  }[trend];
}

function signedPct(value: number | null): string {
  if (value == null) return 'Sin dato comparable';
  return `${value > 0 ? '+' : ''}${formatNumber(value)}%`;
}

function reportDateLabel(report: NightFullReport): string {
  return report.reportDate
    ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'long' }).format(new Date(report.reportDate))
    : report.reportTitle;
}

function asciiCell(value: string, width: number, alignRight = false): string {
  return alignRight ? value.padStart(width) : value.padEnd(width);
}

function bossAsciiTable(report: NightFullReport, limit = report.summary.bosses.length): string {
  const visibleBosses = report.summary.bosses.slice(0, limit);
  const bossWidth = Math.max('Boss'.length, ...visibleBosses.map((boss) => boss.bossName.length));
  const header = `${asciiCell('Boss', bossWidth)} ${asciiCell('P', 3, true)} ${asciiCell('K', 3, true)} ${asciiCell('Best', 7, true)}`;
  const rows = visibleBosses.map((boss) => {
    const best = boss.kills > 0 ? 'KILL' : boss.bestWipePct == null ? '—' : `${formatNumber(boss.bestWipePct)}%`;
    return `${asciiCell(boss.bossName, bossWidth)} ${asciiCell(String(boss.pulls), 3, true)} ${asciiCell(String(boss.kills), 3, true)} ${asciiCell(best, 7, true)}`;
  });
  if (report.summary.bosses.length > limit) rows.push(`… ${report.summary.bosses.length - limit} boss(es) más`);
  return ['```text', header, '-'.repeat(header.length), ...rows, '```'].join('\n');
}

function findDefensiveUsage(report: NightFullReport, bossName: string, difficulty: string) {
  return report.defensiveUsage.find((entry) => entry.bossName === bossName && entry.difficulty === difficulty) ?? null;
}

// §"organizados así los defensivos no me entero de nada... organizados por
// quien, no me interesa una lista infinita" (feedback real, 2026-08-27):
// mismo reagrupado por jugador → hechizo que en la vista (ver
// castsByPlayer en night-report.component.ts) — una línea por hechizo con
// su cuenta, no una línea por cast individual.
function groupDefensiveCastsByPlayer(casts: NightFullReport['defensiveUsage'][number]['casts']) {
  const byPlayer = new Map<string, Map<string, { spellName: string; wowheadSpellId: number | null; occurrences: { pullNumber: number; offsetMs: number }[] }>>();
  for (const cast of casts) {
    let spells = byPlayer.get(cast.playerName);
    if (!spells) {
      spells = new Map();
      byPlayer.set(cast.playerName, spells);
    }
    const spellKey = cast.wowheadSpellId != null ? String(cast.wowheadSpellId) : cast.spellName;
    let spell = spells.get(spellKey);
    if (!spell) {
      spell = { spellName: cast.spellName, wowheadSpellId: cast.wowheadSpellId, occurrences: [] };
      spells.set(spellKey, spell);
    }
    spell.occurrences.push({ pullNumber: cast.pullNumber, offsetMs: cast.offsetMs });
  }
  return [...byPlayer.entries()]
    .map(([playerName, spells]) => {
      const spellList = [...spells.values()].sort((a, b) => b.occurrences.length - a.occurrences.length);
      return { playerName, totalCasts: spellList.reduce((sum, spell) => sum + spell.occurrences.length, 0), spells: spellList };
    })
    .sort((a, b) => a.playerName.localeCompare(b.playerName));
}

/** Agrupa los momentos de un mismo hechizo por pull: "P3: 0:02 0:13 · P5: 0:30". */
function formatOccurrences(occurrences: { pullNumber: number; offsetMs: number }[]): string {
  const byPull: { pullNumber: number; times: string[] }[] = [];
  for (const occ of occurrences) {
    const last = byPull.at(-1);
    if (last?.pullNumber === occ.pullNumber) last.times.push(formatOffset(occ.offsetMs));
    else byPull.push({ pullNumber: occ.pullNumber, times: [formatOffset(occ.offsetMs)] });
  }
  return byPull.map((group) => `P${group.pullNumber}: ${group.times.join(' ')}`).join(' · ');
}

/**
 * Resumen para Discord sin recortes. Puede requerir varios mensajes, pero
 * conserva completas todas las notas y explicaciones incluidas.
 *
 * §"sintetiza el informe completo... es un informe de RL así que solo datos
 * útiles" (feedback real, 2026-08-27): el resumen de Discord se queda
 * deliberadamente en lo accionable — progress, prioridades, roles, quién no
 * usó ningún defensivo EN EL BOSS DE PROGRESS (el detalle completo por
 * boss+pull+minuto vive en "Copiar informe completo", no aquí).
 */
export function buildNightDiscordSummary(report: NightFullReport, attendance?: NightReportAttendanceExtras): string {
  const lines = [
    `# Informe de combate de IRIS · ${escapeMarkdown(reportDateLabel(report))}`,
    `**${report.summary.totalPulls} pulls · ${report.summary.totalKills} kills · ${report.summary.totalWipes} wipes · ${formatDuration(report.summary.totalCombatTimeMs)} en combate**`,
    '',
    bossAsciiTable(report),
  ];

  if (attendance?.absentMain.length) {
    lines.push('', `## Ausentes — Main (${attendance.absentMain.length})`, `- ${attendance.absentMain.map(escapeMarkdown).join(', ')}`);
  }

  if (report.summary.progressBoss) {
    const progress = report.summary.progressBoss;
    const progressGained = progress.firstWipePct != null && progress.lastWipePct != null
      ? Math.round((progress.firstWipePct - progress.lastWipePct) * 10) / 10
      : null;
    lines.push(
      '',
      `## Progress actual · ${escapeMarkdown(bilingualName(progress.bossName, progress.bossNameEs))}`,
      `**${progress.pulls} pulls · ${formatNumber(progress.firstWipePct)}% → ${formatNumber(progress.lastWipePct)}% · mejor ${formatNumber(progress.bestWipePct)}%${progressGained != null && progressGained > 0 ? ` · avance de ${formatNumber(progressGained)} puntos` : ''}**`,
    );
    const progressDefensives = findDefensiveUsage(report, progress.bossName, progress.difficulty);
    if (progressDefensives?.playersWithZeroCasts.length) {
      lines.push(`Sin ningún defensivo en este boss: ${progressDefensives.playersWithZeroCasts.map(escapeMarkdown).join(', ')}`);
    }
  }

  // Evita duplicar la habilidad principal cuando ya abre las prioridades.
  // En una noche sin boss de progress (todo limpio/farm), conserva aun así
  // el golpe final más repetido como contexto útil.
  const topDeath = report.deaths.topFinalBlows[0];
  const topDeathAlreadyPrioritized = topDeath
    ? report.priorities.some((priority) => priority.title.includes(topDeath.mechanicName))
    : false;
  if (topDeath && !topDeathAlreadyPrioritized && (!report.summary.progressBoss || topDeath.isProgressBoss)) {
    lines.push(
      '',
      '## Golpe final más repetido',
      `- ${mechanicLink(topDeath.mechanicName, topDeath.mechanicNameEs, topDeath.wowheadSpellId)} · **${topDeath.count} muertes** · ${escapeMarkdown(bilingualName(topDeath.bossName, topDeath.bossNameEs))}`,
    );
    if (topDeath.note) lines.push(`  - **Qué hace:** ${escapeMarkdown(plainNote(topDeath.note))}`);
  }

  if (report.priorities.length) {
    lines.push('',
      '## Prioridades para la próxima raid',
      ...report.priorities.map((priority, index) => {
        const lethal = report.deaths.topFinalBlows.find((death) => death.isProgressBoss && priority.title.includes(death.mechanicName));
        const mechanic = report.mechanics.find((entry) => entry.isProgressBoss && priority.title.includes(entry.mechanicName));
        const lethalPerPull = lethal && report.summary.progressBoss?.pulls
          ? Math.round((lethal.count / report.summary.progressBoss.pulls) * 10) / 10
          : null;
        const detail = mechanic?.category === 'enrage'
          ? `El enrage apareció en ${mechanic.pullsAffected}/${mechanic.totalPulls} pulls${lethal ? ` y figura como golpe final en ${lethal.count} muertes` : ''}.`
          : priority.detail;
        const reference = lethalPerPull != null ? ` Referencia de esta noche: ${formatNumber(lethalPerPull)} golpes finales por pull.` : '';
        return `${index + 1}. **${escapeMarkdown(priority.title)}:** ${escapeMarkdown(detail + reference)}${priority.note ? `\n   - **Qué hace:** ${escapeMarkdown(plainNote(priority.note))}` : ''}`;
      }),
    );
  }

  const roles = report.roleInsights;
  lines.push('',
    `## Claves por función${roles.scope ? ` · ${escapeMarkdown(bilingualName(roles.scope.bossName, roles.scope.bossNameEs))}` : ''}`,
    `- **Tanks:** ${roles.tanks.tankbusterDeaths} golpe${roles.tanks.tankbusterDeaths === 1 ? '' : 's'} final${roles.tanks.tankbusterDeaths === 1 ? '' : 'es'} por tankbuster · jugadores con algún defensivo registrado ${roles.tanks.playersUsingDefensive}/${roles.tanks.players}${roles.tanks.nonTankTankbusterDeaths ? ` · ${roles.tanks.nonTankTankbusterDeaths} tankbuster${roles.tanks.nonTankTankbusterDeaths === 1 ? '' : 's'} letal${roles.tanks.nonTankTankbusterDeaths === 1 ? '' : 'es'} alcanzaron a no-tanks` : ''}`,
    `- **Healers:** jugadores con algún defensivo registrado ${roles.healers.playersUsingDefensive}/${roles.healers.players} · ${roles.healers.raidDeathsWithSustainedNoHealingSignal} muertes de raid tuvieron daño sostenido sin sanación registrada en los 6 s previos`,
    `- **DPS:** ${roles.dps.personalMechanicDeaths} muertes asociadas a posicionamiento/soak · jugadores con algún defensivo registrado ${roles.dps.playersUsingDefensive}/${roles.dps.players}`,
    '  - La señal de sanación describe la ventana registrada: no atribuye responsabilidad ni demuestra que la muerte fuese salvable.',
  );

  if (report.responsibilities.byResponsibility.length) {
    lines.push(
      '',
      `## Responsabilidad de las mecánicas · cobertura ${report.responsibilities.classifiedMechanics}/${report.responsibilities.totalMechanics}`,
      ...report.responsibilities.byResponsibility.map((entry) =>
        `- **${escapeMarkdown(entry.label)}:** ${entry.failedEvents} fallos en ${entry.pullsAffected} pulls · ${entry.deaths} muertes · ${entry.playersHit} impactos sobre jugadores`,
      ),
      '  - “Responsable” señala quién controla la resolución; no identifica culpables individuales ni convierte cada muerte en una atribución automática.',
    );
  }

  const progressWins: string[] = [];
  const progress = report.summary.progressBoss;
  if (progress?.firstWipePct != null && progress.lastWipePct != null && progress.lastWipePct < progress.firstWipePct) {
    progressWins.push(`- El boss bajó **${formatNumber(progress.firstWipePct - progress.lastWipePct)} puntos de vida** durante la sesión.`);
  }
  const progressInterrupts = report.interrupts.progressBoss;
  if (progressInterrupts && progressInterrupts.totalCasts >= 5 && progressInterrupts.pctSuccess >= 80) {
    progressWins.push(`- Interrupciones verificables del boss de progress: **${progressInterrupts.interrupted}/${progressInterrupts.totalCasts} (${formatNumber(progressInterrupts.pctSuccess)}%)**.`);
  }
  if (progressWins.length) {
    lines.push('', '## Avances confirmados', ...progressWins);
  }

  lines.push('', '> Informe agregado: describe patrones de la raid; no asigna culpables ni convierte asociaciones en causas.');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Informe detallado, pensado para compartirlo completo o como archivo de
 * texto.
 *
 * §"el informe ahora mismo es un poco caos y necesita orden y síntesis...
 * es un informe de RL así que solo datos útiles" (feedback real,
 * 2026-08-27): reorganizado alrededor de los bosses de la noche (mecánicas,
 * golpes finales y uso de defensivos de CADA boss viven juntos, en vez de
 * tres listas planas separadas mezclando todos los bosses) — así se lee
 * como "qué pasó en cada boss", que es como piensa un RL, no como tres ejes
 * de datos sin relación entre sí.
 */
export function buildNightFullReportMarkdown(report: NightFullReport, generatedAt?: string, attendance?: NightReportAttendanceExtras): string {
  const lines: string[] = [
    `# Informe de combate de IRIS · ${escapeMarkdown(reportDateLabel(report))}`,
    `Datos agregados y deterministas · ${report.reportCode}${generatedAt ? ` · actualizado ${new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(generatedAt))}` : ''}`,
    '',
    '## Resumen',
    `- **${report.summary.totalPulls} pulls** · **${report.summary.totalKills} kills** · **${report.summary.totalWipes} wipes** · ${report.summary.totalBosses} bosses · ${formatDuration(report.summary.totalCombatTimeMs)} en combate`,
    '',
    bossAsciiTable(report),
  ];

  if (attendance) {
    lines.push(
      '',
      '## Asistencia',
      `- **Main presentes (${attendance.attendingMain.length}):** ${attendance.attendingMain.map(escapeMarkdown).join(', ') || '—'}`,
      ...(attendance.attendingTrial.length ? [`- **Trial presentes (${attendance.attendingTrial.length}):** ${attendance.attendingTrial.map(escapeMarkdown).join(', ')}`] : []),
      ...(attendance.attendingUnlisted.length ? [`- **Sin roster en WowAudit (${attendance.attendingUnlisted.length}):** ${attendance.attendingUnlisted.map(escapeMarkdown).join(', ')}`] : []),
      ...(attendance.absentMain.length ? [`- **Main ausentes (${attendance.absentMain.length}):** ${attendance.absentMain.map(escapeMarkdown).join(', ')}`] : []),
    );
  }

  if (report.summary.progressBoss) {
    const progress = report.summary.progressBoss;
    lines.push(`- **Progress actual:** ${escapeMarkdown(bilingualName(progress.bossName, progress.bossNameEs))} [${escapeMarkdown(progress.difficulty)}] · ${progress.pulls} pulls · ${formatNumber(progress.firstWipePct)}% → ${formatNumber(progress.lastWipePct)}% · mejor ${formatNumber(progress.bestWipePct)}%`);
  }

  lines.push('', '## Foco para la próxima raid');
  if (report.priorities.length) {
    for (const [index, priority] of report.priorities.slice(0, 3).entries()) {
      lines.push(`${index + 1}. **${escapeMarkdown(priority.title)}:** ${escapeMarkdown(priority.detail)}`);
      if (priority.note) lines.push(`   - **Qué hace:** ${escapeMarkdown(plainNote(priority.note))}`);
    }
  } else {
    lines.push('- No hay una prioridad sólida del boss de progress con la muestra disponible.');
  }
  lines.push('', '### Lo que funcionó');
  lines.push(...(report.goodPoints.length ? report.goodPoints.map((point) => `- ${escapeMarkdown(point)}`) : ['- Sin señal suficiente para destacar una mejora colectiva concreta.']));

  // ---- Bosses de la noche: mecánicas + golpes finales + defensivos, juntos ----
  lines.push('', '## Bosses de la noche', '> El boss de progress aparece primero; después, el resto en el mismo orden que la tabla de arriba.');
  for (const boss of report.summary.bosses) {
    const isProgress = report.summary.progressBoss?.bossName === boss.bossName && report.summary.progressBoss?.difficulty === boss.difficulty;
    lines.push(
      '',
      `### ${escapeMarkdown(bilingualName(boss.bossName, boss.bossNameEs))} [${escapeMarkdown(boss.difficulty)}]${isProgress ? ' · progress actual' : ''}`,
      `${boss.pulls} pulls · ${boss.kills > 0 ? `${boss.kills} kill${boss.kills === 1 ? '' : 's'}` : `mejor ${formatNumber(boss.bestWipePct)}% de vida`}`,
    );

    const bossMechanics = report.mechanics.filter((m) => m.bossName === boss.bossName && m.difficulty === boss.difficulty);
    if (bossMechanics.length) {
      lines.push('', '**Mecánicas:**');
      for (const mechanic of bossMechanics) {
        lines.push(
          `- ${mechanicLink(mechanic.mechanicName, mechanic.mechanicNameEs, mechanic.wowheadSpellId)}: ${mechanic.totalFails} fallos en ${mechanic.pullsAffected}/${mechanic.totalPulls} pulls (${formatNumber(mechanic.pctPullsAffected)}%) · ${mechanic.lethalFinalBlows} golpes finales letales · responsable: ${escapeMarkdown(mechanic.responsibilityLabel ?? 'sin clasificar')} · tendencia: ${trendLabel(mechanic.trend)}${mechanic.avoidableDamageTotal == null ? '' : ` · daño evitable ${formatCompact(mechanic.avoidableDamageTotal)}`}`,
        );
      }
    }

    const bossDeaths = report.deaths.topFinalBlows.filter((d) => d.bossName === boss.bossName && d.difficulty === boss.difficulty);
    if (bossDeaths.length) {
      lines.push('', '**Golpes finales más repetidos:**');
      for (const death of bossDeaths) {
        lines.push(`- ${mechanicLink(death.mechanicName, death.mechanicNameEs, death.wowheadSpellId)}: **${death.count} muertes** · ${death.distinctPlayers} jugador${death.distinctPlayers === 1 ? '' : 'es'} distinto${death.distinctPlayers === 1 ? '' : 's'}`);
      }
    }

    const defensives = findDefensiveUsage(report, boss.bossName, boss.difficulty);
    if (defensives) {
      lines.push('', '**Defensivos:** (sin tanks — su mitigación es continua por diseño del rol)');
      if (defensives.playersWithZeroCasts.length) {
        lines.push(`- ⚠ Sin ningún defensivo (${defensives.playersWithZeroCasts.length}/${defensives.playersAttended}): ${defensives.playersWithZeroCasts.map(escapeMarkdown).join(', ')}`);
      } else if (defensives.playersAttended) {
        lines.push('- Todos los presentes usaron al menos un defensivo.');
      }
      for (const player of groupDefensiveCastsByPlayer(defensives.casts)) {
        lines.push(`  **${escapeMarkdown(player.playerName)}** · ${player.totalCasts} cast${player.totalCasts === 1 ? '' : 's'}`);
        for (const spell of player.spells) {
          lines.push(`    - ${mechanicLink(spell.spellName, null, spell.wowheadSpellId)} ×${spell.occurrences.length} — ${formatOccurrences(spell.occurrences)}`);
        }
      }
    }

    if (isProgress && report.phaseBreakdown) {
      lines.push('', '**Fases:**');
      for (const phase of report.phaseBreakdown.phases) {
        lines.push(`- ${escapeMarkdown(phase.name)}${phase.isIntermission ? ' (intermedio)' : ''}: ${phase.deaths} muerte${phase.deaths === 1 ? '' : 's'} · ${phase.mechanicFails} fallo${phase.mechanicFails === 1 ? '' : 's'} mecánico${phase.mechanicFails === 1 ? '' : 's'}`);
      }
    }
    if (isProgress && report.interrupts.progressBoss?.totalCasts) {
      const pi = report.interrupts.progressBoss;
      lines.push('', `**Interrupciones:** ${pi.interrupted}/${pi.totalCasts} (${formatNumber(pi.pctSuccess)}%)`);
      for (const cast of pi.topUninterrupted) lines.push(`  - ${mechanicLink(cast.mechanicName, cast.mechanicNameEs, cast.wowheadSpellId)}: ${cast.completedCount} sin cortar`);
    }
  }

  // ---- Síntesis de toda la noche (ejes que no tienen sentido por boss) ----
  lines.push(
    '',
    '## Responsabilidad de las mecánicas · toda la noche',
    `- **Cobertura:** ${report.responsibilities.classifiedMechanics}/${report.responsibilities.totalMechanics} mecánicas (${formatNumber(report.responsibilities.classificationCoveragePct)}%)`,
    ...report.responsibilities.byResponsibility.map((entry) =>
      `- **${escapeMarkdown(entry.label)}:** ${entry.mechanics} mecánicas · ${entry.failedEvents} fallos en ${entry.pullsAffected} pulls · ${entry.deaths} muertes · ${formatCompact(entry.damageTaken)} de daño registrado`,
    ),
  );

  const roles = report.roleInsights;
  lines.push(
    '',
    `## Información por función${roles.scope ? ` · ${escapeMarkdown(bilingualName(roles.scope.bossName, roles.scope.bossNameEs))} [${escapeMarkdown(roles.scope.difficulty)}]` : ' · toda la noche'}`,
    `- **Tanks (${roles.tanks.players}):** ${roles.tanks.deaths} muertes (${formatNumber(roles.tanks.deathsPerPull)}/pull) · ${roles.tanks.tankbusterDeaths} por tankbuster${roles.tanks.nonTankTankbusterDeaths ? ` · ${roles.tanks.nonTankTankbusterDeaths} tankbusters letales alcanzaron a no-tanks` : ''}`,
    `- **Healers (${roles.healers.players}):** ${roles.healers.deaths} muertes (${formatNumber(roles.healers.deathsPerPull)}/pull) · ${roles.healers.raidDeathsWithSustainedNoHealingSignal} muertes de raid con daño sostenido sin sanación registrada en 6 s`,
    `- **DPS (${roles.dps.players}):** ${roles.dps.deaths} muertes (${formatNumber(roles.dps.deathsPerPull)}/pull) · ${roles.dps.personalMechanicDeaths} muertes asociadas a posicionamiento/soak`,
  );

  lines.push(
    '',
    '## Muertes: cobertura de datos',
    `- **Muertes reales:** ${report.deaths.totalRealDeaths}${report.deaths.totalWipeCallExcluded ? ` · ${report.deaths.totalWipeCallExcluded} excluidas por wipe call` : ''}`,
    `- **Causa raíz clasificable:** ${report.deaths.rootCauseClassifiedCount}/${report.deaths.totalRealDeaths} (${formatNumber(report.deaths.rootCauseCoveragePct)}%)`,
    ...report.deaths.byRootCause.map((cause) => `  - ${escapeMarkdown(cause.label)}: ${cause.count} (${formatNumber(cause.pct)}%)`),
  );

  lines.push(
    '',
    '## Recursos personales',
    `- **Defensivos:** ${report.defensives.playersEverUsed}/${report.defensives.totalPlayersTracked} jugadores usaron alguno (${formatNumber(report.defensives.pctPlayersUsedAtLeastOnce)}%) · ${report.defensives.totalCasts} casts · ${formatNumber(report.defensives.castsPerCombatMinute)}/min de combate`,
    report.defensives.totalEvaluated
      ? `- **Otra herramienta disponible al morir sin usar:** ${report.defensives.availableUnusedCount}/${report.defensives.totalEvaluated} muertes evaluables (${formatNumber(report.defensives.globalAvailableUnusedPct)}%)`
      : '- **Disponibilidad al morir:** sin muertes evaluables con información de cooldown.',
    `- **Healthstone/health potion:** ${report.survival.either.playersEverUsed}/${report.survival.either.totalPlayersTracked} jugadores usaron alguno (${formatNumber(report.survival.either.pctUsedAtLeastOnce)}%) · ${formatNumber(report.survival.pctDeathsWithNoEmergencyConsumableInPull)}% de las muertes sin uso registrado en el try`,
  );

  if (report.avoidableDamage) {
    const avoidable = report.avoidableDamage;
    lines.push(
      '',
      '## Daño evitable medido',
      `- **${formatCompact(avoidable.total)}** · ${formatCompact(avoidable.perMinute)}/min${avoidable.pctOfRaidDamage == null ? '' : ` · ${formatNumber(avoidable.pctOfRaidDamage)}% del daño de raid en el ámbito medido`} · cobertura ${avoidable.measuredBossScopes}/${avoidable.totalBossScopes} boss+dificultad${avoidable.complete ? ' (completa)' : ' (parcial)'}`,
    );
  }

  lines.push('', '## Señales presentes en wipes', '> Son señales no exclusivas: un mismo wipe puede aparecer en varias filas. No demuestran por sí solas qué causó el wipe.');
  if (report.wipeRecovery.wipesEvaluable) {
    lines.push(`- **Caída en cadena:** ${report.wipeRecovery.wipesWithCascade}/${report.wipeRecovery.wipesEvaluable} wipes con ≥3 muertes reales en ${report.wipeRecovery.windowMs / 1_000} s desde la primera (${formatNumber(report.wipeRecovery.pctWipesWithCascade)}%)`);
  }
  lines.push(...(report.wipePatterns.length
    ? report.wipePatterns.map((pattern) => `- **${escapeMarkdown(pattern.label)}:** ${pattern.count}/${report.summary.totalWipes} (${formatNumber(pattern.pct)}%)`)
    : ['- Sin wipes evaluables.']));

  lines.push('', '## Progresión');
  lines.push(...(report.summary.progression.length
    ? report.summary.progression.map((progress) => `- **${escapeMarkdown(bilingualName(progress.bossName, progress.bossNameEs))}** [${escapeMarkdown(progress.difficulty)}]: ${formatNumber(progress.firstWipePct)}% → ${formatNumber(progress.lastWipePct)}% (${progress.pulls} pulls)`)
    : ['- Hace falta más de un pull por boss para medir progresión.']));
  if (report.progressionComparison) {
    lines.push(`- **Segunda mitad vs primera, mismo boss+dificultad:** muertes/pull ${signedPct(report.progressionComparison.deathsDeltaPct)} · daño evitable/pull ${signedPct(report.progressionComparison.avoidableDamageDeltaPct)} · cobertura defensivos ${signedPct(report.progressionComparison.defensiveCoverageDeltaPct)}`);
  }

  lines.push('', '## Límites del informe', ...report.notAvailable.map((item) => `- ${escapeMarkdown(item)}`));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
