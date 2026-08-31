// Colocar en: src/app/features/night-report/night-report.component.ts
// §"echo de menos un informe... a nivel de raid también" (feedback real).
// Ruta /report/:reportCode — toda la agregación vive en
// night-report.service.ts (asistencia/brief/wipe-calls, ligero) y en
// generate-night-full-report/_shared/night-full-report.ts (el informe
// determinista pesado), este componente combina los dos y pinta.
//
// §"al pulsar 'ver informe completo' se abre informe 1, que a su vez tiene
// otro botón 'ver informe' que carga informe 2... quiero que informe 2 esté
// en lugar de informe 1, fusionando los datos útiles de los dos en un único
// informe con aspecto visual de informe 2" (feedback real, 2026-08-27):
// antes NightReportComponent (informe 1, con su propio resumen/tablas/
// donuts) abría NightFullReportModalComponent (informe 2, mucho más
// completo) como una modal aparte con un segundo clic. Ahora este
// componente ES el informe único: genera/auto-completa el informe
// determinista al entrar (sin esperar un segundo clic), lo pinta con el
// aspecto de lo que antes era la modal, y le inyecta encima solo lo que
// informe 1 tenía y no era redundante (asistencia, brief IA, wipe calls
// detectados, top offenders) — nunca los dos a la vez para el mismo dato
// (ej. topDeathCauses de informe 1 se descarta: deaths.topFinalBlows de
// informe 2 cubre lo mismo con más detalle, boss incluido).
import { Component, computed, effect, inject, input, signal, ElementRef, ViewChild, ViewContainerRef } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { toBlob } from 'html-to-image';
import { NightReportService, type NightAttendee, type NightReport } from '../../core/night-report.service';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { NightPlayerSummaryService } from '../../core/night-player-summary.service';
import { ReliabilityService, type PlayerReliability, type BossDifficultyEvolutionPoint } from '../../core/reliability.service';
import { OffendersService, type RepeatOffenderRow } from '../../core/offenders.service';
import { RosterSnapshotCacheService, type RosterSnapshot } from '../../core/roster-snapshot-cache.service';
import { NightScoreCacheService, type CachedNightAttendanceStats } from '../../core/night-score-cache.service';
import { NightBossEvolutionCacheService } from '../../core/night-boss-evolution-cache.service';
import { mapBrief } from '../../core/pull-analysis.service';
import { classColor, comparisonLabel, formatDuration, formatPct, wclParseTier } from '../../shared/format.util';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { ClassIconComponent } from '../../shared/class-icon.component';
import { TrendBarsComponent } from '../../shared/charts/trend-bars.component';
import { LlmAnalysisCardComponent } from '../live-pull/llm-analysis-card.component';
import { NightReportInfographicComponent } from './night-report-infographic.component';
import { NightPlayerInfographicComponent } from '../night-player-dossier/night-player-infographic.component';
import { EMPTY_BRIEF_ENTITIES, type BriefEntities } from '../../shared/brief-text.component';
import type { LlmPullAnalysis } from '../../shared/models/ui';
import type { NightFullReport, NightReportTrend, StoredNightFullReport } from '../../shared/models/night-full-report';
import { bilingualName, buildNightDiscordSummary, buildNightFullReportMarkdown, formatOffset, type NightReportAttendanceExtras } from './night-full-report-markdown';
import { errorMessage } from '../../shared/error-message.util';

const SCHEMA_VERSION = 15;

/** Mismos umbrales que night-player-dossier.component.ts (toneForScore) — nada nuevo, solo este componente no lo tenía todavía. */
function scoreTone(score: number | null): 'danger' | 'warning' | 'success' | null {
  if (score == null) return null;
  return score < 50 ? 'danger' : score < 75 ? 'warning' : 'success';
}

@Component({
  selector: 'app-night-report',
  standalone: true,
  imports: [DatePipe, RouterLink, WowheadLinkComponent, TrendBarsComponent, LlmAnalysisCardComponent, NightReportInfographicComponent, ClassIconComponent],
  templateUrl: './night-report.component.html',
  styleUrl: './night-report.component.scss',
})
export class NightReportComponent {
  private nightReportService = inject(NightReportService);
  private edgeFunctions = inject(EdgeFunctionsService);
  private nightPlayerSummaryService = inject(NightPlayerSummaryService);
  private reliabilityService = inject(ReliabilityService);
  private offendersService = inject(OffendersService);
  private rosterSnapshotCache = inject(RosterSnapshotCacheService);
  private nightScoreCache = inject(NightScoreCacheService);
  private bossEvolutionCache = inject(NightBossEvolutionCacheService);
  private viewContainerRef = inject(ViewContainerRef);
  scoreTone = scoreTone;
  wclParseTier = wclParseTier;

  reportCode = input.required<string>();

  @ViewChild('reportRoot') private reportRoot?: ElementRef<HTMLElement>;

