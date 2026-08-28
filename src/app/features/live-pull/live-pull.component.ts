// Colocar en: src/app/features/live-pull/live-pull.component.ts
// <app-live-pull>: contenedor, resuelve el Pull + diff + callouts (§15.1 árbol de componentes).
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { PullAnalysisService, type PullDetail } from '../../core/pull-analysis.service';
import { PullHeaderComponent } from './pull-header.component';
import { MetricsRowComponent } from './metrics-row.component';
import { MechanicSwimlaneComponent } from '../../shared/charts/mechanic-swimlane.component';
import { CoachingCalloutListComponent } from './coaching-callout-list.component';
import { LlmAnalysisCardComponent } from './llm-analysis-card.component';
import { WipeCallBannerComponent } from './wipe-call-banner.component';
import { NinjaPullBannerComponent } from './ninja-pull-banner.component';
import { PlayerStatsTableComponent } from './player-stats-table.component';
import { ProvenanceDrawerComponent } from './provenance-drawer.component';
import { DonutChartComponent, type DonutSegment } from '../../shared/charts/donut-chart.component';
import { TrendBarsComponent } from '../../shared/charts/trend-bars.component';
import { CompareBarRowComponent } from './compare-bar-row.component';
import { EMPTY_BRIEF_ENTITIES, type BriefEntities } from '../../shared/brief-text.component';
import type { LlmPullAnalysis, ProvenanceEntry, TimelineChip } from '../../shared/models/ui';
import { errorMessage } from '../../shared/error-message.util';

@Component({
  selector: 'app-live-pull',
  standalone: true,
  imports: [
    PullHeaderComponent,
    MetricsRowComponent,
    MechanicSwimlaneComponent,
    CoachingCalloutListComponent,
    LlmAnalysisCardComponent,
    WipeCallBannerComponent,
    NinjaPullBannerComponent,
    PlayerStatsTableComponent,
    ProvenanceDrawerComponent,
    DonutChartComponent,
    TrendBarsComponent,
    CompareBarRowComponent,
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
  detailPanel = signal<'ai' | 'players' | 'timeline' | 'data' | null>(null);
  // Separado de `error` a propósito (bug real encontrado el 2026-08-22): si
  // reutilizaba `error`, un fallo al pedir el análisis IA (ej. sin
  // ANTHROPIC_API_KEY configurada) borraba TODA la pantalla del pull ya
  // cargado — cabecera, métricas, timeline, todo — para enseñar solo el
  // error. Ahora el fallo se queda contenido junto al botón "Analizar".
  briefError = signal<string | null>(null);
  activeProvenance = signal<ProvenanceEntry | null>(null);

  // §"pintar cada jugador de su clase, mecánicas con tooltip+nota" (feedback
  // real): entidades de ESTE pull para app-brief-text — sacadas de las
  // filas que ya se calculan para "a quién dirigir" (callouts +
  // mechanicFails), nada que pedir aparte.
  briefEntities = computed<BriefEntities>(() => {
    const d = this.detail();
    if (!d) return EMPTY_BRIEF_ENTITIES;
    const players = new Map<string, string>();
    const mechanics = new Map<string, { spellId: number | null; note: string | null }>();
    for (const c of d.callouts) {
      if (c.raiderClass) players.set(c.raiderName, c.raiderClass);
      mechanics.set(c.mechanic.label, { spellId: c.mechanic.wowheadSpellId, note: c.notes });
    }
    for (const m of d.mechanicFails) {
      if (m.raiderClass) players.set(m.raiderName, m.raiderClass);
      mechanics.set(m.mechanic.label, { spellId: m.mechanic.wowheadSpellId, note: m.notes });
    }
    return { players, mechanics };
  });

  // §bug real (2026-08-23): sin esto, cambiar de pull rápido (el
  // auto-seleccionado al cargar el report + el que elige el usuario a
  // continuación, o dos clics seguidos entre pulls) podía dejar la pantalla
  // mostrando datos de OTRO pull — la petición del pull viejo, si tardaba
  // más en responder, llegaba DESPUÉS y sobrescribía en silencio la del
  // pull correcto ya mostrado. Se guarda qué pullId es el más reciente
  // PEDIDO y solo se aplica una respuesta si sigue siendo esa cuando llega.
  private latestRequestedPullId: string | null = null;

  constructor() {
    effect(() => {
      const id = this.pullId();
      void this.load(id);
    });
  }

  async load(id: string): Promise<void> {
    this.latestRequestedPullId = id;
    this.loading.set(true);
    this.error.set(null);
    try {
      const detail = await this.pullAnalysis.loadPullDetail(id);
      if (this.latestRequestedPullId !== id) return; // llegó tarde, ya no es la selección vigente
      this.detail.set(detail);
    } catch (err) {
      if (this.latestRequestedPullId !== id) return;
      this.error.set(errorMessage(err));
    } finally {
      if (this.latestRequestedPullId === id) this.loading.set(false);
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
      this.briefError.set(errorMessage(err));
    } finally {
      this.generatingBrief.set(false);
    }
  }

  onTimelineChipSelected(chip: TimelineChip): void {
    if (chip.provenance) this.activeProvenance.set(chip.provenance);
  }

  /** §"pegar el resultado... procesarlo como si fuese a través de la API": manual-pull-brief ya guardó el brief — esto solo refresca la vista con lo guardado, sin recargar todo el pull. */
  onManualBriefSaved(brief: LlmPullAnalysis): void {
    const current = this.detail();
    if (!current) return;
    this.detail.set({ ...current, brief });
  }

  /** §"que autoexcluya pero que permita también editarlo... para restaurar": el toggle de wipe call cambia demasiados cálculos derivados (deaths, mechFails, racha, defensivos) como para parchearlos a mano — recarga el pull entero desde la BD, ya recalculado. */
  onWipeCallStatusChanged(): void {
    void this.load(this.pullId());
  }

  /** §"un ninja pull... habría que clasificarlo de otra manera": mismo motivo que onWipeCallStatusChanged — la exclusión afecta a fiabilidad/histórico de boss/informe de noche, recarga el pull entero ya recalculado. */
  onNinjaPullStatusChanged(): void {
    void this.load(this.pullId());
  }

  /** §"los roscos deberían tener alguna opción para ver más detalles" — reusa el mismo drawer de provenance que ya usan métricas/timeline/callouts, no un mecanismo de UI nuevo. */
  onDonutSegmentSelected(segment: DonutSegment, source: string): void {
    this.activeProvenance.set({
      source,
      method: `${segment.label}: ${segment.value}.`,
      detail: segment.detailLines?.length ? segment.detailLines.join('\n') : 'Sin desglose adicional para este segmento.',
    });
  }

  toggleDetailPanel(panel: 'ai' | 'players' | 'timeline' | 'data'): void {
    this.detailPanel.update((current) => (current === panel ? null : panel));
  }
}
