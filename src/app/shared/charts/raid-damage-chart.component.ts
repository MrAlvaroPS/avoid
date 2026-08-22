// Colocar en: src/app/shared/charts/raid-damage-chart.component.ts
// Sustituye a mechanic-timeline.component.ts (feedback real y repetido: "el
// timeline de habilidades y eventos que has reconstruido es horrible, hay
// que rehacerlo de cero con algo real y útil" / "no me gusta cómo se
// presentan las mecánicas del boss en una especie de timeline infinito de
// scroll"). En vez de una tira de chips de texto que se lee de izquierda a
// derecha haciendo scroll, esto es una gráfica real de daño recibido por
// la raid (WCL graph(dataType:DamageTaken), ver pulls.raid_damage_taken_series)
// con las mecánicas superpuestas como marcadores en su instante real —
// mismo dato, cero funcionalidad perdida (tooltip de Wowhead, categoría,
// clic a procedencia), pero ahora se lee espacialmente: los picos de daño y
// los fallos en rojo se ven agrupados en el tiempo de un vistazo, sin
// desplazar nada.
import { Component, computed, input, output, signal } from '@angular/core';
import type { TimelineChip } from '../models/ui';
import type { BackgroundMechanicSummary } from '../../core/pull-analysis.service';
import { formatTimeLabel, mechanicCategoryMeta } from '../format.util';

export interface RaidDamagePoint {
  pointIntervalMs: number;
  points: number[];
}

// Sistema de coordenadas interno del SVG — el wrapper HTML tiene
// aspect-ratio: VIEW_W / VIEW_H fijado por CSS, así que un % sobre el
// wrapper (usado por los marcadores/tooltips en HTML, fuera del SVG) cae
// exactamente en el mismo punto que la unidad de viewBox equivalente: no
// hace falta leer getBoundingClientRect() del propio <svg> para conciliar
// dos sistemas de coordenadas distintos.
const VIEW_W = 1000;
const VIEW_H = 280;
const PLOT_TOP = 58;
const PLOT_BOTTOM = 214;
const PLOT_H = PLOT_BOTTOM - PLOT_TOP;
const LANE_TOP = 8;
const LANE_ROW_H = 8.5;
const LANE_MAX_ROWS = 6;

const TICK_STEPS_MS = [5_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000, 600_000, 900_000];

function buildTicks(durationMs: number): number[] {
  const step = TICK_STEPS_MS.find((s) => durationMs / s <= 7) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += step) ticks.push(t);
  return ticks;
}

function fullNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

interface PlotGeometry {
  durationMs: number;
  hasSeries: boolean;
  areaPath: string;
  linePath: string;
  peak: { leftPct: number; topPct: number; label: string } | null;
  ticks: { leftPct: number; label: string }[];
}

interface PositionedMarker {
  chip: TimelineChip;
  leftPct: number;
  topPct: number;
  /** Solo en el marcador sintético "+N" de una columna con más de LANE_MAX_ROWS eventos casi simultáneos — el resto de eventos que representa, para no perderlos. */
  overflow?: TimelineChip[];
}

interface CrosshairInfo {
  leftPct: number;
  topPct: number;
  timeLabel: string;
  valueLabel: string;
  flip: boolean;
}

