// Colocar en: src/app/features/night-player-dossier/night-player-dossier.component.ts
// §"un resumen de una noche... para dirigir a uno o varios raiders... un
// poco como un dosier de personaje de una noche concreta" (feedback real).
// Ruta /report/:code/player/:name — toda la agregación vive en
// night-player-summary.service.ts, este componente solo pinta.
import { Component, computed, effect, HostListener, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DEFENSIVE_MISS_PENALTY, DEFENSIVE_MISTIMED_PENALTY, DEFENSIVE_NEVER_TOUCHED_PENALTY, NightPlayerSummaryService, PULL_SCORE_FAIL_PENALTY, type NightMechanicFailRow, type NightPlayerSummary, type NightPullSummary, type PullScoreBreakdown } from '../../core/night-player-summary.service';
import { effectiveAxisWeights, type PlayerReliability, type ReliabilityBreakdown } from '../../core/reliability.service';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { mapBrief } from '../../core/pull-analysis.service';
import { comparisonLabel, formatDuration, formatPct, mechanicCategoryMeta, mechanicDisplayName, rootCauseMeta } from '../../shared/format.util';
import { RoleIconComponent } from '../../shared/role-icon.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { EmptyPanelComponent } from '../../shared/empty-panel.component';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import { LlmAnalysisCardComponent } from '../live-pull/llm-analysis-card.component';
import { EMPTY_BRIEF_ENTITIES, type BriefEntities } from '../../shared/brief-text.component';
import type { DeathCause, MechanicCategory } from '../../shared/models/domain';
import type { LlmPullAnalysis } from '../../shared/models/ui';
import { errorMessage } from '../../shared/error-message.util';
import { NightPlayerInfographicComponent } from './night-player-infographic.component';
import { CombatEvaluationFeatureFlagsService } from '../../core/combat-evaluation-feature-flags.service';

// §"preparar la vinculación de ese ID... con el dosier de ese raider, para
// eventualmente automatizar enviar la infografía" (feedback real,
// 2026-08-28): mismo guild que ya usa DEFAULT_DISCORD_CHANNEL_ID en
// night-report-infographic.component.ts — un guild ID no es secreto
// (visible en cualquier URL de canal de este servidor), así que vive aquí
// igual que cualquier otra constante de config del frontend.
const DISCORD_GUILD_ID = '1377655547121242132';

function toneForScore(score: number | null): 'danger' | 'warning' | 'success' | null {
  if (score == null) return null;
  return score < 50 ? 'danger' : score < 75 ? 'warning' : 'success';
}

/** Contenido del modal de "por qué esta puntuación" — ver explanationModal más abajo. */
interface ExplanationContent {
  title: string;
  lines: string[];
  /** Sub-lista opcional de texto plano — pulls concretos (modal de noche). undefined = sin sub-lista, no una vacía visible. */
  items?: string[];
  /** §"ponle tooltip y el boton de I de información que traemos del
   * prompt con cómo resolverlo" (feedback real, 2026-08-27): sub-lista
   * RICA solo para el modal de puntuación de un pull — mismo markup
   * (wowhead link + info icon + tag de categoría + comparación) que ya usa
   * la tabla "Mecánicas falladas sin morir", para no perder ese contexto
   * al mover el nombre de la mecánica del tooltip antiguo al modal nuevo. */
  mechanics?: NightMechanicFailRow[];
}

@Component({
  selector: 'app-night-player-dossier',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink, RoleIconComponent, WowheadLinkComponent, EmptyPanelComponent, MechanicInfoIconComponent, LlmAnalysisCardComponent, NightPlayerInfographicComponent],
  templateUrl: './night-player-dossier.component.html',
  styleUrl: './night-player-dossier.component.scss',
})
export class NightPlayerDossierComponent {
  private summaryService = inject(NightPlayerSummaryService);
  private edgeFunctions = inject(EdgeFunctionsService);
  protected combatFlags = inject(CombatEvaluationFeatureFlagsService);

  reportCode = input.required<string>();
  playerName = input.required<string>();

