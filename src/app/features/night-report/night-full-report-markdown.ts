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

/**
 * Resumen para Discord sin recortes. Puede requerir varios mensajes, pero
 * conserva completas todas las notas y explicaciones incluidas.
 */
export function buildNightDiscordSummary(report: NightFullReport): string {
  const lines = [
    `# Informe de combate de IRIS · ${escapeMarkdown(reportDateLabel(report))}`,
    `**${report.summary.totalPulls} pulls · ${report.summary.totalKills} kills · ${report.summary.totalWipes} wipes · ${formatDuration(report.summary.totalCombatTimeMs)} en combate**`,
    '',
    bossAsciiTable(report),
  ];

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

/** Informe detallado, pensado para compartirlo completo o como archivo de texto. */
export function buildNightFullReportMarkdown(report: NightFullReport, generatedAt?: string): string {
  const lines: string[] = [
    `# Informe de combate de IRIS · ${escapeMarkdown(reportDateLabel(report))}`,
    `Datos agregados y deterministas · ${report.reportCode}${generatedAt ? ` · actualizado ${new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(generatedAt))}` : ''}`,
    '',
    '## Resumen',
    `- **${report.summary.totalPulls} pulls** · **${report.summary.totalKills} kills** · **${report.summary.totalWipes} wipes** · ${report.summary.totalBosses} bosses`,
    `- **Tiempo en combate:** ${formatDuration(report.summary.totalCombatTimeMs)} · media ${formatDuration(report.summary.avgPullDurationMs)} por pull`,
    `- **Wipes tempranos (<${formatDuration(report.summary.earlyWipeThresholdMs)}):** ${report.summary.earlyWipeCount}`,
    '',
    bossAsciiTable(report),
  ];

  if (report.summary.bestPull) {
    const best = report.summary.bestPull;
    lines.push(`- **Mejor resultado:** ${escapeMarkdown(bilingualName(best.bossName, best.bossNameEs))} [${escapeMarkdown(best.difficulty)}] #${best.pullNumber} · ${best.kill ? 'kill' : `wipe al ${formatNumber(best.wipePct)}%`}`);
  }

  if (report.summary.progressBoss) {
    const progress = report.summary.progressBoss;
    lines.push(`- **Progress actual:** ${escapeMarkdown(bilingualName(progress.bossName, progress.bossNameEs))} [${escapeMarkdown(progress.difficulty)}] · ${progress.pulls} pulls · ${formatNumber(progress.firstWipePct)}% → ${formatNumber(progress.lastWipePct)}% · mejor ${formatNumber(progress.bestWipePct)}%`);
  }

  const topLethal = report.deaths.topFinalBlows[0];
  if (topLethal) {
    lines.push(
      '',
      '## Golpe final más repetido de la noche',
      `- ${mechanicLink(topLethal.mechanicName, topLethal.mechanicNameEs, topLethal.wowheadSpellId)} · ${escapeMarkdown(bilingualName(topLethal.bossName, topLethal.bossNameEs))} [${escapeMarkdown(topLethal.difficulty)}] · **${topLethal.count} muertes**`,
    );
    if (topLethal.note) lines.push(`  - **Qué hace:** ${escapeMarkdown(plainNote(topLethal.note))}`);
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

  lines.push('', '## Mecánicas recurrentes de la noche', '> El boss de progress aparece primero; después se conserva el contexto útil de los bosses anteriores.');
  if (report.mechanics.length) {
    for (const mechanic of report.mechanics) {
      lines.push(
        `- **${mechanicLink(mechanic.mechanicName, mechanic.mechanicNameEs, mechanic.wowheadSpellId)}** · ${escapeMarkdown(bilingualName(mechanic.bossName, mechanic.bossNameEs))} [${escapeMarkdown(mechanic.difficulty)}]`,
        `  - ${mechanic.totalFails} fallos en ${mechanic.pullsAffected}/${mechanic.totalPulls} pulls (${formatNumber(mechanic.pctPullsAffected)}%) · ${mechanic.lethalFinalBlows} golpes finales letales · tendencia: ${trendLabel(mechanic.trend)}${mechanic.avoidableDamageTotal == null ? '' : ` · daño evitable ${formatCompact(mechanic.avoidableDamageTotal)}`}`,
      );
      if (mechanic.note) lines.push(`  - **Qué hace:** ${escapeMarkdown(plainNote(mechanic.note))}`);
    }
  } else {
    lines.push('- No hay fallos mecánicos verificables registrados.');
  }

  lines.push(
    '',
    '## Muertes: evidencia y cobertura',
    `- **Muertes reales:** ${report.deaths.totalRealDeaths}${report.deaths.totalWipeCallExcluded ? ` · ${report.deaths.totalWipeCallExcluded} excluidas por wipe call` : ''}`,
    `- **Causa raíz clasificable:** ${report.deaths.rootCauseClassifiedCount}/${report.deaths.totalRealDeaths} (${formatNumber(report.deaths.rootCauseCoveragePct)}%)`,
    `- **Categoría mecánica conocida:** ${report.deaths.mechanicCategorizedCount}/${report.deaths.totalRealDeaths} (${formatNumber(report.deaths.mechanicCategoryCoveragePct)}%)`,
    `- **Golpe final sin habilidad identificada:** ${report.deaths.unknownFinalBlowCount}/${report.deaths.totalRealDeaths}`,
    '- “Daño sostenido sin sanación registrada” describe una ventana de 6 s; no atribuye la causa a los healers.',
    '',
    '### Golpes finales más repetidos',
  );
  if (report.deaths.topFinalBlows.length) {
    for (const death of report.deaths.topFinalBlows) {
      lines.push(`- ${mechanicLink(death.mechanicName, death.mechanicNameEs, death.wowheadSpellId)} · ${escapeMarkdown(bilingualName(death.bossName, death.bossNameEs))} [${escapeMarkdown(death.difficulty)}] · **${death.count} muertes**`);
      if (death.note) lines.push(`  - ${escapeMarkdown(plainNote(death.note))}`);
    }
  } else {
    lines.push('- Sin golpes finales identificables.');
  }
  if (report.deaths.unknownFinalBlowCount) {
    lines.push(
      '',
      '### Contexto de muertes sin golpe final identificado',
      `- En ${report.deaths.unknownFinalBlowWithDamageContextCount}/${report.deaths.unknownFinalBlowCount} se conserva al menos un impacto positivo anterior. Esto es contexto, no atribución del golpe final.`,
      ...report.deaths.topLastDamageBeforeUnknownFinalBlow.map((damage) => `- Último daño registrado: ${mechanicLink(damage.mechanicName, damage.mechanicNameEs, damage.wowheadSpellId)} · ${escapeMarkdown(bilingualName(damage.bossName, damage.bossNameEs))} · ${damage.count} casos`),
    );
  }
  lines.push('', '### Señales de causa raíz', ...report.deaths.byRootCause.map((cause) => `- **${escapeMarkdown(cause.label)}:** ${cause.count} (${formatNumber(cause.pct)}%)`));

  const roles = report.roleInsights;
  lines.push(
    '',
    `## Información por función${roles.scope ? ` · ${escapeMarkdown(bilingualName(roles.scope.bossName, roles.scope.bossNameEs))} [${escapeMarkdown(roles.scope.difficulty)}]` : ' · toda la noche'}`,
    `- **Cobertura de roles:** ${roles.classifiedPlayers}/${roles.totalPlayers} jugadores (${formatNumber(roles.classificationCoveragePct)}%)`,
    `- **Tanks (${roles.tanks.players}):** ${roles.tanks.deaths} muertes (${formatNumber(roles.tanks.deathsPerPull)}/pull) · ${roles.tanks.tankbusterDeaths} por tankbuster · defensivo registrado en ${roles.tanks.playersUsingDefensive}/${roles.tanks.players}${roles.tanks.nonTankTankbusterDeaths ? ` · ${roles.tanks.nonTankTankbusterDeaths} tankbusters letales alcanzaron a no-tanks` : ''}`,
    `- **Healers (${roles.healers.players}):** ${roles.healers.deaths} muertes (${formatNumber(roles.healers.deathsPerPull)}/pull) · defensivo registrado en ${roles.healers.playersUsingDefensive}/${roles.healers.players} · ${roles.healers.raidDeathsWithSustainedNoHealingSignal} muertes de raid con daño sostenido sin sanación registrada en 6 s`,
    `- **DPS (${roles.dps.players}):** ${roles.dps.deaths} muertes (${formatNumber(roles.dps.deathsPerPull)}/pull) · defensivo registrado en ${roles.dps.playersUsingDefensive}/${roles.dps.players} · ${roles.dps.personalMechanicDeaths} muertes asociadas a posicionamiento/soak`,
    '- La señal de healing describe lo registrado en la ventana; no identifica responsable ni demuestra que la muerte fuese salvable.',
  );

  const lookbackSeconds = Math.round(report.survival.emergencyLookbackMs / 1_000);
  lines.push(
    '',
    '## Recursos personales',
    `- **Herramientas defensivas registradas:** ${report.defensives.playersEverUsed}/${report.defensives.totalPlayersTracked} jugadores (${formatNumber(report.defensives.pctPlayersUsedAtLeastOnce)}%) · ${report.defensives.totalCasts} casts · ${formatNumber(report.defensives.castsPerCombatMinute)}/min de combate`,
    report.defensives.totalEvaluated
      ? `- **Otra herramienta defensiva disponible al morir:** ${report.defensives.availableUnusedCount}/${report.defensives.totalEvaluated} muertes evaluables (${formatNumber(report.defensives.globalAvailableUnusedPct)}%)`
      : '- **Disponibilidad al morir:** sin muertes evaluables con información de cooldown.',
    `- **Healthstone:** ${report.survival.healthstone.playersEverUsed}/${report.survival.healthstone.playersWithObservedAccess} jugadores con acceso observable registraron uso (${formatNumber(report.survival.healthstone.pctUsedAtLeastOnce)}%)`,
    `- **Health potion:** ${report.survival.healthPotion.playersEverUsed}/${report.survival.healthPotion.totalPlayersTracked} jugadores registraron uso (${formatNumber(report.survival.healthPotion.pctUsedAtLeastOnce)}%)`,
    `- **Algún recurso de emergencia:** ${report.survival.either.playersEverUsed}/${report.survival.either.totalPlayersTracked} jugadores registraron healthstone o health potion (${formatNumber(report.survival.either.pctUsedAtLeastOnce)}%)`,
    `- **Muertes sin uso registrado de esos recursos en los ${lookbackSeconds} s previos:** ${formatNumber(report.survival.pctDeathsWithNoRecentEmergencyConsumable)}%`,
  );
  if (report.survival.healthstone.deathsEvaluable) {
    lines.push(`- **Acceso observable a healthstone y sin uso en los ${lookbackSeconds} s previos:** ${report.survival.healthstone.deathsWithObservedAccessNoRecentUse}/${report.survival.healthstone.deathsEvaluable} muertes evaluables`);
  }

  lines.push('', '## Interrupciones verificables');
  if (report.interrupts.progressBoss) {
    const progressInterrupts = report.interrupts.progressBoss;
    lines.push(`- **Boss de progress — ${escapeMarkdown(bilingualName(progressInterrupts.bossName, progressInterrupts.bossNameEs))}:** ${progressInterrupts.interrupted}/${progressInterrupts.totalCasts} (${formatNumber(progressInterrupts.pctSuccess)}%)`);
    for (const cast of progressInterrupts.topUninterrupted) {
      lines.push(`  - ${mechanicLink(cast.mechanicName, cast.mechanicNameEs, cast.wowheadSpellId)}: ${cast.completedCount} sin cortar`);
      if (cast.note) lines.push(`    - ${escapeMarkdown(plainNote(cast.note))}`);
    }
  }
  lines.push(report.interrupts.totalCasts
    ? `- **Toda la noche:** ${report.interrupts.interrupted}/${report.interrupts.totalCasts} casts interrumpidos (${formatNumber(report.interrupts.pctSuccess)}%)`
    : '- Sin casts interruptibles con clasificación verificada.');
  for (const cast of report.interrupts.topUninterrupted) lines.push(`- ${mechanicLink(cast.mechanicName, cast.mechanicNameEs, cast.wowheadSpellId)}: ${cast.completedCount} sin cortar`);
  if (report.interrupts.excludedUnverifiedCasts) lines.push(`- ${report.interrupts.excludedUnverifiedCasts} casts históricos excluidos: solo estaban inferidos como interrupt por texto.`);

  if (report.avoidableDamage) {
    const avoidable = report.avoidableDamage;
    lines.push(
      '',
      '## Daño evitable medido',
      `- **${formatCompact(avoidable.total)}** · ${formatCompact(avoidable.perMinute)}/min${avoidable.pctOfRaidDamage == null ? '' : ` · ${formatNumber(avoidable.pctOfRaidDamage)}% del daño recibido de raid en el ámbito medido`}`,
      `- Cobertura: ${avoidable.measuredBossScopes}/${avoidable.totalBossScopes} combinaciones boss+dificultad${avoidable.complete ? ' (completa)' : ' (parcial)'}.`,
    );
  }

  lines.push('', '## Señales presentes en wipes', '> Son señales no exclusivas: un wipe puede aparecer en varias filas. No demuestran por sí solas qué causó el wipe.');
  if (report.wipeRecovery.wipesEvaluable) {
    lines.push(`- **Caída en cadena:** en ${report.wipeRecovery.wipesWithCascade}/${report.wipeRecovery.wipesEvaluable} wipes evaluables hubo al menos 3 muertes reales dentro de los ${report.wipeRecovery.windowMs / 1_000} s desde la primera (${formatNumber(report.wipeRecovery.pctWipesWithCascade)}%).`);
  }
  lines.push(...(report.wipePatterns.length
    ? report.wipePatterns.map((pattern) => `- **${escapeMarkdown(pattern.label)}:** ${pattern.count}/${report.summary.totalWipes} (${formatNumber(pattern.pct)}%)`)
    : ['- Sin wipes evaluables.']));

  lines.push('', '## Progresión');
  lines.push(...(report.summary.progression.length
    ? report.summary.progression.map((progress) => `- **${escapeMarkdown(bilingualName(progress.bossName, progress.bossNameEs))}** [${escapeMarkdown(progress.difficulty)}] · vida: ${formatNumber(progress.firstWipePct)}% → ${formatNumber(progress.lastWipePct)}% (${progress.pulls} pulls)`)
    : ['- Hace falta más de un pull por boss para medir progresión.']));
  if (report.progressionComparison) {
    lines.push(`- **Segunda mitad vs primera, mismo boss+dificultad:** muertes/pull ${signedPct(report.progressionComparison.deathsDeltaPct)} · daño evitable/pull ${signedPct(report.progressionComparison.avoidableDamageDeltaPct)} · cobertura de defensivos ${signedPct(report.progressionComparison.defensiveCoverageDeltaPct)}`);
  }

  lines.push('', '## Límites del informe', ...report.notAvailable.map((item) => `- ${escapeMarkdown(item)}`));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