  data = signal<NightReport | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);
  fullReport = signal<StoredNightFullReport | null>(null);
  generatingFullReport = signal(false);
  fullReportError = signal<string | null>(null);

  copyStatus = signal<'idle' | 'discord' | 'full' | 'error'>('idle');
  imageStatus = signal<'idle' | 'rendering' | 'downloaded' | 'error'>('idle');
  infographicOpen = signal(false);
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  formatDuration = formatDuration;
  formatPct = formatPct;
  bilingualName = bilingualName;
  comparisonLabel = comparisonLabel;
  classColor = classColor;

  // §"un resumen de una noche... la consulta de IA" — se mantiene igual que
  // informe 1, nunca lo cubrió informe 2 (es cualitativo/manual, no
  // agregación determinista).
  generatingBrief = signal(false);
  briefError = signal<string | null>(null);

  briefEntities = computed<BriefEntities>(() => {
    const d = this.data();
    const full = this.fullReport()?.report;
    if (!d && !full) return EMPTY_BRIEF_ENTITIES;
    const mechanics = new Map<string, { spellId: number | null; note: string | null }>();
    for (const m of full?.mechanics ?? []) mechanics.set(m.mechanicName, { spellId: m.wowheadSpellId, note: m.note });
    for (const death of full?.deaths.topFinalBlows ?? []) if (!mechanics.has(death.mechanicName)) mechanics.set(death.mechanicName, { spellId: death.wowheadSpellId, note: death.note });
    return { players: d?.playerClasses ?? new Map(), mechanics };
  });

  private attendanceExtras = computed<NightReportAttendanceExtras | undefined>(() => {
    const d = this.data();
    return d
      ? {
          attendingMain: d.attendingMain.map((p) => p.name),
          attendingTrial: d.attendingTrial.map((p) => p.name),
          absentMain: d.absentMain.map((p) => p.name),
        }
      : undefined;
  });

  // §"el informe ahora mismo es un poco caos y necesita orden y síntesis...
  // que sean desplegables los bosses de la noche y ahí aparezca en detalle
  // qué defensivo se ha tirado quién y en qué minuto, y claramente
  // señalado si alguien no se ha tirado defensivo" (feedback real,
  // 2026-08-27): reemplaza la lista plana de "mecánicas recurrentes de la
  // noche" + la tabla plana de "uso de defensivos" por UNA sola estructura
  // por boss — así se lee como "qué pasó en cada boss" en vez de tres ejes
  // de datos sueltos que había que cruzar mentalmente. mechanics/
  // topFinalBlows/defensiveUsage ya llevan bossName+difficulty por fila
  // (o vienen directamente por boss, en el caso de defensiveUsage) —
  // agrupar es presentación pura, no hace falta tocar el informe
  // determinista para esto. Siempre para TODOS los bosses de la noche (ya
  // no solo con más de uno): con un solo boss, sigue siendo la única forma
  // de ver el detalle de sus defensivos.
  bossDetails = computed(() => {
    const full = this.fullReport()?.report;
    if (!full) return [];
    return full.summary.bosses.map((boss) => ({
      boss,
      key: `${boss.bossName}|${boss.difficulty}`,
      isProgressBoss: full.summary.progressBoss?.bossName === boss.bossName && full.summary.progressBoss?.difficulty === boss.difficulty,
      mechanics: full.mechanics.filter((m) => m.bossName === boss.bossName && m.difficulty === boss.difficulty),
      topFinalBlows: full.deaths.topFinalBlows.filter((d) => d.bossName === boss.bossName && d.difficulty === boss.difficulty),
      defensiveUsage: full.defensiveUsage.find((entry) => entry.bossName === boss.bossName && entry.difficulty === boss.difficulty) ?? null,
      interrupts: full.interrupts.progressBoss?.bossName === boss.bossName && full.interrupts.progressBoss?.difficulty === boss.difficulty ? full.interrupts.progressBoss : null,
      phases: full.phaseBreakdown?.bossName === boss.bossName && full.phaseBreakdown?.difficulty === boss.difficulty ? full.phaseBreakdown : null,
    }));
  });

  // §desplegables, colapsados por defecto salvo el boss de progress (el más
  // relevante) — un informe de varios bosses no debería abrir con todo
  // expandido a la vez, eso es justo el "caos" reportado.
  private expandedBossKeys = signal<Set<string>>(new Set());
  isBossExpanded(key: string): boolean {
    return this.expandedBossKeys().has(key);
  }
  toggleBoss(key: string): void {
    this.expandedBossKeys.update((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  formatOffset = formatOffset;

  // §"organizados así los defensivos no me entero de nada... solo saber
  // quien se tiró cual y cuando, pero organizados por quien, no me interesa
  // una lista infinita" (feedback real, 2026-08-27): la lista plana
  // agrupada solo por pull (una fila por cast individual, con Ignore Pain
  // repitiéndose 24 veces seguidas) no se podía escanear. Reagrupa por
  // jugador y, dentro de cada jugador, por hechizo — cada spell aparece UNA
  // vez con su cuenta y sus repeticiones como chips compactos "#pull m:ss",
  // en vez de una fila por cast.
  castsByPlayer(casts: NightFullReport['defensiveUsage'][number]['casts']): {
    playerName: string;
    totalCasts: number;
    spells: { spellName: string; wowheadSpellId: number | null; count: number; occurrences: { pullNumber: number; offsetMs: number }[] }[];
  }[] {
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
        const spellList = [...spells.values()]
          .map((spell) => ({ ...spell, count: spell.occurrences.length }))
          .sort((a, b) => b.count - a.count);
        return { playerName, totalCasts: spellList.reduce((sum, spell) => sum + spell.count, 0), spells: spellList };
      })
      .sort((a, b) => a.playerName.localeCompare(b.playerName));
  }

  // §"detallado por boss" enhancement: las barras de progreso pull-a-pull de
  // informe 1 (progressBars) no tenían equivalente en informe 2 (que solo
  // enseña el mejor resultado) — se injertan en boss-grid por bossName+difficulty,
  // mismo origen de nombre (report_encounters.boss_name) en los dos informes.
  private progressBarsByBossKey = computed(() => {
    const map = new Map<string, NightReport['bosses'][number]['progressBars']>();
    for (const b of this.data()?.bosses ?? []) map.set(`${b.bossName}|${b.difficulty}`, b.progressBars);
    return map;
  });
  progressBarsFor(bossName: string, difficulty: string): NightReport['bosses'][number]['progressBars'] | null {
    return this.progressBarsByBossKey().get(`${bossName}|${difficulty}`) ?? null;
  }

  // §bug real ya visto en varios sitios: leer un input() de ruta dentro del
  // constructor revienta con NG0950 — Angular lo asigna DESPUÉS de construir.
  constructor() {
    effect(() => {
      const code = this.reportCode();
      void this.load(code);
    });
    void this.loadRosterSnapshot();
  }

  private async load(code: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.fullReport.set(null);
    this.fullReportError.set(null);
    this.infographicOpen.set(false);
    this.expandedPlayerNames.set(new Set());
    try {
      this.data.set(await this.nightReportService.load(code));
    } catch (err) {
      this.error.set(errorMessage(err));
      this.loading.set(false);
      return;
    }
    // Independiente del resto (informe completo, brief IA): no bloquea
    // `loading` ni retrasa el resto de la pantalla — la tabla de asistencia
    // rellena "Ejecución de esta noche" en cuanto cada jugador resuelve.
    void this.loadNightAttendanceStats(code, this.attendingPlayers());
    // §evolución por boss+dificultad: keyed por boss (no por report), así
    // que si esta noche repite un boss+dificultad ya visto en otro report
    // de esta sesión, sale del Map en memoria sin volver a pedirlo.
    void this.prefetchBossEvolution();
    try {
      const existing = await this.nightReportService.loadFullReport(code);
      if (existing) this.applyFullReport(existing);
      else await this.generateFullReport(false); // §"informe 2 en lugar de informe 1": sin segundo clic, se genera solo si no había caché todavía.
    } catch (err) {
      this.fullReportError.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  async onGenerateBrief(): Promise<void> {
    const d = this.data();
    if (!d) return;
    this.generatingBrief.set(true);
    this.briefError.set(null);
    try {
      const res = await this.edgeFunctions.generateNightBrief(d.reportCode);
      this.data.set({ ...d, brief: mapBrief(res.brief) });
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
  }

  // §"ahí donde ahora también está el botón de actualizar (que deberíamos
  // mantener para actualizar el informe principal)" (feedback real): único
  // botón de regeneración que queda en la pantalla — fuerza recálculo
  // determinista, nunca gasta presupuesto de IA (el brief de arriba es aparte).
  async onUpdateFullReport(): Promise<void> {
    await this.generateFullReport(true);
  }

  // Recalcula las fuentes materializadas y TODOS sus consumidores. A
  // diferencia de "Actualizar", no se limita al informe determinista.
  recalculatingAll = signal(false);
  recalculateAllError = signal<string | null>(null);
  recalculateAllProgress = signal<{ done: number; total: number } | null>(null);

  async onRecalculateAll(): Promise<void> {
    if (this.recalculatingAll()) return;
    this.recalculatingAll.set(true);
    this.recalculateAllError.set(null);
    this.recalculateAllProgress.set(null);
    try {
      const code = this.reportCode();
      const pullIds = await this.nightReportService.listPullIds(code);
      const failures: string[] = [];
      let done = 0;
      this.recalculateAllProgress.set({ done, total: pullIds.length });

      // Cada pull es una invocación independiente: evita WORKER_RESOURCE_LIMIT
      // y, con un reintento, reduce el riesgo de dejar una noche a medias por
      // un fallo transitorio de red/WCL. Los fallos persistentes nunca se
      // silencian: se muestran al final.
      for (const pullId of pullIds) {
        for (const [label, operation] of [
          ['defensivos', () => this.edgeFunctions.reanalyzeDefensivePressure(pullId)],
          ['mecánicas', () => this.edgeFunctions.reanalyzeUnassignedMechanics(pullId)],
        ] as const) {
          let lastError: unknown = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await operation();
              lastError = null;
              break;
            } catch (err) {
              lastError = err;
            }
          }
          if (lastError != null) failures.push(`${pullId} · ${label}: ${errorMessage(lastError)}`);
        }
        done++;
        this.recalculateAllProgress.set({ done, total: pullIds.length });
      }

      // Invalida también el estado EN MEMORIA de la evolución: su Set de
      // "ya solicitado" impediría volver a entrar aunque el fingerprint
      // persistido hubiese cambiado.
      this.bossEvolutionRequested.clear();
      this.bossEvolution.set(new Map());

      await Promise.all([
        this.loadRosterSnapshot(true),
        this.loadNightAttendanceStats(code, this.attendingPlayers(), true),
        this.prefetchBossEvolution(true),
      ]);
      await this.generateFullReport(true);

      if (failures.length) {
        this.recalculateAllError.set(
          `El recálculo terminó con ${failures.length} operación(es) que siguieron fallando tras reintentar. Los datos visibles se han recargado desde el estado persistido actual, pero la noche no debe considerarse completamente reanalizada. ${failures.slice(0, 3).join(" | ")}${failures.length > 3 ? " …" : ""}`,
        );
      }
    } catch (err) {
      this.recalculateAllError.set(errorMessage(err));
    } finally {
      this.recalculatingAll.set(false);
    }
  }

  private async generateFullReport(force: boolean): Promise<void> {
    if (this.generatingFullReport()) return;
    this.generatingFullReport.set(true);
    this.fullReportError.set(null);
    try {
      const result = await this.edgeFunctions.generateNightFullReport(this.reportCode(), force);
      if (result.report.schemaVersion !== SCHEMA_VERSION) {
        throw new Error('La función generate-night-full-report desplegada está desactualizada. Hay que desplegar la versión local antes de generar el informe.');
      }
      this.applyFullReport({ report: result.report, generatedAt: result.generatedAt });
    } catch (err) {
      this.fullReportError.set(errorMessage(err));
    } finally {
      this.generatingFullReport.set(false);
    }
  }

  private applyFullReport(stored: StoredNightFullReport): void {
    this.fullReport.set(stored);
    // El boss de progress abre expandido (es el que de verdad interesa
    // revisar); si la noche está limpia y no hay boss de progress, se
    // expande el primero de la lista para que no aterrice todo colapsado.
    const progress = stored.report.summary.progressBoss;
    const defaultKey = progress
      ? `${progress.bossName}|${progress.difficulty}`
      : stored.report.summary.bosses[0]
        ? `${stored.report.summary.bosses[0].bossName}|${stored.report.summary.bosses[0].difficulty}`
        : null;
    this.expandedBossKeys.set(defaultKey ? new Set([defaultKey]) : new Set());
  }

  compactNumber(value: number | null): string {
    if (value == null) return '—';
    return new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  trendLabel(trend: NightReportTrend): string {
    return {
      improving: 'Mejora',
      worsening: 'Empeora',
      flat: 'Estable',
      insufficient_data: 'Muestra insuficiente',
    }[trend];
  }

  deltaLabel(value: number | null): string {
    if (value == null) return 'Sin dato comparable';
    return `${value > 0 ? '+' : ''}${formatPct(value)}`;
  }

  async copyDiscordSummary(): Promise<void> {
    const full = this.fullReport()?.report;
    if (!full) return;
    try {
      await navigator.clipboard.writeText(buildNightDiscordSummary(full, this.attendanceExtras()));
      this.setCopyStatus('discord');
    } catch {
      this.setCopyStatus('error');
    }
  }

  async copyFullMarkdown(): Promise<void> {
    const stored = this.fullReport();
    if (!stored) return;
    try {
      await navigator.clipboard.writeText(buildNightFullReportMarkdown(stored.report, stored.generatedAt, this.attendanceExtras()));
      this.setCopyStatus('full');
    } catch {
      this.setCopyStatus('error');
    }
  }

  async downloadFullReportPng(): Promise<void> {
    const source = this.reportRoot?.nativeElement;
    const report = this.fullReport()?.report;
    if (!source || !report || this.imageStatus() === 'rendering') return;
    this.imageStatus.set('rendering');

    const clone = source.cloneNode(true) as HTMLElement;
    clone.setAttribute('aria-hidden', 'true');
    clone.classList.add('report-export');
    clone.querySelector('.page-actions')?.remove();
    clone.querySelector('.limitations')?.remove();

    const width = Math.max(960, Math.round(source.getBoundingClientRect().width));
    Object.assign(clone.style, {
      position: 'fixed',
      inset: 'auto',
      left: '-20000px',
      top: '0',
      width: `${width}px`,
      maxHeight: 'none',
      height: 'auto',
      overflow: 'visible',
    });
    (source.parentElement ?? document.body).appendChild(clone);

    try {
      await document.fonts?.ready;
      await this.waitForImages(clone);
      const height = clone.scrollHeight;
      const pixelRatio = Math.max(1, Math.min(1.6, 14_000 / Math.max(1, height)));
      const blob = await toBlob(clone, {
        width,
        height,
        pixelRatio,
        backgroundColor: '#080810',
        cacheBust: true,
        skipFonts: true,
        style: { position: 'static', inset: 'auto', left: 'auto', top: 'auto', margin: '0', transform: 'none' },
      });
      if (!blob) throw new Error('No se pudo crear el PNG');
      this.downloadBlob(blob, `iris-informe-completo-${report.reportCode}.png`);
      this.setImageStatus('downloaded');
    } catch (error) {
      console.error('No se pudo exportar el informe completo', error);
      this.setImageStatus('error');
    } finally {
      clone.remove();
    }
  }

  private setCopyStatus(status: 'discord' | 'full' | 'error'): void {
    this.copyStatus.set(status);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copyStatus.set('idle'), 2_500);
  }

  private setImageStatus(status: 'downloaded' | 'error'): void {
    this.imageStatus.set(status);
    setTimeout(() => this.imageStatus.set('idle'), 3_000);
  }

  private async waitForImages(root: HTMLElement): Promise<void> {
    const images = Array.from(root.querySelectorAll('img'));
    await Promise.all(
      images.map(async (image) => {
        if (image.complete) return;
        try {
          await image.decode();
        } catch {
          // Un recurso externo que falle no debe bloquear el resto del informe.
        }
      }),
    );
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  // §"un boton arriba a la derecha que sea 'actualizar infografias', que
  // actualice TODAS las infografias de los miembros del roster [...] y otro
  // botón [...] para enviar TODAS las infografias individuales [...]
  // asegurando 100% que estan actualizadas [...] excluyendo obviamente
  // todos los que no han participado" (feedback real, 2026-08-29): SOLO
  // asistentes de ESTE report (Main+Trial) — nunca absentMain. "Actualizar"
  // reutiliza el MISMO mecanismo que ya usa el botón "Actualizar" de la
  // infografía individual (load(..., forceRefresh=true) — releer Supabase,
  // sin tocar WCL/IA, ver comentario junto a refreshInfographic en
  // night-player-dossier.component.ts) — barato, sin cuota de WCL de por
  // medio, seguro de correr sobre 20+ jugadores seguidos.
  private attendingPlayers(): NightAttendee[] {
    const d = this.data();
    return d ? [...d.attendingMain, ...d.attendingTrial] : [];
  }

  // §"más completa... quitar la columna de 'estado' (eso ya se puede ver en
  // la pestaña de roster)... columnas siempre visibles: el parse (WCL),
  // ejecución de esta noche, defensivos (el que ya enseña el dosier),
  // fiabilidad de la noche y fiabilidad a 60 días" (feedback real,
  // 2026-08-30): Fiabilidad-60-días reutiliza EXACTAMENTE lo que ya calcula
  // /roster — ReliabilityService.listPlayerReliability(), MISMA caché
  // (RosterSnapshotCacheService — si el RL ya visitó /roster esta sesión,
  // esto sale gratis) — nunca una fórmula paralela. Las otras 4 columnas
  // (parse/ejecución/defensivos/fiabilidad-de-la-noche) SÍ son específicas
  // de este report (nightScore/nightReliability/worldRankPercent no existen
  // fuera de NightPlayerSummaryService) — se cargan en paralelo por jugador
  // asistente, sin forceRefresh (cache-first, igual que abrir su dosier), y
  // se cachean aparte con fingerprint acotado a ESTE report (ver
  // loadNightAttendanceStats) — una noche cerrada no vuelve a tocar
  // Supabase para esto.
  readonly rosterPlayers = signal<PlayerReliability[]>([]);
  readonly rosterOffenders = signal<RepeatOffenderRow[]>([]);
  readonly nightAttendanceStats = signal<Map<string, CachedNightAttendanceStats>>(new Map());

  private rosterOverallByName = computed(() => new Map(this.rosterPlayers().map((p) => [p.playerName, p.overall])));

  attendanceRows = computed(() => {
    const d = this.data();
    if (!d) return [];
    const stats = this.nightAttendanceStats();
    const overallByName = this.rosterOverallByName();
    const build = (attendee: NightAttendee, isTrial: boolean) => ({
      ...attendee,
      isTrial,
      stats: stats.get(attendee.name) ?? null,
      reliability60d: overallByName.get(attendee.name) ?? null,
    });
    return [...d.attendingMain.map((p) => build(p, false)), ...d.attendingTrial.map((p) => build(p, true))];
  });

  // §"que las filas también fueran un desplegable... si pulso sobre el
  // nombre me lleva a su dosier, pero además dentro del desplegable hay un
  // botón con una flecha que diga 'ver dosier'" (feedback real, 2026-08-30):
  // mismo patrón desplegable/colapsado-por-defecto que expandedBossKeys de
  // arriba (boss-accordion) — el nombre sigue siendo un <a> normal (nunca
  // anidado dentro del botón de desplegar, dos elementos interactivos
  // distintos en la misma fila).
  private expandedPlayerNames = signal<Set<string>>(new Set());
  isPlayerExpanded(name: string): boolean {
    return this.expandedPlayerNames().has(name);
  }
  togglePlayer(name: string): void {
    this.expandedPlayerNames.update((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  private async loadRosterSnapshot(force = false): Promise<void> {
    const cached = force ? null : this.rosterSnapshotCache.read();
    if (cached) {
      this.rosterPlayers.set(cached.players);
      this.rosterOffenders.set(cached.offenders);
    }
    try {
      const fingerprint = await this.rosterSnapshotCache.fingerprint();
      if (!force && cached?.fingerprint === fingerprint) return;
      const [players, offenders] = await Promise.all([
        this.reliabilityService.listPlayerReliability(),
        this.offendersService.listRepeatOffenders().catch(() => []),
      ]);
      this.rosterPlayers.set(players);
      this.rosterOffenders.set(offenders);
      const snapshot: RosterSnapshot = { fingerprint, savedAt: new Date().toISOString(), players, offenders };
      this.rosterSnapshotCache.write(snapshot);
    } catch {
      // best-effort: el fallo de esta optimización nunca bloquea el informe.
    }
  }

  private async loadNightAttendanceStats(code: string, players: NightAttendee[], force = false): Promise<void> {
    if (!players.length) {
      this.nightAttendanceStats.set(new Map());
      return;
    }
    // §"una vez calculado para un informe debería cargarse al instante si no
    // se modifica ningún baremo ni nada de ese informe" (feedback real,
    // 2026-08-30): fingerprint acotado a ESTE report (ver
    // NightScoreCacheService) — a diferencia del caché de
    // NightPlayerSummaryService (fingerprint global, se invalida con
    // cualquier pull de cualquier noche), este solo se invalida si cambian
    // los pulls de este report concreto. Una vez la noche está cerrada, no
    // vuelve a tocar Supabase para esto nunca más.
    let fingerprint: string | null = null;
    if (!force) {
      try {
        fingerprint = await this.nightScoreCache.fingerprint(code);
        const cached = this.nightScoreCache.read(code);
        if (cached && cached.fingerprint === fingerprint) {
          this.nightAttendanceStats.set(new Map(Object.entries(cached.scores)));
          return;
        }
      } catch {
        // sigue al cálculo completo si el fingerprint ligero falla.
      }
    }
    const emptyStats: CachedNightAttendanceStats = { nightScore: null, nightReliability: null, nightDefensiva: null, nightParse: null };
    const entries = await Promise.all(
      players.map(async (p): Promise<[string, CachedNightAttendanceStats]> => {
        try {
          // includeEvolution=false: no hace falta la comparación con la
          // noche anterior (que recalcula TODO otra vez) solo para leer estas 4 columnas.
          const summary = await this.nightPlayerSummaryService.load(code, p.name, false, force);
          // §"el parse obtenido durante la noche (esto lo traemos de WCL)"
          // (feedback real, 2026-08-30): media del percentil de WCL sobre
          // los pulls de esta noche donde WCL pudo rankear al jugador
          // (ninja pulls fuera, igual que el resto de las estadísticas de
          // la noche) — ya viene en summary.pulls[].worldRankPercent, sin
          // query nueva.
          const parses = summary.pulls
            .filter((pull) => !pull.excludedFromStats && pull.worldRankPercent != null)
            .map((pull) => pull.worldRankPercent!);
          // §"el parse son numeros enteros normalmente" (feedback real,
          // 2026-08-30): WCL redondea sus percentiles a enteros — con más
          // de un kill esta noche, la media de dos enteros puede caer en
          // .5, pero nunca en la precisión decimal que salía antes
          // (redondeaba a 1 decimal en vez de a entero).
          const nightParse = parses.length ? Math.round(parses.reduce((sum, v) => sum + v, 0) / parses.length) : null;
          return [
            p.name,
            {
              nightScore: summary.nightScore,
              nightReliability: summary.nightReliability?.overall ?? null,
              nightDefensiva: summary.nightReliability?.breakdown.defensiva ?? null,
              nightParse,
            },
          ];
        } catch {
          return [p.name, emptyStats];
        }
      }),
    );
    this.nightAttendanceStats.set(new Map(entries));
    fingerprint ??= await this.nightScoreCache.fingerprint(code).catch(() => null);
    if (fingerprint) this.nightScoreCache.write(code, fingerprint, Object.fromEntries(entries));
  }

  // §"al desplegar cada fila habrá una comparación (OJO: con la misma
  // dificultad) de su evolución... con otros logs comparables por
  // dificultad y boss de esa misma dificultad... heroico con heroico y
  // mítico con mítico" (feedback real, 2026-08-30): UN fetch por
  // boss+dificultad de ESTA noche (nunca por jugador — la misma llamada ya
  // trae a TODOS los asistentes de una vez, ver
  // ReliabilityService.getBossDifficultyEvolution), precargado en paralelo
  // al entrar (no hace falta esperar a que se despliegue una fila — con 1-3
  // bosses por noche es barato, y así el desplegable abre ya con datos).
  // Cacheado aparte (NightBossEvolutionCacheService) porque depende de TODO
  // el historial de ese boss+dificultad, no solo de este report — mismo
  // fingerprint que ya usa /roster, reutilizado tal cual.
  readonly bossEvolution = signal<Map<string, Map<string, BossDifficultyEvolutionPoint[]>>>(new Map());
  private bossEvolutionRequested = new Set<string>();

  // §todos los boss+dificultad de la noche (data().bosses trae bossId real
  // — bossDetails()/full report solo trae bossName, no sirve para esto),
  // deduplicados: la evolución se enseña igual para todos los jugadores que
  // desplieguen su fila esta noche, no hace falta filtrar por quién asistió
  // a qué boss concreto.
  tonightBossKeys = computed(() => {
    const d = this.data();
    if (!d) return [];
    const seen = new Set<string>();
    const out: { bossId: string; bossName: string; difficulty: string; key: string }[] = [];
    for (const b of d.bosses) {
      const key = `${b.bossId}|${b.difficulty}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ bossId: b.bossId, bossName: b.bossName, difficulty: b.difficulty, key });
    }
    return out;
  });

  private async prefetchBossEvolution(force = false): Promise<void> {
    await Promise.all(this.tonightBossKeys().map((b) => this.loadBossEvolution(b.bossId, b.difficulty, b.key, force)));
  }

  private async loadBossEvolution(bossId: string, difficulty: string, key: string, force = false): Promise<void> {
    if (!force && this.bossEvolutionRequested.has(key)) return;
    this.bossEvolutionRequested.add(key);
    try {
      const fingerprint = await this.bossEvolutionCache.fingerprint();
      const cached = force ? null : this.bossEvolutionCache.read(bossId, difficulty);
      if (!force && cached && cached.fingerprint === fingerprint) {
        this.bossEvolution.update((current) => new Map(current).set(key, new Map(Object.entries(cached.points))));
        return;
      }
      const points = await this.reliabilityService.getBossDifficultyEvolution(bossId, difficulty);
      this.bossEvolution.update((current) => new Map(current).set(key, points));
      this.bossEvolutionCache.write(bossId, difficulty, fingerprint, Object.fromEntries(points));
    } catch {
      // best-effort: sin evolución cacheable, el desplegable simplemente no la enseña — nunca bloquea el resto de la fila.
      this.bossEvolutionRequested.delete(key);
    }
  }

  // §"esto es poco visual, porque además no sé ni qué estoy comparando...
  // algo más visual y sabiendo lo que se compara" (feedback real,
  // 2026-08-30): antes reutilizaba app-trend-bars (pensado para % de vida
  // del boss por intento, una escala y un significado distintos) sin decir
  // en ningún sitio visible qué número era ese ni contra qué se comparaba
  // cada barra — solo salía en el tooltip, así que había que pasar el ratón
  // por cada barra para enterarte. Ahora es un mini-gráfico propio: el
  // valor (Fiabilidad, mismo eje que la columna "Fiabilidad — noche" de la
  // cabecera — misma fórmula, solo que UNA noche por barra en vez de
  // "esta noche") va SIEMPRE visible encima de cada barra, con el
  // resultado (kill/wipe) debajo — el tooltip solo añade el desglose
  // (defensiva/parse) para quien quiera verificar.
  evolutionPointsFor(
    playerName: string,
    bossKey: string,
    reportCode: string,
  ): {
    reportCode: string;
    dateLabel: string;
    overall: number;
    isCurrent: boolean;
    resultLabel: string;
    resultIsKill: boolean;
    tooltip: string;
  }[] {
    const points = this.bossEvolution().get(bossKey)?.get(playerName) ?? [];
    return points.map((p) => ({
      reportCode: p.reportCode,
      dateLabel: new Date(p.closedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }),
      overall: p.overall,
      isCurrent: p.reportCode === reportCode,
      resultLabel: p.kill ? 'kill' : p.bestWipePct != null ? `${formatPct(p.bestWipePct)} vida` : 'wipe',
      resultIsKill: p.kill,
      tooltip:
        `${p.reportTitle ?? p.reportCode} — Fiabilidad ${p.overall}` +
        (p.breakdown.defensiva != null ? ` · defensiva ${p.breakdown.defensiva}%` : '') +
        (p.parseAvg != null ? ` · parse ${formatPct(p.parseAvg, 0)}` : ''),
    }));
  }

  readonly bulkUpdating = signal(false);
  readonly bulkUpdateProgress = signal<{ done: number; total: number } | null>(null);
  readonly bulkUpdateResult = signal<{ done: number; failed: string[] } | null>(null);

  async updateAllInfographics(): Promise<void> {
    const players = this.attendingPlayers();
    if (!players.length || this.bulkUpdating()) return;
    this.bulkUpdating.set(true);
    this.bulkUpdateResult.set(null);
    const failed: string[] = [];
    this.bulkUpdateProgress.set({ done: 0, total: players.length });
    for (const [index, player] of players.entries()) {
      try {
        await this.nightPlayerSummaryService.load(this.reportCode(), player.name, true, true);
      } catch {
        failed.push(player.name);
      }
      this.bulkUpdateProgress.set({ done: index + 1, total: players.length });
    }
    this.bulkUpdating.set(false);
    this.bulkUpdateProgress.set(null);
    this.bulkUpdateResult.set({ done: players.length - failed.length, failed });
  }

  // §"otro botón que tenga alguna clase de confirmacion" (feedback real,
  // 2026-08-29): mismo patrón de doble clic (armar → confirmar en 5s, o se
  // desarma solo) que ya usa discord-settings.component.ts para desvincular
  // — acción que manda mensajes reales a gente real, no dispara con un
  // único clic accidental.
  readonly bulkSendConfirming = signal(false);
  private bulkSendConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  onRequestSendAllInfographics(): void {
    if (this.bulkSendConfirming()) {
      void this.sendAllInfographics();
      return;
    }
    this.bulkSendConfirming.set(true);
    if (this.bulkSendConfirmTimer) clearTimeout(this.bulkSendConfirmTimer);
    this.bulkSendConfirmTimer = setTimeout(() => this.bulkSendConfirming.set(false), 5_000);
  }

  readonly bulkSending = signal(false);
  readonly bulkSendProgress = signal<{ done: number; total: number; current: string | null } | null>(null);
  readonly bulkSendResult = signal<{ sent: string[]; skippedNoChannel: string[]; failed: { name: string; error: string }[] } | null>(null);

  // §"asegurando 100% que estan actualizadas [...] es importante que esten
  // actualizadas a la noche en cuestion cuyo informe tenemos abierto"
  // (feedback real, 2026-08-29): cada envío recarga su propio resumen con
  // forceRefresh=true AQUÍ MISMO, nunca confía en que "Actualizar" se haya
  // pulsado antes — el botón de arriba es una comodidad para previsualizar,
  // no un requisito. Crea la MISMA app-night-player-infographic que ya usa
  // el dosier individual (headless=true, ver ese componente) para reutilizar
  // tal cual su pipeline de render+compresión+envío ya probado, en vez de
  // duplicarlo — una instancia a la vez, nunca en paralelo (ver
  // discord-roster-channels/index.ts: incluso llamadas ligeras a la API de
  // Discord ya han chocado con su rate limit en bloque; aquí cada iteración
  // ya hace un render de imagen pesado de por sí, la pausa extra es margen,
  // no la única defensa — send-discord-message reintenta con backoff si
  // aun así llega un 429 real).
  private async sendAllInfographics(): Promise<void> {
    this.bulkSendConfirming.set(false);
    if (this.bulkSendConfirmTimer) clearTimeout(this.bulkSendConfirmTimer);
    const players = this.attendingPlayers();
    if (!players.length || this.bulkSending()) return;
    this.bulkSending.set(true);
    this.bulkSendResult.set(null);
    const sent: string[] = [];
    const skippedNoChannel: string[] = [];
    const failed: { name: string; error: string }[] = [];

    for (const [index, player] of players.entries()) {
      this.bulkSendProgress.set({ done: index, total: players.length, current: player.name });
      try {
        const summary = await this.nightPlayerSummaryService.load(this.reportCode(), player.name, true, true);
        if (!summary.discordChannel?.discordChannelId) {
          skippedNoChannel.push(player.name);
          continue;
        }
        const componentRef = this.viewContainerRef.createComponent(NightPlayerInfographicComponent);
        try {
          componentRef.setInput('summary', summary);
          componentRef.setInput('headless', true);
          componentRef.changeDetectorRef.detectChanges();
          await componentRef.instance.sendToDiscord();
          if (componentRef.instance.exportStatus() === 'sentDiscord') sent.push(player.name);
          else failed.push({ name: player.name, error: componentRef.instance.exportError() ?? 'Fallo desconocido al enviar.' });
        } finally {
          componentRef.destroy();
        }
      } catch (err) {
        failed.push({ name: player.name, error: errorMessage(err) });
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    this.bulkSending.set(false);
    this.bulkSendProgress.set(null);
    this.bulkSendResult.set({ sent, skippedNoChannel, failed });
  }
}