@Component({
  selector: 'app-raid-damage-chart',
  standalone: true,
  template: `
    @if (loading()) {
      <div class="skeleton-strip" aria-hidden="true"></div>
      <span class="sr-only">Calculando la línea temporal…</span>
    } @else if (plot(); as p) {
      <div class="legend" aria-hidden="true">
        <span class="legend-item"><i class="dot tone-clean"></i>Limpia</span>
        <span class="legend-item"><i class="dot tone-partial"></i>Aviso</span>
        <span class="legend-item"><i class="dot tone-fail"></i>Fallo</span>
      </div>

      <div class="plot-wrap" #plotWrap (mousemove)="onPlotMove($event, plotWrap)" (mouseleave)="onPlotLeave()">
        <svg [attr.viewBox]="'0 0 ' + VIEW_W + ' ' + VIEW_H" class="plot-svg" role="img" [attr.aria-label]="ariaLabel()" preserveAspectRatio="none">
          <!-- líneas de referencia recesivas (dataviz: grid/axes discretos) -->
          <line class="grid-line" [attr.x1]="0" [attr.x2]="VIEW_W" [attr.y1]="PLOT_TOP" [attr.y2]="PLOT_TOP" />
          <line class="grid-line" [attr.x1]="0" [attr.x2]="VIEW_W" [attr.y1]="(PLOT_TOP + PLOT_BOTTOM) / 2" [attr.y2]="(PLOT_TOP + PLOT_BOTTOM) / 2" />
          <line class="axis-line" [attr.x1]="0" [attr.x2]="VIEW_W" [attr.y1]="PLOT_BOTTOM" [attr.y2]="PLOT_BOTTOM" />

          @if (p.hasSeries) {
            <path class="area" [attr.d]="p.areaPath" />
            <path class="line" [attr.d]="p.linePath" />
          }
        </svg>

        @if (!p.hasSeries) {
          <p class="no-series-note">WCL no devolvió la curva de daño de este pull (best-effort) — se muestran solo las mecánicas.</p>
        }

        @if (p.peak; as peak) {
          <div class="peak-label" [style.left.%]="peak.leftPct" [style.top.%]="peak.topPct">{{ peak.label }}</div>
        }

        <!-- Marcadores de mecánica: el <a> ES el punto de Wowhead real cuando
             hay spellId (mismo motivo verificado en real que en el chip
             antiguo — el script de Wowhead solo engancha su listener a
             elementos <a> reales, no a <span>/<button>). El clic abre además
             el tooltip propio con el desglose completo y un botón a
             procedencia, así que el <a> no necesita hacer dos cosas a la vez. -->
        @for (m of positionedMarkers(); track m.leftPct + '|' + m.topPct + '|' + m.chip.description) {
          @if (m.chip.wowheadSpellId && !m.overflow) {
            <a
              class="marker"
              [style.left.%]="m.leftPct"
              [style.top.%]="m.topPct"
              [style.background]="toneColor(m.chip.outcome)"
              [href]="'https://www.wowhead.com/spell=' + m.chip.wowheadSpellId"
              target="_blank"
              rel="noopener"
              [attr.data-wowhead]="'spell=' + m.chip.wowheadSpellId"
              (mouseenter)="hoverMarker.set(m)"
              (mouseleave)="hoverMarker.set(null)"
              (focus)="hoverMarker.set(m)"
              (blur)="hoverMarker.set(null)"
            ></a>
          } @else {
            <div
              class="marker"
              [class.overflow]="!!m.overflow"
              role="button"
              tabindex="0"
              [style.left.%]="m.leftPct"
              [style.top.%]="m.topPct"
              [style.background]="m.overflow ? null : toneColor(m.chip.outcome)"
              (mouseenter)="hoverMarker.set(m)"
              (mouseleave)="hoverMarker.set(null)"
              (focus)="hoverMarker.set(m)"
              (blur)="hoverMarker.set(null)"
              (click)="chipSelected.emit(m.chip)"
              (keydown.enter)="chipSelected.emit(m.chip)"
            >
              {{ m.overflow ? '+' + m.overflow.length : '' }}
            </div>
          }
        }

        @if (hoverMarker(); as hm) {
          <div class="tooltip marker-tooltip" [class.flip]="hm.leftPct > 60" [style.left.%]="hm.leftPct" [style.top.%]="hm.topPct">
            <span class="tt-time tabular">{{ hm.chip.timeLabel }}</span>
            @if (categoryMeta(hm.chip.category); as meta) {
              <span class="tt-category">{{ meta.label }}</span>
            }
            <span class="tt-desc">{{ hm.chip.description }}</span>
            @if (hm.overflow; as extra) {
              <span class="tt-overflow">+{{ extra.length }} más en este instante:</span>
              @for (o of extra; track o.description) {
                <span class="tt-overflow-item">{{ o.timeLabel }} · {{ o.description }}</span>
              }
            }
            @if (hm.chip.provenance) {
              <button type="button" class="tt-provenance" (click)="chipSelected.emit(hm.chip)">Ver procedencia →</button>
            }
          </div>
        } @else if (crosshair(); as ch) {
          <div class="crosshair-line" [style.left.%]="ch.leftPct"></div>
          <div class="crosshair-dot" [style.left.%]="ch.leftPct" [style.top.%]="ch.topPct"></div>
          <div class="tooltip crosshair-tooltip" [class.flip]="ch.flip" [style.left.%]="ch.leftPct" [style.top.%]="ch.topPct">
            <span class="tt-time tabular">{{ ch.timeLabel }}</span>
            <span class="tt-desc">{{ ch.valueLabel }} daño recibido por la raid</span>
          </div>
        }

        @for (tick of p.ticks; track tick.leftPct) {
          <span class="tick-label tabular" [style.left.%]="tick.leftPct">{{ tick.label }}</span>
        }
      </div>

      @for (note of notes(); track note.description) {
        <p class="note">{{ note.description }}</p>
      }

      @if (background().length) {
        <p class="background-summary">
          Además, sin incidentes:
          @for (bg of background(); track bg.wowheadSpellId; let last = $last) {
            <a class="ability-ref" [href]="'https://www.wowhead.com/spell=' + bg.wowheadSpellId" target="_blank" rel="noopener" [attr.data-wowhead]="'spell=' + bg.wowheadSpellId"
              >{{ bg.label }} ×{{ bg.count }}</a
            >{{ last ? '' : ', ' }}
          }
        </p>
      }
    } @else {
      <p class="empty-state">Sin datos de línea temporal para este pull todavía.</p>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .legend {
        display: flex;
        gap: 14px;
        margin-bottom: 8px;
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 10.5px;
        color: var(--text-faint);
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        display: inline-block;
      }
      .tone-clean {
        background: var(--success);
      }
      .tone-partial {
        background: var(--warning);
      }
      .tone-fail {
        background: var(--danger);
      }

      .plot-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 1000 / 280;
        cursor: crosshair;
      }
      .plot-svg {
        width: 100%;
        height: 100%;
        display: block;
        overflow: visible;
      }
      .grid-line {
        stroke: var(--border);
        stroke-width: 1;
      }
      .axis-line {
        stroke: var(--border-bright);
        stroke-width: 1.5;
      }
      .area {
        fill: var(--accent-soft);
      }
      .line {
        fill: none;
        stroke: var(--accent);
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
      }

      .no-series-note {
        position: absolute;
        top: 8%;
        left: 0;
        right: 0;
        text-align: center;
        margin: 0;
        font-size: 11px;
        color: var(--text-faint);
        pointer-events: none;
      }

      .peak-label {
        position: absolute;
        transform: translate(-50%, -140%);
        font-size: 10px;
        color: var(--text-muted);
        background: var(--surface-2);
        border: 1px solid var(--card-border);
        border-radius: 4px;
        padding: 2px 6px;
        white-space: nowrap;
        pointer-events: none;
      }

      // El punto marcador ES el <a> de Wowhead cuando hay spellId (mismo
      // requisito verificado en real que en el chip antiguo), o un <div
      // role=button> cuando no hay spellId que enlazar o cuando es el
      // marcador sintético "+N" (representa varios eventos, no uno solo) —
      // mismo patrón de dos ramas que ya usaba mechanic-timeline.component.
      .marker {
        position: absolute;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        border: 1.5px solid var(--surface);
        cursor: pointer;
        display: block;
        text-decoration: none;
        box-sizing: border-box;
        transition:
          width 0.1s ease,
          height 0.1s ease;

        &:hover,
        &:focus-visible {
          width: 13px;
          height: 13px;
          z-index: 2;
        }
      }
      .marker.overflow {
        width: 15px;
        height: 15px;
        font-size: 8px;
        line-height: 1;
        font-weight: 700;
        color: var(--text);
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--neutral);
      }

      .crosshair-line {
        position: absolute;
        top: 0;
        bottom: 12%;
        width: 1px;
        background: var(--border-bright);
        pointer-events: none;
      }
      .crosshair-dot {
        position: absolute;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--accent);
        border: 1.5px solid var(--surface);
        transform: translate(-50%, -50%);
        pointer-events: none;
      }

      .tooltip {
        position: absolute;
        transform: translate(8px, -50%);
        min-width: 140px;
        max-width: 240px;
        background: var(--surface-2);
        border: 1px solid var(--card-border);
        border-radius: 8px;
        box-shadow: var(--shadow-card);
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 3px;
        pointer-events: none;
        z-index: 3;
      }
      .marker-tooltip {
        pointer-events: auto;
      }
      .tooltip.flip {
        transform: translate(calc(-100% - 8px), -50%);
      }
      .tt-time {
        font-size: 10.5px;
        color: var(--text-faint);
      }
      .tt-category {
        align-self: flex-start;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: var(--accent);
        background: var(--accent-soft);
        border-radius: 4px;
        padding: 1px 5px;
      }
      .tt-desc {
        font-size: 12px;
        color: var(--text);
        line-height: 1.4;
      }
      .tt-overflow {
        margin-top: 2px;
        font-size: 10px;
        color: var(--text-faint);
      }
      .tt-overflow-item {
        font-size: 10.5px;
        color: var(--text-muted);
      }
      .tt-provenance {
        margin-top: 4px;
        align-self: flex-start;
        background: none;
        border: none;
        padding: 0;
        font-size: 11px;
        color: var(--accent);
        cursor: pointer;
        font-family: inherit;

        &:hover {
          text-decoration: underline;
        }
      }

      .tick-label {
        position: absolute;
        bottom: -2px;
        transform: translateX(-50%);
        font-size: 9.5px;
        color: var(--text-faint);
        white-space: nowrap;
      }

      .note {
        margin: 8px 2px 0;
        font-size: 11.5px;
        color: var(--warning);
      }

      .background-summary {
        margin: 10px 2px 0;
        font-size: 11px;
        color: var(--text-faint);
        line-height: 1.6;

        .ability-ref {
          color: var(--text-muted);
          border-bottom: 1px dotted var(--text-faint);
          cursor: help;
          text-decoration: none;

          &:hover {
            color: var(--accent);
            border-bottom-color: var(--accent);
          }
        }
      }

      .empty-state {
        font-size: 12px;
        color: var(--text-faint);
        margin: 0;
        padding: 20px 0;
        text-align: center;
      }

      .skeleton-strip {
        height: 220px;
        border-radius: 8px;
        background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-hover) 37%, var(--surface-2) 63%);
        background-size: 400% 100%;
        animation: shimmer 1.4s ease infinite;
      }
      @keyframes shimmer {
        0% {
          background-position: 100% 50%;
        }
        100% {
          background-position: 0 50%;
        }
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
    `,
  ],
})
export class RaidDamageChartComponent {
  chips = input.required<TimelineChip[]>();
  background = input<BackgroundMechanicSummary[]>([]);
  series = input<RaidDamagePoint | null>(null);
  /** ms reales del pull — se prefiere a derivarlo de la serie (que puede faltar) o del último chip. */
  durationMs = input<number | null>(null);
  loading = input(false);
  chipSelected = output<TimelineChip>();

