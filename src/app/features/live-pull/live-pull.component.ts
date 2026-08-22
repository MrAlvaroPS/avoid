// Colocar en: src/app/features/live-pull/live-pull.component.ts
// <app-live-pull>: contenedor, resuelve el Pull + diff + callouts (§15.1 árbol de componentes).
import { Component, effect, inject, input, signal } from '@angular/core';
import { PullAnalysisService, type PullDetail } from '../../core/pull-analysis.service';
import { PullHeaderComponent } from './pull-header.component';
import { MetricsRowComponent } from './metrics-row.component';
import { RaidDamageChartComponent } from '../../shared/charts/raid-damage-chart.component';
import { CoachingCalloutListComponent } from './coaching-callout-list.component';
import { LlmAnalysisCardComponent } from './llm-analysis-card.component';
import { PlayerStatsTableComponent } from './player-stats-table.component';
import { ProvenanceDrawerComponent } from './provenance-drawer.component';
import { DonutChartComponent, type DonutSegment } from '../../shared/charts/donut-chart.component';
import { TrendBarsComponent } from '../../shared/charts/trend-bars.component';
import type { CoachingCallout, ProvenanceEntry, TimelineChip } from '../../shared/models/ui';

@Component({
  selector: 'app-live-pull',
  standalone: true,
  imports: [
    PullHeaderComponent,
    MetricsRowComponent,
    RaidDamageChartComponent,
    CoachingCalloutListComponent,
    LlmAnalysisCardComponent,
    PlayerStatsTableComponent,
    ProvenanceDrawerComponent,
    DonutChartComponent,
    TrendBarsComponent,
  ],
  templateUrl: './live-pull.component.html',
  styleUrl: './live-pull.component.scss',
})
export class LivePullComponent {
  private pullAnalysis = inject(PullAnalysisService);

  pullId = input.required<string>();

  detail = signal<PullDetail | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);
  generatingBrief = signal(false);
  // Separado de `error` a propósito (bug real encontrado el 2026-08-22): si
  // reutilizaba `error`, un fallo al pedir el análisis IA (ej. sin
  // ANTHROPIC_API_KEY configurada) borraba TODA la pantalla del pull ya
  // cargado — cabecera, métricas, timeline, todo — para enseñar solo el
  // error. Ahora el fallo se queda contenido junto al botón "Analizar".
  briefError = signal<string | null>(null);
  activeProvenance = signal<ProvenanceEntry | null>(null);

  constructor() {
    effect(() => {
      const id = this.pullId();
      void this.load(id);
    });
  }

  async load(id: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const detail = await this.pullAnalysis.loadPullDetail(id);
      this.detail.set(detail);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  async onGenerateBrief(): Promise<void> {
    const current = this.detail();
    if (!current) return;
    this.generatingBrief.set(true);
    this.briefError.set(null);
    try {
      const brief = await this.pullAnalysis.generateBrief(current.pullId);
      this.detail.set({ ...current, brief });
    } catch (err) {
      this.briefError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.generatingBrief.set(false);
    }
  }

  onTimelineChipSelected(chip: TimelineChip): void {
    if (chip.provenance) this.activeProvenance.set(chip.provenance);
  }

  /** §"los roscos deberían tener alguna opción para ver más detalles" — reusa el mismo drawer de provenance que ya usan métricas/timeline/callouts, no un mecanismo de UI nuevo. */
  onDonutSegmentSelected(segment: DonutSegment, source: string): void {
    this.activeProvenance.set({
      source,
      method: `${segment.label}: ${segment.value}.`,
      detail: segment.detailLines?.length ? segment.detailLines.join('\n') : 'Sin desglose adicional para este segmento.',
    });
  }

  onCalloutSelected(callout: CoachingCallout): void {
    this.activeProvenance.set(callout.provenance);
  }
}