  data = signal<NightPlayerSummary | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);

  categoryMeta = mechanicCategoryMeta;
  formatDuration = formatDuration;
  formatPct = formatPct;
  mechanicDisplayName = mechanicDisplayName;

  comparisonLabel = comparisonLabel;

  // §"wowanalyzer para mejorar las rotaciones... todo en nuestra app"
  // (feedback real, 2026-08-27): enlace a la instancia LOCAL autoalojada
  // (supabase/wowanalyzer-app/), no a wowanalyzer.com — puerto fijo del
  // docker-compose.yml de ese directorio. Solo funciona si ese contenedor
  // está levantado; si no, el enlace da un error de conexión normal (mismo
  // criterio que un enlace a RaidBots/RaiderIO que no resuelve — no hay
  // forma de saber desde aquí si el contenedor está arriba sin intentarlo).
  wowAnalyzerUrl(reportCode: string, fightId: number, playerName: string): string {
    return `http://localhost:4321/report/${reportCode}/${fightId}/${encodeURIComponent(playerName)}/standard`;
  }

  copyStatus = signal<'idle' | 'copied' | 'error'>('idle');
  infographicOpen = signal(false);
  refreshingInfographic = signal(false);

  // §"preparar la vinculación de ese ID... con el dosier de ese raider, para
  // eventualmente automatizar enviar la infografía" (feedback real,
  // 2026-08-28): la infografía visual por raider todavía no existe (solo la
  // de la noche completa, ver NightReportInfographicComponent) — esto envía
  // el mismo resumen de texto que ya construye copySummary() a través del
  // canal privado ya vinculado en Ajustes → Discord (discord_roster_channels,
  // resuelto en night-player-summary.service.ts). Mismo sendDiscordMessage
  // que usa la infografía de la noche — cuando exista una infografía visual
  // por raider, apuntarla a este mismo channelId es un cambio trivial.
  sendToDiscordStatus = signal<'idle' | 'sending' | 'sent' | 'error'>('idle');
  sendToDiscordError = signal<string | null>(null);

  // §"que dentro del dosier pueda hacer consulta IA con informe completo...
  // orientado a mejorar como RL" (feedback real): mismo patrón que el brief
  // de un pull — generatingBrief separado de `error` a propósito (un fallo
  // al pedir el análisis no debe borrar el resto del dosier ya cargado).
  generatingBrief = signal(false);
  briefError = signal<string | null>(null);

  // §"pintar cada jugador de su clase, mecánicas con tooltip+nota" (feedback
  // real): un solo jugador en este ámbito, pero mismas mecánicas ya
  // calculadas para las tres tablas del dosier — nada que pedir aparte.
  briefEntities = computed<BriefEntities>(() => {
    const d = this.data();
    if (!d) return EMPTY_BRIEF_ENTITIES;
    const players = new Map<string, string>();
    if (d.gearSnapshot?.class) players.set(d.playerName, d.gearSnapshot.class);
    const mechanics = new Map<string, { spellId: number | null; note: string | null }>();
    for (const death of d.deaths) mechanics.set(mechanicDisplayName(death.mechanicName), { spellId: death.mechanicId, note: death.aiNote });
    for (const fail of d.mechanicFails) mechanics.set(mechanicDisplayName(fail.mechanicName), { spellId: fail.mechanicId, note: fail.aiNote });
    for (const p of d.repeatedPatterns) mechanics.set(mechanicDisplayName(p.mechanicName), { spellId: p.mechanicId, note: p.aiNote });
    return { players, mechanics };
  });

  reliabilityTone = computed<'danger' | 'warning' | 'success' | null>(() => toneForScore(this.data()?.reliability?.overall ?? null));
  // §"fiabilidad debería tener 2 valores: 60 días y de la noche" (feedback real).
  nightReliabilityTone = computed<'danger' | 'warning' | 'success' | null>(() => toneForScore(this.data()?.nightReliability?.overall ?? null));
  /** §"puntuación compuesta... como wipefest" (feedback real, 2026-08-27): nightScore/pullScore van en escala 0-1 (no 0-100 como el resto de tonos) — se convierte aquí en vez de duplicar toneForScore con otra escala. */
  nightScoreTone(score: number): 'danger' | 'warning' | 'success' | null {
    return toneForScore(score * 100);
  }

  // §"el tooltip se sale de la pantalla, además creo que falta información
  // ... igual más que un tooltip tiene que ser un clicable con un modal que
  // te dé una explicación completa de la puntuación" (feedback real,
  // 2026-08-27): un solo modal genérico reutilizado por las 4 puntuaciones
  // de esta página (noche, fiabilidad 60 días, fiabilidad de la noche, y
  // cada pull) — un hover-tooltip anclado a la izquierda del elemento se
  // salía de la pantalla en las columnas de la derecha de la tabla de pulls
  // (capturas reales) y además no funciona en táctil. `items` es una
  // sub-lista opcional — de momento solo la usan pullScoreExplanation
  // (mecánicas concretas) y nightScoreExplanation (pulls concretos).
  explanationModal = signal<ExplanationContent | null>(null);

  openExplanation(content: ExplanationContent): void {
    this.explanationModal.set(content);
  }

  closeExplanation(): void {
    this.explanationModal.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.explanationModal()) this.closeExplanation();
  }

  // §"Ahi por ejemplo pone que falló 2 mecanicas pero no dice cuales"
  // (feedback real, 2026-08-27): antes este texto solo daba el CONTEO;
  // ahora además nombra cada una. mechanicFails ya es EXACTAMENTE el mismo
  // array del que sale mechanicFailCountByPullId en
  // night-player-summary.service.ts (agrupado por pullId) — filtrar aquí
  // por pull.pullId nunca puede desajustarse del conteo que ya sale en
  // scoreBreakdown, es la misma fuente.
  // §pullScore recibido como número aparte (no leído de pull.pullScore
  // dentro del método): pullScore es number|null a nivel de tipo (null en
  // pulls excluidos, ver excludedFromStats) — el llamador solo lo invoca
  // dentro de un @if (p.pullScore != null), y Angular únicamente estrecha
  // esa expresión concreta ahí, no el objeto pull completo pasado entero.
  pullScoreExplanation(pull: NightPullSummary, pullScore: number, mechanicFails: NightMechanicFailRow[]): ExplanationContent {
    const b = pull.scoreBreakdown;
    const durationMs = pull.durationMs;
    const lines: string[] = [];
    // §"consistente... contemplar muchas posibilidades distintas"
    // (feedback real, 2026-08-28): avoidable-ground/spread ahora puntúan
    // por ratio real (instancias esquivadas/elegibles) — se explica aparte
    // porque ya no es "N fallos = −25% cada uno", es una fracción. soak/
    // personal-target siguen siendo conteo plano, se quedan en la línea de
    // abajo tal cual estaba.
    if (b.avoidableMechanicEligibleCount != null && b.avoidableMechanicEligibleCount > 0) {
      const dodged = b.avoidableMechanicEligibleCount - (b.avoidableMechanicFailCount ?? 0);
      lines.push(
        `Esquivar zona/dispersarse: ${dodged}/${b.avoidableMechanicEligibleCount} instancias evitadas mientras seguía vivo.`,
      );
    }
    const countCategoryFailCount =
      b.avoidableMechanicFailCount != null ? Math.max(0, b.mechanicFailCount - b.avoidableMechanicFailCount) : b.mechanicFailCount;
    lines.push(
      countCategoryFailCount === 0
        ? `Mecánica: ${this.formatPct(b.mechanicScore * 100)} — sin fallos de soak/objetivo personal.`
        : `Mecánica: ${this.formatPct(b.mechanicScore * 100)} — ${countCategoryFailCount} fallo${countCategoryFailCount === 1 ? '' : 's'} de soak/objetivo personal (−${this.formatPct(PULL_SCORE_FAIL_PENALTY * 100)} cada uno):`,
    );
    // §"vamos a decirlo y subir su porcentaje de mecanicas por haberlo
    // hecho con éxito" (feedback real, 2026-08-29): línea explícita — el
    // bonus ya está DENTRO del "Mecánica: X%" de arriba, esto es el "por
    // qué" para que nunca sea un número que sube sin que se sepa de dónde
    // viene. Solo aparece si de verdad resolvió alguna (0 = no añade nada,
    // no hay nada que explicar).
    if (b.unassignedMechanicSuccessCount > 0) {
      lines.push(
        `✓ ${b.unassignedMechanicSuccessCount} mecánica${b.unassignedMechanicSuccessCount === 1 ? '' : 's'} sin asignar resuelta${b.unassignedMechanicSuccessCount === 1 ? '' : 's'} (huevo/orbe/ítem — nadie estaba marcado a hacerlo, lo hizo igual): +${this.formatPct(b.unassignedMechanicBonus * 100)} sobre Mecánica.`,
      );
    }
    if (!b.died) {
      lines.push('Consumibles: 100% — no murió, se aprueba automático (igual que con piedra/poción, solo importa si mueres).');
      // §"no es lo mismo usar 0 defensivos que usarlo a destiempo, lo
      // primero debe penalizar mucho y lo segundo un poco" (feedback real,
      // 2026-08-29): ventanas de presión reales (ver damage-pressure-
      // windows.ts), no el booleano de antes — never_touched (cero casts en
      // todo el pull) penaliza más que mistimed (sí usó algo, mal
      // sincronizado). Las ventanas concretas van en `items`, abajo.
      lines.push(
        b.defensiveMissKind === 'never_touched'
          ? `⚠ ${b.defensiveMissedWindows.length} ventana${b.defensiveMissedWindows.length === 1 ? '' : 's'} de presión real con el catálogo libre y CERO casts defensivos en todo el intento: ×${this.formatPct(DEFENSIVE_NEVER_TOUCHED_PENALTY * 100)} sobre toda la puntuación.`
          : b.defensiveMissKind === 'mistimed'
            ? `⚠ ${b.defensiveMissedWindows.length} ventana${b.defensiveMissedWindows.length === 1 ? '' : 's'} de presión sin cubrir, pero sí lanzó defensivos en otro momento del pull — a destiempo: ×${this.formatPct(DEFENSIVE_MISTIMED_PENALTY * 100)}, penaliza poco porque sí hay intento, ver abajo dónde y por qué.`
            : 'Sin ventana de presión real sin cubrir.',
      );
    } else {
      // §"si tras sufrir daño uso la poción es un uso correcto, usarla por
      // usarla no es correcto" (feedback real, 2026-08-30): usedConsumable ya
      // exige que el cast caiga dentro de una ventana de presión real (ver
      // isReactiveConsumableUse) — el texto lo deja explícito.
      lines.push(`Consumibles: ${this.formatPct(b.consumableScore * 100)} — murió ${b.usedConsumable ? 'con' : 'sin'} piedra de brujo o poción usada en respuesta a daño real durante el intento.`);
      if (b.deathTimeMs != null && durationMs) {
        lines.push(`Murió a los ${this.formatDuration(b.deathTimeMs)} de ${this.formatDuration(durationMs)} (${this.formatPct(b.deathMultiplier * 100)} del intento) — penaliza toda la puntuación, no solo el punto de consumibles.`);
      }
      lines.push(
        b.defensiveMissKind === 'death'
          ? `⚠ Defensivo disponible y sin usar: ×${this.formatPct(DEFENSIVE_MISS_PENALTY * 100)} adicional sobre toda la puntuación del intento — tenía un botón de su catálogo libre en ese momento y no lo lanzó.`
          : 'Sin defensivo disponible marcado como sin usar en el momento de morir (o no tenía ninguno libre en ese instante).',
      );
    }
    lines.push(
      `Fórmula: (mecánica×70% + consumibles×30%) × % del intento vivo${
        b.defensiveMissKind === 'death'
          ? ` × ${this.formatPct(DEFENSIVE_MISS_PENALTY * 100)} (defensivo disponible sin usar al morir)`
          : b.defensiveMissKind === 'never_touched'
            ? ` × ${this.formatPct(DEFENSIVE_NEVER_TOUCHED_PENALTY * 100)} (presión sobrevivida sin ningún defensivo)`
            : b.defensiveMissKind === 'mistimed'
              ? ` × ${this.formatPct(DEFENSIVE_MISTIMED_PENALTY * 100)} (defensivo usado a destiempo)`
              : ''
      }.`,
    );
    // §"esa información debe ser verificable... tooltip o panel lateral"
    // (feedback real, 2026-08-29): mismo dato que ya alimenta la infografía
    // (pressureWindowEvaluation, night-player-summary.service.ts) — el
    // momento exacto, la magnitud del pico, y qué tenía disponible en cada
    // ventana fallada, no solo el multiplicador aplicado.
    const windowItems = b.defensiveMissedWindows.map((w) => {
      const options = w.availableOptions.map((o) => o.name).join(' / ') || 'catálogo sin resolver en ese instante';
      return `${this.formatDuration(w.peakMs)} — pico de ${Math.round(w.peakValue).toLocaleString('es-ES')} de daño sobre su línea base — tenía disponible: ${options}`;
    });
    const fails = mechanicFails.filter((f) => f.pullId === pull.pullId);
    return {
      title: `Puntuación del pull — ${this.formatPct(pullScore * 100)}`,
      lines,
      items: windowItems.length ? windowItems : undefined,
      mechanics: fails.length ? fails : undefined,
    };
  }

  /** Mismo texto que antes tenía el tooltip de "puntuación de la noche" — el modal añade el desglose pull a pull, que antes solo se veía pasando el ratón por cada fila una a una. */
  nightScoreExplanation(
    nightScore: number,
    pulls: NightPullSummary[],
    consistency: NightPlayerSummary['nightDefensiveConsistency'],
  ): ExplanationContent {
    const scoredCount = pulls.filter((p) => p.pullScore != null).length;
    const excludedCount = pulls.length - scoredCount;
    return {
      title: `Puntuación de la noche — ${this.formatPct(nightScore * 100)}`,
      lines: [
        'Media de la puntuación de cada pull, ponderada por su duración — un pull de 8 min pesa más que uno de 40s.',
        excludedCount
          ? `${scoredCount} pull${scoredCount === 1 ? '' : 's'} evaluados esta noche (${excludedCount} más excluido${excludedCount === 1 ? '' : 's'} — ninja pull o wipe call temprano, no cuentan).`
          : `${scoredCount} pull${scoredCount === 1 ? '' : 's'} evaluados esta noche.`,
        // §"no puedes tener una ejecución buenísima si no has usado NINGÚN
        // defensivo en algún pull" (feedback real, 2026-08-29): la media de
        // arriba ya diluye un pull sin defensivo si el resto fue limpio —
        // este factor aparte castiga la noche completa y escala con cuántos
        // pulls distintos lo hicieron, para que no se pierda en el promedio.
        consistency.missPullCount === 0
          ? 'Consistencia defensiva: ×100% — ningún pull con un defensivo libre y sin usar esta noche.'
          : `Consistencia defensiva: ×${this.formatPct(consistency.multiplier * 100)} — ${consistency.missPullCount} pull${consistency.missPullCount === 1 ? '' : 's'} distinto${consistency.missPullCount === 1 ? '' : 's'} con un defensivo libre y sin usar (muerte o presión); de ${this.formatPct((consistency.rawScore ?? 0) * 100)} media de pulls a ${this.formatPct(nightScore * 100)} tras aplicarlo.`,
      ],
      // §"no debería contar para ninguna estadística ni métrica" (feedback
      // real, 2026-08-27): los excluidos se listan igual (contexto de qué
      // pasó esa noche), pero sin un % que no significa nada.
      items: pulls.map((p) => `${p.bossName} #${p.pullNumber}: ${p.pullScore != null ? this.formatPct(p.pullScore * 100) + (p.died ? ' (murió)' : '') : 'excluido — ' + (p.excludedReason === 'ninja_pull' ? 'ninja pull' : 'wipe call')}`),
    };
  }

  /** §"venir sin la preparación penaliza si no se hace, pero se da por
   * supuesto que si lo tienes que hacer así que no cuenta para sumar"
   * (feedback real, 2026-08-30): líneas de Mecánica/Defensiva/Preparación
   * compartidas por los dos modales de abajo — el peso que se enseña ya no
   * es un texto fijo (44%/33%/22%), sale de effectiveAxisWeights para que
   * refleje si preparación realmente contó en ESTE overall o quedó fuera
   * por perfecta. */
  private reliabilityAxisLines(breakdown: PlayerReliability['breakdown']): string[] {
    const w = effectiveAxisWeights(breakdown);
    const preparacionLine =
      breakdown.preparacion == null
        ? 'Preparación: sin dato'
        : breakdown.preparacion >= 100
          ? `Preparación: 100% — completa, no suma al overall (es la línea base esperada; solo penalizaría si faltase algo)`
          : `Preparación (${w.preparacion}%): ${breakdown.preparacion.toFixed(0)}% — incompleta, sí penaliza`;
    return [
      `Mecánica (${w.mecanica ?? '—'}%): ${breakdown.mecanica != null ? breakdown.mecanica.toFixed(0) + '%' : 'sin dato'}`,
      `Defensiva (${w.defensiva ?? '—'}%): ${breakdown.defensiva != null ? breakdown.defensiva.toFixed(0) + '%' : 'sin dato'} — uso durante el try; la respuesta en una muerte evaluable pesa el doble.`,
      preparacionLine,
    ];
  }

  /** Mismo contenido que antes tenía el tooltip de fiabilidad — 60 días, ahora en el modal.
   * §"rotar en un boss por tema de specs no tiene por qué afectar a la
   * fiabilidad" (feedback real, 2026-08-28): sin eje de asistencia — se
   * enseña aparte, informativo, para que quede claro que ya no puntúa. */
  reliabilityWindowExplanation(rel: PlayerReliability): ExplanationContent {
    return {
      title: `Fiabilidad — 60 días (${rel.overall}/100)`,
      lines: [
        ...this.reliabilityAxisLines(rel.breakdown),
        `Consistencia: ${rel.consistency ? rel.consistency.score + '/100 (media ' + rel.consistency.averageExecution + ', variabilidad ' + rel.consistency.volatility + ')' : 'sin muestra suficiente'}`,
        `Asistencia (informativo, no puntúa): ${rel.attendanceNightsAttended != null && rel.attendanceNightsTotal != null ? rel.attendanceNightsAttended + '/' + rel.attendanceNightsTotal + ' noches' : 'sin cruce suficiente'} — una rotación por composición no debe penalizar la fiabilidad.`,
      ],
    };
  }

  /** Mismo contenido que antes tenía el tooltip de fiabilidad — esta noche, ahora en el modal. */
  nightReliabilityExplanation(nr: ReliabilityBreakdown & { sampleSize: number }): ExplanationContent {
    return {
      title: `Fiabilidad — esta noche (${nr.overall}/100)`,
      lines: [
        ...this.reliabilityAxisLines(nr.breakdown),
        `Consistencia: ${nr.consistency ? nr.consistency.score + '/100 (media ' + nr.consistency.averageExecution + ', variabilidad ' + nr.consistency.volatility + ')' : 'sin muestra suficiente'}`,
        `${nr.sampleSize} pull${nr.sampleSize === 1 ? '' : 's'} evaluados. Misma fórmula que Fiabilidad — 60 días, solo acotada a esta noche.`,
      ],
    };
  }

  // §bug real ya visto en LivePullComponent/BossHistoryComponent: leer un
  // input() (incluido el vinculado por ruta) DENTRO del constructor revienta
  // con NG0950 — Angular lo asigna DESPUÉS de construir la instancia.
  constructor() {
    effect(() => {
      const code = this.reportCode();
      const name = this.playerName();
      void this.load(code, name);
    });
  }

  private async load(reportCode: string, playerName: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.summaryService.load(reportCode, playerName));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * La lámina se abre sobre el resumen ya cargado y persistido en las tablas
   * de la noche; no llama a IA ni recalcula al abrir. Este botón es la salida
   * explícita para releer Supabase si el report, una exclusión o el manifiesto
   * han cambiado desde que se abrió el dosier. §"tiene sentido que actualice
   * una única vez cuando termina la raid" (feedback real, 2026-08-29):
   * summaryService.load() ahora sirve un snapshot cacheado por defecto — este
   * botón es la vía explícita para saltárselo (forceRefresh) y dejar el
   * caché puesto al día con el resultado fresco.
   */
  recalculateProgress = signal<{ done: number; total: number } | null>(null);

  async refreshInfographic(): Promise<void> {
    if (this.refreshingInfographic()) return;
    this.refreshingInfographic.set(true);
    this.error.set(null);
    this.recalculateProgress.set(null);
    try {
      // §bug real encontrado en real (2026-08-31, tank de Paladin — Divine
      // Protection quitado de Protection en Ajustes, el dosier siguió
      // enseñándolo como disponible incluso tras pulsar "recalcular"):
      // saltarse el caché del CLIENTE (forceRefresh de summaryService.load)
      // no sirve de nada si player_pull_records.defensive_pressure_windows
      // nunca se recalculó de verdad contra WCL — eso solo pasa reanalizando
      // el pull. Antes de releer, se reanaliza cada pull de este jugador en
      // este report de verdad.
      const pullIds = this.data()?.pulls.map((p) => p.pullId) ?? [];
      let done = 0;
      this.recalculateProgress.set({ done, total: pullIds.length });
      for (const pullId of pullIds) {
        // pull_mechanic_events es fuente directa del dosier. Si esta parte
        // falla NO seguimos fingiendo un recálculo correcto leyendo las filas
        // antiguas: el error queda visible al usuario y el reemplazo atómico
        // garantiza que el pull conserva su materializado anterior.
        try {
          await this.edgeFunctions.reanalyzeMechanicEvents(pullId);
        } catch (err) {
          throw new Error(`No se pudieron reconstruir las mecánicas del pull ${pullId}: ${errorMessage(err)}`);
        }
        try {
          await this.edgeFunctions.reanalyzeDefensivePressure(pullId);
        } catch (err) {
          console.error(`No se pudo reanalizar defensivos del pull ${pullId} al recalcular el dosier:`, err);
        }
        try {
          await this.edgeFunctions.reanalyzeUnassignedMechanics(pullId);
        } catch (err) {
          console.error(`No se pudo reanalizar mecánicas sin asignar del pull ${pullId} al recalcular el dosier:`, err);
        }
        done++;
        this.recalculateProgress.set({ done, total: pullIds.length });
      }
      this.data.set(await this.summaryService.load(this.reportCode(), this.playerName(), true, true));
    } catch (err) {
      this.error.set(errorMessage(err));
      this.infographicOpen.set(false);
    } finally {
      this.refreshingInfographic.set(false);
    }
  }

  // §"limpiar todo eso que pone 'sin clasificar' y que de hecho, esté
  // clasificado" (feedback real): rootCause y categoría son dos ejes
  // distintos a propósito — rootCause 'unclassified' es honesto sobre no
  // saber el MECANISMO exacto (self_positioning/no_healing_received/etc.,
  // ver computeRootCause en analyze-report), no significa que la mecánica
  // en sí no tenga categoría confirmada. Antes esto se leía como
  // contradictorio (tag "RAID" confirmado junto a "Sin clasificar" en la
  // misma fila) — si hay categoría, se enseña su nombre en vez de un "no lo
  // sé" plano; el "Sin clasificar" real queda solo para cuando NINGUNO de
  // los dos ejes tiene dato.
  rootCauseLabel(cause: DeathCause['rootCause'], category: MechanicCategory | null): string {
    if (cause !== 'unclassified') return rootCauseMeta(cause)?.label ?? cause;
    return mechanicCategoryMeta(category)?.label ?? rootCauseMeta('unclassified')!.label;
  }

  async onGenerateBrief(): Promise<void> {
    const d = this.data();
    if (!d) return;
    this.generatingBrief.set(true);
    this.briefError.set(null);
    try {
      const res = await this.edgeFunctions.generateNightPlayerBrief(d.reportCode, d.playerName);
      const brief = mapBrief(res.brief);
      this.data.set({ ...d, brief });
      // §"tiene sentido que actualice... no lo dejes fijo ni permanente"
      // (feedback real, 2026-08-29): esta mutación no pasa por
      // summaryService.load() (el único sitio que recalcula y cachea) — sin
      // esto, el snapshot cacheado se quedaría con el brief viejo.
      this.summaryService.updateCachedBrief(d.reportCode, d.playerName, brief);
    } catch (err) {
      this.briefError.set(errorMessage(err));
    } finally {
      this.generatingBrief.set(false);
    }
  }

  onManualBriefSaved(brief: LlmPullAnalysis): void {
    const d = this.data();
    if (!d) return;
    this.data.set({ ...d, brief });
    this.summaryService.updateCachedBrief(d.reportCode, d.playerName, brief);
  }

  async copySummary(): Promise<void> {
    const d = this.data();
    if (!d) return;
    try {
      await navigator.clipboard.writeText(this.buildSummaryText(d));
      this.copyStatus.set('copied');
      setTimeout(() => this.copyStatus.set('idle'), 2000);
    } catch {
      this.copyStatus.set('error');
      setTimeout(() => this.copyStatus.set('idle'), 2000);
    }
  }

  /** URL "abrir en Discord" del canal privado de este raider (Ajustes → Discord) — null si todavía no tiene canal (sin vincular, Trial, oficial, o pendiente del próximo "Sincronizar"). */
  discordChannelUrl(): string | null {
    const channelId = this.data()?.discordChannel?.discordChannelId;
    return channelId ? `https://discord.com/channels/${DISCORD_GUILD_ID}/${channelId}` : null;
  }

  async sendSummaryToDiscord(): Promise<void> {
    const d = this.data();
    const channelId = d?.discordChannel?.discordChannelId;
    if (!d || !channelId) return;
    this.sendToDiscordStatus.set('sending');
    this.sendToDiscordError.set(null);
    try {
      await this.edgeFunctions.sendDiscordMessage({ channelId, content: this.buildSummaryText(d) });
      this.sendToDiscordStatus.set('sent');
      setTimeout(() => this.sendToDiscordStatus.set('idle'), 2500);
    } catch (err) {
      this.sendToDiscordError.set(errorMessage(err));
      this.sendToDiscordStatus.set('error');
    }
  }

  private buildSummaryText(d: NightPlayerSummary): string {
    const dateLabel = d.reportDate ? new Date(d.reportDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' }) : d.reportTitle;
    const lines = [
      `📋 Dosier de ${d.playerName} — ${dateLabel}`,
      `Pulls: ${d.pulls.length} · Muertes: ${d.totalDeaths} · Mecánicas falladas: ${d.totalMechanicFails}`,
      d.reliability ? `Fiabilidad general: ${d.reliability.overall}/100` : null,
      '',
    ].filter((l): l is string => l != null);

    if (d.repeatedPatterns.length) {
      lines.push('⚠️ Patrones repetidos esa noche:');
      lines.push(...d.repeatedPatterns.map((p) => `- ${p.mechanicName}: ${p.instanceCount} veces en ${p.distinctBossCount} boss${p.distinctBossCount === 1 ? '' : 'es'} (${p.bossNames.join(', ')})`));
      lines.push('');
    }
    if (d.deaths.length) {
      lines.push('💀 Muertes:');
      lines.push(
        ...d.deaths.map((death) => `- ${death.bossName} #${death.pullNumber} (${this.formatDuration(death.timeMs)}): ${death.mechanicName ?? 'sin identificar'}${death.isWipeCall ? ' [wipe call]' : death.statisticalExclusionReason ? ' [mención no evaluable: melee del boss sin tank]' : ''}`),
      );
    }

    return lines.join('\n').trim();
  }
}