  categoryMeta = mechanicCategoryMeta;
  readonly VIEW_W = VIEW_W;
  readonly VIEW_H = VIEW_H;
  readonly PLOT_TOP = PLOT_TOP;
  readonly PLOT_BOTTOM = PLOT_BOTTOM;

  hoverXFrac = signal<number | null>(null);
  hoverMarker = signal<PositionedMarker | null>(null);

  private effectiveDurationMs = computed(() => {
    const explicit = this.durationMs();
    if (explicit && explicit > 0) return explicit;
    const s = this.series();
    if (s && s.points.length) return s.pointIntervalMs * s.points.length;
    const maxChip = Math.max(0, ...this.chips().map((c) => c.timeMs ?? 0));
    return maxChip > 0 ? maxChip : null;
  });

  /** Los dos hitos sintéticos ("inicio del pull" y "sin manifiesto") tienen provenance:null — ver buildTimeline. Solo se plotea lo que representa un instante real y verificable. */
  private plottableChips = computed(() => this.chips().filter((c) => c.timeMs != null && c.provenance != null));

  /** El único chip con timeMs:null real es "sin mecánicas clasificadas" (hito sin instante) — se enseña como nota de texto en vez de perderse. "Inicio del pull" (timeMs 0, provenance null) no necesita nota: el propio eje ya empieza en 0:00. */
  notes = computed(() => this.chips().filter((c) => c.timeMs == null));

