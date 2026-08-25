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
import { NightFullReportModalComponent } from './night-full-report-modal.component';
import { EMPTY_BRIEF_ENTITIES, type BriefEntities } from '../../shared/brief-text.component';
import type { LlmPullAnalysis } from '../../shared/models/ui';
import type { StoredNightFullReport } from '../../shared/models/night-full-report';

@Component({
  selector: 'app-night-report',
  standalone: true,
  imports: [DatePipe, RouterLink, TrendBarsComponent, DonutChartComponent, WowheadLinkComponent, EmptyPanelComponent, MechanicInfoIconComponent, LlmAnalysisCardComponent, NightFullReportModalComponent],
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
  fullReport = signal<StoredNightFullReport | null>(null);
  fullReportOpen = signal(false);
  generatingFullReport = signal(false);
  fullReportError = signal<string | null>(null);

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
    this.fullReport.set(null);
    this.fullReportOpen.set(false);
    this.fullReportError.set(null);
    try {
      this.data.set(await this.nightReportService.load(code));
      try {
        this.fullReport.set(await this.nightReportService.loadFullReport(code));
      } catch (err) {
        this.fullReportError.set(err instanceof Error ? err.message : String(err));
      }
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

  async onFullReportPrimaryAction(): Promise<void> {
    if (this.fullReport()) {
      this.fullReportOpen.set(true);
      return;
    }
    await this.generateFullReport(false);
  }

  async onUpdateFullReport(): Promise<void> {
    await this.generateFullReport(true);
  }

  private async generateFullReport(force: boolean): Promise<void> {
    if (this.generatingFullReport()) return;
    this.generatingFullReport.set(true);
    this.fullReportError.set(null);
    try {
      const result = await this.edgeFunctions.generateNightFullReport(this.reportCode(), force);
      if (result.report.schemaVersion !== 6) {
        throw new Error('La función generate-night-full-report desplegada está desactualizada. Hay que desplegar la versión local antes de generar el informe.');
      }
      this.fullReport.set({ report: result.report, generatedAt: result.generatedAt });
      this.fullReportOpen.set(true);
    } catch (err) {
      this.fullReportError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.generatingFullReport.set(false);
    }
  }
}
