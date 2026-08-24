// Colocar en: src/app/features/night-report/night-report.component.ts
// §"echo de menos un informe... a nivel de raid también" (feedback real).
// Ruta /report/:reportCode — toda la agregación vive en
// night-report.service.ts, este componente solo pinta.
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NightReportService, type NightReport } from '../../core/night-report.service';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { mapBrief } from '../../core/pull-analysis.service';
import { formatDuration, formatPct } from '../../shared/format.util';
import { TrendBarsComponent } from '../../shared/charts/trend-bars.component';
import { DonutChartComponent } from '../../shared/charts/donut-chart.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { EmptyPanelComponent } from '../../shared/empty-panel.component';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import { LlmAnalysisCardComponent } from '../live-pull/llm-analysis-card.component';
import { EMPTY_BRIEF_ENTITIES, type BriefEntities } from '../../shared/brief-text.component';
import type { LlmPullAnalysis } from '../../shared/models/ui';

@Component({
  selector: 'app-night-report',
  standalone: true,
  imports: [DatePipe, RouterLink, TrendBarsComponent, DonutChartComponent, WowheadLinkComponent, EmptyPanelComponent, MechanicInfoIconComponent, LlmAnalysisCardComponent],
  templateUrl: './night-report.component.html',
  styleUrl: './night-report.component.scss',
})
export class NightReportComponent {
  private nightReportService = inject(NightReportService);
  private edgeFunctions = inject(EdgeFunctionsService);

  reportCode = input.required<string>();

  data = signal<NightReport | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);
  copyStatus = signal<'idle' | 'copied' | 'error'>('idle');

  formatDuration = formatDuration;
  formatPct = formatPct;

  // §"en el resumen de noche otra consulta IA con informe completo" (feedback real).
  generatingBrief = signal(false);
  briefError = signal<string | null>(null);

  briefEntities = computed<BriefEntities>(() => {
    const d = this.data();
    if (!d) return EMPTY_BRIEF_ENTITIES;
    const mechanics = new Map<string, { spellId: number | null; note: string | null }>();
    for (const c of d.topDeathCauses) mechanics.set(c.mechanicName, { spellId: c.wowheadSpellId, note: c.aiNote });
    return { players: d.playerClasses, mechanics };
  });

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
    try {
      this.data.set(await this.nightReportService.load(code));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
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
      this.briefError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.generatingBrief.set(false);
    }
  }

  onManualBriefSaved(brief: LlmPullAnalysis): void {
    const d = this.data();
    if (!d) return;
    this.data.set({ ...d, brief });
  }

  async copyReport(): Promise<void> {
    const d = this.data();
    if (!d) return;
    const dateLabel = d.reportDate ? new Date(d.reportDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' }) : d.reportTitle;
    const lines = [
      `📋 Informe de raid — ${dateLabel}`,
      `Bosses: ${d.bosses.length} · Kills: ${d.totalKills} · Wipes: ${d.totalWipes} · Tiempo en pulls: ${this.formatDuration(d.totalDurationMs)}`,
      `Asistencia: ${d.attendingMain.length} Main${d.attendingTrial.length ? ` + ${d.attendingTrial.length} Trial` : ''}${d.absentMain.length ? ` · Ausentes: ${d.absentMain.join(', ')}` : ''}`,
      '',
      'Por boss:',
      ...d.bosses.map((b) => `- ${b.bossName} (${b.difficulty}): ${b.attempts} intento${b.attempts === 1 ? '' : 's'}${b.kills ? `, ${b.kills} kill${b.kills === 1 ? '' : 's'}` : `, mejor ${this.formatPct(100 - (b.bestWipePct ?? 100))} de progreso`}`),
    ];
    if (d.wipeCallPulls.length) {
      lines.push('', '🏳️ Wipe calls detectados:');
      lines.push(...d.wipeCallPulls.map((w) => `- ${w.bossName} #${w.pullNumber} (${w.confidence}% confianza)`));
    }
    if (d.topOffenders.length) {
      lines.push('', '⚠️ Muertes repetidas esta noche:');
      lines.push(...d.topOffenders.map((o) => `- ${o.playerName}: ${o.deathCount} muertes`));
    }
    if (d.topDeathCauses.length) {
      lines.push('', '💀 Causas de muerte más repetidas:');
      lines.push(...d.topDeathCauses.slice(0, 5).map((c) => `- ${c.mechanicName}: ${c.deathCount} muertes (${c.distinctPlayers} jugadores distintos)`));
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n').trim());
      this.copyStatus.set('copied');
      setTimeout(() => this.copyStatus.set('idle'), 2000);
    } catch {
      this.copyStatus.set('error');
      setTimeout(() => this.copyStatus.set('idle'), 2000);
    }
  }
}