  plot = computed<PlotGeometry | null>(() => {
    const durationMs = this.effectiveDurationMs();
    if (!durationMs || durationMs <= 0) return null;

    const s = this.series();
    const points = s?.points ?? [];
    const intervalMs = s?.pointIntervalMs ?? 0;
    const hasSeries = points.length > 1 && intervalMs > 0;

    let areaPath = '';
    let linePath = '';
    let peak: PlotGeometry['peak'] = null;

    if (hasSeries) {
      const maxVal = Math.max(1, ...points);
      const coords = points.map((v, i) => {
        const tMs = (i + 0.5) * intervalMs;
        const x = Math.min(1, tMs / durationMs) * VIEW_W;
        const y = PLOT_BOTTOM - (v / maxVal) * PLOT_H;
        return { x, y, v, tMs };
      });
      linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
      const firstX = coords[0].x.toFixed(1);
      const lastX = coords[coords.length - 1].x.toFixed(1);
      areaPath = `${linePath} L${lastX},${PLOT_BOTTOM} L${firstX},${PLOT_BOTTOM} Z`;

      let peakIdx = 0;
      coords.forEach((c, i) => {
        if (c.v > coords[peakIdx].v) peakIdx = i;
      });
      const p = coords[peakIdx];
      if (p.v > 0) {
        peak = {
          leftPct: (p.x / VIEW_W) * 100,
          topPct: (p.y / VIEW_H) * 100,
          label: `Pico: ${fullNumber(p.v)} a ${formatTimeLabel(p.tMs)}`,
        };
      }
    }

    const ticks = buildTicks(durationMs).map((tMs) => ({ leftPct: Math.min(100, (tMs / durationMs) * 100), label: formatTimeLabel(tMs) }));

    return { durationMs, hasSeries, areaPath, linePath, peak, ticks };
  });

