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
import { Component, computed, effect, inject, input, signal, ElementRef, ViewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { toBlob } from 'html-to-image';
import { NightReportService, type NightReport } from '../../core/night-report.service';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { mapBrief } from '../../core/pull-analysis.service';
import { comparisonLabel, formatDuration, formatPct } from '../../shared/format.util';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { TrendBarsComponent } from '../../shared/charts/trend-bars.component';
import { LlmAnalysisCardComponent } from '../live-pull/llm-analysis-card.component';
import { NightReportInfographicComponent } from './night-report-infographic.component';
import { EMPTY_BRIEF_ENTITIES, type BriefEntities } from '../../shared/brief-text.component';
import type { LlmPullAnalysis } from '../../shared/models/ui';
import type { NightFullReport, NightReportTrend, StoredNightFullReport } from '../../shared/models/night-full-report';
import { bilingualName, buildNightDiscordSummary, buildNightFullReportMarkdown, formatOffset, type NightReportAttendanceExtras } from './night-full-report-markdown';
import { errorMessage } from '../../shared/error-message.util';

const SCHEMA_VERSION = 15;

@Component({
  selector: 'app-night-report',
  standalone: true,
  imports: [DatePipe, RouterLink, WowheadLinkComponent, TrendBarsComponent, LlmAnalysisCardComponent, NightReportInfographicComponent],
  templateUrl: './night-report.component.html',
  styleUrl: './night-report.component.scss',
})
export class NightReportComponent {
  private nightReportService = inject(NightReportService);
  private edgeFunctions = inject(EdgeFunctionsService);

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
    return d ? { attendingMain: d.attendingMain, attendingTrial: d.attendingTrial, absentMain: d.absentMain } : undefined;
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
  }

  private async load(code: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.fullReport.set(null);
    this.fullReportError.set(null);
    this.infographicOpen.set(false);
    try {
      this.data.set(await this.nightReportService.load(code));
    } catch (err) {
      this.error.set(errorMessage(err));
      this.loading.set(false);
      return;
    }
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
}