  positionedMarkers = computed<PositionedMarker[]>(() => {
    const durationMs = this.effectiveDurationMs();
    if (!durationMs) return [];
    const laneTopPct = (LANE_TOP / VIEW_H) * 100;
    const rowHPct = (LANE_ROW_H / VIEW_H) * 100;

    const sorted = [...this.plottableChips()].sort((a, b) => a.timeMs! - b.timeMs!);
    const columns = new Map<number, TimelineChip[]>();
    for (const c of sorted) {
      const leftPct = Math.min(100, (c.timeMs! / durationMs) * 100);
      const col = Math.round(leftPct / 1.4);
      const arr = columns.get(col) ?? [];
      arr.push(c);
      columns.set(col, arr);
    }

    const out: PositionedMarker[] = [];
    for (const arr of columns.values()) {
      const visible = arr.slice(0, LANE_MAX_ROWS - 1);
      visible.forEach((chip, row) => {
        out.push({ chip, leftPct: Math.min(100, (chip.timeMs! / durationMs) * 100), topPct: laneTopPct + row * rowHPct });
      });
      if (arr.length > visible.length) {
        const hidden = arr.slice(visible.length);
        out.push({
          chip: hidden[0],
          leftPct: Math.min(100, (hidden[0].timeMs! / durationMs) * 100),
          topPct: laneTopPct + (LANE_MAX_ROWS - 1) * rowHPct,
          overflow: hidden,
        });
      }
    }
    return out;
  });

  crosshair = computed<CrosshairInfo | null>(() => {
    if (this.hoverMarker()) return null;
    const frac = this.hoverXFrac();
    const p = this.plot();
    const s = this.series();
    if (frac == null || !p || !p.hasSeries || !s || !s.points.length) return null;

    const tMs = frac * p.durationMs;
    const idx = Math.max(0, Math.min(s.points.length - 1, Math.round(tMs / s.pointIntervalMs - 0.5)));
    const v = s.points[idx];
    const bucketMidMs = (idx + 0.5) * s.pointIntervalMs;
    const leftPct = Math.min(100, (bucketMidMs / p.durationMs) * 100);
    const maxVal = Math.max(1, ...s.points);
    const topPct = ((PLOT_BOTTOM - (v / maxVal) * PLOT_H) / VIEW_H) * 100;

    return { leftPct, topPct, timeLabel: formatTimeLabel(bucketMidMs), valueLabel: fullNumber(v), flip: leftPct > 60 };
  });

  ariaLabel = computed(() => {
    const p = this.plot();
    return p?.hasSeries ? 'Gráfica de daño recibido por la raid a lo largo del pull, con mecánicas superpuestas' : 'Línea temporal de mecánicas del pull';
  });

  onPlotMove(event: MouseEvent, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    this.hoverXFrac.set(frac);
  }
  onPlotLeave() {
    this.hoverXFrac.set(null);
  }

  toneColor(outcome: TimelineChip['outcome']): string {
    switch (outcome) {
      case 'clean':
        return 'var(--success)';
      case 'partial_fail':
        return 'var(--warning)';
      case 'fail':
        return 'var(--danger)';
      default:
        return 'var(--text-faint)';
    }
  }
}
